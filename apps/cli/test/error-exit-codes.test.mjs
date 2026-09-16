import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdpkg } from "../../../packages/contracts/src/pdpkg.ts";
import { source as authoredSource } from "./fixtures/authored-front-door.mjs";

import {
  GENERATED_CLI_ERROR_CATEGORIES,
  generatedCliFailure,
  generatedCliExitCode,
} from "../src/errors.ts";

const EXPECTED_EXIT_CODES = Object.freeze({
  invocation: 5,
  definition: 2,
  operation: 3,
  host: 4,
  unexpected: 1,
  cancelled: 130,
});

function runCategory(category) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./fixtures/error-category-child.mjs", import.meta.url)),
    category,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({
      exitCode,
      signal,
      output: Buffer.concat(output).toString("utf8"),
      errors: Buffer.concat(errors).toString("utf8"),
    }));
  });
}

function runPdr(argv) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../src/pdr.ts", import.meta.url)),
    ...argv,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({
      exitCode,
      signal,
      output: Buffer.concat(output).toString("utf8"),
      errors: Buffer.concat(errors).toString("utf8"),
    }));
  });
}

test("top-level help succeeds without a device or operation", async () => {
  for (const argv of [["--help"], ["-h"], ["--worker", "--help"]]) {
    const result = await runPdr(argv);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.errors, "");
    assert.match(result.output, /Usage:/u);
    for (const command of ["run", "inspect", "pack"]) {
      assert.ok(result.output.includes(`pdr ${command} `), `help must describe ${command}`);
    }
  }
});

test("every CLI error category is observed as its distinct process exit code", async () => {
  assert.deepEqual([...GENERATED_CLI_ERROR_CATEGORIES], Object.keys(EXPECTED_EXIT_CODES));
  assert.equal(new Set(Object.values(EXPECTED_EXIT_CODES)).size, GENERATED_CLI_ERROR_CATEGORIES.length);

  for (const category of GENERATED_CLI_ERROR_CATEGORIES) {
    const expected = EXPECTED_EXIT_CODES[category];
    assert.equal(generatedCliExitCode(category), expected);
    const result = await runCategory(category);
    assert.equal(result.signal, null, `${category} command must exit normally`);
    assert.equal(result.exitCode, expected, `${category} command must use its category exit code`);
    assert.equal(result.errors, "");
    const failure = JSON.parse(result.output);
    assert.equal(failure.category, category);
    assert.equal(failure.exitCode, expected);
  }
});

test("the pdr catch boundary uses carried responsibility and never invents retryability", async () => {
  const unknown = await runPdr(["not-a-command"]);
  assert.equal(unknown.exitCode, EXPECTED_EXIT_CODES.invocation);
  assert.equal(unknown.signal, null);
  assert.equal(unknown.output, "");
  assert.deepEqual(JSON.parse(unknown.errors), {
    category: "invocation",
    error: {
      code: "cli.command.unknown",
      message: 'unknown command "not-a-command"; expected run, inspect, or pack',
      responsibility: "invocation",
      retryability: "no",
    },
  });

  const invalidPackage = await runPdr([
    "run",
    fileURLToPath(new URL("../../../README.md", import.meta.url)),
  ]);
  assert.equal(invalidPackage.exitCode, EXPECTED_EXIT_CODES.definition);
  assert.equal(invalidPackage.signal, null);
  assert.equal(invalidPackage.output, "");
  assert.deepEqual(JSON.parse(invalidPackage.errors), {
    category: "definition",
    error: {
      code: "pdpkg.archive.invalid",
      message: "ZIP end-of-central-directory record is missing",
      responsibility: "definition",
    },
  });
});

test("a typed failure without responsibility is loudly unexpected while preserving its data", () => {
  const failure = generatedCliFailure({ diagnostic: { code: "future.failure", message: "classification missing" } });
  assert.deepEqual(failure, {
    category: "unexpected",
    exitCode: 1,
    error: { code: "future.failure", message: "classification missing" },
  });
});

test("Error.code and a direct code/message shape do not claim typed status", () => {
  for (const cause of [
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    { code: "authored.api-version", message: "device/v2 required", responsibility: "definition" },
  ]) {
    assert.deepEqual(generatedCliFailure(cause), {
      category: "unexpected",
      exitCode: 1,
      error: { code: "cli.failed", message: cause instanceof Error ? "Error: missing" : "[object Object]" },
    });
  }
});

test("definition admission and invocation probes retain actionable codes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pdr-error-taxonomy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = async (name, source) => {
    const path = join(root, name);
    const built = await buildPdpkg([{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source) }]);
    await writeFile(path, built.archive);
    return path;
  };
  const api = await archive("api.pdpkg", authoredSource.replace('apiVersion="device/v2"', 'apiVersion="device/v3"'));
  const binding = await archive("binding.pdpkg", authoredSource.replace('binding="echo"', 'binding="no_such_binding"'));
  const good = await archive("good.pdpkg", authoredSource);
  for (const [argv, code, category, exitCode] of [
    [["inspect", api], "authored.api-version", "definition", 2],
    [["inspect", binding], "authored.binding.unresolved", "definition", 2],
    [["run", good, "no_such_operation"], "cli.operation.unknown", "invocation", 5],
  ]) {
    const result = await runPdr(argv);
    const reported = JSON.parse(result.errors);
    assert.equal(result.exitCode, exitCode);
    assert.equal(reported.category, category);
    assert.equal(reported.error.code, code);
    assert.equal(reported.error.responsibility, category);
  }
});
