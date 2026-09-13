import type { Brand } from "./brand.js";
import type { PdrError } from "./values.js";
import type { OperationId, SessionId } from "./session.js";

export type ResourceId = Brand<string, "ResourceId">;
export type BrokerCallId = Brand<string, "BrokerCallId">;

/**
 * When a resource closes automatically. Not a permission — every scope may
 * be closed early by its registrar; the scope says what happens if nobody
 * does.
 *
 * "Every resource is invocation-scoped" was the earlier rule and it cannot
 * hold: a large source can be registered before an operation exists, and
 * a capture sink outlives every operation written through it.
 */
export type ResourceScope =
  | { readonly kind: "operation"; readonly sessionId: SessionId; readonly operationId: OperationId }
  | { readonly kind: "session"; readonly sessionId: SessionId }
  /**
   * Closed only by its owner. The file the operator picked before any
   * session existed, or a source retained across operations. This is the one
   * scope that can leak, so the broker reports outstanding host-scoped
   * resources at shutdown rather than closing them silently.
   */
  | { readonly kind: "host" };

export interface ResourceDescriptor {
  /** Undefined when the source cannot report a length in advance. */
  readonly byteLength: number | undefined;
  /** Presence of seek is what makes transfer resume possible. */
  readonly seekable: boolean;
  readonly digest?: { readonly algorithm: string; readonly value: string };
}

export interface ResourceReadResult {
  readonly data: ArrayBuffer;
  /**
   * Distinguishes the three cases a bare byte count cannot: a full read, a
   * legitimate short read with more to come, and end of source.
   */
  readonly eof: boolean;
}

/** What crosses the boundary. `callId` alone — an AbortSignal cannot clone. */
export interface BrokerCall {
  readonly callId: BrokerCallId;
  /** Exclusive bounded read delegation, issued by the owning broker. */
  readonly readGrantId?: string;
  readonly writeGrantId?: string;
}

/**
 * What a LOCAL caller may pass. The facade keeps the signal on its own side
 * and translates abort into `cancel(callId)`. Same split as
 * DeviceSessionClient versus the session RPC protocol.
 */
export interface BrokerCallOptions extends BrokerCall {
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------ *
 * Host-side implementations. LIVE OBJECTS — these never cross.
 * ------------------------------------------------------------------ */

/**
 * EOF originates HERE, not in the broker.
 *
 * A bare `Promise<number>` cannot distinguish zero-bytes-because-finished
 * from zero-bytes-because-nothing-is-available-yet, so a broker promising
 * an explicit `eof` on top of it would be reconstructing the distinction by
 * guesswork — and guessing wrong means a transfer that stops early and
 * verifies against the bytes it happened to get.
 */
export interface HostReadResult {
  readonly bytesRead: number;
  readonly eof: boolean;
}

export interface HostByteSource {
  /** Host-local provenance, not an authored or wire-supplied assertion. */
  readonly origin?: "file" | "memory" | "other";
  readonly byteLength: number | undefined;
  read(into: Uint8Array): Promise<HostReadResult>;
  seek?(offset: number): Promise<void>;
  close(): Promise<void>;
}

export interface HostByteSink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Registration is LOCAL; access is REMOTE.
 * ------------------------------------------------------------------ */

/**
 * Runs where the resource physically lives — usually the browser main
 * thread, since a file handle comes from a picker that requires a gesture.
 * Takes live objects and therefore never crosses a boundary.
 *
 * The registrar CHOOSES the scope, because only the registrar knows why the
 * resource exists.
 *
 * Splitting this out is the same correction made for the session facade: an
 * earlier draft put `registerSource(source: HostByteSource, ...)` on the
 * interface documented as "the boundary", which cannot be true of a method
 * taking an object with methods.
 */
export interface ResourceRegistrar {
  registerSource(source: HostByteSource, scope: ResourceScope): Promise<ResourceId>;
  registerSink(sink: HostByteSink, scope: ResourceScope): Promise<ResourceId>;

