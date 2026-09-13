import type {
  TransferCheckpoint,
  TransferCheckpointClaim,
  TransferCheckpointStore,
} from "@protodriver/contracts";
import {
  TransferCheckpointError,
  validateTransferCheckpoint,
} from "@protodriver/transfer-runtime/transfer-checkpoint";

const CHECKPOINTS = "checkpoints";

function checkpointError(
  code: "transfer.checkpoint-held" | "transfer.checkpoint-conflict" | "transfer.checkpoint-invalid",
  id: string,
  message: string,
): TransferCheckpointError {
  return new TransferCheckpointError({ code, declarationPath: `checkpoints.${id}`, message });
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.addEventListener("success", () => resolve(source.result), { once: true });
    source.addEventListener("error", () => reject(source.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const opening = factory.open(name, 1);
  opening.addEventListener("upgradeneeded", () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains(CHECKPOINTS)) database.createObjectStore(CHECKPOINTS, { keyPath: "id" });
  });
  return await request(opening);
}

interface HeldBrowserClaim {
  readonly owner: string;
  readonly token: string;
  readonly releaseLock: () => void;
  readonly done: Promise<void>;
}

/** Browser durable store: Web Locks own live claims; IDB owns atomic records. */
export class BrowserTransferCheckpointStore implements TransferCheckpointStore {
  readonly #database: Promise<IDBDatabase>;
  readonly #locks: LockManager;
  readonly #databaseName: string;
  readonly #claims = new Map<string, HeldBrowserClaim>();

  constructor(factory: IDBFactory, locks: LockManager, databaseName = "protodriver-transfer-checkpoints") {
    this.#database = openDatabase(factory, databaseName);
    this.#locks = locks;
    this.#databaseName = databaseName;
  }

  async create(checkpoint: TransferCheckpoint): Promise<void> {
    validateTransferCheckpoint(checkpoint);
    const database = await this.#database;
    const transaction = database.transaction(CHECKPOINTS, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    try {
      await request(transaction.objectStore(CHECKPOINTS).add(structuredClone(checkpoint)));
      await done;
    } catch (cause) {
      try {
        transaction.abort();
      } catch {
        // The failed request may already have aborted the transaction.
      }
      await done.catch(() => undefined);
      if (cause instanceof DOMException && cause.name === "ConstraintError") {
        throw checkpointError("transfer.checkpoint-conflict", checkpoint.id, "checkpoint already exists");
      }
      throw cause;
    }
  }

  async read(id: string): Promise<TransferCheckpoint | null> {
    const database = await this.#database;
    const transaction = database.transaction(CHECKPOINTS, "readonly");
    const done = transactionDone(transaction);
    const value = await request(transaction.objectStore(CHECKPOINTS).get(id)) as TransferCheckpoint | undefined;
    await done;
    return value === undefined ? null : Object.freeze(structuredClone(validateTransferCheckpoint(value)));
  }

  async claim(id: string, owner: string): Promise<TransferCheckpointClaim> {
    const token = crypto.randomUUID();
    let announce: (() => void) | undefined;
    let refuse: ((cause: unknown) => void) | undefined;
    const acquired = new Promise<void>((resolve, reject) => { announce = resolve; refuse = reject; });
    let releaseLock: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    const done = this.#locks.request(
      `${this.#databaseName}:checkpoint:${id}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          refuse?.(checkpointError("transfer.checkpoint-held", id, "checkpoint is already claimed by another live tab"));
          return;
        }
        announce?.();
        await held;
      },
    );
    void done.catch((cause) => refuse?.(cause));
    await acquired;
    const checkpoint = await this.read(id);
    if (checkpoint === null) {
      releaseLock?.();
      await done;
      throw checkpointError("transfer.checkpoint-invalid", id, "checkpoint does not exist");
    }
    this.#claims.set(token, { owner, token, releaseLock: releaseLock!, done });
    return Object.freeze({ checkpoint, owner, token });
  }

  async commit(claim: TransferCheckpointClaim, checkpoint: TransferCheckpoint): Promise<TransferCheckpointClaim> {
    validateTransferCheckpoint(checkpoint);
    const database = await this.#database;
    const held = this.#claims.get(claim.token);
    if (held === undefined || held.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim is stale");
    }
    const transaction = database.transaction(CHECKPOINTS, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    const checkpoints = transaction.objectStore(CHECKPOINTS);
    const current = await request(checkpoints.get(claim.checkpoint.id)) as TransferCheckpoint | undefined;
    if (current === undefined
        || current.revision !== claim.checkpoint.revision
        || checkpoint.id !== claim.checkpoint.id
        || checkpoint.revision !== current.revision + 1) {
      transaction.abort();
      await done.catch(() => undefined);
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim or revision is stale");
    }
    await request(checkpoints.put(structuredClone(checkpoint)));
    await done;
    return Object.freeze({ checkpoint: Object.freeze(structuredClone(checkpoint)), owner: claim.owner, token: claim.token });
  }

  async release(claim: TransferCheckpointClaim): Promise<void> {
    const held = this.#claims.get(claim.token);
    if (held === undefined || held.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim is stale");
    }
    this.#claims.delete(claim.token);
    held.releaseLock();
    await held.done;
  }

  async complete(claim: TransferCheckpointClaim): Promise<void> {
    const held = this.#claims.get(claim.token);
    if (held === undefined || held.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", claim.checkpoint.id, "checkpoint claim is stale");
    }
    const database = await this.#database;
    const transaction = database.transaction(CHECKPOINTS, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    await request(transaction.objectStore(CHECKPOINTS).delete(claim.checkpoint.id));
    await done;
    await this.release(claim);
  }
}
