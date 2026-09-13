import type { AuthoredInputRetirement, Clock } from "@protodriver/contracts";
import { activeNativeScratch, nativeKeys } from "@protodriver/lua-vm/retained";
import { InputRetirementIndex } from "./input-retirement.ts";
import { nativeFault } from "./native-helper.ts";

/** A host-installed cut, not a declaration, a method-presence test, or an
 * authored capability. Only the composition root can attest the full group. */
export interface AuthoredRetirementCut {
  readonly index: InputRetirementIndex;
  readonly clock: Clock;
  readonly basisId: string;
  readonly generation: number;
}

/** B9's synchronous observation transaction. This component deliberately does
 * not install a cut or grant authority. The retained executor must first attach
 * every native/broker/handler obligation to its existing input account.
 *
 * The caller supplies its current native scratch scope. Query traversal,
 * validation and result storage spend that scope; there is no service grant,
 * timer, receipt ledger, result cache or retained per-query resource here.
 */
export class AuthoredInputRetirementService {
  readonly #clock: Clock;
  readonly #current: () => AuthoredRetirementCut | undefined;
  readonly #record: (observation: AuthoredInputRetirement) => undefined;
  #closed = false;
  constructor(clock: Clock, current: () => AuthoredRetirementCut | undefined,
    record: (observation: AuthoredInputRetirement) => undefined) {
    this.#clock = clock; this.#current = current; this.#record = record;
  }
  close(): void { this.#closed = true; }
  #live(cut?: AuthoredRetirementCut): AuthoredRetirementCut {
    if (this.#closed) throw nativeFault("retained.revoked", "input retirement service revoked");
    const current = this.#current();
    if (!current || current.index.closed || current.clock !== this.#clock)
      throw nativeFault("retained.input-retirement-unavailable", "no attested reliable input cut in this clock domain");
    if (cut && current !== cut)
      throw nativeFault("retained.revoked", "input retirement generation changed before delivery");
    return current;
  }
  sample(request: unknown): AuthoredInputRetirement {
    const scratch = activeNativeScratch();
    if (!scratch) throw nativeFault("retained.input-retirement-unfunded", "query requires the calling activation's work and storage account");
    scratch.iteration();
    const cut = this.#live();
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw nativeFault("retained.input-retirement-invalid", "expected a closed interval request");
    const r = request as Record<string, unknown>;
    const keys = nativeKeys(r);
    if (keys.length !== 5 || keys.some(key => !["kind", "basisId", "generation", "fromSequence", "beforeSequence"].includes(key))
      || r.kind !== "input-retirement")
      throw nativeFault("retained.input-retirement-invalid", "unexpected interval request fields");
    if (r.basisId !== cut.basisId)
      throw nativeFault("retained.input-retirement-basis", "interval belongs to a different session basis");
    if (r.generation !== cut.generation)
      throw nativeFault("retained.input-retirement-generation", "interval belongs to a different connection generation");
    const from = r.fromSequence, before = r.beforeSequence;
    if (typeof from !== "number" || typeof before !== "number" || !Number.isSafeInteger(from)
      || !Number.isSafeInteger(before) || from < 1 || before <= from)
      throw nativeFault("retained.input-retirement-invalid", "interval must be positive safe integers with fromSequence < beforeSequence");
    // Reserve the bounded immutable value before sampling; reserve failure
    // cannot leave a successful observation without its caller-owned storage.
    scratch.reserve(512 + cut.basisId.length * 3);
    const sequence = this.#clock.nextSequence();
    if (before > sequence)
      throw nativeFault("retained.input-retirement-future", "interval ends after the sampling cut");
    const retired = cut.index.retired(from, before, () => scratch.iteration());
    const observation = Object.freeze({ kind: "input-retirement" as const,
      basisId: cut.basisId, generation: cut.generation,
      fromSequence: from, beforeSequence: before, sequence, retired });
    try {
      // The mandatory recorder runs on the same caller scope, synchronously,
      // before any value can be delivered. A promise is not recording success.
      if (this.#record(observation) !== undefined)
        throw nativeFault("retained.input-retirement-recording", "retirement recording must complete synchronously");
      this.#live(cut);
    } catch (cause) { this.close(); throw cause; }
    return observation;
  }
}
