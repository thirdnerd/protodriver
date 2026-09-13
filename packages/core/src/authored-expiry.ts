import type { AuthoredExpiryObservation, Clock, Disposable } from "@protodriver/contracts";
import { activeNativeScratch, nativeValue } from "@protodriver/lua-vm/retained";
import type { AuthoredTimeBasis } from "./authored-clock.ts";
import type { NativeRunway } from "./native-runway.ts";
import { nativeFault } from "./native-helper.ts";

// A fixed prepaid service allowance, not a new per-callback author grant.
export const EXPIRY_WORK = 4096;
export const EXPIRY_SCRATCH = 32768;
interface Entry {
  readonly owner: string; readonly milliseconds: number; readonly runway: NativeRunway;
  readonly value: { -readonly [K in keyof AuthoredExpiryObservation]: AuthoredExpiryObservation[K] };
  handle?: Disposable; removed?: boolean; running: number; committed: boolean;
}
interface Options {
  clock: Clock; basis: AuthoredTimeBasis;
  generation(): number; live(): boolean; hasCapacity(): boolean; identity(): string;
  prepay(owner: string): NativeRunway;
  reserve(id: string, value: unknown): void; forget(id: string): void;
  record(kind: string, fields: Record<string, unknown>): void;
  failed(cause: unknown): void;
}

/** Inert generation-scoped evidence. No Activation, coroutine, author callback
 * or channel handle is retained. The creator prepays the entire bounded tail. */
