import type {
  CandidateId,
  CaptureDestinationId,
  CaptureId,
  CheckpointId,
  ClientId,
  GrantDescriptor,
  GrantId,
  OperationId,
  RawTerminalId,
  ResourceId,
  RpcCallId,
  RpcSessionEvent,
  SessionRpcEvent,
  SessionRpcMethod,
  SessionRpcOkResponse,
  SessionRpcRequest,
  SessionRpcResponse,
  SubscriptionId,
} from "../src/index.js";

const callId = "clone-call" as RpcCallId;
const clientId = "clone-client" as ClientId;
const operationId = "clone-operation" as OperationId;
const subscriptionId = "clone-subscription" as SubscriptionId;
const captureId = "clone-capture" as CaptureId;
const destinationId = "clone-destination" as CaptureDestinationId;
const checkpointId = "clone-checkpoint" as CheckpointId;
const terminalId = "clone-terminal" as RawTerminalId;
const resourceId = "clone-resource" as ResourceId;
const candidateId = "clone-candidate" as CandidateId;
const grant: GrantDescriptor = {
  grantId: "clone-grant" as GrantId,
  matchedFilters: [0, 2],
};

const error = {
  code: "clone.example",
  message: "representative wire error",
  retryability: "no",
  details: {
    exact: { type: "u64", value: "18446744073709551615" },
    bytes: { type: "bytes", encoding: "base64", value: "AP8=" },
  },
} as const;

const snapshot = {
  takenAtSequence: 19,
  state: "connected",
  currentMode: "application",
  connection: {
    modeId: "application",
    profileId: "serial",
    displayName: "Clone device",
  },
  stateCells: {
    voltage: {
      value: 3.3,
      quality: "valid",
      updatedAtMonotonicUs: 1234,
      updatedBySequence: 18,
      revision: 2,
    },
  },
  activeOperations: [operationId],
  retainedResults: [],
  maintenanceStatus: "active",
  scheduledWork: {
    policy: { burst: 4, refillEveryMs: 1000, minimumIntervalMs: 1000, maximumPlans: 4 },
    permitsRemaining: 3, creditCalculatedAtUs: 5000000, permitsSpent: 1,
    retiredResults: 1, historyDropped: 0,
    plans: [{ id: "application/query", mode: "application", operation: "query",
      cells: ["voltage"], nextDueUs: 35000000, activeOperation: null,
      last: { operationId, outcome: "failed", error } }],
  },
} as const;

const operationResult = {
  operationId,
  outcome: "completed",
  durationMs: 12,
  // A scalar is a valid result projection, so a record-only sample would let
  // it disappear at the wire without any test noticing.
  result: true,
  recoveries: [{
    kind: "after-recovery-reissue",
    failedAttempt: 1,
    reissuedAttempt: 2,
    error: {
      code: "authored.transfer.resume-required",
      message: "Authored transfer is not finished and requires resume",
      retryability: "after-recovery",
    },
  }],
} as const;

type RequestByMethod = {
  readonly [K in SessionRpcMethod]: Extract<SessionRpcRequest, { readonly kind: K }>;
};

export const SESSION_RPC_REQUEST_SAMPLES = {
  "attach-client": { kind: "attach-client", callId, params: { clientId } },
  "client-heartbeat": { kind: "client-heartbeat", callId, params: { clientId, sequence: 7 } },
  "detach-client": { kind: "detach-client", callId, params: { clientId } },
  "get-snapshot": { kind: "get-snapshot", callId, params: {} },
  "resolve-candidates": {
    kind: "resolve-candidates",
    callId,
    params: { request: { mode: "application", grant } },
  },
  connect: {
    kind: "connect",
    callId,
    params: { request: { mode: "application", candidateId, grant } },
  },
  disconnect: { kind: "disconnect", callId, params: { reason: "clone check" } },
  "start-operation": {
    kind: "start-operation",
    callId,
    params: {
      request: {
        operation: "write",
        arguments: {
          address: { kind: "value", value: { type: "u64", value: "9007199254740993" } },
          source: { kind: "resource", id: resourceId },
        },
      },
    },
  },
  "await-operation": { kind: "await-operation", callId, params: { operationId } },
  "acknowledge-operation": { kind: "acknowledge-operation", callId, params: { operationId } },
  "cancel-operation": { kind: "cancel-operation", callId, params: { operationId } },
  subscribe: { kind: "subscribe", callId, params: { subscriptionId, options: { replayLast: 4 } } },
  "subscribe-diagnostics": {
    kind: "subscribe-diagnostics",
    callId,
    params: {
      subscriptionId,
      options: { channelId: "main", direction: "rx", batchIntervalMs: 10, maximumBytesPerBatch: 4096 },
    },
  },
  unsubscribe: { kind: "unsubscribe", callId, params: { subscriptionId } },
  "inspect-checkpoint": { kind: "inspect-checkpoint", callId, params: { checkpointId } },
  "resume-transfer": {
    kind: "resume-transfer",
    callId,
    params: {
      request: {
        checkpointId,
        operation: "write",
        arguments: { source: { kind: "resource", id: resourceId } },
      },
    },
  },
  "open-raw-terminal": { kind: "open-raw-terminal", callId, params: { subscriptionId } },
  "write-raw-terminal": {
    kind: "write-raw-terminal",
    callId,
    params: { terminalId, bytes: new Uint8Array([0x10, 0x20]) },
  },
  "exit-raw-terminal": { kind: "exit-raw-terminal", callId, params: { terminalId } },
  "start-capture": {
    kind: "start-capture",
    callId,
    params: { destinationId, options: { sidecarThresholdBytes: 4096 } },
  },
  "stop-capture": { kind: "stop-capture", callId, params: { captureId } },
} satisfies RequestByMethod;

