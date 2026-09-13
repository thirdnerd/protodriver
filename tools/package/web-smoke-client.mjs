import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [packageRootArgument, serverOutputArgument] = process.argv.slice(2);
if (packageRootArgument === undefined || serverOutputArgument === undefined) {
  throw new Error("usage: node web-smoke-client.mjs PACKAGE_ROOT SERVER_STDOUT");
}

const packageRoot = resolve(packageRootArgument);
const manifest = JSON.parse(await readFile(join(packageRoot, "PACKAGE-MANIFEST.json"), "utf8"));
assert.equal(manifest.web.root, "app/apps/web/dist");
const assets = manifest.web.assets;
assert.ok(Array.isArray(assets));
for (const required of [
  "app.js",
  "index.html",
  "sessionWorker.js",
  "styles.css",
]) {
  assert.ok(assets.some(({ path }) => path === required), `web manifest omits ${required}`);
}

const origin = await waitForOrigin(resolve(serverOutputArgument));
for (const asset of assets) {
  const response = await fetch(new URL(asset.path, `${origin}/`));
  assert.equal(response.status, 200, `${asset.path} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.byteLength, asset.bytes, `${asset.path} length changed while serving`);
  assert.equal(sha256(bytes), asset.sha256, `${asset.path} bytes changed while serving`);
  assert.equal(response.headers.get("cache-control"), "no-store");
}
process.stdout.write(`packaged web: ${assets.length} assets served with expected bytes\n`);

async function waitForOrigin(outputPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = await readFile(outputPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const match = /Protodriver generated browser UI: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
    if (match !== null) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`packaged web server did not announce its loopback origin: ${outputPath}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
