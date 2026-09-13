import assert from "node:assert/strict";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { UsbProfilePolicyError } from "@protodriver/core/usb-profile";
import {
  NodeUsbOpenError,
  NodeUsbTransport,
} from "../src/index.ts";

const identity = {
  transport: "usb",
  vendorId: 0x16c0,
  productId: 0x04d3,
  productName: "non-hardware USB conformance device",
  serialNumber: "fixture",
  usbSpeed: "full",
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

function nativeError(message, errno) {
  const error = new Error(message);
  error.errno = errno;
  return error;
}

class FakeTransfer {
  constructor(endpoint, timeoutMs, callback) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.callback = callback;
    this.pending = false;
    this.buffer = undefined;
  }

  submit(buffer) {
    this.pending = true;
    this.buffer = Buffer.from(buffer);
    this.endpoint.events.push(`submit:${this.endpoint.address.toString(16)}:${buffer.length}`);
    this.endpoint.pending.push(this);
    if (this.endpoint.direction === "out") this.complete(buffer);
    return this;
  }

  cancel() {
    if (!this.pending) return false;
    this.endpoint.events.push(`cancel:${this.endpoint.address.toString(16)}`);
    this.pending = false;
    this.endpoint.pending = this.endpoint.pending.filter((candidate) => candidate !== this);
    this.callback(nativeError("cancelled", -10), this.buffer, 0);
    return true;
  }

  complete(bytes) {
    if (!this.pending) throw new Error("transfer is not pending");
    this.pending = false;
    this.endpoint.pending = this.endpoint.pending.filter((candidate) => candidate !== this);
    const value = Buffer.from(bytes);
    this.callback(undefined, value, value.length);
  }
}

class FakeEndpoint {
  constructor(address, transferType, packetBytes, events) {
    this.address = address;
    this.direction = (address & 0x80) === 0 ? "out" : "in";
    this.events = events;
    this.pending = [];
    this.descriptor = {
      bEndpointAddress: address,
      bmAttributes: transferType === "bulk" ? 2 : 3,
      wMaxPacketSize: packetBytes,
    };
  }

  makeTransfer(timeoutMs, callback) {
    return new FakeTransfer(this, timeoutMs, callback);
  }

  deliver(bytes) {
    const transfer = this.pending[0];
    if (transfer === undefined) throw new Error("no pending input transfer");
    transfer.complete(bytes);
  }
}

class FakeInterface {
  constructor(endpoints, events, device) {
    this.alternateEndpoints = new Map([[0, endpoints]]);
    this.endpoints = endpoints;
    this.events = events;
    this.device = device;
    this.altSetting = 0;
    this.kernelDriverActive = false;
    this.kernelDriverInspectionError = undefined;
    this.claimError = undefined;
  }

  installAlternate(value, endpoints) {
    this.alternateEndpoints.set(value, endpoints);
  }

  refresh() {
    this.events.push(`refresh:${this.altSetting}`);
    this.endpoints = this.alternateEndpoints.get(this.altSetting) ?? new Map();
  }

  isKernelDriverActive() {
    this.events.push("kernel-driver-check");
    if (this.kernelDriverInspectionError !== undefined) throw this.kernelDriverInspectionError;
    return this.kernelDriverActive;
  }

  claim() {
    this.events.push("claim");
    if (this.claimError !== undefined) throw this.claimError;
  }

  endpoint(address) {
    return this.endpoints.get(address);
  }

  setAltSetting(value, callback) {
    this.events.push(`alternate:${value}`);
    if (this.device.alternateSelectionTakesEffect) this.device.currentAlternate = value;
    this.altSetting = value;
    this.refresh();
    callback(undefined);
  }

  release(closeEndpoints, callback) {
    assert.equal(
      Array.from(this.endpoints.values()).some((endpoint) => endpoint.pending.length > 0),
      false,
      "pending native transfers must be cancelled before interface release",
    );
    this.events.push(`release:${closeEndpoints}`);
    callback(undefined);
  }
}

