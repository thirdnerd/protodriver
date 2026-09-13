import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort, nativeEncode, nativeValue } from "./native-account.ts";
import type { VerifiedLuaSourceSet, AuthoredValueType, AuthoredOperation, PublicValue } from "@protodriver/contracts";
import { resolveLuaResourcePolicy, luaResourceError, type LuaResourcePolicyRequest } from "./resource-policy.ts";
import { environmentFailure } from "./environment-failure.ts";
import { NativeScratch, StandaloneNativeData, withNativeScratch, activeNativeScratch, type NativeDataAccount } from "./native-account.ts";
export type { NativeDataAccount } from "./native-account.ts";
export { NativeScratch, withNativeScratch, activeNativeScratch } from "./native-account.ts";
export { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort } from "./native-account.ts";
export { nativeValue, nativeJson, nativeEncode } from "./native-account.ts";
export { sourceMemberAdmissionError } from "./value-abi.ts";
import { decodeLuaValueAbiFrame, encodeLuaProgramInvocation, encodeLuaProgramInvocationInto, requireLuaAdmissionResult, requireLuaProgramInvocationOutcome } from "./value-abi.ts";

export const RETAINED_VM_SHA256 = "f0646d258acf98a02eabf678aea7ae90f118fca6e1014515ffbdb95987c54e37";

// D4/D5 execution defaults are independent accounts. Entry shares execution
// policy; effect-free admission keeps its own smaller allowance.
export const DEFAULT_RETAINED_EFFECT_WORK = 32_000_000;
export const RETAINED_LUA_FUEL = 1_000_000;
const RETAINED_ADMISSION_LUA_FUEL = 100_000;

function retainedVmFailure(status: number, fuelConsumed: number, phase: "admission" | "dispatch"): Error {
  // -2 is scratch capacity, NOT the retained result's recoverable -26.
  // Only the latter may trigger result-buffer growth before reporting failure.
  const resource = status === -17 ? "allocation-limit" : status === -18 ? "fuel-exhausted"
    : status === -28 ? "depth-limit"
    : status === -26 || (phase === "admission" && status === -2) ? "output-limit" : undefined;
  const error = resource === undefined ? environmentFailure(status)
    : luaResourceError(`lua-vm.resource.${resource}`, "retained Lua execution failed");
  error.message += ` (${phase}, VM status ${status})`;
  Object.defineProperties(error, {
    fuelConsumed: { value: fuelConsumed, enumerable: true },
    vmStatus: { value: status, enumerable: true },
    phase: { value: phase, enumerable: true },
  });
  return error;
}

// This slice threads the three byte/allocation policies. Do not advertise
// ignored fuel/watchdog overrides: the retained executor's existing fuel and
// outside-worker detector remain separate host policies.
export type RetainedLuaResourcePolicyRequest = Pick<LuaResourcePolicyRequest,
  "maximumEncodedInputBytes" | "maximumEncodedOutputBytes" | "maximumVmAllocationBytes">;
export function resolveRetainedLuaPolicy(request: RetainedLuaResourcePolicyRequest = {}) {
  if (nativeArray(nativeKeys(request)).some(key => !["maximumEncodedInputBytes", "maximumEncodedOutputBytes", "maximumVmAllocationBytes"].includes(key)))
    throw luaResourceError("lua-vm.resource.policy-limit", "unsupported retained byte/allocation policy member");
  const policy = resolveLuaResourcePolicy(request);
  return Object.freeze({maximumEncodedInputBytes:policy.maximumEncodedInputBytes,
    maximumEncodedOutputBytes:policy.maximumEncodedOutputBytes, maximumVmAllocationBytes:policy.maximumVmAllocationBytes});
}

