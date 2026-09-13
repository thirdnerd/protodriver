import { copy } from "../../../test-support/refusal/cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAuthoredFileArgument } from "../../generated-cli/src/index.ts";
import { admitAuthoredModule } from "../src/authored-module.ts";
import { materializeSourceArguments } from "../src/source-materialization.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { ResourceBrokerHost, ResourceBrokerRpcClient, DirectResourceRpcAdapter } from "../src/resources.ts";
import { CaptureDestinationRegistry, DirectCaptureDestinationRpcAdapter } from "../src/capture-rpc.ts";
import { CaptureWriter, loadCapture } from "../src/capture.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const raw = Uint8Array.of(0, 128, 255, 65);
const bytes = value => ({ type: "bytes", encoding: "base64", value: Buffer.from(value).toString("base64") });
function population({ extra = "", maximum = 4, minimum = 4, kind = "byte-source", body = 'if args.expected==pdrv.bytes("\\x00\\x80\\xffA") then io.request({kind="write",value="SENTINEL"}) end;return args.expected' } = {}) {
  return [{ logicalName: "pdpkg.json", sourceBytes: Buffer.from('{"packageFormat":1,"generatorContract":2}') },
    { logicalName: "device.lua", sourceBytes: Buffer.from(`return {apiVersion="device/v2",id="source-control",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array({{
      id="run",title="Run",binding="run",arguments={expected={kind="${kind}",minimumBytes=${minimum},maximumBytes=${maximum}}${extra}},
      result={kind="value",type={kind="bytes"}},risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"channel"}),requires=pdrv.array({}),
      availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})}}})},{run=function(args,io) ${body} end}`) }];
}
function source(data = raw, { length = data.length, chunk = 256, eofWithData = false, unresolved = false, seekable = true, beforeRead = async () => {} } = {}) {
  let offset = 0, reads = 0, closed = 0;
  return { origin: "memory", byteLength: length, get reads() { return reads; }, get closed() { return closed; },
    async read(into) { reads++; await beforeRead(); const part = data.subarray(offset, offset + Math.min(chunk, into.length));
      into.set(part); offset += part.length; return { bytesRead: part.length, eof: !unresolved && (eofWithData ? offset === data.length : part.length === 0) }; },
    ...(seekable ? { async seek(n) { offset = n; } } : {}), async close() { closed++; } };
}
async function harness(t, options = {}) {
  const writes = [], calls = [], clock = new VirtualClock(), host = new ResourceBrokerHost(), destinations = new CaptureDestinationRegistry();
  const adapter = new DirectResourceRpcAdapter(host), broker = new ResourceBrokerRpcClient({ async request(request) {
    calls.push(request); await options.beforeCall?.(request);
    const response = await adapter.request(request); await options.afterCall?.(request, response); return response;
  }, close: () => adapter.close() });
  const module = await admitAuthoredModule(population(options), artifact, { ...(options.luaResourcePolicy ? { luaResourcePolicy: options.luaResourcePolicy } : {}) });
  const execution = await module.openExecution(), retired = new Map();
  const retire = execution.retire.bind(execution);
  execution.retire = async (...args) => { try { return await retire(...args); } finally { retired.get(args[0])?.resolve(); } };
  const server = new RetainedSessionRpcServer({
    execution, description: module.description, operations: ["run"], logicalDevice: module.description.id,
    platform: "node", clock, modeId: "main", profileId: "serial", channelId: "main", helpers: {}, resourceBroker: broker,
    captureDestinationAdapter: new DirectCaptureDestinationRpcAdapter(destinations, "test"),
    ...(options.maximumEffectWork ? { maximumEffectWork: options.maximumEffectWork } : {}),
    ...(options.maximumNativeHelperBytes ? { maximumNativeHelperBytes: options.maximumNativeHelperBytes } : {}),
    ...(options.luaResourcePolicy ? { luaResourcePolicy: options.luaResourcePolicy } : {}),
    async open() {
      const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
      const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => { const lease = await acquire(...args), write = lease.write.bind(lease);
        lease.write = async b => { writes.push([...b]); return write(b); }; return lease; }; return connection;
    },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); await host.endSession("test"); });
  await client.attach("source-test"); await client.connect({ mode: "main" });
  return { client, host, broker, writes, calls,
    register: s => host.registerSource(s, { kind: "session", sessionId: "test" }),
    async begin(id, extra = {}) { const handle = await client.startOperation({ operation: "run", arguments: { expected: { kind: "resource", id }, ...extra } });
      retired.set(handle.operationId, Promise.withResolvers()); return handle; },
    retired: id => retired.get(id).promise,
    async run(s, extra) { const id = await this.register(s), handle = await this.begin(id, extra); return client.awaitOperation(handle.operationId); },
    async capture() {
      const chunks = [];
      const id = await destinations.register({ async openPart() { return host.registerSink({ async write(b) { chunks.push(b.slice()); }, async close() {} }, { kind: "session", sessionId: "test" }); }, async commit() {}, async abort() {} }, "test");
      const captureId = await client.startCapture(id, { sidecarThresholdBytes: 65536 });
      return async () => ({ summary: await client.stopCapture(captureId), capture: await loadCapture((async function*() { yield* chunks; })()) });
    },
  };
}

