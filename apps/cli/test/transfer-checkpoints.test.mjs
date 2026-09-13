import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_HOST_RESOURCE_LIMITS } from "../../../packages/contracts/src/limits.ts";
import { RealClock } from "../../../packages/core/src/clock.ts";
import { executeResumedHostToDeviceTransfer } from "../../../packages/transfer-runtime/src/transfer-checkpoint.ts";
import { NodeTransferCheckpointStore } from "../src/transfer-checkpoints.ts";
import { withHangDetector } from "../../../test-support/fixtures/hang-detector.mjs";
import {
  checkpoint,
  CHECKPOINT_CHUNK_BYTES,
  CHECKPOINT_DIGEST,
  CHECKPOINT_HALF_OFFSET,
  definition,
  DigestProvider,
  MemorySource,
  WindowAdapter,
} from "./fixtures/checkpoint-conformance.mjs";

function waitForLine(stream, expected) {
  return withHangDetector((async () => {
    let text = "";
    for await (const chunk of stream) {
      text += chunk;
      if (text.includes(expected)) return;
    }
    throw new Error(`child ended before ${JSON.stringify(expected)}`);
  })(), `child output ${JSON.stringify(expected)}`);
}

function waitForFileEvent(path) {
  const name = basename(path);
  const watcher = watch(dirname(path));
  return {
    promise: new Promise((resolve, reject) => {
      watcher.on("change", (_event, changedName) => {
        if (changedName?.toString() === name) resolve();
      });
      watcher.on("error", reject);
    }).finally(() => watcher.close()),
    close: () => watcher.close(),
  };
}

function resumeOptions(store, claim, adapter) {
  return {
    store,
    claim,
    manifestHash: checkpoint().manifestHash,
    definitionHash: checkpoint().definitionHash,
    modeId: checkpoint().modeId,
    identity: checkpoint().identity,
    async observeReportedTargetOffset() { return CHECKPOINT_HALF_OFFSET; },
    definition: definition(),
    adapter,
    source: new MemorySource(),
    digestProvider: new DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  };
}

test("an in-progress live lock is held even while its owner record is incomplete", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-checkpoint-lock-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new NodeTransferCheckpointStore(directory);
  await store.create(checkpoint());
  const lockPath = join(directory, `${checkpoint().id}.lock`);
  const lockEvent = waitForFileEvent(lockPath);
  t.after(lockEvent.close);
  const child = spawn(process.execPath, [
    new URL("./fixtures/checkpoint-lock-race-child.mjs", import.meta.url).pathname,
    directory,
    checkpoint().id,
    String(64 * 1024 * 1024),
  ], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  await lockEvent.promise;
  const observed = await readFile(lockPath, "utf8");
  assert.throws(
    () => JSON.parse(observed),
    SyntaxError,
    "the control observes the actual create-before-content interval",
  );
  await assert.rejects(
    store.claim(checkpoint().id, "contender"),
    (error) => error.diagnostic?.code === "transfer.checkpoint-held",
  );

  await waitForLine(child.stdout, "claimed\n");
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.exitCode, 0);
});

test("the Node non-hardware replacement connection refuses a wrong finalizer-produced digest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new NodeTransferCheckpointStore(directory);
  await store.create({
    ...checkpoint(0, [{ targetOffset: 0, length: CHECKPOINT_HALF_OFFSET }]),
    phase: "transferring",
  });
  const claim = await store.claim(checkpoint().id, "replacement-with-wrong-digest");
  const adapter = new WindowAdapter("00".repeat(CHECKPOINT_DIGEST.length / 2));
  const resumed = await executeResumedHostToDeviceTransfer(resumeOptions(store, claim, adapter));
  assert.equal(resumed.outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(adapter.verificationActions, 1);
  assert.equal(adapter.completionActions, 1);
  assert.deepEqual(adapter.lifecycle, ["transfer", "completion", "verification"]);
  assert.notEqual(await store.read(checkpoint().id), null, "failed verification retains resumable evidence");
});

test("Node checkpoint replacement exposes the old or new record and ignores an orphan serialized temporary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new NodeTransferCheckpointStore(directory);
  await store.create(checkpoint());
  await assert.rejects(
    store.create(checkpoint()),
    (error) => error.diagnostic?.code === "transfer.checkpoint-conflict",
  );
  const claim = await store.claim(checkpoint().id, "writer");

  // This is the on-disk state a killed writer leaves after serialization and
  // fsync but before rename. Readers address only the committed leaf.
  await writeFile(
    join(directory, `${checkpoint().id}.orphan.tmp`),
    `${JSON.stringify(checkpoint(1, [{ targetOffset: 0, length: 512 }]))}\n`,
    { mode: 0o600 },
  );
  assert.equal((await store.read(checkpoint().id)).revision, 0);
  const committed = await store.commit(claim, checkpoint(1, [{ targetOffset: 0, length: 512 }]));
  assert.equal((await store.read(checkpoint().id)).revision, 1);
  await store.release(committed);
});
