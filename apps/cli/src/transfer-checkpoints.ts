import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  TransferCheckpoint,
  TransferCheckpointClaim,
  TransferCheckpointStore,
} from "@protodriver/contracts";
import {
  TransferCheckpointError,
  validateTransferCheckpoint,
} from "@protodriver/transfer-runtime/transfer-checkpoint";

interface HeldClaim {
  readonly token: string;
  readonly owner: string;
  readonly lockPath: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

function checkpointError(
  code: "transfer.checkpoint-held" | "transfer.checkpoint-conflict" | "transfer.checkpoint-invalid",
  id: string,
  message: string,
): TransferCheckpointError {
  return new TransferCheckpointError({ code, declarationPath: `checkpoints.${id}`, message });
}

function leaf(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw checkpointError("transfer.checkpoint-invalid", id, "checkpoint id is not a portable leaf name");
  }
  return id;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Node durable store: exclusive process claim plus fsynced atomic replacement. */
export class NodeTransferCheckpointStore implements TransferCheckpointStore {
  readonly #directory: string;
  readonly #claims = new Map<string, HeldClaim>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  async create(checkpoint: TransferCheckpoint): Promise<void> {
    validateTransferCheckpoint(checkpoint);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = this.#checkpointPath(checkpoint.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      // link is the exclusive commit: it publishes a fully fsynced inode and
      // fails rather than replacing an existing checkpoint.
      await link(temporary, path);
    } catch (cause) {
      if (isCode(cause, "EEXIST")) throw checkpointError("transfer.checkpoint-conflict", checkpoint.id, "checkpoint already exists");
      throw cause;
    } finally {
      await handle?.close();
      try {
        await unlink(temporary);
      } catch (cause) {
        if (!isCode(cause, "ENOENT")) throw cause;
      }
    }
    await fsyncDirectory(this.#directory);
  }

  async read(id: string): Promise<TransferCheckpoint | null> {
    try {
      const value = JSON.parse(await readFile(this.#checkpointPath(id), "utf8")) as TransferCheckpoint;
      return Object.freeze(structuredClone(validateTransferCheckpoint(value)));
    } catch (cause) {
      if (isCode(cause, "ENOENT")) return null;
      if (cause instanceof TransferCheckpointError) throw cause;
      throw checkpointError("transfer.checkpoint-invalid", id, `checkpoint cannot be decoded: ${String(cause)}`);
    }
  }

  async claim(id: string, owner: string): Promise<TransferCheckpointClaim> {
    const checkpoint = await this.read(id);
    if (checkpoint === null) throw checkpointError("transfer.checkpoint-invalid", id, "checkpoint does not exist");
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const lockPath = this.#lockPath(id);
    const token = randomUUID();
    let handle;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, owner, token })}\n`, "utf8");
        await handle.sync();
        break;
      } catch (cause) {
        await handle?.close();
        handle = undefined;
        if (!isCode(cause, "EEXIST")) throw cause;
        if (attempt === 0 && await removeDeadOwnerLock(lockPath)) continue;
        throw checkpointError("transfer.checkpoint-held", id, "checkpoint is already claimed by another live process");
      }
    }
    if (handle === undefined) throw checkpointError("transfer.checkpoint-held", id, "checkpoint claim could not be acquired");
    this.#claims.set(token, { token, owner, lockPath, handle });
    return Object.freeze({ checkpoint, owner, token });
  }

  async commit(claim: TransferCheckpointClaim, checkpoint: TransferCheckpoint): Promise<TransferCheckpointClaim> {
    validateTransferCheckpoint(checkpoint);
    const held = this.#claims.get(claim.token);
    const current = await this.read(claim.checkpoint.id);
    if (held === undefined
        || held.owner !== claim.owner
        || checkpoint.id !== claim.checkpoint.id
        || current === null
        || current.revision !== claim.checkpoint.revision
        || checkpoint.revision !== current.revision + 1) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim or revision is stale");
    }

    const target = this.#checkpointPath(checkpoint.id);
    const temporary = `${target}.${claim.token}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await fsyncDirectory(this.#directory);
    return Object.freeze({ checkpoint: Object.freeze(structuredClone(checkpoint)), owner: claim.owner, token: claim.token });
  }

  async release(claim: TransferCheckpointClaim): Promise<void> {
    const held = this.#claims.get(claim.token);
    if (held === undefined || held.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim is stale");
    }
    this.#claims.delete(claim.token);
    await held.handle.close();
    try {
      await unlink(held.lockPath);
    } catch (cause) {
      if (!isCode(cause, "ENOENT")) throw cause;
    }
    await fsyncDirectory(this.#directory);
  }

  async complete(claim: TransferCheckpointClaim): Promise<void> {
    const held = this.#claims.get(claim.token);
    if (held === undefined || held.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim is stale");
    }
    await held.handle.close();
    await unlink(this.#checkpointPath(claim.checkpoint.id));
    await unlink(held.lockPath);
    this.#claims.delete(claim.token);
    await fsyncDirectory(this.#directory);
  }

  #checkpointPath(id: string): string {
    return join(this.#directory, `${leaf(id)}.json`);
  }

  #lockPath(id: string): string {
    return join(this.#directory, `${leaf(id)}.lock`);
  }
}

function isCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

async function removeDeadOwnerLock(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { readonly pid?: number };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return false;
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (cause) {
      if (!isCode(cause, "ESRCH")) return false;
      await unlink(path);
      return true;
    }
  } catch {
    return false;
  }
}
