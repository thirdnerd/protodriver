import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCapture } from "../../../packages/core/src/capture.ts";
import {
  assertCapturePartName,
  CapturePartNameError,
} from "../../../packages/core/src/capture-path.ts";
import {
  CaptureDestinationError,
  NodeCaptureDestination,
} from "../src/capture-destination.ts";
import {
  CaptureSidecarError,
  resolveCaptureSidecar,
} from "./support/capture-reader.ts";

const hostileNames = Object.freeze([
  Object.freeze({ name: "../escape.bin", rule: "character-set", shape: "traversal" }),
  Object.freeze({ name: "/absolute.bin", rule: "character-set", shape: "absolute path" }),
  Object.freeze({ name: "C:\\absolute.bin", rule: "character-set", shape: "Windows absolute path" }),
  Object.freeze({ name: "nested/part.bin", rule: "character-set", shape: "forward separator" }),
  Object.freeze({ name: "nested\\part.bin", rule: "character-set", shape: "backslash separator" }),
  Object.freeze({ name: "NUL.bin", rule: "reserved-device", shape: "device name" }),
  Object.freeze({ name: ".hidden.bin", rule: "leading-dot", shape: "leading dot" }),
  Object.freeze({ name: "payload.", rule: "trailing-dot", shape: "trailing dot" }),
]);

function rejectsName(name, rule) {
  assert.throws(
    () => assertCapturePartName(name),
    (error) => error instanceof CapturePartNameError && error.rule === rule,
  );
}

function sidecarCaptureArtifact(file) {
  const header = {
    kind: "header", formatVersion: 1, captureId: "hostile-sidecar",
    startedAtUnixMs: 0, timebase: "monotonic-us", clockResolutionUs: 1,
    logicalDevice: "fixture", host: { platform: "node" },
    completeness: "recording", causalFacts: "incomplete",
  };
  const record = {
    kind: "rx-delivered", seq: 1, tUs: 0, conn: 1, ch: "main",
    blob: { file, offset: 0, length: 1 },
  };
  return Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
}

test("part names contain between 1 and 255 ASCII octets", () => {
  rejectsName("", "length");
  rejectsName("a".repeat(256), "length");
  assert.doesNotThrow(() => assertCapturePartName("a".repeat(255)));
});

test("part names use only the portable ASCII filename alphabet", () => {
  for (const name of [
    "a/b", "a\\b", "a:b", "a%2fb", "a%5Cb", "%252e%252e", "a b", "payload ",
    "a\nb", "a\0b", "a⁄b",
  ]) {
    rejectsName(name, "character-set");
  }
  assert.doesNotThrow(() => assertCapturePartName("AZaz09._-"));
});

test("part names cannot begin with a dot", () => {
  for (const name of [".", "..", ".payload.bin"]) rejectsName(name, "leading-dot");
});

test("part names cannot end with a dot", () => {
  rejectsName("payload.", "trailing-dot");
});

test("Windows device basenames are reserved with or without an extension", () => {
  for (const name of [
    "CON", "prn.bin", "AUX", "NUL.bin", "COM1", "com9.log", "LPT1.bin", "lpt9",
  ]) {
    rejectsName(name, "reserved-device");
  }
  assert.doesNotThrow(() => assertCapturePartName("COM10.bin"));
});

test("openPart rejects every hostile path shape before a writer can create it", async () => {
  const base = await mkdtemp(join(tmpdir(), "protodriver-leaves-"));
  const sinks = [];
  const registrar = {
    async registerSource() { throw new Error("not used"); },
    async registerSink(sink) {
      sinks.push(sink);
      return `sink-${sinks.length}`;
    },
    async outstanding() { return []; },
  };
  try {
    const destination = await NodeCaptureDestination.create({
      directory: join(base, "capture"),
      registrar,
      sessionId: "leaf-test",
    });
    for (const { name, rule, shape } of hostileNames) {
      await assert.rejects(
        destination.openPart(name),
        (error) => error instanceof CapturePartNameError && error.rule === rule,
        `write admitted ${shape} ${JSON.stringify(name)}`,
      );
    }

    assert.doesNotThrow(() => assertCapturePartName("capture.0.bin"));
    await destination.openPart("capture.0.bin");
    await destination.commit();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("openPart rejects a symlink whose target is outside the capture directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "protodriver-containment-"));
  const directory = join(base, "capture");
  const outside = join(base, "outside.bin");
  const sinks = new Map();
  let nextId = 0;
  const registrar = {
    async registerSource() {
      throw new Error("source registration is not used here");
    },
    async registerSink(sink) {
      const id = `sink-${nextId += 1}`;
      sinks.set(id, sink);
      return id;
    },
    async outstanding() {
      return [...sinks.keys()];
    },
  };

  try {
    await writeFile(outside, "outside");
    const destination = await NodeCaptureDestination.create({
      directory,
      registrar,
      sessionId: "containment-test",
    });
    await symlink(outside, join(directory, "escape.bin"));
    const capturePath = join(directory, "session.pdcap");
    await writeFile(capturePath, sidecarCaptureArtifact("escape.bin"));
    const loaded = await loadCapture([await readFile(capturePath)]);
    const reference = loaded.records[0].blob;
    assert.notEqual(reference, undefined);

    await assert.rejects(
      destination.openPart("escape.bin"),
      (error) => error instanceof CaptureDestinationError && error.rule === "symlink",
    );
    await assert.rejects(
      resolveCaptureSidecar(capturePath, reference),
      (error) => error instanceof CaptureSidecarError && error.rule === "symlink",
    );
    assert.equal(sinks.size, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("capture artifacts reject every hostile sidecar path shape while loading", async () => {
  for (const { name, rule, shape } of hostileNames) {
    await assert.rejects(
      loadCapture([sidecarCaptureArtifact(name)]),
      (error) => error instanceof CapturePartNameError && error.rule === rule,
      `read admitted ${shape} ${JSON.stringify(name)}`,
    );
  }
});
