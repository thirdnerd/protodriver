import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { checkBrowserOffline } from "../check-browser-offline.mjs";

export const PACKAGE_WEB_BUILD_FORMAT = "protodriver.package-web-build/v1";
export const PACKAGE_WEB_BUILD_MANIFEST = "WEB-BUILD.json";
export const PACKAGE_WEB_ASSETS = Object.freeze([
  "app.js",
  "index.html",
  "sessionWorker.js",
  "styles.css",
]);

const fingerprintRoots = Object.freeze([
  "apps/web",
  "packages",
  "tools/build-package-web.mjs",
  "tools/check-browser-offline.mjs",
  "tools/package/web-build.mjs",
]);

export async function finalizePackageWebBuild({
  buildDirectory,
  sourceDirectory,
} = {}) {
  const buildRoot = resolveRequired(buildDirectory, "buildDirectory");
  const sourceRoot = resolveRequired(sourceDirectory, "sourceDirectory");
  const distribution = await inspectPackageWebDistribution(join(buildRoot, "dist"));
  const manifest = Object.freeze({
    assets: distribution.assets,
    format: PACKAGE_WEB_BUILD_FORMAT,
    offlineFilesChecked: distribution.offlineFilesChecked,
    sourceSha256: await packageWebSourceSha256(sourceRoot),
  });
  await writeFile(
    join(buildRoot, PACKAGE_WEB_BUILD_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function verifyPackageWebBuild({
  buildDirectory,
  sourceDirectory,
} = {}) {
  const buildRoot = resolveRequired(buildDirectory, "buildDirectory");
  const sourceRoot = resolveRequired(sourceDirectory, "sourceDirectory");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(buildRoot, PACKAGE_WEB_BUILD_MANIFEST), "utf8"));
  } catch (cause) {
    throw new Error(
      `package-web-build.manifest-invalid: ${join(buildRoot, PACKAGE_WEB_BUILD_MANIFEST)}`,
      { cause },
    );
  }
  if (manifest.format !== PACKAGE_WEB_BUILD_FORMAT) {
    throw new Error(
      `package-web-build.format-invalid: expected ${PACKAGE_WEB_BUILD_FORMAT}, observed ${JSON.stringify(manifest.format)}`,
    );
  }
  const sourceSha256 = await packageWebSourceSha256(sourceRoot);
  if (manifest.sourceSha256 !== sourceSha256) {
    throw new Error(
      `package-web-build.source-stale: expected ${sourceSha256}, observed ${JSON.stringify(manifest.sourceSha256)}`,
    );
  }
  const distribution = await inspectPackageWebDistribution(join(buildRoot, "dist"));
  if (manifest.offlineFilesChecked !== distribution.offlineFilesChecked
      || JSON.stringify(manifest.assets) !== JSON.stringify(distribution.assets)) {
    throw new Error("package-web-build.assets-changed: built assets do not match WEB-BUILD.json");
  }
  return Object.freeze({ ...distribution, sourceSha256 });
}

export async function stagePackageWebBuild({
  buildDirectory,
  destinationDirectory,
  sourceDirectory,
} = {}) {
  const buildRoot = resolveRequired(buildDirectory, "buildDirectory");
  const destination = resolveRequired(destinationDirectory, "destinationDirectory");
  const verified = await verifyPackageWebBuild({ buildDirectory: buildRoot, sourceDirectory });
  await mkdir(destination, { recursive: true });
  for (const asset of PACKAGE_WEB_ASSETS) {
    await cp(join(buildRoot, "dist", asset), join(destination, asset));
  }
  const staged = await inspectPackageWebDistribution(destination);
  if (JSON.stringify(staged.assets) !== JSON.stringify(verified.assets)) {
    throw new Error("package-web-build.stage-changed: packaged web bytes differ from shared build");
  }
  return Object.freeze({ ...staged, sourceSha256: verified.sourceSha256 });
}

export async function inspectPackageWebDistribution(directory) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true }).catch((cause) => {
    throw new Error(`package-web-build.distribution-absent: ${root}`, { cause });
  });
  const observed = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name).sort();
  const sourceMaps = observed.filter((entry) => entry.endsWith(".map"));
  if (sourceMaps.length > 0) {
    throw new Error(`package-web-build.sourcemap-forbidden: observed ${sourceMaps.join(", ")}`);
  }
  if (nonFiles.length > 0 || observed.join("\n") !== PACKAGE_WEB_ASSETS.join("\n")) {
    throw new Error(
      `package-web-build.assets-invalid: expected ${PACKAGE_WEB_ASSETS.join(", ")}; observed ${observed.join(", ")}`
        + (nonFiles.length === 0 ? "" : `; non-files ${nonFiles.join(", ")}`),
    );
  }
  const offline = await checkBrowserOffline(root);
  if (offline.failures.length > 0) {
    throw new Error(`package-web-build.offline-failed:\n${offline.failures.join("\n")}`);
  }
  const assets = await Promise.all(observed.map(async (name) => Object.freeze({
    bytes: (await lstat(join(root, name))).size,
    path: name,
    sha256: await sha256(join(root, name)),
  })));
  return Object.freeze({
    assets: Object.freeze(assets),
    offlineFilesChecked: offline.fileCount,
  });
}

export async function packageWebSourceSha256(sourceDirectory) {
  const sourceRoot = resolveRequired(sourceDirectory, "sourceDirectory");
  const paths = [];
  for (const input of fingerprintRoots) {
    await collectFingerprintPaths(sourceRoot, resolve(sourceRoot, input), paths);
  }
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash("sha256");
  for (const path of paths) {
    const logical = relative(sourceRoot, path).split(sep).join("/");
    const bytes = await readFile(path);
    hash.update(`${Buffer.byteLength(logical)}:${logical}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function collectFingerprintPaths(sourceRoot, path, paths) {
  const logical = relative(sourceRoot, path).split(sep).join("/");
  if (logical.split("/").includes("node_modules") || logical === "apps/web/dist") return;
  const info = await lstat(path).catch((cause) => {
    throw new Error(`package-web-build.source-input-absent: ${logical}`, { cause });
  });
  if (info.isFile()) {
    paths.push(path);
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`package-web-build.source-input-invalid: ${logical}`);
  }
  const children = await readdir(path);
  children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const child of children) await collectFingerprintPaths(sourceRoot, join(path, child), paths);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function resolveRequired(value, name) {
  if (value === undefined) throw new TypeError(`${name} is required`);
  return resolve(value);
}
