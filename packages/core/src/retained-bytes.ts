import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort } from "@protodriver/lua-vm/retained";
import { activeNativeScratch, nativeEncode } from "@protodriver/lua-vm/retained";
// Selected facade bounds, not a framing grammar. Strings keep their existing
// UTF-8 meaning; byte values never pass through a text encoder/decoder.
export function boundedBytes(value: Uint8Array, maximum = 256): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length > maximum) throw Object.assign(new Error("bounded octets required"), {
    error: { code: "retained.invalid-effect", message: "bounded octets required", retryability: "no" },
  });
  activeNativeScratch()?.reserve(8 + value.length);
  activeNativeScratch()?.work(1 + Math.ceil(value.length / 256));
  return value.slice();
}
export function byteString(value: Uint8Array): string {
  // Internal queue representation only: one code unit per octet. Never put
  // this representation onto a text wire or through a UTF-8 codec.
  let result = "";
  activeNativeScratch()?.reserve(8 + value.length * 6 + Math.ceil(value.length / 256) * 16);
  for (let offset = 0; offset < value.length; offset += 256) {
    activeNativeScratch()?.iteration();
    result += String.fromCharCode(...value.subarray(offset, offset + 256));
  }
  return result;
}
export function stringBytes(value: string): Uint8Array {
  activeNativeScratch()?.reserve(8 + value.length);
  return Uint8Array.from(value, character => {
    activeNativeScratch()?.iteration();
    const byte = character.charCodeAt(0);
    if (byte > 255) throw new Error("non-octet queue value");
    return byte;
  });
}
export function joinBytes(prefix: string, value: Uint8Array): Uint8Array {
  const head = nativeEncode(prefix);
  activeNativeScratch()?.reserve(8 + head.length + value.length);
  activeNativeScratch()?.work(2 + Math.ceil(head.length / 256) + Math.ceil(value.length / 256));
  const result = new Uint8Array(head.length + value.length);
  result.set(head); result.set(value, head.length); return result;
}
