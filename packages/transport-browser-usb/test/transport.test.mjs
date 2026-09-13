import assert from "node:assert/strict";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { UsbProfilePolicyError } from "@protodriver/core/usb-profile";
import {
  BrowserUsbOpenError,
  BrowserUsbTransport,
} from "../src/index.ts";

const identity = {
  transport: "usb",
  vendorId: 0x16c0,
  productId: 0x04d3,
  productName: "non-hardware WebUSB conformance device",
  serialNumber: "fixture",
  stableKeyAssurance: "serial-number",
  stableKey: "fixture",
};

const profile = {
  kind: "usb",
  configurationValue: 1,
  interfaceNumber: 0,
  alternateSetting: 0,
  channels: [
    {
      id: "write-only",
      input: null,
      output: {
        endpointNumber: 1,
        transferType: "bulk",
        maximumPacketBytes: { full: 64, high: 512 },
      },
    },
    {
      id: "read-only",
      input: {
        endpointNumber: 2,
        transferType: "interrupt",
        maximumPacketBytes: { full: 64, high: 64 },
      },
      output: null,
    },
    {
      id: "duplex",
      input: {
        endpointNumber: 4,
        transferType: "bulk",
        maximumPacketBytes: { full: 64, high: 512 },
      },
      output: {
        endpointNumber: 7,
        transferType: "bulk",
        maximumPacketBytes: { full: 64, high: 512 },
      },
    },
  ],
};

class FakeWebUsbDevice {
  opened = false;
  currentConfiguration = null;
  events = [];
  pendingInputs = [];
  controlCalls = [];
  claimed = false;
  activeAlternate = undefined;
  selectionTakesEffect = true;
  wireAlternate = 0;
  alternateObservationStatus = "ok";
  alternateObservationBytes = undefined;
  alternateObservationError = undefined;

  constructor() {
    const endpoints = [
      endpoint(1, "out", "bulk", 64),
      endpoint(2, "in", "interrupt", 64),
      endpoint(4, "in", "bulk", 64),
      endpoint(7, "out", "bulk", 64),
    ];
    this.configurationTemplate = {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        get claimed() { return this.owner.claimed; },
        get alternate() { return this.owner.activeAlternate ?? this.alternates[0]; },
        alternates: [
          { alternateSetting: 0, endpoints },
          { alternateSetting: 1, endpoints },
        ],
        owner: this,
      }],
    };
  }

  get configuration() {
    this.events.push(`configuration-observed:${this.currentConfiguration?.configurationValue ?? "none"}`);
    return this.currentConfiguration;
  }

  async open() {
    this.events.push("open");
    this.opened = true;
  }

  async close() {
    assert.equal(
      this.pendingInputs.every((pending) => pending.settled),
      true,
      "every pending WebUSB transfer must settle before handle close",
    );
    this.events.push("close");
    this.opened = false;
  }

  async selectConfiguration(value) {
    this.events.push(`configuration:${value}`);
    if (this.selectionTakesEffect) this.currentConfiguration = this.configurationTemplate;
  }

  async claimInterface(number) {
    this.events.push(`claim:${number}`);
    this.claimed = true;
  }

  async selectAlternateInterface(number, alternateSetting) {
    this.events.push(`alternate:${number}:${alternateSetting}`);
    const usbInterface = this.configuration.interfaces.find(
      (candidate) => candidate.interfaceNumber === number,
    );
    this.activeAlternate = usbInterface.alternates.find(
      (candidate) => candidate.alternateSetting === alternateSetting,
    );
    if (this.selectionTakesEffect) this.wireAlternate = alternateSetting;
  }

  async releaseInterface(number) {
    this.events.push(`release:${number}`);
    this.claimed = false;
    for (const pending of this.pendingInputs.filter((candidate) => !candidate.settled)) {
      pending.reject(new DOMException("transfer cancelled by interface release", "NetworkError"));
    }
  }

  transferIn(endpointNumber, length) {
    this.events.push(`transferIn:${endpointNumber}:${length}`);
    let resolve;
    let reject;
    const pending = { endpointNumber, length, settled: false, resolve: undefined, reject: undefined };
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }).finally(() => {
      pending.settled = true;
      this.events.push(`settledIn:${endpointNumber}`);
    });
    pending.resolve = resolve;
    pending.reject = reject;
    this.pendingInputs.push(pending);
    return promise;
  }

  async transferOut(endpointNumber, data) {
    const bytes = new Uint8Array(data instanceof ArrayBuffer
      ? data
      : data.buffer, data.byteOffset ?? 0, data.byteLength);
    this.events.push(`transferOut:${endpointNumber}:${bytes.byteLength}`);
    return { status: "ok", bytesWritten: bytes.byteLength };
  }

  async controlTransferIn(setup, length) {
    this.controlCalls.push({ direction: "in", setup, length });
    if (setup.requestType === "standard"
      && setup.recipient === "interface"
      && setup.request === 0x0a) {
      if (this.alternateObservationError !== undefined) throw this.alternateObservationError;
      this.events.push(`alternate-observed:${this.wireAlternate}`);
      const bytes = this.alternateObservationBytes === undefined
        ? Uint8Array.of(this.wireAlternate)
        : this.alternateObservationBytes;
      return {
        status: this.alternateObservationStatus,
        data: bytes === null ? undefined : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    }
    const bytes = Uint8Array.from([
      0x44, 0x33, 0x4c, 0x49, 0x4e, 0x4b, 0x01, 0x00,
      0x01, 0x81, 0x82, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]).subarray(0, length);
    return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }

  async controlTransferOut(setup, data) {
    this.controlCalls.push({ direction: "out", setup, data });
    return { status: "ok", bytesWritten: data?.byteLength ?? 0 };
  }
}

