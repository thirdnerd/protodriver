import type { Brand } from "./brand.js";
import type { PhysicalDeviceIdentity } from "./acquisition.js";
import type { PdrError } from "./values.js";
import type { ResourceId } from "./resources.js";
import type { SessionId } from "./session.js";
import type {
  DeviceConnection,
  TransportTermination,
  WriteOutcome,
} from "./transport.js";

export type CaptureId = Brand<string, "CaptureId">;
export type CaptureDestinationId = Brand<string, "CaptureDestinationId">;

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

export interface DiagnosticRecord {
  readonly sequence: number;
  readonly tUs: number;
  readonly direction: "tx" | "rx";
  readonly channelId: string;
  readonly bytes: Uint8Array;
  /** The invocation these bytes belong to, where a dispatcher issued them. */
  readonly commandInvocation?: string;
}

export interface DiagnosticDropSummary {
  /** Exact until Number.MAX_SAFE_INTEGER, then saturated rather than wrapped. */
  readonly records: number;
  /** Exact until Number.MAX_SAFE_INTEGER, then saturated rather than wrapped. */
  readonly bytes: number;
  /** Earliest timestamp among the dropped observations. */
  readonly firstUs?: number;
  /** Latest timestamp among the dropped observations. */
  readonly lastUs?: number;
}

/**
 * Delivered across the boundary in batches. Raw bytes live in the worker,
 * so a main-thread hex view exists only if something carries them out.
 *
 * Lossy by design and never blocks anything. `dropped` is cumulative for
 * the subscription, so a viewer can render "14,288 bytes over 41 records
 * lost while paused" rather than silently showing a hole. `lastUs-firstUs`
 * is the exact envelope between dropped observations, not proof that loss
 * was continuous throughout that interval.
 */
export interface DiagnosticBatch {
  readonly subscriptionId: string;
  readonly records: readonly DiagnosticRecord[];
  readonly dropped: DiagnosticDropSummary;
}

export interface DiagnosticSubscriptionOptions {
  readonly channelId?: string;
  readonly direction?: "tx" | "rx";
  /** Coalescing window. Larger means fewer, bigger batches. */
  readonly batchIntervalMs?: number;
  readonly maximumBytesPerBatch?: number;
}

/**
 * The in-worker tap the batches are drawn from. A live object, host-side
 * only, and not part of the wire protocol.
 *
 * Bounded by HostResourceLimits.maximumDiagnosticBufferBytes. Works while a
 * lease is held and across a lease handoff.
 */
export interface DiagnosticTap {
  readonly records: AsyncIterable<DiagnosticRecord>;
  readonly dropped: DiagnosticDropSummary;
  close(): void;
}

/* ------------------------------------------------------------------ *
 * The destination
 * ------------------------------------------------------------------ */

export type CaptureCompleteness = "complete" | "incomplete";

export interface CaptureSummary {
  readonly captureId: CaptureId;
  readonly completeness: CaptureCompleteness;
  readonly bytesWritten: number;
  readonly recordCount: number;
  readonly gapCount: number;
  readonly partCount: number;
  /** Present when storage failed; the file is incomplete BECAUSE of this. */
  readonly storageError?: PdrError;
}

/**
 * A capture is a SET of streams, not one.
 *
 *     session.pdcap      the NDJSON record stream
 *     a3f.0.bin          a sidecar holding one oversized payload
 *     a3f.1.bin          ...
 *
 * A ByteSink writes one stream and cannot create named siblings, so the
 * recorder cannot take one.
 *
 * LIVE OBJECT, HOST SIDE ONLY. A directory handle and the picker that
 * produced it belong to the main thread; the recorder runs in the worker.
 * This never crosses — the worker holds a CaptureDestinationId and the
 * owning side resolves it. An earlier draft put this object directly in
 * `RecorderOptions`, which is the same cross-boundary mistake the session
 * facade had already been split to avoid.
 *
 * MORE THAN ONE IMPLEMENTATION, by feature detection. File System Access
 * is preferred but is NOT coextensive with Web Serial and WebUSB — Brave
 * ships the transports and disables the filesystem API — so a browser can
 * reach a device and be unable to hold a multi-part capture. Fallbacks are
 * OPFS, a single-file container, and a loudly bounded in-memory capture.
 */
