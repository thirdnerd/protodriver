import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";
import { MockTransport } from "../../packages/transport-mock/src/index.ts";
import { createNodeAuthoredAcquisition } from "../../apps/cli/src/authored-acquisition.ts";
import { runPdr } from "../../apps/cli/src/pdr.ts";
import { DemoThermostatSimulator } from "./simulator.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = join(root, "examples/demo-thermostat");
const stepOne = join(source, "step-1");
const stepTwo = join(source, "step-2");
const stepThree = join(source, "step-3");

function sink(chunks) {
  return new Writable({write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); }});
}

async function cli(argv, scratch) {
  const { stdout, stderr } = await execute(process.execPath, ["apps/cli/src/pdr.ts", ...argv],
    {cwd: root, encoding: "utf8"});
  if (stderr) throw Error(`unexpected CLI stderr: ${stderr}`);
  return stdout.replaceAll(`${scratch}${sep}`, "").trimEnd();
}

async function runWithSimulator(packagePath, operation, simulator, flags = []) {
  const output = [], error = [], writes = [];
  const acquisition = createNodeAuthoredAcquisition(async (profile, modeId, clock) => {
    if (profile.id !== "serial" || modeId !== "thermostat") throw Error("unexpected demo profile");
    const connection = new MockTransport(clock).openConnection({
      identity: {transport: "mock", stableKeyAssurance: "none"}, modeId, profileId: profile.id,
    });
    const channel = connection.channel("main");
    const acquire = channel.acquire.bind(channel);
    channel.acquire = async (...args) => {
      const lease = await acquire(...args);
      const write = lease.write.bind(lease);
      lease.write = async (bytes, options) => {
        const copy = Uint8Array.from(bytes);
        const receipt = await write(bytes, options);
        writes.push(new TextDecoder().decode(copy));
        for (const part of simulator.answer(copy)) channel.enqueueReceived(part);
        return receipt;
      };
      return lease;
    };
    return [{candidate: {candidateId: "fictional-thermostat", identity: connection.identity,
      displayName: "DemoBench simulator", matchedProfileId: profile.id}, open: async () => connection}];
  });
  let thrown;
  try {
    await runPdr(["run", packagePath, operation, ...flags, "--json"],
      {input: [], output: sink(output), error: sink(error)}, {authoredAcquisition: acquisition});
  } catch (cause) {
    const envelope = typeof cause === "object" && cause !== null && "error" in cause
      && typeof cause.error === "object" && cause.error !== null
      && typeof cause.error.code === "string"
      ? cause.error : undefined;
    thrown = {
      message: String(cause?.message ?? cause),
      ...(envelope === undefined ? {} : { error: envelope }),
    };
  }
  if (error.length) throw Error(`unexpected CLI stderr: ${Buffer.concat(error)}`);
  const stdout = Buffer.concat(output).toString("utf8").trimEnd();
  return {outcome: stdout ? JSON.parse(stdout) : undefined, thrown, writes};
}

function observed(command, result) {
  const lines = [`runPdr ${command}`];
  if (result.outcome?.outcome === "completed") lines.push(`result: ${JSON.stringify(result.outcome.result)}`);
  else if (result.outcome?.error) lines.push(`failure: ${result.outcome.error.details?.name ?? result.outcome.error.code}`);
  else if (result.thrown) lines.push(`failure: ${result.thrown.error?.details?.name
    ?? result.thrown.error?.code
    ?? result.thrown.message.replace(/^Authored operation failed: /, "")}`);
  else throw Error(`no result or failure for ${command}`);
  lines.push(`wrote: ${result.writes.map((value) => JSON.stringify(value)).join(", ")}`);
  return lines.join("\n");
}

/** The transcript executes the public pack/help/inspect commands and the
 * injected-host run calls. Only the runner supplies a fictional device. */