class FakeDevice {
  constructor() {
    this.events = [];
    this.timeout = 0;
    this.deviceDescriptor = { iProduct: 1, iSerialNumber: 2 };
    this.stringDescriptors = new Map([
      [1, "non-hardware USB conformance device"],
      [2, "fixture"],
    ]);
    this.endpoints = new Map([
      [0x01, new FakeEndpoint(0x01, "bulk", 64, this.events)],
      [0x82, new FakeEndpoint(0x82, "interrupt", 64, this.events)],
      [0x84, new FakeEndpoint(0x84, "bulk", 64, this.events)],
      [0x07, new FakeEndpoint(0x07, "bulk", 64, this.events)],
    ]);
    this.currentAlternate = 0;
    this.alternateSelectionTakesEffect = true;
    this.usbInterface = new FakeInterface(this.endpoints, this.events, this);
    this.allConfigDescriptors = [{
      bConfigurationValue: 1,
      interfaces: [[{
        bInterfaceNumber: 0,
        bAlternateSetting: 0,
        endpoints: Array.from(this.endpoints.values(), (endpoint) => endpoint.descriptor),
      }]],
    }];
    this.activeConfigDescriptor = this.allConfigDescriptors[0];
    this.selectionTakesEffect = true;
    this.alternateObservationOverride = null;
    this.interfacesHydrated = false;
    this.controlCalls = [];
  }

  get configDescriptor() {
    this.events.push(`configuration-observed:${this.activeConfigDescriptor?.bConfigurationValue ?? "none"}`);
    return this.activeConfigDescriptor;
  }

  open(defaultConfiguration) {
    this.events.push(`open:${defaultConfiguration}`);
    this.interfacesHydrated = defaultConfiguration;
  }

  close() {
    this.events.push("close");
    this.interfacesHydrated = false;
  }

  getStringDescriptor(index, callback) {
    this.events.push(`string:${index}`);
    callback(undefined, this.stringDescriptors.get(index));
  }

  setConfiguration(value, callback) {
    this.events.push(`configuration:${value}`);
    if (this.selectionTakesEffect) {
      this.activeConfigDescriptor = this.allConfigDescriptors.find(
        (candidate) => candidate.bConfigurationValue === value,
      );
      this.interfacesHydrated = true;
    }
    callback(undefined);
  }

  interface(number) {
    this.events.push(`interface:${number}`);
    if (!this.interfacesHydrated) throw new Error(`Interface not found for address: ${number}`);
    return this.usbInterface;
  }

  controlTransfer(requestType, request, value, index, dataOrLength, callback) {
    this.controlCalls.push({ requestType, request, value, index, dataOrLength });
    if (requestType === 0x81 && request === 0x0a) {
      this.events.push(`alternate-observed:${this.currentAlternate}`);
      if (this.alternateObservationOverride instanceof Error) {
        callback(this.alternateObservationOverride, undefined);
      } else {
        callback(
          undefined,
          this.alternateObservationOverride === null
            ? Buffer.of(this.currentAlternate)
            : this.alternateObservationOverride,
        );
      }
      return this;
    }
    callback(undefined, typeof dataOrLength === "number"
      ? Buffer.from("D3LINK\x01\x00abcdefgh", "binary").subarray(0, dataOrLength)
      : dataOrLength.length);
    return this;
  }
}

async function openFake(
  device = new FakeDevice(),
  suppliedProfile = profile,
  suppliedIdentity = identity,
  requiredProductName,
  observeBeforeIngress,
) {
  const transport = new NodeUsbTransport({ clock: new VirtualClock() });
  const connection = await transport.open({
    device,
    profileId: "non-hardware.usb",
    modeId: "normal",
    identity: suppliedIdentity,
    speedEvidence: suppliedIdentity.usbSpeed === undefined
      ? { kind: "unreported" }
      : { kind: "reported", speed: suppliedIdentity.usbSpeed },
    profile: suppliedProfile,
    ...(requiredProductName === undefined ? {} : { requiredProductName }),
    ...(observeBeforeIngress === undefined ? {} : { observeBeforeIngress }),
    declaredMaximumFrameBytes: 2058,
  });
  return { device, connection };
}

test("Node USB required product name fails after descriptor enrichment but before configuration handling", async () => {
  const matching = new FakeDevice();
  const matchingConnection = (await openFake(
    matching,
    profile,
    identity,
    "non-hardware USB conformance device",
  )).connection;
  assert.equal(matching.events.some((event) => event.startsWith("string:")), false);
  await matchingConnection.close();

  for (const productName of ["TI-84 Plus Silver Calculator", undefined]) {
    const device = new FakeDevice();
    const suppliedIdentity = { ...identity };
    if (productName === undefined) delete suppliedIdentity.productName;
    else suppliedIdentity.productName = productName;
    await assert.rejects(
      openFake(device, profile, suppliedIdentity, "TI-84 Plus CE"),
      (error) => error instanceof NodeUsbOpenError
        && error.error.code === "transport.usb.product-name-mismatch",
    );
    assert.equal(device.events[0], "open:true");
    assert.equal(device.events.some((event) => event.startsWith("configuration")), false);
    assert.equal(device.events.includes("claim"), false);
    assert.equal(device.events.at(-1), "close");
  }
});