  /** Reports host-scoped resources still open. The only scope that leaks. */
  outstanding(): Promise<readonly ResourceId[]>;
}

/**
 * What the worker holds: identifiers and data, nothing live.
 *
 * Concurrency: ONE outstanding call per resource. A second concurrent call
 * on the same id rejects with `resource.call-in-flight`. A resource is a
 * stream, so serializing removes every ordering question rather than
 * answering it.
 *
 * Lifetime:
 *   operation   closed when the operation ends, whatever the outcome
 *   session     closed when the session ends
 *   host        closed only by its owner; reported if still open at shutdown
 *
 * Ending a session closes every OPERATION-scoped resource first, THEN every
 * session-scoped one, then reports host-scoped leaks. The order matters and
 * the reverse is a bug: the capture destination is session-scoped, so
 * closing it first would discard the record of every operation resource
 * that failed to close after it.
 *
 * An identifier is valid within its scope and nowhere else. Using a stale
 * one is `resource.unknown-id`, never a read of whatever now holds that
 * slot — so identifiers are not reused within a process.
 */
export interface ResourceBrokerClient {
  describe(id: ResourceId): Promise<ResourceDescriptor>;

  /** Optional broker extension: absence refuses B1, never falls back to ambient reads. */
  grantRead?(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadGrant>;
  /** B2: bounded reads within an exclusive finite source domain, not B1 materialization. */
  grantStream?(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadGrant>;
  /** B6: one append-only attempt into a fresh sink. Close retires the grant. */
  grantWrite?(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<string>;
  releaseRead?(id: ResourceId, grantId: string, call: BrokerCall): Promise<void>;

  read(id: ResourceId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadResult>;
  seek(id: ResourceId, offset: number, call: BrokerCall): Promise<void>;

  /** All-or-error. A partial write is reported as a failure, never success. */
  write(id: ResourceId, data: ArrayBuffer, call: BrokerCall): Promise<void>;

  /**
   * Best effort. If the call already completed, cancel resolves and the
   * result stands — a caller may observe "cancelled" and still receive
   * data, and must treat that data as delivered.
   */
  cancel(callId: BrokerCallId): Promise<void>;

  /** Idempotent. Closing twice is not an error. */
  close(id: ResourceId): Promise<void>;
}

export interface ResourceReadGrant extends ResourceDescriptor {
  readonly streaming?: true;
  readonly id: string;
  readonly operationId: OperationId;
  readonly origin: "file" | "memory" | "other";
  readonly scope: ResourceScope["kind"];
  readonly maximumBytes: number;
}

/* ------------------------------------------------------------------ *
 * Resource wire protocol
 * ------------------------------------------------------------------ */

export type ResourceRpcRequest =
  | { readonly kind: "grant-write"; readonly call: BrokerCall; readonly id: ResourceId; readonly operationId: OperationId; readonly maximumBytes: number }
  | { readonly kind: "grant-stream"; readonly call: BrokerCall; readonly id: ResourceId; readonly operationId: OperationId; readonly maximumBytes: number }
  | { readonly kind: "grant-read"; readonly call: BrokerCall; readonly id: ResourceId; readonly operationId: OperationId; readonly maximumBytes: number }
  | { readonly kind: "release-read"; readonly call: BrokerCall; readonly id: ResourceId; readonly grantId: string }
  | { readonly kind: "describe"; readonly call: BrokerCall; readonly id: ResourceId }
  | { readonly kind: "read"; readonly call: BrokerCall; readonly id: ResourceId; readonly maximumBytes: number }
  | { readonly kind: "seek"; readonly call: BrokerCall; readonly id: ResourceId; readonly offset: number }
  | { readonly kind: "write"; readonly call: BrokerCall; readonly id: ResourceId; readonly data: ArrayBuffer }
  | { readonly kind: "cancel"; readonly call: BrokerCall; readonly targetCallId: BrokerCallId }
  | { readonly kind: "close"; readonly call: BrokerCall; readonly id: ResourceId };

export type ResourceRpcResponse =
  | { readonly kind: "write-granted"; readonly callId: BrokerCallId; readonly grantId: string }
  | { readonly kind: "read-granted"; readonly callId: BrokerCallId; readonly grant: ResourceReadGrant }
  | { readonly kind: "described"; readonly callId: BrokerCallId; readonly descriptor: ResourceDescriptor }
  | { readonly kind: "read"; readonly callId: BrokerCallId; readonly result: ResourceReadResult }
  | { readonly kind: "ok"; readonly callId: BrokerCallId }
  | { readonly kind: "error"; readonly callId: BrokerCallId; readonly error: PdrError };

/**
 * Emitted to the owning side when the worker dies holding a resource, so
 * the registrar can close what the far side can no longer reach.
 */
export interface ResourceAbandoned {
  readonly id: ResourceId;
  readonly reason: PdrError;
}

/**
 * `read` returns a transferable ArrayBuffer, so bytes move rather than
 * being cloned — which neuters the buffer on the sending side. That is
 * correct: the broker's caller has handed it over. Do not add a defensive
 * copy to fix a bug caused by retaining it.
 */
