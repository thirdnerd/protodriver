/** One authored turn at a time, ordered by host readiness, not promise arrival.
 * A host task boundary gathers this native turn's deliveries before selection. */
export class ReadyQueue {
  readonly #channel = new MessageChannel();
  readonly #jobs: Array<{ sequence: number; run(): Promise<void>; reject(cause: Error): void }> = [];
  #active = false;
  #scheduled = false;
  #closed = false;
  readonly #beforeTurn: () => void;
  constructor(beforeTurn: () => void = () => {}) {
    this.#beforeTurn = beforeTurn;
    this.#channel.port1.onmessage = () => { this.#scheduled = false; void this.#drain(); };
  }
  enqueue<T>(sequence: number, work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("retained ready queue closed"));
    if (this.#jobs.length >= 64) return Promise.reject(new Error("retained ready queue full"));
    return new Promise((resolve, reject) => {
      this.#jobs.push({ sequence, reject, async run() {
        try { resolve(await work()); } catch (cause) { reject(cause); }
      } });
      this.#schedule();
    });
  }
  #schedule(): void {
    if (this.#scheduled || this.#active || this.#closed || !this.#jobs.length) return;
    this.#scheduled = true; this.#channel.port2.postMessage(null);
  }
  async #drain(): Promise<void> {
    if (this.#active || this.#closed) return;
    this.#active = true;
    try {
      this.#beforeTurn();
      // Matched waits enqueue continuations in their promise reactions. Settle
      // those before choosing a turn, not on a competing MessagePort task.
      await Promise.resolve();
      if (this.#closed) return;
      this.#jobs.sort((a, b) => a.sequence - b.sequence);
      const job = this.#jobs.shift(); // FIFO mutation target: never pop/head-requeue
      if (job) await job.run();
    }
    catch (cause) { this.close(cause instanceof Error ? cause : new Error(String(cause))); }
    finally { this.#active = false; this.#schedule(); }
  }
  close(cause = new Error("retained ready queue closed")): void {
    this.#closed = true;
    for (const job of this.#jobs.splice(0)) job.reject(cause);
    this.#channel.port1.close(); this.#channel.port2.close();
  }
}