export interface HostCaptureDestination {
  /**
   * `name` must be a portable leaf name, never a path.
   * The destination joins it beneath its own root, so containment holds on
   * write as well as read and a capture cannot reference outside itself even
   * deliberately or through platform-specific filename aliases.
   */
  openPart(name: string, options?: { readonly contentType?: string }): Promise<ResourceId>;
  commit(): Promise<void>;
  /**
   * Parts written so far remain and the record stream has no footer, so a
   * reader loads it as `incomplete` — which is the point. A capture of a
   * session that crashed is evidence.
   */
  abort(error: PdrError): Promise<void>;
}

/** LOCAL to the owning side, exactly like ResourceRegistrar. */
export interface CaptureDestinationRegistrar {
  register(destination: HostCaptureDestination, sessionId: SessionId): Promise<CaptureDestinationId>;
  release(id: CaptureDestinationId): Promise<void>;
}

export interface CaptureOptions {
  /** Records above this size open a sidecar part instead of inlining. */
  readonly sidecarThresholdBytes: number;
}

/**
 * Complete, or explicitly and locatably failed. Streams through to its
 * destination — which is how a browser session records a 16 MB transfer
 * without accumulating it in memory.
 *
 * In-worker object; the client drives it through startCapture/stopCapture.
 */
export interface Recorder {
  readonly captureId: CaptureId;
  readonly completeness: "recording" | CaptureCompleteness;
  /** Returns the summary. Silent failure is the thing this prevents. */
  close(): Promise<CaptureSummary>;
}

/* ------------------------------------------------------------------ *
 * Destination wire protocol
 *
 * The worker asks the owning side to act on a destination it cannot hold.
 * ------------------------------------------------------------------ */

export type CaptureRpcRequest =
  | {
      readonly kind: "open-part";
      readonly destinationId: CaptureDestinationId;
      readonly name: string;
      readonly contentType?: string;
    }
  | { readonly kind: "commit-destination"; readonly destinationId: CaptureDestinationId }
  | {
      readonly kind: "abort-destination";
      readonly destinationId: CaptureDestinationId;
      readonly error: PdrError;
    };

export type CaptureRpcResponse =
  | { readonly kind: "part-opened"; readonly resourceId: ResourceId }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly error: PdrError };

/* ------------------------------------------------------------------ *
 * The file format
 * ------------------------------------------------------------------ */

