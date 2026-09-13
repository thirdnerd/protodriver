import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CaptureBlobRef } from "@protodriver/contracts";

import { assertCapturePartName } from "../../../../packages/core/src/capture-path.ts";

export type CaptureSidecarRule =
  | "symlink"
  | "outside-directory"
  | "truncated";

export class CaptureSidecarError extends Error {
  readonly rule: CaptureSidecarRule;

  constructor(file: string, rule: CaptureSidecarRule) {
    super(`capture sidecar ${JSON.stringify(file)} rejected by ${rule} rule`);
    this.name = "CaptureSidecarError";
    this.rule = rule;
  }
}

/** Resolves one sidecar relative to its capture record stream. */
export async function resolveCaptureSidecar(
  capturePath: string,
  reference: CaptureBlobRef,
): Promise<Uint8Array> {
  assertCapturePartName(reference.file);
  const directory = await realpath(dirname(capturePath));
  const candidate = join(directory, reference.file);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new CaptureSidecarError(reference.file, "symlink");
  }
  const resolved = await realpath(candidate);
  const fromDirectory = relative(directory, resolved);
  if (fromDirectory === ".." || fromDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || isAbsolute(fromDirectory)) {
    throw new CaptureSidecarError(reference.file, "outside-directory");
  }
  if (reference.offset + reference.length > metadata.size) {
    throw new CaptureSidecarError(reference.file, "truncated");
  }

  const handle = await open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const bytes = new Uint8Array(reference.length);
  try {
    let read = 0;
    while (read < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        read,
        bytes.byteLength - read,
        reference.offset + read,
      );
      if (result.bytesRead === 0) {
        throw new CaptureSidecarError(reference.file, "truncated");
      }
      read += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  return bytes;
}
