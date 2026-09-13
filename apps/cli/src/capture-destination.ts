import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

import type {
  HostByteSink,
  HostCaptureDestination,
  PdrError,
  ResourceRegistrar,
  ResourceId,
  SessionId,
} from "@protodriver/contracts";

import { assertCapturePartName } from "../../../packages/core/src/capture-path.ts";

export type CaptureDestinationRule = "symlink" | "already-exists" | "closed";

export class CaptureDestinationError extends Error {
  readonly rule: CaptureDestinationRule;

  constructor(name: string, rule: CaptureDestinationRule) {
    super(`capture part ${JSON.stringify(name)} rejected by ${rule} rule`);
    this.name = "CaptureDestinationError";
    this.rule = rule;
  }
}

class NodeFileSink implements HostByteSink {
  readonly #handle: FileHandle;
  #closed = false;

  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("capture part is closed");
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesWritten } = await this.#handle.write(
        data,
        offset,
        data.byteLength - offset,
        null,
      );
      if (bytesWritten === 0) throw new Error("capture part write made no progress");
      offset += bytesWritten;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

export interface NodeCaptureDestinationOptions {
  readonly directory: string;
  readonly registrar: ResourceRegistrar;
  readonly sessionId: SessionId;
}

/** Node directory-backed implementation of the pluggable destination. */
export class NodeCaptureDestination implements HostCaptureDestination {
  readonly #directory: string;
  readonly #registrar: ResourceRegistrar;
  readonly #sessionId: SessionId;
  readonly #sinks = new Set<NodeFileSink>();
  #state: "open" | "committed" | "aborted" = "open";

  private constructor(
    directory: string,
    registrar: ResourceRegistrar,
    sessionId: SessionId,
  ) {
    this.#directory = directory;
    this.#registrar = registrar;
    this.#sessionId = sessionId;
  }

  static async create(options: NodeCaptureDestinationOptions): Promise<NodeCaptureDestination> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(options.directory);
    return new NodeCaptureDestination(directory, options.registrar, options.sessionId);
  }

  async openPart(
    name: string,
    _options?: { readonly contentType?: string },
  ): Promise<ResourceId> {
    assertCapturePartName(name);
    if (this.#state !== "open") throw new CaptureDestinationError(name, "closed");
    const path = resolve(this.#directory, name);

    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink()) throw new CaptureDestinationError(name, "symlink");
      throw new CaptureDestinationError(name, "already-exists");
    } catch (error) {
      if (error instanceof CaptureDestinationError) throw error;
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const raced = await lstat(path);
        throw new CaptureDestinationError(
          name,
          raced.isSymbolicLink() ? "symlink" : "already-exists",
        );
      }
      throw error;
    }

    const sink = new NodeFileSink(handle);
    this.#sinks.add(sink);
    try {
      return await this.#registrar.registerSink(sink, {
        kind: "session",
        sessionId: this.#sessionId,
      });
    } catch (error) {
      this.#sinks.delete(sink);
      await sink.close();
      await unlink(path);
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#state !== "open") return;
    await this.#closeParts();
    this.#state = "committed";
  }

  async abort(_error: PdrError): Promise<void> {
    if (this.#state !== "open") return;
    await this.#closeParts();
    this.#state = "aborted";
  }

  async #closeParts(): Promise<void> {
    const settled = await Promise.allSettled([...this.#sinks].map(async (sink) => sink.close()));
    this.#sinks.clear();
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
