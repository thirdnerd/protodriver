import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { AcquisitionError, SessionAcquisition } from "../src/acquisition.ts";
import {
  DeviceSessionRpcClient,
  PostMessageSessionRpcAdapter,
  serveSessionRpc,
} from "../src/rpc.ts";

const device1A = {
  candidateId: "device-1-a",
  identity: {
    transport: "serial",
    vendorId: 0x1a86,
    productId: 0x7523,
    manufacturerName: "wch.cn",
    productName: "USB2.0-Serial",
    portPath: "/dev/ttyUSB0",
    stableKeyAssurance: "path-derived",
    stableKey: "path:/dev/ttyUSB0",
  },
  displayName: "D1-CHAN on /dev/ttyUSB0",
  matchedProfileId: "device-1-serial",
  ambiguousWith: ["device-1-b"],
};

const device1B = {
  candidateId: "device-1-b",
  identity: {
    transport: "serial",
    vendorId: 0x1a86,
    productId: 0x7523,
    manufacturerName: "wch.cn",
    productName: "USB2.0-Serial",
    portPath: "/dev/ttyUSB2",
    stableKeyAssurance: "path-derived",
    stableKey: "path:/dev/ttyUSB2",
  },
  displayName: "D1-CHAN on /dev/ttyUSB2",
  matchedProfileId: "device-1-serial",
  ambiguousWith: ["device-1-a"],
};

const nesApplication = {
  candidateId: "nes-application",
  identity: {
    transport: "usb",
    vendorId: 0x057e,
    productId: 0x2042,
    manufacturerName: "Nintendo Co., Ltd.",
    productName: "CLV-S-NES",
    serialNumber: "0123456789ABCDEF0123",
    stableKeyAssurance: "serial-number",
    stableKey: "serial:0123456789ABCDEF0123",
  },
  displayName: "NES Classic application mode",
  matchedProfileId: "nes-usb",
};

const snapshot = {
  takenAtSequence: 1,
  state: "connected",
  currentMode: "application",
  stateCells: {},
  activeOperations: [],
  retainedResults: [],
  maintenanceStatus: "active",
};

class EventQueue {
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {});
  }
}

