import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runAuthorTutorialExample } from "../author-tutorial-example.mjs";

const transcriptPath = new URL(
  "../../examples/ti84-plus-ce/transcript.txt",
  import.meta.url,
);

test("the author tutorial transcript executes its commands and retained hardware exchange", async () => {
  const expected = await readFile(transcriptPath, "utf8");
  const actual = await runAuthorTutorialExample();

  assert.equal(actual.transcript, expected);
  assert.deepEqual(actual.retainedResponse, {
    bytes: 154_406,
    sha256: "c9aab30b871acbc2d716ce9e73d5d782e86bce147f54313c75e5fbcbadd0f9fa",
  });
  assert.deepEqual(actual.savedScreenshot, {
    file: "ti84-plus-ce-screenshot.bmp",
    bytes: 153_666,
    sha256: "f13a25cc9c310ce2fc8dea0246c5fd3b291bc83de6804dc317d071678aac38b0",
    screenSha256: "18214f6cb20f393a6e8293d181715af9abda74f32f943941aaa0a5e5d90cf125",
  });
  assert.equal(actual.writes, 155);
});
