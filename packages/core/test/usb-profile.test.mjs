import assert from "node:assert/strict";
import test from "node:test";

import {
  nativeUsbInRequestBytes,
  UsbProfilePolicyError,
  validateUsbProfilePolicy,
} from "../src/usb-profile.ts";

const profile = {
  kind: "usb",
  configurationValue: 1,
  interfaceNumber: 0,
  alternateSetting: 0,
  channels: [
    {
      id: "requests",
      input: null,
      output: {
        endpointNumber: 1,
        transferType: "bulk",
        maximumPacketBytes: { full: 64, high: 512 },
      },
    },
    {
      id: "responses",
      input: {
        endpointNumber: 1,
        transferType: "bulk",
        maximumPacketBytes: { full: 64, high: 512 },
      },
      output: null,
    },
    {
      id: "telemetry",
      input: {
        endpointNumber: 2,
        transferType: "interrupt",
        maximumPacketBytes: { full: 64, high: 64 },
      },
      output: null,
    },
  ],
};

const descriptor = {
  configurationValue: 1,
  interfaceNumber: 0,
  alternateSetting: 0,
  endpoints: [
    { address: 0x01, direction: "output", transferType: "bulk", maximumPacketBytes: 64 },
    { address: 0x81, direction: "input", transferType: "bulk", maximumPacketBytes: 64 },
    { address: 0x82, direction: "input", transferType: "interrupt", maximumPacketBytes: 64 },
  ],
};

function changedProfile(mutator) {
  const copy = structuredClone(profile);
  mutator(copy);
  return copy;
}

function changedDescriptor(mutator) {
  const copy = structuredClone(descriptor);
  mutator(copy);
  return copy;
}

function rejects(code, path, candidateProfile = profile, candidateDescriptor = descriptor) {
  assert.throws(
    () => validateUsbProfilePolicy(
      candidateProfile,
      { kind: "reported", speed: "full" },
      candidateDescriptor,
    ),
    (error) => error instanceof UsbProfilePolicyError
      && error.diagnostic.code === code
      && error.diagnostic.declarationPath === path,
  );
}

test("native USB input stays one live packet instead of inheriting the fallback containment ceiling", () => {
  assert.equal(nativeUsbInRequestBytes({ transferType: "bulk", maximumPacketBytes: 64 }), 64);
});

test("USB profile resolves three independent directional endpoints", () => {
  const result = validateUsbProfilePolicy(
    profile,
    { kind: "reported", speed: "full" },
    descriptor,
  );
  assert.deepEqual(result.speedEvidence, { kind: "reported", speed: "full" });
  assert.deepEqual(result.matchingDeclaredSpeeds, ["full"]);
  assert.deepEqual(result.endpoints.map((endpoint) => ({
    channelId: endpoint.channelId,
    direction: endpoint.direction,
    address: endpoint.address,
    maximumPacketBytes: endpoint.maximumPacketBytes,
  })), [
    { channelId: "requests", direction: "output", address: 0x01, maximumPacketBytes: 64 },
    { channelId: "responses", direction: "input", address: 0x81, maximumPacketBytes: 64 },
    { channelId: "telemetry", direction: "input", address: 0x82, maximumPacketBytes: 64 },
  ]);
});

test("USB profile resolves unreported speed from one common packet-size key without calling it negotiated", () => {
  const result = validateUsbProfilePolicy(profile, { kind: "unreported" }, descriptor);
  assert.deepEqual(result.speedEvidence, { kind: "unreported" });
  assert.deepEqual(result.matchingDeclaredSpeeds, ["full"]);
  assert.deepEqual(result.endpoints.map(({ maximumPacketBytes }) => maximumPacketBytes), [64, 64, 64]);
});

test("USB profile retains every safe matching key when unreported packet sizes are ambiguous", () => {
  const equalSizes = singleEndpointProfile("interrupt", { full: 64, high: 64 });
  const result = validateUsbProfilePolicy(
    equalSizes,
    { kind: "unreported" },
    singleEndpointDescriptor("interrupt", 64),
  );
  assert.deepEqual(result.matchingDeclaredSpeeds, ["full", "high"]);
});

test("reported and unreported evidence intentionally differ only where speed remains unknowable", () => {
  const highOnly = singleEndpointProfile("interrupt", { high: 64 });
  const live = singleEndpointDescriptor("interrupt", 64);
  const result = validateUsbProfilePolicy(highOnly, { kind: "unreported" }, live);
  assert.deepEqual(result.matchingDeclaredSpeeds, ["high"]);
  assert.throws(
    () => validateUsbProfilePolicy(highOnly, { kind: "reported", speed: "full" }, live),
    (error) => error instanceof UsbProfilePolicyError
      && error.diagnostic.code === "transport.usb.missing-negotiated-speed",
  );
});

test("USB profile rejects unreported endpoint sizes with no common declared speed key", () => {
  const crossed = changedProfile((candidate) => {
    candidate.channels[0].output.maximumPacketBytes = { full: 64, high: 512 };
    candidate.channels[1].input.maximumPacketBytes = { high: 512 };
    candidate.channels[2].input.maximumPacketBytes = { full: 64, high: 64 };
  });
  const crossedDescriptor = changedDescriptor((candidate) => {
    candidate.endpoints[1].maximumPacketBytes = 512;
  });
  assert.throws(
    () => validateUsbProfilePolicy(crossed, { kind: "unreported" }, crossedDescriptor),
    (error) => error instanceof UsbProfilePolicyError
      && error.diagnostic.code === "transport.usb.no-common-packet-size-speed"
      && error.diagnostic.declarationPath === "$open.profile",
  );
});

