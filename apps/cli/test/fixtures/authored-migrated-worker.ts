import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerData } from "node:worker_threads";

import { readFile } from "node:fs/promises";
import { admitAuthoredModule, createAuthoredSession } from "@protodriver/core/authored-module";
import { RealClock } from "@protodriver/core/clock";
import { DEFAULT_AUTHORED_POLL_POLICY, grantRequiredPollPlans, pollPlans } from "@protodriver/core/authored-poll";
import { PostMessageCaptureDestinationRpcAdapter } from "@protodriver/core/capture-rpc";
import { PostMessageResourceRpcAdapter, ResourceBrokerRpcClient } from "@protodriver/core/resources";
import { serveSessionRpc } from "@protodriver/core/rpc";
import { MockTransport } from "../../../../packages/transport-mock/src/index.ts";

import type { AuthoredWorkerSessionInput } from "../../src/authored-worker-session.ts";
import { NodeTransferCheckpointStore } from "../../src/transfer-checkpoints.ts";
import { retainedWire } from "../../../../test-support/ti84-plus-ce/replay-wire.mjs";
import {retainedExchange,retainedStimulus} from "../../../../test-support/ti-84-evo/fixture.mjs";

const data = workerData as {
  readonly request: import("../../src/authored-worker-client.ts").AuthoredWorkerOpenRequest<AuthoredWorkerSessionInput>;
  readonly sessionPort: import("node:worker_threads").MessagePort;
  readonly resourcePort: import("node:worker_threads").MessagePort;
  readonly capturePort: import("node:worker_threads").MessagePort;
};
const input = data.request.generatedLua!;
const artifact = new Uint8Array(await readFile(new URL(
  "../../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  import.meta.url,
)));
const module = await admitAuthoredModule(data.request.canonicalBytes, artifact,
  input.expectedSourceSetSha256 === undefined ? {} : { expectedSourceSetSha256: input.expectedSourceSetSha256 });
const profile = module.description.connectionProfiles?.[input.selection.profileId];
if (profile === undefined || !profile.modes.includes(input.selection.modeId)) {
  throw new Error("fixture selection does not match the worker-admitted description");
}
const clock = new RealClock();
const exchange = await exchangeFor(module.description.id, input.selection.serialPath);
const pollPolicy = grantRequiredPollPlans(pollPlans(module.description), DEFAULT_AUTHORED_POLL_POLICY,
  { minimumIntervalMs: 200, maximumNominalPollsPerSecond: 5 });
const resources = new PostMessageResourceRpcAdapter(data.resourcePort as never);
const captures = new PostMessageCaptureDestinationRpcAdapter(data.capturePort as never);
const { server } = await createAuthoredSession(data.request.canonicalBytes, artifact, {
  platform: "node",
  modeId: input.selection.modeId,
  profileId: input.selection.profileId,
  channelId: "main",
  helpers: {},
  clock,
  pollPolicy,
  inputRetirementSupport: { adapter: "bounded-ingress-v1", clock },
  usbControl: { available: profile.transport.kind === "usb", limitation: "controlled serialized qualification" },
  checkpointStore: new NodeTransferCheckpointStore(join(tmpdir(), "f92-authored-worker-checkpoints")),
  async open() {
    const connection = new MockTransport(clock).openConnection({
      modeId: input.selection.modeId,
      profileId: input.selection.profileId,
      identity: { transport: "mock", stableKeyAssurance: "none" },
    });
    const channel = connection.channel("main");
    const acquire = channel.acquire.bind(channel);
    channel.acquire = async (...args) => {
      const lease = await acquire(...args);
      const write = lease.write.bind(lease);
      lease.write = async bytes => {
        const receipt = await write(bytes);
        for (const response of exchange(Buffer.from(bytes))) channel.enqueueReceived(response);
        return receipt;
      };
      return lease;
    };
    return connection;
  },
  resourceBroker: new ResourceBrokerRpcClient(resources),
  captureDestinationAdapter: captures,
});
serveSessionRpc(data.sessionPort as never, server);

async function exchangeFor(id: string, serialPath?: string): Promise<(bytes: Buffer) => readonly Uint8Array[]> {
  if (id === "d1-chan") {
    const replies = new Map([
      ["50534541524348", "06503133474d5253"], ["503133474d5253", "06"],
      ["02", "ffffffffffffffff"], ["06", "06"], ["5200000000", "5700000000"],
    ]);
    return bytes => [Buffer.from(requireReply(replies, bytes), "hex")];
  }
  if (id === "device-2-authored") {
    if (serialPath !== undefined && serialPath !== "/dev/pts/worker-fixture") {
      throw new Error("device-2 worker fixture received the wrong serial path");
    }
    return bytes => {
      if (bytes.toString() === "*IDN?\r\n") return [Buffer.from(serialPath === undefined
        ? "D2-LABS,D2-MON,1234ABCD,1.0\r\n"
        : "D2-LABS,D2-MON,SERIAL-PATH,1.0\r\n")];
      if (bytes.toString() === "CONF:RATE?\r\n") return [Buffer.from("1000\r\n")];
      throw new Error("device-2 worker fixture saw an unrequested write");
    };
  }
  if (id === "ti84-plus-ce") {
    const { frames } = await retainedWire();
    let stage = 0, next = 0;
    return bytes => {
      const hex = bytes.toString("hex");
      if (stage === 0 && hex === "000000040100000400") { stage = 1; return [frames[0]]; }
      if (stage === 1 && hex === "00000010040000000a0001000300010000000007d0") { stage = 2; return [Buffer.concat(frames.slice(1, 3))]; }
      if (stage === 2 && hex === "0000000205e000") { stage = 3; return []; }
      if (stage === 3 && hex === "0000000a0400000004000700010022") { stage = 4; next = 5; return [Buffer.concat(frames.slice(3, 5))]; }
      if (stage === 4 && hex === "0000000205e000") return next < frames.length ? [frames[next++]] : [];
      throw new Error("CE worker fixture saw an unrequested write");
    };
  }
  if (id === "ti-84-evo") return retainedExchange(await retainedStimulus());
  if (id === "device-3-authored") {
    return bytes => {
      if (bytes.length < 10 || bytes[6] !== 1 || bytes[7] !== 1) {
        throw new Error("device-3 worker fixture saw an unrequested write");
      }
      const body = Buffer.alloc(31);
      body[0] = 2; body[1] = 1; body[2] = bytes[8]!; body[3] = bytes[9]!;
      body[4] = 0; body[5] = 1; body[6] = 0x41; body[7] = 0;
      body[8] = 1; body[9] = 2; body[10] = 3; body[15] = 1; body[27] = 3;
      return [device3Frame(body)];
    };
  }
  throw new Error(`no serialized migration fixture for ${id}`);
}

function requireReply(replies: ReadonlyMap<string, string>, bytes: Buffer): string {
  const reply = replies.get(bytes.toString("hex"));
  if (reply === undefined) throw new Error("device-1 worker fixture saw an unrequested write");
  return reply;
}

function device3Frame(body: Uint8Array): Uint8Array {
  const framed = Buffer.alloc(body.length + 10);
  framed.set([0xa5, 0x5a, 0xd3, 1, body.length & 255, body.length >>> 8], 0);
  framed.set(body, 6);
  framed.writeUInt32LE(crc32c(framed.subarray(3, framed.length - 4)), framed.length - 4);
  return framed;
}

function crc32c(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
