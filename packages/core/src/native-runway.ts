import { NativeScratch, withNativeScratch } from "@protodriver/lua-vm/retained";
import type { NativeHelperData } from "./native-helper.ts";

/** D's terminal reserve is withheld from ordinary authority, not a new grant.
 * Spent work stays spent; unused authority returns only when this owner ends.
 * Backing capacity stays held across cancellation until native settlement. */
export class NativeRunway {
  readonly #data: NativeHelperData;
  readonly #reserveWork: (units: number) => void;
  readonly #spendWork: (units: number) => void;
  readonly #releaseWork: (units: number) => void;
  readonly #storage: Array<{ release(): void }> = [];
  readonly #owner: string | undefined;
  #work = 0;
  #capacity = 0;
  #resident = 0;
  #running = false;
  #closed = false;
  constructor(data: NativeHelperData, reserve: (units: number) => void,
    spend: (units: number) => void, release: (units: number) => void, owner?: string) {
    this.#data = data; this.#reserveWork = reserve;
    this.#spendWork = spend; this.#releaseWork = release;
    this.#owner = owner;
  }
  get remainingWork(): number { return this.#work; }
  reserveRelease(): void { this.ensure(this.#work + 1, this.#capacity); }
  charge(units: number): void {
    if (this.#closed || !Number.isSafeInteger(units) || units < 0 || units > this.#work)
      throw new Error("terminal work reservation underestimated");
    this.#spendWork(units); this.#work -= units;
  }
  ensure(work: number, capacity: number): void {
    if (this.#closed) throw new Error("terminal reserve already retired");
    const addedWork = Math.max(0, work - this.#work), addedCapacity = Math.max(0, capacity - this.#capacity);
    this.#reserveWork(addedWork);
    try { if (addedCapacity) this.#storage.push(this.#data.reserve(addedCapacity)); }
    catch (cause) { this.#releaseWork(addedWork); throw cause; }
    this.#work += addedWork; this.#capacity += addedCapacity;
  }
  run<T>(work: () => T): T {
    if (this.#closed) throw new Error("terminal reserve already retired");
    if (this.#running) return work();
    const scratch = new NativeScratch({ reserve: capacity => {
      const bytes = capacity + 84;
      if (bytes > this.#capacity - this.#resident) throw new Error("terminal capacity reservation underestimated");
      this.#resident += bytes; let live = true;
      return { release: () => { if (live) { live = false; this.#resident -= bytes; } } };
    } }, units => this.charge(units), this.#owner);
    this.#running = true;
    try { return withNativeScratch(scratch, work); }
    finally { this.#running = false; scratch.close(); }
  }
  close(): void {
    if (this.#closed) return;
    if (this.#running || this.#resident) throw new Error("terminal reserve still in use");
    this.#closed = true; this.#releaseWork(this.#work); this.#work = 0;
    for (const hold of this.#storage) hold.release();
    this.#storage.length = 0;
  }
}
