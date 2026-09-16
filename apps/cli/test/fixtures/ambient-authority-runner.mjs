import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { devNull } from "node:os";
import { Writable } from "node:stream";

import { MockTransport } from "../../../../packages/transport-mock/src/index.ts";
import { runPdr } from "../../src/pdr.ts";

const packagePaths = process.argv.slice(2);
let sequence = 0;
const transport = new MockTransport({
  monotonicUs: () => 0,
  wallClockUnixMs: () => 0,
  nextSequence: () => ++sequence,
  sleep: async () => {},
  timer: () => ({ dispose() {} }),
});
const transportOpenPhases = [];
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const error = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

async function recordingOpenSession() {
  transportOpenPhases.push(process.env.PDR_AMBIENT_PHASE);
  return transport.openConnection({
    identity: { transport: "mock", stableKeyAssurance: "none" },
    modeId: "ambient-control",
    profileId: "ambient-control",
  });
}

process.env.PDR_AMBIENT_PHASE = "control";
await readFile(devNull);
readFileSync(devNull);
await new Promise((resolveControl) => {
  const socket = net.connect({ path: `/tmp/protodriver-ambient-missing-${process.pid}.sock` });
  socket.once("error", resolveControl);
});
await new Promise((resolveControl, rejectControl) => {
  const child = spawn(process.execPath, ["-e", ""]);
  child.once("error", rejectControl);
  child.once("exit", (code) => code === 0 ? resolveControl() : rejectControl(new Error(`control subprocess exited ${code}`)));
});
await import(`data:text/javascript,export default true#ambient-${process.pid}`);
await (await recordingOpenSession()).close();

const loaded = [];
for (const packagePath of packagePaths) {
  process.env.PDR_AMBIENT_PHASE = `load:${packagePath}`;
  await runPdr(["run", packagePath], {
    input: [],
    output,
    error,
  }, { authoredAcquisition: recordingOpenSession });
  loaded.push(packagePath);
}
process.env.PDR_AMBIENT_PHASE = "idle";

process.stdout.write(`${JSON.stringify({
  loaded,
  transport: {
    instrumentVisible: transport.connections.length,
    control: transportOpenPhases.filter((phase) => phase === "control").length,
    duringLoad: transportOpenPhases.filter((phase) => phase?.startsWith("load:")).length,
  },
})}\n`);
