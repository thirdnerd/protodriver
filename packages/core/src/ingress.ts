import type {
  ChannelId,
  Clock,
  InputCustodySink,
  ReceivedChunk,
  TransportTermination,
} from "@protodriver/contracts";

// Identity, not a duck-typed method or a copied assertion. A receipt belongs to
// this exact binding/sink and is issued only after the earliest-stamp census.
const custodyAttestations = new WeakMap<object, InputCustodySink>();
export function isInputCustodyAttestation(receipt: object, sink: InputCustodySink): boolean {
  return custodyAttestations.get(receipt) === sink;
}

export type IngressPushResult =
  | { readonly kind: "accepted"; readonly acceptedBytes: number }
  | { readonly kind: "overflow"; readonly rejectedBytes: number }
  | { readonly kind: "terminated"; readonly rejectedBytes: number };

export interface IngressMetrics {
  readonly retainedBytes: number;
  readonly highWaterBytes: number;
  readonly acceptedBytes: number;
  readonly deliveredBytes: number;
  readonly rejectedBytes: number;
}

export interface BoundedIngressOptions {
  readonly channelId: ChannelId;
  readonly hardLimitBytes: number;
  readonly clock: Clock;
  readonly onTerminate?: (termination: TransportTermination) => void;
}

export class ReceiveTerminatedError extends Error {
  readonly termination: TransportTermination;

  constructor(termination: TransportTermination) {
    super(`receive path terminated: ${termination.kind}`);
    this.name = "ReceiveTerminatedError";
    this.termination = termination;
  }
}

interface PendingRead {
  readonly consumer: symbol;
  readonly resolve: (result: IteratorResult<ReceivedChunk>) => void;
  readonly reject: (error: ReceiveTerminatedError) => void;
}

interface IngressNode { readonly chunk: ReceivedChunk; custody?: { discarded(): void }; next?: IngressNode }

/**
 * Authoritative per-channel ingress. It either retains every accepted octet
 * or terminates; there is no drop-and-continue state.
 */
export class BoundedIngress {
  readonly #channelId: ChannelId;
  readonly #hardLimitBytes: number;
  readonly #clock: Clock;
  readonly #onTerminate: BoundedIngressOptions["onTerminate"];
  #head: IngressNode | undefined;
  #tail: IngressNode | undefined;
  #pending: PendingRead | undefined;
  #termination: TransportTermination | undefined;
  #retainedBytes = 0;
  #highWaterBytes = 0;
  #acceptedBytes = 0;
  #deliveredBytes = 0;
  #rejectedBytes = 0;
  #consumer: symbol | undefined;
  #custody: InputCustodySink | undefined;

  constructor(options: BoundedIngressOptions) {
    if (!Number.isSafeInteger(options.hardLimitBytes) || options.hardLimitBytes <= 0) {
      throw new RangeError("hardLimitBytes must be a positive safe integer");
    }
    this.#channelId = options.channelId;
    this.#hardLimitBytes = options.hardLimitBytes;
    this.#clock = options.clock;
    this.#onTerminate = options.onTerminate;
  }

  get hardLimitBytes(): number {
    return this.#hardLimitBytes;
  }

  get metrics(): IngressMetrics {
    return {
      retainedBytes: this.#retainedBytes,
      highWaterBytes: this.#highWaterBytes,
      acceptedBytes: this.#acceptedBytes,
      deliveredBytes: this.#deliveredBytes,
      rejectedBytes: this.#rejectedBytes,
    };
  }

  get termination(): TransportTermination | undefined {
    return this.#termination;
  }

