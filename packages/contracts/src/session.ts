import type { Brand } from "./brand.js";
import type { PdrError, PublicValue } from "./values.js";
import type { ResourceId } from "./resources.js";
import type { CandidateId, GrantDescriptor, SerializableCandidate } from "./acquisition.js";
import type {
  RawTerminalExitResult,
  RawTerminalHandle,
  RawTerminalId,
} from "./raw-terminal.js";
import type {
  CaptureDestinationId,
  CaptureId,
  CaptureOptions,
  CaptureSummary,
  DiagnosticBatch,
  DiagnosticSubscriptionOptions,
} from "./capture.js";
import type { TransferCheckpointPhase, TransferResumeIdentity } from "./transfer.js";
import type { WriteReceipt } from "./transport.js";

export type SessionId = Brand<string, "SessionId">;
export type OperationId = Brand<string, "OperationId">;
export type RpcCallId = Brand<string, "RpcCallId">;
export type SubscriptionId = Brand<string, "SubscriptionId">;
export type CheckpointId = Brand<string, "CheckpointId">;

export interface SessionOperationLock {
  readonly id: string;
  readonly owner: string;
}

/**
 * Identifies a CLIENT of the session, not the session itself. The worker
 * tracks liveness per client, so "the UI went away" is a fact about a
 * ClientId rather than an inference from a silent port.
 */
export type ClientId = Brand<string, "ClientId">;

export type SessionState =
  | "idle"
  | "selecting"
  | "opening"
  | "probing"
  | "connected"
  | "revalidation-required"
  | "resynchronizing"
  | "reconnecting"
  | "closing"
  | "closed"
  | "faulted";

/**
 * An operation argument is a scalar or a resource reference, never a bare
 * object. Resource ids keep large input outside the expression AST and the
 * RPC value payload: a 32-byte key and a 16 MB image must not arrive through
 * the same door.
 */
export type OperationArgument =
  | { readonly kind: "value"; readonly value: PublicValue }
  | { readonly kind: "resource"; readonly id: ResourceId };

export interface OperationRequest {
  readonly operation: string;
  readonly arguments: { readonly [name: string]: OperationArgument };
  /** Host-registered output sink for a declared authored file/resource result. */
  readonly resultDestinationId?: ResourceId;
}

export interface ResumeTransferRequest extends OperationRequest {
  readonly checkpointId: CheckpointId;
}

export interface CheckpointAssurance {
  readonly assurance: TransferResumeIdentity["assurance"];
  /** Authored inspection preserves the digest subject, never an implicit file hash. */
  readonly source?: import("./transfer.js").TransferCheckpoint["source"];
}

export interface OperationHandle {
  readonly operationId: OperationId;
  readonly acceptedAtSequence: number;
}

export interface ResumeTransferResult extends OperationHandle, CheckpointAssurance {}

export type OperationOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "resume-required"
  | "failed-with-incomplete-cleanup";

export interface AuthoredOperationCause {
  /** Stable author-owned name; consumers must branch on outcome, not this value. */
  readonly name: string;
  readonly details: PublicValue;
}

export interface OperationRecovery {
  readonly kind: "after-recovery-reissue";
  readonly failedAttempt: 1;
  readonly reissuedAttempt: 2;
  readonly error: PdrError;
}

