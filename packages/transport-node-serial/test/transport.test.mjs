import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { ReceiveTerminatedError } from "../../core/src/ingress.ts";
import {
  NodeSerialTransport,
  SERIAL_DISCONNECT_ARBITRATION_MS,
  SerialHalfDuplexError,
  SerialPortHeldError,
  drainSerialUntilQuiet,
} from "../src/index.ts";

const identity = {
  transport: "serial",
  vendorId: 0x1a86,
  productId: 0x7523,
  portPath: "/dev/ttyUSB0",
  stableKeyAssurance: "path-derived",
  stableKey: "/dev/ttyUSB0",
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
  parity: "even",
  stopBits: 2,
  flowControl: "hardware",
});
const LIFECYCLE = Object.freeze({
  openingDrainQuietMs: 0,
  postTerminationSilence: Object.freeze({
    minimumMs: 3_000,
    afterAbnormalTermination: true,
    afterModeExit: true,
  }),
});
const NO_LIFECYCLE_DELAY = Object.freeze({
  openingDrainQuietMs: 0,
  postTerminationSilence: Object.freeze({
    minimumMs: 0,
    afterAbnormalTermination: false,
    afterModeExit: false,
  }),
});

class FakePort extends EventEmitter {
  isOpen = false;
  writes = [];
  events = [];
  openingError;
  deferWrite = false;
  pendingWriteCallback;

  read() {
    this.events.push("read");
    return null;
  }

  open(callback) {
    if (this.openingError !== undefined) {
      callback(this.openingError);
      return;
    }
    this.isOpen = true;
    this.events.push("open");
    callback(null);
  }

  close(callback) {
    if (!this.isOpen) {
      callback(null);
      return;
    }
    this.isOpen = false;
    this.events.push("close");
    this.emit("close", null);
    callback(null);
  }

  write(data, callback) {
    this.writes.push(Buffer.from(data));
    if (this.deferWrite) {
      this.pendingWriteCallback = callback;
      return true;
    }
    callback(null);
    return true;
  }

  deliver(bytes) {
    this.emit("data", Buffer.from(bytes));
  }

  disconnect() {
    const error = new Error("Input/output error");
    error.code = "EIO";
    error.errno = -5;
    error.disconnected = true;
    this.emit("error", error);
    this.isOpen = false;
    this.emit("close", error);
  }

  remoteClose(error = null) {
    this.isOpen = false;
    this.emit("close", error);
  }

  writeError(error) {
    this.emit("error", error);
    this.pendingWriteCallback?.(error);
    this.pendingWriteCallback = undefined;
  }

  beginDisconnectedWrite(error) {
    this.isOpen = false;
    this.emit("error", error);
    this.pendingWriteCallback?.(error);
    this.pendingWriteCallback = undefined;
  }
}

function enforceExclusive() {
  return Promise.resolve();
}

function inspectTermios() {
  return Promise.resolve();
}

async function openFake(clock, port = new FakePort(), protocolDuplex = "half-duplex") {
  const transport = new NodeSerialTransport({
    clock,
    createPort: () => port,
    configureTermios: inspectTermios,
    enforceExclusive,
  });
  const opening = transport.open({
    path: "/dev/ttyUSB0",
    profileId: "device-1.serial",
    modeId: "normal",
    protocolDuplex,
    identity,
    line: ALTERNATE_LINE,
    // The real 300 ms drain is covered against stale-tail.pdcap above. These
    // connection tests start from a fake port whose input is already empty.
    lifecycle: LIFECYCLE,
  });
  return { transport, port, connection: await opening };
}

test("the initial drain retains the real stale-tail regression across empty polls", async () => {
  const text = await readFile(
    new URL("../../core/test/fixtures/stale-tail.pdcap", import.meta.url),
    "utf8",
  );
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  const requested = records.find(({ kind }) => kind === "tx-requested");
  const stale = records.find(({ kind }) => kind === "rx-delivered");
  assert.ok(requested);
  assert.ok(stale);

  const clock = new VirtualClock();
  const arrivalUs = stale.tUs - requested.tUs;
  const staleBytes = Uint8Array.from(Buffer.from(stale.data, "base64"));
  let delivered = false;
  const draining = drainSerialUntilQuiet({
    clock,
    readAvailable: () => {
      if (!delivered && clock.monotonicUs() >= arrivalUs) {
        delivered = true;
        return staleBytes;
      }
      return undefined;
    },
    quietWindowMs: 300,
    maximumDiscardedBytes: 4096,
  });

  await clock.advance(400_000);
  await draining;
  assert.equal(arrivalUs, 20_000, "fixture must preserve the measured delayed arrival");
  assert.equal(delivered, true, "the delayed stale delivery must be consumed");
  assert.ok(clock.monotonicUs() >= arrivalUs + 300_000);
});

