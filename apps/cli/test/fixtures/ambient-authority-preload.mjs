import childProcess from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";
import { threadId } from "node:worker_threads";

const PREFIX = "PDR_AMBIENT_OBSERVATION ";

function observe(kind, operation, details = {}) {
  const phase = process.env.PDR_AMBIENT_PHASE;
  if (phase === undefined || !(phase === "control" || phase.startsWith("load:"))) return;
  process.stderr.write(`${PREFIX}${JSON.stringify({ kind, operation, phase, threadId, ...details })}\n`);
}

function pathTarget(value) {
  return value instanceof URL ? value.href
    : typeof value === "string" || Buffer.isBuffer(value) ? String(value)
    : `<${value?.constructor?.name ?? typeof value}>`;
}

function wrapMethods(owner, names, kind, details = () => ({})) {
  for (const name of names) {
    const original = owner[name];
    if (typeof original !== "function") continue;
    owner[name] = function ambientAuthorityInstrument(...args) {
      observe(kind, name, details(args));
      return Reflect.apply(original, this, args);
    };
  }
}

const filesystemMethods = [
  "access", "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown",
  "link", "lstat", "lutimes", "mkdir", "mkdtemp", "open", "opendir", "readFile",
  "readdir", "readlink", "realpath", "rename", "rm", "rmdir", "stat", "statfs",
  "symlink", "truncate", "unlink", "utimes", "watch", "writeFile",
];
wrapMethods(fsPromises, filesystemMethods, "filesystem", (args) => ({ target: pathTarget(args[0]) }));
wrapMethods(fs, filesystemMethods, "filesystem", (args) => ({ target: pathTarget(args[0]) }));
for (const name of filesystemMethods.map((method) => `${method}Sync`)) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function ambientAuthoritySyncFilesystem(...args) {
    const caller = (new Error().stack?.split("\n").slice(2) ?? []).find((line) => (
      !line.includes("ambient-authority-preload.mjs")
      && !line.includes("node:fs:")
      && !line.includes("node:internal/fs/")
    )) ?? "";
    // The test executes TypeScript directly, so worker bootstrap obtains the
    // host's already-authored modules through Node's loader. This boundary
    // observes application calls after bootstrap, not the module loader itself.
    if (!caller.includes("node:internal/modules/esm/")
        && !caller.includes("node:internal/modules/typescript")) {
      observe("filesystem", name, { target: pathTarget(args[0]) });
    }
    return Reflect.apply(original, this, args);
  };
}

wrapMethods(childProcess, [
  "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
], "subprocess", (args) => ({ target: String(args[0]) }));

wrapMethods(net, ["connect", "createConnection"], "network");
wrapMethods(net.Socket.prototype, ["connect"], "network");
wrapMethods(http, ["get", "request"], "network");
wrapMethods(https, ["get", "request"], "network");
wrapMethods(tls, ["connect"], "network");
wrapMethods(dns, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny"], "network");
wrapMethods(dnsPromises, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny"], "network");

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function ambientAuthorityFetch(input, init) {
    observe("network", "fetch", { target: String(input) });
    return Reflect.apply(originalFetch, this, [input, init]);
  };
}
if (typeof process.execve === "function") {
  const originalExecve = process.execve;
  process.execve = function ambientAuthorityExecve(file, args, env) {
    observe("subprocess", "execve", { target: String(file) });
    return Reflect.apply(originalExecve, this, [file, args, env]);
  };
}

diagnosticsChannel.channel("tracing:module.import:asyncStart").subscribe(({ id, parentURL }) => {
  // `--import` itself is implemented as an internal import with no parent. A
  // source-level import() has the originating module URL that this control pins.
  if (parentURL === undefined) return;
  observe("dynamic-import", "import", { target: String(id), parentURL: String(parentURL) });
});

syncBuiltinESMExports();
