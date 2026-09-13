import type { DiagnosticRecord } from "@protodriver/contracts";

interface RenderedRecord {
  readonly retainedBytes: number;
  readonly text: string;
}

const HEX_OCTETS = Object.freeze(Array.from(
  { length: 256 },
  (_, value) => value.toString(16).padStart(2, "0"),
));

/** A bounded rendering window; the diagnostic tap remains the byte authority. */
export class HexWindow {
  readonly #maximumBytes: number;
  readonly #records: RenderedRecord[] = [];
  #retainedBytes = 0;

  constructor(maximumBytes = 32 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("maximumBytes must be a positive safe integer");
    }
    this.#maximumBytes = maximumBytes;
  }

  append(record: Pick<DiagnosticRecord, "sequence" | "tUs" | "direction" | "bytes">): string {
    const omitted = Math.max(0, record.bytes.byteLength - this.#maximumBytes);
    const retained = omitted === 0 ? record.bytes : record.bytes.subarray(omitted);
    const prefix = `${record.sequence.toString().padStart(6)} ${record.tUs.toFixed(0).padStart(10)} ${record.direction.toUpperCase()}`;
    const text = `${prefix}${omitted === 0 ? "" : ` … ${omitted} earlier bytes not rendered`} ${hex(retained)}`;
    this.#records.push({ retainedBytes: retained.byteLength, text });
    this.#retainedBytes += retained.byteLength;
    while (this.#retainedBytes > this.#maximumBytes && this.#records.length > 1) {
      const removed = this.#records.shift();
      if (removed !== undefined) this.#retainedBytes -= removed.retainedBytes;
    }
    return `${this.#records.map(({ text: line }) => line).join("\n")}\n`;
  }
}

function hex(bytes: Uint8Array): string {
  let rendered = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (index > 0) rendered += " ";
    rendered += HEX_OCTETS[bytes[index]!]!;
  }
  return rendered;
}