test("Node USB rejects contradictory speed evidence before opening", async () => {
  const device = new FakeDevice();
  await assert.rejects(
    new NodeUsbTransport().open({
      device,
      profileId: "contradictory-speed",
      modeId: "normal",
      identity,
      speedEvidence: { kind: "unreported" },
      profile,
    }),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.usb.speed-evidence-mismatch",
  );
  assert.deepEqual(device.events, []);
});

test("Node USB unreported speed and selected-open strings remain consistent", async () => {
  const device = new FakeDevice();
  const { connection } = await openFake(
    device,
    profile,
    {
      transport: "usb",
      vendorId: 0x16c0,
      productId: 0x04d3,
      portPath: "usb:1-2.3",
      stableKeyAssurance: "path-derived",
      stableKey: "1-2.3",
    },
    "non-hardware USB conformance device",
  );
  assert.equal(connection.identity.usbSpeed, undefined);
  assert.equal(connection.identity.productName, "non-hardware USB conformance device");
  assert.equal(connection.identity.serialNumber, "fixture");
  assert.equal(connection.identity.stableKeyAssurance, "serial-number");
  assert.equal(connection.identity.stableKey, "fixture");
  assert.ok(device.events.indexOf("string:1") > device.events.indexOf("open:true"));
  assert.ok(device.events.indexOf("string:2") > device.events.indexOf("open:true"));
  assert.ok(device.events.indexOf("configuration-observed:1") > device.events.indexOf("string:2"));
  assert.ok(device.events.indexOf("claim") > device.events.indexOf("string:2"));
  await connection.close();
});

test("Node USB bulk input request stays one packet when the declared frame ceiling is larger", async () => {
  const { device, connection } = await openFake();
  assert.equal(
    device.endpoints.get(0x84).pending[0].buffer.byteLength,
    64,
  );
  await connection.close();
});

test("read-only, write-only, and duplex channels do not pair endpoint numbers", async () => {
  const { device, connection } = await openFake();
  assert.deepEqual(connection.channels.map(({ id, direction }) => ({ id, direction })), [
    { id: "write-only", direction: "out" },
    { id: "read-only", direction: "in" },
    { id: "duplex", direction: "duplex" },
  ]);
  assert.ok(device.events.includes("submit:82:64"));
  assert.ok(device.events.includes("submit:84:64"));

  const readLease = await connection.channels[1].acquire("protocol");
  const received = readLease.incoming()[Symbol.asyncIterator]().next();
  device.endpoints.get(0x82).deliver(Uint8Array.of(1, 2, 3));
  assert.deepEqual((await received).value.bytes, Uint8Array.of(1, 2, 3));
  await readLease.release();

  const writeLease = await connection.channels[0].acquire("protocol");
  assert.equal((await writeLease.write(Uint8Array.of(4, 5))).outcome.kind, "accepted-by-platform");
  await writeLease.release();

  const duplexLease = await connection.channels[2].acquire("protocol");
  assert.equal((await duplexLease.write(new Uint8Array(64))).outcome.kind, "accepted-by-platform");
  assert.ok(device.events.includes("submit:7:64"));
  await duplexLease.release();

  await connection.close();
  assert.deepEqual(device.events.slice(-4), ["cancel:82", "cancel:84", "release:true", "close"]);
});