test("exclusion precedes termios and an explicit zero drain preserves buffered input", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  const events = port.events;
  let receivedOptions;
  const transport = new NodeSerialTransport({
    clock,
    createPort: (options) => {
      receivedOptions = options;
      return port;
    },
    configureTermios: async () => {
      events.push("termios");
    },
    enforceExclusive: async () => {
      events.push("exclusive");
    },
  });
  const connection = await transport.open({
    path: "/dev/ttyUSB0",
    profileId: "device-1.serial",
    modeId: "normal",
    protocolDuplex: "half-duplex",
    identity,
    line: ALTERNATE_LINE,
    lifecycle: {
      openingDrainQuietMs: 0,
      postTerminationSilence: {
        minimumMs: 0, afterAbnormalTermination: false, afterModeExit: false,
      },
    },
  });

  assert.deepEqual(events, ["open", "exclusive", "termios"]);
  assert.deepEqual(receivedOptions, {
    path: "/dev/ttyUSB0",
    baudRate: 115_200,
    dataBits: 7,
    stopBits: 2,
    parity: "even",
    rtscts: true,
    xon: false,
    xoff: false,
    lock: true,
    autoOpen: false,
  });
  await connection.close();
});

test("invalid serial profile policy fails by name before the native port is created", async () => {
  let created = false;
  const transport = new NodeSerialTransport({
    clock: new VirtualClock(),
    createPort: () => {
      created = true;
      return new FakePort();
    },
  });
  await assert.rejects(
    transport.open({
      path: "/dev/ttyUSB0",
      profileId: "invalid.serial",
      modeId: "invalid",
      protocolDuplex: "half-duplex",
      identity,
      line: { ...LINE, dataBits: 6 },
      lifecycle: NO_LIFECYCLE_DELAY,
    }),
    (error) => error.diagnostic?.code === "transport.serial.invalid-line-parameters"
      && error.diagnostic.declarationPath === "$open.line",
  );
  assert.equal(created, false);
});

test("an outstanding authoritative read structurally excludes a write", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  await assert.rejects(
    lease.write(Uint8Array.of(0x50, 0x53, 0x45, 0x41, 0x52, 0x43, 0x48)),
    (error) => {
      assert.ok(error instanceof SerialHalfDuplexError);
      assert.equal(error.error.code, "transport.half-duplex-conflict");
      return true;
    },
  );
  assert.equal(port.writes.length, 0);

  port.deliver(Uint8Array.of(0x06, 0x50, 0x31));
  assert.deepEqual((await pendingRead).value.bytes, Uint8Array.of(0x06, 0x50, 0x31));
  const receipt = await lease.write(Uint8Array.of(0x06));
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  assert.deepEqual(port.writes, [Buffer.of(0x06)]);
});

test("full-duplex protocol lease writes while authoritative reception is armed", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  const { connection } = await openFake(clock, port, "full-duplex");
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  const receipt = await lease.write(Uint8Array.of(0xa5, 0x5a));
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  assert.deepEqual(port.writes, [Buffer.of(0xa5, 0x5a)]);
  port.deliver(Uint8Array.of(0x01));
  await pendingRead;
  await lease.release();
  const closing = connection.close();
  await clock.advance(3_000_000);
  await closing;
});

test("raw-terminal permits a same-channel read while a write is outstanding", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  const lease = await connection.channels[0].acquire("raw-terminal");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  const bytes = Uint8Array.of(0xd3, 0x5a, 0xa5, 0x7e);
  const receipt = await lease.write(bytes);
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  port.deliver(bytes);
  assert.deepEqual((await pendingRead).value.bytes, bytes);

  await lease.release();
  const closing = connection.close();
  await clock.advance(3_000_000);
  await closing;
});

test("a node-serialport lock failure names the other context", async () => {
  const error = new Error("Error: Resource temporarily unavailable Cannot lock port");
  error.code = "EBUSY";
  const port = new FakePort();
  port.openingError = error;
  const transport = new NodeSerialTransport({
    clock: new VirtualClock(),
    createPort: () => port,
    configureTermios: inspectTermios,
    enforceExclusive,
  });

  await assert.rejects(
    transport.open({
      path: "/dev/ttyUSB0",
      profileId: "device-1.serial",
      modeId: "normal",
      protocolDuplex: "half-duplex",
      identity,
      line: LINE,
      lifecycle: LIFECYCLE,
    }),
    (failure) => {
      assert.ok(failure instanceof SerialPortHeldError);
      assert.equal(failure.error.code, "transport.port-held");
      assert.equal(failure.message, "serial port /dev/ttyUSB0 is held by another context");
      assert.equal(failure.error.platformCause.code, "EBUSY");
      assert.equal(failure.error.platformCause.serializableDetails, undefined);
      return true;
    },
  );
});

