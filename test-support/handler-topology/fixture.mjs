import { RealClock } from "../../packages/core/src/clock.ts";
import { MockTransport } from "../../packages/transport-mock/src/index.ts";
import { decodeLuaValueAbiFrame, requireLuaProgramInvocationOutcome } from "../../packages/lua-vm/src/value-abi.ts";

export function inputs(source, name) {
  return [{ logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
    { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source.replace('local selected="valid"', 'local selected=' + JSON.stringify(name))) }];
}

/** Observe the actual Wasm execution export, not an admission-wrapper call. */
export function instrumentVm(observe, onEffect = () => {}) {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...args) => {
    const result = await instantiate(...args), exports = result.instance.exports;
    return { ...result, instance: { exports: { ...exports,
      pdrv_retained_result_dispatch(...values) {
        observe({ kind: "vm-dispatch" });
        const count = exports.pdrv_retained_result_dispatch(...values);
        if (count > 0) {
          let reply;
          try { reply = requireLuaProgramInvocationOutcome(decodeLuaValueAbiFrame(new Uint8Array(exports.memory.buffer, values[3], count).slice())); }
          catch (cause) {
            // An encoded authored failure is a valid ABI outcome, not an
            // exception thrown by the native VM call this instrument wraps.
            if (!cause?.programFailureName) throw cause;
            observe({kind:"vm-program-failure",name:cause.programFailureName});
            return count;
          }
          // Start/resume have the trusted task-death envelope; retire and
          // invalidate return their host-control outcome directly.
          const effect = typeof reply.value?.ended === "boolean" ? reply.value.value : reply.value;
          observe({ kind: "vm-effect", effect: effect?.kind,
            ...(typeof effect?.value === "string" ? { value: effect.value } : {}) });
          onEffect(effect);
        }
        return count;
      },
    } } };
  };
  return () => { WebAssembly.instantiate = instantiate; };
}

export function nativeFixture(observe) {
  const clock = new RealClock(); let channel;
  return { options: { clock, modeId: "challenge", profileId: "serial", channelId: "main", helpers: {},
    async open() {
      observe({ kind: "native-open" });
      const c = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "challenge", profileId: "serial" });
      channel = c.channel("main"); const acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), write = lease.write.bind(lease), incoming = lease.incoming.bind(lease);
        lease.incoming = async function*() { for await (const chunk of incoming()) { yield chunk; observe({ kind: "ingress", value: new TextDecoder().decode(chunk.bytes) }); } };
        lease.write = async bytes => { const result = await write(bytes); observe({ kind: "write", value: new TextDecoder().decode(bytes) }); return result; };
        return lease;
      };
      return c;
    } }, ingress(value) { channel.enqueueReceived(new TextEncoder().encode(value)); } };
}