test("Node USB open preserves an active configuration and verifies selection before claim", async () => {
  const active = new FakeDevice();
  const activeConnection = (await openFake(active)).connection;
  assert.deepEqual(
    active.events.filter((event) => event.startsWith("configuration")),
    ["configuration-observed:1"],
    "an already selected configuration must be observed without being selected again",
  );
  assert.equal(active.events[0], "open:true", "native open must hydrate active host-side interfaces");
  assert.ok(active.events.indexOf("claim") > active.events.indexOf("configuration-observed:1"));
  await activeConnection.close();

  for (const initial of [undefined, 2]) {
    const changed = new FakeDevice();
    changed.activeConfigDescriptor = initial === undefined
      ? undefined
      : { ...changed.allConfigDescriptors[0], bConfigurationValue: initial };
    const changedConnection = (await openFake(changed)).connection;
    assert.deepEqual(
      changed.events.filter((event) => event.startsWith("configuration")),
      [
        `configuration-observed:${initial ?? "none"}`,
        "configuration:1",
        "configuration-observed:1",
      ],
    );
    assert.ok(changed.events.indexOf("claim") > changed.events.indexOf("configuration-observed:1", 1));
    await changedConnection.close();
  }

  const unchanged = new FakeDevice();
  unchanged.activeConfigDescriptor = undefined;
  unchanged.selectionTakesEffect = false;
  await assert.rejects(
    openFake(unchanged),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.usb.configuration-postcondition-failed",
  );
  assert.deepEqual(
    unchanged.events.filter((event) => event.startsWith("configuration")),
    ["configuration-observed:none", "configuration:1", "configuration-observed:none"],
  );
  assert.equal(unchanged.events.includes("claim"), false);
});

test("Node USB preserve-active never selects a configuration and requires a live declared interface", async () => {
  const preserveActive = structuredClone(profile);
  preserveActive.configurationValue = "preserve-active";
  for (const value of [1, 2, 3]) {
    const device = new FakeDevice();
    device.activeConfigDescriptor = {
      ...device.allConfigDescriptors[0],
      bConfigurationValue: value,
    };
    const { connection } = await openFake(device, preserveActive);
    assert.deepEqual(
      device.events.filter((event) => event.startsWith("configuration")),
      [`configuration-observed:${value}`],
      "preserve-active must not select any reported active configuration",
    );
    assert.ok(device.events.indexOf("claim") > device.events.indexOf(`configuration-observed:${value}`));
    await connection.close();
  }

  const unconfigured = new FakeDevice();
  unconfigured.activeConfigDescriptor = undefined;
  await assert.rejects(
    openFake(unconfigured, preserveActive),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.usb.configuration-postcondition-failed",
  );
  assert.deepEqual(
    unconfigured.events.filter((event) => event.startsWith("configuration")),
    ["configuration-observed:none"],
  );
  assert.equal(unconfigured.events.includes("claim"), false);

  const absentInterface = new FakeDevice();
  absentInterface.activeConfigDescriptor = {
    bConfigurationValue: 2,
    interfaces: [],
  };
  await assert.rejects(openFake(absentInterface, preserveActive), UsbProfilePolicyError);
  assert.equal(absentInterface.events.includes("claim"), false);
});

test("Node USB open observes alternate state, skips matching selection, and verifies changed selection", async () => {
  const matching = new FakeDevice();
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
  assert.ok(matching.events.indexOf("alternate-observed:0") > matching.events.indexOf("claim"));
  await matchingConnection.close();

  const changed = new FakeDevice();
  changed.currentAlternate = 1;
  const changedConnection = (await openFake(changed)).connection;
  assert.deepEqual(
    changed.events.filter((event) => event.startsWith("alternate")),
    ["alternate-observed:1", "alternate:0", "alternate-observed:0"],
  );
  await changedConnection.close();

  const matchingNonzero = new FakeDevice();
  matchingNonzero.currentAlternate = 1;
  matchingNonzero.usbInterface.installAlternate(1, matchingNonzero.endpoints);
  matchingNonzero.allConfigDescriptors[0].interfaces[0].push({
    bInterfaceNumber: 0,
    bAlternateSetting: 1,
    endpoints: Array.from(matchingNonzero.endpoints.values(), (endpoint) => endpoint.descriptor),
  });
  const nonzeroProfile = structuredClone(profile);
  nonzeroProfile.alternateSetting = 1;
  const nonzeroConnection = (await openFake(matchingNonzero, nonzeroProfile)).connection;
  assert.equal(matchingNonzero.usbInterface.altSetting, 1);
  assert.ok(matchingNonzero.events.includes("refresh:1"));
  assert.equal(matchingNonzero.events.includes("alternate:1"), false);
  await nonzeroConnection.close();

  const unchanged = new FakeDevice();
  unchanged.currentAlternate = 1;
  unchanged.alternateSelectionTakesEffect = false;
  await assert.rejects(
    openFake(unchanged),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.usb.alternate-postcondition-failed",
  );
  assert.deepEqual(
    unchanged.events.filter((event) => event.startsWith("alternate")),
    ["alternate-observed:1", "alternate:0", "alternate-observed:1"],
  );

  for (const invalidObservation of [
    undefined,
    Buffer.alloc(0),
    Buffer.of(0, 0),
    nativeError("GET_INTERFACE stalled", -9),
  ]) {
    const invalid = new FakeDevice();
    invalid.alternateObservationOverride = invalidObservation;
    await assert.rejects(
      openFake(invalid),
      (error) => error instanceof NodeUsbOpenError
        && error.error.code === "transport.usb.alternate-observation-failed",
    );
    assert.equal(invalid.events.some((event) => event.startsWith("alternate:")), false);
    assert.equal(invalid.events.some((event) => event.startsWith("submit:")), false);
  }
});

