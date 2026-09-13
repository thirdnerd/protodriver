#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  cp,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, createGzip } from "node:zlib";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { stagePackageAuthorMaterial } from "./package/author-material.mjs";
import { createDeterministicDeflatedZip } from "./package/stored-zip.mjs";
import { packageArchiveName, packageTarget } from "./package/targets.mjs";
import { releaseManifestFields, validateReleaseVersion } from "./package/release-version.mjs";
import { stagePackageWebBuild } from "./package/web-build.mjs";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cliRuntimeModules = Object.freeze([
  "@serialport",
  "@types/w3c-web-usb",
  "debug",
  "ms",
  "node-addon-api",
  "node-gyp-build",
  "serialport",
  "usb",
]);

const posixIoctlRuntimeModules = Object.freeze([
  "bindings",
  "file-uri-to-path",
  "ioctl",
  "nan",
]);

const retainedVmInput = Object.freeze({
  source: "packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  packaged: "app/packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  sha256: "f0646d258acf98a02eabf678aea7ae90f118fca6e1014515ffbdb95987c54e37",
});

export async function discoverCliProjectPackages(sourceDirectory = defaultRepositoryRoot) {
  // Release assembly copies each runtime dependency's whole src tree. That
  // packaging mechanism does not make every copied export a published API;
  // decide reachability from actual readers, not archive presence alone.
  const sourceRoot = resolve(sourceDirectory);
  const cliPackagePath = join(sourceRoot, "apps", "cli", "package.json");
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  if (typeof cliPackage.dependencies !== "object"
      || cliPackage.dependencies === null
      || Array.isArray(cliPackage.dependencies)) {
    throw new Error(`package-cli.dependencies-invalid: ${cliPackagePath} has no dependency object`);
  }
  const names = [];
  for (const dependencyName of Object.keys(cliPackage.dependencies)) {
    if (!dependencyName.startsWith("@protodriver/")) continue;
    const packageName = dependencyName.slice("@protodriver/".length);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(packageName)) {
      throw new Error(`package-cli.dependencies-invalid: ${JSON.stringify(dependencyName)} is not a package leaf`);
    }
    const packagePath = join(sourceRoot, "packages", packageName, "package.json");
    const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageManifest.name !== dependencyName) {
      throw new Error(
        `package-cli.dependencies-invalid: ${packagePath} names ${JSON.stringify(packageManifest.name)}, expected ${JSON.stringify(dependencyName)}`,
      );
    }
    names.push(packageName);
  }
  if (names.length === 0) {
    throw new Error(`package-cli.dependencies-invalid: ${cliPackagePath} names no @protodriver runtime dependency`);
  }
  return Object.freeze(names.sort());
}

