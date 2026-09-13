import { nativeFault } from "./native-helper.ts";

export interface InputRange { sequence: number; length: number; offset?: number }

/** Trusted byte-queue normalization only; no author work or timer policy.
 * The caller reserves copy/descriptor capacity before accepting this request.
 * Wait for the threshold, then visit each contributing range ONCE. Repeated
 * arbitration never rescans an incomplete or ready fill. */
export class BoundedFill {
  readonly count: number;
  readonly bound: number;
  used = 0;
  #sequence: number | undefined;
  #lengths: number[] = [];
  constructor(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 256)
      throw nativeFault("retained.invalid-fill", "fill count must be an integer in 1..256");
    this.count = count; this.bound = 2 * count + 1;
  }
  charge(): void {
    if (this.used >= this.bound) throw nativeFault("retained.fill-work-exhausted", "bounded-fill normalization allowance exhausted");
    this.used++;
  }
  ready(ranges: readonly InputRange[], available: number, registered: number): number | undefined {
    if (this.#sequence !== undefined || available < this.count) return this.#sequence;
    let remaining = this.count;
    for (const range of ranges) {
      this.charge(); // visit one nonempty contributing range
      if (range.length <= 0) throw nativeFault("retained.invalid-fill-range", "empty ranges must not enter the owned queue");
      const length = Math.min(remaining, range.length);
      this.#lengths.push(length); remaining -= length;
      if (!remaining) { this.#sequence = Math.max(registered, range.sequence); return this.#sequence; }
    }
    throw nativeFault("retained.invalid-fill-range", "queue byte and provenance counts disagree");
  }
  take(buffer: string, ranges: InputRange[]): string {
    if (this.#sequence === undefined) throw nativeFault("retained.invalid-fill-range", "cannot complete a partial fill");
    const pieces: string[] = [];
    let offset = 0, removed = 0;
    for (const length of this.#lengths) {
      this.charge(); // copy this range, retaining its unconsumed suffix
      pieces.push(buffer.slice(offset, offset + length)); offset += length;
      const range = ranges[removed]!;
      if (range.offset !== undefined) range.offset += length;
      range.length -= length;
      if (!range.length) removed++;
    }
    this.charge(); // seal exactly one completion
    ranges.splice(0, removed);
    return pieces.join("");
  }
}