type OkResponseByMethod = {
  readonly [K in SessionRpcMethod]: Extract<SessionRpcOkResponse, { readonly method: K }>;
};

export const SESSION_RPC_OK_RESPONSE_SAMPLES = {
  "attach-client": {
    kind: "ok",
    method: "attach-client",
    callId,
    result: {
      heartbeatIntervalMs: 1000,
      missesAllowed: 3,
      declaredGoneAfterMs: 3000,
      reattachAllowed: true,
      multipleClientsAllowed: true,
    },
  },
  "client-heartbeat": { kind: "ok", method: "client-heartbeat", callId, result: null },
  "detach-client": { kind: "ok", method: "detach-client", callId, result: null },
  "get-snapshot": { kind: "ok", method: "get-snapshot", callId, result: snapshot },
  "resolve-candidates": {
    kind: "ok",
    method: "resolve-candidates",
    callId,
    result: [{
      candidateId,
      identity: {
        transport: "serial",
        portPath: "/dev/ttyUSB0",
        stableKeyAssurance: "path-derived",
        stableKey: "usb-1-2",
      },
      displayName: "Clone device",
      matchedProfileId: "serial",
    }],
  },
  connect: {
    kind: "ok",
    method: "connect",
    callId,
    result: { kind: "connected", modeId: "application", profileId: "serial", snapshot },
  },
  disconnect: { kind: "ok", method: "disconnect", callId, result: null },
  "start-operation": {
    kind: "ok",
    method: "start-operation",
    callId,
    result: { operationId, acceptedAtSequence: 20 },
  },
  "await-operation": { kind: "ok", method: "await-operation", callId, result: operationResult },
  "acknowledge-operation": { kind: "ok", method: "acknowledge-operation", callId, result: null },
  "cancel-operation": { kind: "ok", method: "cancel-operation", callId, result: null },
  subscribe: { kind: "ok", method: "subscribe", callId, result: null },
  "subscribe-diagnostics": { kind: "ok", method: "subscribe-diagnostics", callId, result: null },
  unsubscribe: { kind: "ok", method: "unsubscribe", callId, result: null },
  "inspect-checkpoint": {
    kind: "ok",
    method: "inspect-checkpoint",
    callId,
    result: { assurance: "verified" },
  },
  "resume-transfer": {
    kind: "ok",
    method: "resume-transfer",
    callId,
    result: {
      operationId,
      acceptedAtSequence: 30,
      assurance: "verified",
    },
  },
  "open-raw-terminal": {
    kind: "ok",
    method: "open-raw-terminal",
    callId,
    result: {
      terminalId,
      exitRequirement: {
        kind: "declared-recovery",
        strategy: "reconnect",
        message: "Reconnect before returning to protocol work.",
      },
    },
  },
  "write-raw-terminal": {
    kind: "ok",
    method: "write-raw-terminal",
    callId,
    result: {
      outcome: { kind: "accepted-by-platform" },
      requestedBytes: 2,
      atSequence: 31,
      taintsSession: false,
    },
  },
  "exit-raw-terminal": {
    kind: "ok",
    method: "exit-raw-terminal",
    callId,
    result: {
      kind: "recovered",
      recovery: {
        kind: "recovered",
        strategy: "reconnect",
        connectionReplaced: true,
        discardedBytes: 0,
      },
    },
  },
  "start-capture": { kind: "ok", method: "start-capture", callId, result: captureId },
  "stop-capture": {
    kind: "ok",
    method: "stop-capture",
    callId,
    result: {
      captureId,
      completeness: "complete",
      bytesWritten: 512,
      recordCount: 4,
      gapCount: 0,
      partCount: 1,
    },
  },
} satisfies OkResponseByMethod;

