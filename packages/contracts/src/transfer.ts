import type { Clock } from "./clock.js";
import type { StableKeyAssurance } from "./acquisition.js";
import type { HostResourceLimits } from "./limits.js";
import type { HostByteSource } from "./resources.js";
import type { PlatformCauseSnapshot } from "./values.js";
import type { LuaSourceSetIdentity } from "./lua-source-set.js";

/** Selector supplied to a protocol-specific transfer adapter. */
export interface MessageSelector {
  readonly kind: number | string;
  readonly opcode: number | string;
}

export type PackedBcdLayoutValue =
  | { readonly kind: "value"; readonly value: number | bigint }
  | { readonly kind: "special"; readonly name: string };

export interface DecimalLayoutValue {
  readonly kind: "decimal";
  readonly value: number;
  readonly suffix: string | null;
}

export interface TaggedUnionLayoutValue {
  readonly kind: string;
  readonly fields: Readonly<Record<string, LayoutFieldValue>>;
}

export type LayoutFieldValue =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly string[]
  | PackedBcdLayoutValue
  | DecimalLayoutValue
  | TaggedUnionLayoutValue;

/** Decoded observation supplied by a transfer adapter, not a host codec. */
export interface DecodedLayout {
  readonly identity: MessageSelector;
  /** Absent optional fields are omitted, never represented as null. */
  readonly fields: Readonly<Record<string, LayoutFieldValue>>;
  /** Exact defensive copy of the payload supplied by the adapter. */
  readonly sourcePayload: Uint8Array;
}

export type TransferDirection = "hostToDevice" | "deviceToHost";
export type TransferByteDomain = "source" | "transmitted" | "target";

/** Transfer digest vocabulary executable by every host admitting the declaration. */
export const TRANSFER_DIGEST_ALGORITHMS = Object.freeze(["sha256"] as const);

export type TransferDigestAlgorithm = typeof TRANSFER_DIGEST_ALGORITHMS[number];

export function isTransferDigestAlgorithm(value: string): value is TransferDigestAlgorithm {
  return (TRANSFER_DIGEST_ALGORITHMS as readonly string[]).includes(value);
}

export interface TransferEffectiveRange {
  readonly sourceOffset: number;
  readonly targetOffset: number;
  readonly length: number;
}

export type TransferBindingValueKind = "integer" | "bytes";

export type TransferBindingInitializerContract =
  | { readonly kind: "source-length" }
  | { readonly kind: "source-digest"; readonly algorithm: TransferDigestAlgorithm };

export interface TransferBindingContract {
  readonly name: string;
  readonly valueKind: TransferBindingValueKind;
  /** Engine facts are initialized before recipes; carrier results omit this. */
  readonly initialize?: TransferBindingInitializerContract;
}

export interface TransferRecipeBindingContract {
  readonly binding: string;
  readonly path: readonly string[];
}

export interface TransferRecipeActionContract {
  /** Reference to an action declared by the carrier; never an unrestricted kind. */
  readonly action: string;
  readonly maximumWaitMs: number;
  /** True when starting this action may change device state irreversibly. */
  readonly destructive: boolean;
}

export interface TransferDataActionContract {
  /** Reference to the direction's bounded data action recipe. */
  readonly action: string;
  readonly maximumWaitMs: number;
  readonly sourceOffset: number;
  readonly targetOffset: number;
  readonly length: number;
  readonly maximumChunkBytes: number;
  readonly alignmentBytes: number;
  readonly maximumInFlight: number;
}

export type TransferSettlementKind =
  | "transport-completion"
  | "per-action-response"
  | "device-paced-status-poll"
  | "range-window-report"
  | "cumulative-prefix-report";

/**
 * Settlement is direction-owned. The carrier performs its declared recipe;
 * the correlator consumes only bounded observations of this selected kind.
 */
export interface TransferRangeSettlementContract {
  readonly kind: Exclude<TransferSettlementKind, "cumulative-prefix-report">;
  readonly selection: string;
  readonly maximumWaitMs: number;
  readonly maximumObservations: number;
}

export interface TransferCumulativePrefixSettlementContract {
  readonly kind: "cumulative-prefix-report";
  readonly selection: MessageSelector;
  /** The selected offset is interpreted only in this declared byte domain. */
  readonly domain: "source" | "target";
  readonly path: readonly string[];
  readonly maximumWaitMs: number;
  readonly maximumObservations: number;
}

export type TransferSettlementContract =
  | TransferRangeSettlementContract
  | TransferCumulativePrefixSettlementContract;

export interface TransferCancellationContract {
  readonly action: string;
  readonly maximumWaitMs: number;
  readonly destructive: boolean;
  readonly retireCheckpointOnSuccess: boolean;
}

