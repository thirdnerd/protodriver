const PACKAGES = "packages";

export interface StoredBrowserPackageSummary {
  readonly id: number;
  readonly byteLength: number;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.addEventListener("success", () => resolve(source.result), { once: true });
    source.addEventListener(
      "error",
      () => reject(source.error ?? new Error("IndexedDB package request failed")),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB package transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB package transaction failed")),
      { once: true },
    );
  });
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const opening = factory.open(name, 1);
  opening.addEventListener("upgradeneeded", () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains(PACKAGES)) {
      database.createObjectStore(PACKAGES, { autoIncrement: true });
    }
  });
  return await request(opening);
}

function storedBytes(value: unknown, id: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`browser.package-storage.invalid-record: stored package ${id} is not raw bytes`);
  }
  return Uint8Array.from(value);
}

function numericKey(key: IDBValidKey): number {
  if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 1) {
    throw new Error("browser.package-storage.invalid-key: IndexedDB did not return a positive integer key");
  }
  return key;
}

/** IndexedDB owns only raw package bytes; every verdict is recomputed by the worker. */
export class BrowserPackageStore {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, databaseName = "protodriver-imported-packages") {
    this.#database = openDatabase(factory, databaseName);
  }

  async add(bytes: Uint8Array): Promise<number> {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    try {
      const key = await request(transaction.objectStore(PACKAGES).add(Uint8Array.from(bytes)));
      await done;
      return numericKey(key);
    } catch (cause) {
      try {
        transaction.abort();
      } catch {
        // A quota or request failure may already have aborted the transaction.
      }
      await done.catch(() => undefined);
      throw cause;
    }
  }

  async list(): Promise<readonly StoredBrowserPackageSummary[]> {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(PACKAGES);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    if (keys.length !== values.length) {
      throw new Error("browser.package-storage.invalid-record: package keys and values differ in length");
    }
    return Object.freeze(keys.map((key, index) => {
      const id = numericKey(key);
      return Object.freeze({ id, byteLength: storedBytes(values[index], id).byteLength });
    }));
  }

  async read(id: number): Promise<Uint8Array | null> {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readonly");
    const done = transactionDone(transaction);
    const value = await request(transaction.objectStore(PACKAGES).get(id));
    await done;
    return value === undefined ? null : storedBytes(value, id);
  }

  async remove(id: number): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    await request(transaction.objectStore(PACKAGES).delete(id));
    await done;
  }
}

export const BROWSER_PACKAGE_OBJECT_STORE = PACKAGES;