export interface CaptureBlobRef {
  /**
   * Resolved ONLY beneath the capture's own directory. Names outside the
   * portable leaf-name language and symlinks are rejected: a .pdcap is an
   * untrusted path-bearing format, exactly like a package archive.
   */
  readonly file: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * Header and footer are FRAMING records: they delimit the file and are not
 * events in the session's ordering, so they carry no `seq` or `tUs`. Every
 * other record carries both. Expressing that as one union is what lets a
 * compiler catch a byte record with no `conn`, a settled record with no
 * `ref`, or a footer that picked up event fields.
 */
export interface CaptureHeader {
  readonly kind: "header";
  readonly formatVersion: 1;
  readonly captureId: CaptureId;
  readonly startedAtUnixMs: number;
  readonly timebase: "monotonic-us";
  readonly clockResolutionUs: number;
  readonly logicalDevice: string;
  readonly host: {
    readonly platform: "node" | "web";
  };
  readonly completeness: "recording";
  /**
   * Omission in a pre-Phase-3 capture means `incomplete`. New recorders
   * always write this field; replay never infers the missing facts.
   */
  readonly causalFacts: "complete" | "incomplete";
}

export interface CaptureFooter {
  readonly kind: "footer";
  readonly endedAtUnixMs: number;
  readonly completeness: CaptureCompleteness;
  readonly replayability: ReplayabilityClass;
  readonly recordCount: number;
  readonly gapCount: number;
  readonly connections: number;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly storageError?: PdrError;
}

interface CaptureRecordBase {
  readonly seq: number;
  readonly tUs: number;
}

interface ByteRecordCommon extends CaptureRecordBase {
  /** Connection ordinal, so one file holds a multi-connection operation. */
  readonly conn: number;
  readonly ch: string;
  /**
   * Inline attribution is known before a dispatcher transmits. New receive
   * attribution is positioned after decoding and routing instead, because a
   * single observed delivery may contain bytes from several causes.
   */
  readonly commandInvocation?: string;
}

type ByteRecordBase = ByteRecordCommon & (
  | { readonly data: string; readonly blob?: never }
  | { readonly data?: never; readonly blob: CaptureBlobRef }
);

export interface CapturedChannelDeclaration {
  readonly id: string;
  readonly direction: "in" | "out" | "duplex";
}

export interface CapturedControlResult {
  readonly settled: "completed" | "unsupported" | "failed";
  /** Canonical base64. Absence means no payload when causalFacts is complete. */
  readonly payload?: string;
  readonly error?: PdrError;
}

/**
 * Names describe what the HOST OBSERVED, not what crossed the wire — an
 * adapter learns only that bytes were handed to a platform, so a record
 * claiming a transmission claims evidence nobody has.
 */
export type CaptureRecord =
  | ({ readonly kind: "tx-requested" } & ByteRecordBase)
  | ({ readonly kind: "tx-settled"; readonly ref: number; readonly outcome: WriteOutcome } & CaptureRecordBase)
  | ({ readonly kind: "rx-delivered" } & ByteRecordBase)
  | ({
      /** Positioned classification of part of an earlier receive delivery. */
      readonly kind: "byte-attribution";
      /** Sequence of the earlier `rx-delivered` record. */
      readonly ref: number;
      readonly offsetBytes: number;
      readonly lengthBytes: number;
      readonly commandInvocation: string;
    } & CaptureRecordBase)
  | ({
      readonly kind: "control-requested";
      readonly conn: number;
      readonly capability: string;
      readonly request: import("./values.js").PublicValue;
      /** Canonical base64. Absence means no payload when causalFacts is complete. */
      readonly payload?: string;
    } & CaptureRecordBase)
  | ({ readonly kind: "control-settled"; readonly ref: number; readonly result: CapturedControlResult } & CaptureRecordBase)
  | ({
      readonly kind: "connection-open";
      readonly conn: number;
      readonly profileId: string;
      /** Required when the header declares complete causal facts. */
      readonly modeId?: string;
      /** Required when the header declares complete causal facts. */
      readonly identity?: PhysicalDeviceIdentity;
      /** Required when the header declares complete causal facts. */
      readonly channels?: readonly CapturedChannelDeclaration[];
    } & CaptureRecordBase)
  | ({
      readonly kind: "connection-close";
      readonly conn: number;
      /** Required when the header declares complete causal facts. */
      readonly termination?: TransportTermination;
      /** Pre-Phase-3 receive-only evidence; never promoted into a termination. */
      readonly reason?: string;
    } & CaptureRecordBase)
  | ({ readonly kind: "state"; readonly from: string; readonly to: string; readonly reason: string } & CaptureRecordBase)
  | ({ readonly kind: "event"; readonly name: string } & CaptureRecordBase)
  | ({ readonly kind: "gap"; readonly reason: "recorder-overrun"; readonly droppedBytes: number; readonly droppedRecords: number } & CaptureRecordBase)
  | ({ readonly kind: "suspend"; readonly observedGapMs: number } & CaptureRecordBase);

export type CaptureLine = CaptureHeader | CaptureRecord | CaptureFooter;

export type ReplayabilityClass = "byte-exact-replayable" | "diagnostic-only";
