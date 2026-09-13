import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { packCorpusDirectory } from "../../../tools/pack-corpus.mjs";

const cliRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(cliRoot, "../..");
const observationPrefix = "PDR_AMBIENT_OBSERVATION ";

test("CLI package loading has only its named and pinned authority", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(resolve(cliRoot, ".ambient-authority."));
  try {
    const packages = await packCorpusDirectory(resolve(repositoryRoot, "corpus"), scratch);
    assert.equal(packages.length, 6);
    const packagePaths = packages.map(({ outputPath }) => outputPath);
    const child = await runInstrumented(packagePaths);
    assert.equal(child.code, 0, child.stderr);

    const report = JSON.parse(child.stdout);
    assert.deepEqual(report.loaded, packagePaths);
    assert.ok(report.transport.instrumentVisible > 0, "recording transport did not retain its control connection");
    assert.ok(report.transport.control > 0, "transport-open control was invisible");
    assert.equal(report.transport.duringLoad, 0, "package loading requested a transport open");

    const observations = child.stderr.split(/\r?\n/u)
      .filter((line) => line.startsWith(observationPrefix))
      .map((line) => JSON.parse(line.slice(observationPrefix.length)));
    const controls = observations.filter(({ phase }) => phase === "control");
    for (const kind of ["filesystem", "network", "subprocess", "dynamic-import"]) {
      assert.ok(controls.some((record) => record.kind === kind), `${kind} control was invisible`);
    }

    const duringLoad = observations.filter(({ phase }) => phase.startsWith("load:"));
    for (const kind of ["network", "subprocess", "dynamic-import"]) {
      assert.deepEqual(
        duringLoad.filter((record) => record.kind === kind),
        [],
        `${kind} activity occurred while loading: ${JSON.stringify(duringLoad.filter((record) => record.kind === kind))}`,
      );
    }

    const runtimeArtifact = pathToFileURL(resolve(
      repositoryRoot,
      "packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
    )).href;
    const unexpectedFilesystem = duringLoad.filter(({ kind, phase, target }) => {
      if (kind !== "filesystem") return false;
      const namedPackage = phase.slice("load:".length);
      return target !== namedPackage && target !== runtimeArtifact;
    });
    assert.deepEqual(
      unexpectedFilesystem,
      [],
      `package loading touched paths outside its permitted set: ${JSON.stringify(unexpectedFilesystem)}`,
    );
    for (const packagePath of packagePaths) {
      const records = duringLoad.filter(({ phase }) => phase === `load:${packagePath}`);
      assert.ok(records.some(({ kind, target }) => kind === "filesystem" && target === packagePath));
      assert.ok(records.some(({ kind, target }) => kind === "filesystem" && target === runtimeArtifact));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

async function runInstrumented(packagePaths) {
  const preload = resolve(import.meta.dirname, "fixtures/ambient-authority-preload.mjs");
  const runner = resolve(import.meta.dirname, "fixtures/ambient-authority-runner.mjs");
  const child = spawn(process.execPath, ["--import", preload, runner, ...packagePaths], {
    cwd: cliRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  return { code, stdout, stderr };
}