export interface OperationResult {
  readonly operationId: OperationId;
  readonly outcome: OperationOutcome;
  readonly durationMs: number;
  readonly result: PublicValue;
  /** Counts at logical termination, never content. Late native receipts are separate capture facts. */
  readonly sourcePreparation?: PublicValue;
  /** Common service receipt; device-reported evidence is not independent read-back. */
  readonly transferReceipt?: PublicValue;
  /** Operation-level output receipt, never an arbitrary nested bytes field. */
  readonly resourceResult?: {
    readonly kind: "file" | "resource";
    readonly destinationId: ResourceId;
    readonly byteLength: number;
    readonly content: string;
    readonly mediaType: string;
    readonly suggestedExtension?: string;
    readonly digest?: { readonly authority: "host-observed"; readonly algorithm: "sha256"; readonly value: string;
      readonly subject: { readonly kind: "result-range"; readonly domain: string; readonly offset: number; readonly length: number } };
  };
  /** Snapshot at logical termination; late destination effects remain separate capture facts. */
  readonly outputProgress?: PublicValue;
  /** Present on a host-admitted authored `resume-required` terminal outcome. */
  readonly authoredCause?: AuthoredOperationCause;
  readonly error?: PdrError;
  /** Present only when the fixed one-reissue policy was exercised. */
  readonly recoveries?: readonly [OperationRecovery];
}

/* ------------------------------------------------------------------ *
 * Connecting
 * ------------------------------------------------------------------ */

export interface ConnectRequest {
  readonly mode?: string;
  /** Selected acquisition profile; required when the admitted mode has more than one. */
  readonly profile?: string;
  readonly candidateId?: CandidateId;
  /**
   * The WHOLE descriptor, obtained by the application inside a user-gesture
   * handler and passed across. Not a bare id: the session needs
   * `matchedFilters` to know which profiles the grant covers, and there is
   * no separate registration message that would let it resolve an id.
   */
  readonly grant?: GrantDescriptor;
}

/**
 * Connecting has two outcomes, and collapsing them was hiding a hole.
 *
 * The session cannot open a chooser, so when a grant covers several
 * indistinguishable devices it has nothing to do but hand the list back and
 * let the application ask. Without this variant there was no way for a
 * candidate id to reach the application at all, and `selecting` was a
 * session state nothing could produce.
 */
export type ConnectResult =
  | {
      readonly kind: "connected";
      readonly modeId: string;
      readonly profileId: string;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly kind: "selection-required";
      readonly candidates: readonly SerializableCandidate[];
    };

