import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../corpus/device-3/device.lua", import.meta.url), "utf8");

test("Device 3 moves both DATA deadline occurrences to the measured bound", () => {
  assert.equal(source.match(/deadline_ms\([ \t]*2501[ \t]*\)/gu)?.length, 1);
  assert.equal(source.match(/window\([ \t]*io[ \t]*,[ \t]*2501[ \t]*\)/gu)?.length, 1);
  assert.doesNotMatch(
    source,
    /deadline_ms\([ \t]*1001[ \t]*\)|window\([ \t]*io[ \t]*,[ \t]*1001[ \t]*\)/u,
  );
});
