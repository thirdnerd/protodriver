import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { CaptureWriter, loadCapture } from "../src/capture.ts";
import { VirtualClock } from "../../../test-support/clock.ts";

class MemorySink {
  chunks = [];
  closed = false;

  async write(data) {
    this.chunks.push(Uint8Array.from(data));
  }

  async close() {
    this.closed = true;
  }

  async *source() {
    for (const chunk of this.chunks) yield chunk;
  }
}

class GatedSink extends MemorySink {
  writes = 0;
  #release;
  #gate = new Promise((resolve) => {
    this.#release = resolve;
  });

  async write(data) {
    this.writes += 1;
    if (this.writes > 1) await this.#gate;
    await super.write(data);
  }

  release() {
    this.#release();
  }
}

function writerOptions(sink, clock, maximumBufferedBytes = 1_024) {
  return {
    sink,
    clock,
    captureId: "capture-test",
    logicalDevice: "test.device",
    host: { platform: "node" },
    maximumBufferedBytes,
  };
}

test("a closed capture loads as complete", async () => {
  const sink = new MemorySink();
  const clock = new VirtualClock(1_700_000_000_000);
  const writer = await CaptureWriter.create(writerOptions(sink, clock));

  writer.record({
    kind: "rx-delivered",
    conn: 1,
    ch: "main",
    data: "V0DnEUAEQP4=",
  });
  const summary = await writer.close();
  const loaded = await loadCapture(sink.source());

  assert.equal(summary.completeness, "complete");
  assert.equal(summary.gapCount, 0);
  assert.equal(sink.closed, true);
  assert.equal(loaded.completeness, "complete");
  assert.equal(loaded.replayability, "byte-exact-replayable");
  assert.equal(loaded.footer?.rxBytes, 8);
  assert.equal(loaded.records.length, 1);
});

test("positioned attribution preserves one receive delivery and rejects overlapping ownership", async () => {
  const sink = new MemorySink();
  const clock = new VirtualClock(1_700_000_000_000);
  const writer = await CaptureWriter.create(writerOptions(sink, clock));

  writer.record({
    kind: "rx-delivered",
    conn: 1,
    ch: "main",
    data: Buffer.from("aabbccddee", "hex").toString("base64"),
  });
  writer.record({
    kind: "byte-attribution",
    ref: 1,
    offsetBytes: 0,
    lengthBytes: 2,
    commandInvocation: "command-1",
  });
  writer.record({
    kind: "byte-attribution",
    ref: 1,
    offsetBytes: 3,
    lengthBytes: 2,
    commandInvocation: "command-2",
  });
  await writer.close();

  const loaded = await loadCapture(sink.source());
  assert.equal(loaded.records.filter(({ kind }) => kind === "rx-delivered").length, 1);
  assert.deepEqual(loaded.records.filter(({ kind }) => kind === "byte-attribution"), [
    {
      kind: "byte-attribution", seq: 2, tUs: 0, ref: 1,
      offsetBytes: 0, lengthBytes: 2, commandInvocation: "command-1",
    },
    {
      kind: "byte-attribution", seq: 3, tUs: 0, ref: 1,
      offsetBytes: 3, lengthBytes: 2, commandInvocation: "command-2",
    },
  ]);

  const lines = sink.chunks.map((chunk) => Buffer.from(chunk).toString("utf8")).join("")
    .trimEnd().split("\n").map((line) => JSON.parse(line));
  lines[3].offsetBytes = 1;
  await assert.rejects(
    loadCapture([Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)]),
    /overlaps attribution for delivery 1/,
  );
});