export interface CandidateRequest {
  readonly mode?: string;
  /** Narrows authorized enumeration to the host-selected admitted profile. */
  readonly profile?: string;
  readonly grant?: GrantDescriptor;
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface StateCellSnapshot {
  readonly value?: PublicValue;
  readonly quality: "unknown" | "valid" | "stale" | "invalid";
  readonly updatedAtMonotonicUs?: number;
  readonly updatedBySequence?: number;
  /** Preserved across invalidation, so "invalidated" differs from "never seen". */
  readonly revision: number;
}

export interface ConnectionSummary {
  readonly modeId: string;
  readonly profileId: string;
  readonly displayName: string;
}

/**
 * A coherent point-in-time view, built atomically. No field may tear
 * against another.
 *
 * `takenAtSequence` is what lets a client reconcile a snapshot against the
 * event stream without a race:
 *
 *   sequence <= takenAtSequence   already reflected here; discard
 *   sequence >  takenAtSequence   not yet applied; apply in order
 *
 * Stated with <= and > rather than "lower" and "higher" because equality
 * is the case that matters: the event AT takenAtSequence is the one the
 * snapshot was taken from, and a client that re-applies it double-counts.
 */
export interface SessionSnapshot {
  readonly takenAtSequence: number;
  readonly state: SessionState;
  readonly currentMode: string;
  readonly connection?: ConnectionSummary;
  readonly stateCells: { readonly [name: string]: StateCellSnapshot };
  readonly activeOperations: readonly OperationId[];
  /** Finished but not yet acknowledged. See awaitOperation below. */
  readonly retainedResults: readonly OperationId[];
  readonly maintenanceStatus: "active" | "released-idle";
  readonly fault?: PdrError;
  /** Bounded host-owned scheduled-service observation; absent without a plan. */
  readonly scheduledWork?: PublicValue;
}

export type RpcSessionEvent =
  | { readonly kind: "scheduled-work"; readonly observation: PublicValue; readonly sequence: number }
  | { readonly kind: "state"; readonly from: SessionState; readonly to: SessionState; readonly reason: string; readonly sequence: number }
  | { readonly kind: "connection-open"; readonly connection: ConnectionSummary; readonly sequence: number }
  | { readonly kind: "connection-close"; readonly reason: string; readonly error?: PdrError; readonly sequence: number }
  | { readonly kind: "operation-start"; readonly operationId: OperationId; readonly operation: string; readonly sequence: number }
  | { readonly kind: "operation-progress"; readonly operationId: OperationId; readonly phase: string; readonly completed: number; readonly total?: number; readonly sequence: number }
  | { readonly kind: "transfer-progress"; readonly operationId: OperationId; readonly checkpointId: CheckpointId; readonly phase: TransferCheckpointPhase; readonly sequence: number;
      readonly sourceSubject?: { readonly kind: "effective-range"; readonly offset: number; readonly length: number };
      readonly segmentation?: { readonly quantum: number; readonly index: number; readonly count: number; readonly submittedSourceOffset: number; readonly committedSourceOffset: number } }
  | { readonly kind: "operation-end"; readonly result: OperationResult; readonly sequence: number }
  | { readonly kind: "state-cells"; readonly changed: { readonly [name: string]: StateCellSnapshot }; readonly sequence: number }
  | { readonly kind: "mode-maintenance"; readonly modeId: string; readonly operation: string; readonly status: "active" | "released-idle"; readonly sequence: number }
  | { readonly kind: "raw-terminal-bytes"; readonly terminalId: RawTerminalId; readonly bytes: Uint8Array; readonly sequence: number; readonly tUs: number }
  | { readonly kind: "suspend"; readonly observedGapMs: number;
      readonly heartbeatIntervalMs: number; readonly heartbeatLateByMs: number;
      readonly wallDeltaMs: number; readonly monotonicDeltaMs: number;
      readonly source: "heartbeat-overdue"; readonly sequence: number };

export interface SubscriptionOptions {
  /** Bounded by HostResourceLimits.maximumEventReplayCount. */
  readonly replayLast?: number;
}

export interface Disposable {
  dispose(): void;
}

/** Local subscription handle. Its id is data and may name an owner-side stream. */
export interface SessionSubscription extends Disposable {
  readonly subscriptionId: SubscriptionId;
}

/* ------------------------------------------------------------------ *
 * The client lease
 *
 * Client loss has three distinct cases: normal detach, heartbeat-detected
 * absence, and abrupt termination. The wire contract must distinguish them
 * so cleanup does not depend on a local facade's assumptions.
 * ------------------------------------------------------------------ */

export interface ClientLeasePolicy {
  /**
   * Measured on the SESSION's clock, not the client's. A client whose
   * thread is blocked cannot be trusted to notice it is late, and a
   * deadline owned by the party that might be frozen is not a deadline.
   */
  readonly heartbeatIntervalMs: number;
  readonly missesAllowed: number;

  /**
   * A blocked main thread is indistinguishable from a dead one at the
   * protocol level, and this is the knob that decides which to assume.
   * The interval times the miss count should exceed the longest
   * synchronous stall the UI can legitimately produce.
   */
  readonly declaredGoneAfterMs: number;

  /**
   * Whether a reloaded UI may take over the same session rather than
   * starting a new one. Reattaching preserves the capture and any running
   * operation; refusing makes a page reload equivalent to a disconnect.
   */
  readonly reattachAllowed: boolean;

