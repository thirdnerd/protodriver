import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserFilePreviewOwner,
  installBrowserFileResult,
} from "../src/file-result.ts";

function fakeUrls() {
  const blobs = [];
  const revoked = [];
  return {
    blobs,
    revoked,
    api: {
      createObjectURL(blob) { blobs.push(blob); return `blob:test-${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  };
}

test("browser file result binds an authored operation Blob to the same preview and explicit-save bytes", async () => {
  // Unique regression: authored controls can auto-download a file while never creating their preview/save surface.
  const bytes = Uint8Array.of(0x42, 0x4d, 0x10, 0x20, 0x30);
  const blob = new Blob([bytes], { type: "image/bmp" });
  const urls = fakeUrls();
  const owner = new BrowserFilePreviewOwner(urls.api);
  const image = { hidden: true, src: "", onload: null, onerror: null };
  const status = { textContent: "" };
  let saveListener;
  const save = { addEventListener(_name, listener) { saveListener = listener; } };
  const anchor = { href: "", download: "", clicks: 0, click() { this.clicks += 1; } };
  installBrowserFileResult(
    { mediaType: "image/bmp", suggestedExtension: "bmp" },
    blob,
    { save, image, status },
    owner,
    { createElement() { return anchor; } },
    urls.api,
  );
  assert.equal(image.src, "blob:test-1");
  image.onload();
  assert.equal(status.textContent, "Preview available.");
  image.onerror();
  assert.equal(image.hidden, true);
  assert.equal(status.textContent, "Preview unavailable. The original bytes can still be saved.");
  assert.deepEqual(urls.revoked, ["blob:test-1"]);
  installBrowserFileResult(
    { mediaType: "image/bmp", suggestedExtension: "bmp" },
    blob, { save, image, status }, owner,
    { createElement() { return anchor; } }, urls.api,
  );
  saveListener();
  assert.equal(anchor.download, "protodriver-result.bmp");
  assert.equal(anchor.clicks, 1);
  assert.deepEqual(new Uint8Array(await urls.blobs[0].arrayBuffer()), bytes);
  assert.deepEqual(new Uint8Array(await urls.blobs[2].arrayBuffer()), bytes);
});
