import assert from "node:assert/strict";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { createNodeAuthoredAcquisition } from "../src/authored-acquisition.ts";
import { nodeSerialPathCandidate } from "../src/node-authored-candidates.ts";

const lifecycle = Object.freeze({
  openingDrainQuietMs: 37,
  postTerminationSilence: Object.freeze({
    minimumMs: 250,
    afterAbnormalTermination: true,
    afterModeExit: false,
  }),
});
const line = Object.freeze({
  kind: "serial",
  baudRate: 115_200,
  dataBits: 8,
  parity: "even",
  stopBits: 2,
  flowControl: "hardware",
});

function serialProfile() {
  return {
    id: "serial",
    modes: ["main"],
    acquisitionFilters: [{ transport: "serial", vendorId: 0x1209, productId: 0xd001 }],
    transport: line,
    channels: [{ id: "main", protocolDuplex: "full-duplex" }],
    lifecycle,
  };
}

function description(profile = serialProfile()) {
  return {
    apiVersion: "device/v2",
    id: "serial-path-fixture",
    modes: ["main"],
    profiles: [profile.id],
    connectionProfiles: { [profile.id]: profile },
    operations: [{
      id: "noop",
      title: "Noop",
      binding: "noop",
      arguments: {},
      result: { kind: "none" },
      risk: "read-only",
      repeatability: "safe-to-repeat",
      locks: [],
      requires: [],
      availability: { modes: ["main"], profiles: [profile.id] },
    }],
  };
}

test("an operator-named serial path constructs path-only identity and opens with the admitted serial policy", async () => {
  const profile = serialProfile();
  Object.defineProperty(profile, "acquisitionFilters", {
    get() { throw new Error("direct serial path consulted discovery filters"); },
  });
  const opened = Object.freeze({ fixture: "connection" });
  let openOptions;
  const selected = nodeSerialPathCandidate(
    profile,
    "main",
    new VirtualClock(),
    "/dev/pts/3",
    { async open(options) { openOptions = options; return opened; } },
  );

  assert.deepEqual(selected.candidate, {
    candidateId: "serial:/dev/pts/3",
    displayName: "Operator-selected serial path /dev/pts/3",
    matchedProfileId: "serial",
    identity: {
      transport: "serial",
      portPath: "/dev/pts/3",
      stableKeyAssurance: "path-derived",
      stableKey: "/dev/pts/3",
    },
  });
  assert.equal(await selected.open(), opened);
  assert.deepEqual(openOptions, {
    path: "/dev/pts/3",
    profileId: "serial",
    modeId: "main",
    identity: selected.candidate.identity,
    line,
    lifecycle,
    protocolDuplex: "full-duplex",
  });
  assert.equal("vendorId" in selected.candidate.identity, false);
  assert.equal("productId" in selected.candidate.identity, false);
  assert.equal("manufacturerName" in selected.candidate.identity, false);
  assert.equal("serialNumber" in selected.candidate.identity, false);

  assert.throws(
    () => nodeSerialPathCandidate({ ...serialProfile(), channels: [{ id: "alternate", protocolDuplex: "full-duplex" }] },
      "main", new VirtualClock(), "/dev/pts/3"),
    /Node serial supports only the main channel/u,
  );
});

test("an operator-named serial path skips enumeration even when descriptor filters would reject it", async () => {
  let enumerations = 0;
  const acquire = createNodeAuthoredAcquisition(async () => {
    enumerations += 1;
    throw new Error("direct serial path enumerated ports");
  });
  const grant = await acquire(description(), { serialPath: "/dev/pts/3" });
  assert.equal(enumerations, 0);
  assert.equal(grant.modeId, "main");
  assert.equal(grant.profileId, "serial");
  assert.equal(typeof grant.open, "function");
});

test("an unknown candidate id remains an enumerated-set selection rather than becoming a serial path", async () => {
  let enumerations = 0;
  const acquire = createNodeAuthoredAcquisition(async () => {
    enumerations += 1;
    return [{
      candidate: {
        candidateId: "serial:/dev/ttyUSB0",
        displayName: "enumerated fixture",
        matchedProfileId: "serial",
        identity: { transport: "serial", stableKeyAssurance: "none" },
      },
      async open() { throw new Error("unknown candidate must not open"); },
    }];
  });
  await assert.rejects(
    acquire(description(), { candidateId: "serial:/dev/pts/3" }),
    error => error.error?.code === "authored.acquisition.candidate"
      && error.error.responsibility === "invocation",
  );
  assert.equal(enumerations, 1);
});

test("serial path selection refuses USB profiles and conflicting candidate selection as invocation errors", async () => {
  const acquire = createNodeAuthoredAcquisition(async () => {
    throw new Error("refused selections must not enumerate");
  });
  await assert.rejects(
    acquire(description(), { candidateId: "opaque", serialPath: "/dev/pts/3" }),
    error => error.error?.code === "cli.option.conflict"
      && error.error.responsibility === "invocation",
  );

  const usb = {
    id: "usb",
    modes: ["main"],
    acquisitionFilters: [{ transport: "usb", vendorId: 0x1209, productId: 0xd001 }],
    transport: { kind: "usb" },
  };
  await assert.rejects(
    acquire(description(usb), { serialPath: "/dev/pts/3" }),
    error => error.error?.code === "authored.acquisition.serial-path-profile"
      && error.error.responsibility === "invocation",
  );
});
