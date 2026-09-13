import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  GENERATED_CLI_ERROR_CATEGORIES,
  generatedCliExitCode,
} from "../src/errors.ts";

const EXPECTED_EXIT_CODES = Object.freeze({
  unexpected: 1,
  definition: 2,
  operation: 3,
  host: 4,
  uncategorized: 5,
  cancelled: 130,
});

function runCategory(category) {
  const child = spawn(process.execPath, [
    new URL("./fixtures/error-category-child.mjs", import.meta.url).pathname,
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
    new URL("../src/pdr.ts", import.meta.url).pathname,
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

test("the pdr catch boundary uses the category map and never invents retryability", async () => {
  const unknown = await runPdr(["not-a-command"]);
  assert.equal(unknown.exitCode, EXPECTED_EXIT_CODES.unexpected);
  assert.equal(unknown.signal, null);
  assert.equal(unknown.output, "");
  assert.deepEqual(JSON.parse(unknown.errors), {
    category: "unexpected",
    error: {
      code: "cli.failed",
      message: 'Error: unknown command "not-a-command"; expected run, inspect, or pack',
    },
  });

  const invalidPackage = await runPdr([
    "run",
    new URL("../../../README.md", import.meta.url).pathname,
  ]);
  assert.equal(invalidPackage.exitCode, EXPECTED_EXIT_CODES.definition);
  assert.equal(invalidPackage.signal, null);
  assert.equal(invalidPackage.output, "");
  assert.deepEqual(JSON.parse(invalidPackage.errors), {
    category: "definition",
    error: {
      code: "pdpkg.archive.invalid",
      message: "ZIP end-of-central-directory record is missing",
    },
  });
});