function endpoint(endpointNumber, direction, type, packetSize) {
  return { endpointNumber, direction, type, packetSize };
}

async function openFake(
  device = new FakeWebUsbDevice(),
  suppliedProfile = profile,
  suppliedIdentity = identity,
  requiredProductName,
) {
  const transport = new BrowserUsbTransport({ clock: new VirtualClock() });
  const connection = await transport.open({
    device,
    profileId: "non-hardware.webusb",
    modeId: "normal",
    identity: suppliedIdentity,
    profile: suppliedProfile,
    ...(requiredProductName === undefined ? {} : { requiredProductName }),
    declaredMaximumFrameBytes: 2058,
    maximumBufferedBytes: 1024,
    maximumDiagnosticBytes: 1024,
  });
  return { device, connection };
}

test("WebUSB required product name fails open before configuration handling", async () => {
  const matching = new FakeWebUsbDevice();
  matching.currentConfiguration = matching.configurationTemplate;
  const matchingConnection = (await openFake(
    matching,
    profile,
    identity,
    "non-hardware WebUSB conformance device",
  )).connection;
  await matchingConnection.close();

  for (const productName of ["TI-84 Plus Silver Calculator", undefined]) {
    const device = new FakeWebUsbDevice();
    const suppliedIdentity = { ...identity };
    if (productName === undefined) delete suppliedIdentity.productName;
    else suppliedIdentity.productName = productName;
    await assert.rejects(
      openFake(device, profile, suppliedIdentity, "TI-84 Plus CE"),
      (error) => error instanceof BrowserUsbOpenError
        && error.error.code === "transport.usb.product-name-mismatch",
    );
    assert.deepEqual(device.events, [], "identity failure precedes open and configuration handling");
  }
});

test("WebUSB bulk input request stays one packet when the declared frame ceiling is larger", async () => {
  const { device, connection } = await openFake();
  const bulkInputs = device.pendingInputs.filter((pending) => pending.endpointNumber === 4);
  assert.ok(bulkInputs.length > 0);
  assert.deepEqual(
    [...new Set(bulkInputs.map(({ length }) => length))],
    [64],
  );
  await connection.close();
});

