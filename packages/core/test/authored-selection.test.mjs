import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { nativeOptions, exchanges } from "../../../test-support/device-2/fixture.mjs";
import { instrumentVm, nativeFixture, inputs } from "../../../test-support/handler-topology/fixture.mjs";
import { observations } from "../../../test-support/client-harness.mjs";

const wasm = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const source = await readFile(new URL("../../../test-support/device-2/preflight.lua", import.meta.url), "utf8");
const topology = await readFile(new URL("./fixtures/authored-topology/device.lua", import.meta.url), "utf8");
const population = lua => inputs(lua, "valid");
async function clientFor(t, lua, options) {
  const { server, module } = await createAuthoredSession(population(lua), wasm,
    { ...options, platform: "node", resourceBroker: {}, captureDestinationAdapter: {} });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("selection-test"); return { client, module };
}
for (const mode of ["interactive", "silent"]) for (const profile of ["serial", "serial-control"])
  test(`K1 entry sends selected first line: ${mode}/${profile}`, { timeout: 3000 }, async t => {
    const seen = [], options = nativeOptions(mode, profile, exchanges(mode), e => seen.push(e));
    const lua = source.replace('    io.request({kind="write",value="CONF:RATE 100\\r\\n"})', '')
      .replace('local value=receive(io,selection.modeId=="interactive" and 42 or 4)', 'local value=""');
    const { client } = await clientFor(t, lua, options);
    assert.deepEqual(seen, []);
    const result = await client.connect({ mode });
    assert.equal(result.modeId, mode); assert.equal(result.profileId, profile);
    assert.deepEqual(seen.filter(e => e.kind === "write").map(e => Buffer.from(e.bytes).toString()),
      mode === "interactive" ? ["\r\n", "*IDN?\r\n"] : ["*IDN?\r\n"]);
    const handle = await client.startOperation({ operation: "observe", arguments: {} });
    const observed = await client.awaitOperation(handle.operationId);
    assert.equal(observed.outcome, "completed", JSON.stringify(observed));
    assert.equal(observed.result.modeId, mode); assert.equal(observed.result.profileId, profile);
    assert.equal(observed.result.operationArguments, "");
  });

for (const [field, value, code] of [
  ["modeId", "other-mode", "authored.mode.unavailable"],
  ["profileId", "other-profile", "authored.profile.unavailable"],
  ["modeId", undefined, "authored.mode.unavailable"],
  ["profileId", undefined, "authored.profile.unavailable"],
]) test(`K1 refuses ${field}=${value} before entry, handler or acquisition`, { timeout: 3000 }, async t => {
  const seen = [], restore = instrumentVm(e => seen.push(e)); t.after(restore);
  const fixture = nativeFixture(e => seen.push(e));
  let accepted;
  try {
    accepted = await createAuthoredSession(population(topology), wasm, {
      ...fixture.options, [field]: value, platform: "node", resourceBroker: {}, captureDestinationAdapter: {},
    });
    const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(accepted.server));
    try { await client.attach("unexpected"); await client.connect({}); }
    finally { await client.disconnect(); await client.close(); }
    assert.fail("unavailable selection admitted; observations=" + JSON.stringify(seen));
  } catch (cause) {
    assert.equal(cause.code, code, String(cause));
    assert.ok(cause.message.includes(value ?? "<missing>"), cause.message);
  }
  assert.deepEqual(seen, [], "no native open or real retained VM dispatch before refusal");
});
test("K1 contradictory connect selection refuses before entry or acquisition", { timeout: 3000 }, async t => {
  const seen = [], restore = instrumentVm(e => seen.push(e)); t.after(restore);
  const { client } = await clientFor(t, source, nativeOptions("interactive", "serial", exchanges("interactive"), e => seen.push(e)));
  await assert.rejects(client.connect({ mode: "silent" }), e => e.error?.code === "retained.mode-unavailable" && e.error.message.includes("silent"));
  assert.deepEqual(seen, []);
  await client.connect({ mode: "interactive" });
  assert.ok(seen.some(e => e.kind === "write"));
});