// This shim is execution-runtime code, not part of the author's source identity.
// The entry is separately compiled, so authored code cannot name these locals.
// Retain primitive functions before entry can mutate its own library tables.
const dispatcher = `
local type,error,fields,sort=type,error,pdrv.record_fields,table.sort
local create,resume,status,yield=coroutine.create,coroutine.resume,coroutine.status,coroutine.yield
local readonly,array,null=pdrv.readonly,pdrv.array,pdrv.null
local char,unpack=string.char,table.unpack
local description,callables=pdrv.entry()
local bindings={}
local resolved={}
if type(callables)~="table" then error("callable table required") end
for name,fn in fields(callables) do
  if type(name)~="string" or type(fn)~="function" then error("invalid callable binding") end
  bindings[#bindings+1]=name
  resolved[name]=fn
end
sort(bindings)
local invalidation=description.invalidation and resolved[description.invalidation]
local tasks={}
local function dispatch(input)
  local action,key=input.action,input.id
  if action=="retire" then tasks[key]=nil; return {kind="retired"} end
  if action=="invalidate" then
    if invalidation then invalidation(input.value) end
    return {kind="invalidated"}
  end
  if action=="start" then
    local fn=resolved[input.binding]
    if type(fn)~="function" then error("unresolved binding") end
    local api=readonly({request=function(effect) return yield(effect) end,resultDestination=input.destination})
    local arguments=input.arguments
    if input.octets then arguments=readonly({input=char(unpack(input.octets)),sequence=arguments.sequence,channelId=arguments.channelId,observation=arguments.observation}) end
    if input.relayOctets then
      local request={}
      for name,value in fields(arguments) do request[name]=value end
      request.bytes=input.relayOctets
      arguments=readonly(request)
    end
    tasks[key]=create(function()
      if input.context and input.context.reentryRequired then
        local enter=resolved[input.context.reentryBinding]
        if type(enter)~="function" then error("unresolved reentry") end
        if enter(readonly({modeId=input.context.modeId,profileId=input.context.profileId}),api,input.context)~=nil then
          error("reentry must return nil")
        end
      end
      local result=fn(arguments,api,input.context)
      if result==nil then result=null end
      return {kind="result",value=result}
    end)
  end
  -- Public byte-valued arguments remain immutable ABI boundary values. A
  -- channel completion instead becomes the raw Lua string protocol code can
  -- parse. The host supplies bounded octets, never UTF-8-decoded payload text.
  local value=input.value
  if action=="resume" and input.octets then value=(input.waitPrefix or "")..char(unpack(input.octets)) end
  if action=="resume" and input.rawOctets then value=(input.waitPrefix or "")..input.rawOctets end
  local ok,result=resume(tasks[key],value)
  if not ok then error(result) end
  local ended=status(tasks[key])=="dead"
  if ended then tasks[key]=nil end
  -- Outside the authored value: yielding a result is not coroutine death.
  return {ended=ended,value=result}
end
return {description=description,bindings=array(bindings)},{dispatch=dispatch}
`;

function abi(value: unknown): unknown {
  activeNativeScratch()?.node();
  if (typeof value === "string") activeNativeScratch()?.text(value);
  if (value instanceof Uint8Array) activeNativeScratch()?.reserve(16);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "number") return { kind: "float64", decimal: String(value) };
  if (typeof value === "bigint") return { kind: "integer", decimal: String(value) };
  if (value instanceof Uint8Array) return { kind: "bytes-buffer", value };
  if (Array.isArray(value)) return { kind: "array", items: nativeArray(value).map(abi) };
  if (value && typeof value === "object") return { kind: "record", entriesInCanonicalOrder: nativeArray(nativeSort(nativeEntries(value), ([a], [b]) => a < b ? -1 : a > b ? 1 : 0)).map(([key, v]) => [key, abi(v)]) };
  throw new Error("retained ABI input is not a supported value");
}
function argumentAbi(value: PublicValue, schema: AuthoredValueType, iteration?: () => void, directBytes = false): unknown {
  iteration?.(); activeNativeScratch()?.reserve(8);
  if (schema.kind === "record") return { kind: "record", entriesInCanonicalOrder: nativeSort(nativeArray(nativeKeys(schema.fields!))).map(key => [key, argumentAbi((value as Record<string, PublicValue>)[key]!, schema.fields![key]!, iteration, directBytes)]) };
  if (schema.kind === "array") return { kind: "array", items: nativeArray((value as readonly PublicValue[])).map(item => argumentAbi(item, schema.item!, iteration, directBytes)) };
  if (schema.kind === "variant") {
    const v = value as { tag: string; value: PublicValue };
    return { kind: "record", entriesInCanonicalOrder: [["kind", abi("variant")], ["tag", abi(v.tag)], ["value", argumentAbi(v.value, schema.variants![v.tag]!, iteration, directBytes)]] };
  }
  if (schema.kind === "integer") return { kind: schema.signed ? "i64" : "u64", decimal: typeof value === "number" ? String(value) : (value as { value: string }).value };
  if (schema.kind === "decimal") return abi((value as { value: string }).value);
  if (schema.kind === "bytes") {
    if (directBytes) return { kind: "bytes-base64", value: (value as { value: string }).value };
    activeNativeScratch()?.text((value as { value: string }).value);
    const bytes = atob((value as { value: string }).value);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) { iteration?.(); hex += bytes.charCodeAt(i).toString(16).padStart(2, "0"); }
    return { kind: "bytes", hex };
  }
  return abi(value);
}
function invocationSemantic(request: unknown, types?: Readonly<Record<string, AuthoredValueType>>, iteration?: () => void, directBytes = false) {
  const semantic = abi(types ? { ...(request as object), arguments: null } : request) as { entriesInCanonicalOrder: Array<[string, unknown]> };
  if (types) {
    const args = (request as { arguments: Record<string, PublicValue> }).arguments;
    semantic.entriesInCanonicalOrder.find(([key]) => key === "arguments")![1] = {
      kind: "record", entriesInCanonicalOrder: nativeSort(nativeArray(nativeKeys(types))).map(key => [key, argumentAbi(args[key]!, types[key]!, iteration, directBytes)]) };
  }
  return semantic;
}
/** Minimum framing overhead plus the full declared source population. Ordinary
 * argument-dependent size is checked by the operation preflight separately. */