export async function buildCliPackage({
  target: targetId,
  nodeRuntimeRoot = resolve(process.execPath, "../.."),
  outputDirectory,
  sourceCommit,
  releaseVersion,
  sourceDirectory = defaultRepositoryRoot,
  webBuildDirectory,
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (outputDirectory === undefined) throw new TypeError("outputDirectory is required");
  if (webBuildDirectory === undefined) throw new TypeError("webBuildDirectory is required");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit");
  }
  if (releaseVersion !== undefined) validateReleaseVersion(releaseVersion);
  const target = packageTarget(targetId);
  const builder = `${process.platform}-${process.arch}`;
  const nativeBuilder = process.platform === target.os && process.arch === target.architecture;
  if (!nativeBuilder && !target.crossAssemblyHosts?.includes(builder)) {
    throw new Error(`package-cli.target-mismatch: requested ${target.id}, builder is ${process.platform}-${process.arch}`);
  }
  const sourceRoot = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  const runtimeRoot = resolve(nodeRuntimeRoot);
  const projectPackages = await discoverCliProjectPackages(sourceRoot);
  const archiveName = packageArchiveName(target, releaseVersion);
  await mkdir(output, { recursive: true });
  await verifyNodeRuntime(runtimeRoot, target);
  await verifyPinnedInput(sourceRoot, retainedVmInput);
  for (const [name, input] of Object.entries(target.nativeInputs)) {
    if (input.sha256 === undefined) {
      await assertFile(resolve(sourceRoot, input.source), `${name} native addon`);
    } else {
      await verifyPinnedInput(sourceRoot, input);
    }
  }
  const nativeArchitectures = await verifyTargetNativeArchitectures(sourceRoot, target);

  const scratch = await mkdtemp(join(output, `.package-${target.id}.`));
  const packagedRoot = join(scratch, target.packageRootName);
  const temporaryArchive = join(output, `.${archiveName}.${process.pid}.tmp`);
  const temporaryTar = `${temporaryArchive}.tar`;
  const archivePath = join(output, archiveName);
  try {
    await stagePackage(packagedRoot, runtimeRoot, sourceRoot, projectPackages, target);
    await stagePackageAuthorMaterial({
      packageRoot: packagedRoot,
      sourceDirectory: sourceRoot,
      target,
    });
    const web = await stageWebApplication(packagedRoot, sourceRoot, webBuildDirectory);
    if (target.sourceRepresentation?.kind === "javascript") {
      await emitJavaScriptPackageTree(packagedRoot, sourceRoot);
    }
    const manifest = await writePackageManifest(
      packagedRoot,
      sourceRoot,
      projectPackages,
      target,
      nativeArchitectures,
      web,
      sourceCommit,
      releaseVersion,
    );
    if (target.os === "darwin") await normalizeDarwinTree(packagedRoot);
    const unpackedBytes = await regularFileBytes(packagedRoot);
    const fileCount = await regularFileCount(packagedRoot);
    if (target.archiveFormat === "zip") {
      await createDeterministicDeflatedZip({
        outputPath: temporaryArchive,
        rootDirectory: packagedRoot,
        rootName: target.packageRootName,
      });
    } else {
      await createNormalizedTar(scratch, temporaryTar, target.packageRootName);
      await pipeline(
        createReadStream(temporaryTar),
        createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
        createWriteStream(temporaryArchive, { flags: "wx", mode: 0o644 }),
      );
    }
    await rename(temporaryArchive, archivePath);
    return Object.freeze({
      archivePath,
      archiveSha256: await sha256(archivePath),
      fileCount,
      manifest,
      unpackedBytes,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(temporaryTar, { force: true });
    await rm(temporaryArchive, { force: true });
  }
}

/** Staging writes ~138 MB. When the destination filesystem cannot take it,
 *  Node surfaces the raw errno — ENOSPC, or EDQUOT as "Unknown system error
 *  -122" — with a stack trace and no mention of the path or the cause. */
async function stage(action, destination) {
  try {
    return await action;
  } catch (cause) {
    const code = cause?.code ?? "";
    const outOfRoom = code === "ENOSPC" || code === "EDQUOT"
      || cause?.errno === -122 || String(code).includes("-122");
    throw new Error(
      outOfRoom
        ? `package-cli.staging-full: no room to write ${destination}. `
          + "The staged package needs about 140 MB; check free space on that "
          + "filesystem, and note that a small /tmp will not hold it."
        : `package-cli.staging-failed: could not write ${destination}`,
      { cause },
    );
  }
}

async function stagePackage(packagedRoot, runtimeRoot, sourceRoot, projectPackages, target) {
  await Promise.all([
    mkdir(join(packagedRoot, "app", "apps", "cli"), { recursive: true }),
    mkdir(join(packagedRoot, "app", "apps", "web"), { recursive: true }),
    mkdir(join(packagedRoot, "app", "node_modules", "@protodriver"), { recursive: true }),
    mkdir(join(packagedRoot, "bin"), { recursive: true }),
    mkdir(join(packagedRoot, "licenses"), { recursive: true }),
  ]);
  await Promise.all([
    stage(
      cp(
        join(runtimeRoot, target.runtimeBinarySource ?? "bin/node"),
        join(packagedRoot, target.runtimeBinaryPackaged ?? "bin/node"),
      ),
      join(packagedRoot, target.runtimeBinaryPackaged ?? "bin/node"),
    ),
    cp(join(runtimeRoot, "LICENSE"), join(packagedRoot, "licenses", "node-LICENSE")),
    // Lua is MIT and its notice must travel with the WebAssembly built from it.
    cp(join(sourceRoot, "packages/lua-vm/LICENSE"), join(packagedRoot, "licenses", "lua-LICENSE")),
    cp(join(sourceRoot, "LICENSE"), join(packagedRoot, "licenses", "protodriver-LICENSE")),
    cp(join(sourceRoot, "NOTICE"), join(packagedRoot, "NOTICE")),
    cp(join(sourceRoot, "apps/cli/package.json"), join(packagedRoot, "app/apps/cli/package.json")),
    stage(
      cp(join(sourceRoot, "apps/cli/src"), join(packagedRoot, "app/apps/cli/src"), { recursive: true }),
      join(packagedRoot, "app/apps/cli/src"),
    ),
    cp(join(sourceRoot, "apps/web/serve.mjs"), join(packagedRoot, "app/apps/web/serve.mjs")),
    cp(join(sourceRoot, "tools/package/native-smoke.ts"), join(packagedRoot, "app/native-smoke.ts")),
  ]);

  for (const packageName of projectPackages) {
    const source = join(sourceRoot, "packages", packageName);
    const destination = join(packagedRoot, "app", "packages", packageName);
    await mkdir(destination, { recursive: true });
    await Promise.all([
      cp(join(source, "package.json"), join(destination, "package.json")),
      cp(join(source, "src"), join(destination, "src"), { recursive: true }),
    ]);
    if (packageName === "lua-vm") {
      await mkdir(join(destination, "artifacts"), { recursive: true });
      await cp(join(sourceRoot, retainedVmInput.source), join(destination, "artifacts", "protodriver-retained-v2.wasm"));
    }
    const installedPackage = join(packagedRoot, "app", "node_modules", "@protodriver", packageName);
    if (target.projectPackageLayout === "copy") {
      // Windows extraction must not require symlink privilege or Developer
      // Mode. Copying this small source graph also keeps package-relative WASM
      // resolution identical to the POSIX symlink layout.
      await cp(destination, installedPackage, { recursive: true });
    } else {
      await symlink(`../../packages/${packageName}`, installedPackage);
    }
  }

  for (const moduleName of cliRuntimeModules) {
    await copyRuntimeModule(join(sourceRoot, "apps/cli/node_modules"), moduleName, join(packagedRoot, "app/node_modules"));
  }
  if (target.nativeInputs.ioctl !== undefined) {
    for (const moduleName of posixIoctlRuntimeModules) {
      await copyRuntimeModule(
        join(sourceRoot, "packages/transport-node-serial/node_modules"),
        moduleName,
        join(packagedRoot, "app/node_modules"),
      );
    }
  }
  await keepOnlyTargetPrebuild(packagedRoot, sourceRoot, target.nativeInputs.serialport);
  await keepOnlyTargetPrebuild(packagedRoot, sourceRoot, target.nativeInputs.usb);
  if (target.nativeInputs.ioctl !== undefined) {
    await keepOnlyIoctlAddon(packagedRoot, sourceRoot, target.nativeInputs.ioctl);
  }

  if (target.os === "win32") {
    const launcher = `@echo off\r
"%~dp0node.exe" "%~dp0..\\app\\apps\\cli\\src\\pdr.js" %*\r
`;
    const webLauncher = `@echo off\r
setlocal\r
pushd "%~dp0..\\app\\apps\\web" || exit /b 1\r
"%~dp0node.exe" "serve.mjs" %*\r
set "pdr_web_status=%ERRORLEVEL%"\r
popd\r
exit /b %pdr_web_status%\r
`;
    await Promise.all([
      writeFile(join(packagedRoot, "bin", "pdr.cmd"), launcher),
      writeFile(join(packagedRoot, "bin", "pdr-web.cmd"), webLauncher),
    ]);
    return;
  }

  const launcher = `#!/bin/sh
set -eu
case "$0" in
  */*) pdr_bin_dir=\${0%/*} ;;
  *) pdr_bin_dir=. ;;
esac
pdr_bin_dir=$(CDPATH= cd -- "$pdr_bin_dir" && pwd)
exec "$pdr_bin_dir/node" "$pdr_bin_dir/../app/apps/cli/src/pdr.ts" "$@"
`;
  const webLauncher = `#!/bin/sh
set -eu
case "$0" in
  */*) pdr_bin_dir=\${0%/*} ;;
  *) pdr_bin_dir=. ;;
esac
pdr_bin_dir=$(CDPATH= cd -- "$pdr_bin_dir" && pwd)
cd "$pdr_bin_dir/../app/apps/web"
exec "$pdr_bin_dir/node" "serve.mjs" "$@"
`;
  await Promise.all([
    writeFile(join(packagedRoot, "bin", "pdr"), launcher, { mode: 0o755 }),
    writeFile(join(packagedRoot, "bin", "pdr-web"), webLauncher, { mode: 0o755 }),
  ]);
  await chmod(join(packagedRoot, target.runtimeBinaryPackaged ?? "bin/node"), 0o755);
}

export async function stageWebApplication(
  packagedRoot,
  sourceRoot = defaultRepositoryRoot,
  webBuildDirectory,
) {
  if (webBuildDirectory === undefined) throw new TypeError("webBuildDirectory is required");
  const destination = join(packagedRoot, "app", "apps", "web", "dist");
  return await stagePackageWebBuild({
    buildDirectory: webBuildDirectory,
    destinationDirectory: destination,
    sourceDirectory: sourceRoot,
  });
}

async function copyRuntimeModule(sourceNodeModules, moduleName, destinationNodeModules) {
  const source = join(sourceNodeModules, ...moduleName.split("/"));
  const destination = join(destinationNodeModules, ...moduleName.split("/"));
  await assertDirectory(source, `runtime dependency ${moduleName}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function keepOnlyTargetPrebuild(packagedRoot, sourceRoot, input) {
  const packaged = join(packagedRoot, input.packaged);
  const prebuilds = resolve(packaged, "../..");
  await rm(prebuilds, { recursive: true, force: true });
  await mkdir(dirname(packaged), { recursive: true });
  await cp(join(sourceRoot, input.source), packaged);
}

async function keepOnlyIoctlAddon(packagedRoot, sourceRoot, input) {
  const packaged = join(packagedRoot, input.packaged);
  const build = resolve(packaged, "../..");
  await rm(build, { recursive: true, force: true });
  await mkdir(dirname(packaged), { recursive: true });
  await cp(join(sourceRoot, input.source), packaged);
}

/**
 * Emit the authored application graph for targets where Node cannot execute
 * TypeScript from its installed package location. Published runtime modules
 * stay untouched; only source owned by this repository is transformed.
 */
export async function emitJavaScriptPackageTree(
  packagedRoot,
  sourceRoot = defaultRepositoryRoot,
) {
  const requireFromCli = createRequire(join(resolve(sourceRoot), "apps/cli/package.json"));
  const typescript = requireFromCli("typescript");
  if (typescript.version !== "5.6.3") {
    throw new Error(
      `package-cli.typescript-version-mismatch: expected 5.6.3, observed ${typescript.version}`,
    );
  }
  const authoredRoots = [
    join(packagedRoot, "app", "apps", "cli"),
    join(packagedRoot, "app", "packages"),
    join(packagedRoot, "app", "node_modules", "@protodriver"),
  ];
  const sourcePaths = [];
  const packageManifests = [];
  for (const root of authoredRoots) {
    await walk(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (path.endsWith(".ts") || path.endsWith(".js")) sourcePaths.push(path);
      else if (path.endsWith("package.json")) packageManifests.push(path);
    });
  }
  const nativeSmoke = join(packagedRoot, "app", "native-smoke.ts");
  await assertFile(nativeSmoke, "native smoke source");
  sourcePaths.push(nativeSmoke);

  // Existing JavaScript compatibility bridges are rewritten first. A sibling
  // TypeScript implementation then deliberately replaces the bridge at the
  // same .js path, as with contracts/src/lua-source-set.{js,ts}.
  sourcePaths.sort((left, right) => {
    const extensionOrder = Number(left.endsWith(".ts")) - Number(right.endsWith(".ts"));
    return extensionOrder || left.localeCompare(right);
  });
  const rewriteSpecifier = rewriteTypeScriptSpecifierTransformer(typescript);
  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, "utf8");
    const emitted = typescript.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        allowJs: true,
        module: typescript.ModuleKind.ESNext,
        newLine: typescript.NewLineKind.LineFeed,
        target: typescript.ScriptTarget.ESNext,
        verbatimModuleSyntax: true,
      },
      reportDiagnostics: true,
      transformers: { before: [rewriteSpecifier] },
    });
    const errors = (emitted.diagnostics ?? []).filter(
      ({ category }) => category === typescript.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      const details = errors.map(({ messageText }) => (
        typescript.flattenDiagnosticMessageText(messageText, " ")
      )).join("; ");
      throw new Error(`package-cli.javascript-emit-failed: ${sourcePath}: ${details}`);
    }
    const outputPath = sourcePath.endsWith(".ts")
      ? `${sourcePath.slice(0, -3)}.js`
      : sourcePath;
    await writeFile(outputPath, emitted.outputText);
    if (sourcePath.endsWith(".ts")) await rm(sourcePath);
  }

  for (const manifestPath of packageManifests.sort()) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const rewritten = rewriteTypeScriptPathStrings(manifest);
    if (rewritten.changed) {
      await writeFile(manifestPath, `${JSON.stringify(rewritten.value, null, 2)}\n`);
    }
  }

  for (const root of authoredRoots) {
    await walk(root, async (path, entry) => {
      if (entry.isFile() && path.endsWith(".ts")) {
        throw new Error(`package-cli.javascript-emit-incomplete: retained ${path}`);
      }
    });
  }
}

function rewriteTypeScriptSpecifierTransformer(typescript) {
  return (context) => {
    const visit = (node) => {
      if (typescript.isStringLiteral(node) && node.text.endsWith(".ts")) {
        return typescript.factory.createStringLiteral(`${node.text.slice(0, -3)}.js`);
      }
      return typescript.visitEachChild(node, visit, context);
    };
    return (sourceFile) => typescript.visitNode(sourceFile, visit);
  };
}

function rewriteTypeScriptPathStrings(value) {
  if (typeof value === "string") {
    return value.endsWith(".ts")
      ? { value: `${value.slice(0, -3)}.js`, changed: true }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const rewritten = value.map((member) => {
      const result = rewriteTypeScriptPathStrings(member);
      changed ||= result.changed;
      return result.value;
    });
    return { value: rewritten, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const rewritten = {};
    for (const [key, member] of Object.entries(value)) {
      if (key === "types") {
        changed = true;
        continue;
      }
      const result = rewriteTypeScriptPathStrings(member);
      changed ||= result.changed;
      rewritten[key] = result.value;
    }
    return { value: rewritten, changed };
  }
  return { value, changed: false };
}

async function writePackageManifest(
  packagedRoot,
  sourceRoot,
  projectPackages,
  target,
  nativeArchitectures,
  web,
  sourceCommit,
  releaseVersion,
) {
  const versions = Object.freeze({ serialport: "13.0.0", usb: "2.15.0", ioctl: "2.0.2" });
  const nativeAddons = {};
  for (const [name, input] of Object.entries(target.nativeInputs)) {
    nativeAddons[name] = Object.freeze({
      version: versions[name],
      path: input.packaged,
      sha256: input.sha256 ?? await sha256(join(sourceRoot, input.source)),
      ...(nativeArchitectures?.[name] === undefined
        ? {}
        : { architectures: nativeArchitectures[name] }),
    });
  }
  const manifest = Object.freeze({
    format: "protodriver.cli-package/v1",
    sourceCommit,
    ...releaseManifestFields(releaseVersion),
    target: target.manifestTarget,
    node: target.node,
    projectPackages: Object.freeze(projectPackages.map((name) => `@protodriver/${name}`)),
    sourceRepresentation: target.sourceRepresentation
      ?? Object.freeze({ kind: "typescript", execution: "bundled-node-type-stripping" }),
    nativeAddons: Object.freeze(nativeAddons),
    retainedLuaVm: Object.freeze({ path: retainedVmInput.packaged, sha256: retainedVmInput.sha256 }),
    web: Object.freeze({
      root: "app/apps/web/dist",
      launcher: target.os === "win32" ? "bin/pdr-web.cmd" : "bin/pdr-web",
      offlineFilesChecked: web.offlineFilesChecked,
      sourceSha256: web.sourceSha256,
      assets: web.assets,
    }),
  });
  await writeFile(join(packagedRoot, "PACKAGE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function inspectMachOArchitectures(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength < 8) throw new Error(`package-cli.mach-o-invalid: ${path} is too short`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fatMagic = view.getUint32(0, false);
  if (fatMagic === 0xcafebabe) {
    const count = view.getUint32(4, false);
    if (count === 0 || 8 + count * 20 > bytes.byteLength) {
      throw new Error(`package-cli.mach-o-invalid: ${path} has an invalid universal header`);
    }
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
      architectures.push(machOCpuName(view.getUint32(8 + index * 20, false), path));
    }
    return Object.freeze(architectures);
  }
  if (view.getUint32(0, true) === 0xfeedfacf) {
    return Object.freeze([machOCpuName(view.getUint32(4, true), path)]);
  }
  throw new Error(`package-cli.mach-o-invalid: ${path} is not a 64-bit Mach-O binary`);
}

function machOCpuName(cpuType, path) {
  if (cpuType === 0x01000007) return "x86_64";
  if (cpuType === 0x0100000c) return "arm64";
  throw new Error(`package-cli.mach-o-invalid: ${path} has unsupported CPU type 0x${cpuType.toString(16)}`);
}

export async function inspectPeArchitecture(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`package-cli.pe-invalid: ${path} has no DOS header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset > bytes.byteLength - 6
      || view.getUint32(peOffset, false) !== 0x50450000) {
    throw new Error(`package-cli.pe-invalid: ${path} has no PE header`);
  }
  const machine = view.getUint16(peOffset + 4, true);
  if (machine === 0x8664) return "x86_64";
  if (machine === 0xaa64) return "arm64";
  throw new Error(
    `package-cli.pe-invalid: ${path} has unsupported machine 0x${machine.toString(16)}`,
  );
}

export async function verifyTargetNativeArchitectures(sourceRoot, target) {
  if (target.nativeFormat === "pe") {
    const architectures = {};
    for (const [name, input] of Object.entries(target.nativeInputs)) {
      const architecture = await inspectPeArchitecture(join(sourceRoot, input.source));
      if (architecture !== target.peArchitecture) {
        throw new Error(
          `package-cli.architecture-mismatch: ${name} has ${architecture}, expected ${target.peArchitecture}`,
        );
      }
      architectures[name] = Object.freeze([architecture]);
    }
    return Object.freeze(architectures);
  }
  if (target.nativeFormat !== "mach-o") return undefined;
  const serialport = await inspectMachOArchitectures(join(sourceRoot, target.nativeInputs.serialport.source));
  const usb = await inspectMachOArchitectures(join(sourceRoot, target.nativeInputs.usb.source));
  const ioctl = await inspectMachOArchitectures(join(sourceRoot, target.nativeInputs.ioctl.source));
  for (const [name, architectures] of [["serialport", serialport], ["usb", usb]]) {
    if (!architectures.includes(target.machOArchitecture)) {
      throw new Error(
        `package-cli.architecture-mismatch: ${name} has ${architectures.join(",")}, expected ${target.machOArchitecture}`,
      );
    }
  }
  if (ioctl.length !== 1 || ioctl[0] !== target.machOArchitecture) {
    throw new Error(
      `package-cli.architecture-mismatch: ioctl has ${ioctl.join(",")}, expected only ${target.machOArchitecture}`,
    );
  }
  return Object.freeze({ serialport, usb, ioctl });
}

async function verifyNodeRuntime(runtimeRoot, target) {
  const binary = join(runtimeRoot, target.runtimeBinarySource ?? "bin/node");
  const license = join(runtimeRoot, "LICENSE");
  await Promise.all([
    verifySha256(binary, target.node.binarySha256, "Node runtime binary"),
    verifySha256(license, target.node.licenseSha256, "Node runtime license"),
  ]);
  if (process.platform !== target.os || process.arch !== target.architecture) {
    if (target.nativeFormat !== "pe") {
      throw new Error(`package-cli.node-unexecutable: cannot verify ${target.id} on ${process.platform}-${process.arch}`);
    }
    const architecture = await inspectPeArchitecture(binary);
    if (architecture !== target.peArchitecture) {
      throw new Error(
        `package-cli.architecture-mismatch: Node runtime has ${architecture}, expected ${target.peArchitecture}`,
      );
    }
    return;
  }
  const result = await run(binary, [
    "--input-type=module",
    "--eval",
    "process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch}))",
  ]);
  const identity = JSON.parse(result.stdout);
  if (identity.version !== target.node.version
      || identity.platform !== target.os
      || identity.arch !== target.architecture) {
    throw new Error(`package-cli.node-mismatch: requested ${target.id}, observed ${JSON.stringify(identity)}`);
  }
}

async function verifyPinnedInput(sourceRoot, input) {
  await verifySha256(join(sourceRoot, input.source), input.sha256, input.source);
}

async function verifySha256(path, expected, subject) {
  const observed = await sha256(path);
  if (observed !== expected) {
    throw new Error(`package-cli.digest-mismatch: ${subject} expected ${expected}, observed ${observed}`);
  }
}

async function createNormalizedTar(scratch, outputPath, packageRootName) {
  if (process.platform === "darwin") {
    const listPath = `${outputPath}.files`;
    const entries = await archiveEntries(scratch, packageRootName);
    await writeFile(listPath, `${entries.join("\n")}\n`);
    try {
      await run("tar", darwinTarArguments({ outputPath, scratch, listPath }));
    } finally {
      await rm(listPath, { force: true });
    }
    return;
  }
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "--format=gnu",
    "-cf",
    outputPath,
    "-C",
    scratch,
    packageRootName,
  ]);
}

