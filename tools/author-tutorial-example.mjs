import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { MockTransport } from "../packages/transport-mock/src/index.ts";
import { createNodeAuthoredAcquisition } from "../apps/cli/src/authored-acquisition.ts";
import { runPdr } from "../apps/cli/src/pdr.ts";
import { retainedWire } from "../test-support/ti84-plus-ce/replay-wire.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = join(repositoryRoot, "corpus/ti84-plus-ce");

const displayedCommands = Object.freeze({
  pack: "node apps/cli/src/pdr.ts pack corpus/ti84-plus-ce ti84-plus-ce.pdpkg",
  modeHelp: "node apps/cli/src/pdr.ts run ti84-plus-ce.pdpkg --help",
  operationHelp: "node apps/cli/src/pdr.ts run ti84-plus-ce.pdpkg capture_screenshot --help",
  run: "node apps/cli/src/pdr.ts run ti84-plus-ce.pdpkg capture_screenshot --save-result ti84-plus-ce-screenshot.bmp",
});

/** Executes every command displayed by the author tutorial's worked example. */
export async function runAuthorTutorialExample() {
  const retained = await retainedWire();
  let writes;
  const output = [];
  const errors = [];
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-author-tutorial-"));
  const packagePath = join(scratch, "ti84-plus-ce.pdpkg");
  const savedPath = join(scratch, "ti84-plus-ce-screenshot.bmp");
  let screenshot;
  try {
    const packedRaw = await runPdrProcess(["pack", sourcePath, packagePath]);
    const packed = packedRaw.replace(packagePath, "ti84-plus-ce.pdpkg");
    const [modeHelp, operationHelp] = await Promise.all([
      runPdrProcess(["run", packagePath, "--help"]),
      runPdrProcess(["run", packagePath, "capture_screenshot", "--help"]),
    ]);
    const acquisition=createNodeAuthoredAcquisition(async(profile,modeId,clock)=>{
      if(profile.id!=="usb"||modeId!=="screenshot")throw Error("tutorial command selected an unexpected mode or profile");
      const connection=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId,profileId:profile.id});
      const channel=connection.channel("main"),nativeAcquire=channel.acquire.bind(channel),requests=["000000040100000400","00000010040000000a0001000300010000000007d0","0000000a0400000004000700010022"],ack="0000000205e000";
      let stage=0,next=0;writes=[];
      channel.acquire=async(...args)=>{const lease=await nativeAcquire(...args),nativeWrite=lease.write.bind(lease);lease.write=async bytes=>{
        const copy=Buffer.from(bytes),hex=copy.toString("hex"),receipt=await nativeWrite(bytes);writes.push(copy);
        if(stage===0){if(hex!==requests[0])throw Error("tutorial negotiation request changed");channel.enqueueReceived(retained.frames[0]);stage=1;}
        else if(stage===1){if(hex!==requests[1])throw Error("tutorial entry request changed");channel.enqueueReceived(Buffer.concat(retained.frames.slice(1,3)));stage=2;}
        else if(stage===2){if(hex!==ack)throw Error("tutorial entry acknowledgement changed");stage=3;}
        else if(stage===3){if(hex!==requests[2])throw Error("tutorial screenshot request changed");channel.enqueueReceived(Buffer.concat(retained.frames.slice(3,5)));next=5;stage=4;}
        else{if(stage!==4||hex!==ack)throw Error("tutorial screenshot acknowledgement changed");if(next<retained.frames.length)channel.enqueueReceived(retained.frames[next++]);else stage=5;}
        return receipt;};return lease;};
      return[{candidate:{candidateId:"tutorial-retained-ce",identity:connection.identity,displayName:"Retained TI-84 Plus CE exchange",matchedProfileId:"usb"},open:async()=>connection}];
    });
    await runPdr(["run",packagePath,"capture_screenshot","--save-result",savedPath],{input:[],output:byteSink(output),error:byteSink(errors)},{authoredAcquisition:acquisition});
    if(errors.length)throw Error("tutorial command wrote unexpected stderr: "+Buffer.concat(errors).toString("utf8"));
    screenshot = new Uint8Array(await readFile(savedPath));
    const runOutput = Buffer.concat(output).toString("utf8");
    const transcript=renderTranscript({packed,modeHelp,operationHelp,runOutput});
    if(writes?.length!==155)throw Error("tutorial command did not execute the complete retained CE exchange");
    const screen=screenshot.subarray(66);
    if(screen.byteLength!==retained.fixture.expected.screenBytes||sha256(screen)!==retained.fixture.expected.screenSha256)
      throw Error("tutorial screenshot differs from the retained hardware response");
    return Object.freeze({transcript,retainedResponse:Object.freeze({bytes:retained.wire.byteLength,sha256:sha256(retained.wire)}),
      savedScreenshot:Object.freeze({file:"ti84-plus-ce-screenshot.bmp",bytes:screenshot.byteLength,sha256:sha256(screenshot),screenSha256:sha256(screen)}),writes:writes.length});
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runPdrProcess(argv) {
  const result = await executeFile(
    process.execPath,
    ["apps/cli/src/pdr.ts", ...argv],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.stderr !== "") {
    throw new Error(`tutorial command wrote unexpected stderr: ${result.stderr}`);
  }
  return result.stdout;
}

function renderTranscript({ packed, modeHelp, operationHelp, runOutput }) {
  const sections = [
    [displayedCommands.pack, packed],
    [displayedCommands.modeHelp, modeHelp],
    [displayedCommands.operationHelp, operationHelp],
    [displayedCommands.run, runOutput],
  ];
  return `${sections.map(([command, output]) => {
    const rendered = output.trimEnd();
    return `$ ${command}${rendered === "" ? "" : `\n${rendered}`}`;
  }).join("\n\n")}\n`;
}

function byteSink(chunks) {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (await isMainModule(import.meta.url)) {
  const result = await runAuthorTutorialExample();
  process.stdout.write(result.transcript);
}