export async function runDemoThermostatWalkthrough() {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-demo-thermostat-"));
  const declarationPackage = join(scratch, "declaration.pdpkg");
  const entryPackage = join(scratch, "entry.pdpkg");
  const statusPackage = join(scratch, "status.pdpkg");
  const packagePath = join(scratch, "thermostat.pdpkg");
  try {
    const sections = [];
    const command = async (label, argv) => {
      sections.push(`$ ${label}\n${await cli(argv, scratch)}`);
    };
    await command("node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-1 declaration.pdpkg",
      ["pack", stepOne, declarationPackage]);
    await command("node apps/cli/src/pdr.ts run declaration.pdpkg --help", ["run", declarationPackage, "--help"]);
    await command("node apps/cli/src/pdr.ts inspect declaration.pdpkg", ["inspect", declarationPackage]);
    await command("node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-2 entry.pdpkg",
      ["pack", stepTwo, entryPackage]);
    const entryGood = await runWithSimulator(entryPackage, "read_status", new DemoThermostatSimulator());
    const entryBad = await runWithSimulator(entryPackage, "read_status", new DemoThermostatSimulator("wrong-identity"));
    assert.deepEqual(entryGood.writes, ["ID?\r"]);
    assert.equal(entryGood.outcome?.error?.details?.name, "demo-thermostat.not-implemented");
    assert.equal(entryBad.thrown?.message, "Authored operation failed: demo-thermostat.identity-mismatch");
    sections.push(observed("read_status [step-2: identified, operation unfinished]", entryGood));
    sections.push(observed("read_status [step-2: wrong identity]", entryBad));
    await command("node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-3 status.pdpkg",
      ["pack", stepThree, statusPackage]);
    const stageStatus = await runWithSimulator(statusPackage, "read_status", new DemoThermostatSimulator("fragmented"));
    assert.deepEqual(stageStatus.outcome?.result, {heater:"on", sequence:1,
      target_centi_c:2200, temperature_centi_c:2150});
    sections.push(observed("read_status [step-3: fragmented]", stageStatus));
    await command("node apps/cli/src/pdr.ts pack examples/demo-thermostat thermostat.pdpkg",
      ["pack", source, packagePath]);
    await command("node apps/cli/src/pdr.ts run thermostat.pdpkg set_target --help",
      ["run", packagePath, "set_target", "--help"]);

    const normal = new DemoThermostatSimulator();
    for (const [label, operation, simulator, flags] of [
      ["read_status [normal]", "read_status", normal, []],
      ["set_target --target_centi_c 2300 [normal]", "set_target", normal, ["--target_centi_c", "2300"]],
      ["read_status [normal]", "read_status", normal, []],
      ["read_status [fragmented]", "read_status", new DemoThermostatSimulator("fragmented"), []],
      ["read_status [wrong-identity]", "read_status", new DemoThermostatSimulator("wrong-identity"), []],
      ["read_status [malformed]", "read_status", new DemoThermostatSimulator("malformed"), []],
      ["read_status [overlong]", "read_status", new DemoThermostatSimulator("overlong"), []],
      ["read_status [silent]", "read_status", new DemoThermostatSimulator("silent"), []],
      ["set_target --target_centi_c 2300 [unexpected-range-refusal]", "set_target",
        new DemoThermostatSimulator("unexpected-range-refusal"), ["--target_centi_c", "2300"]],
      ["set_target --target_centi_c 4000 [argument bound]", "set_target",
        new DemoThermostatSimulator(), ["--target_centi_c", "4000"]],
    ]) {
      const result = await runWithSimulator(packagePath, operation, simulator, flags);
      sections.push(observed(label, result));
    }
    const raw = new DemoThermostatSimulator();
    sections.push(`$ simulator raw SET 4000\\r\n${new TextDecoder().decode(raw.answer(new TextEncoder().encode("SET 4000\r"))[0])}`.trimEnd());
    sections.push(`$ simulator raw WHAT?\\r\n${raw.answer(new TextEncoder().encode("WHAT?\r")).length === 0 ? "(no reply)" : "unexpected reply"}`);
    return `${sections.join("\n\n")}\n`;
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

if (await isMainModule(import.meta.url)) process.stdout.write(await runDemoThermostatWalkthrough());