test("WebUSB bulk input maintains eight independently pending transfers", async () => {
  const { device, connection } = await openFake();
  const pendingBulkInputs = () => device.pendingInputs.filter(
    (pending) => pending.endpointNumber === 4 && !pending.settled,
  );
  assert.equal(pendingBulkInputs().length, 8);
  const first = pendingBulkInputs()[0];
  const bytes = Uint8Array.of(1);
  first.resolve({ status: "ok", data: new DataView(bytes.buffer) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingBulkInputs().length, 8, "a settled bulk input must be replaced");
  await connection.close();
});

test("WebUSB read-only, write-only, and duplex channels use declared directions independently", async () => {
  const { device, connection } = await openFake();
  assert.deepEqual(connection.channels.map(({ id, direction }) => ({ id, direction })), [
    { id: "write-only", direction: "out" },
    { id: "read-only", direction: "in" },
    { id: "duplex", direction: "duplex" },
  ]);
  assert.equal(device.events.includes("transferIn:2:64"), true);
  assert.equal(device.events.includes("transferIn:4:64"), true);

  const lease = await connection.channels[2].acquire("raw-write");
  const receipt = await lease.write(new Uint8Array(64));
  assert.equal(receipt.outcome.kind, "accepted-by-platform");
  assert.deepEqual(device.events.filter((event) => event.startsWith("transferOut")), [
    "transferOut:7:64",
  ]);
  await lease.release();
  await connection.close();
});

test("WebUSB open preserves an active configuration and verifies selection before claim", async () => {
  const active = new FakeWebUsbDevice();
  active.currentConfiguration = active.configurationTemplate;
  const activeConnection = (await openFake(active)).connection;
  assert.equal(
    active.events.filter((event) => event === "configuration:1").length,
    0,
    "the existing WebUSB guard must prevent same-value configuration selection",
  );
  assert.deepEqual(
    active.events.slice(0, active.events.indexOf("claim:0")).filter((event) => event.startsWith("configuration")),
    ["configuration-observed:1"],
  );
  assert.ok(active.events.indexOf("claim:0") > active.events.indexOf("configuration-observed:1"));
  await activeConnection.close();

  for (const initial of [null, 2]) {
    const changed = new FakeWebUsbDevice();
    changed.currentConfiguration = initial === null
      ? null
      : { ...changed.configurationTemplate, configurationValue: initial };
    const changedConnection = (await openFake(changed)).connection;
    const selection = changed.events.indexOf("configuration:1");
    const postcondition = changed.events.indexOf("configuration-observed:1", selection + 1);
    assert.ok(selection > changed.events.indexOf(`configuration-observed:${initial ?? "none"}`));
    assert.ok(postcondition > selection);
    assert.ok(changed.events.indexOf("claim:0") > postcondition);
    assert.equal(changed.events.filter((event) => event === "configuration:1").length, 1);
    await changedConnection.close();
  }

  const unchanged = new FakeWebUsbDevice();
  unchanged.selectionTakesEffect = false;
  await assert.rejects(
    openFake(unchanged),
    (error) => error instanceof BrowserUsbOpenError
      && error.error.code === "transport.usb.configuration-postcondition-failed",
  );
  assert.equal(unchanged.events.filter((event) => event === "configuration:1").length, 1);
  assert.equal(unchanged.events.includes("claim:0"), false);
});

test("WebUSB preserve-active never selects a configuration and requires a live declared interface", async () => {
  const preserveActive = structuredClone(profile);
  preserveActive.configurationValue = "preserve-active";
  for (const value of [1, 2, 3]) {
    const device = new FakeWebUsbDevice();
    device.currentConfiguration = {
      ...device.configurationTemplate,
      configurationValue: value,
    };
    const { connection } = await openFake(device, preserveActive);
    assert.equal(
      device.events.some((event) => event.startsWith("configuration:")),
      false,
      "preserve-active must not select any reported active configuration",
    );
    assert.ok(device.events
      .filter((event) => event.startsWith("configuration-observed:"))
      .every((event) => event === `configuration-observed:${value}`));
    assert.ok(device.events.indexOf("claim:0") > device.events.indexOf(`configuration-observed:${value}`));
    await connection.close();
  }

  const unconfigured = new FakeWebUsbDevice();
  await assert.rejects(
    openFake(unconfigured, preserveActive),
    (error) => error instanceof BrowserUsbOpenError
      && error.error.code === "transport.usb.configuration-postcondition-failed",
  );
  assert.deepEqual(
    unconfigured.events.filter((event) => event.startsWith("configuration")),
    ["configuration-observed:none"],
  );
  assert.equal(unconfigured.events.includes("claim:0"), false);

  const absentInterface = new FakeWebUsbDevice();
  absentInterface.currentConfiguration = {
    configurationValue: 2,
    interfaces: [],
  };
  await assert.rejects(openFake(absentInterface, preserveActive), UsbProfilePolicyError);
  assert.equal(absentInterface.events.includes("claim:0"), false);
});

test("WebUSB open observes alternate state, skips matching selection, and verifies changed selection", async () => {
  const matching = new FakeWebUsbDevice();
  matching.currentConfiguration = matching.configurationTemplate;
  const matchingConnection = (await openFake(matching)).connection;
  assert.deepEqual(
    matching.events.filter((event) => event.startsWith("alternate:")),
    [],
    "an observed matching alternate must not be selected again",
  );
  assert.deepEqual(
    matching.events.filter((event) => event.startsWith("alternate-observed:")),
    ["alternate-observed:0"],
  );
  assert.ok(matching.events.indexOf("alternate-observed:0") > matching.events.indexOf("claim:0"));
  await matchingConnection.close();

  const changed = new FakeWebUsbDevice();
  changed.currentConfiguration = changed.configurationTemplate;
  changed.wireAlternate = 1;
  changed.activeAlternate = changed.configurationTemplate.interfaces[0].alternates[1];
  const changedConnection = (await openFake(changed)).connection;
  assert.deepEqual(
    changed.events.filter((event) => event.startsWith("alternate")),
    ["alternate-observed:1", "alternate:0:0", "alternate-observed:0"],
  );
  await changedConnection.close();

  const matchingNonzero = new FakeWebUsbDevice();
  matchingNonzero.currentConfiguration = matchingNonzero.configurationTemplate;
  matchingNonzero.wireAlternate = 1;
  matchingNonzero.activeAlternate = matchingNonzero.configurationTemplate.interfaces[0].alternates[1];
  const nonzeroProfile = structuredClone(profile);
  nonzeroProfile.alternateSetting = 1;
  const nonzeroConnection = (await openFake(matchingNonzero, nonzeroProfile)).connection;
  assert.equal(matchingNonzero.events.includes("alternate:0:1"), false);
  assert.equal(matchingNonzero.configuration.interfaces[0].alternate.alternateSetting, 1);
  await nonzeroConnection.close();

  const unchanged = new FakeWebUsbDevice();
  unchanged.currentConfiguration = unchanged.configurationTemplate;
  unchanged.wireAlternate = 1;
  unchanged.activeAlternate = unchanged.configurationTemplate.interfaces[0].alternates[1];
  unchanged.selectionTakesEffect = false;
  await assert.rejects(
    openFake(unchanged),
    (error) => error instanceof BrowserUsbOpenError
      && error.error.code === "transport.usb.alternate-postcondition-failed",
  );
  assert.deepEqual(
    unchanged.events.filter((event) => event.startsWith("alternate")),
    ["alternate-observed:1", "alternate:0:0", "alternate-observed:1"],
  );

  const conflicting = new FakeWebUsbDevice();
  conflicting.currentConfiguration = conflicting.configurationTemplate;
  conflicting.wireAlternate = 1;
  const conflictingProfile = structuredClone(profile);
  conflictingProfile.alternateSetting = 1;
  await assert.rejects(
    openFake(conflicting, conflictingProfile),
    (error) => error instanceof BrowserUsbOpenError
      && error.error.code === "transport.usb.alternate-host-view-mismatch",
  );
  assert.equal(conflicting.events.includes("alternate:0:1"), false);

  const invalidObservations = [
    { bytes: null, status: "ok" },
    { bytes: new Uint8Array(), status: "ok" },
    { bytes: Uint8Array.of(0, 0), status: "ok" },
    { bytes: Uint8Array.of(0), status: "stall" },
    { error: new DOMException("GET_INTERFACE stalled", "NetworkError") },
  ];
  for (const observation of invalidObservations) {
    const invalid = new FakeWebUsbDevice();
    invalid.currentConfiguration = invalid.configurationTemplate;
    invalid.alternateObservationBytes = observation.bytes;
    invalid.alternateObservationStatus = observation.status ?? "ok";
    invalid.alternateObservationError = observation.error;
    await assert.rejects(
      openFake(invalid),
      (error) => error instanceof BrowserUsbOpenError
        && error.error.code === "transport.usb.alternate-observation-failed",
    );
    assert.equal(invalid.events.some((event) => event.startsWith("alternate:")), false);
    assert.equal(invalid.events.some((event) => event.startsWith("transferIn:")), false);
  }
});

test("WebUSB profile mismatch fails through the shared validator before claim", async () => {
  const device = new FakeWebUsbDevice();
  const mismatched = structuredClone(profile);
  mismatched.channels[1].input.maximumPacketBytes = { high: 64 };
  await assert.rejects(
    openFake(device, mismatched),
    (error) => error instanceof UsbProfilePolicyError
      && error.diagnostic.code === "transport.usb.no-common-packet-size-speed"
      && error.diagnostic.declarationPath === "$open.profile",
  );
  assert.equal(device.events.some((event) => event.startsWith("claim:")), false);
});

test("WebUSB usb.control shares setup validation and returns the vendor IN bytes", async () => {
  const { device, connection } = await openFake();
  const openingControlCalls = device.controlCalls.length;
  const invalid = await connection.control({
    kind: "usb.control",
    parameters: { direction: "device-to-host" },
  });
  assert.equal(invalid.settled, "failed");
  assert.equal(invalid.error.code, "transport.usb.invalid-control-request");
  assert.equal(device.controlCalls.length, openingControlCalls);

  const response = await connection.control({
    kind: "usb.control",
    parameters: {
      direction: "device-to-host",
      requestType: "vendor",
      recipient: "device",
      request: 0x51,
      value: 1,
      index: 0,
      length: 16,
    },
  });
  assert.equal(response.settled, "completed");
  assert.deepEqual([...response.payload], [
    0x44, 0x33, 0x4c, 0x49, 0x4e, 0x4b, 0x01, 0x00,
    0x01, 0x81, 0x82, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.deepEqual(device.controlCalls.at(-1), {
    direction: "in",
    setup: { requestType: "vendor", recipient: "device", request: 0x51, value: 1, index: 0 },
    length: 16,
  });
  await connection.close();
});

test("WebUSB close releases to cancel, awaits settlement, then closes without a false fault", async () => {
  const { device, connection } = await openFake();
  const pendingBeforeClose = device.pendingInputs.filter((pending) => !pending.settled).length;
  assert.equal(pendingBeforeClose, 9, "one interrupt and eight bulk inputs must be pending");
  const termination = connection.terminated;
  await connection.close();
  assert.deepEqual(await termination, { kind: "closed-by-host" });
  assert.equal(device.events.filter((event) => event === "release:0").length, 1);
  const releaseIndex = device.events.indexOf("release:0");
  const settledIndexes = device.events
    .map((event, index) => event.startsWith("settledIn:") ? index : -1)
    .filter((index) => index >= 0);
  const closeIndex = device.events.indexOf("close");
  assert.equal(settledIndexes.length, pendingBeforeClose);
  assert.equal(settledIndexes.every((index) => index > releaseIndex && index < closeIndex), true);
});