test("USB profile accepts the legal packet-size domain for every supported type and speed", () => {
  const cases = [
    ["bulk", "full", 8],
    ["bulk", "full", 16],
    ["bulk", "full", 32],
    ["bulk", "full", 64],
    ["bulk", "high", 512],
    ["interrupt", "full", 1],
    ["interrupt", "full", 64],
    ["interrupt", "high", 1],
    ["interrupt", "high", 1024],
  ];
  for (const [transferType, speed, bytes] of cases) {
    assert.doesNotThrow(
      () => validateUsbProfilePolicy(
        singleEndpointProfile(transferType, { [speed]: bytes }),
        { kind: "reported", speed },
        singleEndpointDescriptor(transferType, bytes),
      ),
      `${speed}-speed ${transferType} ${bytes}`,
    );
  }
});

test("USB profile rejects every illegal packet-size domain by declaration path", () => {
  const cases = [
    ["bulk", "full", 7],
    ["bulk", "full", 63],
    ["bulk", "high", 64],
    ["bulk", "high", 1024],
    ["interrupt", "full", 65],
    ["interrupt", "high", 1025],
  ];
  for (const [transferType, speed, bytes] of cases) {
    assert.throws(
      () => validateUsbProfilePolicy(
        singleEndpointProfile(transferType, { [speed]: bytes }),
        { kind: "reported", speed },
        singleEndpointDescriptor(transferType, bytes),
      ),
      (error) => error instanceof UsbProfilePolicyError
        && error.diagnostic.code === "transport.usb.illegal-packet-size"
        && error.diagnostic.declarationPath === `$open.profile.channels[0].input.maximumPacketBytes.${speed}`,
      `${speed}-speed ${transferType} ${bytes}`,
    );
  }
});

test("USB profile rejects an endpoint missing the negotiated speed", () => {
  rejects(
    "transport.usb.missing-negotiated-speed",
    "$open.profile.channels[0].output.maximumPacketBytes.full",
    changedProfile((candidate) => { delete candidate.channels[0].output.maximumPacketBytes.full; }),
  );
});

test("USB profile rejects duplicate channel identifiers", () => {
  rejects(
    "transport.usb.duplicate-channel-id",
    "$open.profile.channels[1].id",
    changedProfile((candidate) => { candidate.channels[1].id = "requests"; }),
  );
});

test("USB profile rejects duplicate derived endpoint addresses", () => {
  rejects(
    "transport.usb.duplicate-endpoint-address",
    "$open.profile.channels[2].input",
    changedProfile((candidate) => { candidate.channels[2].input.endpointNumber = 1; }),
  );
});

test("USB profile rejects live direction and address disagreement", () => {
  rejects(
    "transport.usb.endpoint-descriptor-mismatch",
    "$open.profile.channels[1].input",
    profile,
    changedDescriptor((candidate) => { candidate.endpoints[1].direction = "output"; }),
  );
});

test("USB profile rejects a declared endpoint absent from the live descriptor", () => {
  rejects(
    "transport.usb.endpoint-descriptor-mismatch",
    "$open.profile.channels[1].input",
    profile,
    changedDescriptor((candidate) => { candidate.endpoints.splice(1, 1); }),
  );
});

test("USB profile rejects a declared transfer type that disagrees with the live descriptor", () => {
  rejects(
    "transport.usb.endpoint-descriptor-mismatch",
    "$open.profile.channels[1].input",
    profile,
    changedDescriptor((candidate) => { candidate.endpoints[1].transferType = "interrupt"; }),
  );
});

test("USB profile rejects a negotiated packet size that disagrees with the live descriptor", () => {
  rejects(
    "transport.usb.endpoint-descriptor-mismatch",
    "$open.profile.channels[1].input",
    changedProfile((candidate) => { candidate.channels[1].input.maximumPacketBytes.full = 32; }),
  );
});

test("USB profile rejects an empty packet-size record", () => {
  rejects(
    "transport.usb.empty-packet-size-record",
    "$open.profile.channels[0].output.maximumPacketBytes",
    changedProfile((candidate) => { candidate.channels[0].output.maximumPacketBytes = {}; }),
  );
});

test("USB profile rejects a channel with both directions null", () => {
  rejects(
    "transport.usb.invalid-channel",
    "$open.profile.channels[0]",
    changedProfile((candidate) => {
      candidate.channels[0].input = null;
      candidate.channels[0].output = null;
    }),
  );
});

function singleEndpointProfile(transferType, maximumPacketBytes) {
  return {
    kind: "usb",
    configurationValue: 1,
    interfaceNumber: 0,
    alternateSetting: 0,
    channels: [{
      id: "only",
      input: { endpointNumber: 1, transferType, maximumPacketBytes },
      output: null,
    }],
  };
}

function singleEndpointDescriptor(transferType, maximumPacketBytes) {
  return {
    configurationValue: 1,
    interfaceNumber: 0,
    alternateSetting: 0,
    endpoints: [{
      address: 0x81,
      direction: "input",
      transferType,
      maximumPacketBytes,
    }],
  };
}