export interface TransferResumeRecipeContract {
  readonly quiescence?: TransferResumeReportedVolatileEmptyContract;
  readonly actions: readonly TransferRecipeActionContract[];
  readonly reportedOffsetBinding: string;
  readonly generationBinding: string;
}

export interface TransferResumeReportedVolatileEmptyContract {
  readonly kind: "reported-volatile-empty";
  /** The adapter subscribes to report events before transmitting this action. */
  readonly probe: TransferRecipeActionContract;
  readonly probedGenerationBinding: string;
  readonly volatileOffsetBinding: string;
  readonly bufferedRangeCountBinding: string;
  readonly report: {
    readonly selection: MessageSelector;
    readonly maximumWaitMs: number;
    readonly reportedOffsetPath: readonly string[];
    readonly volatileOffsetPath: readonly string[];
    readonly bufferedRangeCountPath: readonly string[];
    readonly generationPath: readonly string[];
  };
}

export interface TransferResumeContractValue {
  readonly kind: "durable-reported-offset";
  readonly reportedOffsetSelection: string;
  readonly maximumWaitMs: number;
  readonly sourceDigestAlgorithm: TransferDigestAlgorithm;
  readonly finalization: "repeatable" | "not-repeatable";
  readonly recipe?: TransferResumeRecipeContract;
}

export type TransferEffectiveRangeCoverage =
  | { readonly kind: "complete-effective-range" }
  | {
    readonly kind: "explicit-range";
    readonly offset: number;
    readonly length: number;
  };

export type TransferVerificationDomainCoverage =
  | {
    readonly domain: "source" | "target";
    readonly coverage: TransferEffectiveRangeCoverage;
  }
  | {
    readonly domain: "transmitted";
    readonly coverage: { readonly kind: "complete-attempt-sequence" };
  };

interface TransferDigestVerificationBaseContract {
  readonly id: string;
  readonly algorithm: TransferDigestAlgorithm;
  readonly maximumWaitMs: number;
  /** Declared recipe result; no adapter-owned digest callback exists. */
  readonly reportedBinding: string;
}

export type TransferHostComputedDeviceConfirmedVerificationContract =
  TransferDigestVerificationBaseContract
  & TransferVerificationDomainCoverage
  & { readonly authority: "host-computed-device-confirmed" };

export type TransferDeviceReportedVerificationContract =
  TransferDigestVerificationBaseContract
  & TransferVerificationDomainCoverage
  & { readonly authority: "device-reported" };

export type TransferVerificationContract =
  | TransferHostComputedDeviceConfirmedVerificationContract
  | TransferDeviceReportedVerificationContract;

/** Explicit direction-owned prohibition; automatic retry has no current device consumer. */
export type TransferRetryContract = { readonly kind: "none" };

export type TransferResumeContract =
  | null
  | TransferResumeContractValue;

export type HostToDeviceWriteProtectionContract =
  | { readonly kind: "compare-before-write" }
  | {
    readonly kind: "device-journaled-source";
    readonly initiationAction: string;
    readonly sourceDigestBinding: string;
    readonly generationBinding: string;
  };

export interface TransferDirectionContract {
  readonly preparation: readonly TransferRecipeActionContract[];
  readonly data: TransferDataActionContract;
  readonly settlement: TransferSettlementContract;
  readonly completion: readonly TransferRecipeActionContract[];
  readonly verification: readonly TransferVerificationContract[];
  readonly retry: TransferRetryContract;
  readonly resume: TransferResumeContract;
  readonly cancellation?: TransferCancellationContract;
}

export interface HostToDeviceTransferDirectionContract extends TransferDirectionContract {
  readonly writeProtection: HostToDeviceWriteProtectionContract;
}

export interface DeviceToHostTransferDirectionContract extends TransferDirectionContract {
  readonly writeProtection?: never;
}

/**
 * The two properties are structurally distinct even when they happen to use
 * the same declaration type. A settlement never rises to transfer scope.
 */
export interface TransferDefinitionContract {
  readonly id: string;
  readonly bindings?: readonly TransferBindingContract[];
  readonly directions: {
    readonly hostToDevice: HostToDeviceTransferDirectionContract | null;
    readonly deviceToHost: DeviceToHostTransferDirectionContract | null;
  };
}

export interface TransferAdmittedAction {
  readonly id: number;
  readonly action: string;
  readonly range: TransferEffectiveRange;
}

