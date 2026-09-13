#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";

const executeFile = promisify(execFile);
const restrictionPath = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const restrictionKey = "kernel.apparmor_restrict_unprivileged_userns";

async function probeBubblewrap() {
  // This includes the network namespace. Do not replace it with --share-net:
  // the actual package smoke must still prove isolation from the host network.
  await executeFile("/usr/bin/bwrap", ["--unshare-all", "--ro-bind", "/", "/", "/usr/bin/true"]);
}

async function readRestriction() {
  return (await readFile(restrictionPath, "utf8")).trim();
}

async function disableRestriction() {
  await executeFile("sudo", ["sysctl", "-w", `${restrictionKey}=0`]);
}

async function markRestore() {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "restore_apparmor=true\n");
}

function failure(cause) {
  return cause?.stderr?.trim() || cause?.message || String(cause);
}

export async function prepareLinuxSandbox({
  probe = probeBubblewrap,
  read = readRestriction,
  disable = disableRestriction,
  restoreMarker = markRestore,
  report = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  try {
    await probe();
    report("linux-sandbox: bwrap --unshare-all probe passed; package smoke remains required");
    return Object.freeze({ apparmorChanged: false });
  } catch (firstCause) {
    const setting = await read().catch(() => "unavailable");
    report(`linux-sandbox: bwrap --unshare-all probe failed: ${failure(firstCause)}; AppArmor userns restriction=${setting}`);
    if (setting !== "1") {
      throw new Error(
        "linux-sandbox.unavailable: cannot run isolated package smoke; AppArmor restriction is not enabled, so inspect runner namespace permissions",
        { cause: firstCause },
      );
    }
    try {
      await disable();
    } catch (cause) {
      throw new Error(`linux-sandbox.apparmor-adjustment-failed: ${failure(cause)}; cannot run isolated package smoke`, { cause });
    }
    await restoreMarker();
    try {
      await probe();
    } catch (cause) {
      throw new Error(
        `linux-sandbox.unavailable: bwrap --unshare-all still fails after temporarily disabling AppArmor userns restriction: ${failure(cause)}; cannot verify package smoke on this runner`,
        { cause },
      );
    }
    report("linux-sandbox: bwrap --unshare-all passed after temporary AppArmor adjustment; the full package smoke still runs unchanged");
    return Object.freeze({ apparmorChanged: true });
  }
}

if (await isMainModule(import.meta.url)) await prepareLinuxSandbox();
