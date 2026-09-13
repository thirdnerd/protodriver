import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPackageStore } from "../src/package-storage.ts";

class FakeRequest extends EventTarget {
  result;
  error = null;
}

class FakeTransaction extends EventTarget {
  error = null;
  #done = false;
  #pending = 0;
  constructor(database) { super(); this.database = database; }
  objectStore() {
    const request = (operation) => {
      const source = new FakeRequest();
      this.#pending += 1;
      queueMicrotask(() => {
        if (this.#done) return;
        try {
          source.result = operation();
          source.dispatchEvent(new Event("success"));
          this.#pending -= 1;
          setTimeout(() => {
            if (this.#done || this.#pending !== 0) return;
            this.#done = true;
            this.dispatchEvent(new Event("complete"));
          }, 0);
        } catch (cause) {
          source.error = cause;
          this.error = cause;
          source.dispatchEvent(new Event("error"));
          this.#done = true;
          this.dispatchEvent(new Event("abort"));
        }
      });
      return source;
    };
    return {
      add: (value) => request(() => {
        if (this.database.quotaExceeded) throw new DOMException("full", "QuotaExceededError");
        const key = this.database.nextKey++;
        this.database.records.set(key, structuredClone(value));
        return key;
      }),
      get: (key) => request(() => {
        const value = this.database.records.get(key);
        return value === undefined ? undefined : structuredClone(value);
      }),
      getAllKeys: () => request(() => [...this.database.records.keys()]),
      getAll: () => request(() => [...this.database.records.values()].map((value) => structuredClone(value))),
      delete: (key) => request(() => { this.database.records.delete(key); }),
    };
  }
  abort() {
    if (this.#done) throw new DOMException("transaction already finished", "InvalidStateError");
    this.#done = true;
    this.dispatchEvent(new Event("abort"));
  }
}

class FakeDatabase {
  objectStoreNames = { contains: () => true };
  records = new Map();
  nextKey = 1;
  quotaExceeded = false;
  transaction() { return new FakeTransaction(this); }
}

class FakeIndexedDbFactory {
  database = new FakeDatabase();
  open() {
    const opening = new FakeRequest();
    opening.result = this.database;
    queueMicrotask(() => opening.dispatchEvent(new Event("success")));
    return opening;
  }
}

test("browser package persistence retains only cloned raw bytes and supports explicit removal", async () => {
  const factory = new FakeIndexedDbFactory();
  const store = new BrowserPackageStore(factory, "package-storage-control");
  const supplied = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0xaa);
  const id = await store.add(supplied);
  supplied[4] = 0xff;

  assert.equal(id, 1);
  assert.ok(factory.database.records.get(id) instanceof Uint8Array);
  assert.deepEqual([...factory.database.records.get(id)], [0x50, 0x4b, 0x03, 0x04, 0xaa]);
  assert.deepEqual(await store.list(), [{ id, byteLength: 5 }]);
  const firstRead = await store.read(id);
  firstRead[0] = 0;
  assert.deepEqual([...await store.read(id)], [0x50, 0x4b, 0x03, 0x04, 0xaa]);

  await store.remove(id);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read(id), null);
});

test("quota exhaustion is returned unchanged and never evicts an existing package", async () => {
  const factory = new FakeIndexedDbFactory();
  const store = new BrowserPackageStore(factory, "package-storage-quota-control");
  const retainedId = await store.add(Uint8Array.of(1, 2, 3));
  factory.database.quotaExceeded = true;

  await assert.rejects(
    store.add(Uint8Array.of(4, 5, 6)),
    (cause) => cause instanceof DOMException && cause.name === "QuotaExceededError",
  );
  assert.deepEqual(await store.list(), [{ id: retainedId, byteLength: 3 }]);
  assert.deepEqual([...await store.read(retainedId)], [1, 2, 3]);
});