export function darwinTarArguments({ outputPath, scratch, listPath }) {
  return Object.freeze([
    "--format", "gnutar",
    "--uid", "0",
    "--gid", "0",
    "--uname", "root",
    "--gname", "root",
    "--no-recursion",
    "-cf", outputPath,
    "-C", scratch,
    "-T", listPath,
  ]);
}

async function archiveEntries(scratch, packageRootName) {
  const entries = [packageRootName];
  async function append(directory, relative) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const childRelative = `${relative}/${child.name}`;
      entries.push(childRelative);
      if (child.isDirectory()) await append(join(directory, child.name), childRelative);
    }
  }
  await append(join(scratch, packageRootName), packageRootName);
  return entries;
}

async function normalizeDarwinTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await lutimes(path, 0, 0);
    return;
  }
  if (info.isDirectory()) {
    const children = await readdir(path);
    children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const child of children) await normalizeDarwinTree(join(path, child));
    await chmod(path, 0o755);
    await utimes(path, 0, 0);
    return;
  }
  if (info.isFile()) {
    await chmod(path, (info.mode & 0o111) === 0 ? 0o644 : 0o755);
    await utimes(path, 0, 0);
  }
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function regularFileBytes(root) {
  let total = 0;
  await walk(root, async (path, entry) => {
    if (entry.isFile()) total += (await lstat(path)).size;
  });
  return total;
}

