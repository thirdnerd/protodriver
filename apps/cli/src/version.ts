import { readFile } from "node:fs/promises";

/** The installed CLI lives at app/apps/cli/src; this reaches the archive root. */
const packagedManifest = new URL("../../../../PACKAGE-MANIFEST.json", import.meta.url);

export async function pdrVersion(manifestUrl: URL = packagedManifest): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(manifestUrl, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "pdr: not a released build (source commit unavailable)\n";
    }
    throw cause;
  }
  const manifest: unknown = JSON.parse(contents);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("PACKAGE-MANIFEST.json must be an object");
  }
  const record = manifest as Record<string, unknown>;
  const commit = record.sourceCommit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("PACKAGE-MANIFEST.json has no valid sourceCommit");
  }
  if (record.version === undefined) {
    return `pdr: not a released build (source commit ${commit})\n`;
  }
  if (typeof record.version !== "string" || !/^0\.(?:[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(record.version)) {
    throw new Error("PACKAGE-MANIFEST.json has no valid release version");
  }
  return `pdr ${record.version} (source commit ${commit})\n`;
}
