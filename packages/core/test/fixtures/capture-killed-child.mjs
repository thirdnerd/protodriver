import { open } from "node:fs/promises";

import { CaptureWriter } from "../../src/capture.ts";
import { VirtualClock } from "../../../../test-support/clock.ts";

const outputPath = process.argv[2];
if (outputPath === undefined) throw new Error("capture output path is required");

const handle = await open(outputPath, "wx", 0o600);
const writer = await CaptureWriter.create({
  sink: {
    async write(data) {
      await handle.write(data);
    },
    async close() {
      await handle.close();
    },
  },
  clock: new VirtualClock(1_700_000_000_000),
  captureId: "killed-child",
  logicalDevice: "test.device",
  host: { platform: "node" },
  maximumBufferedBytes: 1_024,
});

writer.record({
  kind: "rx-delivered",
  conn: 1,
  ch: "main",
  data: "AQIDBA==",
});
await writer.flush();
process.stdout.write("READY\n");
process.stdin.resume();
