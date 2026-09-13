import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAuthoredSession } from "../../packages/core/src/authored-module.ts";
import { VirtualClock } from "../clock.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../../packages/core/src/rpc.ts";
import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";
import { instrumentVm } from "../handler-topology/fixture.mjs";
import { nativeOptions } from "./fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stateIds = ["sample_rate_ms", "sample_rate_is_slowest"];
const pair = (cells) => Object.fromEntries(stateIds.map((id) => [id, cells[id]]));

async function bounded(promise, name) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`derived preflight did not settle: ${name}`)), 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDerived(output) {
  if (!output) throw new Error("usage: derived-preflight.mjs NEW_DIRECTORY");
  await mkdir(output);
  output = resolve(output);
  const lua = await readFile(new URL("./derived-preflight.lua", import.meta.url), "utf8");
  const wasm = new Uint8Array(await readFile(new URL(
    "../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
    import.meta.url,
  )));
  const population = [{
    logicalName: "pdpkg.json",
    sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}'),
  }, { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(lua) }];
  const report = {
    scope: "current device/v2 inherited-validity acceptance; synthetic passive input; no predecessor",
    source: { lines: lua.split("\n").length - 1, bytes: Buffer.byteLength(lua), sha256: hash(lua) },
    arms: [],
  };
  try {
    for (const gapMs of [1, 0]) {
      const arm = { name: "inherited-validity", gapMs };
      report.arms.push(arm);
      const suspended = Promise.withResolvers();
      const effects = [];
      const restore = instrumentVm((event) => {
        effects.push(event);
        if (event.kind === "vm-effect" && event.effect === "read") suspended.resolve();
      });
      const options = nativeOptions("interactive", "serial", []);
      const open = options.open;
      let client;
      let channel;
      try {
        const { server } = await createAuthoredSession(population, wasm, {
          ...options,
          async open() {
            const connection = await open();
            channel = connection.channel("main");
            return connection;
          },
          platform: "node",
          resourceBroker: {},
          captureDestinationAdapter: {},
        });
        client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
        await bounded(client.attach("derived-preflight"), "attach");
        await bounded(client.connect({ mode: "interactive" }), "connect");

        async function run(operation, args = {}, outcome = "completed") {
          const handle = await client.startOperation({
            operation,
            arguments: Object.fromEntries(Object.entries(args).map(([key, value]) => (
              [key, { kind: "value", value }]
            ))),
          });
          const result = await bounded(client.awaitOperation(handle.operationId), operation);
          assert.equal(result.outcome, outcome, JSON.stringify(result));
          await client.acknowledgeOperation(handle.operationId);
          return result;
        }

        const observing = run("observe", { line: "5000\r\n", suspend: gapMs > 0 });
        if (gapMs > 0) {
          await bounded(suspended.promise, "read suspension");
          arm.suspended = pair((await client.getSnapshot()).stateCells);
          assert.equal(arm.suspended.sample_rate_ms.quality, "valid");
          assert.equal(arm.suspended.sample_rate_is_slowest.quality, "unknown");
          await options.clock.advance(1_000);
          channel.enqueueReceived(new TextEncoder().encode("!"));
        }
        await observing;
        arm.current = pair((await client.getSnapshot()).stateCells);
        assert.equal(arm.current.sample_rate_is_slowest.value, true);
        assert.equal(arm.current.sample_rate_is_slowest.quality, "valid");

        await options.clock.advance(5_499_000 - options.clock.monotonicUs());
        await run("barrier");
        assert.equal((await client.getSnapshot()).stateCells.sample_rate_is_slowest.quality, "valid");
        await options.clock.advance(5_500_000 - options.clock.monotonicUs());
        await run("barrier");
        arm.at5500ms = pair((await client.getSnapshot()).stateCells);
        assert.equal(arm.at5500ms.sample_rate_ms.quality, "stale");
        assert.equal(arm.at5500ms.sample_rate_is_slowest.quality, "stale");
        assert.equal(
          arm.current.sample_rate_is_slowest.updatedAtMonotonicUs
            - arm.current.sample_rate_ms.updatedAtMonotonicUs,
          gapMs * 1_000,
        );
        assert.deepEqual(arm.at5500ms.sample_rate_is_slowest, {
          ...arm.current.sample_rate_is_slowest,
          quality: "stale",
        });

        arm.staleAttempt = await run("mark", { quality: "stale" }, "failed");
        assert.equal(arm.staleAttempt.error.code, "retained.invalid-effect");
        arm.unknownAttempt = await run("mark", { quality: "unknown" }, "failed");
        assert.equal(arm.unknownAttempt.error.code, "retained.invalid-effect");
        await run("observe", { line: "100\r\n", suspend: false });
        arm.fresh100 = pair((await client.getSnapshot()).stateCells);
        assert.equal(arm.fresh100.sample_rate_is_slowest.value, false);
        assert.equal(arm.fresh100.sample_rate_is_slowest.quality, "valid");
        assert.ok(effects.some((event) => event.kind === "vm-dispatch"));
        assert.ok(effects.some((event) => event.kind === "vm-effect" && event.effect === "state-publish"));
        arm.effects = effects;
        await bounded(client.disconnect(), "disconnect");
        arm.closed = pair((await client.getSnapshot()).stateCells);
        for (const cell of Object.values(arm.closed)) {
          assert.equal(cell.quality, "unknown");
          assert.equal("value" in cell, false);
        }
      } finally {
        if (client) {
          await bounded(client.disconnect(), "cleanup disconnect");
          await bounded(client.close(), "cleanup close");
        }
        restore();
      }
    }
    report.finding = "current v2 inherited validity passes at zero/1 ms publication gaps";
  } catch (cause) {
    report.failure = String(cause);
    throw cause;
  } finally {
    const resultPath = join(output, "RESULT.json");
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({
      output,
      finding: report.finding,
      failure: report.failure,
      sha256: hash(await readFile(resultPath)),
    }));
  }
  return report;
}

if (await isMainModule(import.meta.url)) await runDerived(process.argv[2]);