export function assertSourceDeclarationPolicy(operation: AuthoredOperation, maximum: number): void {
  const args: Record<string, PublicValue> = {}, types: Record<string, AuthoredValueType> = {};
  let payload = 0;
  for (const [name, type] of nativeEntries(operation.arguments)) if (type.kind === "byte-source") {
    args[name] = { type: "bytes", encoding: "base64", value: "" }; types[name] = { kind: "bytes" }; payload += type.maximumBytes;
  }
  if (!nativeKeys(types).length) return;
  const semantic = invocationSemantic({ action: "start", id: "retained-operation-0", binding: operation.binding,
    arguments: args, value: null, destination: null }, types);
  if (encodeLuaProgramInvocation("dispatch", semantic).length + payload > maximum)
    throw luaResourceError("lua-vm.resource.input-limit", "declared source population cannot fit complete invocation policy");
}
type Exports = WebAssembly.Exports & {
  readonly memory: WebAssembly.Memory;
  readonly _initialize: () => void;
  readonly malloc: (length: number) => number;
  readonly free: (pointer: number) => void;
  readonly pdrv_lua_vm_smoke: () => number;
  readonly pdrv_lua_invocation_open_admission_bounded: (
    source: number, sourceLength: number, output: number, outputCapacity: number,
    allocationLimit: number, fuelLimit: number, fuelUsed: number, handleOutput: number,
  ) => number;
  readonly pdrv_lua_invocation_execute_bounded: (
    handle: number, input: number, inputLength: number, output: number,
    outputCapacity: number, fuelLimit: number, fuelUsed: number,
  ) => number;
  pdrv_retained_scratch_clear: () => void;
  pdrv_retained_result_open: Exports["pdrv_lua_invocation_open_admission_bounded"];
  pdrv_retained_result_close: (handle: number) => void;
  pdrv_retained_result_dispatch: Exports["pdrv_lua_invocation_execute_bounded"];
  pdrv_retained_result_encode: (handle: number, output: number, capacity: number) => number;
};
function exactIntegers(node: unknown, value: unknown): unknown {
  activeNativeScratch()?.node();
  if (!node || typeof node !== "object") return value;
  const n = node as { kind: string; decimal: string; entriesInCanonicalOrder: [string, unknown][]; items: unknown[]; value: unknown };
  if (["i64", "u64", "integer"].includes(n.kind)) { activeNativeScratch()?.text(n.decimal); return BigInt(n.decimal); }
  if (n.kind === "array") return nativeArray(n.items).map((child, i) => exactIntegers(child, (value as unknown[])[i]));
  if (n.kind === "record") return nativeRecord(nativeArray(n.entriesInCanonicalOrder).map(([key, child]) => [key, exactIntegers(child, (value as Record<string, unknown>)[key])]));
  if (n.kind === "variant") return { ...(value as object), value: exactIntegers(n.value, (value as { value: unknown }).value) };
  return value;
}
function effectNumbers(value: unknown): unknown {
  activeNativeScratch()?.node();
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (Array.isArray(value)) return nativeArray(value).map(effectNumbers);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) return nativeRecord(nativeArray(nativeEntries(value)).map(([key, child]) => [key, effectNumbers(child)]));
  return value;
}
export async function openRetainedLua(source: VerifiedLuaSourceSet, artifact: Uint8Array, request: RetainedLuaResourcePolicyRequest = {}, nativeData: NativeDataAccount = new StandaloneNativeData()) {
  const policy = resolveRetainedLuaPolicy(request);
  const bytes = artifact.slice();
  const digest = nativeArray([...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]).map(v => v.toString(16).padStart(2, "0")).join("");
  if (digest !== RETAINED_VM_SHA256) throw new Error("authored.vm.digest-mismatch");
  let e: Exports;
  let chargeEncoding: ((units: number) => void) | undefined, encodingFailure: unknown;
  let poisoned = false, allocationSerial = 0;
  const scratch = new Map<number, { release(): void }>();
  const hostScratch = new Set<NativeScratch>();
  // Failure details escape on the rejected invocation, not on a result handle.
  // Keep their decoded store until the consumer retires that invocation.
  const failureScratch = new Map<string, NativeScratch>();
  const nativeWork = (units: number) => {
    if (encodingFailure !== undefined) throw encodingFailure;
    if (!chargeEncoding) throw new Error("authored.vm.encoding-account-missing");
    chargeEncoding(units);
  };
  const forbidden = () => { throw new Error("authored.vm.forbidden-host-call"); };
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth() {}, __syscall_dup3: forbidden,
      pdrv_retained_work(units: number) {
        try { nativeWork(units); }
        catch (cause) { poisoned = true; encodingFailure = cause; throw cause; }
      },
      pdrv_retained_reserve(capacity: number) {
        try {
          if (allocationSerial === 0xffff_ffff) throw luaResourceError("retained.helper-data-exhausted", "scratch identity exhausted");
          const held = (activeNativeScratch()?.dataAccount ?? nativeData).reserve(capacity);
          const id = ++allocationSerial; scratch.set(id, held); return id;
        } catch (cause) { poisoned = true; encodingFailure = cause; throw cause; }
      },
      pdrv_retained_release(id: number) {
        const held = scratch.get(id);
        if (!held) throw new Error("authored.vm.scratch-ownership");
        held.release(); scratch.delete(id);
      },
      pdrv_retained_charge_work(units: number) {
        if (encodingFailure !== undefined) return 0;
        try { if (!chargeEncoding) throw new Error("authored.vm.encoding-account-missing"); chargeEncoding(units); return 1; }
        catch (cause) { encodingFailure = cause; return 0; }
      },
      pdrv_lua_require_source(np: number, nl: number, out: number, capacity: number) {
        try {
        activeNativeScratch()?.reserve(8 + nl * 3); nativeWork(nl);
        const name = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(e.memory.buffer, np, nl));
        const owned = source.sourceBytes(name, length => {
          activeNativeScratch()?.reserve(8 + length);
          nativeWork(1 + Math.ceil(length / 256));
        });
        if (!owned) return -1;
        if (!capacity) return owned.length;
        if (owned.length > capacity) return -1;
        nativeWork(1 + Math.ceil(owned.length / 256));
        new Uint8Array(e.memory.buffer, out, owned.length).set(owned); return owned.length;
        } catch (cause) { poisoned = true; encodingFailure = cause; throw cause; }
      } },
    wasi_snapshot_preview1: { fd_read: forbidden, fd_write: forbidden, fd_close: forbidden, fd_seek: forbidden },
  });
  e = instance.exports as Exports; e._initialize();
  if (e.pdrv_lua_vm_smoke() !== 42 || typeof e.pdrv_retained_result_encode !== "function") throw new Error("authored.vm.contract-mismatch");
  const inputCapacity = policy.maximumEncodedInputBytes;
  let outputCapacity = policy.maximumEncodedOutputBytes, output = e.malloc(outputCapacity);
  const input = e.malloc(inputCapacity), fuel = e.malloc(4), handleOut = e.malloc(4);
  let handle = 0, closed = false;
  const accounts = new Map<string, { consumed: number; work: number; maximumFuel: number; segments: number; segment: number }>();
  const workChargers = new Map<string, (units: number) => void>();
  const endedTasks = new Set<string>();
  const sourceInputMeters = new Map<string, () => void>();
  // Completed input tasks may still fund queued siblings. These are bounded
  // account records, not live Lua coroutines or fresh grants.
  const retainedAccounts = new Map<string, { consumed: number; work: number; maximumFuel: number; segments: number; segment: number }>();
  const close = () => {
    if (closed) return;
    closed = true; accounts.clear(); retainedAccounts.clear(); workChargers.clear(); endedTasks.clear(); sourceInputMeters.clear();
    try {
      // A host import can interrupt Lua outside a protected C boundary. Never
      // enter that context again, even for Lua finalizers. Discard the instance.
      if (!poisoned) {
        e.pdrv_retained_scratch_clear();
        if (handle) e.pdrv_retained_result_close(handle);
        for (const p of [input, output, fuel, handleOut]) if (p) e.free(p);
      }
    } finally {
      for (const held of scratch.values()) held.release(); scratch.clear();
      for (const scope of hostScratch) scope.close(); hostScratch.clear();
      failureScratch.clear();
      if (poisoned) e = undefined as unknown as Exports;
    }
  };
  const put = (v: Uint8Array) => {
    if (v.length > inputCapacity) throw luaResourceError("lua-vm.resource.input-limit", "encoded input exceeds resolved policy");
    activeNativeScratch()?.work(1 + Math.ceil(v.length / 256));
    new Uint8Array(e.memory.buffer, input, v.length).set(v);
  };
  try {
    if (!input || !output || !fuel || !handleOut) throw new Error("authored.vm.allocation-failed");
    const code = new TextEncoder().encode(dispatcher); put(code);
    // One bounded effect-free evaluation, not a fresh account per comparison.
    // Retained execution below uses its actual activation/parent work account.
    let admissionWork = 0;
    chargeEncoding = units => {
      if (admissionWork + units > 100000) throw luaResourceError("retained.work-exhausted", "native admission work exhausted");
      admissionWork += units;
    };
    const admissionScratch = new NativeScratch(nativeData, nativeWork); hostScratch.add(admissionScratch);
    admissionScratch.reserve(8 + 64 * 64); // bounded task-death witness index, held until VM close
    withNativeScratch(admissionScratch, () => {
      const entry = source.sourceBytes("device.lua", length => {
        admissionScratch.reserve(8 + length); admissionScratch.work(1 + Math.ceil(length / 256));
      });
      if (!entry) throw new Error("authored.entry.missing");
    });
    let result: number;
    try { result = withNativeScratch(admissionScratch, () => e.pdrv_retained_result_open(input, code.length, output, outputCapacity, policy.maximumVmAllocationBytes, RETAINED_ADMISSION_LUA_FUEL, fuel, handleOut)); }
    finally { if (!poisoned) e.pdrv_retained_scratch_clear(); }
    handle = new DataView(e.memory.buffer).getUint32(handleOut, true);
    if (encodingFailure) throw encodingFailure;
    if (result < 0) throw retainedVmFailure(result, new DataView(e.memory.buffer).getUint32(fuel, true), "admission");
    if (!handle) throw new Error("authored.vm.admission-handle-missing");
    const admission = withNativeScratch(admissionScratch, () => {
      admissionScratch.reserve(8 + result); admissionScratch.work(1 + Math.ceil(result / 256));
      return requireLuaAdmissionResult(decodeLuaValueAbiFrame(new Uint8Array(e.memory.buffer, output, result).slice()));
    });
    const graph = admission.graph as { description: unknown; bindings: string[] };
    // Admission uses the complete policy buffer. Dispatch starts with a small
    // reservation derived from that same policy, not another result ceiling.
    e.free(output); output = 0;
    outputCapacity = Math.max(1, Math.ceil(policy.maximumEncodedOutputBytes / 16));
    output = e.malloc(outputCapacity);
    if (!output) throw new Error("authored.vm.allocation-failed");
    const [handlerBindings, authorizationBindings] = withNativeScratch(admissionScratch, () => {
      const handlers = (graph.description as { handlers?: Array<{ binding: string; authorizeWrite?: string }> }).handlers ?? [];
      admissionScratch.reserve(16 + handlers.length * 64); admissionScratch.work(handlers.length * 2);
      return [new Set(nativeArray(handlers).map(handler => handler.binding)),
        new Set(nativeArray(handlers).map(handler => handler.authorizeWrite))] as const;
    });
    chargeEncoding = undefined;
    const invoke = (id: string, request: unknown, argumentTypes?: Readonly<Record<string, AuthoredValueType>>) => {
      if (closed || !accounts.has(id)) throw new Error("authored.vm.account-revoked");
      const remaining = accounts.get(id)!.maximumFuel - accounts.get(id)!.consumed;
      if (remaining <= 0) { close(); throw retainedVmFailure(-18, 0, "dispatch"); }
      new DataView(e.memory.buffer).setUint32(fuel, 0, true);
      encodingFailure = undefined;
      chargeEncoding = units => {
        const account = accounts.get(id)!;
        const charge = workChargers.get(id);
        if (charge) charge(units);
        else if (account.work + units > DEFAULT_RETAINED_EFFECT_WORK) throw luaResourceError("retained.work-exhausted", "native encoding work exhausted");
        account.work += units;
      };
      const caller = activeNativeScratch();
      const data = caller?.owner === id ? caller.dataAccount : nativeData;
      const inputScope = new NativeScratch(data, nativeWork, id); hostScratch.add(inputScope);
      const scope = new NativeScratch(data, nativeWork, id); hostScratch.add(scope);
      let authoredFailure = false;
      try {
      const { count, consumed } = withNativeScratch(inputScope, () => {
      request = typeof request === "function" ? request() : request;
      // B4 authorization is another bounded binary invocation. Reuse B1's
      // single-pass encoder; nested ByteWriter scalar staging amplifies even
      // a 64 KiB carrier beyond the unchanged native residency account.
      const direct = argumentTypes !== undefined && (sourceInputMeters.has(id)
        || (request as { relayOctets?: unknown }).relayOctets instanceof Uint8Array);
      const iteration = inputScope.iteration;
      const semantic = invocationSemantic(request, argumentTypes, iteration, direct);
      let encodedLength: number;
      if (direct) encodedLength = encodeLuaProgramInvocationInto("dispatch", semantic,
        new Uint8Array(e.memory.buffer, input, inputCapacity), iteration);
      else { const encoded = encodeLuaProgramInvocation("dispatch", semantic, iteration); put(encoded); encodedLength = encoded.length; }
      let count: number;
        count = e.pdrv_retained_result_dispatch(handle, input, encodedLength, output, outputCapacity, remaining, fuel);
        while (count === -26 && outputCapacity < policy.maximumEncodedOutputBytes) {
          e.free(output); output = 0;
          // One recovery allocation, directly from policy. Geometric growth
          // needlessly repeats native traversal and can consume the account.
          outputCapacity = policy.maximumEncodedOutputBytes;
          output = e.malloc(outputCapacity);
          if (!output) throw new Error("authored.vm.allocation-failed");
          // The tagged outcome survives; NEVER dispatch the authored turn again.
          count = e.pdrv_retained_result_encode(handle, output, outputCapacity);
        }
      const consumed = new DataView(e.memory.buffer).getUint32(fuel, true); accounts.get(id)!.consumed += consumed;
      if (encodingFailure) throw encodingFailure;
      if (count < 0) throw retainedVmFailure(count, consumed, "dispatch");
      return { count, consumed };
      });
      // The native call has consumed the crossing, including any -26 retry.
      // Encoding intermediates must not stay resident while the result waits
      // on I/O. The decoded result has a distinct handoff lifetime below.
      inputScope.close(); hostScratch.delete(inputScope);
      return withNativeScratch(scope, () => {
      activeNativeScratch()?.reserve(8 + count);
      activeNativeScratch()?.work(1 + Math.ceil(count / 256));
      const decoded = decodeLuaValueAbiFrame(new Uint8Array(e.memory.buffer, output, count).slice());
      authoredFailure = decoded.envelopeKind === "program-failure";
      let value = exactIntegers(decoded.semantic, requireLuaProgramInvocationOutcome(decoded).value);
      const action = (request as { action: string }).action;
      if (action === "start" || action === "resume") {
        scope.work(2); // inspect trusted envelope and update the bounded witness index
        if (!value || typeof value !== "object" || !("ended" in value) || typeof value.ended !== "boolean" || !("value" in value))
          throw new Error("authored.vm.invalid-task-envelope");
        if (value.ended) endedTasks.add(id);
        value = value.value;
      }
      // Effect setup fields are bounded mathematical integers; authoring `1`
      // must not require `1.0`. Typed operation results retain their ABI kinds.
      return { value: value && typeof value === "object" && "kind" in value && value.kind !== "result" ? effectNumbers(value) : value, consumed,
        release() { scope.close(); hostScratch.delete(scope); } };
      }); } catch (cause) {
        if (!closed && cause instanceof Error && !Object.hasOwn(cause, "fuelConsumed"))
          Object.defineProperty(cause, "fuelConsumed", { value: new DataView(e.memory.buffer).getUint32(fuel, true), enumerable: true });
        // A decoded authored failure is an operation outcome, not corruption
        // of the retained VM. The wider accounting catch must not turn it
        // into session death. Resource/encoding/bridge refusals remain sticky.
        if (authoredFailure && !encodingFailure && !poisoned) {
          inputScope.close(); hostScratch.delete(inputScope);
          failureScratch.set(id, scope);
        } else close();
        throw cause;
      }
      finally { if (!closed && !poisoned) e.pdrv_retained_scratch_clear(); chargeEncoding = undefined; }
    };
    const admissionRun = <T>(run: () => T): T => {
        if (closed) throw new Error("authored.vm.account-revoked");
        chargeEncoding = units => {
          if (admissionWork + units > 100000) throw luaResourceError("retained.work-exhausted", "native admission work exhausted");
          admissionWork += units;
        };
        try { return withNativeScratch(admissionScratch, run); } finally { chargeEncoding = undefined; }
    };
    return { description: graph.description, bindings: Object.freeze([...graph.bindings]),
      admission: admissionRun,
      execution: {
        // Trusted composition only; no method/account crosses a session wire.
        // Construction after description validation spends the SAME bounded
        // effect-free evaluation account, not a third admission allowance.
        admission: admissionRun,
        get terminated() { return closed; },
        preflightSourceInput(id: string, binding: string, args: Readonly<Record<string, PublicValue>>,
          types: Readonly<Record<string, AuthoredValueType>>, lengths: Readonly<Record<string, number>>, iteration: () => void, destination?: string, context?: Readonly<Record<string, PublicValue>>) {
          const scope = new NativeScratch(nativeData, units => { for (let i = 0; i < units; i++) iteration(); });
          try { return withNativeScratch(scope, () => {
          const empty = { ...args };
          for (const key of nativeKeys(lengths)) { iteration(); empty[key] = { type: "bytes", encoding: "base64", value: "" }; }
          const semantic = invocationSemantic({ action: "start", id, binding, arguments: empty, value: null, destination: destination ?? null, ...(context ? { context } : {}) }, types, iteration);
          // ABI bytes use a fixed-width length, not content-dependent escaping.
          // Empty sources plus every L is the exact complete frame size.
          const maximum = encodeLuaProgramInvocation("dispatch", semantic, iteration).length + nativeArray(nativeValues(lengths)).reduce((a, b) => a + b, 0);
          if (maximum > inputCapacity) throw luaResourceError("lua-vm.resource.input-limit", "complete source invocation exceeds resolved input policy before reading");
          sourceInputMeters.set(id, iteration);
          return maximum;
          }); } finally { scope.close(); }
        },
        async register(id: string, parent?: string, chargeWork?: (units: number) => void, maximumFuel = RETAINED_LUA_FUEL, segments = 1) {
          if (closed || accounts.has(id) || retainedAccounts.has(id) || accounts.size >= 64) throw new Error("authored.vm.account-limit");
          if (parent !== undefined && !accounts.has(parent) && !retainedAccounts.has(parent)) throw new Error("authored.vm.account-revoked");
          // An effect-caused callback has a distinct task but cannot print fuel.
          if (!Number.isSafeInteger(maximumFuel) || maximumFuel < 1 || maximumFuel > RETAINED_LUA_FUEL) throw new Error("authored.vm.invalid-fuel-partition");
          if (!Number.isSafeInteger(segments) || segments < 1 || !Number.isSafeInteger(segments * maximumFuel) || (parent !== undefined && segments !== 1))
            throw new Error("authored.vm.invalid-segment-plan");
          accounts.set(id, parent === undefined ? { consumed: 0, work: 0, maximumFuel, segments, segment: 0 } : (accounts.get(parent) ?? retainedAccounts.get(parent))!);
          if (chargeWork) workChargers.set(id, chargeWork);
        },
        async advanceSegment(id: string, index: number) {
          const account = accounts.get(id);
          if (closed || !account || endedTasks.has(id) || !Number.isSafeInteger(index) || index <= account.segment || index >= account.segments
            || account.consumed >= account.maximumFuel)
            throw new Error("authored.vm.segment-revoked");
          let references = 0;
          for (const population of [accounts, retainedAccounts]) for (const other of population.values()) {
            const charge = workChargers.get(id);
            if (charge) charge(1);
            else if (++account.work > DEFAULT_RETAINED_EFFECT_WORK) throw luaResourceError("retained.work-exhausted", "segment alias check exhausted work");
            if (other === account && ++references > 1) throw new Error("authored.vm.segment-revoked");
          }
          // Trusted host schedule only. The coroutine survives; its unused
          // account does not. No effect exposed to Lua can call this method.
          account.segment = index; account.consumed = 0; account.work = 0;
        },
        async startOperation(id: string, binding: string, args: Readonly<Record<string, PublicValue>>, types: Readonly<Record<string, AuthoredValueType>>, destination?: string, context?: Readonly<Record<string, PublicValue>>) {
          return invoke(id, () => {
          const channelInput = handlerBindings.has(binding) && types.input?.kind === "bytes";
          if (channelInput) {
            const input = (args.input as { value: string }).value;
            activeNativeScratch()?.text(input); activeNativeScratch()?.reserve(8 + input.length * 16);
            activeNativeScratch()?.work(input.length);
          }
          const octets = channelInput ? Array.from(atob((args.input as { value: string }).value), c => c.charCodeAt(0)) : undefined;
          // Like channel ingress, exact proposed octets enter as an immutable
          // Lua byte string, not UTF-8 text or an opaque result-boundary value.
          let relayOctets: Uint8Array | undefined;
          if (authorizationBindings.has(binding) && types.bytes?.kind === "bytes") {
            const input = (args.bytes as { value: string }).value;
            // The trusted host supplies B4's bound for this task; ordinary C2
            // and D6 cleanup still supply 256. Refuse before scaling copies.
            const maximum = types.bytes.maximumLength ?? 256;
            if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536 || input.length > Math.ceil(maximum / 3) * 4)
              throw new Error("authored.vm.byte-completion-limit");
            activeNativeScratch()?.text(input); activeNativeScratch()?.reserve(8 + input.length * 4);
            activeNativeScratch()?.work(input.length);
            relayOctets = Uint8Array.from(atob(input), c => c.charCodeAt(0));
            if (relayOctets.length > maximum) throw new Error("authored.vm.byte-completion-limit");
          }
          if (octets && octets.length > 256) throw new Error("authored.vm.byte-completion-limit");
          return { action: "start", id, binding, arguments: args, value: null, destination: destination ?? null,
            ...(octets ? { octets } : {}), ...(relayOctets ? { relayOctets } : {}), ...(context ? { context } : {}) };
          }, types);
        },
        async dispatch(id: string, text: string) { return invoke(id, () => { activeNativeScratch()?.text(text); const [action, , ...rest] = text.split("|"); return { action, id, value: rest.join("|") }; }); },
        async dispatchObservation(id: string, observation: import("@protodriver/contracts").AuthoredClockObservation | import("@protodriver/contracts").AuthoredExpiryObservation | import("@protodriver/contracts").AuthoredInputRetirement) {
          return invoke(id, () => { nativeValue(observation); return { action: "resume", id, value: { ...observation } }; });
        },
        async dispatchBytes(id: string, input: Uint8Array) {
          return invoke(id, () => {
          const header = nativeEncode("resume|" + id + "|");
          if (input.length < header.length) throw new Error("authored.vm.invalid-byte-envelope");
          for (let i = 0; i < header.length; i++) {
            activeNativeScratch()?.work(1);
            if (input[i] !== header[i]) throw new Error("authored.vm.invalid-byte-envelope");
          }
          const length = input.length - header.length;
          if (length > 256) throw new Error("authored.vm.byte-completion-limit");
          // One byte copy, not a numeric-array expansion plus repeated scans.
          activeNativeScratch()?.reserve(16 + length); activeNativeScratch()?.work(length);
          return { action: "resume", id, value: null, rawOctets: input.slice(header.length) };
          });
        },
        async dispatchWaitBytes(id: string, prefix: string, bytes: Uint8Array) {
          // Metadata is a bounded text value; native octets are a separate
          // owned value. Do not debit a wait tag from the 256-octet read bound
          // or encode a binary payload as text to fit the old completion port.
          if (typeof prefix !== "string" || (prefix !== "receive:" && !/^message:[a-zA-Z0-9_-]{1,64}:$/u.test(prefix)))
            throw new Error("authored.vm.invalid-wait-prefix");
          if (!(bytes instanceof Uint8Array) || bytes.length > 256) throw new Error("authored.vm.byte-completion-limit");
          // Host envelope refusal has not entered Lua and must not poison the
          // context. Only the conversion below belongs inside invoke's scope.
          return invoke(id, () => {
          activeNativeScratch()?.reserve(8 + bytes.length * 17); activeNativeScratch()?.work(bytes.length * 2);
          const octets = bytes.slice();
          return { action: "resume", id, value: null, waitPrefix: prefix, octets: [...octets] };
          });
        },
        async retire(id: string, retainAccount = false) {
          let consumed = 0;
          sourceInputMeters.delete(id);
          // Public terminal publication has consumed the failure by this point.
          const failure = failureScratch.get(id);
          if (failure) { failure.close(); hostScratch.delete(failure); failureScratch.delete(id); }
          if (retainedAccounts.has(id)) { if (!retainAccount) retainedAccounts.delete(id); return; }
          try {
            if (!closed && accounts.has(id) && !endedTasks.has(id)) {
              const result = invoke(id, { action: "retire", id, value: null });
              consumed = result.consumed; result.release();
            }
            if (!closed && retainAccount && accounts.has(id)) {
              if (retainedAccounts.size >= 1024) throw new Error("authored.vm.retained-account-limit");
              retainedAccounts.set(id, accounts.get(id)!);
            }
          } finally { accounts.delete(id); workChargers.delete(id); endedTasks.delete(id); }
          return { consumed };
        },
        async close() { close(); },
      }, close,
    };
  } catch (cause) { close(); throw cause; }
}