export const SESSION_RPC_ERROR_RESPONSE_SAMPLE = {
  kind: "error",
  method: "connect",
  callId,
  error,
} as const satisfies SessionRpcResponse;

type SessionEventByKind = {
  readonly [K in RpcSessionEvent["kind"]]: Extract<RpcSessionEvent, { readonly kind: K }>;
};

const RPC_SESSION_EVENT_SAMPLES = {
  "scheduled-work": {
    kind: "scheduled-work", sequence: 20,
    observation: { kind: "terminal", generation: 1, plan: "application/query", cells: ["voltage"],
      nextDueUs: 35000000, result: { operationId, outcome: "failed", result: null, durationMs: 500, error } },
  },
  state: {
    kind: "state",
    from: "opening",
    to: "connected",
    reason: "probe complete",
    sequence: 21,
  },
  "connection-open": { kind: "connection-open", connection: snapshot.connection!, sequence: 22 },
  "connection-close": { kind: "connection-close", reason: "unplugged", error, sequence: 23 },
  "operation-start": { kind: "operation-start", operationId, operation: "write", sequence: 24 },
  "operation-progress": {
    kind: "operation-progress",
    operationId,
    phase: "program",
    completed: 256,
    total: 1024,
    sequence: 25,
  },
  "transfer-progress": {
    kind: "transfer-progress",
    operationId,
    checkpointId,
    phase: "transferring",
    sequence: 26,
  },
  "operation-end": { kind: "operation-end", result: operationResult, sequence: 26 },
  "state-cells": { kind: "state-cells", changed: snapshot.stateCells, sequence: 27 },
  "mode-maintenance": {
    kind: "mode-maintenance",
    modeId: "application",
    operation: "maintain",
    status: "released-idle",
    sequence: 28,
  },
  "raw-terminal-bytes": {
    kind: "raw-terminal-bytes",
    terminalId,
    bytes: new Uint8Array([0xa5, 0x5a]),
    sequence: 29,
    tUs: 123456,
  },
  suspend: {
    kind: "suspend",
    observedGapMs: 1_800,
    heartbeatIntervalMs: 250,
    heartbeatLateByMs: 1_550,
    wallDeltaMs: 1_800,
    monotonicDeltaMs: 250,
    source: "heartbeat-overdue",
    sequence: 28,
  },
} satisfies SessionEventByKind;

type OuterEventByKind = {
  readonly [K in SessionRpcEvent["kind"]]: Extract<SessionRpcEvent, { readonly kind: K }>;
};

const OUTER_EVENT_SAMPLES = {
  event: { kind: "event", subscriptionId, event: RPC_SESSION_EVENT_SAMPLES.state },
  diagnostics: {
    kind: "diagnostics",
    subscriptionId,
    batch: {
      subscriptionId,
      records: [{
        sequence: 29,
        tUs: 123456,
        direction: "rx",
        channelId: "main",
        bytes: new Uint8Array([0xa5, 0x5a, 0xd3]),
      }],
      dropped: { records: 1, bytes: 7, firstUs: 120000, lastUs: 121000 },
    },
  },
  "client-evicted": { kind: "client-evicted", clientId, reason: error },
  "subscriber-evicted": { kind: "subscriber-evicted", subscriptionId, reason: error },
} satisfies OuterEventByKind;

export const SESSION_RPC_EVENT_SAMPLES: readonly SessionRpcEvent[] = [
  ...Object.values(RPC_SESSION_EVENT_SAMPLES).map((event) => ({
    kind: "event" as const,
    subscriptionId,
    event,
  })),
  OUTER_EVENT_SAMPLES.diagnostics,
  OUTER_EVENT_SAMPLES["client-evicted"],
  OUTER_EVENT_SAMPLES["subscriber-evicted"],
];

export const SESSION_RPC_CLONE_SAMPLES = [
  ...Object.values(SESSION_RPC_REQUEST_SAMPLES),
  ...Object.values(SESSION_RPC_OK_RESPONSE_SAMPLES),
  SESSION_RPC_ERROR_RESPONSE_SAMPLE,
  ...SESSION_RPC_EVENT_SAMPLES,
] as const;
