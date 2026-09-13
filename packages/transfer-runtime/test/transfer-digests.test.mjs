import assert from "node:assert/strict";
import test from "node:test";

import { SHA256_TRANSFER_DIGESTS } from "../src/transfer-digests.ts";

test("the portable streaming SHA-256 provider matches the published abc vector across updates", async () => {
  const digest = SHA256_TRANSFER_DIGESTS.create("sha256");
  digest.update(new TextEncoder().encode("a"));
  digest.update(new TextEncoder().encode("bc"));
  assert.equal(
    await digest.digestHex(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

