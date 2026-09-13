import { once } from "node:events";

import { NodeTransferCheckpointStore } from "../../src/transfer-checkpoints.ts";

const [directory, id, ownerBytesText] = process.argv.slice(2);
const ownerBytes = Number(ownerBytesText);
if (directory === undefined || id === undefined || !Number.isSafeInteger(ownerBytes) || ownerBytes <= 0) {
  throw new Error("checkpoint lock child requires directory, id, and a positive owner byte count");
}

const store = new NodeTransferCheckpointStore(directory);
const owner = `child-${process.pid}:`.padEnd(ownerBytes, "x");
const claim = await store.claim(id, owner);
process.stdout.write("claimed\n");
process.stdin.resume();
await once(process.stdin, "end");
await store.release(claim);
