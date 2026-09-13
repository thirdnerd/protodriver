import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DestinationCaptureRecorder,
  loadCapture,
} from "../../../packages/core/src/capture.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { NodeCaptureDestination } from "../src/capture-destination.ts";
import { resolveCaptureSidecar } from "./support/capture-reader.ts";

class LocalResources {
  resources = new Map();
  nextResource = 0;
  writes = 0;
  failWrite = undefined;

  async registerSource() {
    throw new Error("source registration is not used by capture tests");
  }

  async registerSink(sink) {
    const id = `resource-${this.nextResource += 1}`;
    this.resources.set(id, { sink, closed: false });
    return id;
  }

  async outstanding() {
    return [...this.resources.entries()]
      .filter(([, resource]) => !resource.closed)
      .map(([id]) => id);
  }

  async write(id, data) {
    this.writes += 1;
    if (this.writes === this.failWrite) throw new Error("injected storage full");
    const resource = this.#resource(id);
    await resource.sink.write(new Uint8Array(data));
  }

  async close(id) {
    const resource = this.#resource(id);
    if (resource.closed) return;
    resource.closed = true;
    await resource.sink.close();
  }

  async describe() { throw new Error("not used"); }
  async read() { throw new Error("not used"); }
  async seek() { throw new Error("not used"); }
  async cancel() {}

  #resource(id) {
    const resource = this.resources.get(id);
    if (resource === undefined) throw new Error(`unknown test resource ${id}`);
    return resource;
  }
}

const captureError = {
  code: "capture.aborted-for-test",
  message: "intentional abort",
  retryability: "no",
};

async function setupCapture(directory, resources = new LocalResources(), capture = undefined) {
  const destination = await NodeCaptureDestination.create({
    directory,
    registrar: resources,
    sessionId: "capture-test-session",
  });
  const recorder = await DestinationCaptureRecorder.create({
    destination,
    broker: resources,
    clock: new VirtualClock(1_700_000_000_000),
    captureId: "capture-test",
    logicalDevice: "device-3",
    host: { platform: "node" },
    maximumBufferedBytes: 8 * 1024 * 1024,
    ...(capture === undefined ? {} : { capture }),
  });
  return { recorder, resources };
}

test("two device-3-sized payloads become independent sidecars", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-sidecars-"));
  try {
    const { recorder } = await setupCapture(directory);
    const source = new Uint8Array(2_097_088).fill(0x5a);
    const target = new Uint8Array(2_097_152).fill(0xa5);

    recorder.recordBytes({ kind: "tx-requested", conn: 1, ch: "main" }, source);
    recorder.recordBytes({ kind: "rx-delivered", conn: 1, ch: "main" }, target);
    const summary = await recorder.close();

    assert.equal(summary.completeness, "complete");
    assert.equal(summary.partCount, 3);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["payload.0.bin", "payload.1.bin", "session.pdcap"],
    );

    const capturePath = join(directory, "session.pdcap");
    const loaded = await loadCapture(createReadStream(capturePath));
    const references = loaded.records
      .filter((record) => record.kind === "tx-requested" || record.kind === "rx-delivered")
      .map((record) => record.blob);
    assert.equal(references.length, 2);

    for (const [index, expected] of [source, target].entries()) {
      const reference = references[index];
      assert.notEqual(reference, undefined);
      const resolved = await resolveCaptureSidecar(capturePath, reference);
      assert.deepEqual(resolved, expected);
      assert.equal(resolved.byteLength, expected.byteLength);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a recoverable storage write failure leaves an explicit incomplete footer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-storage-failure-"));
  const resources = new LocalResources();
  resources.failWrite = 2; // header succeeds; the first event fails; footer can report it
  try {
    const { recorder } = await setupCapture(directory, resources);
    recorder.recordBytes(
      { kind: "rx-delivered", conn: 1, ch: "main" },
      Uint8Array.of(1, 2, 3, 4),
    );
    const summary = await recorder.close();
    const loaded = await loadCapture(createReadStream(join(directory, "session.pdcap")));

    assert.equal(summary.completeness, "incomplete");
    assert.equal(summary.storageError?.code, "capture.storage-failed");
    assert.equal(loaded.completeness, "incomplete");
    assert.equal(loaded.footer?.completeness, "incomplete");
    assert.equal(loaded.footer?.storageError?.code, "capture.storage-failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborting preserves a footerless record stream which loads incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-abort-"));
  try {
    const { recorder } = await setupCapture(directory);
    recorder.recordBytes(
      { kind: "rx-delivered", conn: 1, ch: "main" },
      Uint8Array.of(5, 6, 7, 8),
    );
    const summary = await recorder.abort(captureError);
    const loaded = await loadCapture(createReadStream(join(directory, "session.pdcap")));

    assert.equal(summary.completeness, "incomplete");
    assert.equal(loaded.completeness, "incomplete");
    assert.equal(loaded.footer, undefined);
    assert.equal(loaded.records.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
