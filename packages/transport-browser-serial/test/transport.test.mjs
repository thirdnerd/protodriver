import assert from "node:assert/strict";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { ReceiveTerminatedError } from "../../core/src/ingress.ts";
import {
  BrowserSerialHalfDuplexError,
  BrowserSerialOpenError,
  BrowserSerialPortHeldError,
  BrowserSerialTransport,
  drainBrowserSerialUntilQuiet,
} from "../src/index.ts";

const identity = {
  transport: "serial",
  vendorId: 0x1a86,
  productId: 0x7523,
  stableKeyAssurance: "none",
};

const LINE = Object.freeze({
  baudRate: 57_600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
});
const ALTERNATE_LINE = Object.freeze({
  baudRate: 115_200,
  dataBits: 7,
  parity: "odd",
  stopBits: 2,
  flowControl: "hardware",
});
const NO_LIFECYCLE_DELAY = Object.freeze({
  openingDrainQuietMs: 0,
  postTerminationSilence: Object.freeze({
    minimumMs: 0,
    afterAbnormalTermination: false,
    afterModeExit: false,
  }),
});
const TRANSFER_LIFECYCLE = Object.freeze({
  openingDrainQuietMs: 0,
  postTerminationSilence: Object.freeze({
    minimumMs: 3_000,
    afterAbnormalTermination: true,
    afterModeExit: true,
  }),
});

class FakeWebSerialPort extends EventTarget {
  readable = null;
  writable = null;
  connected = true;
  writes = [];
  events = [];
  openError;
  openCalls = 0;
  openOptions;
  #readController;

  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }

  async open(options) {
    this.openCalls += 1;
    this.openOptions = options;
    if (this.openError !== undefined) throw this.openError;
    this.readable = new ReadableStream({
      start: (controller) => { this.#readController = controller; },
      cancel: () => { this.events.push("reader-cancel"); },
    });
    this.writable = new WritableStream({
      write: (bytes) => { this.writes.push(Uint8Array.from(bytes)); },
    });
  }

  async close() {
    assert.equal(this.readable?.locked, false, "read lock must be released before close");
    assert.equal(this.writable?.locked, false, "write lock must be released before close");
    this.events.push("port-close");
    this.readable = null;
    this.writable = null;
  }

  deliver(bytes) {
    this.#readController.enqueue(Uint8Array.from(bytes));
  }

  disconnect() {
    this.connected = false;
    this.#readController.error(new DOMException("device removed", "NetworkError"));
    this.dispatchEvent(new Event("disconnect"));
  }
}

class FakeLockManager {
  held = new Set();

