import { DARWIN_PACKAGE_TARGETS } from "./darwin-targets.mjs";
import { LINUX_PACKAGE_TARGETS } from "./linux-targets.mjs";
import { WIN32_PACKAGE_TARGETS } from "./win32-targets.mjs";
import { validateReleaseVersion } from "./release-version.mjs";

export const CLI_PACKAGE_TARGETS = Object.freeze({
  ...LINUX_PACKAGE_TARGETS,
  ...DARWIN_PACKAGE_TARGETS,
  ...WIN32_PACKAGE_TARGETS,
});

export function packageArchiveName(target, releaseVersion) {
  if (target.archiveFormat !== "tar.gz" && target.archiveFormat !== "zip") {
    throw new Error(`cli-package.archive-format-unknown: ${JSON.stringify(target.archiveFormat)}`);
  }
  return releaseVersion === undefined
    ? `${target.packageRootName}.${target.archiveFormat}`
    : `protodriver-${validateReleaseVersion(releaseVersion)}-${target.id}.${target.archiveFormat}`;
}

export function packageTarget(id) {
  const target = CLI_PACKAGE_TARGETS[id];
  if (target === undefined) {
    throw new Error(
      `cli-package.target-unknown: ${JSON.stringify(id)}; expected ${Object.keys(CLI_PACKAGE_TARGETS).join(" or ")}`,
    );
  }
  return target;
}

export function hostPackageTarget({
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const id = `${platform}-${architecture}`;
  const target = CLI_PACKAGE_TARGETS[id];
  if (target === undefined) {
    throw new Error(
      `cli-package.host-unsupported: ${id}; supported native hosts are ${Object.keys(CLI_PACKAGE_TARGETS).join(", ")}`,
    );
  }
  return target;
}

export function nativePackageTarget(id, host = {}) {
  const target = packageTarget(id);
  const native = hostPackageTarget(host);
  if (target.id !== native.id) {
    throw new Error(
      `cli-package.target-not-native: requested ${target.id}, host is ${native.id}; the one-command build always runs its package smoke`,
    );
  }
  return target;
}
