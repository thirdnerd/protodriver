import { CanonicalSizeAccounting } from "./limits.ts";
import { activeNativeScratch, type NativeScratch } from "@protodriver/lua-vm/retained";

const sizes = new CanonicalSizeAccounting();
// Trusted ingress descriptors have four numeric fields: their canonical size
// is independent of sequence/offset values. Not an authored-value shortcut.
const inputRangeBytes = sizes.rpcMessageBytes({ sequence: 0, recordedSequence: 0, offset: 0, length: 0 });
const inputKeyBytes = sizes.rpcMessageBytes("input");
const rangesKeyBytes = sizes.rpcMessageBytes("input-ranges");

/** Capacity inventory for D3. Reservations measure only changed entries;
 * ingress and effect collections maintain their own incremental inventories.
 * Direct set is reserved for shrinking/replacing an already reserved value.
 * Mutable effect outcomes and their eventual byte count have 64 bytes of
 * terminal headroom per slot. This is reserved capacity, not another limit. */
export class RetainedMailbox extends Map<string, unknown> {
  #entries = new Map<string, number>();
  #bytes = 8;
  #rawBytes = 0;
  #rawItems = 0;
  readonly #accounting = new CanonicalSizeAccounting();
  #effects = new WeakMap<object, { history: number; live: number }>();
  get reservedBytes(): number { return this.#bytes + this.#rawBytes; }
  get reservedItems(): number { return this.size + this.#rawItems; }
  /** The caller has measured only the newly appended text and maintained the
   * exact UTF-8 length through consumption. Neither old ranges nor unrelated
   * (possibly settled) effect records need another traversal at each arrival.
   * Their existing reserved headroom remains held until replacement/deletion.
   * Check BOTH replacements before publishing either one. */
  reserveInput(value: string, ranges: readonly { sequence: number; recordedSequence: number; offset: number; length: number }[],
    utf8Bytes: number, fill: number, timed = false): boolean {
    const scope = activeNativeScratch();
    scope?.work(2); scope?.reserve(64); // two capacity-index updates, before publication
    const input = inputKeyBytes + 8 + utf8Bytes + 32 + 64;
    const provenance = rangesKeyBytes + 8 + ranges.length * (inputRangeBytes + 64 + (timed ? 19 : 0)) + 32; // tUs: key 3 + numeric node 16
    const bytes = this.#bytes - (this.#entries.get("input") ?? 0) - (this.#entries.get("input-ranges") ?? 0) + input + provenance;
    const added = Number(!this.has("input")) + Number(!this.has("input-ranges"));
    if (this.reservedItems + added > 1024 || bytes + this.#rawBytes + fill > 16 * 1024 * 1024) return false;
    super.set("input", value); super.set("input-ranges", ranges);
    this.#entries.set("input", input); this.#entries.set("input-ranges", provenance); this.#bytes = bytes;
    return true;
  }
  reserve(key: string, value: unknown, fill: number): boolean {
    const measure = (meter?: NativeScratch) => {
      meter?.reserve(32);
      const n = this.#accounting.rpcMessageBytes(key, meter) + this.#accounting.rpcMessageBytes(value, meter);
      meter?.iteration(); // the changed capacity-index entry
      const capacity = n + 32 + (Array.isArray(value) ? value.length * 64 : value instanceof Map ? value.size * 64 : 64);
      const bytes = this.#bytes - (this.#entries.get(key) ?? 0) + capacity;
      if (this.reservedItems + (this.has(key) ? 0 : 1) > 1024
        || bytes + this.#rawBytes + fill > 16 * 1024 * 1024) return false;
      // Transfer the capacity index while its temporary allocation is still
      // reserved. A failed admission never publishes a partial index.
      super.set(key, value); this.#entries.set(key, capacity); this.#bytes = bytes;
      return true;
    };
    const scope = activeNativeScratch();
    return scope ? scope.transient(measure) : measure();
  }
  /** Trusted effect containers: measure the new record once, never old mutable
   * outcomes. The per-slot 64-byte terminal headroom remains held. An additional
   * 64 bytes per slot covers the sizing-cache record (conservatively in BOTH
   * containers, since either can outlive the other). Validate the complete
   * replacement before changing either container or evicting any history. */
  reserveEffect<T extends { id: string }>(key: string, history: Map<string, T>, live: Map<string, T>, effect: T,
    evict: string | undefined, fill: number): boolean {
    const measure = (meter?: NativeScratch) => {
      meter?.reserve(192);
      const record = this.#accounting.rpcMessageBytes(effect, meter);
      const idBytes = this.#accounting.rpcMessageBytes(effect.id, meter);
      const slot = { history: record + idBytes + 64 + 64,
        live: record + idBytes + 64 + 64 };
      const oldHistory = this.#entries.get(key);
      const oldLive = this.#entries.get("live-effects");
      const removed = evict === undefined ? 0 : this.#effects.get(history.get(evict)!)?.history;
      if (removed === undefined) throw new Error("effect history has no capacity reservation");
      const historyCapacity = (oldHistory ?? this.#accounting.rpcMessageBytes(key, meter) + 8 + 32) - removed + slot.history;
      const liveCapacity = (oldLive ?? this.#accounting.rpcMessageBytes("live-effects", meter) + 8 + 32) + slot.live;
      // Ordered keyed history preserves chronology without moving old slots.
      // Charge its deletion and the three cache/index changes before publication.
      meter?.work(3 + Number(evict !== undefined));
      const bytes = this.#bytes - (oldHistory ?? 0) - (oldLive ?? 0) + historyCapacity + liveCapacity;
      if (this.reservedItems + Number(oldHistory === undefined) + Number(oldLive === undefined) > 1024
        || bytes + this.#rawBytes + fill > 16 * 1024 * 1024) return false;
      if (evict !== undefined) history.delete(evict);
      history.set(effect.id, effect); live.set(effect.id, effect);
      this.#effects.set(effect, slot);
      super.set(key, history); super.set("live-effects", live);
      this.#entries.set(key, historyCapacity); this.#entries.set("live-effects", liveCapacity); this.#bytes = bytes;
      return true;
    };
    const scope = activeNativeScratch();
    return scope ? scope.transient(measure) : measure();
  }
  releaseEffect(effect: object): void {
    // Disconnect can clear the mailbox before an outstanding platform call
    // settles. Its late terminal accounting cannot release cleared capacity.
    if (!this.#entries.has("live-effects")) return;
    const slot = this.#effects.get(effect);
    if (!slot) throw new Error("live effect has no capacity reservation");
    // Called only after terminal accounting, never while a native call remains
    // pending. History still owns its separately reserved record and headroom.
    const live = this.#entries.get("live-effects")!;
    this.#entries.set("live-effects", live - slot.live); this.#bytes -= slot.live;
  }
  retainRaw(backingBytes: number, fill: number): boolean {
    // One descriptor plus its owned backing allocation; no payload traversal.
    const capacity = backingBytes + 128;
    if (this.reservedItems + 1 > 1024 || this.reservedBytes + capacity + fill > 16 * 1024 * 1024) return false;
    this.#rawItems++; this.#rawBytes += capacity; return true;
  }
  releaseRaw(backingBytes: number): void {
    this.#rawItems--; this.#rawBytes -= backingBytes + 128;
  }
  clearRaw(): void { this.#rawItems = 0; this.#rawBytes = 0; }
  /** Commit an already reserved stage to its shorter permanent key. Both
   * values coexist until this point; no uncharged re-sizing on the commit. */
  commitStage(stage: string, target: string): void {
    const capacity = this.#entries.get(stage);
    if (capacity === undefined || !target.startsWith("state:") || stage !== "state-stage:" + target.slice(6))
      throw new Error("invalid mailbox reservation handoff");
    const value = super.get(stage);
    this.delete(target); this.delete(stage);
    // The shared suffix is unchanged, including UTF-8 width. Only the six
    // ASCII octets "-stage" disappear; release precisely that key capacity.
    super.set(target, value); this.#entries.set(target, capacity - 6); this.#bytes += capacity - 6;
  }
  override delete(key: string): boolean {
    if (!super.delete(key)) return false;
    this.#bytes -= this.#entries.get(key) ?? 0; this.#entries.delete(key); return true;
  }
  override clear(): void {
    super.clear(); this.#entries.clear(); this.#effects = new WeakMap(); this.#bytes = 8; this.#rawItems = 0; this.#rawBytes = 0;
  }
}
