import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runDemoThermostatWalkthrough } from "../../test-support/demo-thermostat/run.mjs";
import { DemoThermostatSimulator } from "../../test-support/demo-thermostat/simulator.mjs";

const example = new URL("../../examples/demo-thermostat/", import.meta.url);

test("the six-step thermostat walkthrough executes and its shown output stays true", async () => {
  const actual = await runDemoThermostatWalkthrough();
  const expected = await readFile(new URL("transcript.txt", example), "utf8");
  const readme = await readFile(new URL("README.md", example), "utf8");
  assert.equal(actual, expected);
  for (const [, block] of readme.matchAll(/```text\n([\s\S]*?)\n```/gu)) {
    assert.ok(actual.includes(block), `README output block is absent from the executed transcript:\n${block}`);
  }
  for (const [, command] of readme.matchAll(/^(node apps\/cli\/src\/pdr\.ts (?!.*demo-work).*?)$/gmu)) {
    assert.ok(actual.includes(`$ ${command}\n`), `README command was not executed: ${command}`);
  }
  for (const name of ["step-1", "step-2", "step-3"]) {
    assert.match(actual, new RegExp(`examples/demo-thermostat/${name} .*\\.pdpkg`, "u"));
  }
  assert.match(actual, /failure: demo-thermostat\.identity-mismatch/u);
  assert.match(actual, /failure: demo-thermostat\.malformed-status/u);
  assert.match(actual, /failure: demo-thermostat\.line-too-long/u);
  assert.match(actual, /failure: demo-thermostat\.response-timeout/u);
  assert.match(actual, /failure: demo-thermostat\.range-refused/u);
  assert.match(actual, /wrote: "ID\?\\r", "SET 2300\\r"/u);
});

test("the host simulator implements the written raw refusals without importing a module", async () => {
  const simulatorSource = await readFile(new URL("../../test-support/demo-thermostat/simulator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(simulatorSource, /(?:from|import\()\s*["'][^"']*(?:corpus|device\.lua|demo-thermostat\/device)/u);
  const simulator = new DemoThermostatSimulator();
  const reply = (request) => simulator.answer(new TextEncoder().encode(request))
    .map((part) => new TextDecoder().decode(part)).join("");
  assert.equal(reply("ID?\r"), "ID DEMOBENCH-THERMOSTAT 1\r");
  assert.equal(reply("STATUS?\r"), "STATUS 1 2150 2200 on\r");
  assert.equal(reply("SET 4000\r"), "ERR RANGE\r");
  assert.equal(reply("STATUS?\r"), "STATUS 2 2150 2200 on\r");
  assert.equal(reply("WHAT?\r"), "");
  assert.equal(reply("SET 2100\r"), "SET-OK 2100\r");
  assert.equal(reply("STATUS?\r"), "STATUS 3 2150 2100 off\r");
});