test("a physical disconnect differs from host close and rejects a pending read", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const pendingRead = incoming.next();

  port.disconnect();
  assert.deepEqual(await connection.terminated, { kind: "device-lost" });
  await assert.rejects(pendingRead, (error) => {
    assert.ok(error instanceof ReceiveTerminatedError);
    assert.equal(error.termination.kind, "device-lost");
    return true;
  });
  assert.equal(connection.terminationEvidence.code, "EIO");
  assert.equal(connection.terminationEvidence.serializableDetails.disconnected, true);
  assert.deepEqual(connection.platformEvents.map(({ kind }) => kind), ["error"]);
  assert.equal(connection.platformEvents[0].cause.code, "EIO");
  assert.equal(connection.platformEvents[0].cause.serializableDetails.errno, -5);
});

test("a remote close with no in-flight native operation terminates as device-lost", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  const lease = await connection.channels[0].acquire("protocol");
  const pendingRead = lease.incoming()[Symbol.asyncIterator]().next();

  port.remoteClose();

  assert.deepEqual(await connection.terminated, { kind: "device-lost" });
  await assert.rejects(pendingRead, ReceiveTerminatedError);
  assert.deepEqual(connection.platformEvents, [{
    kind: "close",
    sequence: connection.platformEvents[0].sequence,
    tUs: connection.platformEvents[0].tUs,
    localCloseInProgress: false,
  }]);
});

test("a write-only native error terminates, settles uncertainty, and remains handled after close", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  port.deferWrite = true;
  const { connection } = await openFake(clock, port);
  const lease = await connection.channels[0].acquire("raw-terminal");
  const write = lease.write(Uint8Array.from([0xfe, 0xfd, 0xfc]));
  const failure = Object.assign(
    new Error("Writing to COM port (GetOverlappedResult): Operation aborted"),
    { code: "UNKNOWN", errno: -1 },
  );

  port.writeError(failure);

  const termination = await connection.terminated;
  assert.equal(termination.kind, "fault");
  assert.equal(termination.error.code, "transport.platform-error");
  assert.equal(termination.error.platformCause.message, failure.message);
  assert.deepEqual((await write).outcome, {
    kind: "may-be-partial",
    knownAcceptedBytes: 0,
    possiblyAcceptedBytesUpTo: 3,
  });
  assert.equal(port.listenerCount("error"), 1);

  // @serialport/stream may emit its callback error after a disconnect close.
  // The retained listener must consume and record that late native signal.
  assert.doesNotThrow(() => port.emit("error", failure));
  assert.deepEqual(connection.platformEvents.map(({ kind }) => kind), ["error", "error"]);
});

test("an unmarked write error defers to a bounded non-local close without guessing from EBADF", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  port.deferWrite = true;
  const { connection } = await openFake(clock, port);
  const lease = await connection.channels[0].acquire("raw-terminal");
  const write = lease.write(Uint8Array.from([0xfe, 0xfd, 0xfc]));
  const barePollError = new Error("bad file descriptor");

  port.beginDisconnectedWrite(barePollError);
  assert.equal(connection.usable, true);
  const receipt = await write;
  assert.equal(receipt.outcome.kind, "may-be-partial");
  assert.equal(receipt.platformCause.message, barePollError.message);
  await clock.advance(SERIAL_DISCONNECT_ARBITRATION_MS * 1_000 - 1);
  assert.equal(connection.usable, true);

  const disconnected = Object.assign(new Error("bad file descriptor"), { disconnected: true });
  port.remoteClose(disconnected);
  assert.deepEqual(await connection.terminated, { kind: "device-lost" });
  assert.deepEqual(connection.platformEvents.map(({ kind }) => kind), ["error", "close"]);
  assert.equal(connection.platformEvents[0].cause.message, barePollError.message);
  assert.equal(connection.platformEvents[1].cause.serializableDetails.disconnected, true);

  const fallbackClock = new VirtualClock();
  const fallbackPort = new FakePort();
  fallbackPort.deferWrite = true;
  const fallback = await openFake(fallbackClock, fallbackPort);
  const fallbackLease = await fallback.connection.channels[0].acquire("raw-terminal");
  void fallbackLease.write(Uint8Array.from([0xff]));
  fallbackPort.beginDisconnectedWrite(barePollError);
  await fallbackClock.advance(SERIAL_DISCONNECT_ARBITRATION_MS * 1_000);

  const fallbackTermination = await fallback.connection.terminated;
  assert.equal(fallbackTermination.kind, "fault");
  assert.equal(fallbackTermination.error.code, "transport.platform-error");
  assert.deepEqual(fallback.connection.platformEvents.map(({ kind }) => kind), [
    "error",
    "disconnect-arbitration-timeout",
  ]);
  assert.equal(
    fallback.connection.platformEvents[1].waitedMs,
    SERIAL_DISCONNECT_ARBITRATION_MS,
  );
});