async function regularFileCount(root) {
  let total = 0;
  await walk(root, async (_path, entry) => {
    if (entry.isFile()) total += 1;
  });
  return total;
}

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory()) await walk(path, visit);
  }
}

async function assertFile(path, subject) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`package-cli.input-missing: ${subject} at ${path}`);
}

async function assertDirectory(path, subject) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`package-cli.input-missing: ${subject} at ${path}`);
}

async function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolvePromise(result);
      else reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? code})\n${result.stdout}${result.stderr}`));
    });
  });
}

function usage() {
  return "usage: node tools/package-cli.mjs --target TARGET --output DIRECTORY --web-build DIRECTORY --source-commit COMMIT [--release-version VERSION] [--node-runtime-root DIRECTORY]";
}

function parseArguments(argv) {
  let target;
  let nodeRuntimeRoot;
  let outputDirectory;
  let sourceCommit;
  let releaseVersion;
  let webBuildDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--target" || name === "--node-runtime-root" || name === "--output" || name === "--web-build" || name === "--source-commit" || name === "--release-version") && value !== undefined) {
      if (name === "--target") target = value;
      else if (name === "--node-runtime-root") nodeRuntimeRoot = value;
      else if (name === "--output") outputDirectory = value;
      else if (name === "--source-commit") sourceCommit = value;
      else if (name === "--release-version") releaseVersion = value;
      else webBuildDirectory = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (target === undefined || outputDirectory === undefined || sourceCommit === undefined || webBuildDirectory === undefined) {
    throw new Error(usage());
  }
  return { target, nodeRuntimeRoot, outputDirectory, sourceCommit, releaseVersion, webBuildDirectory };
}

export async function main(argv = process.argv.slice(2), build = buildCliPackage) {
  const options = parseArguments(argv);
  const result = await build({
    target: options.target,
    outputDirectory: options.outputDirectory,
    webBuildDirectory: options.webBuildDirectory,
    ...(options.nodeRuntimeRoot === undefined ? {} : { nodeRuntimeRoot: options.nodeRuntimeRoot }),
    sourceCommit: options.sourceCommit,
    releaseVersion: options.releaseVersion,
  });
  process.stdout.write(
    `${result.archivePath}\n`
    + `sha256:${result.archiveSha256}\n`
    + `unpacked regular-file bytes:${result.unpackedBytes}\n`
    + `files:${result.fileCount}\n`,
  );
}

if (await isMainModule(import.meta.url)) {
  await main();
}
