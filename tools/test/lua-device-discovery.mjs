import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const BOOTSTRAP = Object.freeze({
  packageFormat: "supported",
  generatorContract: "supported",
});

/** Discover every repository-owned authoritative Lua device source set. */
export async function discoverLuaDeviceModules(repositoryRoot) {
  const corpusDirectory = resolve(repositoryRoot, "corpus");
  const modulesByName = new Map();

  for (const entry of await readdir(corpusDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDirectory = resolve(corpusDirectory, entry.name);
    const entrySource = resolve(sourceDirectory, "device.lua");
    if (!await isFile(entrySource)) continue;
    if (modulesByName.has(entry.name)) {
      throw new Error(`lua-device-discovery.duplicate-module: ${entry.name}`);
    }
    modulesByName.set(entry.name, Object.freeze({
      name: entry.name,
      sourceDirectory,
      entrySource,
    }));
  }

  const modules = [...modulesByName.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (modules.length === 0) {
    throw new Error("lua-device-discovery.empty-population: no authoritative device.lua source sets discovered");
  }
  return modules;
}

/** Snapshot one discovered source set in the shared authored-Lua candidate shape. */
export async function loadDiscoveredLuaSourceSet(deviceModule) {
  const files = (await readdir(deviceModule.sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
    .map((entry) => entry.name)
    .sort();
  if (!files.includes("device.lua")) {
    throw new Error(`lua-device-discovery.entry-missing: ${deviceModule.name} has no device.lua`);
  }
  const members = await Promise.all(files.map(async (logicalName) => Object.freeze({
    logicalName,
    sourceBytes: new Uint8Array(await readFile(resolve(deviceModule.sourceDirectory, logicalName))),
  })));
  return Object.freeze({ bootstrap: BOOTSTRAP, members: Object.freeze(members) });
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}