export class AuthoredExpiryLedger {
  readonly #options: Options;
  readonly #entries = new Map<string, Entry>();
  readonly #owners = new Map<string, Set<string>>();
  constructor(options: Options) { this.#options = options; }
  get size(): number { return this.#entries.size; }
  reserve(owner: string, milliseconds: unknown): string {
    if (typeof milliseconds !== "number" || !Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647)
      throw nativeFault("retained.invalid-expiry", "expiry duration must be an integer in 0..2147483647 ms");
    if (!this.#options.live()) throw nativeFault("retained.revoked", "expiry generation is not live");
    if (!this.#options.hasCapacity()) throw nativeFault("retained.timer-limit", "shared timer/expiry receipt slots exhausted");
    const runway = this.#options.prepay(owner);
    let entry: Entry | undefined;
    try {
      entry = runway.run(() => {
        activeNativeScratch()?.reserve(512); activeNativeScratch()?.work(3);
        const id = this.#options.identity(), generation = this.#options.generation();
        const value: Entry["value"] = { kind: "expiry", id, status: "reserved", generation,
          basisId: this.#options.basis.state.basisId, sequence: 0, elapsedUs: 0 };
        return { owner, milliseconds, value, runway, running: 0, committed: false };
      });
      const prepared = entry;
      return this.#run(prepared, () => {
        const { value } = prepared, id = value.id;
        this.#options.reserve(id, { owner, milliseconds, value });
        this.#entries.set(id, prepared);
        let owned = this.#owners.get(owner);
        if (!owned) this.#owners.set(owner, owned = new Set());
        owned.add(id);
        this.#options.record("expiry-reserved", { owner, expiry: { ...value }, milliseconds, prepaidWork: EXPIRY_WORK });
        return id;
      });
    } catch (cause) {
      if (entry && !entry.removed) this.#remove(entry, "reservation-failed"); else if (!entry) runway.close();
      throw cause;
    }
  }
  /** Host-only irreversible handoff, immediately before executor invocation.
   * A missing executor reply can never undo this custody transition. */
  commitDelivery(owner: string, id: string): void {
    const entry = this.#get(id);
    if (entry.owner !== owner || entry.committed || entry.value.status !== "reserved")
      throw nativeFault("retained.expiry-not-deliverable", "expiry completion is not owned by this pending delivery");
    this.#run(entry, () => {
      activeNativeScratch()?.iteration();
      entry.committed = true;
      this.#options.record("expiry-delivery-committed", { owner, id, generation: entry.value.generation });
    });
  }
  start(owner: string, id: string): string {
    const entry = this.#visible(id);
    if (entry.owner !== owner || entry.value.status !== "reserved")
      throw nativeFault("retained.expiry-not-startable", "only the live creator can start its unstarted expiry");
    this.#start(entry, this.#options.clock.monotonicUs(), "explicit"); return "armed";
  }
  terminal(owner: string, atUs: number): void {
    const owned = this.#owners.get(owner);
    if (!owned) return;
    // Each iteration is paid by its own pre-existing receipt, not by the dead
    // creator. Removing the current Set member does not skip its successor.
    for (const id of owned) {
      const entry = this.#get(id);
      if (!entry.committed) this.#remove(entry, "undelivered");
      else this.#start(entry, atUs, "owner-terminal");
    }
  }
  read(id: string): AuthoredExpiryObservation {
    const value = this.#visible(id).value;
    nativeValue(value); return Object.freeze({ ...value });
  }
  release(id: string): string { this.#remove(this.#visible(id), "released"); return "released"; }
  clear(reason: string): void {
    let failure: unknown;
    for (const entry of this.#entries.values()) {
      try { this.#remove(entry, reason); } catch (cause) { failure ??= cause; }
    }
    if (failure) this.#options.failed(failure);
  }
  #get(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry || !this.#options.live() || entry.value.generation !== this.#options.generation())
      throw nativeFault("retained.expiry-not-granted", "expiry receipt is unknown, released or from an ended generation");
    return entry;
  }
  #visible(id: string): Entry {
    const entry = this.#get(id);
    if (!entry.committed) throw nativeFault("retained.expiry-not-granted", "expiry completion still belongs to its host delivery");
    return entry;
  }
  #run<T>(entry: Entry, action: () => T): T {
    entry.running++;
    try { return entry.runway.run(action); }
    finally { if (--entry.running === 0 && entry.removed) entry.runway.close(); }
  }
  #unown(entry: Entry): void {
    const owned = this.#owners.get(entry.owner);
    owned?.delete(entry.value.id);
    if (!owned?.size) this.#owners.delete(entry.owner);
  }
  #start(entry: Entry, atUs: number, trigger: string): void {
    this.#run(entry, () => {
      activeNativeScratch()?.work(2);
      if (entry.value.status !== "reserved") throw nativeFault("retained.expiry-not-startable", "expiry already started");
      const dueUs = atUs + entry.milliseconds * 1000;
      if (!Number.isFinite(dueUs) || dueUs > Number.MAX_SAFE_INTEGER) throw nativeFault("retained.invalid-expiry", "expiry clock domain exhausted");
      this.#unown(entry); entry.value.status = "armed";
      entry.handle = this.#options.clock.timer(Math.max(0, (dueUs - this.#options.clock.monotonicUs()) / 1000), () => {
        if (entry.removed) return;
        if (!this.#options.live() || entry.value.generation !== this.#options.generation()) { this.#remove(entry, "revoked"); return; }
        try { this.#run(entry, () => {
          activeNativeScratch()?.iteration();
          // The adapter's input acceptance uses this very same clock. This is
          // the expiry EVENT, not the eventual read/dispatch of its evidence.
          const observed = this.#options.basis.observe(this.#options.clock.nextSequence(), entry.value.generation);
          entry.value.status = "expired"; entry.value.sequence = observed.sequence; entry.value.elapsedUs = observed.elapsedUs;
          this.#options.record("expiry-observed", { owner: entry.owner, expiry: { ...entry.value } });
        }); } catch (cause) { this.#options.failed(cause); }
      });
      this.#options.record("expiry-armed", { owner: entry.owner, id: entry.value.id, trigger, atUs, dueUs });
    });
  }
  #remove(entry: Entry, reason: string): void {
    if (entry.removed) return;
    // Detach before recording: recording loss may synchronously clear the
    // ledger again. A currently running prepaid scope closes at its own exit.
    entry.removed = true; entry.handle?.dispose(); this.#entries.delete(entry.value.id); this.#unown(entry);
    this.#options.forget(entry.value.id);
    this.#run(entry, () => { activeNativeScratch()?.iteration();
      this.#options.record("expiry-retired", { owner: entry.owner, id: entry.value.id, status: entry.value.status, reason }); });
  }
}