  /**
   * More than one is legitimate — a UI and a diagnostics window — and the
   * session ends only when the LAST client leaves. Bounded by
   * HostResourceLimits.maximumClientsPerSession.
   */
  readonly multipleClientsAllowed: boolean;
}

/* ------------------------------------------------------------------ *
 * The session RPC protocol
 *
 * THIS is what crosses the boundary — not DeviceSessionClient, which is a
 * local facade over it. Every field of every member below survives
 * structuredClone, enforced by src/wire-guard.ts rather than asserted.
 * ------------------------------------------------------------------ */

/**
 * ONE SOURCE OF TRUTH for the protocol: each method names its parameters
 * and its result, and the request and response unions are derived from it.
 *
 * A loose `value?: SessionSnapshot | ConnectResult | OperationHandle | ...`
 * let a broken adapter answer `get-snapshot` with an `OperationHandle`, or
 * omit a required result entirely, and still compile. The compiler was
 * checking that the response was SOME valid shape rather than the RIGHT
 * one, which is the weaker half of what a typed boundary is for.
 *
 * `null` rather than `void` for empty results: this is a DTO, and `void` is
 * not a value that survives a wire.
 */
export interface SessionRpcMethods {
  "attach-client": { readonly params: { readonly clientId: ClientId }; readonly result: ClientLeasePolicy };
  "client-heartbeat": {
    readonly params: { readonly clientId: ClientId; readonly sequence: number };
    readonly result: null;
  };
  "detach-client": { readonly params: { readonly clientId: ClientId }; readonly result: null };

  "get-snapshot": { readonly params: Record<string, never>; readonly result: SessionSnapshot };
  "resolve-candidates": {
    readonly params: { readonly request: CandidateRequest };
    readonly result: readonly SerializableCandidate[];
  };
  "connect": { readonly params: { readonly request: ConnectRequest }; readonly result: ConnectResult };
  "disconnect": { readonly params: { readonly reason?: string }; readonly result: null };

  "start-operation": { readonly params: { readonly request: OperationRequest }; readonly result: OperationHandle };
  "await-operation": { readonly params: { readonly operationId: OperationId }; readonly result: OperationResult };
  "acknowledge-operation": { readonly params: { readonly operationId: OperationId }; readonly result: null };
  "cancel-operation": { readonly params: { readonly operationId: OperationId }; readonly result: null };

  "subscribe": {
    readonly params: { readonly subscriptionId: SubscriptionId; readonly options?: SubscriptionOptions };
    readonly result: null;
  };
  "subscribe-diagnostics": {
    readonly params: { readonly subscriptionId: SubscriptionId; readonly options?: DiagnosticSubscriptionOptions };
    readonly result: null;
  };
  "unsubscribe": { readonly params: { readonly subscriptionId: SubscriptionId }; readonly result: null };

  "inspect-checkpoint": {
    readonly params: { readonly checkpointId: CheckpointId };
    readonly result: CheckpointAssurance;
  };
  "resume-transfer": {
    readonly params: { readonly request: ResumeTransferRequest };
    readonly result: ResumeTransferResult;
  };

  "open-raw-terminal": {
    readonly params: { readonly subscriptionId: SubscriptionId };
    readonly result: RawTerminalHandle;
  };
  "write-raw-terminal": {
    readonly params: { readonly terminalId: RawTerminalId; readonly bytes: Uint8Array };
    readonly result: WriteReceipt;
  };
  "exit-raw-terminal": {
    readonly params: { readonly terminalId: RawTerminalId };
    readonly result: RawTerminalExitResult;
  };