for (const chunk of [1, 3, 256]) test(`complete source, short non-EOF reads and final empty EOF probe: ${chunk}`, { timeout: 4000 }, async t => {
  const h = await harness(t), s = source(raw, { chunk });
  const result = await h.run(s);
  assert.deepEqual(result.result, bytes(raw), JSON.stringify(result.error));
  assert.deepEqual(h.writes, [[...Buffer.from("SENTINEL")]]);
  assert.equal(result.sourcePreparation.complete, true);
  assert.equal(s.closed, 0, "delegation release is not session-owned source close");
  assert.equal(h.calls.filter(c => c.kind === "read").at(-1).maximumBytes, 1);
});
test("selected file is not read until invocation; growth after stat is caught by actual EOF probe", { timeout: 4000 }, async t => {
  const h = await harness(t), directory = await mkdtemp(join(tmpdir(), "b1-file-growth-")), path = join(directory, "guard.bin");
  await writeFile(path, raw, { flag: "wx" });
  const selected = await registerAuthoredFileArgument({ arguments: { expected: { kind: "byte-source", minimumBytes: 4, maximumBytes: 4 } } },
    "expected", path, s => h.register(s));
  t.after(() => selected.close());
  assert.equal(h.calls.filter(c => c.kind === "read").length, 0);
  await appendFile(path, Uint8Array.of(66));
  const stop = await h.capture(), op = await h.begin(selected.argument.id);
  await h.client.awaitOperation(op.operationId); await h.retired(op.operationId);
  assert.deepEqual(h.writes, [], "cached file size was mistaken for observed EOF");
  const { summary } = await stop(); assert.equal(summary.completeness, "complete");
  assert.deepEqual(h.calls.filter(c => c.kind === "read").map(c => c.maximumBytes), [4, 1]);
});
test("unterminated M prefix must never become a matching guarded-write input", { timeout: 4000 }, async t => {
  const h = await harness(t), stop = await h.capture();
  const input = source(Uint8Array.of(...raw, 66), { length: 4 });
  const result = await h.run(input);
  // This is the content oracle: the forbidden prefix equals the fresh guard
  // and would emit these exact sentinel bytes if truncation were admitted.
  assert.deepEqual(h.writes, [], "truncation admitted the matching prefix to the writer");
  assert.equal(result.result, null);
  const { summary } = await stop(); assert.equal(summary.completeness, "complete");
  assert.equal(input.reads, 2);
  assert.deepEqual(h.calls.filter(c => c.kind === "read").map(c => c.maximumBytes), [4, 1]);
});
for (const [name, s] of [
  ["undersize descriptor", () => source(raw, { length: 3 })], ["oversize descriptor", () => source(raw, { length: 5 })],
  ["unknown descriptor", () => ({ ...source(), byteLength: undefined })], ["unavailable origin", () => source(raw, { seekable: false })],
]) test(`${name} refuses before source contents`, { timeout: 4000 }, async t => {
  const h = await harness(t), input = s(), result = await h.run(input);
  assert.equal(result.outcome, "failed"); assert.equal(h.calls.filter(c => c.kind === "read").length, 0); assert.deepEqual(h.writes, []);
});
for (const [name, input] of [["early EOF", () => source(raw.slice(0, 3), { length: 4 })], ["unresolved EOF", () => source(raw, { unresolved: true })]])
  test(`${name} refuses rather than looping or dispatching`, { timeout: 4000 }, async t => {
    const h = await harness(t), r = await h.run(input()); assert.equal(r.outcome, "failed"); assert.deepEqual(h.writes, []);
  });