export interface TransferSettledRange {
  readonly actionId: number;
  readonly range: TransferEffectiveRange;
  /** Exact bytes in the direction's source domain. */
  readonly sourceBytes: Uint8Array;
  /** A started range which cannot be confirmed makes cancellation indeterminate. */
  readonly status: "confirmed" | "may-be-partial";
}

export interface TransferRangeSettlementObservation {
  readonly kind: Exclude<TransferSettlementKind, "cumulative-prefix-report">;
  readonly selection: string;
  readonly ranges: readonly TransferSettledRange[];
}

export interface TransferCumulativePrefixObservation {
  readonly kind: "cumulative-prefix-report";
  readonly selection: MessageSelector;
  readonly domain: "source" | "target";
  readonly offset: number;
}

export type TransferSettlementObservation =
  | TransferRangeSettlementObservation
  | TransferCumulativePrefixObservation;

export type TransferBindingValue = number | Uint8Array;

/**
 * Protocol-specific execution lives behind this port. Admission and
 * settlement are separate calls on purpose: command-shaped traffic does not
 * make command completion the correlator's authority.
 */
export interface DeviceToHostTransferAdapter {
  initializeBindings?(values: Readonly<Record<string, TransferBindingValue>>): void;
  executeRecipeAction(
    action: TransferRecipeActionContract,
    phase: "preparation" | "completion",
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, TransferBindingValue>> | void>;
  admit(
    action: TransferAdmittedAction,
    signal: AbortSignal,
    observeTransmitted: (bytes: Uint8Array) => void,
  ): Promise<void>;
  nextSettlement(
    settlement: TransferSettlementContract,
    signal: AbortSignal,
  ): Promise<TransferSettlementObservation>;
  binding?(name: string): TransferBindingValue | undefined;
}

export interface HostToDeviceTransferAdapter {
  initializeBindings?(values: Readonly<Record<string, TransferBindingValue>>): void;
  executeRecipeAction(
    action: TransferRecipeActionContract,
    phase: "preparation" | "completion",
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, TransferBindingValue>> | void>;
  /** Arms report observation before transmitting the one declared resume probe. */
  executeResumeProbe?(
    action: TransferRecipeActionContract,
    selection: MessageSelector,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, TransferBindingValue>> | void>;
  nextResumeReport?(
    selection: MessageSelector,
    signal: AbortSignal,
  ): Promise<DecodedLayout>;
  /** Exact fresh target bytes used by the guarded-write comparison/readback. */
  readTarget(range: TransferEffectiveRange, signal: AbortSignal): Promise<Uint8Array>;
  admit(
    action: TransferAdmittedAction,
    sourceBytes: Uint8Array,
    signal: AbortSignal,
    observeTransmitted: (bytes: Uint8Array) => void,
  ): Promise<void>;
  nextSettlement(
    settlement: TransferSettlementContract,
    signal: AbortSignal,
  ): Promise<TransferSettlementObservation>;
  binding?(name: string): TransferBindingValue | undefined;
  executeCancellation?(
    cancellation: TransferCancellationContract,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, TransferBindingValue>> | void>;
  readonly connectionUsable?: boolean;
}

export interface TransferStreamingDigest {
  update(bytes: Uint8Array): void;
  digestHex(): Promise<string>;
}

export interface TransferDigestProvider {
  create(algorithm: TransferDigestAlgorithm): TransferStreamingDigest;
}

export interface DeviceToHostTransferOptions {
  readonly definition: TransferDefinitionContract;
  readonly adapter: DeviceToHostTransferAdapter;
  readonly sink: { write(data: Uint8Array): Promise<void> };
  readonly digestProvider: TransferDigestProvider;
  readonly clock: Pick<Clock, "timer">;
  readonly limits: Pick<
    HostResourceLimits,
    "maximumTransferWindowBytes" | "maximumChunksInFlight"
  >;
  readonly signal?: AbortSignal;
}

export interface TransferByteDomainCounts {
  readonly source: number;
  readonly transmitted: number;
  readonly target: number;
}

export interface TransferVerificationResult {
  readonly id: string;
  readonly authority: TransferVerificationContract["authority"];
  readonly algorithm: TransferDigestAlgorithm;
  readonly domain: TransferByteDomain;
  readonly coverage: TransferVerificationContract["coverage"];
  readonly value: string;
}

export interface DeviceToHostTransferResult {
  readonly direction: "deviceToHost";
  readonly counts: TransferByteDomainCounts;
  readonly verification: readonly TransferVerificationResult[];
}

export interface HostToDeviceTransferOptions {
  readonly definition: TransferDefinitionContract;
  readonly adapter: HostToDeviceTransferAdapter;
  readonly source: HostByteSource;
  /** Present only for a composed optimistic-concurrency guard. */
  readonly expectedCurrent?: HostByteSource;
  readonly digestProvider: TransferDigestProvider;
  readonly clock: Pick<Clock, "timer">;
  readonly limits: Pick<
    HostResourceLimits,
    "maximumTransferWindowBytes" | "maximumChunksInFlight" | "maximumResourceChunkBytes"
  >;
  /**
   * Optional caller authority. The engine prehashes it before device work and
   * separately hashes bytes read during admission, then compares both before
   * completion. A mutable source therefore cannot splice a resumed/write run.
   */
  readonly expectedSourceDigest?: {
    readonly algorithm: TransferDigestAlgorithm;
    readonly value: string;
  };
  /** Resume-only engine facts reconstructed from checkpointed source identity. */
  readonly initialBindings?: Readonly<Record<string, TransferBindingValue>>;
  /** Durable-resume integration; absent for non-resumable definitions. */
  readonly checkpoint?: {
    /** Returns the exact range durably recorded; rounding is a named failure. */
    confirmed(range: TransferEffectiveRange): Promise<TransferEffectiveRange>;
    phase(phase: TransferCheckpointPhase): Promise<void>;
    retire?(): Promise<void>;
  };
  readonly signal?: AbortSignal;
}

export interface HostToDeviceTransferResult {
  readonly direction: "hostToDevice";
  readonly counts: TransferByteDomainCounts;
  /** Number of admitted actions settled by the declared direction. */
  readonly settledActions: number;
  readonly verification: readonly TransferVerificationResult[];
  readonly outcome: "completed";
}

export type HostToDeviceTransferOutcome =
  | HostToDeviceTransferResult
  | {
      readonly direction: "hostToDevice";
      readonly outcome: "failed-before-destructive-work";
      readonly cause: TransferRuntimeDiagnostic;
    }
  | {
      readonly direction: "hostToDevice";
      readonly outcome: "indeterminate-after-destructive-work";
      readonly destructiveActions: number;
      readonly cause: TransferRuntimeDiagnostic;
    }
  | {
      readonly direction: "hostToDevice";
      readonly outcome: "resume-required";
      readonly confirmedActions: number;
      readonly unresolvedActions: number;
      readonly cause: TransferRuntimeDiagnostic;
    }
  | {
      readonly direction: "hostToDevice";
      readonly outcome: "cancelled";
      readonly confirmedActions: number;
      readonly cause: TransferRuntimeDiagnostic;
    }
  | {
      readonly direction: "hostToDevice";
      readonly outcome: "failed-mid-write";
      readonly confirmedActions: number;
      readonly unresolvedActions: number;
      readonly cause: TransferRuntimeDiagnostic;
    };

export type TransferRuntimeDiagnosticCode =
  | "transfer.data.alignment-invalid"
  | "transfer.declaration.invalid-integer"
  | "transfer.direction.unavailable"
  | "transfer.limit.chunks-in-flight"
  | "transfer.limit.window-bytes"
  | "transfer.range.not-explicit"
  | "transfer.read.incomplete"
  | "transfer.recipe.action-empty"
  | "transfer.recipe.destructive-not-declared"
  | "transfer.retry.not-admitted"
  | "transfer.resume.required-after-settlement-timeout"
  | "transfer.cancelled"
  | "transfer.cancelled.failed-mid-write"
  | "transfer.settlement.action-not-in-flight"
  | "transfer.settlement.data-length"
  | "transfer.settlement.duplicate"
  | "transfer.settlement.empty"
  | "transfer.settlement.kind-mismatch"
  | "transfer.settlement.observation-bound"
  | "transfer.settlement.range-mismatch"
  | "transfer.settlement.selection-mismatch"
  | "transfer.settlement.timeout"
  | "transfer.settlement.prefix-domain-mismatch"
  | "transfer.settlement.prefix-regressed"
  | "transfer.settlement.prefix-unadmitted"
  | "transfer.settlement.checkpoint-rounded"
  | "transfer.binding.unavailable"
  | "transfer.binding.kind-mismatch"
  | "transfer.resume.binding-not-reconstructed"
  | "transfer.cancellation.failed"
  | "transfer.cancellation.skipped-dead-link"
  | "transfer.verification.digest-mismatch"
  | "transfer.verification.authority-invalid"
  | "transfer.verification.coverage-invalid"
  | "transfer.verification.domain-unavailable"
  | "transfer.verification.id-invalid"
  | "transfer.verification.invalid-digest"
  | "transfer.verification.source-changed"
  | "transfer.write.expected-current-mismatch"
  | "transfer.write.readback-mismatch"
  | "transfer.write.source-incomplete"
  | "transfer.write.indeterminate";

/** One non-recursive immediate cause retained when a transfer layer adds context. */
export interface TransferRuntimeDiagnosticCause {
  readonly owner: "transfer" | "protocol" | "transport" | "manifest" | "platform" | "runtime";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly platformCause?: PlatformCauseSnapshot;
}

export interface TransferRuntimeDiagnostic {
  readonly code: TransferRuntimeDiagnosticCode;
  readonly declarationPath: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: TransferRuntimeDiagnosticCause;
}

export type TransferCheckpointPhase =
  | "preparing"
  | "prepared"
  | "transferring"
  | "verifying"
  | "finalizing";

export interface TransferCheckpointRange {
  readonly targetOffset: number;
  readonly length: number;
}

export interface TransferResumeIdentity {
  /** Host acquisition provenance. Device-reported transfer state never upgrades this tier. */
  readonly stableKeyAssurance: StableKeyAssurance;
  readonly stableKey: string | null;
  /** Device-reported transfer-state correlation value, not physical identity evidence. */
  readonly generation: string | null;
}

export type TransferCheckpointAssurance = "verified" | "unverified";

/** Clone-safe durable state. It contains facts, never a live source or connection. */
export interface TransferCheckpoint {
  readonly formatVersion: 2;
  readonly id: string;
  readonly revision: number;
  readonly manifestHash: string;
  /** Present only when authored Lua produced the graph named by manifestHash. */
  readonly sourceSetIdentity?: LuaSourceSetIdentity;
  readonly definitionHash: string;
  /**
   * Manifest-owned materialization inputs. Low-level engine checkpoints do
   * not need them; the product composition surface requires them so a
   * replacement process can rematerialize rather than receive a definition
   * reconstructed by its caller.
   */
  readonly manifestTransfer?: {
    readonly id: string;
    readonly parameters: Readonly<Record<string, number>>;
  };
  /** Authored service identity; old graph checkpoints do not acquire this tag. */
  readonly authoredTransfer?: {
    readonly version: 1;
    readonly operation: string;
    readonly argumentsDigest: string;
    readonly policyDigest: string;
    readonly targetOffset: number;
    readonly targetLength: number;
    readonly admittedEnd: number;
    readonly streamed?: { readonly version: 1; readonly committedDigest: string; readonly submittedDigest: string };
    readonly cookie: string;
  };
  readonly modeId: string;
  readonly direction: TransferDirection;
  readonly source: {
    readonly algorithm: TransferDigestAlgorithm;
    readonly digest: string;
    readonly byteLength: number;
    /** Explicit B5 subject; byteLength then names the range, not its enclosing file. */
    readonly subject?: { readonly kind: "effective-range"; readonly offset: number; readonly length: number };
  };
  readonly identity: TransferResumeIdentity;
  readonly phase: TransferCheckpointPhase;
  readonly confirmedRanges: readonly TransferCheckpointRange[];
  readonly finalization: "repeatable" | "not-repeatable";
}

export interface TransferCheckpointClaim {
  readonly checkpoint: TransferCheckpoint;
  readonly owner: string;
  readonly token: string;
}

export type TransferCheckpointDiagnosticCode =
  | "transfer.checkpoint-held"
  | "transfer.checkpoint-conflict"
  | "transfer.checkpoint-invalid"
  | "transfer.resume.manifest-mismatch"
  | "transfer.resume.source-set-mismatch"
  | "transfer.resume.definition-mismatch"
  | "transfer.resume.mode-mismatch"
  | "transfer.resume.direction-mismatch"
  | "transfer.resume.source-mismatch"
  | "transfer.resume.identity-mismatch"
  | "transfer.resume.offset-mismatch"
  | "transfer.resume.preparation-incomplete"
  | "transfer.resume.finalization-not-repeatable";

export interface TransferCheckpointDiagnostic {
  readonly code: TransferCheckpointDiagnosticCode;
  readonly declarationPath: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/** Atomic claim plus compare-and-swap commit; implementations own durability. */
export interface TransferCheckpointStore {
  create(checkpoint: TransferCheckpoint): Promise<void>;
  read(id: string): Promise<TransferCheckpoint | null>;
  claim(id: string, owner: string): Promise<TransferCheckpointClaim>;
  commit(claim: TransferCheckpointClaim, checkpoint: TransferCheckpoint): Promise<TransferCheckpointClaim>;
  /** Atomically removes a claim-checked checkpoint. The caller distinguishes
   * verified transfer completion from explicitly confirmed protocol retirement. */
  complete(claim: TransferCheckpointClaim): Promise<void>;
  release(claim: TransferCheckpointClaim): Promise<void>;
}