test("a whole grant reaches worker resolution and operator selection without a chooser", async () => {
  const grantsSeenByWorker = [];
  const connectedCandidates = [];
  const acquisition = new SessionAcquisition({
    service: {
      async listAuthorized(profiles, grant) {
        grantsSeenByWorker.push(structuredClone(grant));
        assert.deepStrictEqual(profiles, grant.grantId === "grant-nes"
          ? ["nes-usb"]
          : ["device-1-serial"]);
        return grant.grantId === "grant-nes" ? [nesApplication] : [device1A, device1B];
      },
    },
    profileIdsForMode: (mode) => mode === "nes" ? ["nes-usb"] : ["device-1-serial"],
    async connectCandidate(candidate) {
      connectedCandidates.push(candidate);
      return {
        kind: "connected",
        modeId: candidate.candidateId === "nes-application" ? "nes" : "application",
        profileId: candidate.matchedProfileId,
        snapshot,
      };
    },
  });
  const server = {
    events: new EventQueue(),
    async handle(request) {
      try {
        if (request.kind === "resolve-candidates") {
          return {
            kind: "ok",
            method: request.kind,
            callId: request.callId,
            result: await acquisition.resolveCandidates(request.params.request),
          };
        }
        if (request.kind === "connect") {
          return {
            kind: "ok",
            method: request.kind,
            callId: request.callId,
            result: await acquisition.connect(request.params.request),
          };
        }
        throw new Error(`acquisition server does not handle ${request.kind}`);
      } catch (cause) {
        if (!(cause instanceof AcquisitionError)) throw cause;
        return {
          kind: "error",
          method: request.kind,
          callId: request.callId,
          error: cause.error,
        };
      }
    },
  };
  const { port1, port2 } = new MessageChannel();
  const service = serveSessionRpc(port2, server);
  const adapter = new PostMessageSessionRpcAdapter(port1);
  const client = new DeviceSessionRpcClient(adapter);

  let clickHandlerActive = true;
  const permissionBroker = {
    async requestGrant(filters) {
      assert.equal(clickHandlerActive, true, "permission chooser escaped its click handler");
      assert.equal(filters.length, 3);
      return { grantId: "grant-device-1", matchedFilters: [0, 2] };
    },
  };

  try {
    const grantPromise = permissionBroker.requestGrant([
      { profileId: "device-1-serial", transport: "serial", vendorId: 0x1a86, productId: 0x7523 },
      { profileId: "nes-usb", transport: "usb", vendorId: 0x057e },
      { profileId: "device-1-fallback", transport: "serial", vendorId: 0x1a86 },
    ]);
    clickHandlerActive = false;
    const grant = await grantPromise;

    const candidates = await client.resolveCandidates({ mode: "application", grant });
    assert.deepStrictEqual(candidates, [device1A, device1B]);
    assert.deepStrictEqual(candidates.map(({ ambiguousWith }) => ambiguousWith), [
      ["device-1-b"],
      ["device-1-a"],
    ]);
    assert.deepStrictEqual(
      candidates.map(({ displayName, identity }) => ({ displayName, portPath: identity.portPath })),
      [
        { displayName: "D1-CHAN on /dev/ttyUSB0", portPath: "/dev/ttyUSB0" },
        { displayName: "D1-CHAN on /dev/ttyUSB2", portPath: "/dev/ttyUSB2" },
      ],
    );

    const selection = await client.connect({ mode: "application", grant });
    assert.equal(selection.kind, "selection-required");
    assert.deepStrictEqual(selection.candidates, candidates);

    const connected = await client.connect({
      mode: "application",
      grant,
      candidateId: candidates[1].candidateId,
    });
    assert.equal(connected.kind, "connected");
    assert.equal(connected.profileId, "device-1-serial");
    assert.equal(connectedCandidates.at(-1).candidateId, "device-1-b");

    const nesGrant = { grantId: "grant-nes", matchedFilters: [1] };
    const direct = await client.connect({ mode: "nes", grant: nesGrant });
    assert.equal(direct.kind, "connected");
    assert.equal(connectedCandidates.at(-1).candidateId, "nes-application");
    assert.equal(connectedCandidates.at(-1).identity.serialNumber, "0123456789ABCDEF0123");

    assert.deepStrictEqual(grantsSeenByWorker, [
      grant,
      grant,
      grant,
      nesGrant,
    ]);

    const malformed = await adapter.request({
      kind: "resolve-candidates",
      callId: "bare-grant-test",
      params: { request: { grant: { grantId: "grant-device-1" } } },
    });
    assert.equal(malformed.kind, "error");
    assert.equal(malformed.error.code, "acquisition.invalid-grant");
    assert.match(malformed.error.message, /whole grant descriptor/);
    assert.equal(grantsSeenByWorker.length, 4, "bare grant reached the provider");
  } finally {
    await client.close();
    service.dispose();
  }
});

test("raw USB observations survive without being promoted to stable identity", async () => {
  const serials = ["A1B2C3D", "000000000001", "SF30 Pro    ", undefined];
  const products = ["Controller", "Pro Controller", "8Bitdo SN30 Pro", "Wireless Controller"];
  const candidates = serials.map((serialNumber, index) => ({
    candidateId: `8bitdo-${index}`,
    identity: {
      transport: "usb",
      vendorId: [0x045e, 0x057e, 0x2dc8, 0x054c][index],
      productId: [0x028e, 0x2009, 0x6001, 0x05c4][index],
      manufacturerName: [
        "8Bitdo SF30 Pro  ",
        "Nintendo Co., Ltd.",
        "8Bitdo SF30 Pro  ",
        "Sony Computer Entertainment",
      ][index],
      productName: products[index],
      ...(serialNumber === undefined ? {} : { serialNumber }),
      stableKeyAssurance: "none",
    },
    displayName: `SF30 Pro presentation ${index + 1}`,
    matchedProfileId: "8bitdo-usb",
  }));
  const acquisition = new SessionAcquisition({
    service: { async listAuthorized() { return candidates; } },
    profileIdsForMode: () => ["8bitdo-usb"],
    async connectCandidate() { throw new Error("not used"); },
  });

  const resolved = await acquisition.resolveCandidates({});
  assert.deepStrictEqual(
    resolved.map(({ identity }) => ({
      manufacturerName: identity.manufacturerName,
      productName: identity.productName,
      serialNumber: identity.serialNumber,
      stableKeyAssurance: identity.stableKeyAssurance,
      stableKey: identity.stableKey,
    })),
    candidates.map(({ identity }) => ({
      manufacturerName: identity.manufacturerName,
      productName: identity.productName,
      serialNumber: identity.serialNumber,
      stableKeyAssurance: "none",
      stableKey: undefined,
    })),
  );
});
