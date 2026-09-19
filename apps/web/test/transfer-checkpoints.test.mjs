import assert from "node:assert/strict";
import test from "node:test";

import { BrowserTransferCheckpointStore } from "../src/transfer-checkpoints.ts";

class FakeRequest extends EventTarget {
  result;
  error = null;
}

class FakeTransaction extends EventTarget {
  error = null;
  #done = false;
  #pending = 0;
  constructor(records) { super(); this.records = records; }
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
        if (this.records.has(value.id)) throw new DOMException("duplicate", "ConstraintError");
        this.records.set(value.id, structuredClone(value));
      }),
      get: (id) => request(() => {
        const value = this.records.get(id);
        return value === undefined ? undefined : structuredClone(value);
      }),
      put: (value) => request(() => { this.records.set(value.id, structuredClone(value)); }),
      delete: (id) => request(() => { this.records.delete(id); }),
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
  transaction() { return new FakeTransaction(this.records); }
}

class FakeIndexedDbFactory {
  database = new FakeDatabase();
  open() {
    const request = new FakeRequest();
    request.result = this.database;
    queueMicrotask(() => request.dispatchEvent(new Event("success")));
    return request;
  }
}

class FakeLockManager {
  held = new Set();
  async request(name, options, callback) {
    assert.equal(options.mode, "exclusive");
    assert.equal(options.ifAvailable, true);
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); }
    finally { this.held.delete(name); }
  }
}

function checkpoint(revision = 0) {
  return {
    formatVersion: 2,
    id: "non-hardware-browser-checkpoint",
    revision,
    manifestHash: "11".repeat(32),
    definitionHash: "22".repeat(32),
    modeId: "bootloader",
    direction: "hostToDevice",
    source: { algorithm: "sha256", digest: "33".repeat(32), byteLength: 1024 },
    identity: { stableKeyAssurance: "serial-number", stableKey: "serial:conformance", generation: "generation-7" },
    phase: "preparing",
    confirmedRanges: revision === 0 ? [] : [{ targetOffset: 0, length: 512 }],
    finalization: "repeatable",
  };
}

test("browser checkpoint ownership uses one Web Lock while IndexedDB revisions remain compare-and-swap", async () => {
  const factory = new FakeIndexedDbFactory();
  const locks = new FakeLockManager();
  const firstStore = new BrowserTransferCheckpointStore(factory, locks, "non-hardware-conformance");
  const secondStore = new BrowserTransferCheckpointStore(factory, locks, "non-hardware-conformance");
  await firstStore.create(checkpoint());
  const first = await firstStore.claim(checkpoint().id, "tab-a");
  await assert.rejects(
    secondStore.claim(checkpoint().id, "tab-b"),
    (error) => error.diagnostic?.code === "transfer.checkpoint-held",
  );
  const committed = await firstStore.commit(first, checkpoint(1));
  await firstStore.release(committed);
  const second = await secondStore.claim(checkpoint().id, "tab-b");
  assert.equal(second.checkpoint.revision, 1);
  assert.deepEqual(second.checkpoint.confirmedRanges, [{ targetOffset: 0, length: 512 }]);
  await secondStore.complete(second);
  assert.equal(await secondStore.read(checkpoint().id), null);
});