test("a storage overrun is positioned and closes incomplete", async () => {
  const sink = new GatedSink();
  const clock = new VirtualClock(1_700_000_000_000);
  const writer = await CaptureWriter.create(writerOptions(sink, clock, 250));
  const payload = Buffer.alloc(64, 0xa5).toString("base64");

  writer.record({ kind: "rx-delivered", conn: 1, ch: "main", data: payload });
  writer.record({ kind: "rx-delivered", conn: 1, ch: "main", data: payload });
  writer.record({ kind: "rx-delivered", conn: 1, ch: "main", data: payload });
  sink.release();

  const summary = await writer.close();
  const loaded = await loadCapture(sink.source());
  const gap = loaded.records.find(({ kind }) => kind === "gap");

  assert.equal(summary.completeness, "incomplete");
  assert.equal(summary.gapCount, 1);
  assert.equal(loaded.completeness, "incomplete");
  assert.equal(loaded.replayability, "diagnostic-only");
  assert.deepEqual(gap, {
    kind: "gap",
    seq: 2,
    tUs: 0,
    reason: "recorder-overrun",
    droppedBytes: 128,
    droppedRecords: 2,
  });
  assert.equal(loaded.footer?.completeness, "incomplete");
});

test("recording loss revokes an owner before close and preserves reentrant loss position", async () => {
  const sink = new GatedSink(), clock = new VirtualClock(0);
  let permitted = true, writer;
  writer = await CaptureWriter.create({ ...writerOptions(sink, clock, 250), onRecordingLoss() {
    permitted = false;
    // Real owners can emit a terminal fact while revoking. It must not steal
    // the earlier dropped receive's sequence or recurse into this observer.
    writer.record({ kind: "event", name: "cancelled" });
  } });
  const data = Buffer.alloc(64).toString("base64");
  writer.record({ kind: "rx-delivered", conn: 1, ch: "main", data });
  writer.record({ kind: "rx-delivered", conn: 1, ch: "main", data });
  assert.equal(permitted, false, "required-recording owner must already be revoked");
  sink.release();
  assert.equal((await writer.close()).completeness, "incomplete");
  const gap = (await loadCapture(sink.source())).records.find(record => record.kind === "gap");
  assert.equal(gap.seq, 2);
  assert.equal(gap.droppedRecords, 2);
});

for (const kind of ["stream", "sidecar"]) test(`${kind} failure is observable before recorder close`, { timeout: 2000 }, async () => {
  const sink = new MemorySink(), clock = new VirtualClock(0);
  let fail;
  const failing = new Promise((_resolve, reject) => { fail = reject; });
  let observe;
  const lost = new Promise(resolve => { observe = resolve; });
  const writer = await CaptureWriter.create({ ...writerOptions(sink, clock),
    sidecarThresholdBytes: 1, writeSidecar: () => failing, onRecordingLoss: observe });
  if (kind === "stream") {
    sink.write = () => failing;
    writer.record({ kind: "event", name: "pending" });
  } else writer.recordBytes({ kind: "rx-delivered", conn: 1, ch: "main" }, Uint8Array.of(1, 2));
  fail(new Error("controlled storage failure"));
  assert.match((await lost).message, /controlled storage failure/);
  assert.equal((await writer.close()).completeness, "incomplete");
});

test("a throwing recording-loss observer cannot escape as success or an unhandled rejection", async () => {
  const sink = new GatedSink(), clock = new VirtualClock(0);
  const writer = await CaptureWriter.create({ ...writerOptions(sink, clock, 1),
    onRecordingLoss() { throw new Error("broken policy observer"); } });
  assert.doesNotThrow(() => writer.record({ kind: "event", name: "oversized" }));
  sink.release();
  const summary = await writer.close();
  assert.equal(summary.completeness, "incomplete");
  assert.equal(summary.storageError.code, "capture.loss-observer-failed");
});

test("a process killed after writing records leaves a loadable incomplete capture", {
  timeout: 5_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-capture-"));
  const capturePath = join(directory, "killed.pdcap");
  const childPath = fileURLToPath(
    new URL("./fixtures/capture-killed-child.mjs", import.meta.url),
  );

  try {
    const child = spawn(process.execPath, [childPath, capturePath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    await new Promise((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY\n")) resolve();
      });
    });

    child.kill("SIGKILL");
    const exit = await new Promise((resolve) => child.once("exit", (code, signal) => {
      resolve({ code, signal });
    }));
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" });

    const loaded = await loadCapture(createReadStream(capturePath));
    assert.equal(loaded.footer, undefined);
    assert.equal(loaded.completeness, "incomplete");
    assert.equal(loaded.records.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