test("a disconnect close cannot expose the delayed write error as an unhandled event", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  port.deferWrite = true;
  const { connection } = await openFake(clock, port);
  const lease = await connection.channels[0].acquire("raw-terminal");
  const write = lease.write(Uint8Array.from([0xff, 0xff]));
  const disconnected = Object.assign(new Error("Access denied"), { disconnected: true });
  const delayedWriteError = new Error(
    "Writing to COM port (GetOverlappedResult): Operation aborted",
  );

  // This is @serialport/stream's observed Windows ordering: _disconnected()
  // closes first, then Writable delivers the rejected write as an error event.
  port.remoteClose(disconnected);
  assert.deepEqual(await connection.terminated, { kind: "device-lost" });
  assert.equal((await write).outcome.kind, "may-be-partial");
  assert.doesNotThrow(() => port.emit("error", delayedWriteError));
  assert.deepEqual(connection.platformEvents.map(({ kind }) => kind), ["close", "error"]);
  assert.equal(connection.platformEvents[0].localCloseInProgress, false);
  assert.equal(connection.platformEvents[1].cause.message, delayedWriteError.message);
});

test("incoming retains its typed terminal cause when disconnect lands between reads", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  const lease = await connection.channels[0].acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();

  port.disconnect();
  await connection.terminated;

  await assert.rejects(incoming.next(), (error) => {
    assert.ok(error instanceof ReceiveTerminatedError);
    assert.equal(error.termination.kind, "device-lost");
    return true;
  });
  await lease.release();
});

test("clean close enforces exactly the declared 3000 ms recovery silence", async () => {
  const clock = new VirtualClock();
  const { connection } = await openFake(clock);
  const closing = connection.close("test complete");
  assert.deepEqual(await connection.terminated, { kind: "closed-by-host" });

  let resolved = false;
  void closing.then(() => { resolved = true; });
  await clock.advance(2_999_999);
  assert.equal(resolved, false);
  await clock.advance(1);
  await closing;
  assert.equal(resolved, true);
  assert.equal(connection.platformEvents[0].kind, "close");
  assert.equal(connection.platformEvents[0].localCloseInProgress, true);
});

test("a profile with no mode-exit obligation closes without recovery silence", async () => {
  const clock = new VirtualClock();
  const port = new FakePort();
  const transport = new NodeSerialTransport({
    clock,
    createPort: () => port,
    configureTermios: inspectTermios,
    enforceExclusive,
  });
  const connection = await transport.open({
    path: "/dev/ttyUSB0",
    profileId: "device-2.serial",
    modeId: "silent",
    protocolDuplex: "full-duplex",
    identity,
    line: LINE,
    lifecycle: NO_LIFECYCLE_DELAY,
  });
  await connection.close("clean non-transfer close");
  assert.deepEqual(await connection.terminated, { kind: "closed-by-host" });
  assert.equal(clock.monotonicUs(), 0);
});

test("protocol invalidation retains the native handle through recovery", async () => {
  const clock = new VirtualClock();
  const { connection, port } = await openFake(clock);
  connection.invalidate({
    kind: "fault",
    error: {
      code: "device-1.probe-timeout",
      message: "negative probe",
      retryability: "after-recovery",
    },
  });

  assert.equal((await connection.terminated).kind, "fault");
  assert.equal(port.isOpen, true, "TIOCEXCL/platform exclusion must remain owned");
  const cleanup = connection.close("negative probe cleanup");
  let settled = false;
  void cleanup.then(() => { settled = true; });

  await clock.advance(2_999_999);
  assert.equal(port.isOpen, true);
  assert.equal(settled, false);
  await clock.advance(1);
  await cleanup;
  assert.equal(port.isOpen, false);
  assert.equal(settled, true);
});
