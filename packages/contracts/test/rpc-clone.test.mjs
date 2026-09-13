import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_RPC_CLONE_SAMPLES,
} from "./rpc-clone-corpus.ts";

test("every exhaustively registered session RPC member survives structuredClone", () => {
  for (const message of SESSION_RPC_CLONE_SAMPLES) {
    assert.deepStrictEqual(structuredClone(message), message);
  }
});