  "start-capture": {
    readonly params: { readonly destinationId: CaptureDestinationId; readonly options: CaptureOptions };
    readonly result: CaptureId;
  };
  "stop-capture": { readonly params: { readonly captureId: CaptureId }; readonly result: CaptureSummary };
}

export type SessionRpcMethod = keyof SessionRpcMethods;

export type SessionRpcRequest = {
  [K in SessionRpcMethod]: {
    readonly kind: K;
    readonly callId: RpcCallId;
    readonly params: SessionRpcMethods[K]["params"];
  };
}[SessionRpcMethod];

/**
 * `method` is carried on the response, not only `callId`. Correlating by
 * call id alone means the type of a result depends on state the type system
 * cannot see; carrying the method makes the pairing checkable.
 */
export type SessionRpcOkResponse = {
  [K in SessionRpcMethod]: {
    readonly kind: "ok";
    readonly method: K;
    readonly callId: RpcCallId;
    readonly result: SessionRpcMethods[K]["result"];
  };
}[SessionRpcMethod];

export type SessionRpcResponse =
  | SessionRpcOkResponse
  | { readonly kind: "error"; readonly method: SessionRpcMethod; readonly callId: RpcCallId; readonly error: PdrError };

/** The result type for one method, for adapter and facade implementations. */
export type SessionRpcResult<K extends SessionRpcMethod> = SessionRpcMethods[K]["result"];
export type SessionRpcParams<K extends SessionRpcMethod> = SessionRpcMethods[K]["params"];

export type SessionRpcEvent =
  | { readonly kind: "event"; readonly subscriptionId: SubscriptionId; readonly event: RpcSessionEvent }
  | { readonly kind: "diagnostics"; readonly subscriptionId: SubscriptionId; readonly batch: DiagnosticBatch }
  /** Sent, not requested: the session has given up on a client. */
  | { readonly kind: "client-evicted"; readonly clientId: ClientId; readonly reason: PdrError }
  /** Sent when a subscriber's lossless queue overflowed and it was dropped. */
  | { readonly kind: "subscriber-evicted"; readonly subscriptionId: SubscriptionId; readonly reason: PdrError };

export type SessionRpcMessage = SessionRpcRequest | SessionRpcResponse | SessionRpcEvent;

/* ------------------------------------------------------------------ *
 * The facade
 * ------------------------------------------------------------------ */

/**
 * A LOCAL FACADE over the protocol above, running in the caller's context.
 *
 * It may accept callbacks and AbortSignals and return Disposables — none of
 * those cross the boundary. `subscribe` retains the listener locally, sends
 * a `subscribe` message carrying a SubscriptionId, and invokes the function
 * as matching events arrive. The convenience is local by construction and
 * the wire sees only identifiers.
 *
 * Product hosts compose this facade with their concrete manifest or retained
 * session server. Those server-side owners are never proxied and do not
 * appear in this package's public surface.
 *
 * The Node adapter implements the same protocol without serialization. That
 * is what keeps the boundary from rotting in the host that does not need it.
 *
 * DELIVERY GUARANTEES
 *   operation-start and operation-end are lossless. They are the outcome,
 *       and dropping one loses the answer.
 *   operation-progress and transfer-progress are coalesced per operation,
 *       latest wins.
 *   state-cells is coalesced per cell, latest wins.
 *   state, connection-*, and suspend are lossless.
 *   DIAGNOSTICS ARE LOSSY BY DESIGN and travel on their own channel. They
 *       are high-rate byte traffic for a hex view, not lifecycle facts, and
 *       must never share a queue whose overflow policy assumes the latter.
 *
 * LOSSLESS IS BOUNDED
 *   Lossless, non-blocking, and unbounded session lifetime cannot all hold.
 *   Each subscriber has a queue of maximumLosslessQueueDepth; coalescible
 *   events replace in place. On overflow the SUBSCRIBER is evicted with
 *   `rpc.subscriber-overflow` and may re-subscribe and reconcile from a
 *   fresh snapshot. The session is never faulted because a subscriber
 *   stopped reading.
 *
 *   Dispatch is queued on BOTH adapters. postMessage gives the browser that
 *   separation for free; the Node direct adapter must do it deliberately,
 *   or slow CLI rendering runs inside the session's critical path.
 *
 * CLIENT LOSS is three cases, not one:
 *   normal detach       explicit detach-client; orderly cleanup GUARANTEED
 *   lost client         heartbeat absent past declaredGoneAfterMs on the
 *                       SESSION's clock; the worker evicts and ATTEMPTS
 *                       cleanup. It must not hold a device open for a
 *                       client that will not return.
 *   abrupt termination  the platform releases the device with the context;
 *                       orderly cleanup and the capture footer are BEST
 *                       EFFORT, not guaranteed — there may be no event loop
 *                       turn left in which to run either.
 */
export interface DeviceSessionClient {
  /** Establishes the lease. Every other call requires an attached client. */
  attach(clientId: ClientId): Promise<ClientLeasePolicy>;
  detach(clientId: ClientId): Promise<void>;

