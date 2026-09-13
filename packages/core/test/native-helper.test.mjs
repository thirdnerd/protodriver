import assert from "node:assert/strict";
import test from "node:test";

import { NativeHelperData } from "../src/native-helper.ts";

test("buffer accounting refuses invalid bounds and keeps release idempotent", () => {
  const data = new NativeHelperData(256);
  for (const bounds of [[-1, 0], [3, 4], [Infinity, 0], [3.5, 1]])
    assert.throws(() => data.reserve(...bounds), /invalid bounded buffer/);
  const held = data.reserve(128, 0);
  assert.throws(() => data.reserve(128, 0), /before allocation/);
  held.release(); held.release();
  const next = data.reserve(128, 0);
  assert.throws(() => data.reserve(128, 0), /before allocation/);
  next.release();
});
