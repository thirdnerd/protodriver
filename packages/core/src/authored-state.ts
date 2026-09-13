import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort } from "@protodriver/lua-vm/retained";
import { activeNativeScratch, nativeValue } from "@protodriver/lua-vm/retained";
import type { AuthoredStateCell, Clock, Disposable, StateCellSnapshot } from "@protodriver/contracts";
import { authoredPublicValue } from "./authored-admission.ts";
import type { ReadyQueue } from "./ready-queue.ts";

type Quality = StateCellSnapshot["quality"];
interface StateReservation { commit(): void; release(): void }
function staged(value: StateReservation | void): StateReservation | undefined {
  // Existing void callbacks may incidentally return e.g. Array.push's count.
  return value && typeof value === "object" ? value : undefined;
}
const severity: Record<Quality, number> = { valid: 0, stale: 1, unknown: 2, invalid: 3 };
export function inheritedStateQuality(own: Quality, inputs: readonly Quality[]): Quality {
  return nativeArray(inputs).reduce((worst, input) => severity[input] > severity[worst] ? input : worst, own);
}

/** Typed host observations, not proof of the device's physical state. */
export class AuthoredState {
  readonly #cells: Record<string, StateCellSnapshot> = {};
  readonly #timers = new Map<string, Disposable>();
  readonly #basis = new Map<string, Readonly<Record<string, number>>>();
  readonly #ids: readonly string[];
  readonly #closedCells: Record<string, { quality: "unknown"; revision: number }> = {};
  #closed = false;
  readonly declarations: Readonly<Record<string, AuthoredStateCell>>;
  readonly clock: Clock;
  readonly queue: Pick<ReadyQueue, "enqueue">;
  readonly stamp: () => number;
  readonly publish: (changed: Readonly<Record<string, StateCellSnapshot>>, sequence: number) => void;
  readonly reserve: (id: string, cell: StateCellSnapshot, basis?: Readonly<Record<string, number>>) => StateReservation | void;
  readonly canArm: () => boolean;
  readonly failed: (cause: unknown) => void;
  constructor(declarations: Readonly<Record<string, AuthoredStateCell>>, clock: Clock,
    queue: Pick<ReadyQueue, "enqueue">, stamp: () => number,
    publish: (changed: Readonly<Record<string, StateCellSnapshot>>, sequence: number) => void,
    reserve: (id: string, cell: StateCellSnapshot, basis?: Readonly<Record<string, number>>) => StateReservation | void,
    canArm: () => boolean, failed: (cause: unknown) => void = () => {}) {
    this.declarations = declarations; this.clock = clock; this.queue = queue; this.stamp = stamp;
    this.publish = publish; this.reserve = reserve; this.canArm = canArm; this.failed = failed;
    this.#ids = nativeKeys(declarations);
    // Destruction cannot depend on a publisher still having ordinary fuel.
    // Admission reserves both bounded cleanup passes and their replacement
    // records; no values, keys or dependency graph are copied during close.
    activeNativeScratch()?.work(2 * this.#ids.length + 1);
    activeNativeScratch()?.reserve(32);
    for (const id of this.#ids) {
      activeNativeScratch()?.node(96);
      this.#cells[id] = { quality: "unknown", revision: 0 };
      this.#closedCells[id] = { quality: "unknown", revision: 0 };
    }
  }
  get timerCount(): number { return this.#timers.size; }
  snapshot(): Readonly<Record<string, StateCellSnapshot>> {
    const result: Record<string, StateCellSnapshot> = {};
    // Admission bounds and rejects cycles. Memoization visits each cell/edge
    // once, including diamonds; no authored code runs during a snapshot.
    const view = (id: string): StateCellSnapshot => {
      activeNativeScratch()?.node();
      if (Object.hasOwn(result, id)) return result[id]!;
      const cell = this.#cells[id]!, inputs = this.declarations[id]!.dependsOn;
      if (!inputs) return result[id] = cell;
      const basis = this.#basis.get(id);
      const currentBasis = nativeArray(inputs).every(input => basis?.[input] === this.#cells[input]!.revision);
      const quality = inheritedStateQuality(currentBasis ? cell.quality : "unknown", nativeArray(inputs).map(input => view(input).quality));
      const { value, ...observation } = cell;
      return result[id] = { ...observation, quality,
        ...((quality === "valid" || quality === "stale") && Object.hasOwn(cell, "value") ? { value } : {}) };
    };
    for (const id of nativeKeys(this.#cells)) view(id);
    return structuredClone(nativeValue(result));
  }
  #changed(before: Readonly<Record<string, StateCellSnapshot>>, sequence: number): void {
    const changed: Record<string, StateCellSnapshot> = {};
    for (const [id, cell] of nativeEntries(this.snapshot())) {
      const prior = before[id]!;
      if (cell.quality !== prior.quality || cell.revision !== prior.revision
        || cell.updatedBySequence !== prior.updatedBySequence || cell.updatedAtMonotonicUs !== prior.updatedAtMonotonicUs) changed[id] = cell;
    }
    // One event contains the source and every affected dependent. Consumers
    // cannot observe half an expiry through an incremental state subscription.
    if (nativeKeys(changed).length) this.publish(changed, sequence);
  }
  update(id: string, quality: unknown, value: unknown, live: () => void,
    run: <T>(work: () => T) => T = work => work()): Promise<void> {
    // Deliberately not an immediate callback: a ready peer gets its turn first.
    return this.queue.enqueue(this.stamp(), async () => run(() => {
      live();
      const declaration = this.declarations[id];
      if (this.#closed || !declaration) throw new Error("authored.state.invalid-publication");
      const inherited = declaration.dependsOn !== undefined;
      if (inherited ? quality !== undefined : !["valid", "unknown"].includes(String(quality))) throw new Error("authored.state.invalid-publication");
      // Value-only for a derived cell. The author never chooses its quality.
      if (inherited) quality = "valid";
      if (quality === "unknown" && value !== null) throw new Error("authored.state.unknown-has-value");
      const converted = quality === "valid" ? authoredPublicValue(value, declaration.type) : undefined;
      // An unaged observation reserves its ordinary state bytes, but no age
      // timer. Its generation and explicit invalidation obligations remain.
      const ages = !inherited && declaration.freshForMs !== null;
      if (quality === "valid" && ages && !this.#timers.has(id) && !this.canArm()) throw new Error("authored.state.timer-limit");
      const revision = this.#cells[id]!.revision + 1, sequence = this.stamp();
      const cell: StateCellSnapshot = { quality: quality as "valid" | "unknown", revision, updatedBySequence: sequence,
        updatedAtMonotonicUs: this.clock.monotonicUs(), ...(converted === undefined ? {} : { value: converted }) };
      const basis = inherited ? nativeRecord(nativeArray(declaration.dependsOn!).map(input => [input, this.#cells[input]!.revision])) : undefined;
      const reservation = staged(this.reserve(id, cell, basis));
      try {
      const before = this.snapshot();
      const prior = this.#cells[id]!, priorBasis = this.#basis.get(id);
      this.#cells[id] = cell;
      if (basis) this.#basis.set(id, basis);
      try { this.#changed(before, sequence); }
      catch (cause) {
        if (!this.#closed) {
          this.#cells[id] = prior;
          if (priorBasis) this.#basis.set(id, priorBasis); else this.#basis.delete(id);
        }
        throw cause;
      }
      reservation?.commit();
      this.#timers.get(id)?.dispose(); this.#timers.delete(id);
      if (quality === "valid" && ages) this.#timers.set(id, this.clock.timer(declaration.freshForMs!, () => {
        void this.queue.enqueue(this.stamp(), async () => run(() => {
          if (this.#closed || this.#cells[id]?.revision !== revision) return;
          const before = this.snapshot();
          this.#timers.delete(id);
          const next = { ...cell, quality: "stale" as const };
          const reservation = staged(this.reserve(id, next, this.#basis.get(id)));
          try {
            this.#cells[id] = next;
            try { this.#changed(before, this.stamp()); }
            catch (cause) { if (!this.#closed) this.#cells[id] = cell; throw cause; }
            reservation?.commit();
          } finally { reservation?.release(); }
        })).catch(cause => { if (!this.#closed) this.failed(cause); });
      }));
      } finally { reservation?.release(); }
    }));
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // The two per-cell passes and iterator storage were prepaid at admission.
    for (const timer of this.#timers.values()) timer.dispose();
    this.#timers.clear();
    this.#basis.clear();
    for (const id of this.#ids) {
      const closed = this.#closedCells[id]!;
      closed.revision = this.#cells[id]!.revision;
      this.#cells[id] = closed;
    }
  }
  async invalidate(live: () => void, run: <T>(work: () => T) => T = work => work()): Promise<void> {
    await this.queue.enqueue(this.stamp(), async () => run(() => {
      live();
      if (this.#closed) throw new Error("authored.state.invalid-publication");
      const before = this.snapshot(), sequence = this.stamp(), now = this.clock.monotonicUs();
      const next = nativeRecord(nativeArray(nativeEntries(this.#cells)).map(([id, cell]) => [id,
        { quality: "unknown" as const, revision: cell.revision + 1, updatedBySequence: sequence, updatedAtMonotonicUs: now }]));
      activeNativeScratch()?.reserve(16 + this.#ids.length * 48 + this.#basis.size * 32);
      activeNativeScratch()?.work(this.#ids.length + this.#basis.size);
      const prior = { ...this.#cells }, priorBasis = new Map(this.#basis), reservations: StateReservation[] = [];
      try {
        for (const [id, cell] of nativeEntries(next)) { const r = staged(this.reserve(id, cell)); if (r) reservations.push(r); }
        this.#basis.clear(); Object.assign(this.#cells, next);
        try { this.#changed(before, sequence); }
        catch (cause) {
          if (!this.#closed) {
            Object.assign(this.#cells, prior);
            for (const [id, basis] of priorBasis) this.#basis.set(id, basis);
          }
          throw cause;
        }
        for (const r of reservations) r.commit();
        for (const timer of this.#timers.values()) timer.dispose();
        this.#timers.clear();
      } finally { for (const r of reservations) r.release(); }
    }));
  }
}