  getSnapshot(): Promise<SessionSnapshot>;

  /**
   * Enumerates what the grant authorized WITHOUT opening a chooser. The
   * application calls PermissionBroker.requestGrant() in its click handler,
   * passes the descriptor here, and disambiguates if more than one
   * candidate comes back.
   */
  resolveCandidates(request: CandidateRequest): Promise<readonly SerializableCandidate[]>;

  connect(request: ConnectRequest): Promise<ConnectResult>;
  disconnect(reason?: string): Promise<void>;

  startOperation(request: OperationRequest): Promise<OperationHandle>;

  /**
   * The RELIABLE completion channel, independent of subscription health.
   *
   * `operation-end` is an observation for anyone watching. It cannot also
   * be the answer to the caller who started the work: a fast operation can
   * finish before the caller subscribes, and an overflowing subscriber
   * would take the only copy of the result with it.
   *
   * Resolves immediately if the operation already finished, because the
   * result is RETAINED until acknowledged — that retention is what closes
   * the race rather than an ordering rule the contract cannot enforce.
   * Bounded by maximumRetainedOperationResults; the oldest acknowledged-
   * pending result is dropped first and its operation reported in
   * `SessionSnapshot.retainedResults` until then.
   */
  awaitOperation(operationId: OperationId): Promise<OperationResult>;
  acknowledgeOperation(operationId: OperationId): Promise<void>;

  /** Idempotent. Cancelling an unknown or finished operation resolves. */
  cancelOperation(operationId: OperationId): Promise<void>;

  /**
   * Dispatch rules, which a synchronous listener would otherwise violate:
   *   - a listener exception is caught and logged, and never aborts dispatch
   *   - listeners run in subscription order
   *   - a listener added during dispatch starts with the NEXT event
   *   - a listener removed during dispatch receives no later event in that
   *     dispatch
   *   - reentrant session mutations are queued until dispatch completes
   */
  subscribe(listener: (event: RpcSessionEvent) => void, options?: SubscriptionOptions): SessionSubscription;

  /**
   * High-rate, lossy, and separate. Raw bytes stay in the worker, so a
   * main-thread hex view can only exist if batches are delivered — without
   * this there is no contract through which a live hex view could be built.
   *
   * Implementations should carry these on a dedicated MessagePort rather
   * than the lifecycle queue: they are the traffic most likely to saturate
   * a channel and the traffic it matters least to preserve.
   */
  subscribeDiagnostics(
    listener: (batch: DiagnosticBatch) => void,
    options?: DiagnosticSubscriptionOptions,
  ): Disposable;

  inspectTransferCheckpoint(checkpointId: CheckpointId): Promise<CheckpointAssurance>;
  resumeTransfer(request: ResumeTransferRequest): Promise<ResumeTransferResult>;

  openRawTerminal(subscriptionId: SubscriptionId): Promise<RawTerminalHandle>;
  writeRawTerminal(terminalId: RawTerminalId, bytes: Uint8Array): Promise<WriteReceipt>;
  exitRawTerminal(terminalId: RawTerminalId): Promise<RawTerminalExitResult>;

  /**
   * The destination is registered on the OWNING side and referenced by id.
   * A directory handle and its picker live on the main thread; the recorder
   * lives in the worker; a method-bearing object cannot travel between them.
   */
  startCapture(destinationId: CaptureDestinationId, options: CaptureOptions): Promise<CaptureId>;
  stopCapture(captureId: CaptureId): Promise<CaptureSummary>;
}
