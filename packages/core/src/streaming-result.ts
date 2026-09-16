import type { AuthoredOperation, AuthoredResourceResult, PublicValue } from "@protodriver/contracts";
import { nativeKeys, nativeSort } from "@protodriver/lua-vm/retained";
import { StreamingSha256 } from "./streaming-sha256.ts";
import { TRANSFER_SOURCE_QUANTUM } from "./authored-transfer.ts";

function requireResult(ok: unknown, message: string): asserts ok {
  if (!ok) throw Object.assign(new Error(message), { error: { code: "authored.result.stream", message, responsibility: "definition", retryability: "no" } });
}
export function validateStreamedResult(r: AuthoredResourceResult, args: AuthoredOperation["arguments"]): number {
  const s = r.streamed!;
  requireResult(s && typeof s === "object" && nativeSort(nativeKeys(s)).join(",") === "length,offset,subject"
    && typeof s.subject === "string" && s.subject.length > 0 && s.subject.length <= 128, "bounded result subject and exact range required");
  const bounds = (v: typeof s.offset, minimum: number): [number, number] => {
    if (typeof v === "number") { requireResult(Number.isSafeInteger(v) && v >= minimum, "invalid result range constant"); return [v,v]; }
    requireResult(v && typeof v === "object" && nativeKeys(v).join() === "argument" && typeof v.argument === "string", "bounded result range argument required");
    const a = args[v.argument];
    requireResult(a?.kind === "integer" && Number.isSafeInteger(a.minimum) && Number.isSafeInteger(a.maximum)
      && a.minimum! >= minimum, "result range requires bounded integer arguments");
    return [a.minimum!,a.maximum!];
  };
  const o = bounds(s.offset,0), l = bounds(s.length,1);
  requireResult(l[0] >= r.minimumBytes && l[1] <= r.maximumBytes && Number.isSafeInteger(o[1]+l[1])
    && Number.isSafeInteger(Math.ceil(l[1]/TRANSFER_SOURCE_QUANTUM)*32000000), "result range or aggregate grant is outside declared bounds");
  return Math.ceil(l[1]/TRANSFER_SOURCE_QUANTUM);
}
export function resolveResultSubject(r: AuthoredResourceResult, args: Readonly<Record<string,PublicValue>>) {
  const s = r.streamed!;
  const value = (v: typeof s.offset) => typeof v === "number" ? v : typeof args[v.argument] === "number" ? args[v.argument] as number
    : Number((args[v.argument] as { value?: string })?.value);
  const offset = value(s.offset), length = value(s.length);
  requireResult(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 1
    && length >= r.minimumBytes && length <= r.maximumBytes && Number.isSafeInteger(offset+length), "resolved output subject is outside declaration");
  return { kind: "result-range" as const, domain: s.subject, offset, length };
}
/** Constant hash state. The caller owns one at-most-256-byte pending crossing. */
export class StreamingResult {
  bytes = 0;
  grant?: string;
  readonly count: number;
  readonly subject: ReturnType<typeof resolveResultSubject>;
  #hash: StreamingSha256;
  constructor(subject: ReturnType<typeof resolveResultSubject>, charge: () => void) {
    this.subject = subject;
    this.count = Math.max(1,Math.ceil(subject.length/TRANSFER_SOURCE_QUANTUM));
    this.#hash = new StreamingSha256(charge);
  }
  get eligibleIndex(): number { return Math.min(this.count-1,Math.floor(this.bytes/TRANSFER_SOURCE_QUANTUM)); }
  prepare(bytes: Uint8Array): StreamingSha256 {
    requireResult(bytes.length <= 256 && bytes.length <= this.subject.length-this.bytes, "streamed output exceeds chunk or exact extent before submission");
    const next = this.#hash.clone(); next.update(bytes); return next;
  }
  accept(hash: StreamingSha256, length: number): void { this.#hash = hash; this.bytes += length; }
  digest() {
    requireResult(this.bytes === this.subject.length, "streamed result is short");
    return { authority: "host-observed" as const, algorithm: "sha256" as const, value: this.#hash.hex(), subject: this.subject };
  }
}