test("empty source still establishes EOF", { timeout: 4000 }, async t => {
  const h = await harness(t, { minimum: 0, maximum: 0, body: "return args.expected" });
  assert.deepEqual((await h.run(source(new Uint8Array()))).result, bytes([]));
  assert.equal(h.calls.filter(c => c.kind === "read").length, 1);
});
test("file affordance is not inline bytes; wrong-kind, foreign and stale IDs cannot read", { timeout: 4000 }, async t => {
  const h = await harness(t);
  await assert.rejects(h.client.startOperation({ operation: "run", arguments: { expected: { kind: "value", value: bytes(raw) } } }), /source resource required/);
  const other = new ResourceBrokerHost(), foreign = await other.registerSource(source(), { kind: "host" });
  const stale = await h.register(source()); await h.broker.close(stale);
  const sink = await h.host.registerSink({ async write() { assert.fail("destination must not be read"); }, async close() {} }, { kind: "session", sessionId: "test" });
  for (const id of [foreign, stale, sink]) { const op = await h.begin(id); assert.equal((await h.client.awaitOperation(op.operationId)).outcome, "failed"); }
  assert.equal(h.calls.filter(c => c.kind === "read").length, 0); assert.deepEqual(h.writes, []);
});
test("source policy and aggregate framed input are checked before reads", { timeout: 4000 }, async t => {
  await assert.rejects(admitAuthoredModule(population({ maximum: 65537 }), artifact), /65536/);
  await assert.rejects(admitAuthoredModule(population({ maximum: 4096 }), artifact, { luaResourcePolicy: { maximumEncodedInputBytes: 4096 } }), /input-limit/);
  const h = await harness(t, { extra: ',other={kind="string"}', luaResourcePolicy: { maximumEncodedInputBytes: 8192 } });
  const r = await h.run(source(), { other: { kind: "value", value: "x".repeat(8192) } });
  assert.equal(r.outcome, "failed"); assert.equal(h.calls.filter(c => c.kind === "read").length, 0);
});
test(copy.name, { timeout: 4000 }, async t => {
  for (const options of [{}, { maximumNativeHelperBytes: 200000 }, { maximumEffectWork: 11000 }]) {
    const data = new Uint8Array(options.maximumEffectWork ? 32768 : 1024);
    const h = await harness(t, { ...options, minimum: data.length, maximum: data.length,
      body: 'io.request({kind="write",value="SENTINEL"}); return args.expected' }), r = await h.run(source(data));
    if (!Object.keys(options).length) {
      assert.deepEqual(r.result, bytes(data));
      assert.deepEqual(h.writes, [[...Buffer.from("SENTINEL")]]);
      continue;
    }
    assert.equal(r.error?.code, options.maximumNativeHelperBytes ? "retained.helper-data-exhausted" : "retained.work-exhausted");
    assert.deepEqual(h.writes, []);
    assert.ok(h.calls.some(c => c.kind === "seek"), "must reach preparation, not fail at public start or source delegation");
    if (options.maximumEffectWork) {
      assert.ok(r.sourcePreparation.deliveredBytes>=256,'source preparation must reach its first delivered block');
      assert.ok(r.sourcePreparation.deliveredBytes<data.length,'refusal must precede complete materialization');
    }
    assert.equal(h.calls.at(-1).kind, "release-read", "refusal must still release its grant");
  }
  // Isolate the actual materializer from broker/VM overhead as well. Otherwise
  // removing copy debits can still fail later in an unrelated encoding pass.
  for(const budget of [100000,copy.grant]) {
    if (budget===copy.grant) copy.begin();
    const host=new ResourceBrokerHost(),broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
    const data=Uint8Array.from({length:32768},(_,i)=>i%256),s=source(data);
    const id=await host.registerSource(s,{kind:'host'});let work=0,serial=0,readBytes=0,complete=false,exact=false;
    const context={id:'copy-population',broker,live(){},iteration(){if(globalThis[Symbol.for('refusal-meter')]?.skip())return;if(++work>budget)throw new Error('copy work exhausted');},
      reserve:()=>({release(){}}),preflight:()=>100000,mark(){},
      call:(_kind,_fields,run)=>run('call-'+ ++serial),
      async read(_fields,_max,run){const r=await run('call-'+ ++serial);readBytes+=r.data.byteLength;return r;}};
    try {
      const run=()=>materializeSourceArguments({arguments:{expected:{kind:'byte-source',minimumBytes:data.length,maximumBytes:data.length}}},
        {expected:{kind:'resource',id}},{},context).then(prepared=>{complete=true;assert.deepEqual(prepared.values.expected,bytes(data));exact=true;prepared.release();});
      if(budget===100000)await run();
      else {
        let code;
        try { await run(); } catch (cause) {
          if (cause.message==='copy work exhausted') code='retained.work-exhausted';
          else throw cause;
        }
        copy.check({ code, readBytes, complete, exact });
      }
    } finally {await broker.close(id);}
  }
});
test("individually fitting source declarations cannot buy two input frames", { timeout: 4000 }, async () => {
  const luaResourcePolicy = { maximumEncodedInputBytes: 7000 };
  await admitAuthoredModule(population({ minimum: 4096, maximum: 4096 }), artifact, { luaResourcePolicy });
  await assert.rejects(admitAuthoredModule(population({ minimum: 4096, maximum: 4096,
    extra: ',second={kind="byte-source",minimumBytes=4096,maximumBytes=4096}' }), artifact, { luaResourcePolicy }),
  /declared source population cannot fit complete invocation policy/);
});
test("source copy and value encoding spend one cumulative account per octet", async () => {
  const data = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  const delivered = [];
  for (const budget of [2057, 1029]) {
    const host = new ResourceBrokerHost(), broker = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
    const id = await host.registerSource(source(data), { kind: "host" });
    let work = 0, serial = 0;
    const context = { id: "work-control", broker, live() {}, iteration() { if (++work > budget) throw new Error("work exhausted"); },
      reserve: () => ({ release() {} }), preflight: () => 2048, mark() {},
      call: (_kind, _fields, run) => run("call-" + ++serial), read: (_fields, _max, run) => run("call-" + ++serial) };
    try {
      const prepared = await materializeSourceArguments({ arguments: { expected: { kind: "byte-source", minimumBytes: 1024, maximumBytes: 1024 } } },
        { expected: { kind: "resource", id } }, {}, context);
      if (budget === 2057) assert.deepEqual(prepared.values.expected, bytes(data));
      else delivered.push(...Buffer.from(prepared.values.expected.value, "base64"));
      prepared.release();
    } catch (cause) { assert.equal(budget, 1029); assert.match(cause.message, /work exhausted/); }
    finally { await broker.close(id); }
  }
  assert.deepEqual(delivered, [], "underfunded preparation published source contents");
});
for (const kind of ["byte-source", "stream-source"]) test(`a cancelled native ${kind} read retains its slot and grant until terminal completion`, { timeout: 4000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const h = await harness(t, { kind, ...(kind === "stream-source" ? { body: 'local bytes=io.request({kind="source-read",source=args.expected,maximum=4});io.request({kind="write",value="SENTINEL"});return pdrv.bytes(bytes)' } : {}) }), input = source(raw, { beforeRead: async () => { entered.resolve(); await release.promise; } });
  const stop = await h.capture();
  const id = await h.register(input), op = await h.begin(id);
  await entered.promise; await h.client.cancelOperation(op.operationId);
  assert.equal(h.host.metrics.callsInFlight, 1);
  await assert.rejects(h.broker.grantRead(id, "peer", 5, { callId: "peer-call" }), /exclusively delegated/);
  release.resolve(); await h.retired(op.operationId);
  assert.equal(h.host.metrics.callsInFlight, 0); assert.deepEqual(h.writes, []);
  assert.equal((await h.broker.describe(id)).byteLength, 4);
  const {summary}=await stop();assert.equal(summary.completeness,"complete");
  assert.equal(input.reads,1);
});
test("source evidence reservation refuses before an unrecordable effect", async () => {
  const writer = await CaptureWriter.create({ captureId: "test", sink: { async write() {}, async close() {} }, clock: new VirtualClock(),
    logicalDevice: "test", host: { platform: "node" }, maximumBufferedBytes: 1000 });
  assert.throws(() => writer.reserveObservation(1001), /reservation-refused/);
  const held = writer.reserveObservation(900);
  assert.throws(() => writer.reserveObservation(101), /reservation-refused/);
  held.release(); writer.reserveObservation(900).release(); await writer.close();
});
test("stopping capture during a native source read retains the request and refuses completeness", { timeout: 4000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await harness(t), stop = await h.capture();
  const input = source(raw, { beforeRead: async () => { entered.resolve(); await release.promise; } });
  const id = await h.register(input), op = await h.begin(id);
  await entered.promise;
  const { summary } = await stop();
  assert.equal(summary.completeness, "incomplete");
  assert.equal(h.host.metrics.callsInFlight, 1);
  release.resolve(); await h.retired(op.operationId);
  assert.deepEqual(h.writes, []);
  assert.equal(h.host.metrics.callsInFlight, 0);
});
for (const boundary of ["source-rewind", "pending-read", "completed-read"]) test(`cancel at ${boundary} prevents the binding`, { timeout: 4000 }, async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers(), cleanup = Promise.withResolvers();
  let held = false;
  const h = await harness(t, {
    beforeCall: async r => { if (!held && ((boundary === "source-rewind" && r.kind === "seek") || (boundary === "pending-read" && r.kind === "read"))) { held = true; reached.resolve(); await release.promise; } },
    afterCall: async r => { if (r.kind === "release-read") cleanup.resolve();
      if (!held && boundary === "completed-read" && r.kind === "read") { held = true; reached.resolve(); await release.promise; } },
  });
  const id = await h.register(source()), op = await h.begin(id); await reached.promise;
  await h.client.cancelOperation(op.operationId); assert.equal((await h.client.awaitOperation(op.operationId)).outcome, "cancelled");
  release.resolve();
  // A broker barrier, not a sleep, proves that cleanup and its preceding read
  // have terminally settled before examining forbidden device contents.
  await cleanup.promise;
  await h.retired(op.operationId);
  assert.deepEqual(h.writes, []);
});