test("invalid declarations fail before the native interface is claimed", async () => {
  const device = new FakeDevice();
  const candidate = structuredClone(profile);
  candidate.channels[0].output.maximumPacketBytes = {};
  await assert.rejects(
    new NodeUsbTransport().open({
      device,
      profileId: "invalid",
      modeId: "normal",
      identity,
      speedEvidence: { kind: "reported", speed: "full" },
      profile: candidate,
    }),
    (error) => error.diagnostic?.code === "transport.usb.empty-packet-size-record"
      && error.diagnostic.declarationPath === "$open.profile.channels[0].output.maximumPacketBytes",
  );
  assert.equal(device.events.includes("claim"), false);
  assert.equal(device.events.at(-1), "close");
});

test("an active kernel driver fails visibly and is never detached", async () => {
  const device = new FakeDevice();
  device.usbInterface.kernelDriverActive = true;
  await assert.rejects(
    new NodeUsbTransport().open({
      device,
      profileId: "held",
      modeId: "normal",
      identity,
      speedEvidence: { kind: "reported", speed: "full" },
      profile,
    }),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.port-held",
  );
  assert.equal(device.events.includes("claim"), false);
  assert.equal(device.events.some((event) => event.includes("detach")), false);
});

test("an unavailable kernel-driver concept is explicit and leaves ownership to claim", async () => {
  const device = new FakeDevice();
  device.usbInterface.kernelDriverInspectionError = nativeError(
    "LIBUSB_ERROR_NOT_SUPPORTED",
    -12,
  );
  const { connection } = await openFake(device);
  assert.ok(
    device.events.indexOf("kernel-driver-check") < device.events.indexOf("claim"),
    "the unsupported inspection must not bypass the native claim",
  );
  await connection.close();

  const held = new FakeDevice();
  held.usbInterface.kernelDriverInspectionError = nativeError(
    "LIBUSB_ERROR_NOT_SUPPORTED",
    -12,
  );
  held.usbInterface.claimError = nativeError("interface busy", -6);
  await assert.rejects(
    openFake(held),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.port-held",
  );
  assert.ok(held.events.includes("claim"));
  assert.equal(held.events.includes("release:true"), false);
  assert.equal(held.events.at(-1), "close");
});

test("kernel-driver inspection failures other than not-supported still abort open", async () => {
  const device = new FakeDevice();
  device.usbInterface.kernelDriverInspectionError = nativeError("device gone", -4);
  await assert.rejects(
    openFake(device),
    (error) => error instanceof NodeUsbOpenError
      && error.error.code === "transport.open-failed"
      && error.error.platformCause?.serializableDetails.errno === -4,
  );
  assert.equal(device.events.includes("claim"), false);
  assert.equal(device.events.at(-1), "close");
});

test("usb.control validates the setup before the native vendor IN call", async () => {
  const { device, connection } = await openFake();
  const openingControlCalls = device.controlCalls.length;
  const invalid = await connection.control({
    kind: "usb.control",
    parameters: {
      direction: "device-to-host",
      requestType: "vendor",
      recipient: "device",
      request: 0x51,
      value: 1,
      index: 0,
      length: 16,
      extra: 1,
    },
  });
  assert.equal(invalid.settled, "failed");
  assert.equal(invalid.error.code, "transport.usb.invalid-control-request");
  assert.equal(device.controlCalls.length, openingControlCalls);

  const result = await connection.control({
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
  assert.equal(result.settled, "completed");
  assert.equal(result.payload.length, 16);
  assert.deepEqual(device.controlCalls.at(-1), {
    requestType: 0xc0,
    request: 0x51,
    value: 1,
    index: 0,
    dataOrLength: 16,
  });
  await connection.close();
});