  async request(name, _options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

async function openFake(clock, port = new FakeWebSerialPort(), protocolDuplex = "half-duplex") {
  const connection = await new BrowserSerialTransport({ clock }).open({
    port,
    profileId: "device-1.serial",
    modeId: "normal",
    protocolDuplex,
    identity,
    line: LINE,
    lifecycle: NO_LIFECYCLE_DELAY,
  });
  return { port, connection };
}

test("Web Serial receives every declared standard line parameter", async () => {
  const port = new FakeWebSerialPort();
  const connection = await new BrowserSerialTransport({ clock: new VirtualClock() }).open({
    port,
    profileId: "alternate.serial",
    modeId: "alternate",
    protocolDuplex: "half-duplex",
    identity,
    line: ALTERNATE_LINE,
    lifecycle: NO_LIFECYCLE_DELAY,
  });
  assert.deepEqual(port.openOptions, {
    baudRate: 115_200,
    dataBits: 7,
    stopBits: 2,
    parity: "odd",
    flowControl: "hardware",
    bufferSize: 64 * 1024,
  });
  await connection.close();
});

test("initial drain waits through emptiness and discards a delayed stale delivery", async () => {
  const clock = new VirtualClock();
  const port = new FakeWebSerialPort();
  await port.open();
  const draining = drainBrowserSerialUntilQuiet({
    port,
    clock,
    quietWindowMs: 300,
    maximumDiscardedBytes: 4_096,
  });

  await clock.advance(20_000);
  port.deliver(Uint8Array.of(0x57, 0x40, 0xe7, 0x11, 0x40, 0x04, 0x40, 0xfe));
  await new Promise((resolve) => setImmediate(resolve));
  await clock.advance(300_000);
  await draining;
  const reader = port.readable.getReader();
  const fresh = Uint8Array.of(0xa5);
  const next = reader.read();
  port.deliver(fresh);
  assert.deepEqual((await next).value, fresh, "the stale delivery must not survive the drain");
  reader.releaseLock();
  assert.equal(port.readable.locked, false);
});

test("browser transport preserves arbitrary chunks and cancels, unlocks, then closes", async () => {
  const clock = new VirtualClock();
  const { port, connection } = await openFake(clock);
  const channel = connection.channels[0];
  const diagnostic = channel.observe().records[Symbol.asyncIterator]();
  const lease = await channel.acquire("protocol");

  assert.deepEqual(port.openOptions, {
    baudRate: 57_600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    bufferSize: 64 * 1024,
  });

  const write = await lease.write(Uint8Array.of(0x50, 0x53));
  assert.equal(write.outcome.kind, "accepted-by-platform");
  assert.deepEqual(port.writes, [Uint8Array.of(0x50, 0x53)]);
  assert.equal((await diagnostic.next()).value.direction, "tx");

  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pending = incoming.next();
  await assert.rejects(
    lease.write(Uint8Array.of(0x06)),
    (error) => error instanceof BrowserSerialHalfDuplexError,
  );
  port.deliver(Uint8Array.of(1, 4, 5));
  assert.deepEqual((await pending).value.bytes, Uint8Array.of(1, 4, 5));
  await lease.release();
  await connection.close();
  assert.deepEqual(port.events, ["reader-cancel", "port-close"]);
});

test("full-duplex browser protocol lease writes while authoritative reception is armed", async () => {
  const clock = new VirtualClock();
  const port = new FakeWebSerialPort();
  const { connection } = await openFake(clock, port, "full-duplex");
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  const receipt = await lease.write(Uint8Array.of(0xa5, 0x5a));
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  assert.deepEqual(port.writes, [Uint8Array.of(0xa5, 0x5a)]);
  port.deliver(Uint8Array.of(0x01));
  await pendingRead;
  await lease.release();
  await connection.close();
});

test("invalid serial profile policy fails by name before Web Serial opens", async () => {
  const port = new FakeWebSerialPort();
  await assert.rejects(
    new BrowserSerialTransport({ clock: new VirtualClock() }).open({
      port,
      profileId: "invalid.serial",
      modeId: "invalid",
      protocolDuplex: "half-duplex",
      identity,
      line: LINE,
      lifecycle: {
        openingDrainQuietMs: -1,
        postTerminationSilence: NO_LIFECYCLE_DELAY.postTerminationSilence,
      },
    }),
    (error) => error.diagnostic?.code === "transport.serial.invalid-opening-drain"
      && error.diagnostic.declarationPath === "$open.lifecycle.openingDrainQuietMs",
  );
  assert.equal(port.openCalls, 0);
});

test("raw-terminal permits a same-channel read while a write is outstanding", async () => {
  const { port, connection } = await openFake(new VirtualClock());
  const lease = await connection.channels[0].acquire("raw-terminal");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  const bytes = Uint8Array.of(0xd3, 0x5a, 0xa5, 0x7e);
  const receipt = await lease.write(bytes);
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  port.deliver(bytes);
  assert.deepEqual((await pendingRead).value.bytes, bytes);

  await lease.release();
  await connection.close();
});

test("an already-open port produces the actionable held-context error", async () => {
  const port = new FakeWebSerialPort();
  await port.open();
  await assert.rejects(
    new BrowserSerialTransport({ clock: new VirtualClock() }).open({
      port,
      profileId: "device-1.serial",
      modeId: "normal",
      protocolDuplex: "half-duplex",
      identity,
      line: LINE,
      lifecycle: NO_LIFECYCLE_DELAY,
    }),
    (error) => error instanceof BrowserSerialPortHeldError
      && error.error.code === "transport.port-held"
      && /another browser tab or context/.test(error.message),
  );
});

test("a duplicate browser context is refused before its open can disturb the live port", async () => {
  const locks = new FakeLockManager();
  const clock = new VirtualClock();
  const first = new FakeWebSerialPort();
  const live = await new BrowserSerialTransport({ clock, lockManager: locks }).open({
    port: first,
    profileId: "device-1.serial",
    modeId: "normal",
    protocolDuplex: "half-duplex",
    identity,
    line: LINE,
    lifecycle: NO_LIFECYCLE_DELAY,
  });
  const contender = new FakeWebSerialPort();
  await assert.rejects(
    new BrowserSerialTransport({ clock, lockManager: locks }).open({
      port: contender,
      profileId: "device-1.serial",
      modeId: "normal",
      protocolDuplex: "half-duplex",
      identity,
      line: LINE,
      lifecycle: NO_LIFECYCLE_DELAY,
    }),
    (error) => error instanceof BrowserSerialPortHeldError,
  );
  assert.equal(contender.openCalls, 0);
  assert.equal(live.usable, true);
  await live.close();
});

test("protocol invalidation retains the browser port and origin lock through recovery", async () => {
  const locks = new FakeLockManager();
  const clock = new VirtualClock();
  const port = new FakeWebSerialPort();
  const connection = await new BrowserSerialTransport({ clock, lockManager: locks }).open({
    port,
    profileId: "device-1.serial",
    modeId: "normal",
    protocolDuplex: "half-duplex",
    identity,
    line: LINE,
    lifecycle: TRANSFER_LIFECYCLE,
  });
  connection.invalidate({
    kind: "fault",
    error: {
      code: "device-1.probe-timeout",
      message: "negative probe",
      retryability: "after-recovery",
    },
  });

  assert.equal((await connection.terminated).kind, "fault");
  assert.notEqual(port.readable, null);
  assert.equal(locks.held.size, 1);
  const cleanup = connection.close("negative probe cleanup");

  await clock.advance(2_999_999);
  assert.notEqual(port.readable, null);
  assert.equal(locks.held.size, 1);
  await clock.advance(1);
  await cleanup;
  assert.equal(port.readable, null);
  assert.equal(locks.held.size, 0);
});

test("a generic Web Serial NetworkError does not fabricate a known holder", async () => {
  const port = new FakeWebSerialPort();
  port.openError = new DOMException("Failed to open serial port.", "NetworkError");
  await assert.rejects(
    new BrowserSerialTransport({ clock: new VirtualClock(), lockManager: false }).open({
      port,
      profileId: "device-1.serial",
      modeId: "normal",
      protocolDuplex: "half-duplex",
      identity,
      line: LINE,
      lifecycle: NO_LIFECYCLE_DELAY,
    }),
    (error) => error instanceof BrowserSerialOpenError
      && error.error.code === "transport.open-failed"
      && /did not report whether another process holds it/.test(error.message),
  );
});

test("a physical stream failure terminates the connection and pending input", async () => {
  const { port, connection } = await openFake(new VirtualClock());
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pending = incoming.next();
  port.disconnect();
  assert.deepEqual(await connection.terminated, { kind: "device-lost" });
  await assert.rejects(
    pending,
    (error) => error instanceof ReceiveTerminatedError
      && error.termination.kind === "device-lost",
  );
  await Promise.resolve();
  assert.deepEqual(connection.platformEvents.map(({ kind }) => kind), [
    "disconnect-event",
    "read-error",
  ]);
  assert.equal(connection.platformEvents[1].cause.name, "NetworkError");
  await connection.close();
  assert.deepEqual(port.events, ["port-close"]);
});

test("incoming retains its typed terminal cause when disconnect lands between reads", async () => {
  const { port, connection } = await openFake(new VirtualClock());
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();

  port.disconnect();
  await connection.terminated;

  await assert.rejects(
    incoming.next(),
    (error) => error instanceof ReceiveTerminatedError
      && error.termination.kind === "device-lost",
  );
  await lease.release();
});