  bindInputCustody(sink: InputCustodySink): { dispose(): void } {
    if (sink.clock !== undefined && sink.clock !== this.#clock)
      throw new Error("input.retirement.cut-unavailable: clock domain differs");
    if (this.#consumer !== undefined || this.#deliveredBytes !== 0 || this.#custody || this.#termination)
      throw new Error("input.retirement.cut-unavailable");
    // One installation-time census, never a per-query or per-arrival scan.
    // No callback can interleave this synchronous registration with push.
    try {
      for (let node = this.#head; node; node = node.next) {
        const ticket = sink.observed(node.chunk.atSequence, node.chunk.bytes.byteLength);
        if (ticket) node.custody = ticket;
      }
    } catch (cause) {
      try { sink.revoked("terminated"); } catch { /* preserve the registration failure */ }
      throw cause;
    }
    this.#custody = sink;
    if (sink.attested) {
      const receipt = Object.freeze({}); custodyAttestations.set(receipt, sink);
      try { sink.attested(receipt); }
      catch (cause) { this.#custody = undefined; sink.revoked("terminated"); throw cause; }
    }
    return { dispose: () => {
      if (this.#custody !== sink) return;
      this.#custody = undefined;
      sink.revoked("released");
    } };
  }

  push(bytes: Uint8Array): IngressPushResult {
    if (bytes.byteLength === 0) return { kind: "accepted", acceptedBytes: 0 };
    if (this.#termination !== undefined) {
      this.#rejectedBytes += bytes.byteLength;
      return { kind: "terminated", rejectedBytes: bytes.byteLength };
    }

    // Check BEFORE Uint8Array.from: an oversized delivery must not create the
    // transient allocation that the bound exists to prevent.
    if (bytes.byteLength > this.#hardLimitBytes - this.#retainedBytes) {
      this.#rejectedBytes += bytes.byteLength;
      const termination: TransportTermination = {
        kind: "receive-overflow",
        limitBytes: this.#hardLimitBytes,
        channel: this.#channelId,
      };
      this.#terminate(termination);
      return { kind: "overflow", rejectedBytes: bytes.byteLength };
    }

    const sequence = this.#clock.nextSequence();
    // Refusal happens before accepting/copying the new reliable obligation.
    let ticket: void | { discarded(): void };
    try { ticket = this.#custody?.observed(sequence, bytes.byteLength); }
    catch (cause) {
      try {
        this.#terminate({ kind: "fault", error: { code: "input.retirement.accounting-failed",
          message: "reliable input custody could not be reserved", responsibility: "operation", retryability: "no" } });
      } catch { /* pending reads still settle; preserve the accounting failure */ }
      throw cause;
    }
    let copy: Uint8Array;
    try { copy = Uint8Array.from(bytes); }
    catch (cause) { ticket?.discarded(); throw cause; }
    const chunk = {
      bytes: copy,
      atSequence: sequence,
      tUs: Math.floor(this.#clock.monotonicUs()),
    };
    const node: IngressNode = { chunk, ...(ticket ? { custody: ticket } : {}) };
    if (this.#tail) this.#tail.next = node;
    else this.#head = node;
    this.#tail = node;
    this.#retainedBytes += copy.byteLength;
    this.#acceptedBytes += copy.byteLength;
    this.#highWaterBytes = Math.max(this.#highWaterBytes, this.#retainedBytes);
    this.#settlePending();
    return { kind: "accepted", acceptedBytes: copy.byteLength };
  }

  incoming(): AsyncIterable<ReceivedChunk> {
    if (this.#consumer !== undefined) {
      throw new Error("authoritative ingress already has a consumer");
    }
    const consumer = Symbol("ingress-consumer");
    this.#consumer = consumer;
    let iteratorCreated = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (iteratorCreated) throw new Error("ingress iterable already has an iterator");
        iteratorCreated = true;
        return {
          next: () => this.#next(consumer),
          return: async () => {
            this.#releaseConsumer(consumer);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  close(termination: TransportTermination): void {
    if (this.#termination !== undefined) return;
    this.#terminate(termination);
  }

  /** Connection replacement explicitly invalidates buffered old-connection bytes. */
  discardAndClose(): void {
    this.#discard();
    if (this.#termination === undefined) this.#terminate({ kind: "closed-by-host" });
    else this.#settlePending();
  }

  /** Discards untrusted queued bytes and rejects the active consumer. */
  discardAndTerminate(termination: TransportTermination): void {
    this.#discard();
    if (this.#termination === undefined) this.#terminate(termination);
    else this.#settlePending();
  }

  #discard(): void {
    // Every visit spends its original observation's prepaid disposal unit.
    // A dequeued node is deliberately absent: its promise/host owns it now.
    while (this.#head) {
      const node = this.#head; this.#head = node.next;
      node.custody?.discarded();
    }
    this.#tail = undefined; this.#retainedBytes = 0;
  }

  async #next(consumer: symbol): Promise<IteratorResult<ReceivedChunk>> {
    if (this.#consumer !== consumer) {
      throw new Error("authoritative ingress consumer was released");
    }
    const available = this.#dequeue();
    if (available !== undefined) return { done: false, value: available };
    if (this.#termination !== undefined) return this.#terminalResult();
    if (this.#pending !== undefined) throw new Error("concurrent ingress reads are not allowed");
    return new Promise<IteratorResult<ReceivedChunk>>((resolve, reject) => {
      this.#pending = { consumer, resolve, reject };
    });
  }

  #releaseConsumer(consumer: symbol): void {
    if (this.#consumer !== consumer) return;
    this.#consumer = undefined;
    if (this.#pending?.consumer === consumer) {
      const pending = this.#pending;
      this.#pending = undefined;
      pending.resolve({ done: true, value: undefined });
    }
  }

  #dequeue(): ReceivedChunk | undefined {
    const node = this.#head;
    if (node === undefined) return undefined;
    this.#head = node.next;
    if (!this.#head) this.#tail = undefined;
    const chunk = node.chunk;
    this.#retainedBytes -= chunk.bytes.byteLength;
    this.#deliveredBytes += chunk.bytes.byteLength;
    return chunk;
  }

  #settlePending(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    const available = this.#dequeue();
    if (available !== undefined) {
      this.#pending = undefined;
      pending.resolve({ done: false, value: available });
      return;
    }
    if (this.#termination !== undefined) {
      this.#pending = undefined;
      const terminal = this.#termination;
      if (terminal.kind === "closed-by-host") {
        pending.resolve({ done: true, value: undefined });
      } else {
        pending.reject(new ReceiveTerminatedError(terminal));
      }
    }
  }

  #terminalResult(): IteratorResult<ReceivedChunk> {
    const termination = this.#termination;
    if (termination === undefined) throw new Error("ingress is not terminated");
    if (termination.kind === "closed-by-host") return { done: true, value: undefined };
    throw new ReceiveTerminatedError(termination);
  }

  #terminate(termination: TransportTermination): void {
    this.#termination = termination;
    const custody = this.#custody;
    this.#custody = undefined;
    try { custody?.revoked("terminated"); }
    finally {
      try { this.#onTerminate?.(termination); }
      finally { this.#settlePending(); }
    }
  }
}
