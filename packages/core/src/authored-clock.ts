import type { AuthoredClockObservation, AuthoredValueType, Clock } from "@protodriver/contracts";
import { nativeFault } from "./native-helper.ts";

export const clockObservationType: AuthoredValueType = { kind: "record", fields: {
  basisId: { kind: "string", maximumLength: 64 },
  // Host-validated safe integers use the same numeric Lua representation as
  // the completion, not the public u64 wrapper representation.
  generation: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  sequence: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  elapsedUs: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
} };

/** Session-owned constant-space basis. Past ingress is allowed to predate a
 * later clock read; it must not be retimestamped at handler dispatch. */
export class AuthoredTimeBasis {
  readonly state: { basisId: string; originUs: number; lastUs: number };
  readonly clock: Pick<Clock, "monotonicUs">;
  constructor(clock: Pick<Clock, "monotonicUs">) {
    this.clock = clock;
    const originUs = clock.monotonicUs();
    if (!Number.isFinite(originUs) || originUs < 0 || originUs > Number.MAX_SAFE_INTEGER)
      throw nativeFault("retained.clock-invalid", "invalid monotonic session origin");
    // Native ReceivedChunk.tUs is already floored. Use its lattice for the
    // origin too; retain the raw last sample to detect even sub-tick regressions.
    this.state = { basisId: crypto.randomUUID(), originUs: Math.floor(originUs), lastUs: originUs };
  }
  observe(sequence: number, generation: number, acceptedUs?: number): AuthoredClockObservation {
    const now = this.clock.monotonicUs();
    if (!Number.isFinite(now) || now < this.state.lastUs || now > Number.MAX_SAFE_INTEGER)
      throw nativeFault("retained.clock-invalid", "monotonic source regressed or exhausted");
    this.state.lastUs = now;
    const at = acceptedUs ?? now;
    if (!Number.isFinite(at) || at < this.state.originUs || at > now
      || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(generation) || generation < 1)
      throw nativeFault("retained.clock-invalid", "invalid ordered clock observation");
    const elapsedUs = Math.floor(at - this.state.originUs);
    if (!Number.isSafeInteger(elapsedUs)) throw nativeFault("retained.clock-invalid", "elapsed clock domain exhausted");
    return Object.freeze({ basisId: this.state.basisId, generation, sequence, elapsedUs });
  }
}
