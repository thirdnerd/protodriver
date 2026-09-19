import type {
  BrokerCallId, CaptureId, CaptureSummary, ChannelLease, Clock, DeviceConnection, Disposable, ControlRequest,
  OperationId, OperationRequest, OperationResult, PdrError, PdrFailureResponsibility, PublicValue, AuthoredValueType, AuthoredPollPolicy, AuthoredClockObservation, AuthoredExpiryObservation, AuthoredInputRetirement, InputCustodySink,
  ResourceBrokerClient, ResourceId, RpcSessionEvent, SessionRpcEvent, ReceivedChunk, WriteReceipt,
  SessionRpcRequest, SessionRpcResponse, SessionSnapshot, SubscriptionId, TransferCheckpointStore, CheckpointId, ResumeTransferRequest,
  RawTerminalExitResult, RawTerminalHandle, RawTerminalId,
} from "@protodriver/contracts";
import { DEFAULT_HOST_RESOURCE_LIMITS } from "@protodriver/contracts/limits";
import { DestinationCaptureRecorder } from "./capture.ts";
import { RemoteCaptureDestination, type CaptureDestinationRpcAdapter } from "./capture-rpc.ts";
import { OperationResultRetention } from "./lifecycle.ts";
import { SessionEventDelivery } from "./events.ts";
import { CanonicalSizeAccounting } from "./limits.ts";
import { RetainedMailbox } from "./retained-mailbox.ts";
import { NativeRunway } from "./native-runway.ts";
import { InputWorkAccount, InputWorkRanges } from "./input-work.ts";
import { InputRetirementIndex } from "./input-retirement.ts";
import { isInputCustodyAttestation } from "./ingress.ts";
import { AuthoredInputRetirementService, type AuthoredRetirementCut } from "./authored-input-retirement.ts";
import { NativeHelperData, type NativeHelperContext } from "./native-helper.ts";
import { boundedBytes, byteString, stringBytes, joinBytes } from "./retained-bytes.ts";
import { ReadyQueue } from "./ready-queue.ts";
import { BoundedFill } from "./bounded-fill.ts";
import { AuthoredState } from "./authored-state.ts";
import { AuthoredTimeBasis, clockObservationType } from "./authored-clock.ts";
import { AuthoredExpiryLedger, EXPIRY_WORK, EXPIRY_SCRATCH } from "./authored-expiry.ts";
import { materializeSourceArguments, sourceValueTypes, type SourcePreparationContext } from "./source-materialization.ts";
import { openStreamingSources, type StreamingSource } from "./streaming-source.ts";
import { StreamingResult, resolveResultSubject, validateStreamedResult } from "./streaming-result.ts";
import { ChannelGroup } from "./channel-group.ts";
import type { AuthoredChannelRoles } from "@protodriver/contracts";
import { AuthoredTransfer, checkpointAssurance, inspectAuthoredCheckpoint, transferSegmentCount, TRANSFER_SOURCE_QUANTUM, type TransferServiceIdentity } from "./authored-transfer.ts";
import { maximumTransferSourceLength, resolveTransferSourceRange } from "./effective-source-range.ts";
import { AuthoredPollService, DEFAULT_AUTHORED_POLL_POLICY, grantPollPlans, pollPlans, type PollPlan } from "./authored-poll.ts";
import type { SessionRpcServer } from "./rpc.ts";
import { parseUsbControlRequest } from "./usb-control.ts";
import { authoredPublicValue, validateAuthoredArguments, type AuthoredDescription, type AuthoredOperation } from "./authored-admission.ts";
import { DEFAULT_RETAINED_EFFECT_WORK, RETAINED_LUA_FUEL, LuaResourceError, NativeScratch, withNativeScratch, activeNativeScratch, nativeValue, nativeEncode,
  nativeKeys, nativeEntries, nativeArray, nativeJson, nativeSort, nativeRecord } from "@protodriver/lua-vm/retained";

/** Preserve traversal order and short circuiting; charge before each body. */
function* nativeWalk<T>(values: Iterable<T>): Iterable<T> {
  activeNativeScratch()?.reserve(32);
  for (const value of values) { activeNativeScratch()?.iteration(); yield value; }
}
function nativeList<T>(values: Iterable<T>): T[] {
  activeNativeScratch()?.reserve(8);
  const result: T[] = [];
  for (const value of nativeWalk(values)) { activeNativeScratch()?.reserve(16); result.push(value); }
  return nativeArray(result);
}

interface RetainedDispatchResult {
  readonly value: unknown;
  readonly consumed: number;
  /** Handoff of owned native result storage, not an extra execution grant. */
  release?(): void;
}

/** Host-only candidate port. Neither this object nor a native lease crosses RPC. */
export interface RetainedExecutionPort {
  /** Fatal shared-context termination is not an ordinary operation failure. */
  readonly terminated?: boolean;
  register(activation: string, parentAccount?: string, chargeNativeWork?: (units: number) => void, maximumLuaFuel?: number, segments?: number): Promise<void>;
  advanceSegment?(activation: string, index: number): Promise<void>;
  dispatch(activation: string, input: string): Promise<RetainedDispatchResult>;
  dispatchBytes?(activation: string, input: Uint8Array): Promise<RetainedDispatchResult>;
  dispatchWaitBytes?(activation: string, prefix: string, bytes: Uint8Array): Promise<RetainedDispatchResult>;
  dispatchObservation?(activation: string, observation: AuthoredClockObservation | AuthoredExpiryObservation | AuthoredInputRetirement): Promise<RetainedDispatchResult>;
  startOperation?(activation: string, binding: string, args: Readonly<Record<string, PublicValue>>, types: Readonly<Record<string, AuthoredValueType>>, destination?: string, context?: Readonly<Record<string, PublicValue>>): Promise<RetainedDispatchResult>;
  preflightSourceInput?(activation: string, binding: string, args: Readonly<Record<string, PublicValue>>,
    types: Readonly<Record<string, AuthoredValueType>>, lengths: Readonly<Record<string, number>>, iteration: () => void, destination?: string, context?: Readonly<Record<string, PublicValue>>): number;
  retire(activation: string, retainAccount?: boolean): Promise<void | { readonly consumed: number }>;
  close(): Promise<void>;
}

export interface RetainedHelperChannel {
  read(maximum: number): Promise<string>;
  readBytes(maximum: number): Promise<Uint8Array>;
  write(bytes: string | Uint8Array): Promise<void>;
  /** Two-party transfer back: the helper offers; its caller accepts on return. */
  offerBack(): { readonly offerId: string };
}
export interface RetainedHelper {
  /** Host-granted routed receive channel below a session demultiplexer.
   * Writes still use the broker's existing transport grant and effect ledger. */
  readonly mailbox?: string;
  run(offer: { accept(): RetainedHelperChannel }, context: NativeHelperContext): Promise<{
    readonly value: string | Uint8Array; readonly handback: { readonly offerId: string };
  }>;
}

export interface RetainedSessionOptions {
  readonly platform: "node" | "web";
  readonly clock: Clock;
  readonly logicalDevice: string;
  readonly modeId: string;
  readonly profileId: string;
  /** Host-validated operation surface; this slice does not replace admission. */
  readonly operations: readonly string[];
  readonly description?: AuthoredDescription;
  readonly capabilities?: Readonly<Record<string, { readonly available: boolean; readonly limitation: string }>>;
  readonly executionIdentity?: { readonly digest: string };
  readonly execution: RetainedExecutionPort;
  /** Already granted acquisition context, not a Lua-supplied open callback. */
  readonly open: () => Promise<DeviceConnection>;
  readonly channelId: string;
  readonly channelRoles?: AuthoredChannelRoles | undefined;
  readonly helpers: Readonly<Record<string, RetainedHelper>>;
  readonly checkpointStore?: TransferCheckpointStore;
  readonly checkpointPolicyDigest?: string;
  readonly resourceBroker: ResourceBrokerClient;
  readonly captureDestinationAdapter: CaptureDestinationRpcAdapter;
  readonly maximumConcurrentTimers?: number;
  readonly maximumEffectWork?: number;
  readonly maximumNativeHelperBytes?: number;
  /** Host-selected capture-writer queue bound. The package cannot raise it. */
  readonly maximumCaptureBufferedBytes?: number;
  /** Composition-root aggregate shared with the retained VM's native scratch. */
  readonly nativeData?: NativeHelperData;
  readonly pollPolicy?: AuthoredPollPolicy | null;
  /** Selected host-granted topology, not yet part of authored-module admission.
   * The handler receives each native range; no operation gets direct receive. */
  readonly scheduling?: { readonly demultiplexer: string; readonly mailboxes: readonly string[] };
  /** Host-granted capability, never inferred from the presence of control(). */
  readonly usbControl?: { readonly available: boolean; readonly limitation: string };
  /** Trusted composition-root selection, never an authored claim. The selected
   * factory must use original-stamp BoundedIngress on EVERY reliable member.
   * Admission does not open hardware. Connection admission separately requires
   * unforgeable receipts for every member before any entry/handler runs. */
  readonly inputRetirementSupport?: { readonly adapter: "bounded-ingress-v1"; readonly clock: Clock };
}

interface Effect { id: string; kind: string; outcome: string; bytes?: number }
interface Activation {
  readonly id: OperationId;
  generation: number;
  readonly startedUs: number;
  readonly resources: Set<ResourceId>;
  readonly effects: Map<string, Effect>;
  effectsEvicted?: number;
  live: boolean;
  finished: boolean;
  work: number;
  consumed: number;
  workFailure?: Error;
  reservedWork?: number;
  maximumWork?: number;
  maximumLuaFuel?: number;
  segments?: { count: number; index: number; workBase: number; fuelBase: number };
  cleanupChild?: Activation;
  cleanupPending?: Promise<void>;
  cleanupOwner?: Activation;
  ordinaryRunSettled?: boolean;
  cleanupComplete?: (error?: PdrError) => void;
  cleanupTimer?: Disposable;
  cleanupRetired?: boolean;
  idleContext?: Readonly<Record<string, PublicValue>>;
  completed?: boolean;
  terminal?: NativeRunway;
  sourceCleanup?: Map<string, { effect: Effect; observation: NativeRunway }>;
  retiring?: boolean;
  readonly revokers: Set<() => void>;
  handler?: boolean;
  readySequence?: number | undefined;
  declaration?: AuthoredOperation;
  arguments?: Readonly<Record<string, PublicValue>>;
  sourceArguments?: OperationRequest["arguments"];
  sourceStorage?: { release(): void };
  streams?: Map<string, StreamingSource>;
  transfer?: AuthoredTransfer;
  transferGeneration?: number;
  authoredCause?: { readonly name: string; readonly details: PublicValue };
  resumeId?: string;
  inputEvidence?: InputEvidence;
  consumedRangeInput?: boolean;
  consumedRangeChannel?: string;
  inputChannel?: string;
  inputPhysicalSequence?: number;
  inputInterpretations?: Set<{ release(): void }>;
  custodyInterpretations?: Set<Disposable>;
  resultScratch?: RetainedDispatchResult;
  nativeScratch?: Set<NativeScratch>;
  sourcePreparation?: { requested: number; reads: number; deliveredBytes: number; complete: boolean };
  output?: { id: ResourceId; bytes: number; receipt?: OperationResult["resourceResult"]; stream?: StreamingResult; held?: { release(): void }; closed?: boolean };
  entryDone?: (error?: PdrError) => void;
  eventAccount?: boolean;
  accountParent?: Activation;
  inputHandler?: string;
  acceptanceDone?: (value: PublicValue, error?: PdrError) => void;
  entryHandoff?: boolean;
  /** Buffered deliveries retain the causing account, not entry's lifetime. */
  inheritedInput?: boolean;
  accountChildren?: number;
  childrenRetired?: () => void;
  poll?: boolean;
  locksAcquired?: boolean;
  delivery?: HandlerDelivery;
  /** Exact host-owned expiry-reserve completion, not a delivered author handle. */
  pendingExpiryDelivery?: string;
}
interface DispatchFailureContext {
  readonly action: string;
  readonly role: "cleanup" | "entry" | "write-authorization" | "session-event" | "handler" | "operation";
  readonly binding?: string;
  readonly resumingEffect?: string;
}
interface InputEvidence {
  sequence: number; bytes: number;
  range?: { generation: number; handler: string; channel: string; start: number; end: number; physicalSequence: number };
}
interface ConsumedInput { delivered: number; consumed: number; physicalSequence: number }
interface HandlerDelivery {
  id: string; generation: number; sequence: number; recordedSequence: number;
  bytes: Uint8Array; offset: number; sourceOffset: number; length: number; active: number;
  parent?: Activation; root?: Activation; parked?: boolean; releasing?: boolean; work: number;
  channelId?: string;
  observation?: AuthoredClockObservation;
  inputWork?: InputWorkAccount;
}
interface Receiver { readonly owner: string; readonly activation: Activation; readonly maximum: number; readonly registered: number; resolve(bytes: string): void; reject(cause: unknown): void }
interface InputPump {
  readonly channelId?: string;
  readonly iterator: AsyncIterator<ReceivedChunk>;
  readonly generation: number;
  readonly capability: string;
  readonly standing: boolean;
  pending: boolean;
  foregroundOwner?: OperationId;
  foregroundRetirement?: OperationId;
}
interface RelayJob { parent: Activation; run(): Promise<void>; reject(cause: unknown): void }
interface RawTerminalSession { readonly id: RawTerminalId; readonly subscriptionId: SubscriptionId; readonly lease: ChannelLease; readonly connection: DeviceConnection }
interface RoutedChannel { readonly activation: Activation; readonly mailbox: string; owner: string; receiver?: Receiver | undefined }
interface ArmedTimer {
  readonly activation: Activation;
  readonly effect: Effect;
  handle?: Disposable;
  readySequence?: number;
}
interface ArmedDeadline {
  readonly activation: Activation;
  readonly effect: Effect;
  readonly milliseconds: number;
  readonly acceptedUs: number;
  readonly dueUs: number;
  handle?: Disposable;
}
interface AnyWait {
  readonly fill?: BoundedFill;
  readonly activation: Activation;
  readonly timers: readonly string[];
  readonly maximum: number;
  readonly mailboxes: readonly string[];
  readonly registered: number;
  resolve(value: WaitCompletion): void;
  reject(cause: unknown): void;
}
// The facade tag is metadata, not part of the bounded native byte range.
type WaitCompletion = string | { readonly prefix: string; readonly bytes: Uint8Array };
interface DeferredInputRange {
  readonly storage?: { release(): void };
  readonly tUs?: number;
  readonly channelId?: string;
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly recordedSequence: number;
  next?: DeferredInputRange;
}
type Unsequenced = RpcSessionEvent extends infer T ? T extends { sequence: number } ? Omit<T, "sequence"> : never : never;

function fault(code: string, message: string, details?: PublicValue,
  responsibility: PdrFailureResponsibility = "operation"): Error & { error: PdrError } {
  return Object.assign(new Error(message), { error: { code, message, responsibility, retryability: "no" as const,
    ...(details === undefined ? {} : { details }) } });
}
function errorValue(cause: unknown): PdrError {
  if (typeof cause === "object" && cause !== null && "error" in cause) return (cause as { error: PdrError }).error;
  if (cause instanceof Error && cause.name === "TransferCheckpointError" && "diagnostic" in cause) {
    const d = cause.diagnostic as { code?: unknown; message?: unknown };
    const responsibility = "responsibility" in cause
      ? cause.responsibility as PdrFailureResponsibility : "operation";
    if (typeof d.code === "string" && d.code.startsWith("transfer.") && d.code.length <= 128 && typeof d.message === "string")
      return { code: d.code, message: d.message.slice(0, 512), responsibility, retryability: "no" };
  }
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    const bounded = ["lua-vm.resource.input-limit", "lua-vm.resource.output-limit", "lua-vm.resource.allocation-limit",
      "lua-vm.resource.depth-limit", "lua-vm.resource.fuel-exhausted", "retained.work-exhausted"].includes(cause.code);
    const vm = cause as Error & { fuelConsumed?: unknown; vmStatus?: unknown; phase?: unknown; dispatchContext?: unknown };
    const vmFailure = typeof vm.vmStatus === "number" && Number.isSafeInteger(vm.vmStatus) && vm.vmStatus < 0
      && (vm.phase === "admission" || vm.phase === "dispatch");
    if ((bounded && cause instanceof LuaResourceError)
        || (vmFailure && cause.code.startsWith("lua-vm.environment."))) {
      // Select only bounded host fields. Do not serialize arbitrary Error
      // properties, interpret prose, or relabel an authored named failure.
      const details: Record<string, PublicValue> = {};
      if (typeof vm.fuelConsumed === "number" && Number.isSafeInteger(vm.fuelConsumed) && vm.fuelConsumed >= 0)
        details.fuelConsumed = vm.fuelConsumed;
      if (vmFailure) { details.vmStatus = vm.vmStatus as number; details.phase = vm.phase as string; }
      if (vmFailure && vm.phase === "dispatch" && typeof vm.dispatchContext === "object" && vm.dispatchContext !== null) {
        const context = vm.dispatchContext as Record<string, unknown>;
        const roles = ["cleanup", "entry", "write-authorization", "session-event", "handler", "operation"];
        if (["start", "resume", "invalidate"].includes(context.action as string) && roles.includes(context.role as string)) {
          const dispatch: Record<string, PublicValue> = { action: context.action as string, role: context.role as string };
          if (typeof context.binding === "string" && nativeEncode(context.binding).length <= 256) dispatch.binding = context.binding;
          if (typeof context.resumingEffect === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(context.resumingEffect))
            dispatch.resumingEffect = context.resumingEffect;
          details.dispatch = dispatch;
        }
      }
      return { code: cause.code, message: cause.message, responsibility: "definition", retryability: bounded ? "no" : "unknown",
        ...(Object.keys(details).length ? { details } : {}) };
    }
  }
  if (typeof cause === "object" && cause !== null && "programFailureName" in cause) {
    const failure = cause as { programFailureName: string; programFailureDetails: PublicValue };
    return { code: "lua-vm.invocation.program-failure", message: "Authored operation failed: " + failure.programFailureName,
      responsibility: "definition", retryability: "unknown", details: { name: failure.programFailureName, details: failure.programFailureDetails } };
  }
  return { code: "retained.execution-failed", message: String(cause), retryability: "unknown" };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fault("retained.invalid-effect", "effect must be a record");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || nativeEncode(value).length > maximum) throw fault("retained.invalid-effect", "bounded string required");
  return value;
}
function publicValue(value: unknown, path = "details"): PublicValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map((item, index) => publicValue(item, `${path}[${index}]`));
  if (typeof value !== "object" || value instanceof Uint8Array) {
    throw fault("retained.invalid-effect", "authored cause details must be a public value");
  }
  const source = value as Record<string, unknown>, result: Record<string, PublicValue> = {};
  for (const [key, item] of nativeEntries(source)) result[key] = publicValue(item, `${path}.${key}`);
  return result;
}

/**
 * Session RPC server for admitted authored modules. It retains Lua execution
 * across effects and delegates device, resource, capture, and event work to
 * host services.
 */
export class RetainedSessionRpcServer implements SessionRpcServer {
  readonly #options: RetainedSessionOptions;
  readonly #time: AuthoredTimeBasis | undefined;
  readonly #expiries: AuthoredExpiryLedger | undefined;
  readonly #retirement: AuthoredInputRetirementService | undefined;
  #retirementCut: AuthoredRetirementCut | undefined;
  #inputIndex: InputRetirementIndex | undefined;
  readonly #retention = new OperationResultRetention(DEFAULT_HOST_RESOURCE_LIMITS.maximumRetainedOperationResults,
    DEFAULT_HOST_RESOURCE_LIMITS.maximumConcurrentOperations);
  readonly #delivery: SessionEventDelivery;
  readonly #subscriptions = new Map<SubscriptionId, { dispose(): void }>();
  readonly #events: SessionRpcEvent[] = [];
  readonly #eventWaiters: Array<(value: IteratorResult<SessionRpcEvent>) => void> = [];
  readonly #clients = new Set<string>();
  readonly #activations = new Map<OperationId, Activation>();
  // Live slots are session-wide and independent of operation retention.
  // Acknowledging/cancelling a caller cannot erase its unresolved native call.
  readonly #liveEffects = new Map<string, Effect>();
  readonly #pendingEffects = new WeakSet<Effect>();
  readonly #accountedEffects = new WeakSet<Effect>();
  readonly #accounting = new CanonicalSizeAccounting();
  readonly #mailbox: Map<string, unknown>;
  readonly #idleMailbox: RetainedMailbox;
  #fillCapacity = 0; // single direct consumer; included in the SAME mailbox bound
  readonly #timers = new Map<string, ArmedTimer>();
  readonly #deadlines = new Map<string, ArmedDeadline>();
  // This selected session has one granted physical outbound channel. Keep the
  // obstruction across owner/lease/generation changes, until native settlement.
  readonly #outbound = new Map<string, { owner: string; generation: number; effect: Effect }>();
  readonly #maximumTimers: number;
  readonly #maximumWork: number;
  readonly #terminalBaseWork: number;
  readonly #terminalBaseCapacity: number;
  readonly #helperData: NativeHelperData;
  #helperTasks = 0;
  #tasks = 0;
  #cleanupTimers = 0;
  readonly #inputRanges: Array<{ sequence: number; recordedSequence: number; offset: number; length: number; channelId?: string; tUs?: number }> = [];
  #inputUtf8Bytes = 0;
  readonly #readyChannel = new MessageChannel();
  #readyScheduled = false;
  readonly #waiting = new Map<OperationId, AnyWait>();
  readonly #messages = new Map<string, Array<{ sequence: number; value: string; binary?: boolean; evidence?: InputEvidence }>>();
  readonly #consumedInput = new Map<string, ConsumedInput>();
  readonly #inputWork = new Map<number, InputWorkAccount>();
  // Unlike the pending delivery map, this survives dequeue, raw consumption
  // and revocation until every original native/publication frame is released.
  readonly #nativeInputWork = new Map<number, InputWorkAccount>();
  readonly #inputParents = new Map<InputWorkAccount, Activation>();
  #preparedEntry: { activation: Activation; done: Promise<void> } | undefined;
  readonly #inputWorkRanges = new Map<string, InputWorkRanges>();
  readonly #routed = new Map<OperationId, RoutedChannel>();
  readonly #relayQueue: RelayJob[] = [];
  #relayRunning = false;
  readonly #taps = new Map<string, { owner: Activation; dropped: number; records: Array<{ sequence: number; value: string }> }>();
  #demuxOwner: string | undefined;
  #serial = 0;
  #sequence = 0;
  #generation = 0;
  #capabilities: { connection: string; lease: string } | undefined;
  #acquiring = false;
  #connection: DeviceConnection | undefined;
  #lease: ChannelLease | undefined;
  #channelGroup: ChannelGroup | undefined;
  #groupPumps: InputPump[] = [];
  #channelOwner: string | undefined;
  #channelFunding: Activation | undefined;
  #receiver: Receiver | undefined;
  #inputPump: InputPump | undefined;
  #buffer = "";
  #deferredInput: DeferredInputRange | undefined;
  #deferredTail: DeferredInputRange | undefined;
  #closed = false;
  #disconnectPromise: Promise<void> | undefined;
  #protocolReestablishmentRequired = false;
  #rawTerminal: RawTerminalSession | undefined;
  #resumeOffer: string | undefined;
  readonly #tracksTransferInput: boolean;
  #checkpointInspection = false;
  #capture: DestinationCaptureRecorder | undefined;
  #captureFailure: PdrError | undefined;
  readonly #turns: ReadyQueue;
  readonly #state: AuthoredState;
  readonly #poll: AuthoredPollService | undefined;
  #entering = false;
  #terminalError: PdrError | undefined;
  readonly #handlerTasks = new Map<string, number>();
  readonly #handlerDeliveries = new Set<HandlerDelivery>();
  readonly #handlerQueue: HandlerDelivery[] = [];
  #handlerScheduled = false;
  #handlerScheduleEpoch = 0;
  #handlerBytes = 0;
  #handlerHighWater = 0;
  readonly #lockOwners = new Map<string, Activation>();
  readonly #lockWaiters = new Map<OperationId, { activation: Activation; locks: readonly string[]; resolve(): void; reject(cause: unknown): void }>();

  constructor(options: RetainedSessionOptions) {
    if (options.description && options.scheduling) throw new Error("admitted topology cannot be replaced by host-supplied scheduling metadata");
    if (options.description?.handlers?.length) {
      const handlers = options.description.handlers;
      if (handlers.length !== 1 || handlers[0]!.event.channelId !== options.channelId) throw new Error("admitted topology targets an ungranted channel");
      options = { ...options, scheduling: { demultiplexer: handlers[0]!.binding, mailboxes: options.description.mailboxes ?? [] } };
    }
    this.#options = options;
    this.#idleMailbox = new RetainedMailbox();
    this.#mailbox = this.#idleMailbox;
    if (options.scheduling) {
      text(options.scheduling.demultiplexer);
      const names = options.scheduling.mailboxes;
      if (!options.scheduling.demultiplexer || names.length > 32 || new Set(names).size !== names.length
        || names.some(name => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))) throw new Error("invalid bounded scheduling topology");
      for (const name of names) this.#messages.set(name, []);
    }
    for (const helper of Object.values(options.helpers)) {
      if (helper.mailbox !== undefined && !this.#messages.has(helper.mailbox))
        throw new Error("helper routed channel must name a granted scheduling mailbox");
    }
    this.#maximumWork = options.maximumEffectWork ?? DEFAULT_RETAINED_EFFECT_WORK;
    if (!Number.isSafeInteger(this.#maximumWork) || this.#maximumWork < 1) throw new RangeError("invalid native work policy");
    this.#helperData = options.nativeData ?? new NativeHelperData(options.maximumNativeHelperBytes);
    activeNativeScratch()?.reserve(24 + (1 + (options.description?.handlers?.length ?? 0) + 2 * (options.description?.operations.length ?? 0)) * 16);
    const declarations = [options.description?.entry, ...(options.description?.handlers ?? []),
      ...(options.description?.operations ?? []), ...(nativeArray(options.description?.operations)?.map(o => o.cleanup) ?? [])];
    const expiryEnabled = nativeArray(declarations).some(d => nativeArray(d?.requires)?.some(r => r === "expiry.observe"));
    const retirementEnabled = nativeArray(declarations).some(d => nativeArray(d?.requires)?.some(r => r === "input.retirement"));
    if (retirementEnabled && options.capabilities?.["input.retirement"]?.available
      && (options.inputRetirementSupport?.adapter !== "bounded-ingress-v1" || options.inputRetirementSupport.clock !== options.clock
        || options.description?.entry?.inputEvidence !== "consumed-ranges" || options.description.handlers?.length !== 1
        || options.description.handlers[0]?.inputEvidence !== "consumed-ranges"))
      throw fault("retained.input-retirement-unavailable", "retirement admission requires selected adapter support and the complete consumed-range path");
    const timed = expiryEnabled || retirementEnabled || nativeArray(declarations).some(d => nativeArray(d?.requires)?.some(r => r === "clock.observe"));
    if (timed) {
      activeNativeScratch()?.reserve(256);
      this.#time = new AuthoredTimeBasis(options.clock);
      this.#reserve("clock-basis", this.#time.state);
    }
    if (retirementEnabled) {
      this.#retirement = new AuthoredInputRetirementService(options.clock, () =>
        !this.#closed && !this.#captureFailure && !this.#options.execution.terminated ? this.#retirementCut : undefined,
      observation => {
        if (!this.#capture) throw fault("retained.input-retirement-recording", "mandatory capture is not active");
        this.#stamp();
        if (this.#captureFailure) throw fault("retained.input-retirement-recording", "mandatory capture lost");
        return undefined;
      });
    }
    if (expiryEnabled) {
      activeNativeScratch()?.reserve(256);
      this.#expiries = new AuthoredExpiryLedger({ clock: options.clock, basis: this.#time!,
        generation: () => this.#generation,
        live: () => !this.#closed && !this.#captureFailure && !this.#options.execution.terminated,
        hasCapacity: () => this.#timerCount() < this.#maximumTimers,
        identity: () => this.#identity("expiry"),
        prepay: owner => {
          const activation = this.#activations.get(owner as OperationId);
          if (!activation) throw fault("retained.revoked", "expiry creator has ended");
          this.#live(activation); this.#nativeWork(activation, EXPIRY_WORK);
          // Already charged in full. These callbacks retain no Activation and
          // neither replenish nor mutate an ended operation's work receipt.
          const runway = new NativeRunway(this.#helperData, () => {}, () => {}, () => {}, owner);
          try { runway.ensure(EXPIRY_WORK, EXPIRY_SCRATCH); return runway; }
          catch (cause) { runway.close(); throw cause; }
        },
        reserve: (id, value) => this.#reserve(id, value), forget: id => { this.#mailbox.delete(id); },
        record: () => { this.#stamp(); }, failed: cause => { void this.#disconnect(errorValue(cause)); },
      });
    }
    this.#tracksTransferInput = Boolean(nativeArray(options.description?.operations)?.some(o => o.transfer));
    this.#maximumTimers = options.maximumConcurrentTimers ?? DEFAULT_HOST_RESOURCE_LIMITS.maximumConcurrentTimers;
    if (!Number.isSafeInteger(this.#maximumTimers) || this.#maximumTimers < 1
      || this.#maximumTimers > DEFAULT_HOST_RESOURCE_LIMITS.maximumConcurrentTimers) throw new RangeError("invalid outstanding timer limit");
    // The release algorithm scans the session's lock/timer populations. Their
    // future maximum is known from admitted topology and the unchanged host
    // bounds, not from whichever population happens to exist at task start.
    const lockNames=new Set<string>();let maximumLocks=0;
    activeNativeScratch()?.reserve(16 + ((options.description?.operations.length ?? 0)
      + (options.description?.handlers?.length ?? 0) + (options.description?.entry ? 1 : 0)) * 16);
    const lockDeclarations=[...(options.description?.operations??[]),...(options.description?.handlers??[]),
      ...(options.description?.entry?[options.description.entry]:[])];
    for(const declaration of lockDeclarations){
      activeNativeScratch()?.iteration();maximumLocks=Math.max(maximumLocks,declaration.locks.length);
      for(const lock of declaration.locks){activeNativeScratch()?.iteration();activeNativeScratch()?.reserve(16);lockNames.add(lock);}
    }
    this.#terminalBaseWork=512+this.#maximumTimers*2+64*(4+maximumLocks*4)+lockNames.size*2;
    this.#terminalBaseCapacity=32768+64*(128+maximumLocks*32)+lockNames.size*32;
    this.#delivery = new SessionEventDelivery({ maximumLosslessQueueDepth: DEFAULT_HOST_RESOURCE_LIMITS.maximumLosslessQueueDepth,
      maximumReplayCount: DEFAULT_HOST_RESOURCE_LIMITS.maximumEventReplayCount,
      onSubscriberTerminated: (subscriptionId, reason) => {
        this.#subscriptions.delete(subscriptionId);
        if (this.#rawTerminal?.subscriptionId === subscriptionId) void this.#closeRawTerminal(this.#rawTerminal.id, reason);
      } });
    this.#turns = new ReadyQueue(() => this.#considerWait());
    this.#state = new AuthoredState(options.description?.state ?? {}, options.clock, this.#turns, () => this.#stamp(),
      (changed, sequence) => {
        // Finish all size-dependent preparation before either public event
        // or capture publication can reveal a partial state transaction.
        nativeValue(changed);
        const stampCount = nativeArray(nativeEntries(changed)).length;
        for (let index = 0; index < stampCount; index += 1) this.#stamp();
        if (this.#closed || this.#captureFailure) throw fault("retained.revoked", "state publication lost its live recording/session");
        this.#delivery.publish({ kind: "state-cells", changed, sequence });
      }, (id, cell, basis) => {
        const stage = "state-stage:" + id, target = "state:" + id;
        this.#reserve(stage, basis ? { observation: cell, basis } : cell);
        return {
          commit: () => {
            this.#idleMailbox.commitStage(stage, target);
          },
          release: () => { this.#mailbox.delete(stage); },
        };
      },
      () => this.#timerCount() < this.#maximumTimers,
      () => { void this.#disconnect(); });
    const plans = options.description ? pollPlans(options.description) : [];
    const policy = grantPollPlans(plans, options.pollPolicy === undefined ? DEFAULT_AUTHORED_POLL_POLICY : options.pollPolicy);
    if (plans.length + (plans.some(p => p.releaseAfterIdleMs !== undefined) ? 1 : 0) > this.#maximumTimers) throw new Error("poll plans exceed aggregate timer capacity");
    if (plans.length && policy) this.#poll = new AuthoredPollService(plans, policy, {
      clock: options.clock, sequence: () => this.#stamp(), enqueue: (sequence, run) => this.#turns.enqueue(sequence, run),
      start: (plan, debit) => this.#start({ operation: plan.operation, arguments: {} }, { plan, debit }).operationId,
      quiescent: () => this.#outbound.size === 0 && this.#tasks === 0 && (!this.#inputPump?.pending || this.#inputPump.standing),
      release: () => this.#state.invalidate(() => {
        if (this.#closed || this.#captureFailure) throw fault("retained.revoked", "idle release revoked");
      }),
      observe: observation => {
        this.#reserve("poll-service", this.#poll!.snapshot);
        this.#publish({ kind: "scheduled-work", observation });
        this.#stamp();
      }, failed: cause => { void this.#disconnect(errorValue(cause)); },
    });
    this.#readyChannel.port1.onmessage = () => { this.#readyScheduled = false; this.#considerWait(); };
  }
  get events(): AsyncIterable<SessionRpcEvent> {
    return { [Symbol.asyncIterator]: () => ({ next: () => {
      const event = this.#events.shift();
      if (event) return Promise.resolve({ done: false as const, value: event });
      return new Promise(resolve => this.#eventWaiters.push(resolve));
    } }) };
  }
  #emit(event: SessionRpcEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else if (this.#events.length < DEFAULT_HOST_RESOURCE_LIMITS.maximumLosslessQueueDepth) this.#events.push(event);
    else throw fault("retained.event-overflow", "product event queue exhausted");
  }
  #stamp(): number { return this.#sequence = this.#options.clock.nextSequence(); }
  #publish(event: Unsequenced): number {
    const sequence = this.#stamp();
    this.#delivery.publish({ ...event, sequence } as RpcSessionEvent);
    return sequence;
  }
  #reserve(key: string, value: unknown): void {
    if (!this.#idleMailbox.reserve(key, value, this.#fillCapacity))
      throw fault("retained.mailbox-overflow", "aggregate execution mailbox exhausted");
  }
  #snapshot(): SessionSnapshot {
    return { takenAtSequence: this.#sequence, state: this.#closed ? "closed" : this.#rawTerminal || this.#protocolReestablishmentRequired ? "revalidation-required" : this.#connection ? "connected" : "idle",
      currentMode: this.#options.modeId, stateCells: this.#state.snapshot(), maintenanceStatus: this.#poll?.released ? "released-idle" : "active",
      ...(this.#terminalError ? { fault: this.#terminalError } : {}),
      ...(this.#poll ? { scheduledWork: this.#poll.snapshot } : {}),
      activeOperations: this.#retention.activeOperations, retainedResults: this.#retention.retainedResults,
      ...(this.#connection ? { connection: { modeId: this.#options.modeId, profileId: this.#options.profileId,
        displayName: this.#options.logicalDevice } } : {}) };
  }
  async handle(request: SessionRpcRequest): Promise<SessionRpcResponse> {
    const ok = (result: unknown): SessionRpcResponse => ({ kind: "ok", method: request.kind, callId: request.callId, result }) as SessionRpcResponse;
    try {
      if (request.kind === "attach-client") {
        if (this.#clients.size >= DEFAULT_HOST_RESOURCE_LIMITS.maximumClientsPerSession) throw fault("retained.client-limit", "client limit reached");
        this.#clients.add(request.params.clientId);
        return ok({ heartbeatIntervalMs: 1000, missesAllowed: 5, declaredGoneAfterMs: 5000, reattachAllowed: true, multipleClientsAllowed: true });
      }
      if (!this.#clients.size) throw fault("retained.not-attached", "attach is required");
      switch (request.kind) {
        case "client-heartbeat": return ok(null);
        case "detach-client":
          this.#clients.delete(request.params.clientId);
          if (!this.#clients.size) await this.#disconnect();
          return ok(null);
        case "get-snapshot": return ok(this.#snapshot());
        case "resolve-candidates": return ok([]); // acquisition was supplied by the composition root
        case "connect": {
          if (this.#connection || this.#closed || this.#acquiring || this.#channelOwner) throw fault("retained.connection-state", "candidate session is already connected, acquiring, owned or closed");
          if (request.params.request.mode !== undefined && request.params.request.mode !== this.#options.modeId) throw fault("retained.mode-unavailable", `mode ${JSON.stringify(request.params.request.mode)} not granted`);
          this.#requirements(this.#options.description?.entry?.requires ?? []);
          this.#entering = true;
          try { this.#prepareEntry(); await this.#openConnection(); await this.#entry(); }
          catch (cause) { await this.#disconnect(); throw cause; }
          finally { this.#entering = false; }
          this.#protocolReestablishmentRequired = false;
          this.#poll?.resume(this.#options.modeId, this.#generation);
          return ok({ kind: "connected", modeId: this.#options.modeId, profileId: this.#options.profileId, snapshot: this.#snapshot() });
        }
        case "disconnect": await this.#disconnect(); return ok(null);
        case "start-operation": return ok(this.#start(request.params.request));
        case "inspect-checkpoint": { const { assurance, checkpoint } = await this.#inspectCheckpoint(request.params.checkpointId); return ok({ assurance, source: checkpoint.source }); }
        case "resume-transfer": return ok(await this.#resumeTransfer(request.params.request));
        case "await-operation": return this.#retention.handle(request);
        case "acknowledge-operation": {
          const reply = await this.#retention.handle(request);
          if (reply.kind === "ok") {
            this.#activations.delete(request.params.operationId);
            this.#mailbox.delete(request.params.operationId);
          }
          return reply;
        }
        case "cancel-operation":
          if (this.#activations.get(request.params.operationId)?.handler) throw fault("retained.not-operation", "session handler is not a foreground operation");
          this.#cancel(request.params.operationId); return ok(null);
        case "subscribe": {
          const id = request.params.subscriptionId;
          this.#subscriptions.set(id, this.#delivery.subscribe(id, event => this.#emit({ kind: "event", subscriptionId: id, event }), request.params.options));
          return ok(null);
        }
        case "unsubscribe":
          if (this.#rawTerminal?.subscriptionId === request.params.subscriptionId) await this.#closeRawTerminal(this.#rawTerminal.id);
          this.#subscriptions.get(request.params.subscriptionId)?.dispose(); this.#subscriptions.delete(request.params.subscriptionId); return ok(null);
        case "open-raw-terminal": return ok(await this.#openRawTerminal(request.params.subscriptionId));
        case "write-raw-terminal": return ok(await this.#writeRawTerminal(request.params.terminalId, request.params.bytes));
        case "exit-raw-terminal": return ok(await this.#closeRawTerminal(request.params.terminalId));
        case "start-capture": {
          if (this.#capture || this.#closed) throw fault("retained.capture-state", "capture already active or session closed");
          const id = this.#identity("capture") as CaptureId;
          this.#capture = await DestinationCaptureRecorder.create({ destination: new RemoteCaptureDestination(request.params.destinationId, this.#options.captureDestinationAdapter),
            broker: this.#options.resourceBroker, clock: this.#options.clock, captureId: id, logicalDevice: this.#options.logicalDevice,
            host: { platform: this.#options.platform },
            maximumBufferedBytes: this.#options.maximumCaptureBufferedBytes
              ?? DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
            capture: request.params.options,
            onRecordingLoss: error => { this.#captureFailure = error; this.#expiries?.clear("recording-lost"); this.#poll?.pause(); for (const activation of this.#activations.values()) this.#cancel(activation.id, error); } });
          this.#stamp();
          return ok(id);
        }
        case "stop-capture": {
          if (!this.#capture || this.#capture.captureId !== request.params.captureId) throw fault("retained.capture-state", "capture is not active");
          this.#stamp();
          const capture = this.#capture; this.#capture = undefined;
          return ok(await capture.close());
        }
        default: throw fault("retained.unsupported", "candidate does not implement " + request.kind);
      }
    } catch (cause) {
      return { kind: "error", method: request.kind, callId: request.callId, error: errorValue(cause) };
    }
  }
  async #openRawTerminal(subscriptionId: SubscriptionId): Promise<RawTerminalHandle> {
    if (!this.#subscriptions.has(subscriptionId)) throw fault("retained.raw-terminal-subscription", "raw terminal requires a live owning subscription");
    if (this.#rawTerminal) throw fault("retained.raw-terminal-active", "a raw terminal already owns the channel");
    if (!this.#connection || !this.#lease || !this.#capabilities || this.#closed) throw fault("retained.not-connected", "an established protocol connection is required");
    if (this.#acquiring || this.#entering || this.#checkpointInspection || this.#retention.activeOperations.length || this.#tasks
      || this.#helperTasks || this.#liveEffects.size || this.#outbound.size || this.#waiting.size)
      throw fault("retained.raw-terminal-busy", "protocol work must be quiescent before raw-terminal ownership");
    const connection = this.#connection, protocolLease = this.#lease, group = this.#channelGroup;
    this.#protocolReestablishmentRequired = true; this.#poll?.pause(); this.#generation++;
    this.#capabilities = undefined; this.#lease = undefined; this.#channelGroup = undefined; this.#groupPumps = []; this.#inputPump = undefined;
    this.#channelOwner = undefined; this.#demuxOwner = undefined; this.#revokeRetirement(); this.#expiries?.clear("raw-terminal"); this.#revokeDeliveries();
    this.#buffer = ""; this.#inputRanges.length = 0; this.#inputUtf8Bytes = 0; this.#discardDeferred(); this.#idleMailbox.clearRaw();
    this.#messages.forEach((_, name) => this.#messages.set(name, []));
    await this.#state.invalidate(() => { if (this.#closed) throw fault("retained.revoked", "session closed during raw-terminal transition"); });
    try {
      if (group) await group.release(); else await protocolLease.release();
      const channelId = this.#options.channelRoles?.request ?? this.#options.channelId;
      const channel = connection.channels.find(candidate => candidate.id === channelId);
      if (!channel) throw fault("retained.channel-unavailable", "raw-terminal channel is unavailable");
      const lease = await channel.acquire("raw-terminal"), id = this.#identity("raw-terminal") as RawTerminalId;
      const terminal = { id, subscriptionId, lease, connection };
      this.#lease = lease; this.#rawTerminal = terminal;
      this.#stamp();
      void this.#pumpRawTerminal(terminal);
      return { terminalId: id, exitRequirement: { kind: "reconnect-required", message: "Protocol re-establishment is required after raw-terminal use." } };
    } catch (cause) {
      this.#connection = undefined;
      try { await connection.close("raw-terminal acquisition failed"); } catch { /* original failure wins */ }
      throw cause;
    }
  }
  async #pumpRawTerminal(terminal: RawTerminalSession): Promise<void> {
    try {
      for await (const chunk of terminal.lease.incoming()) {
        if (this.#rawTerminal !== terminal || this.#closed) return;
        const sequence = this.#stamp(), bytes = chunk.bytes.slice();
        this.#capture?.recordBytesStamped({ kind: "rx-delivered", conn: this.#generation, ch: terminal.lease.channelId },
          bytes, sequence, Math.floor(chunk.tUs));
        this.#delivery.publishTo(terminal.subscriptionId, { kind: "raw-terminal-bytes", terminalId: terminal.id, bytes, sequence, tUs: chunk.tUs });
      }
      if (this.#rawTerminal === terminal) await this.#closeRawTerminal(terminal.id,
        { code: "retained.connection-ended", message: "raw-terminal input ended", responsibility: "operation", retryability: "after-reconnect" });
    } catch (cause) {
      if (this.#rawTerminal === terminal) await this.#closeRawTerminal(terminal.id, errorValue(cause));
    }
  }
  async #writeRawTerminal(terminalId: RawTerminalId, value: Uint8Array): Promise<WriteReceipt> {
    const terminal = this.#rawTerminal;
    if (!terminal || terminal.id !== terminalId) throw fault("retained.raw-terminal-owner", "raw-terminal handle is stale or not owned by this session");
    if (!(value instanceof Uint8Array) || !value.length)
      throw fault("retained.raw-terminal-write", "raw-terminal write requires nonempty bytes");
    const bytes = value.slice(), capture = this.#capture, settlement = capture?.reserveObservation(4096), ref = this.#stamp();
    try {
      capture?.recordBytesStamped({ kind: "tx-requested", conn: this.#generation, ch: terminal.lease.channelId },
        bytes, ref, Math.floor(this.#options.clock.monotonicUs()));
      const receipt = await terminal.lease.write(bytes);
      if (this.#rawTerminal === terminal && this.#capture === capture)
        settlement?.record({ kind: "tx-settled", ref, outcome: receipt.outcome }, this.#stamp(), Math.floor(this.#options.clock.monotonicUs()));
      else settlement?.release();
      return receipt;
    } catch (cause) {
      settlement?.release();
      throw cause;
    }
  }
  async #closeRawTerminal(terminalId: RawTerminalId, error?: PdrError): Promise<RawTerminalExitResult> {
    const terminal = this.#rawTerminal;
    if (!terminal || terminal.id !== terminalId) throw fault("retained.raw-terminal-owner", "raw-terminal handle is stale or not owned by this session");
    this.#rawTerminal = undefined; this.#lease = undefined; this.#connection = undefined; this.#generation++;
    this.#stamp();
    try { await terminal.lease.release(); } finally { await terminal.connection.close("raw terminal closed"); }
    this.#publish({ kind: "connection-close", reason: error?.message ?? "raw terminal closed; protocol re-establishment required", ...(error ? { error } : {}) });
    return { kind: "reestablishment-required", refusal: "retained.protocol-reestablishment-required" };
  }
  #transferIdentity(): TransferServiceIdentity {
    if (!this.#options.checkpointStore || !this.#options.executionIdentity || !this.#options.checkpointPolicyDigest)
      throw fault("authored.transfer.unavailable", "host has not granted an identity-bound checkpoint store");
    return { execution: this.#options.executionIdentity.digest, mode: this.#options.modeId,
      device: this.#connection?.identity.stableKey ?? null,
      deviceAssurance: this.#connection?.identity.stableKeyAssurance ?? "none", policy: this.#options.checkpointPolicyDigest };
  }
  async #inspectCheckpoint(id: string) {
    const identity = this.#transferIdentity();
    if (this.#checkpointInspection) throw fault("authored.transfer.inspection-pending", "the earlier store read still owns the inspection slot");
    if (!this.#connection || this.#closed || this.#entering || this.#retention.activeOperations.length || this.#liveEffects.size
      || this.#options.description?.handlers?.some(h => h.requires.some(r => ["channel.write", "usb.control", "connection.lifecycle"].includes(r))))
      throw fault("authored.transfer.offer-unavailable", "connection cannot enter a quiescent resume offer");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw fault("transfer.checkpoint-invalid", "invalid checkpoint ID");
    this.#resumeOffer = id; this.#poll?.pause(); this.#checkpointInspection = true;
    const generation = this.#generation;
    try {
      const value = await this.#options.checkpointStore!.read(id);
      if (this.#closed || generation !== this.#generation || this.#resumeOffer !== id) throw fault("retained.revoked", "checkpoint inspection was superseded");
      const cp = inspectAuthoredCheckpoint(value, identity);
      const op = this.#options.description?.operations.find(o => o.id === cp.authoredTransfer!.operation);
      if (!op?.transfer) throw fault("transfer.resume.definition-mismatch", "checkpoint operation is not available");
      inspectAuthoredCheckpoint(cp, identity, op);
      if (cp.identity.generation === null) throw fault("transfer.resume.preparation-incomplete", "checkpoint has no completed device binding");
      this.#stamp();
      return { assurance: checkpointAssurance(cp), checkpoint: cp };
    } finally {
      // A failed inspection never resumes background device work implicitly.
      // Nor does cancellation free a still-unresolved native storage call.
      this.#checkpointInspection = false;
    }
  }
  async #resumeTransfer(request: ResumeTransferRequest) {
    if (this.#protocolReestablishmentRequired)
      throw fault("retained.protocol-reestablishment-required", "raw-terminal use requires explicit protocol re-establishment");
    const { assurance, checkpoint: cp } = await this.#inspectCheckpoint(request.checkpointId);
    if (cp.authoredTransfer!.operation !== request.operation) throw fault("transfer.resume.definition-mismatch", "checkpoint belongs to another operation");
    return { ...this.#start(request, undefined, request.checkpointId), assurance, source: cp.source };
  }
  #start(request: OperationRequest, poll?: { plan: PollPlan; debit(): boolean }, resumeId?: string): { operationId: OperationId; acceptedAtSequence: number } {
    let preparationWork = 0;
    let funded: Activation | undefined;
    const scratch = new NativeScratch(this.#helperData, units => {
      if (funded) this.#nativeWork(funded, units);
      else {
        if (preparationWork + units > this.#maximumWork) throw fault("retained.work-exhausted", "argument preparation exhausted work before admission to execution");
        preparationWork += units;
      }
    });
    try { return withNativeScratch(scratch, () => {
    if (this.#protocolReestablishmentRequired)
      throw fault("retained.protocol-reestablishment-required", "raw-terminal use requires explicit protocol re-establishment");
    if (!this.#connection || this.#closed || this.#captureFailure) throw fault("retained.not-connected", "live granted connection required");
    if (this.#checkpointInspection) throw fault("authored.transfer.inspection-pending", "the earlier store read has not retired");
    if (poll && this.#resumeOffer) throw fault("authored.poll.quota-skip", "operator resume offer suppresses background work");
    if (this.#entering) throw fault("authored.entry.pending", "session entry must finish before an operation");
    if (this.#poll?.releasing) throw fault("authored.idle-release.pending", "state invalidation must settle before reentry");
    if (!this.#options.operations.includes(request.operation)) throw fault("retained.unknown-operation", "operation is not admitted");
    if (this.#channelOwner && !this.#options.scheduling) throw fault("retained.channel-busy", "another activation owns the channel");
    if (nativeList(this.#activations.values()).filter(value => !value.handler).length >= 32) throw fault("retained.retention-full", "acknowledge earlier operation results");
    if (this.#tasks + this.#helperTasks >= 64) throw fault("retained.task-limit", "shared logical task capacity exhausted");
    if (poll?.plan.suspendWhileLocksHeld.some(lock => this.#lockOwners.has(lock))) throw fault("authored.poll.lock-skip", "poll suspension lock is held");
    let declaration = nativeArray(this.#options.description?.operations)?.find(operation => operation.id === request.operation);
    if (resumeId) {
      if (!declaration?.transfer) throw fault("transfer.resume.definition-mismatch", "operation has no resume binding");
      declaration = { ...declaration, binding: declaration.transfer.resumeBinding };
    }
    if (this.#options.description && !declaration) throw fault("authored.operation.unknown", "operation is not admitted", undefined, "invocation");
    let args: Readonly<Record<string, PublicValue>> | undefined;
    if (declaration) {
      if (nativeArray(declaration.locks).some(lock => this.#lockOwners.has(lock) || nativeList(this.#lockWaiters.values()).some(wait => wait.locks.includes(lock))))
        throw fault("authored.lock-busy", "a declared lock is held or has an earlier waiting handler");
      if (!declaration.availability.modes.includes(this.#options.modeId) || !declaration.availability.profiles.includes(this.#options.profileId))
        throw fault("authored.operation.unavailable", "operation is unavailable for this mode/profile");
      for (const requirement of nativeWalk(declaration.requires)) {
        const capability = this.#options.capabilities?.[requirement];
        if (!capability?.available || (requirement === "connection.lifecycle" && !this.#options.description?.invalidation)) throw fault("authored.capability.unavailable", "required capability unavailable before operation start", {
          requirement, limitation: capability?.limitation ?? "host has not granted this capability", operation: request.operation, started: false });
      }
      if (this.#poll?.released && !poll) {
        if (!declaration.reentry || this.#options.scheduling || !this.#options.execution.startOperation)
          throw fault("authored.reentry.unavailable", "admitted direct-channel reentry required before operation start");
        this.#requirements(declaration.reentry.requires);
        this.#unresolvedOutboundAvailable(undefined, "idle-reentry");
      }
      for (const requirement of nativeWalk(declaration.cleanup?.requires ?? [])) {
        if (!this.#options.capabilities?.[requirement]?.available)
          throw fault("authored.capability.unavailable", "cleanup capability unavailable before operation start", { requirement, started: false });
      }
      // Cleanup leaves unrelated handlers alive and does not take their
      // channel. Its separately granted requirements were checked above.
      if (declaration.cleanup && !this.#options.execution.startOperation)
        throw fault("authored.cleanup.unavailable", "cleanup requires an admitted binding adapter", { started: false });
      if (declaration.cleanup && (this.#tasks + this.#helperTasks + 2 > 64 || this.#timerCount() >= this.#maximumTimers))
        throw fault("authored.cleanup.capacity", "cleanup task and deadline must be withheld before operation start", undefined, "host");
      if (declaration.cleanup && (declaration.cleanup.maximumWork + preparationWork + this.#terminalBaseWork >= this.#maximumWork
        || declaration.cleanup.maximumWork <= this.#terminalBaseWork))
        throw fault("authored.cleanup.budget", "ordinary and cleanup terminal partitions do not fit the operation grant");
      const streamedOutput = (declaration.result.kind === "file" || declaration.result.kind === "resource") && declaration.result.streamed;
      if (declaration.transfer?.segmented || streamedOutput) {
        const count = (declaration.transfer?.segmented ? transferSegmentCount(maximumTransferSourceLength(declaration)) : 1)
          + (streamedOutput ? validateStreamedResult(declaration.result as import("@protodriver/contracts").AuthoredResourceResult, declaration.arguments) - 1 : 0);
        if (!this.#options.execution.advanceSegment || !Number.isSafeInteger(count * this.#maximumWork) || !Number.isSafeInteger(count * RETAINED_LUA_FUEL))
          throw fault("authored.transfer.segment-plan", "complete declared segment authorization is unavailable before start");
      }
      args = validateAuthoredArguments(declaration, request.arguments);
    }
    // This candidate accepts only an optional output resource; no permissive
    // object cast can quietly become arbitrary A-E invocation argument support.
    const resources = new Set<ResourceId>();
    const outputResult = declaration?.result.kind === "file" || declaration?.result.kind === "resource";
    if (outputResult !== (request.resultDestinationId !== undefined)) throw fault("authored.result.destination", "only a declared output result requires a host destination ID", undefined, "invocation");
    if (request.resultDestinationId !== undefined) {
      if (typeof request.resultDestinationId !== "string" || !request.resultDestinationId.length || request.resultDestinationId.length > 256) throw fault("authored.result.destination", "bounded destination ID required", undefined, "invocation");
      if (nativeList(this.#activations.values()).some(a => a.live && a.resources.has(request.resultDestinationId!))) throw fault("authored.result.destination-busy", "destination already delegated", undefined, "host");
      resources.add(request.resultDestinationId);
    }
    for (const [name, supplied] of nativeEntries(declaration ? {} : request.arguments)) {
      if (name !== "output" || supplied.kind !== "resource") throw fault("retained.unsupported-argument", "candidate accepts only the output resource argument");
      resources.add(supplied.id);
    }
    const id = this.#identity("operation") as OperationId;
    const activation: Activation = { id, generation: this.#generation, startedUs: this.#options.clock.monotonicUs(), resources,
      effects: new Map(), live: true, finished: false, work: preparationWork, consumed: 0, revokers: new Set() };
    funded = activation;
    if (declaration && args) {
      activation.declaration = declaration; activation.arguments = args;
      if (this.#poll?.idleReleaseMode) {
        const reentryRequired = !poll && this.#poll.released;
        activation.idleContext = Object.freeze({ origin: poll ? "scheduled" : "foreground", reentryRequired,
          modeId: this.#options.modeId, profileId: this.#options.profileId,
          ...(reentryRequired ? { reentryBinding: declaration.reentry!.binding } : {}) });
        if (reentryRequired) activation.declaration = { ...declaration, requires: [...new Set([...declaration.requires, ...declaration.reentry!.requires])] };
      }
      const sources = nativeArray(nativeEntries(declaration.arguments)).filter(([, type]) => type.kind === "byte-source" || type.kind === "stream-source");
      if (sources.length) {
        activation.sourceArguments = structuredClone(nativeValue(request.arguments));
        activation.sourcePreparation = { requested: sources.length, reads: 0, deliveredBytes: 0, complete: false };
      }
    }
    if (resumeId) activation.resumeId = resumeId;
    if (request.resultDestinationId) activation.output = { id: request.resultDestinationId, bytes: 0 };
    if (declaration?.cleanup) {
      const c = declaration.cleanup;
      const { cleanup: _cleanup, transfer: _transfer, writeVia: _ordinaryRoute, ...ordinary } = declaration;
      activation.maximumWork = this.#maximumWork - c.maximumWork;
      activation.maximumLuaFuel = RETAINED_LUA_FUEL - c.maximumLuaFuel;
      activation.cleanupChild = { id: this.#identity("cleanup") as OperationId, generation: this.#generation,
        startedUs: 0, resources: new Set(), effects: new Map(), live: true, finished: false, work: 0, consumed: 0,
        revokers: new Set(), handler: true, cleanupOwner: activation, maximumWork: c.maximumWork, maximumLuaFuel: c.maximumLuaFuel,
        declaration: { ...ordinary, id: "protocol-cleanup", title: "Protocol cleanup", binding: c.binding,
          arguments: { outcome: { kind: "string" }, code: { kind: "string" },
            ...(c.requires.includes("clock.observe") ? { terminal: clockObservationType } : {}) }, result: { kind: "none" },
          ...(c.writeVia === undefined ? {} : { writeVia: c.writeVia }), requires: c.requires }, arguments: {} };
    }
    this.#reserve(id, activation.effects);
    this.#reserve("arguments:" + id, { values: activation.arguments ?? null, sources: activation.sourceArguments ?? null });
    // No await between refusal checks, permit debit, lock acquisition and
    // normal registration. A skipped poll never becomes a lock waiter.
    if (poll) {
      if (!poll.debit()) { this.#mailbox.delete(id); this.#mailbox.delete("arguments:" + id); throw fault("authored.poll.quota-skip", "session background grant exhausted"); }
      activation.poll = true; activation.locksAcquired = true;
      for (const lock of declaration!.locks) this.#lockOwners.set(lock, activation);
    }
    this.#retention.begin(id); this.#activations.set(id, activation);
    if (!poll) this.#resumeOffer = undefined; // explicit operator action, never a reconnect side effect
    if (!this.#options.scheduling) { this.#channelOwner = id; this.#channelFunding = activation; }
    const acceptedAtSequence = this.#publish({ kind: "operation-start", operationId: id, operation: request.operation });
    if (!poll) this.#poll?.foregroundStarted(id, activation.generation);
    this.#tasks++;
    if (activation.cleanupChild) { this.#tasks++; this.#cleanupTimers++; }
    void this.#run(activation, request.operation);
    return { operationId: id, acceptedAtSequence };
    }); } finally { scratch.close(); }
  }
  #requirements(requirements: readonly string[]): void {
    for (const requirement of requirements) if (!(this.#options.description?.entry?.handoffTo && ["channel.read", "channel.write"].includes(requirement))
      && !this.#options.capabilities?.[requirement]?.available)
      throw fault("authored.capability.unavailable", "required session-entry capability is unavailable before acquisition", { requirement, started: false });
  }
  #prepareEntry(): void {
    const entry = this.#options.description?.entry;
    if (!entry) return;
    const id = this.#identity("entry") as OperationId;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Acquisition may fail before the first authored turn is possible.
    void done.catch(() => undefined);
    const activation: Activation = { id, generation: this.#generation, startedUs: this.#options.clock.monotonicUs(),
      resources: new Set(), effects: new Map(), live: true, finished: false, work: 0, consumed: 0, revokers: new Set(), handler: true,
      // Host context enters through the immutable value ABI, not public
      // operation arguments or effect-free source evaluation.
      declaration: { ...entry, id: "session-entry", title: "Session entry", arguments: {
        modeId: { kind: "string" }, profileId: { kind: "string" } }, result: { kind: "none" },
        risk: "changes-state", repeatability: "not-repeatable", availability: { modes: [this.#options.modeId], profiles: [this.#options.profileId] } },
      arguments: { modeId: this.#options.modeId, profileId: this.#options.profileId },
      entryDone: error => error ? reject(Object.assign(new Error(error.message), { error })) : resolve() };
    this.#preparedEntry = { activation, done };
  }
  async #entry(): Promise<void> {
    const prepared = this.#preparedEntry;
    if (!prepared) return;
    const { activation, done } = prepared, id = activation.id;
    const entry = this.#options.description!.entry!;
    activation.generation = this.#generation;
    if (!this.#options.scheduling || entry.handoffTo) this.#channelOwner = id;
    if (!this.#options.scheduling) this.#channelFunding = activation;
    this.#activations.set(id, activation); this.#tasks++;
    this.#stamp();
    void this.#run(activation, "session-entry");
    await done;
    this.#preparedEntry = undefined;
  }
  #entryOwns(activation: Activation): boolean {
    return Boolean(activation.entryDone && this.#options.description?.entry?.handoffTo
      && !activation.entryHandoff && this.#channelOwner === activation.id);
  }
  #entryTracksInput(activation: Activation): boolean {
    return this.#entryOwns(activation) && this.#options.description?.entry?.inputEvidence === "consumed-ranges";
  }
  #entryInputKey(activation: Activation): string {
    if (!activation.inputChannel) throw fault("retained.input-consumption", "entry has no current reliable input channel");
    return "entry:" + activation.id + ":" + activation.inputChannel;
  }
  async #entryHandoff(parent: Activation, parser: unknown, timers: unknown): Promise<string> {
    this.#live(parent, parent.id);
    if (!this.#entryOwns(parent)) throw fault("retained.wrong-owner", "only opted-in entry can offer this channel");
    const handler = nativeArray(this.#options.description!.handlers!).find(h => h.id === this.#options.description!.entry!.handoffTo)!;
    const effect = this.#effect(parent, "entry-handoff");
    const refuse = (reason: string): string => {
      effect.outcome = "refused";
      this.#stamp();
      return "refused";
    };
    let child: Activation | undefined;
    const revoke = () => { if (child) this.#cancel(child.id); };
    this.#pendingEffects.add(effect);
    try {
      // Retained raw prefixes do not transfer timers or unsettled effects.
      const retained = parser === "retained-prefixes" && this.#entryTracksInput(parent);
      const entryKey = "entry:" + parent.id + ":";
      const cursors = nativeList(this.#consumedInput.entries()).filter(([key]) => key.startsWith(entryKey));
      const prefixes = nativeArray(cursors).filter(([, c]) => c.delivered > c.consumed).map(([key, c]) => ({
        channelId: key.slice(entryKey.length), start: c.consumed, end: c.delivered, physicalSequence: c.physicalSequence }));
      if ((!retained && (parser !== "empty" || prefixes.length > 0)) || timers !== "none" || this.#receiver || this.#waiting.has(parent.id)
        || nativeList(this.#timers.values()).some(timer => timer.activation === parent)
        || nativeList(parent.effects.values()).some(e => e !== effect && this.#pendingEffects.has(e))) return refuse("non-quiescent-or-unsupported");
      if (this.#tasks + this.#helperTasks >= 64) return refuse("task-capacity");
      const offerId = this.#identity("entry-offer"), generation = this.#generation;
      const offer = { offerId, owner: parent.id, recipient: handler.id, channelId: handler.event.channelId,
        generation, parser: retained ? "retained-prefixes" : "empty", timers: "none", ...(retained ? { prefixes } : {}) };
      this.#reserve(offerId, offer);
      try {
        let resolve!: (decision: { value: PublicValue; error?: PdrError }) => void;
        const done = new Promise<{ value: PublicValue; error?: PdrError }>(yes => { resolve = yes; });
        const id = this.#identity("acceptance") as OperationId;
        child = { id, generation, startedUs: this.#options.clock.monotonicUs(), resources: new Set(), effects: new Map(),
          live: true, finished: false, work: 0, consumed: 0, revokers: new Set(), handler: true, accountParent: parent,
          declaration: { id: "entry-acceptance", title: "Entry handoff acceptance", binding: handler.acceptHandoff!,
            arguments: nativeRecord(nativeArray(nativeKeys(offer)).map(key => [key, key === "prefixes"
              ? { kind: "array", maximumLength: 3, item: { kind: "record", fields: {
                  channelId: { kind: "string", maximumLength: 96 },
                  start: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, end: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                  physicalSequence: { kind: "float", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } }
              : key === "generation" ? { kind: "integer", widthBits: 64, signed: false } : { kind: "string", maximumLength: 256 }])),
            result: { kind: "value", type: { kind: "record", fields: { accepted: { kind: "boolean" } } } },
            locks: [], requires: [], risk: "changes-state", repeatability: "not-repeatable",
            availability: { modes: [this.#options.modeId], profiles: [this.#options.profileId] } },
          arguments: offer, acceptanceDone: (value, error) => resolve({ value, ...(error ? { error } : {}) }) };
        this.#activations.set(id, child); this.#tasks++;
        parent.revokers.add(revoke);
        effect.outcome = "offered";
        this.#stamp();
        void this.#run(child, "entry-acceptance");
        const decision = await done;
        return this.#native(parent, () => {
        this.#live(parent, parent.id);
        if (generation !== this.#generation || !this.#entryOwns(parent)) throw fault("retained.revoked", "entry offer revoked before commitment");
        if (decision.error || !(decision.value as { accepted: boolean })?.accepted) return refuse(decision.error?.code ?? "recipient-declined");
        this.#materializeDeferred();
        // Input may have arrived during acceptance. Reserve the actual delivery
        // population before changing ownership, or leave it all with entry.
        // Delivery queues bytes, not one eagerly registered task per native range.
        // Reserve a conservative peak for the compact delivery copies and
        // descriptors before committing authority. No await intervenes between
        // this check and the transfer; refusal leaves the entry queue intact.
        if (this.#idleMailbox.reservedItems + this.#inputRanges.length + 4 > 1024
          || this.#idleMailbox.reservedBytes + this.#fillCapacity
            + this.#buffer.length * 4 + this.#inputRanges.length * 1024 > 16 * 1024 * 1024)
          return refuse("delivery-capacity");
        // Reserve every destination before any custody changes. No prefix is
        // replayed into Lua; its existing private bytes remain with the module.
        for (const [key, cursor] of cursors) {
          activeNativeScratch()?.iteration();
          const destination = handler.id + ":" + key.slice(entryKey.length);
          if (this.#consumedInput.has(destination)) return refuse("recipient-already-has-input-custody");
          this.#reserve("consumed-input:" + destination, cursor);
        }
        const committed = this.#stamp();
        for (const [key, cursor] of cursors) {
          activeNativeScratch()?.iteration();
          const channelId = key.slice(entryKey.length), destination = handler.id + ":" + channelId;
          this.#consumedInput.set(destination, cursor);
          const ranges = this.#inputWorkRanges.get(key);
          if (ranges) { this.#inputWorkRanges.set(destination, ranges); this.#inputWorkRanges.delete(key); }
          this.#consumedInput.delete(key); this.#mailbox.delete("consumed-input:" + key);
          this.#stamp();
        }
        this.#channelOwner = this.#demuxOwner;
        parent.entryHandoff = true;
        this.#stamp();
        while (this.#inputRanges.length) {
          activeNativeScratch()?.iteration();
          const { sequence, recordedSequence, offset, length, channelId, tUs } = this.#inputRanges[0]!, bytes = this.#takeInput(length);
          this.#queueHandler(stringBytes(bytes), sequence, recordedSequence, parent, committed, offset, channelId, tUs);
        }
        effect.outcome = "accepted";
        parent.readySequence = committed;
        return "accepted";
        });
      } finally { this.#mailbox.delete(offerId); }
    } catch (cause) {
      effect.outcome = "failed-or-revoked";
      throw cause;
    } finally {
      parent.revokers.delete(revoke);
      this.#settleEffect(parent, effect);
    }
  }
  #live(activation: Activation, owner?: string): void {
    if (!activation.live || this.#closed || activation.generation !== this.#generation) throw fault("retained.revoked", "activation authority is revoked");
    if (activation.accountParent && !activation.accountParent.live && !activation.inheritedInput) throw fault("retained.revoked", "causing activation is revoked");
    if (activation.workFailure) throw activation.workFailure;
    const expected = owner ?? (!this.#options.scheduling ? activation.id : undefined);
    const consumingOwner = this.#routed.get(activation.id)?.owner ?? this.#channelOwner;
    if (expected !== undefined && consumingOwner !== expected
      && !(!this.#routed.has(activation.id) && (activation.inputHandler || (!this.#options.description && activation.handler)) && expected === activation.id && this.#channelOwner === this.#demuxOwner))
      throw fault("retained.wrong-owner", "channel belongs to a different owner"); // handoff bypass mutation target
    if (this.#captureFailure) throw Object.assign(new Error(this.#captureFailure.message), { error: this.#captureFailure });
  }
  #charge(activation: Activation, owner?: string): void {
    this.#live(activation, owner);
    const account = activation.accountParent ?? activation;
    if (account.work + (account.reservedWork ?? 0) >= this.#workCeiling(account)) {
      activation.workFailure = fault("retained.work-exhausted", "activation effect/work account exhausted before next unit");
      account.workFailure = activation.workFailure;
      throw activation.workFailure;
    }
    activation.work++;
    if (account !== activation) account.work++;
  }
  #nativeWork(activation: Activation, units: number): void {
    const account = activation.accountParent ?? activation;
    if (activation.workFailure) throw activation.workFailure;
    if (account.workFailure) throw account.workFailure;
    if (!Number.isSafeInteger(units) || units < 0 || account.work + (account.reservedWork ?? 0) + units > this.#workCeiling(account)) {
      activation.workFailure = fault("retained.work-exhausted", "native work exhausted the cumulative activation account");
      account.workFailure = activation.workFailure;
      throw activation.workFailure;
    }
    activation.work += units;
    if (account !== activation) account.work += units;
  }
  #workCeiling(account: Activation): number {
    return (account.maximumWork ?? this.#maximumWork) + (account.segments?.workBase ?? 0);
  }
  #native<T>(activation: Activation, run: () => T): T {
    const scratch = new NativeScratch(this.#helperData, units => this.#nativeWork(activation, units));
    (activation.nativeScratch ??= new Set()).add(scratch);
    return withNativeScratch(scratch, run);
  }
  #nativeTransient<T>(activation: Activation, run: () => T): T {
    const scratch = new NativeScratch(this.#helperData, units => this.#nativeWork(activation, units));
    try { return withNativeScratch(scratch, run); } finally { scratch.close(); }
  }
  async #nativeAsync<T>(activation: Activation, run: () => Promise<T>): Promise<T> {
    // Only the synchronous preparation runs in the scope. A post-await
    // conversion must explicitly enter #native again. Storage remains owned
    // through the wait and is handed off at the next turn or terminal result.
    const { promise } = this.#native(activation, () => ({ promise: run() }));
    return await promise;
  }
  #releaseNative(activation: Activation): void {
    for (const scratch of activation.nativeScratch ?? []) scratch.close();
    activation.nativeScratch?.clear();
  }
  #newRunway(activation: Activation): NativeRunway {
    const account=activation.accountParent??activation;
    return new NativeRunway(this.#helperData,units=>{
      if(account.work+(account.reservedWork??0)+units>this.#workCeiling(account))
        throw fault("retained.work-exhausted","terminal work must be reserved before accepting more work");
      account.reservedWork=(account.reservedWork??0)+units;
    },units=>{
      account.reservedWork=(account.reservedWork??0)-units;
      activation.work+=units;if(account!==activation)account.work+=units;
    },units=>{account.reservedWork=(account.reservedWork??0)-units;},activation.id);
  }
  #ensureTerminal(activation: Activation, slots: number): void {
    const fresh=activation.terminal===undefined;
    activation.terminal??=this.#newRunway(activation);
    // Bounded host receipt fields, plus each retained effect's terminal and
    // cancellation copies. Variable result/payload preparation stays on the
    // ordinary account; these are reservations, not consumed work or limits.
    try {activation.terminal.ensure(this.#terminalBaseWork+slots*256,this.#terminalBaseCapacity+slots*2048);}
    catch(cause){if(fresh){activation.terminal.close();delete activation.terminal;}throw cause;}
  }
  #terminal<T>(activation: Activation, work:()=>T):T {
    return activation.terminal ? activation.terminal.run(work) : work();
  }
  async #retireVm(activation: Activation, retainAccount = false): Promise<void> {
    if (activation.cleanupRetired) return;
    const countCleanupFuel = (used: number) => {
      if (activation.cleanupOwner || activation.idleContext || activation.accountParent?.cleanupOwner) {
        activation.consumed += used;
        if (activation.accountParent) activation.accountParent.consumed += used;
      }
    };
    const retire = async () => {
      activation.retiring = true;
      try {
        const { promise } = this.#terminal(activation, () => ({ promise: this.#options.execution.retire(activation.id, retainAccount) }));
        const result = await promise;
        if (result) countCleanupFuel(result.consumed);
      } finally { delete activation.retiring; }
    };
    await (this.#closed ? retire() : this.#turns.enqueue(this.#stamp(), retire)).catch(async cause => {
      const used = (cause as { fuelConsumed?: unknown })?.fuelConsumed;
      if (typeof used === "number" && Number.isSafeInteger(used) && used > 0 && used <= RETAINED_LUA_FUEL) countCleanupFuel(used);
      if (this.#options.execution.terminated && !this.#closed) await this.#disconnect(errorValue(cause));
    });
    if (activation.cleanupOwner || activation.idleContext) activation.cleanupRetired = true;
  }
  #connected(): { connection: string; lease: string } {
    if (!this.#connection || !this.#lease || !this.#capabilities) throw fault("retained.not-connected", "no live connection grant");
    return this.#capabilities;
  }
  #capability(value: unknown, kind: "connection" | "lease"): void {
    if (text(value) !== this.#capabilities?.[kind]) throw fault("retained.capability-not-granted", "stale, wrong-kind or unknown " + kind + " capability");
    this.#connected();
  }
  #identity(kind: string): string {
    if (!Number.isSafeInteger(this.#serial + 1)) throw fault("retained.identity-exhausted", "identity space exhausted");
    return "retained-" + kind + "-" + (++this.#serial);
  }
  async #openConnection(activation?: Activation): Promise<string> {
    if (this.#closed || this.#connection || this.#acquiring) throw fault("retained.connection-state", "cannot reacquire a live, acquiring or closed session");
    this.#outboundAvailable(activation, "reacquire");
    this.#acquiring = true;
    let connection: DeviceConnection | undefined, lease: ChannelLease | undefined, group: ChannelGroup | undefined;
    const check = () => {
      if (this.#closed) throw fault("retained.revoked", "session closed during acquisition");
      if (activation) this.#live(activation);
    };
    try {
      check(); connection = await this.#options.open(); check();
      const selectChannel = () => nativeArray(connection!.channels).find(channel => channel.id === this.#options.channelId);
      if (this.#options.channelRoles) group = await ChannelGroup.acquire(connection, this.#options.channelRoles, check,
        () => { if (activation) this.#charge(activation); });
      const channel = group?.request.channel ?? (activation ? this.#native(activation, selectChannel) : selectChannel());
      if (!channel) throw fault("retained.channel-unavailable", "granted channel missing");
      lease = group?.request.lease ?? await channel.acquire("protocol"); check();
      const install = () => {
      const capabilities = { connection: this.#identity("connection"), lease: this.#identity("lease") };
      const generation = ++this.#generation;
      // Reserve at the original native observation, including the synchronous
      // buffered census before publication. Entry borrows its existing counter;
      // it does not receive an additional external-input grant per fragment.
      const inputs = group ? group.inputs.map(input => input.lease) : [lease!];
      const certify = this.#retirement && this.#options.capabilities?.["input.retirement"]?.available;
      if (certify) {
        if (this.#options.inputRetirementSupport?.clock !== this.#options.clock || !inputs.every(input => input.bindInputCustody)
          || (group && group.request.channel.direction !== "out" && !inputs.includes(group.request.lease)))
          throw fault("retained.input-retirement-unavailable", "complete original-stamp group is unavailable");
        this.#inputIndex = new InputRetirementIndex(sequence => {
          const source = this.#nativeInputWork.get(sequence);
          if (!source) throw fault("retained.input-retirement-unavailable", "original observation has no funded account");
          return source.custodyAccount();
        });
      }
      if (this.#options.scheduling && inputs.every(input => input.bindInputCustody)) {
        let receiving = true;
        let attested = 0;
        for (const input of inputs) {
        const sink: InputCustodySink = { clock: this.#options.clock,
          ...(certify ? { attested: (receipt: object) => {
            if (!isInputCustodyAttestation(receipt, sink)) throw fault("retained.input-retirement-unavailable", "invalid original-stamp attestation");
            attested++;
          } } : {}),
          observed: (sequence, bytes) => {
            if (!receiving) return;
            const entry = !activation && this.#options.description?.entry?.handoffTo && !this.#preparedEntry?.activation.entryHandoff
              ? this.#preparedEntry?.activation : undefined;
            const ranges = (entry ? this.#options.description?.entry : this.#options.description?.handlers?.[0])?.inputEvidence === "consumed-ranges";
            const account = new InputWorkAccount(this.#helperData, this.#maximumWork, bytes, ranges,
              entry ? {
                work: () => entry.work,
                reserve: units => {
                  if (entry.work + (entry.reservedWork ?? 0) + units > this.#workCeiling(entry))
                    throw fault("retained.work-exhausted", "entry input disposal must fit its existing account");
                  entry.reservedWork = (entry.reservedWork ?? 0) + units;
                },
                charge: units => this.#nativeWork(entry, units),
                spend: units => { entry.reservedWork! -= units; entry.work += units; },
                release: units => { entry.reservedWork! -= units; },
              } : undefined);
            try { account.nativeBegin(bytes); } catch (cause) { account.revoke(); account.close(); throw cause; }
            if (this.#inputIndex) {
              this.#nativeInputWork.set(sequence, account);
              try { this.#inputIndex.register(sequence, bytes); account.attachCustody(this.#inputIndex, sequence); }
              catch (cause) { this.#revokeRetirement(); account.nativeEnd(); account.revoke(); account.close(); this.#nativeInputWork.delete(sequence); throw cause; }
            }
            if (entry && ranges) {
              try { (entry.inputInterpretations ??= new Set()).add(account.interpretation()); this.#retainCustody(entry, account); }
              catch (cause) { account.nativeEnd(); account.revoke(); account.close(); throw cause; }
            }
            if (entry) { entry.accountChildren = (entry.accountChildren ?? 0) + 1; this.#inputParents.set(account, entry); }
            account.disposed = () => {
              this.#nativeInputWork.delete(sequence); this.#inputWork.delete(sequence);
              this.#inputParents.delete(account);
              if (entry && --entry.accountChildren! === 0) entry.childrenRetired?.();
            };
            if (entry) account.consumed = () => account.close();
            this.#inputWork.set(sequence, account); this.#nativeInputWork.set(sequence, account);
            return { discarded: () => { account.nativeEnd(); account.revoke(); account.close(); } };
          },
          // Revocation removes authority, not native ownership. Queue discard
          // and the actual iterator reaction separately release their tickets.
          revoked: () => { receiving = false; this.#revokeRetirement(); },
        };
        input.bindInputCustody!(sink);
        }
        if (certify) {
          if (attested !== inputs.length || !receiving) throw fault("retained.input-retirement-unavailable", "group census was not completely attested");
          this.#retirementCut = Object.freeze({ index: this.#inputIndex!, clock: this.#options.clock, basisId: this.#time!.state.basisId, generation });
        }
      }
      // Iterator construction belongs to acquisition, before any grant observation
      // or entry-visible authority. A throwing second input rolls back all.
      const groupPumps: InputPump[] = group ? group.inputs.map(({ channel: input, lease: inputLease }) => ({
        iterator: inputLease.incoming()[Symbol.asyncIterator](), generation, channelId: input.id,
        capability: capabilities.lease, standing: input.protocolDuplex !== "half-duplex", pending: false })) : [];
      const inputPump = group ? groupPumps[0] : { iterator: lease!.incoming()[Symbol.asyncIterator](), generation,
        capability: capabilities.lease, standing: channel.protocolDuplex !== "half-duplex", pending: false };
      if (activation) {
        delete activation.inputChannel;
        activation.generation = generation;
        this.#poll?.operationReacquired(activation.id, generation);
        if (activation.cleanupOwner) this.#poll?.operationReacquired(activation.cleanupOwner.id, generation);
      }
      this.#connection = connection; this.#lease = lease; this.#capabilities = capabilities;
      this.#channelGroup = group;
      if (this.#options.scheduling) {
        this.#demuxOwner = this.#identity("demultiplexer");
        // Reserve entry ownership before the native pump can deliver anything.
        this.#channelOwner = !activation && this.#options.description?.entry?.handoffTo ? undefined : this.#demuxOwner;
      }
      this.#capture?.record({ kind: "connection-open", conn: generation, profileId: this.#options.profileId,
        modeId: this.#options.modeId, identity: connection!.identity,
        channels: nativeArray(connection!.channels).map(({ id, direction }) => ({ id, direction })) });
      this.#stamp();
      if (this.#demuxOwner && this.#channelOwner === this.#demuxOwner) this.#stamp();
      check();
      this.#groupPumps = groupPumps;
      this.#inputPump = inputPump;
      this.#pump();
      this.#publish({ kind: "connection-open", connection: this.#snapshot().connection! });
      return capabilities.connection + "|" + capabilities.lease;
      };
      return activation ? this.#native(activation, install) : install();
    } catch (cause) {
      this.#revokeRetirement();
      // An unabortable open/acquire may settle after cancellation. Its native
      // objects are disposed, never installed as a new grant for a dead owner.
      if (this.#connection === connection) { this.#connection = undefined; this.#lease = undefined; this.#capabilities = undefined; }
      this.#channelGroup = undefined; this.#groupPumps = []; this.#inputPump = undefined;
      try { if (group) await group.release(); else await lease?.release(); } finally { await connection?.close(); }
      throw cause;
    } finally { this.#acquiring = false; }
  }
  async #closeConnection(activation: Activation, capability: unknown): Promise<string> {
    this.#capability(capability, "connection");
    const effect = this.#effect(activation, "connection-close"); this.#live(activation);
    this.#pendingEffects.add(effect);
    try {
      const connection = this.#connection!, lease = this.#lease!, group = this.#channelGroup, generation = this.#generation;
      effect.outcome = "closing";
      this.#capabilities = undefined; this.#connection = undefined; this.#lease = undefined;
      this.#channelGroup = undefined; this.#groupPumps = []; this.#inputPump = undefined;
      this.#poll?.pause();
      this.#generation++; activation.generation = this.#generation;
      this.#revokeRetirement();
      this.#expiries?.clear("connection-ended");
      this.#revokeDeliveries();
      this.#buffer = ""; this.#inputRanges.length = 0; this.#inputUtf8Bytes = 0;
      this.#discardDeferred(); this.#idleMailbox?.clearRaw();
      this.#mailbox.delete("input"); this.#mailbox.delete("input-ranges");
      for (const [id, timer] of this.#timers) this.#dropTimer(id, timer, "connection-ended");
      for (const wait of this.#waiting.values()) wait.reject(fault("retained.revoked", "connection ended"));
      this.#waiting.clear();
      // Mailbox payloads and taps carry channel-generation provenance too.
      // Reacquisition must not feed an old delivery to a new operation.
      for (const [name, messages] of this.#messages) {
        if (messages.length) this.#stamp();
        this.#messages.set(name, []); this.#mailbox.delete("messages:" + name);
      }
      for (const id of this.#taps.keys()) this.#mailbox.delete(id);
      this.#taps.clear();
      for (const [id, channel] of this.#routed) {
        channel.receiver?.reject(fault("retained.revoked", "routed channel generation ended"));
        this.#mailbox.delete("routed:" + id);
      }
      this.#routed.clear();
      if (this.#receiver) { const receive = this.#receiver; this.#receiver = undefined; receive.reject(fault("retained.revoked", "connection ended")); }
      for (const other of this.#activations.values()) if (other !== activation) this.#cancel(other.id);
      this.#stamp();
      this.#publish({ kind: "connection-close", reason: "authored close" });
      try { if (group) await group.release(); else await lease.release(); } finally { await connection.close(); }
      effect.outcome = "closed";
      // This is a delivered, serialized Lua turn, not a pollable freshness flag
      // or an ordinary resume pretending that old device facts remain valid.
      await this.#state.invalidate(() => this.#live(activation), run => this.#nativeTransient(activation, run));
      const reply = await this.#invalidation(activation, generation);
      if (this.#native(activation, () => nativeKeys(reply).join(",")) !== "kind" || reply.kind !== "invalidated")
        throw fault("retained.invalidation-not-acknowledged", "dispatcher must process connection invalidation");
      this.#stamp();
      return "closed";
    } catch (cause) {
      // If cancellation, failed disposal or a bad dispatcher prevents delivery,
      // do not retain silently stale state. This narrow candidate ends the VM.
      effect.outcome = "failed";
      if (!activation.finished) this.#finish(activation, "failed", null, errorValue(cause));
      await this.#disconnect(); throw cause;
    } finally { this.#settleEffect(activation, effect); }
  }
  async #invalidation(parent: Activation, generation: number): Promise<Record<string, unknown>> {
    if (!this.#options.description?.invalidation) return this.#turn(parent, "invalidate", String(generation));
    const id = this.#identity("invalidation") as OperationId;
    const event: Activation = { id, generation: this.#generation, startedUs: this.#options.clock.monotonicUs(), resources: new Set(),
      effects: new Map(), live: true, finished: false, work: 0, consumed: 0, revokers: new Set(), handler: true, eventAccount: true, accountParent: parent };
    if (this.#tasks + this.#helperTasks >= 64) throw fault("retained.task-limit", "invalidation task capacity exhausted");
    this.#activations.set(id, event); this.#channelOwner = id; this.#tasks++;
    this.#stamp();
    try { return await this.#turn(event, "invalidate", String(generation)); }
    finally {
      event.live = false; event.finished = true;
      this.#terminal(event, () => this.#stamp());
      await this.#retireVm(event);
      event.resultScratch?.release?.(); this.#releaseNative(event);
      event.terminal?.close(); delete event.terminal;
      this.#activations.delete(id); this.#mailbox.delete(id); this.#tasks--;
      if (parent.live && !this.#closed) this.#channelOwner = parent.id;
    }
  }
  #effect(activation: Activation, kind: string, accepted = true): Effect {
    return this.#native(activation, () => this.#accountedEffect(activation, kind, accepted));
  }
  #accountedEffect(activation: Activation, kind: string, accepted: boolean): Effect {
    if (this.#liveEffects.size >= DEFAULT_HOST_RESOURCE_LIMITS.maximumOutstandingBrokerCalls)
      throw fault("retained.effect-limit", "outstanding effect ledger exhausted");
    this.#ensureTerminal(activation,Math.min(64,activation.effects.size+1));
    // The bounded observation window is not the outstanding-slot account.
    // Evict only already retired terminal facts, reporting lost history.
    let evict: string | undefined;
    if (activation.effects.size >= 64) for (const old of nativeWalk(activation.effects.values())) {
      if (!this.#liveEffects.has(old.id)) { evict = old.id; break; }
    }
    if (activation.effects.size >= 64 && evict === undefined)
      throw fault("retained.effect-limit", "activation effect window has no retired entry");
    const effect = { id: this.#identity("effect"), kind, outcome: "not-submitted" };
    if (!this.#idleMailbox.reserveEffect(activation.id, activation.effects, this.#liveEffects, effect, evict, this.#fillCapacity))
      throw fault("retained.mailbox-overflow", "aggregate execution mailbox exhausted");
    if (evict !== undefined) activation.effectsEvicted = (activation.effectsEvicted ?? 0) + 1;
    this.#stamp();
    return effect;
  }
  #settleEffect(activation: Activation, effect: Effect, record = true): void {
    this.#terminal(activation,()=>this.#settleEffectReserved(activation,effect,record));
  }
  #settlement(activation: Activation, effect: Effect): void {
    this.#terminal(activation, () => {
      try { this.#stamp(); }
      finally { this.#settleEffect(activation, effect); }
    });
  }
  #settleEffectReserved(activation: Activation, effect: Effect, record: boolean): void {
    this.#pendingEffects.delete(effect);
    if (this.#accountedEffects.has(effect)) return;
    // The mutable slot now holds its terminal outcome in the bounded
    // observation window. Required recording must accept that fact first.
    this.#accountedEffects.add(effect);
    if (record) this.#stamp();
    this.#retireEffect(effect);
  }
  #retireEffect(effect: Effect): void {
    if (!this.#accountedEffects.has(effect) || this.#pendingEffects.has(effect) || this.#captureFailure) return;
    activeNativeScratch()?.iteration(); // retire the live capacity-index entry
    this.#liveEffects.delete(effect.id); // terminal-accounting retirement mutation target
    this.#idleMailbox.releaseEffect(effect);
  }
  async #turn(activation: Activation, action: string, value: WaitCompletion | Uint8Array | AuthoredClockObservation | AuthoredExpiryObservation | AuthoredInputRetirement,
    finishTurn?: (request: Record<string, unknown>) => void, resumingEffect?: string): Promise<Record<string, unknown>> {
    this.#live(activation);
    activation.resultScratch?.release?.(); delete activation.resultScratch;
    const prefix = action + "|" + activation.id + "|";
    const byteWait = typeof value === "object" && !(value instanceof Uint8Array) ? value : undefined;
    const key = "turn:" + activation.id;
    const input = this.#native(activation, () => {
      const input = byteWait ?? (value instanceof Uint8Array ? joinBytes(prefix, value) : prefix + value);
      this.#reserve(key, input); return input;
    });
    this.#releaseNative(activation); // mailbox now owns the complete crossing
    const sequence = activation.readySequence ?? this.#stamp();
    activation.readySequence = undefined;
    const turn = this.#turns.enqueue(sequence, async () => {
      this.#charge(activation); // explicit continuation dispatch, exactly once
      if (action === "start" || activation.eventAccount) this.#ensureTerminal(activation, 0);
      if (action === "start" || activation.eventAccount) await this.#options.execution.register(activation.id, activation.accountParent?.id, units => {
        // Synchronous VM encoding has no channel authority. Retirement can
        // encode after handoff, but still spends the original work account.
        const account = activation.accountParent ?? activation;
        if(activation.retiring&&activation.terminal){activation.terminal.charge(units);return;}
        if (!Number.isSafeInteger(units) || units < 1 || account.work + (account.reservedWork ?? 0) + units > this.#workCeiling(account)) {
          activation.workFailure = fault("retained.work-exhausted", "native encoding exhausted the activation work account");
          account.workFailure = activation.workFailure;
          throw activation.workFailure;
        }
        if (activation.workFailure) throw activation.workFailure;
        if (account.workFailure) throw account.workFailure;
        activation.work += units;
        if (account !== activation) account.work += units;
      }, activation.maximumLuaFuel, activation.segments?.count);
      this.#live(activation); // registration may have settled after cancellation
      this.#stamp();
      let result: RetainedDispatchResult;
      if (action === "resume" && activation.pendingExpiryDelivery !== undefined) {
        if (value !== activation.pendingExpiryDelivery) throw fault("retained.expiry-not-deliverable", "expiry completion identity mismatch");
        this.#expiries!.commitDelivery(activation.id, activation.pendingExpiryDelivery);
        delete activation.pendingExpiryDelivery;
        this.#live(activation);
      }
      // No await between the delivery commit and this executor invocation.
      try { result = action === "start" && activation.declaration
        ? await this.#options.execution.startOperation!(activation.id, activation.declaration.binding, activation.arguments!, this.#native(activation, () => sourceValueTypes(activation.declaration!)), activation.output?.id, activation.idleContext)
        : typeof input === "object" && !(input instanceof Uint8Array)
          ? "basisId" in input ? await this.#options.execution.dispatchObservation!(activation.id, input)
          : await this.#dispatchWaitBytes(activation.id, input)
        : input instanceof Uint8Array
          ? await this.#dispatchBytes(activation.id, input)
          : await this.#options.execution.dispatch(activation.id, input);
      } catch (cause) {
        const used = (cause as { fuelConsumed?: unknown })?.fuelConsumed;
        if (typeof used === "number" && Number.isSafeInteger(used) && used > 0 && used <= RETAINED_LUA_FUEL) {
          activation.consumed += used;
          if (activation.accountParent) activation.accountParent.consumed += used;
        }
        const vm = cause as { vmStatus?: unknown; dispatchContext?: DispatchFailureContext };
        if (typeof vm?.vmStatus === "number" && Number.isSafeInteger(vm.vmStatus) && vm.vmStatus < 0) {
          const role = activation.cleanupOwner ? "cleanup" : activation.entryDone ? "entry"
            : activation.declaration?.id === "write-authorization" ? "write-authorization"
            : activation.eventAccount ? "session-event" : activation.handler ? "handler" : "operation";
          vm.dispatchContext = { action, role, ...(activation.declaration?.binding ? { binding: activation.declaration.binding } : {}),
            ...(resumingEffect ? { resumingEffect } : {}) };
        }
        throw cause;
      }
      activation.resultScratch = result;
      if (action === "start") {
        // The VM has consumed the invocation. Its own retained copies remain
        // charged there; host source staging no longer owns a live value.
        activation.sourceStorage?.release(); delete activation.sourceStorage;
        delete activation.arguments;
        this.#mailbox.delete("arguments:" + activation.id);
      }
      activation.consumed += result.consumed;
      if (activation.accountParent) activation.accountParent.consumed += result.consumed;
      this.#live(activation); // queued cancellation cannot be undone by a worker response
      this.#native(activation, () => this.#reserve(key, result.value));
      const request = object(result.value);
      // The author has returned: no later disposal promise is interpretation.
      // End this dependency inside the serialized dispatch before another
      // activation can sample a cut. Work/VM lifetime remains independent.
      if (request.kind === "result") this.#endCustody(activation);
      this.#native(activation, () => finishTurn?.(request)); // Decision and native acceptance precede the next authored turn.
      if (activation.delivery) this.#scheduleHandlers();
      return request;
    });
    try { return await turn; } finally { this.#mailbox.delete(key); }
  }
  async #dispatchBytes(id: string, input: Uint8Array) {
    if (!this.#options.execution.dispatchBytes) throw fault("retained.unsupported-bytes", "execution port has no byte completion adapter");
    return this.#options.execution.dispatchBytes(id, input);
  }
  async #dispatchWaitBytes(id: string, value: Exclude<WaitCompletion, string>) {
    if (!this.#options.execution.dispatchWaitBytes) throw fault("retained.unsupported-bytes", "execution port has no byte wait-completion adapter");
    return this.#options.execution.dispatchWaitBytes(id, value.prefix, value.bytes);
  }
  async #run(activation: Activation, operation: string, input?: string | Uint8Array): Promise<void> {
    try {
      this.#ensureTerminal(activation,0);
      if (activation.cleanupChild) this.#ensureTerminal(activation.cleanupChild, 0);
      await this.#nativeAsync(activation, () => this.#takeLocks(activation));
      if (activation.output && activation.declaration && (activation.declaration.result.kind === "file" || activation.declaration.result.kind === "resource")
        && activation.declaration.result.streamed) {
        const output = activation.output;
        const subject = this.#nativeTransient(activation, () => resolveResultSubject(activation.declaration!.result as import("@protodriver/contracts").AuthoredResourceResult, activation.arguments!));
        if (!this.#options.resourceBroker.grantWrite) throw fault("authored.result.stream-unavailable", "broker has no fresh output delegation");
        output.held = this.#helperData.reserve(4096);
        output.stream = new StreamingResult(subject, () => this.#nativeWork(activation,1));
        activation.segments = { count: output.stream.count, index: 0, workBase: 0, fuelBase: 0 };
        await this.#sourceCall(activation,"result-grant",{source:output.id,subject},0,async callId => {
          output.stream!.grant = await this.#options.resourceBroker.grantWrite!(output.id,activation.id,subject.length,{callId});
          return output.stream!.grant;
        }, grant => ({grant}));
        this.#live(activation);
        this.#nativeTransient(activation, () => this.#stamp());
      }
      if (activation.sourceArguments) {
        const sourceGeneration = this.#generation;
        const context: SourcePreparationContext = {
          id: activation.id, broker: this.#options.resourceBroker,
          live: () => { this.#live(activation); if (sourceGeneration !== this.#generation) throw fault("retained.revoked", "source grant belongs to an earlier connection generation"); }, iteration: () => this.#charge(activation),
          native: run => this.#native(activation, run),
          reserve: bytes => this.#helperData.reserve(bytes),
          preflight: (args, lengths) => {
            const port = this.#options.execution;
            if (!port.preflightSourceInput) throw fault("authored.source.input-policy", "execution has no complete invocation reservation");
            return port.preflightSourceInput(activation.id, activation.declaration!.binding, args,
              sourceValueTypes(activation.declaration!), lengths, () => this.#charge(activation), activation.output?.id, activation.idleContext);
          },
          call: (kind, fields, run, observed) => this.#sourceCall(activation, kind, fields, 0, run, observed),
          read: (fields, maximum, run) => this.#sourceCall(activation, "source-read", { ...fields, requestedBytes: maximum }, maximum, run, result => {
            activation.sourcePreparation!.reads++;
            activation.sourcePreparation!.deliveredBytes += result.data.byteLength;
            return { deliveredBytes: result.data.byteLength, eof: result.eof,
              data: btoa(byteString(new Uint8Array(result.data))) };
          }),
          mark: () => this.#nativeTransient(activation, () => { this.#stamp(); }),
        };
        const streaming = await openStreamingSources(activation.declaration!, activation.sourceArguments, activation.arguments!, context);
        activation.streams = streaming.streams;
        const prepared = await materializeSourceArguments(activation.declaration!, activation.sourceArguments, streaming.values, context);
        activation.sourceStorage = prepared;
        this.#live(activation);
        activation.arguments = prepared.values;
        activation.sourcePreparation!.complete = activation.streams.size === 0;
        delete activation.sourceArguments;
      }
      if (activation.declaration?.transfer) {
        if (activation.declaration.transfer.segmented) {
          const value = activation.arguments![activation.declaration.transfer.sourceArgument];
          const stream = activation.streams?.get(value as string);
          const encoded = stream ? "" : (value as { value: string }).value;
          const descriptorLength = stream?.descriptorLength ?? (encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0));
          const range = resolveTransferSourceRange(activation.declaration, activation.arguments!, descriptorLength);
          const length = range?.length ?? descriptorLength;
          const count = transferSegmentCount(length) + (activation.output?.stream?.count ?? 1) - 1;
          if (!Number.isSafeInteger(count * this.#maximumWork) || !Number.isSafeInteger(count * RETAINED_LUA_FUEL))
            throw fault("authored.transfer.segment-plan", "actual source has an unrepresentable aggregate grant");
          activation.segments = { count, index: 0, workBase: 0, fuelBase: 0 };
          this.#nativeTransient(activation, () => this.#stamp());
        }
        activation.transferGeneration = this.#generation;
        activation.transfer = await AuthoredTransfer.prepare(this.#options.checkpointStore!, activation.declaration, activation.arguments!, this.#transferIdentity(), {
          live: () => { this.#live(activation); if (activation.transferGeneration !== this.#generation)
            throw fault("transfer.resume.identity-mismatch", "transfer service grant does not survive connection generation replacement"); },
          charge: units => this.#nativeWork(activation, units),
          native: run => this.#native(activation, run),
          takeEvidence: () => { const evidence = activation.inputEvidence; delete activation.inputEvidence;
            this.#mailbox.delete("evidence:" + activation.id);
            if (evidence) this.#nativeTransient(activation, () => this.#stamp());
            return evidence; },
          reserve: bytes => this.#helperData.reserve(bytes),
          call: (kind, run) => this.#sourceCall(activation, kind, { source: "authored-checkpoint" }, 0, run),
          progress: cp => this.#nativeTransient(activation, () => {
            this.#stamp();
            const p = activation.segments && activation.transfer?.segmentProgress;
            this.#publish({ kind: "transfer-progress", operationId: activation.id, checkpointId: cp.id as CheckpointId, phase: cp.phase,
              ...(cp.source.subject ? { sourceSubject: cp.source.subject } : {}),
              ...(p ? { segmentation: { quantum: p.quantum, index: activation.segments!.index, count: p.count,
                submittedSourceOffset: p.submittedSourceOffset, committedSourceOffset: p.committedSourceOffset } } : {}) });
          }),
        }, activation.resumeId, activation.streams?.get(activation.arguments![activation.declaration.transfer.sourceArgument] as string), activation.streams);
      }
      const heading = this.#native(activation,()=>{
        activeNativeScratch()?.reserve(8+activation.resources.size*16);
        activeNativeScratch()?.work(activation.resources.size);
        const value=operation+"|"+([...activation.resources][0]??"");
        if(input instanceof Uint8Array)return joinBytes(value+"|",input);
        activeNativeScratch()?.reserve(8+(value.length+(input?.length??0)+1)*3);
        activeNativeScratch()?.work(1+Math.ceil((value.length+(input?.length??0)+1)/256));
        return value+(input===undefined?"":"|"+input);
      });
      let request = await this.#turn(activation, "start", heading);
      if (input !== undefined && this.#rangeHandler(activation)) this.#native(activation, () => {
        const key = this.#inputKey(activation), previous = this.#consumedInput.get(key);
        const delivered = (previous?.delivered ?? 0) + input.length;
        if (!Number.isSafeInteger(delivered)) throw fault("retained.input-consumption", "input stream offset exhausted");
        const cursor = { delivered, consumed: previous?.consumed ?? 0, physicalSequence: activation.delivery?.sequence ?? activation.readySequence! };
        if (activation.delivery?.inputWork) {
          let ranges = this.#inputWorkRanges.get(key);
          if (!ranges) { ranges = new InputWorkRanges((previous?.delivered ?? 0) - (previous?.consumed ?? 0)); this.#inputWorkRanges.set(key, ranges); }
          ranges.append(activation.delivery.inputWork, input.length);
        }
        this.#reserve("consumed-input:" + key, cursor); this.#consumedInput.set(key, cursor);
        this.#stamp();
      });
      for (;;) {
        this.#charge(activation); // each requested effect, not each authority check
        const kind = this.#native(activation,()=>text(request.kind));
        const keys = this.#native(activation, () => nativeSort(nativeKeys(request)).join(","));
        const shape = { read: "kind,maximum", "read-bytes": "kind,maximum", write: "kind,value", helper: "kind,name", "resource-write": "kind,resource,value", result: "kind,value",
          "transfer-open": "kind", "transfer-report": "buffered,committed,cookie,generation,kind,volatile",
          "transfer-cleanup-state": "kind", "transfer-retire": "cookie,generation,kind",
          "source-read": "kind,maximum,source", "source-seek": "kind,offset,source",
          "input-channel": "kind", "input-consume": "kind,length",
          "transfer-write": "kind,length,offset,payloadOffset,value", "transfer-finalize": "kind", "transfer-verify": "kind,source,target",
          "transfer-resume-required": "details,kind,name",
          "entry-handoff": "kind,parser,timers", "write-via": "kind,value",
          "timer-arm": "kind,milliseconds", "timer-cancel": "kind,timer", "wait-any": "kind,maximum,timers", "wait-fill": "count,kind,timers", control: "kind,payload,setup",
          "deadline-arm": "kind,milliseconds", "deadline-disarm": "deadline,kind", "clock-observe": "kind",
          "expiry-reserve": "kind,milliseconds", "expiry-start": "expiry,kind", "expiry-read": "expiry,kind", "expiry-release": "expiry,kind",
          "input-retirement": "basisId,beforeSequence,fromSequence,generation,kind",
          "connection-grant": "kind", "connection-close": "connection,kind", "connection-reacquire": "kind",
          "lease-read": "kind,lease,maximum", "lease-write": "kind,lease,value",
          reschedule: "kind", "message-send": "kind,mailbox,value", "message-wait": "kind,mailboxes,timers",
          "tap-open": "kind", "tap-poll": "kind,tap", "state-publish": this.#options.description?.state?.[String(request.cell)]?.dependsOn
            ? "cell,kind,value" : "cell,kind,quality,value" }[kind];
        if (shape === undefined || keys !== shape) throw fault("retained.invalid-effect", "unknown effect family or members");
        if (activation.cleanupOwner) {
          const requirement = ({ read: "channel.read", "read-bytes": "channel.read", "lease-read": "channel.read", "input-channel": "channel.read",
            write: "channel.write", "lease-write": "channel.write", "timer-arm": "timer", "timer-cancel": "timer",
            "wait-any": "timer", "wait-fill": "timer", "clock-observe": "clock.observe", control: "usb.control", "connection-grant": "connection.lifecycle",
            "expiry-reserve": "expiry.observe", "expiry-start": "expiry.observe", "expiry-read": "expiry.observe", "expiry-release": "expiry.observe",
            "input-retirement": "input.retirement",
            "connection-close": "connection.lifecycle", "connection-reacquire": "connection.lifecycle",
            "transfer-cleanup-state": "transfer.cleanup", "transfer-retire": "transfer.cleanup",
            "write-via": "channel.write-via", "message-wait": "mailbox" } as Record<string, string>)[kind];
          if (kind !== "result" && (!requirement || !activation.declaration!.requires.includes(requirement)
            || (["wait-any", "wait-fill"].includes(kind) && Number(request.maximum ?? request.count) > 0 && !activation.declaration!.requires.includes("channel.read"))))
            throw fault("authored.cleanup.authority", "effect is outside explicitly retained cleanup authority", { effect: kind, submitted: false });
        }
        if (activation.acceptanceDone && !["result", "reschedule"].includes(kind))
          throw fault("retained.handoff-control", "acceptance supports only a bounded decision and cooperative rescheduling");
        if (kind === "result") {
          if (activation.transfer && !activation.transfer.receipt) throw fault("authored.transfer.incomplete", "operation cannot succeed before common transfer verification", undefined, "definition");
          let value: PublicValue;
          if (!activation.declaration) { this.#finish(activation, "completed", this.#native(activation,()=>text(request.value))); return; }
          try {
            if (activation.declaration.result.kind === "none") {
              if (request.value !== null) throw new Error("no-result operation returned a value");
              value = null;
            } else if (activation.declaration.result.kind === "value") value = this.#native(activation,
              () => authoredPublicValue(request.value, (activation.declaration!.result as { kind: "value"; type: AuthoredValueType }).type));
            else {
              const declared = activation.declaration.result, output = activation.output!;
              if (request.value !== output.id || output.bytes < declared.minimumBytes || output.bytes > declared.maximumBytes) throw new Error("returned output ID or completed byte bounds differ");
              const digest = output.stream && this.#nativeTransient(activation, () => output.stream!.digest());
              if (output.stream) {
                await this.#closeStreamedResult(activation); this.#live(activation);
              } else {
              const effect = this.#effect(activation, "resource-close"); effect.outcome = "indeterminate";
              this.#pendingEffects.add(effect);
              try { await this.#options.resourceBroker.close(output.id); this.#live(activation); effect.outcome = "settled"; }
              catch (cause) { effect.outcome = "failed"; throw cause; }
              finally { this.#settlement(activation, effect); }
              }
              output.receipt = { kind: declared.kind, destinationId: output.id, byteLength: output.bytes,
                content: declared.content, mediaType: declared.mediaType,
                ...(digest ? {digest} : {}),
                ...(declared.suggestedExtension === undefined ? {} : { suggestedExtension: declared.suggestedExtension }) };
              value = null;
            }
          } catch (cause) {
            if (activation.workFailure) throw activation.workFailure;
            if (errorValue(cause).code === "retained.helper-data-exhausted") throw cause;
            throw fault("authored.result.invalid", "returned value violates the admitted result: " + String(cause), {
              effects: nativeList(activation.effects.values()).map(effect => ({ ...effect })), effectsEvicted: activation.effectsEvicted ?? 0, operation: activation.declaration!.id }, "definition");
          }
          for (const stream of activation.streams?.values() ?? []) await stream.release();
          this.#live(activation); // a held release can settle after cancellation
          // Cleanup success includes funded VM retirement. Keep its wall
          // deadline live while that serialized turn is queued or running.
          if (activation.cleanupOwner || activation.idleContext) await this.#retireVm(activation);
          this.#finish(activation, "completed", value);
          return;
        }
        if (kind === "transfer-resume-required") {
          const service = activation.transfer;
          if (!activation.declaration?.transfer || !service || activation.handler || activation.cleanupOwner)
            throw fault("authored.transfer.resume-disposition-refused", "only an active resumable operation can require resume");
          if (activation.transferGeneration !== this.#generation)
            throw fault("authored.transfer.resume-disposition-refused", "transfer claim belongs to a replaced connection generation");
          const unresolved = this.#outbound.size > 0
            || nativeList(activation.effects.values()).some(effect => this.#pendingEffects.has(effect)
              && !(effect.outcome === "not-submitted" && ["source-release", "checkpoint-release", "result-close"].includes(effect.kind)))
            || nativeList(this.#deadlines.values()).some(deadline => deadline.activation === activation)
            || this.#waiting.has(activation.id) || this.#receiver?.activation === activation;
          if (unresolved) throw fault("authored.transfer.resume-disposition-refused",
            "resume-required cannot terminally classify unresolved native effects");
          service.resumeRequired();
          const cause = this.#native(activation, () => {
            const name = text(request.name, 128);
            if (!name.length) throw fault("retained.invalid-effect", "authored cause name must be nonempty");
            return { name, details: publicValue(nativeValue(request.details)) };
          });
          const effect = this.#effect(activation, "transfer-resume-required");
          effect.outcome = "admitted"; this.#settleEffect(activation, effect);
          activation.authoredCause = cause;
          this.#finish(activation, "resume-required", null, {
            code: "authored.transfer.resume-required",
            message: "Authored transfer is not finished and requires resume",
            responsibility: "operation",
            retryability: "after-recovery",
          });
          return;
        }
        let completion: WaitCompletion | Uint8Array | AuthoredClockObservation | AuthoredExpiryObservation | AuthoredInputRetirement;
        if (["reschedule", "message-send", "message-wait", "tap-open", "tap-poll"].includes(kind) && !this.#options.scheduling)
          throw fault("retained.unsupported", "scheduled effects require a granted topology");
        if (activation.declaration && kind === "connection-close" && !this.#options.description?.invalidation)
          throw fault("authored.capability.unavailable", "authored lifecycle requires a resolved invalidation handler", { effect: kind, submitted: false });
        if (!["connection-reacquire", "resource-write", "deadline-arm", "deadline-disarm"].includes(kind)) this.#connected();
        if (kind === "source-read" || kind === "source-seek") {
          delete activation.inputChannel;
          const stream = activation.streams?.get(text(request.source));
          if (!stream) throw fault("authored.source.unavailable", "stream handle is not granted to this activation");
          if (kind === "source-read") completion = await stream.read(request.maximum as number);
          else { await stream.seek(request.offset as number); completion = "seeked"; }
          activation.sourcePreparation!.complete = this.#native(activation, () => nativeList(activation.streams!.values()).every(s => s.complete));
        }
        else if (kind === "transfer-cleanup-state" || kind === "transfer-retire") {
          const parent = activation.cleanupOwner;
          if (!parent || !activation.declaration!.requires.includes("transfer.cleanup"))
            throw fault("authored.cleanup.authority", "checkpoint retirement is explicitly granted to cleanup only");
          const service = parent.transfer;
          if (kind === "transfer-cleanup-state") completion = this.#native(activation, () => service?.cleanupState() ?? (parent.ordinaryRunSettled ? "none" : "pending"));
          else {
            if (!service) throw fault("authored.transfer.cleanup-pending", "ordinary transfer preparation has not supplied a settled claim");
            if (parent.transferGeneration !== this.#generation) throw fault("transfer.resume.identity-mismatch", "cleanup cannot retire a checkpoint across connection replacement");
            completion = await service.retire({
              live: () => this.#live(activation), charge: units => this.#nativeWork(activation, units),
              takeEvidence: () => { const evidence = activation.inputEvidence; delete activation.inputEvidence;
                this.#mailbox.delete("evidence:" + activation.id);
                if (evidence) this.#nativeTransient(activation, () => this.#stamp());
                return evidence; },
              call: (request, run) => this.#sourceCall(activation, request, { source: "authored-checkpoint", operation: parent.id }, 0, run),
            }, request.cookie, request.generation);
          }
        }
        else if (kind.startsWith("transfer-")) {
          const service = activation.transfer;
          if (!service || activation.handler) throw fault("authored.transfer.unavailable", "operation has no transfer service grant");
          if (kind === "transfer-open") completion = await service.open();
          else if (kind === "transfer-report") completion = await service.report(request.cookie, request.generation, request.committed, request.volatile, request.buffered);
          else if (kind === "transfer-finalize") completion = await service.finalize();
          else if (kind === "transfer-verify") completion = await service.verify(request.source, request.target);
          else {
            if (!(request.value instanceof Uint8Array)) throw fault("retained.invalid-effect", "carrier requires bytes");
            const bytes = this.#native(activation, () => { nativeValue(request.value); return (request.value as Uint8Array).slice(); });
            await service.admit(request.offset, request.payloadOffset, bytes, request.length);
            const maximum = activation.declaration!.transfer!.maximumCarrierBytes ?? 256;
            if (activation.declaration?.writeVia) await this.#nativeAsync(activation, () => this.#writeVia(activation, bytes, maximum));
            else await this.#nativeAsync(activation, () => this.#write(activation, activation.id, bytes, undefined, maximum));
            completion = "accepted-by-platform";
          }
        }
        else if (kind.startsWith("expiry-")) {
          completion = this.#native(activation, () => {
            this.#live(activation);
            if (!nativeArray(activation.declaration?.requires)?.some(r => r === "expiry.observe") || !this.#options.capabilities?.["expiry.observe"]?.available || !this.#expiries)
              throw fault("retained.expiry-not-granted", "expiry evidence requires an admitted grant");
            if (!this.#options.execution.dispatchObservation) throw fault("retained.clock-unavailable", "execution adapter has no observation completion");
            const effect = this.#effect(activation, kind, false);
            try {
              const value = kind === "expiry-reserve" ? this.#expiries.reserve(activation.id, request.milliseconds)
                : kind === "expiry-start" ? this.#expiries.start(activation.id, text(request.expiry))
                : kind === "expiry-release" ? this.#expiries.release(text(request.expiry)) : this.#expiries.read(text(request.expiry));
              if (kind === "expiry-reserve") activation.pendingExpiryDelivery = value as string;
              this.#stamp();
              if (kind === "expiry-read") this.#stamp();
              this.#live(activation); effect.outcome = "settled"; return value;
            } catch (cause) { effect.outcome = "failed"; throw cause; }
            finally { this.#settleEffect(activation, effect); }
          });
        }
        else if (kind === "input-retirement") {
          completion = await this.#turns.enqueue(this.#stamp(), async () => this.#native(activation, () => {
            this.#live(activation);
            if (!activation.declaration?.requires.includes("input.retirement") || !this.#options.capabilities?.["input.retirement"]?.available || !this.#retirement)
              throw fault("retained.input-retirement-not-granted", "input retirement requires admitted authority");
            if (!this.#options.execution.dispatchObservation) throw fault("retained.input-retirement-unavailable", "execution adapter has no observation completion");
            const effect = this.#effect(activation, kind);
            try {
              const value = this.#retirement.sample(request);
              this.#live(activation); effect.outcome = "settled"; return value;
            } catch (cause) { effect.outcome = "failed"; throw cause; }
            finally { this.#settleEffect(activation, effect); }
          }));
        }
        else if (kind === "clock-observe") {
          completion = await this.#turns.enqueue(this.#stamp(), async () => this.#native(activation, () => {
            this.#live(activation);
            if (!nativeArray(activation.declaration?.requires)?.some(requirement => requirement === "clock.observe") || !this.#options.capabilities?.["clock.observe"]?.available || !this.#time)
              throw fault("retained.clock-not-granted", "clock observation requires an admitted grant");
            if (!this.#options.execution.dispatchObservation) throw fault("retained.clock-unavailable", "execution adapter has no observation completion");
            const effect = this.#effect(activation, "clock-observe");
            try {
              const observation = this.#clockObservation(activation, "requested");
              effect.outcome = "settled"; return observation;
            } catch (cause) { effect.outcome = "failed"; throw cause; }
            finally { this.#settleEffect(activation, effect); }
          }));
        }
        else if (kind === "state-publish") {
          const effect = this.#effect(activation, kind);
          this.#pendingEffects.add(effect);
          try { await this.#state.update(text(request.cell), request.quality, request.value, () => this.#live(activation),
            run => this.#nativeTransient(activation, run)); effect.outcome = "settled"; }
          catch (cause) { effect.outcome = "failed"; throw cause; }
          finally { this.#settlement(activation, effect); }
          completion = "published";
        }
        else if (kind === "entry-handoff") completion = await this.#nativeAsync(activation, () => this.#entryHandoff(activation, request.parser, request.timers));
        else if (kind === "reschedule") completion = "rescheduled";
        else if (kind === "input-consume") { this.#native(activation, () => this.#consumeInput(activation, request.length)); completion = "consumed"; }
        else if (kind === "message-send") { this.#native(activation, () => this.#sendMessage(activation, text(request.mailbox), request.value instanceof Uint8Array ? byteString(boundedBytes(request.value)) : text(request.value), request.value instanceof Uint8Array)); completion = "sent"; }
        else if (kind === "message-wait") { delete activation.inputChannel; completion = await this.#nativeAsync(activation, () => this.#waitAny(activation, request.timers, 0, request.mailboxes)); }
        else if (kind === "input-channel") {
          if (!activation.inputChannel) throw fault("retained.input-provenance-unavailable", "no reliable physical-channel input in this activation");
          completion = activation.inputChannel;
        }
        else if (kind === "tap-open") completion = this.#native(activation, () => this.#openTap(activation));
        else if (kind === "tap-poll") completion = this.#native(activation, () => this.#pollTap(activation, text(request.tap)));
        else if (kind === "connection-grant") { const grant = this.#connected(); completion = grant.connection + "|" + grant.lease; }
        else if (kind === "connection-close") completion = await this.#nativeAsync(activation, () => this.#closeConnection(activation, request.connection));
        else if (kind === "connection-reacquire") {
          const effect = this.#effect(activation, kind); this.#live(activation); effect.outcome = "acquiring";
          this.#pendingEffects.add(effect);
          try { completion = await this.#nativeAsync(activation, () => this.#openConnection(activation)); effect.outcome = "granted"; }
          catch (cause) { effect.outcome = "failed"; throw cause; }
          finally { this.#settlement(activation, effect); }
        }
        else if (kind === "lease-read") { this.#capability(request.lease, "lease"); completion = await this.#nativeAsync(activation, () => this.#read(activation, activation.id, request.maximum)); }
        else if (kind === "lease-write") { this.#capability(request.lease, "lease"); await this.#nativeAsync(activation, () => this.#write(activation, activation.id, request.value instanceof Uint8Array ? request.value : text(request.value))); completion = "accepted-by-platform"; }
        else if (kind === "read") completion = await this.#nativeAsync(activation, () => this.#read(activation, activation.id, request.maximum));
        else if (kind === "read-bytes") {
          if (!this.#options.execution.dispatchBytes) throw fault("retained.unsupported-bytes", "execution port has no byte completion adapter");
          const bytes = await this.#nativeAsync(activation, () => this.#read(activation, activation.id, request.maximum, true));
          completion = this.#native(activation, () => stringBytes(bytes));
        }
        else if (kind === "write") { await this.#nativeAsync(activation, () => this.#write(activation, activation.id, request.value instanceof Uint8Array ? request.value : text(request.value))); completion = "accepted-by-platform"; }
        else if (kind === "write-via") { await this.#nativeAsync(activation, () => this.#writeVia(activation, request.value)); completion = "accepted-by-platform"; }
        else if (kind === "helper") completion = await this.#nativeAsync(activation, () => this.#helper(activation, text(request.name)));
        else if (kind === "timer-arm") completion = this.#native(activation, () => this.#armTimer(activation, request.milliseconds));
        else if (kind === "timer-cancel") completion = this.#native(activation, () => this.#cancelTimer(activation, text(request.timer)));
        else if (kind === "deadline-arm") completion = this.#native(activation, () => this.#armDeadline(activation, request.milliseconds));
        else if (kind === "deadline-disarm") completion = this.#disarmDeadline(activation, text(request.deadline));
        else if (kind === "wait-any") completion = await this.#nativeAsync(activation, () => this.#waitAny(activation, request.timers, request.maximum));
        else if (kind === "wait-fill") {
          if (this.#groupPumps.length > 1) throw fault("retained.channel-fill-unavailable", "bounded fill cannot concatenate distinct physical channels; use at-most input with channel provenance");
          completion = await this.#nativeAsync(activation, () => this.#waitAny(activation, request.timers, request.count, [], new BoundedFill(request.count as number)));
        }
        else if (kind === "control") completion = await this.#nativeAsync(activation, () => this.#control(activation, request.setup, request.payload));
        else {
          const resource = text(request.resource) as ResourceId;
          if (!activation.resources.has(resource)) throw fault("retained.resource-not-granted", "resource is not delegated to this activation");
          const bytes = this.#native(activation, () => {
            if (request.value instanceof Uint8Array) {
              if (activation.output?.stream && request.value.length > 256) throw fault("authored.result.chunk-bound", "streamed result chunk exceeds 256 octets before copying");
              nativeValue(request.value); return request.value.slice();
            }
            const value = text(request.value);
            if (activation.output?.stream && value.length > 256) throw fault("authored.result.chunk-bound", "streamed result text exceeds chunk bound before encoding");
            return nativeEncode(value);
          });
          if (bytes.length > 65536) throw fault("authored.result.chunk-bound", "resource chunk exceeds 64 KiB");
          if (activation.output) {
            const declared = activation.declaration!.result;
            if ((declared.kind !== "file" && declared.kind !== "resource") || activation.output.bytes + bytes.length > declared.maximumBytes) throw fault("authored.result.byte-bound", "output would exceed declared maximum before submission");
          }
          if (activation.output?.stream) {
            const output = activation.output, stream = output.stream!, length = bytes.length;
            const next = this.#nativeTransient(activation, () => stream.prepare(bytes));
            const data = this.#nativeTransient(activation, () => btoa(byteString(bytes)));
            await this.#sourceCall(activation,"result-write",{source:resource,subject:stream.subject,offset:stream.bytes,requestedBytes:length,data},length,
              callId => this.#options.resourceBroker.write(resource,bytes.buffer as ArrayBuffer,{callId,writeGrantId:stream.grant!}));
            this.#live(activation); // late acceptance belongs to the abandoned destination, never this continuation
            stream.accept(next,length); output.bytes = stream.bytes;
            completion = "settled";
          } else {
          const effect = this.#effect(activation, "resource-write");
          // The broker transfers (and detaches) this buffer. Retain the count
          // before crossing the wire, not bytes.length after settlement.
          const byteLength = bytes.length;
          Object.assign(effect, { bytes: byteLength });
          this.#live(activation); effect.outcome = "indeterminate";
          this.#pendingEffects.add(effect);
          try {
            await this.#options.resourceBroker.write(resource, bytes.buffer as ArrayBuffer, { callId: effect.id as BrokerCallId });
            activation.readySequence = this.#stamp(); // host observation of the broker completion
            this.#live(activation);
            if (activation.output) activation.output.bytes += byteLength;
            effect.outcome = "settled";
          } catch (cause) { effect.outcome = "failed"; throw cause; }
          finally { this.#settlement(activation, effect); }
          completion = "settled";
          }
        }
        if ((this.#tracksTransferInput || this.#entryTracksInput(activation)) && (kind === "read" || kind === "read-bytes") && (typeof completion === "string" || completion instanceof Uint8Array) && completion.length)
          this.#recordReadInput(activation, this.#stamp(), completion.length, activation.inputPhysicalSequence);
        await this.#advanceTransferSegment(activation);
        request = await this.#turn(activation, "resume", completion, undefined, kind);
      }
    } catch (cause) {
      if (!activation.finished) this.#finish(activation, "failed", null, errorValue(cause));
      if (this.#options.execution.terminated) await this.#disconnect(errorValue(cause));
    } finally {
      activation.ordinaryRunSettled = true;
      if (activation.cleanupPending) await activation.cleanupPending;
      // The store-call ledger records a release failure. Do not abandon VM,
      // resource and task retirement because a failed store retained its lock.
      await activation.transfer?.release().catch(() => undefined);
      for (const stream of activation.streams?.values() ?? []) await stream.release().catch(() => undefined);
      activation.streams?.clear(); delete activation.streams;
      activation.sourceStorage?.release(); delete activation.sourceStorage;
      this.#mailbox.delete("arguments:" + activation.id);
      this.#mailbox.delete("evidence:" + activation.id); delete activation.inputEvidence;
      activation.resultScratch?.release?.(); delete activation.resultScratch;
      if (activation.output?.stream) await this.#closeStreamedResult(activation).catch(() => undefined);
      this.#releaseNative(activation); delete activation.nativeScratch;
      delete activation.sourceArguments;
      for (const pending of activation.sourceCleanup?.values() ?? []) {
        pending.effect.outcome = "not-submitted";
        this.#settleEffect(activation, pending.effect); pending.observation.close();
      }
      activation.sourceCleanup?.clear(); delete activation.sourceCleanup;
      if (activation.sourcePreparation) delete activation.arguments;
      if (activation.output && !activation.output.stream && !activation.output.receipt) await this.#options.resourceBroker.close(activation.output.id).catch(() => undefined);
      activation.output?.held?.release();
      // Retention keeps the scalar receipt, not an unaccounted hash state.
      if (activation.output) { delete activation.output.held; delete activation.output.stream; }
      // Retain the VM account until every buffered-delivery child has retired.
      // Entry may return first; its already-owned suffix cannot mint new fuel.
      this.#endCustody(activation);
      for (const interpretation of activation.inputInterpretations ?? []) interpretation.release();
      delete activation.inputInterpretations;
      if (activation.accountChildren) await new Promise<void>(resolve => { activation.childrenRetired = resolve; });
      const delivery = activation.delivery;
      const retainAccount = Boolean(delivery && delivery.root === activation && (delivery.offset < delivery.length || delivery.active > 1 || delivery.inputWork?.remaining));
      await this.#retireVm(activation, retainAccount);
      this.#tasks--;
      if (!delivery && activation.inheritedInput && activation.accountParent && --activation.accountParent.accountChildren! === 0)
        activation.accountParent.childrenRetired?.();
      if (activation.inputHandler) this.#handlerTasks.set(activation.inputHandler, this.#handlerTasks.get(activation.inputHandler)! - 1);
      if (delivery) {
        // The delivery retains only the spent account, not a retired task's
        // argument copies, result/effect history or callable declaration.
        delete activation.arguments; delete activation.declaration; delete activation.output;
        activation.effects.clear(); activation.resources.clear();
        if (retainAccount) delivery.parked = true;
        delivery.active--;
        this.#retireDelivery(delivery);
      }
      if (activation.handler) { this.#activations.delete(activation.id); this.#mailbox.delete(activation.id); this.#mailbox.delete("handler:" + activation.id); }
      if (activation.poll) {
        this.#retention.acknowledge(activation.id);
        this.#activations.delete(activation.id); this.#mailbox.delete(activation.id);
        this.#poll?.retired(activation.id);
      }
      else if (!activation.handler) {
        // A cancelled logical receive can retire before its demand-driven
        // native next(). Keep foreground scheduling busy without pretending
        // that read settled.
        const pump = this.#inputPump;
        if (pump?.pending && pump.foregroundOwner === activation.id) pump.foregroundRetirement = activation.id;
        else this.#poll?.foregroundRetired(activation.id, Boolean(activation.idleContext?.reentryRequired && activation.finished && !this.#closed && activation.cleanupRetired
          && activation.completed));
      }
      if (!this.#closed && !this.#captureFailure && this.#connection && !this.#entering && !this.#resumeOffer) this.#poll?.resume(this.#options.modeId, this.#generation);
      this.#scheduleHandlers();
      // A delivery root still funds the final suffix/retirement observation
      // after its first task retires. It closes with the delivery, not early.
      if (delivery?.root !== activation) { activation.terminal?.close(); delete activation.terminal; }
    }
  }
  async #closeStreamedResult(activation: Activation): Promise<void> {
    const output = activation.output!;
    if (output.closed || !output.stream?.grant || !activation.sourceCleanup?.has(String(output.id))) return;
    // The reservation is retained through grant/write settlement, including
    // cancellation. Closing never creates a replacement ordinary account.
    output.closed = true;
    await this.#sourceCall(activation,"result-close",{source:output.id},0,() => this.#options.resourceBroker.close(output.id));
  }
  async #advanceTransferSegment(activation: Activation): Promise<void> {
    const segment = activation.segments, transfer = activation.transfer;
    if (!segment) return;
    const p = transfer && activation.declaration?.transfer?.segmented ? this.#nativeTransient(activation, () => transfer.segmentProgress) : undefined;
    const result = activation.output?.stream;
    const eligibleIndex = (p?.eligibleIndex ?? 0) + (result?.eligibleIndex ?? 0);
    if (eligibleIndex <= segment.index) return;
    await this.#turns.enqueue(this.#stamp(), async () => {
      this.#live(activation);
      const safe = this.#nativeTransient(activation, () => !activation.accountParent && !activation.accountChildren
        && !activation.revokers.size && !this.#outbound.size
        && !nativeList(this.#timers.values()).some(t => t.activation === activation)
        && !nativeList(this.#deadlines.values()).some(t => t.activation === activation)
        && !nativeList(activation.effects.values()).some(e => this.#pendingEffects.has(e)
          && !(e.outcome === "not-submitted" && (e.kind === "source-release" || e.kind === "checkpoint-release" || e.kind === "result-close"))));
      if (!safe) return; // never move an unresolved platform call into a fresh account
      this.#nativeTransient(activation, () => this.#stamp());
      await this.#options.execution.advanceSegment!(activation.id, eligibleIndex);
      this.#live(activation);
      segment.index = eligibleIndex; segment.workBase = activation.work; segment.fuelBase = activation.consumed;
      const cp = transfer?.checkpoint;
      if (cp && p) this.#nativeTransient(activation, () => this.#publish({ kind: "transfer-progress", operationId: activation.id,
        ...(cp.source.subject ? { sourceSubject: cp.source.subject } : {}),
        checkpointId: cp.id as CheckpointId, phase: cp.phase, segmentation: { quantum: p.quantum, index: segment.index, count: p.count + (result?.count ?? 1) - 1,
          submittedSourceOffset: p.submittedSourceOffset, committedSourceOffset: p.committedSourceOffset } }));
    });
  }
  async #sourceCall<T>(activation: Activation, kind: string, fields: Record<string, unknown>, maximumBytes: number,
    run: (id: BrokerCallId) => Promise<T>, observed?: (value: T) => Record<string, unknown>): Promise<T> {
    const cleanup = kind === "source-release" || kind === "checkpoint-release" || kind === "result-close";
    if (!cleanup) this.#charge(activation);
    const prior = cleanup ? activation.sourceCleanup?.get(String(fields.source)) : undefined;
    if (cleanup && !prior) throw fault("retained.source-release-unreserved", "source delegation has no cleanup reservation");
    const effect = prior?.effect ?? this.#effect(activation, kind);
    const accounting = prior?.observation ?? this.#newRunway(activation);
    if (!prior) {
      try {
        // A read is at most 256 octets. Include byte conversion, base64 and
        // both bounded diagnostic envelopes; hold through late settlement.
        accounting.ensure(1024 + maximumBytes * 4, 65536 + maximumBytes * 128);
        if (kind === "source-grant" || kind === "checkpoint-claim" || kind === "result-grant") {
          const release = this.#newRunway(activation);
          try {
            release.ensure(1024, 65536);
            const releaseEffect = this.#effect(activation, kind === "source-grant" ? "source-release" : kind === "result-grant" ? "result-close" : "checkpoint-release", false);
            this.#pendingEffects.add(releaseEffect); // keep reserved cleanup capacity through revocation and late grant
            (activation.sourceCleanup ??= new Map()).set(String(fields.source), { effect: releaseEffect, observation: release });
          } catch (cause) { release.close(); throw cause; }
        }
      } catch (cause) { accounting.close(); throw cause; }
    }
    const capture = this.#capture;
    let reserved: ReturnType<DestinationCaptureRecorder["reserveObservation"]> | undefined;
    const revoke = () => { if (kind.startsWith("source-") || kind.startsWith("result-")) void this.#options.resourceBroker.cancel(effect.id as BrokerCallId).catch(() => undefined); };
    let record: Record<string, unknown> = {};
    let submitted = false;
    try {
      try { reserved = capture?.reserveObservation(8192 + maximumBytes * 2); }
      catch (cause) { if (!cleanup) throw cause; }
      if (!cleanup) this.#live(activation);
      activation.revokers.add(revoke);
      this.#pendingEffects.add(effect); effect.outcome = "indeterminate";
      submitted = true;
      const result = await run(effect.id as BrokerCallId);
      activation.readySequence = this.#stamp();
      record = accounting.run(() => observed?.(result) ?? {});
      effect.outcome = activation.live && activation.generation === this.#generation ? "settled" : "late-discarded";
      return result;
    } catch (cause) { effect.outcome = "failed"; record = { error: errorValue(cause) }; throw cause; }
    finally {
      activation.revokers.delete(revoke);
      const observation = { kind, preparation: activation.id, owner: activation.id, generation: activation.generation,
        effectId: effect.id, submitted, outcome: effect.outcome, ...fields, ...record };
      try {
        // A closing recording already accounts for its unresolved reservation
        // as a gap. Never append its late completion into another recording.
        if (capture === this.#capture) {
          accounting.run(() => this.#stamp());
        }
      } finally {
        reserved?.release();
        try { this.#settleEffect(activation, effect, capture === this.#capture); }
        finally { accounting.close(); if (cleanup) activation.sourceCleanup?.delete(String(fields.source)); }
      }
    }
  }
  #takeLocks(activation: Activation): Promise<void> {
    const locks = activation.declaration?.locks ?? [];
    this.#live(activation);
    if (activation.locksAcquired) return Promise.resolve();
    if (locks.length) this.#reserve("locks:" + activation.id, locks);
    if (nativeArray(locks).every(lock => !this.#lockOwners.has(lock)) && !nativeList(this.#lockWaiters.values()).some(wait => nativeArray(wait.locks).some(lock => locks.includes(lock)))) {
      for (const lock of nativeWalk(locks)) this.#lockOwners.set(lock, activation);
      return Promise.resolve();
    }
    this.#stamp();
    return new Promise((resolve, reject) => this.#lockWaiters.set(activation.id, { activation, locks, resolve, reject }));
  }
  #releaseLocks(activation: Activation): void {
    this.#mailbox.delete("locks:" + activation.id);
    const cancelled = this.#lockWaiters.get(activation.id);
    if (cancelled) { this.#lockWaiters.delete(activation.id); cancelled.reject(fault("retained.revoked", "lock waiter revoked")); }
    for (const [lock, owner] of nativeWalk(this.#lockOwners)) if (owner === activation) this.#lockOwners.delete(lock);
    if (this.#closed) return;
    activeNativeScratch()?.reserve(8);
    const blocked = new Set<string>();
    for (const [id, wait] of nativeWalk(this.#lockWaiters)) {
      if (nativeArray(wait.locks).some(lock => this.#lockOwners.has(lock) || blocked.has(lock))) {
        for (const lock of nativeWalk(wait.locks)) { activeNativeScratch()?.reserve(16); blocked.add(lock); }
        continue;
      }
      this.#lockWaiters.delete(id);
      for (const lock of nativeWalk(wait.locks)) this.#lockOwners.set(lock, wait.activation);
      wait.activation.readySequence = this.#stamp();
      this.#stamp();
      wait.resolve();
    }
  }
  async #writeVia(parent: Activation, value: unknown, maximum = 256): Promise<void> {
    this.#live(parent);
    this.#outboundAvailable(parent, "write-via");
    const handler = nativeArray(this.#options.description?.handlers)?.find(h => h.id === parent.declaration?.writeVia);
    if ((parent.handler && !parent.cleanupOwner) || !handler?.authorizeWrite || !parent.declaration?.requires.includes("channel.write-via"))
      throw fault("retained.relay-unavailable", "operation has no admitted write route");
    const owner = this.#demuxOwner, generation = this.#generation;
    if (!owner || this.#channelOwner !== owner) throw fault("retained.wrong-owner", "relay recipient does not own the channel");
    if (value instanceof Uint8Array) nativeValue(value);
    const bytes = value instanceof Uint8Array ? boundedBytes(value, maximum).slice() : nativeEncode(text(value));
    const effect = this.#effect(parent, "write-via");
    this.#pendingEffects.add(effect);
    const request = { requestId: effect.id, operationId: parent.id, operation: parent.cleanupOwner?.declaration?.id ?? parent.declaration.id,
      origin: parent.cleanupOwner ? "cleanup" : "operation", cleanupOf: parent.cleanupOwner?.id ?? "",
      ownerId: owner, channelId: handler.event.channelId, generation,
      bytes: { kind: "bytes" as const, encoding: "base64" as const, value: btoa(byteString(bytes)) } };
    let child: Activation | undefined;
    let job: RelayJob | undefined;
    const revoke = () => {
      if (child) this.#cancel(child.id);
      if (job) { const i = this.#relayQueue.indexOf(job); if (i >= 0) {
        this.#relayQueue.splice(i, 1); job.reject(fault("retained.revoked", "queued relay revoked"));
      } }
    };
    try {
      this.#reserve(effect.id, request);
      parent.revokers.add(revoke);
      await new Promise<void>((resolve, reject) => {
        job = { parent, reject, run: async () => {
          let failure: PdrError | undefined;
          try {
            this.#live(parent, owner);
            if (this.#tasks + this.#helperTasks >= 64) throw fault("retained.relay-refused", "authorization task capacity exhausted");
            const id = this.#identity("write-authorization") as OperationId;
            child = { id, generation, startedUs: this.#options.clock.monotonicUs(), resources: new Set(), effects: new Map(),
              live: true, finished: false, work: 0, consumed: 0, revokers: new Set(), handler: true, accountParent: parent,
              acceptanceDone: () => undefined,
              declaration: { id: "write-authorization", title: "Write authorization", binding: handler.authorizeWrite!,
                arguments: this.#native(parent, () => nativeRecord(nativeArray(nativeKeys(request)).map(key => [key, key === "generation"
                  ? { kind: "integer", widthBits: 64, signed: false } : key === "bytes"
                    ? { kind: "bytes", maximumLength: maximum } : { kind: "string", maximumLength: 256 }]))),
                result: { kind: "value", type: { kind: "record", fields: { accepted: { kind: "boolean" } } } },
                locks: [], requires: [], risk: "changes-state", repeatability: "not-repeatable",
                availability: { modes: [this.#options.modeId], profiles: [this.#options.profileId] } }, arguments: request };
            this.#activations.set(id, child); this.#tasks++;
            this.#stamp();
            let submitted: Promise<void> | undefined, action = "start";
            for (;;) {
              await this.#turn(child, action, "", decision => {
                this.#charge(child!);
                if (decision.kind === "reschedule" && nativeKeys(decision).length === 1) return;
                if (decision.kind !== "result" || nativeSort(nativeKeys(decision)).join(",") !== "kind,value")
                  throw fault("retained.relay-refused", "authorization permits only decision or reschedule");
                let accepted: { accepted: boolean };
                try { accepted = authoredPublicValue(decision.value, { kind: "record", fields: { accepted: { kind: "boolean" } } }) as { accepted: boolean }; }
                catch { throw fault("retained.relay-refused", "authorization must return exactly {accepted=boolean}"); }
                this.#stamp();
                if (!accepted.accepted) throw fault("retained.relay-refused", "owner declined exact write request");
                this.#live(parent, owner); this.#live(child!);
                if (generation !== this.#generation || parent.declaration?.writeVia !== handler.id || effect.outcome !== "not-submitted")
                  throw fault("retained.revoked", "relay identity or authority changed");
                // No await: native submission starts inside this SAME ReadyQueue
                // job. Its settlement must not hold the authored scheduler.
                effect.outcome = "authorized";
                submitted = this.#write(parent, owner, bytes, effect.id, maximum);
                void submitted.catch(() => undefined);
              });
              if (submitted) { await submitted; break; }
              action = "resume";
            }
            effect.outcome = "accepted-by-platform";
            parent.readySequence = this.#stamp();
          } catch (cause) {
            failure = errorValue(cause);
            this.#stamp();
            effect.outcome = "refused-or-failed"; throw cause;
          }
          finally {
            if (child) {
              if (!child.finished) this.#finish(child, failure ? "failed" : "completed", null, failure);
              await this.#retireVm(child);
              child.resultScratch?.release?.(); this.#releaseNative(child);
              child.terminal?.close(); delete child.terminal;
              this.#activations.delete(child.id); this.#mailbox.delete(child.id); this.#tasks--;
            }
          }
        } };
        const run = job.run;
        job.run = async () => { try { await run(); resolve(); } catch (cause) { reject(cause); } };
        this.#relayQueue.push(job);
        void this.#drainRelay();
      });
    } finally {
      parent.revokers.delete(revoke); this.#mailbox.delete(effect.id); this.#settleEffect(parent, effect);
    }
  }
  async #drainRelay(): Promise<void> {
    if (this.#relayRunning) return;
    this.#relayRunning = true;
    try { while (this.#relayQueue.length) await this.#relayQueue.shift()!.run(); }
    finally { this.#relayRunning = false; }
  }
  async #write(activation: Activation, owner: string, value: string | Uint8Array, relayRequest?: string, maximum = 256): Promise<void> {
    this.#live(activation, owner);
    this.#outboundAvailable(activation, "write");
    const bytes = value instanceof Uint8Array ? boundedBytes(value, maximum) : nativeEncode(text(value));
    const effect = this.#effect(activation, "write");
    effect.bytes = bytes.length;
    const capture = this.#capture;
    let settlement: ReturnType<DestinationCaptureRecorder["reserveObservation"]> | undefined;
    try {
      // Keep the future receipt's capacity through native settlement, including
      // cancellation. Closing this recording while it is held must expose the
      // missing tail; an indeterminate observation is not that future receipt.
      settlement = capture?.reserveObservation(8192);
      if (relayRequest) this.#stamp();
      this.#live(activation, owner);
      const ref = this.#stamp();
      this.#capture?.recordBytesStamped({ kind: "tx-requested", conn: this.#generation, ch: this.#options.channelRoles?.request ?? this.#options.channelId,
        commandInvocation: activation.id }, bytes, ref, Math.floor(this.#options.clock.monotonicUs()));
      // The capacity reservation itself can synchronously revoke the owner.
      this.#live(activation, owner);
      effect.outcome = "indeterminate";
      this.#pendingEffects.add(effect);
      this.#outbound.set(effect.id, { owner: activation.id, generation: activation.generation, effect });
      // A thrown platform error is not an acceptance receipt, even if its
      // nested diagnostic happens to use one of our terminal disposition codes.
      const writeFailure = (cause: unknown) => {
        const diagnostic = errorValue(cause);
        // Preserve transport/host diagnostics; only receipt-derived codes are
        // reserved here. A blanket wrapper would erase half-duplex refusal.
        return diagnostic.code === "retained.write-rejected" || diagnostic.code === "retained.write-may-be-partial"
          ? fault("retained.write-indeterminate", "platform write ended without an acceptance receipt", diagnostic as unknown as PublicValue)
          : cause;
      };
      let submitted: Promise<WriteReceipt>;
      try { submitted = this.#lease!.write(bytes); }
      catch (cause) { throw writeFailure(cause); }
      void submitted.catch(() => undefined);
      // Refusal recording can revoke on capture loss. Do it AFTER actual
      // submission, not between the final live check and the platform call.
      // Queued relays cannot wait invisibly behind that unresolved call.
      for (const job of this.#relayQueue.splice(0)) {
        try { this.#outboundAvailable(job.parent, "queued-write-via"); }
        catch (cause) { job.reject(cause); }
      }
      let receipt: WriteReceipt;
      try { receipt = await submitted; }
      catch (cause) { throw writeFailure(cause); }
      if (owner === activation.id) activation.readySequence = Math.max(ref, receipt.atSequence);
      effect.outcome = receipt.outcome.kind;
      // A late receipt belongs to the recording that saw the request, never a
      // replacement recording whose sequence space has no such tx reference.
      this.#terminal(activation, () => {
        if (this.#capture !== capture) return;
        settlement?.record({ kind: "tx-settled", ref, outcome: receipt.outcome },
          this.#stamp(), Math.floor(this.#options.clock.monotonicUs()));
        this.#stamp();
        if (relayRequest) this.#stamp();
      });
      if (receipt.outcome.kind !== "accepted-by-platform") {
        // Cleanup already receives the terminal code. Preserve disposition
        // there without giving cleanup the receipt or resuming the failed call.
        const code = receipt.outcome.kind === "rejected" ? "retained.write-rejected"
          : receipt.outcome.kind === "may-be-partial" ? "retained.write-may-be-partial" : "retained.write-not-settled";
        throw fault(code, "platform write did not accept all bytes", receipt as unknown as PublicValue);
      }
    } catch (cause) {
      if (effect.outcome === "indeterminate" && this.#capture === capture) this.#terminal(activation, () => {
        this.#stamp();
      });
      throw cause;
    } finally { settlement?.release(); this.#settleEffect(activation, effect, capture === this.#capture); this.#outbound.delete(effect.id); }
  }
  #outboundAvailable(activation: Activation | undefined, requested: string): void {
    if (this.#resumeOffer) throw fault("authored.transfer.offer-writes-forbidden", "operator has not acted on the resume offer", { requested, submitted: false });
    this.#unresolvedOutboundAvailable(activation, requested);
  }
  #unresolvedOutboundAvailable(activation: Activation | undefined, requested: string): void {
    const pending = this.#outbound.values().next().value;
    if (!pending) return;
    const details = { submitted: false, requested, predecessor: { effectId: pending.effect.id,
      operationId: pending.owner, generation: pending.generation, outcome: pending.effect.outcome } };
    this.#stamp();
    throw fault("retained.outbound-unresolved", "physical outbound path has an unresolved predecessor", details);
  }
  #timerCount(): number { return this.#timers.size + this.#deadlines.size + this.#cleanupTimers + this.#state.timerCount + (this.#poll?.timerReservation ?? 0) + (this.#expiries?.size ?? 0); }
  #retainCustody(activation: Activation, source: InputWorkAccount): void {
    const held = source.retainCustody();
    if (held) (activation.custodyInterpretations ??= new Set()).add(held);
  }
  #endCustody(activation: Activation): void {
    for (const held of activation.custodyInterpretations ?? []) held.dispose();
    delete activation.custodyInterpretations;
  }
  #revokeRetirement(): void {
    this.#retirementCut = undefined;
    const index = this.#inputIndex; this.#inputIndex = undefined; index?.close();
  }
  #clockObservation(activation: Activation, source: string, sequence = this.#stamp(), acceptedUs?: number): AuthoredClockObservation {
    const observation = this.#time!.observe(sequence, activation.generation, acceptedUs);
    nativeValue(observation);
    this.#stamp();
    this.#live(activation); // mandatory recording failure cannot leak the sample
    return observation;
  }
  #deadlineAuthority(activation: Activation): void {
    this.#live(activation);
    if (activation.handler || !activation.declaration?.requires.includes("operation.deadline")
      || !this.#options.capabilities?.["operation.deadline"]?.available)
      throw fault("retained.deadline-not-granted", "deadline effects require an admitted ordinary operation capability");
  }
  #armDeadline(activation: Activation, milliseconds: unknown): string {
    this.#deadlineAuthority(activation);
    if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 2147483647)
      throw fault("retained.invalid-deadline", "deadline duration must be an integer in 1..2147483647 ms");
    if (this.#timerCount() >= this.#maximumTimers) throw fault("retained.timer-limit", "aggregate timer account exhausted");
    const effect = this.#effect(activation, "deadline", false);
    this.#live(activation);
    const acceptedUs = this.#options.clock.monotonicUs();
    const deadline: ArmedDeadline = { activation, effect, milliseconds, acceptedUs, dueUs: acceptedUs + milliseconds * 1000 };
    // Reserve the terminal observation before registering a callback.
    this.#reserve(effect.id, { deadlineId: effect.id, owner: activation.id, milliseconds, acceptedUs, dueUs: deadline.dueUs, expiredAtSequence: Number.MAX_SAFE_INTEGER });
    this.#deadlines.set(effect.id, deadline); effect.outcome = "armed";
    this.#stamp();
    this.#live(activation); // synchronous recording loss must not leave a ghost timer
    deadline.handle = this.#options.clock.timer(milliseconds, () => {
      if (!activation.live || this.#deadlines.get(effect.id) !== deadline) return;
      const expiredAtSequence = this.#stamp();
      const cause = { kind: "authored-deadline", deadlineId: effect.id, milliseconds, acceptedUs, dueUs: deadline.dueUs, expiredAtSequence };
      try { this.#terminal(activation, () => this.#stamp()); }
      finally {
        try { this.#dropDeadline(deadline, "expired"); }
        finally { this.#cancel(activation.id, { code: "retained.cancelled", message: "authored operation deadline expired", responsibility: "operation", retryability: "unknown", details: { cause } }); }
      }
    });
    this.#stamp();
    return effect.id;
  }
  #dropDeadline(deadline: ArmedDeadline, outcome: string): void {
    const { effect, activation } = deadline;
    deadline.handle?.dispose(); this.#deadlines.delete(effect.id); this.#mailbox.delete(effect.id); effect.outcome = outcome;
    try { this.#terminal(activation, () => this.#stamp()); }
    finally { this.#settleEffect(activation, effect); }
  }
  #disarmDeadline(activation: Activation, id: string): string {
    this.#deadlineAuthority(activation);
    const deadline = this.#deadlines.get(id);
    if (!deadline || deadline.activation !== activation) throw fault("retained.deadline-not-granted", "deadline ID is not live in this operation");
    this.#dropDeadline(deadline, "disarmed"); return "disarmed";
  }
  #read(activation: Activation, owner: string, maximum: unknown, binary = false): Promise<string> {
    this.#live(activation, owner);
    delete activation.inputChannel;
    const routed = this.#routed.get(activation.id);
    if (this.#options.scheduling && !routed && !this.#entryOwns(activation)) throw fault("retained.receive-owner", "session demultiplexer already owns reliable input");
    if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1 || maximum > 256) throw fault("retained.invalid-effect", "read maximum outside 1..256");
    if (routed ? routed.receiver || this.#waiting.has(activation.id)
      : this.#receiver || nativeList(this.#waiting.values()).some(wait => wait.maximum)) throw fault("retained.receive-busy", "one consuming registration permitted");
    const effect = this.#effect(activation, "read");
    this.#live(activation, owner);
    this.#pendingEffects.add(effect);
    return new Promise((resolve, reject) => {
      const receiver: Receiver = { owner, activation, maximum, registered: this.#stamp(), resolve: bytes => {
        try { this.#native(activation, () => {
        activeNativeScratch()?.reserve(8 + bytes.length * 16);
        if (!binary && nativeArray([...bytes]).some(byte => byte.charCodeAt(0) > 127)) {
          effect.outcome = "failed"; this.#stamp();
          this.#settleEffect(activation, effect);
          reject(fault("retained.unsupported-bytes", "text read requires ASCII; use byte receive")); return;
        }
        effect.outcome = "settled"; this.#stamp(); this.#settleEffect(activation, effect); resolve(bytes);
        }); } catch (cause) { effect.outcome = "failed"; this.#settleEffect(activation, effect); reject(cause); }
      }, reject: cause => { effect.outcome = "cancelled"; this.#settleEffect(activation, effect); reject(cause); } };
      if (routed) { routed.receiver = receiver; this.#consumeRouted(routed); }
      else { this.#receiver = receiver; this.#consume(); this.#pump(); }
    });
  }
  #consumeRouted(channel: RoutedChannel): void {
    const receiver = channel.receiver, queue = this.#messages.get(channel.mailbox)!;
    if (!receiver || !queue.length) return;
    try {
      this.#live(receiver.activation, receiver.owner);
      const range = queue[0]!;
      const bytes = this.#native(receiver.activation, () => {
        activeNativeScratch()?.reserve(16 + range.value.length * 3);
        activeNativeScratch()?.work(2 + Math.ceil(range.value.length / 256));
        return range.value.slice(0, receiver.maximum);
      });
      if (receiver.owner === receiver.activation.id)
        receiver.activation.readySequence = Math.max(receiver.registered, range.sequence);
      range.value = range.value.slice(bytes.length);
      if (!range.value.length) queue.shift();
      this.#mailbox.set("messages:" + channel.mailbox, queue);
      channel.receiver = undefined; receiver.resolve(bytes);
    } catch (cause) { channel.receiver = undefined; receiver.reject(cause); }
  }
  #mailboxConsumer(activation: Activation, name: string): void {
    const channel = nativeList(this.#routed.values()).find(channel => channel.mailbox === name);
    if (channel && (channel.activation !== activation || channel.owner !== activation.id || channel.receiver))
      throw fault("retained.wrong-owner", "routed channel belongs to another consuming owner");
  }
  #consume(): void {
    const receiver = this.#receiver;
    if (!receiver || (!this.#buffer.length && !this.#deferredInput)) return;
    try {
      this.#live(receiver.activation, receiver.owner);
      this.#nativeTransient(receiver.activation, () => this.#materializeDeferred());
      if (receiver.owner === receiver.activation.id)
        receiver.activation.readySequence = Math.max(receiver.registered, this.#inputRanges[0]!.sequence);
      receiver.activation.inputChannel = this.#inputRanges[0]!.channelId ?? this.#options.channelId;
      receiver.activation.inputPhysicalSequence = this.#inputRanges[0]!.sequence;
      const bytes = this.#native(receiver.activation, () => {
        this.#trackInputWork(receiver.activation, Math.min(receiver.maximum, this.#inputRanges[0]!.length));
        return this.#takeInput(receiver.maximum);
      });
      this.#receiver = undefined; receiver.resolve(bytes);
    } catch (cause) { this.#receiver = undefined; receiver.reject(cause); }
  }
  #pump(waitDemand = false): void {
    if (this.#groupPumps.length) { for (const pump of this.#groupPumps) this.#pumpOne(pump, waitDemand); return; }
    const pump = this.#inputPump;
    if (pump) this.#pumpOne(pump, waitDemand);
  }
  #pumpOne(pump: InputPump, waitDemand: boolean): void {
    if (!pump || pump.pending || pump.capability !== this.#capabilities?.lease || this.#closed) return;
    // Half-duplex has no speculative authoritative read. Wait demand is only
    // granted AFTER arbitration: a buffered reply or ready timer may win and
    // resume a writer. Never arm the next read ahead of that decision.
    // Once next() is submitted, cancellation is NOT native settlement. Keep
    // pending true until it settles or its connection is disposed; do not
    // clear adapter read authority to make a subsequent write succeed.
    if (!pump.standing && !this.#receiver && !(waitDemand && nativeList(this.#waiting.values()).some(wait => wait.maximum))) return;
    pump.pending = true;
    const owner = !pump.standing ? this.#receiver?.activation ?? nativeList(this.#waiting.values()).find(wait => wait.maximum)?.activation : undefined;
    if (owner && !owner.handler && !owner.poll) pump.foregroundOwner = owner.id;
    else delete pump.foregroundOwner;
    void this.#readInput(pump);
  }
  async #readInput(pump: InputPump): Promise<void> {
    const { generation, capability } = pump;
    let delivered = false;
    let inputWork: InputWorkAccount | undefined;
    try {
      const next = await pump.iterator.next().finally(() => {
        pump.pending = false;
        const retired = pump.foregroundRetirement;
        delete pump.foregroundRetirement; delete pump.foregroundOwner;
        if (retired) this.#poll?.foregroundRetired(retired);
      });
      delivered = !next.done;
      if (!next.done) inputWork = this.#nativeInputWork.get(next.value.atSequence);
      pump.pending = false;
      if (capability !== this.#capabilities?.lease || this.#closed) {
        // Explicit iteration must preserve for-await's IteratorClose on a
        // stale delivery. In particular, release the old generator's finally
        // blocks without requesting another byte or touching the new pump.
        delivered = false; await pump.iterator.return?.(); return;
      }
      if (next.done) throw fault("retained.connection-ended", "native receive stream ended");
      if (this.#retirementCut && !inputWork)
        throw fault("retained.input-retirement-unavailable", "certified adapter introduced an unregistered original observation");
      const chunk = next.value;
      // The adapter already sequenced observation on the session clock.
      // Promise/iterator delivery must not make an earlier byte look newer
      // than a timer callback from that same native turn.
      const sequence = chunk.atSequence, recordedSequence = this.#stamp();
      this.#withInputWork(inputWork, () => this.#capture?.recordBytesStamped({ kind: "rx-delivered", conn: generation, ch: pump.channelId ?? this.#options.channelId }, chunk.bytes,
        recordedSequence, Math.floor(this.#options.clock.monotonicUs())));
      const process = async () => {
      if (capability !== this.#capabilities?.lease || this.#closed) return;
      this.#withInputWork(inputWork, () => this.#stamp());
      if (this.#options.scheduling && this.#channelOwner === this.#demuxOwner) {
        this.#queueHandler(chunk.bytes, sequence, recordedSequence, undefined, undefined, 0, pump.channelId, chunk.tUs);
        this.#pump(); return;
      }
      const idleEntry = this.#preparedEntry?.activation;
      if (!this.#receiver && !this.#waiting.size && ((inputWork?.remaining && idleEntry && this.#entryOwns(idleEntry))
        || (!this.#entering && !this.#options.scheduling && !this.#channelOwner))) {
        if (!this.#idleMailbox!.retainRaw(chunk.bytes.buffer.byteLength, this.#fillCapacity))
          throw fault("retained.mailbox-overflow", "aggregate execution mailbox exhausted by idle input");
        // Constant-time metadata insertion: no idle array growth/copy or
        // traversal of prior payloads needs an invented work owner.
        const storage = inputWork?.deferred(chunk.bytes.buffer.byteLength + 256);
        const range = { bytes: chunk.bytes, sequence, recordedSequence, ...(storage ? { storage } : {}), ...(this.#time ? { tUs: chunk.tUs } : {}), ...(pump.channelId ? { channelId: pump.channelId } : {}) };
        if (this.#deferredTail) this.#deferredTail.next = range;
        else this.#deferredInput = range;
        this.#deferredTail = range;
        if (inputWork) this.#withInputWork(inputWork, () => this.#stamp());
        this.#pump(); return;
      }
      const owner = this.#receiver?.activation ?? nativeList(this.#waiting.values()).find(wait => wait.maximum)?.activation
        ?? this.#activations.get(this.#channelOwner as OperationId) ?? this.#channelFunding;
      if (!owner) throw fault("retained.wrong-owner", "input conversion has no activation account");
      this.#nativeTransient(owner, () => this.#materializeDeferred());
      const append = () => this.#appendInput(chunk.bytes, sequence, recordedSequence, pump.channelId, chunk.tUs);
      if (inputWork) this.#withInputWork(inputWork, append); else this.#nativeTransient(owner, append);
      this.#consume(); this.#scheduleWait();
      this.#pump();
      };
      if (pump.channelId && this.#groupPumps.length > 1) {
        pump.pending = true; // one queued/native range per physical pump, not one per promise reaction
        const hold = inputWork ? inputWork.publication(chunk.bytes.buffer.byteLength + 256)
          : this.#helperData.reserve(chunk.bytes.buffer.byteLength + 256);
        if (!this.#idleMailbox.retainRaw(chunk.bytes.buffer.byteLength, this.#fillCapacity)) { hold.release(); throw fault("retained.mailbox-overflow", "queued group input exceeds aggregate capacity"); }
        let queued = true;
        try {
          if (inputWork) this.#withInputWork(inputWork, () => this.#stamp());
          await this.#turns.enqueue(sequence, async () => {
          if (generation === this.#generation) this.#idleMailbox.releaseRaw(chunk.bytes.buffer.byteLength);
          queued = false; pump.pending = false; await process();
        }); } finally {
          if (queued) pump.pending = false;
          if (queued && generation === this.#generation) this.#idleMailbox.releaseRaw(chunk.bytes.buffer.byteLength);
          hold.release();
        }
      } else await process();
    } catch (cause) {
      // Match IteratorClose for an exception while processing a yielded
      // delivery too. Preserve the original processing failure if close fails.
      if (delivered) { try { await pump.iterator.return?.(); } catch { /* original failure wins */ } }
      if (capability !== this.#capabilities?.lease || this.#closed) return;
      for (const activation of this.#activations.values()) this.#cancel(activation.id, errorValue(cause));
      await this.#disconnect(errorValue(cause));
    } finally {
      inputWork?.nativeEnd();
      if (inputWork?.inherited && !inputWork.remaining) inputWork.close();
      // Foreground release follows retained ingress accounting as well as native
      // settlement; it cannot overtake the just-delivered suffix's capture.
      this.#poll?.settled();
    }
  }
  #appendInput(bytes: Uint8Array, sequence: number, recordedSequence: number, channelId?: string, tUs?: number): void {
    const scope = activeNativeScratch();
    if (!scope) throw new Error("input conversion requires its consuming account");
    scope.reserve(8 + (this.#buffer.length + bytes.length) * 3);
    scope.work(1 + Math.ceil((this.#buffer.length + bytes.length) / 256));
    const appended = byteString(bytes);
    const utf8Bytes = this.#inputUtf8Bytes + this.#accounting.rpcMessageBytes(appended, scope) - 8;
    const buffer = this.#buffer + appended;
    const previous = this.#inputRanges.length;
    try {
      if (bytes.length) this.#inputRanges.push({ sequence, recordedSequence, offset: 0, length: bytes.length, ...(this.#time ? { tUs: tUs ?? Number.NaN } : {}), ...(channelId ? { channelId } : {}) });
      if (this.#inputRanges.length > 1024) throw fault("retained.mailbox-overflow", "input range queue exhausted");
      if (!this.#idleMailbox.reserveInput(buffer, this.#inputRanges, utf8Bytes, this.#fillCapacity, Boolean(this.#time)))
        throw fault("retained.mailbox-overflow", "aggregate execution mailbox exhausted");
      this.#buffer = buffer; this.#inputUtf8Bytes = utf8Bytes;
    } catch (cause) { this.#inputRanges.length = previous; throw cause; }
  }
  #materializeDeferred(): void {
    while (this.#deferredInput) {
      activeNativeScratch()?.iteration();
      const range = this.#deferredInput;
      const append = () => this.#appendInput(range.bytes, range.sequence, range.recordedSequence, range.channelId, range.tUs);
      const source = this.#inputWork.get(range.sequence);
      if (source) this.#withInputWork(source, append); else append();
      this.#deferredInput = range.next;
      if (!this.#deferredInput) this.#deferredTail = undefined;
      this.#idleMailbox!.releaseRaw(range.bytes.buffer.byteLength);
      range.storage?.release();
    }
  }
  #discardDeferred(): void {
    while (this.#deferredInput) {
      const range = this.#deferredInput; this.#deferredInput = range.next;
      range.storage?.release();
    }
    this.#deferredTail = undefined;
  }
  #trackInputWork(activation: Activation, count: number): void {
    // Called BEFORE either read or bounded-fill changes physical provenance.
    // Latest observed-through is not a replacement for the original ranges.
    if (!count || !this.#entryTracksInput(activation)) return;
    const key = this.#entryInputKey(activation);
    let ranges = this.#inputWorkRanges.get(key);
    for (const range of this.#inputRanges) {
      if (!count) break;
      const n = Math.min(count, range.length), source = this.#inputWork.get(range.sequence);
      if (source) {
        if (!ranges) { ranges = new InputWorkRanges(0); this.#inputWorkRanges.set(key, ranges); }
        ranges.append(source, n);
      } else if (ranges) throw fault("retained.input-retirement-unavailable", "mixed tracked and untracked entry input");
      count -= n;
    }
  }
  #takeInput(maximum: number): string {
    // One receive completion keeps one source range's readiness sequence.
    const count = Math.min(maximum, this.#inputRanges[0]?.length ?? 0);
    activeNativeScratch()?.reserve(16 + this.#buffer.length * 3);
    activeNativeScratch()?.work(2 + Math.ceil(this.#buffer.length / 256));
    const bytes = this.#buffer.slice(0, count);
    const consumedUtf8 = this.#accounting.rpcMessageBytes(bytes, activeNativeScratch()) - 8;
    this.#inputUtf8Bytes -= consumedUtf8;
    this.#buffer = this.#buffer.slice(count);
    if (this.#inputRanges[0]) { this.#inputRanges[0].offset += count; this.#inputRanges[0].length -= count; if (!this.#inputRanges[0].length) this.#inputRanges.shift(); }
    this.#mailbox.set("input", this.#buffer);
    return bytes;
  }
  #armTimer(activation: Activation, milliseconds: unknown): string {
    this.#live(activation);
    if (typeof milliseconds !== "number" || !Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647)
      throw fault("retained.invalid-timer", "timer duration must be an integer in 0..2147483647 ms");
    if (this.#timerCount() >= this.#maximumTimers) throw fault("retained.timer-limit", "outstanding timer account exhausted");
    const effect = this.#effect(activation, "timer");
    this.#live(activation);
    const timer: ArmedTimer = { activation, effect };
    this.#reserve(effect.id, { owner: activation.id, milliseconds });
    this.#timers.set(effect.id, timer); effect.outcome = "armed";
    this.#pendingEffects.add(effect);
    timer.handle = this.#options.clock.timer(milliseconds, () => {
      if (!activation.live || activation.generation !== this.#generation || this.#timers.get(effect.id) !== timer) return;
      timer.readySequence = this.#stamp(); effect.outcome = "expired-undelivered";
      this.#terminal(activation, () => this.#stamp());
      this.#scheduleWait();
    });
    this.#stamp();
    return effect.id;
  }
  #ownedTimer(activation: Activation, id: string): ArmedTimer {
    const timer = this.#timers.get(id);
    if (!timer || timer.activation !== activation || activation.generation !== this.#generation)
      throw fault("retained.timer-not-granted", "timer ID is not live in this activation");
    return timer;
  }
  #dropTimer(id: string, timer: ArmedTimer, outcome: string): void {
    timer.handle?.dispose(); this.#timers.delete(id); this.#mailbox.delete(id); timer.effect.outcome = outcome;
    this.#terminal(timer.activation, () => this.#stamp());
    this.#settleEffect(timer.activation, timer.effect);
  }
  #cancelTimer(activation: Activation, id: string): string {
    this.#live(activation);
    const timer = this.#ownedTimer(activation, id);
    this.#dropTimer(id, timer, "cancelled");
    return "cancelled:" + id;
  }
  #waitAny(activation: Activation, timerIds: unknown, maximum: unknown, mailboxNames: unknown = [], fill?: BoundedFill): Promise<WaitCompletion> {
    this.#live(activation);
    if (!Array.isArray(timerIds) || timerIds.length > this.#maximumTimers || new Set(timerIds).size !== timerIds.length
      || !Array.isArray(mailboxNames) || mailboxNames.length > 32 || new Set(mailboxNames).size !== mailboxNames.length
      || typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 0 || maximum > 256
      || (!maximum && !timerIds.length && !mailboxNames.length))
      throw fault("retained.invalid-wait", "wait requires distinct owned timers, granted mailboxes and/or a bounded receive");
    const ids = nativeArray(timerIds).map(id => text(id)), mailboxes = nativeArray(mailboxNames).map(name => text(name));
    for (const id of ids) { activeNativeScratch()?.iteration(); this.#ownedTimer(activation, id); }
    for (const name of mailboxes) { activeNativeScratch()?.iteration(); if (!this.#messages.has(name)) throw fault("retained.mailbox-not-granted", "unknown mailbox; taps are not reliable input capabilities"); }
    for (const name of mailboxes) { activeNativeScratch()?.iteration(); this.#mailboxConsumer(activation, name); }
    if (maximum) {
      this.#live(activation, activation.id);
      if (this.#options.scheduling && !this.#entryOwns(activation)) throw fault("retained.receive-owner", "session demultiplexer owns input");
    }
    if (this.#waiting.has(activation.id) || (maximum && (this.#receiver || nativeList(this.#waiting.values()).some(wait => wait.maximum))))
      throw fault("retained.receive-busy", "one wait per activation and one direct consuming registration");
    // Reserve peak copies (byte-string pieces, joined string and byte adapter)
    // and bounded range descriptors before effect acceptance. Input remains in
    // its existing queue/account until a receive actually wins.
    if (fill) {
      activeNativeScratch()?.reserve(8 + fill.count * (12 * 3 + 128));
      activeNativeScratch()?.work(fill.count);
      this.#fillCapacity = this.#accounting.rpcMessageBytes({
      bound: fill.bound, used: 0, scratch: " ".repeat(fill.count * 12),
      ranges: Array.from({ length: fill.count }, () => ({ length: 256, sequence: Number.MAX_SAFE_INTEGER })) }, activeNativeScratch());
    }
    let effect: Effect;
    try {
      this.#reserve("wait:" + activation.id, { ids, mailboxes, maximum });
      effect = this.#effect(activation, fill ? "wait-fill" : "wait-any"); this.#live(activation);
    } catch (cause) { if (fill) this.#fillCapacity = 0; this.#mailbox.delete("wait:" + activation.id); throw cause; }
    this.#pendingEffects.add(effect);
    const accounting = () => { if (fill) this.#stamp();
      if (fill) this.#fillCapacity = 0;
    };
    return new Promise((resolve, reject) => {
      this.#waiting.set(activation.id, { activation, timers: ids, maximum, mailboxes, registered: this.#stamp(), ...(fill ? { fill } : {}),
        reject: cause => { effect.outcome = "cancelled"; accounting(); this.#settleEffect(activation, effect); reject(cause); }, resolve: value => {
        effect.outcome = "settled"; accounting(); this.#settleEffect(activation, effect); resolve(value);
      } });
      this.#scheduleWait();
    });
  }
  #scheduleWait(): void {
    if (!this.#waiting.size || this.#readyScheduled || this.#closed) return;
    this.#readyScheduled = true;
    this.#readyChannel.port2.postMessage(null);
  }
  #considerWait(): void {
    // Match globally by observation sequence before any promise is resolved.
    // A message can satisfy one wait only; reconsider after each consumption.
    for (;;) {
      const scratch: NativeScratch[] = [];
      try {
      const ready: Array<{ waiting: AnyWait; kind: "receive" | "timer" | "message"; id: string; sequence: number }> = [];
      for (const waiting of this.#waiting.values()) {
        try {
          const account = new NativeScratch(this.#helperData, units => this.#nativeWork(waiting.activation, units));
          scratch.push(account);
          withNativeScratch(account, () => {
          account.node(8 + (1 + waiting.timers.length + waiting.mailboxes.length) * 96);
          this.#live(waiting.activation);
          if (waiting.maximum) this.#materializeDeferred();
          if (waiting.maximum && this.#inputRanges.length) {
            const sequence = waiting.fill ? waiting.fill.ready(this.#inputRanges, this.#buffer.length, waiting.registered) : this.#inputRanges[0]!.sequence;
            if (sequence !== undefined) ready.push({ waiting, kind: "receive", id: this.#options.channelId, sequence });
          }
          for (const id of waiting.timers) {
            account.iteration();
            const timer = this.#ownedTimer(waiting.activation, id);
            if (timer.readySequence !== undefined) ready.push({ waiting, kind: "timer", id, sequence: timer.readySequence });
          }
          for (const id of waiting.mailboxes) {
            account.iteration();
            this.#mailboxConsumer(waiting.activation, id);
            const message = this.#messages.get(id)![0];
            if (message) ready.push({ waiting, kind: "message", id, sequence: message.sequence });
          }
          });
        } catch (cause) {
          for (let i = ready.length - 1; i >= 0; i--) if (ready[i]!.waiting === waiting) ready.splice(i, 1);
          this.#waiting.delete(waiting.activation.id); this.#mailbox.delete("wait:" + waiting.activation.id); waiting.reject(cause);
        }
      }
      let sorting: AnyWait | undefined;
      try { ready.sort((a, b) => {
        sorting = a.waiting; this.#nativeWork(a.waiting.activation, 1);
        return a.sequence - b.sequence;
      }); } catch (cause) {
        if (!sorting) throw cause;
        this.#waiting.delete(sorting.activation.id); this.#mailbox.delete("wait:" + sorting.activation.id); sorting.reject(cause); continue;
      } // precedence mutation target: never candidate enumeration order
      const winner = ready[0];
      if (!winner) { this.#pump(true); return; }
      const waiting = winner.waiting;
      this.#waiting.delete(waiting.activation.id);
      const describe = ({ kind, id, sequence }: typeof winner) => ({ kind, id, sequence });
      try {
        this.#native(waiting.activation, () => {
        this.#stamp();
        this.#live(waiting.activation);
        // An old buffered event wins this wait, but cannot backdate an
        // activation that only now registered interest ahead of a ready peer.
        waiting.activation.readySequence = Math.max(waiting.registered, winner.sequence);
        let value = winner.id;
        let binary = false;
        if (winner.kind === "receive") {
          waiting.activation.inputChannel = this.#inputRanges[0]?.channelId ?? this.#options.channelId;
          if (waiting.fill) {
            activeNativeScratch()?.reserve(8 + this.#buffer.length * 3);
            activeNativeScratch()?.work(1 + Math.ceil(this.#buffer.length / 256));
            // Stage the exact consumed UTF-8 size before fill.take mutates
            // provenance. Refusal cannot leave the byte counter half updated.
            const consumedUtf8 = activeNativeScratch()!.transient(scratch => {
              scratch.reserve(8 + waiting.fill!.count * 3);
              scratch.work(1 + Math.ceil(waiting.fill!.count / 256));
              return this.#accounting.rpcMessageBytes(this.#buffer.slice(0, waiting.fill!.count), scratch) - 8;
            });
            this.#trackInputWork(waiting.activation, waiting.fill.count);
            value = waiting.fill.take(this.#buffer, this.#inputRanges);
            this.#inputUtf8Bytes -= consumedUtf8;
            this.#buffer = this.#buffer.slice(waiting.fill.count);
            this.#mailbox.set("input", this.#buffer);
          } else {
            this.#trackInputWork(waiting.activation, Math.min(waiting.maximum, this.#inputRanges[0]?.length ?? 0));
            value = this.#takeInput(waiting.maximum);
          }
          activeNativeScratch()?.reserve(8 + value.length * 16);
          binary = nativeArray([...value]).some(byte => byte.charCodeAt(0) > 127);
          if (value.length) this.#recordReadInput(waiting.activation, winner.sequence, value.length);
        }
        else if (winner.kind === "timer") this.#dropTimer(winner.id, this.#ownedTimer(waiting.activation, winner.id), "delivered");
        else {
          const queue = this.#messages.get(winner.id)!;
          const message = queue[0]!;
          if (message.evidence) this.#inputEvidence(waiting.activation, message.evidence.sequence, message.evidence.bytes, message.evidence.range);
          else { delete waiting.activation.inputEvidence; this.#mailbox.delete("evidence:" + waiting.activation.id); }
          queue.shift();
          binary = message.binary === true;
          value = binary ? message.value : value + ":" + message.value;
          this.#mailbox.set("messages:" + winner.id, queue);
        }
        waiting.resolve(binary
          ? { prefix: winner.kind + ":" + (winner.kind === "message" ? winner.id + ":" : ""), bytes: stringBytes(value) }
          : winner.kind + ":" + value);
        });
      } catch (cause) { waiting.reject(cause); }
      finally { this.#mailbox.delete("wait:" + waiting.activation.id); }
      } finally { for (const account of scratch) account.close(); }
    }
  }
  #rangeHandler(activation: Activation): boolean {
    return Boolean(activation.inputHandler && activation.consumedRangeInput);
  }
  #inputKey(activation: Activation): string { return activation.inputHandler + ":" + activation.consumedRangeChannel; }
  #recordReadInput(activation: Activation, sequence: number, bytes: number, physicalSequence = sequence): void {
    if (this.#tracksTransferInput) this.#inputEvidence(activation, sequence, bytes);
    if (this.#entryTracksInput(activation)) this.#native(activation, () => {
      const key = this.#entryInputKey(activation), previous = this.#consumedInput.get(key);
      const delivered = (previous?.delivered ?? 0) + bytes;
      if (!Number.isSafeInteger(delivered)) throw fault("retained.input-consumption", "entry stream offset exhausted");
      const cursor = { delivered, consumed: previous?.consumed ?? 0, physicalSequence };
      this.#reserve("consumed-input:" + key, cursor); this.#consumedInput.set(key, cursor);
      this.#stamp();
    });
  }
  #consumeInput(activation: Activation, length: unknown): void {
    this.#live(activation);
    const entry = this.#entryTracksInput(activation);
    if (!entry && !this.#rangeHandler(activation)) throw fault("retained.input-consumption", "consumed-range authority is not granted to this activation");
    const cursor = this.#consumedInput.get(entry ? this.#entryInputKey(activation) : this.#inputKey(activation));
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0 || !cursor || length > cursor.delivered - cursor.consumed)
      throw fault("retained.input-consumption", "claim exceeds this owner's delivered, unconsumed input");
    const effect = this.#effect(activation, "input-consume");
    const range = { generation: this.#generation, handler: entry ? activation.id : activation.inputHandler!, channel: entry ? activation.inputChannel! : activation.consumedRangeChannel!,
      start: cursor.consumed, end: cursor.consumed + length, physicalSequence: cursor.physicalSequence };
    this.#inputEvidence(activation, this.#stamp(), length, range);
    cursor.consumed = range.end;
    this.#inputWorkRanges.get(entry ? this.#entryInputKey(activation) : this.#inputKey(activation))?.consume(length, source => {
      // A parser may consume a prefix from an OLDER observation, then yield
      // while classifying it. Transfer that dependency to this interpreting
      // activation; raw consumption alone is not retirement of the source.
      (activation.inputInterpretations ??= new Set()).add(source.interpretation());
      this.#retainCustody(activation, source);
    });
    this.#stamp();
    effect.outcome = "consumed"; this.#settleEffect(activation, effect);
  }
  #inputEvidence(activation: Activation, sequence: number, bytes: number, range?: InputEvidence["range"]): void {
    this.#native(activation, () => {
      const evidence = { sequence, bytes, ...(range ? { range } : {}) }; this.#reserve("evidence:" + activation.id, evidence);
      activation.inputEvidence = evidence;
    });
  }
  #sendMessage(activation: Activation, name: string, value: string, binary = false): void {
    const queue = this.#messages.get(name);
    if (!queue) throw fault("retained.mailbox-not-granted", "unknown mailbox");
    if (nativeList(this.#messages.values()).reduce((sum, messages) => sum + messages.length, 0) >= 64)
      throw fault("retained.message-limit", "shared message capacity exhausted");
    const effect = this.#effect(activation, "message-send");
    this.#live(activation);
    activeNativeScratch()?.reserve(8 + (queue.length + 1) * 16);
    activeNativeScratch()?.work(queue.length);
    const next = [...queue, { sequence: this.#stamp(), value, ...(binary ? { binary: true } : {}), ...(activation.inputEvidence ? { evidence: { ...activation.inputEvidence } } : {}) }];
    this.#reserve("messages:" + name, next); this.#messages.set(name, next);
    // A range receipt moves with the message; sending again cannot copy it.
    if (activation.inputEvidence?.range) { delete activation.inputEvidence; this.#mailbox.delete("evidence:" + activation.id); }
    effect.outcome = "accepted-by-mailbox";
    this.#stamp();
    this.#settleEffect(activation, effect);
    const routed = nativeList(this.#routed.values()).find(channel => channel.mailbox === name);
    if (routed) this.#consumeRouted(routed);
    this.#scheduleWait();
  }
  #withInputWork<T>(account: InputWorkAccount | undefined, run: () => T): T {
    if (!account) return run();
    const scratch = new NativeScratch(this.#helperData, units => account.charge(units));
    try { return withNativeScratch(scratch, run); } finally { scratch.close(); }
  }
  #closePendingInputWork(): void {
    for (const account of this.#inputWork.values()) { account.revoke(); account.close(); }
    this.#inputWork.clear();
  }
  #queueHandler(bytes: Uint8Array, sequence: number, recordedSequence: number, parent?: Activation, committed?: number, sourceOffset = 0, channelId?: string, tUs?: number): void {
    if (!bytes.length) return;
    const id = this.#identity("input");
    const inputWork = this.#inputWork.get(sequence);
    parent ??= inputWork ? this.#inputParents.get(inputWork) : undefined;
    let preparationWork = 0, prepared: HandlerDelivery | undefined;
    const scratch = new NativeScratch(this.#helperData, units => {
      if (inputWork) inputWork.charge(units);
      else if (parent) this.#nativeWork(parent, units);
      else if ((prepared?.work ?? preparationWork) + units > this.#maximumWork)
        throw fault("retained.work-exhausted", "input delivery preparation exhausted its account");
      preparationWork += units;
      if (prepared) prepared.work += units;
    });
    try { withNativeScratch(scratch, () => {
    // Reserve before copying; a compact owned buffer cannot retain hidden capacity.
    const observation = this.#options.description?.handlers?.[0]?.requires.includes("clock.observe")
      ? this.#time!.observe(sequence, this.#generation, tUs ?? Number.NaN) : undefined;
    this.#reserve(id, { sequence, recordedSequence, generation: this.#generation, offset: 0, bytes, ...(observation ? { observation } : {}) });
    scratch.work(1 + Math.ceil(bytes.length / 256));
    const delivery: HandlerDelivery = { id, sequence, recordedSequence, generation: this.#generation,
      bytes: bytes.slice(), length: bytes.length, offset: 0, sourceOffset, active: 0, work: preparationWork, ...(inputWork ? { inputWork } : {}), ...(parent ? { parent } : {}), ...(channelId ? { channelId } : {}), ...(observation ? { observation } : {}) };
    prepared = delivery;
    this.#mailbox.set(id, { sequence, recordedSequence, generation: delivery.generation, offset: 0, bytes: delivery.bytes, ...(observation ? { observation } : {}) });
    if (observation) this.#stamp();
    if (parent) parent.accountChildren = (parent.accountChildren ?? 0) + 1;
    this.#handlerDeliveries.add(delivery); this.#handlerQueue.push(delivery);
    if (inputWork) {
      const consumed = inputWork.consumed;
      inputWork.consumed = () => { consumed?.(); this.#retireDelivery(delivery); };
      if (!inputWork.inherited) this.#inputWork.delete(sequence);
    }
    this.#handlerBytes += bytes.length;
    this.#handlerHighWater = Math.max(this.#handlerHighWater, this.#handlerBytes);
    // Taps observe ingress even if the consuming handler is suspended. Only
    // the last two quanta can survive the lossy ring: compute dropped counts
    // without iterating through or retaining every subdivision.
    this.#observeTaps(bytes, sequence, () => {
      if (inputWork) inputWork.charge(1);
      else if (parent) this.#charge(parent);
      else if (delivery.work >= this.#maximumWork) throw fault("retained.work-exhausted", "input observation work exhausted");
      delivery.work++;
    });
    this.#stamp();
    this.#scheduleHandlers(Math.max(sequence, committed ?? sequence));
    }); } finally { scratch.close(); }
  }
  #scheduleHandlers(sequence = this.#stamp()): void {
    const handler = this.#options.description?.handlers?.[0];
    if (this.#handlerScheduled || !this.#handlerQueue.length || this.#closed || !this.#connection
      || this.#channelOwner !== this.#demuxOwner || this.#tasks + this.#helperTasks >= 64
      || (handler && (this.#handlerTasks.get(handler.id) ?? 0) >= handler.maximumConcurrent)) return;
    this.#handlerScheduled = true;
    const epoch = this.#handlerScheduleEpoch;
    void this.#turns.enqueue(sequence, async () => {
      if (epoch !== this.#handlerScheduleEpoch) return;
      this.#handlerScheduled = false;
      const delivery = this.#handlerQueue[0];
      if (!delivery || this.#closed || delivery.generation !== this.#generation) return;
      if (this.#tasks + this.#helperTasks >= 64 || (handler && (this.#handlerTasks.get(handler.id) ?? 0) >= handler.maximumConcurrent)) return;
      const offset = delivery.offset, length = Math.min(256, delivery.length - offset);
      const bytes = delivery.bytes.subarray(offset, offset + length);
      this.#startHandler(bytes, delivery.sequence,
        delivery.parent ?? delivery.root, sequence, delivery);
      this.#nativeTransient((delivery.parent ?? delivery.root)!, () => this.#stamp());
      delivery.offset += length;
      if (delivery.offset === delivery.length) {
        this.#handlerQueue.shift();
        this.#handlerBytes -= delivery.bytes.length; delivery.bytes = new Uint8Array();
        this.#mailbox.set(delivery.id, { sequence: delivery.sequence, generation: delivery.generation, length: delivery.length, ...(delivery.observation ? { observation: delivery.observation } : {}) });
      }
      // An authored turn or retirement schedules the successor; no inline drain.
    }).catch(cause => { void this.#disconnect(errorValue(cause)); });
  }
  #retireDelivery(delivery: HandlerDelivery): void {
    if (delivery.active || delivery.offset < delivery.length || delivery.inputWork?.remaining || delivery.releasing) return;
    delivery.releasing = true;
    const release = async () => {
      if (delivery.parked && delivery.root) {
        const root = delivery.root; root.retiring = true;
        try { const { promise } = this.#terminal(root, () => ({ promise: this.#options.execution.retire(root.id) })); await promise; }
        finally { delete root.retiring; }
      }
    };
    void (this.#closed ? release() : this.#turns.enqueue(this.#stamp(), release)).catch(cause => {
      void this.#disconnect(errorValue(cause));
    }).finally(() => {
      this.#handlerDeliveries.delete(delivery); this.#mailbox.delete(delivery.id);
      if (delivery.parent && --delivery.parent.accountChildren! === 0) delivery.parent.childrenRetired?.();
      const owner = delivery.parent ?? delivery.root;
      const record = () => this.#stamp();
      try { if (owner) this.#terminal(owner, record); else record(); }
      finally {
        delivery.root?.terminal?.close(); if (delivery.root) delete delivery.root.terminal;
        delivery.inputWork?.close();
      }
    });
  }
  #revokeDeliveries(): void {
    const prepared = this.#preparedEntry?.activation;
    if (prepared && !this.#activations.has(prepared.id)) {
      this.#endCustody(prepared);
      // Acquisition/census refusal can precede #run and its finally block.
      for (const interpretation of prepared.inputInterpretations ?? []) interpretation.release();
      delete prepared.inputInterpretations;
    }
    for (const ranges of this.#inputWorkRanges.values()) ranges.close();
    this.#inputWorkRanges.clear(); this.#closePendingInputWork();
    for (const key of this.#consumedInput.keys()) this.#mailbox.delete("consumed-input:" + key);
    this.#consumedInput.clear();
    this.#handlerScheduleEpoch++; this.#handlerScheduled = false;
    this.#handlerQueue.length = 0;
    for (const delivery of this.#handlerDeliveries) {
      // Prefix descriptors have now spent their prepaid release work. Only
      // here may generation-wide revocation discard any never-delivered part.
      delivery.inputWork?.revoke();
      this.#revokeDelivery(delivery);
    }
  }
  #revokeDelivery(delivery: HandlerDelivery): void {
    const discarded = delivery.length - delivery.offset;
    // Local cancellation discards the undispatched tail, not delivered raw
    // prefixes still referenced by the consuming owner's inventory.
    if (discarded && delivery.inputWork?.remaining) delivery.inputWork.consume(discarded);
    if (discarded) this.#stamp();
    const index = this.#handlerQueue.indexOf(delivery);
    if (index >= 0) this.#handlerQueue.splice(index, 1);
    this.#handlerBytes -= delivery.bytes.length;
    delivery.offset = delivery.length; delivery.bytes = new Uint8Array();
    this.#mailbox.set(delivery.id, { revoked: true });
    this.#retireDelivery(delivery);
  }
  #startHandler(input: string | Uint8Array, sequence: number, parent?: Activation, committed?: number, delivery?: HandlerDelivery): void {
    if (this.#closed || this.#captureFailure) throw fault("retained.revoked", "session handler cannot start after revocation");
    if (this.#tasks + this.#helperTasks >= 64) throw fault("retained.task-limit", "shared logical task capacity exhausted");
    const handler = this.#options.description?.handlers?.[0];
    if (handler && (this.#handlerTasks.get(handler.id) ?? 0) >= handler.maximumConcurrent)
      throw fault("authored.handler.delivery-limit", "declared concurrent delivery capacity exhausted; reliable input cannot be silently dropped");
    const id = this.#identity("handler") as OperationId;
    const activation: Activation = { id, generation: this.#generation, startedUs: this.#options.clock.monotonicUs(),
      resources: new Set(), effects: new Map(), live: true, finished: false, work: 0, consumed: 0,
      revokers: new Set(), handler: true, readySequence: Math.max(sequence, committed ?? sequence),
      ...(parent ? { accountParent: parent, inheritedInput: true } : {}), ...(delivery ? { delivery } : {}) };
    if (delivery?.inputWork && !parent) delivery.inputWork.bind(activation);
    if (delivery?.inputWork?.inherited && delivery.inputWork.remaining)
      activation.inputInterpretations = new Set([delivery.inputWork.interpretation()]);
    if (delivery?.inputWork) this.#retainCustody(activation, delivery.inputWork);
    try {
    if (this.#tracksTransferInput && handler?.inputEvidence !== "consumed-ranges") this.#inputEvidence(activation, sequence, input.length);
    if (input instanceof Uint8Array && !this.#options.execution.dispatchBytes) {
      const bytes = input;
      input = this.#native(activation, () => {
        activeNativeScratch()?.reserve(32); // borrowed range view
        if (nativeArray(bytes).some(byte => byte > 127))
          throw fault("retained.unsupported-bytes", "execution port has no byte delivery adapter");
        return byteString(bytes);
      });
    }
    if (delivery) {
      if (!delivery.parent && !delivery.root && !delivery.inputWork) activation.work = delivery.work;
      this.#charge(activation); // Subdivision step; no normalization grant.
      this.#nativeTransient(activation, () => this.#reserve("handler:" + id, input));
      if (input instanceof Uint8Array) {
        const bytes = input;
        input = this.#native(activation, () => boundedBytes(bytes));
      }
    }
    if (handler) {
      if (delivery?.channelId) activation.inputChannel = delivery.channelId;
      activation.inputHandler = handler.id;
      activation.consumedRangeInput = handler.inputEvidence === "consumed-ranges";
      if (activation.consumedRangeInput) activation.consumedRangeChannel = delivery?.channelId ?? this.#options.channelId;
      activation.declaration = { ...handler, id: handler.id, title: handler.id, arguments: {
        ...(delivery?.observation ? { observation: clockObservationType } : {}),
        ...(delivery?.channelId ? { channelId: { kind: "string" as const, maximumLength: 96 } } : {}),
        input: { kind: input instanceof Uint8Array ? "bytes" : "string", maximumLength: 256 }, sequence: { kind: "integer", widthBits: 64, signed: false } },
        result: { kind: "none" }, risk: "changes-state", repeatability: "not-repeatable",
        availability: { modes: [this.#options.modeId], profiles: [this.#options.profileId] } };
      activation.arguments = this.#native(activation, () => ({ input: input instanceof Uint8Array
        ? authoredPublicValue(input, { kind: "bytes", maximumLength: 256 }) : input, sequence, ...(delivery?.channelId ? { channelId: delivery.channelId } : {}),
        ...(delivery?.observation ? { observation: { ...delivery.observation } } : {}) }));
    }
    this.#native(activation, () => {
      this.#reserve("handler:" + id, { input, arguments: activation.arguments ?? null }); this.#reserve(id, activation.effects);
    });
    } catch (cause) {
      this.#endCustody(activation);
      for (const interpretation of activation.inputInterpretations ?? []) interpretation.release();
      delete activation.inputInterpretations;
      this.#releaseNative(activation); this.#mailbox.delete("handler:" + id); this.#mailbox.delete(id); throw cause;
    }
    if (delivery) { if (!delivery.parent && !delivery.root) delivery.root = activation; delivery.active++; }
    if (handler) this.#handlerTasks.set(handler.id, (this.#handlerTasks.get(handler.id) ?? 0) + 1);
    if (parent && !delivery) parent.accountChildren = (parent.accountChildren ?? 0) + 1;
    this.#activations.set(id, activation);
    this.#nativeTransient(activation, () => this.#stamp());
    this.#tasks++;
    void this.#run(activation, this.#options.scheduling!.demultiplexer, input);
  }
  #openTap(activation: Activation): string {
    if (this.#taps.size >= 32) throw fault("retained.tap-limit", "tap capacity exhausted");
    const id = this.#identity("tap");
    // Reserve peak ring/poll scratch up front, so observation cannot block the
    // consumer on mailbox growth. Capacity two, drop oldest, octet ranges <=256.
    this.#reserve(id, { owner: activation.id, dropped: 0, capacity: 2,
      records: Array.from({ length: 2 }, () => ({ sequence: Number.MAX_SAFE_INTEGER, value: " ".repeat(256) })),
      // JSON escapes an ASCII control byte into up to six bytes. Reserve the
      // full bounded poll representation, not just its unescaped payload.
      pollScratch: " ".repeat(4096) });
    this.#taps.set(id, { owner: activation, dropped: 0, records: [] });
    this.#stamp();
    return id;
  }
  #observeTaps(bytes: Uint8Array, sequence: number, charge: () => void): void {
    if (!this.#taps.size) return;
    const count = Math.ceil(bytes.length / 256), records: Array<{ sequence: number; value: string }> = [];
    for (let i = Math.max(0, count - 2); i < count; i++) {
      charge(); records.push({ sequence, value: byteString(bytes.subarray(i * 256, Math.min(bytes.length, (i + 1) * 256))) });
    }
    for (const tap of this.#taps.values()) {
      charge(); tap.dropped += Math.max(0, tap.records.length + count - 2);
      tap.records = [...tap.records, ...records].slice(-2);
    }
  }
  #pollTap(activation: Activation, id: string): string {
    const tap = this.#taps.get(id);
    if (!tap || tap.owner !== activation) throw fault("retained.tap-not-granted", "tap not owned by activation");
    const value = nativeJson({ reliable: false, dropped: tap.dropped, records: tap.records })!;
    tap.records = []; tap.dropped = 0;
    return value;
  }
  async #control(activation: Activation, setupValue: unknown, payloadValue: unknown): Promise<string> {
    this.#live(activation);
    const effect = this.#effect(activation, "control", false);
    const invalid = (message: string): never => {
      effect.outcome = "invalid"; this.#stamp();
      this.#settleEffect(activation, effect);
      throw fault("retained.invalid-control", message, { effectId: effect.id, submitted: false });
    };
    if (typeof setupValue !== "object" || setupValue === null || Array.isArray(setupValue)) invalid("control setup must be a record");
    const setup = setupValue as Record<string, unknown>;
    if (!Array.isArray(payloadValue) || payloadValue.length > 256 || payloadValue.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) invalid("control payload must contain at most 256 octets");
    activeNativeScratch()?.reserve(8 + (payloadValue as number[]).length);
    activeNativeScratch()?.work((payloadValue as number[]).length);
    const payload = Uint8Array.from(payloadValue as number[]);
    const request: ControlRequest = { kind: "usb.control", parameters: setup as Record<string, PublicValue>,
      ...(setup.direction === "host-to-device" || payload.length ? { payload } : {}) };
    const parsed = parseUsbControlRequest(request);
    if (parsed.kind === "invalid") invalid(parsed.message);
    if ((setup.length as number) > 256) invalid("control response/request bound is 256 bytes");
    this.#live(activation);
    const capability = this.#options.usbControl;
    if (!capability?.available) {
      effect.outcome = "unsupported";
      const outcome = { effectId: effect.id, settled: "unsupported", limitation: capability?.limitation ?? "no USB control grant", submitted: false };
      this.#stamp();
      this.#settleEffect(activation, effect);
      return nativeJson(outcome)!;
    }
    this.#outboundAvailable(activation, "control");
    // The granted domain bounds the asynchronous response. Its mandatory
    // observation cannot borrow another activation's ambient scope, and must
    // still be possible if cancellation occurs while the platform owns it.
    const observation = this.#newRunway(activation);
    observation.ensure(1024 + 4 * (setup.length as number), 65536 + 128 * (setup.length as number));
    try {
    this.#stamp();
    this.#live(activation);
    this.#stamp();
    this.#live(activation); effect.outcome = "indeterminate";
    this.#pendingEffects.add(effect);
    this.#outbound.set(effect.id, { owner: activation.id, generation: activation.generation, effect });
    try {
      const response = await this.#connection!.control(request);
      activation.readySequence = response.atSequence;
      effect.outcome = response.settled;
      if (response.payload && (response.payload.length > (setup.length as number) || setup.direction !== "device-to-host"))
        throw fault("retained.invalid-control-response", "platform control response exceeds the granted byte domain", { effectId: effect.id });
      observation.run(() => {
        if (response.payload) { activeNativeScratch()?.reserve(8 + response.payload.length * 16); activeNativeScratch()?.work(response.payload.length); }
        this.#stamp();
      });
      if (response.settled === "failed") throw Object.assign(new Error(response.error?.message ?? "control failed"), {
        error: { ...(response.error ?? { code: "retained.control-failed", message: "platform control failed", responsibility: "operation", retryability: "unknown" }),
          details: { effectId: effect.id, submitted: true, ...(response.error?.details === undefined ? {} : { cause: response.error.details }) } } });
      return this.#native(activation, () => {
        const bytes = response.payload ?? new Uint8Array();
        activeNativeScratch()?.reserve(8 + bytes.length * 16); activeNativeScratch()?.work(bytes.length);
        return nativeJson({ effectId: effect.id, settled: response.settled, payload: [...bytes] })!;
      });
    } catch (cause) {
      effect.outcome = "failed";
      observation.run(() => this.#stamp());
      throw cause;
    } finally { this.#settleEffect(activation, effect); this.#outbound.delete(effect.id); }
    } finally { observation.close(); }
  }
  async #helper(activation: Activation, name: string, parent = activation.id as string): Promise<string | Uint8Array> {
    const helper = this.#options.helpers[name];
    if (!helper) throw fault("retained.helper-unavailable", "helper not granted");
    this.#live(activation, this.#options.scheduling ? undefined : parent);
    let routed = this.#routed.get(activation.id);
    if (this.#options.scheduling) {
      if (!helper.mailbox) throw fault("retained.helper-channel-not-granted", "scheduled helper requires an explicit routed channel, not raw input");
      if (routed && routed.mailbox !== helper.mailbox) throw fault("retained.helper-channel-not-granted", "helper cannot widen its inherited routed channel");
      if (!routed) {
        if (nativeList(this.#routed.values()).some(channel => channel.mailbox === helper.mailbox)
          || nativeList(this.#waiting.values()).some(wait => wait.mailboxes.includes(helper.mailbox!)))
          throw fault("retained.receive-busy", "routed channel already has a consuming owner or registration");
        routed = { activation, mailbox: helper.mailbox, owner: parent };
        this.#reserve("routed:" + activation.id, { mailbox: helper.mailbox, owner: parent });
        this.#routed.set(activation.id, routed);
        this.#stamp();
      }
    }
    this.#charge(activation, parent); // native helper entry; no fresh child account
    if (routed ? routed.receiver || this.#waiting.has(activation.id) : this.#receiver)
      throw fault("retained.handoff-unavailable", "pending receive must finish or be withdrawn before handoff");
    if (this.#tasks + this.#helperTasks >= 64) throw fault("retained.helper-task-limit", "shared logical task limit reached");
    const child = this.#identity("helper");
    // Bounded native adapter frame: IDs, ownership flags, one pending call,
    // wire/reply/result scratch (256 bytes each), and reservation containers.
    // Buffer reservations add their own descriptors; neither cost is RSS.
    const frame = this.#helperData.frame({ child, parent, name, accepted: false,
      entered: false, ended: false, busy: false, sequence: 0, allocation: 0,
      workResult: " ".repeat(256), wireRequest: " ".repeat(256), wireReply: " ".repeat(256),
      holdings: [], reservations: [], pending: { id: 0, method: " ".repeat(16) } });
    this.#helperTasks++;
    const holdings = new Set<{ release(): void }>();
    const context: NativeHelperContext = {
          iteration: () => this.#charge(activation, child),
      reserveBuffer: (capacity, usedLength) => {
        this.#live(activation, child);
        activation.terminal?.reserveRelease();
        const held = this.#helperData.reserve(capacity, usedLength);
        let live = true;
        const owned = { release: () => { if (live) {
          this.#terminal(activation, () => { activeNativeScratch()?.iteration(); held.release(); holdings.delete(owned); live = false; });
        } } };
        holdings.add(owned); return owned;
      },
      call: name => { this.#charge(activation, child); return this.#nativeAsync(activation, () => this.#helper(activation, text(name), child)); },
      onRevoke: cancel => {
        this.#live(activation, child); activation.revokers.add(cancel);
        return () => { activation.revokers.delete(cancel); };
      },
    };
    let accepted = false, back: string | undefined;
    try {
    this.#stamp();
    const result = await helper.run({ accept: () => this.#native(activation, () => {
      this.#live(activation, parent);
      if (accepted) throw fault("retained.stale-offer", "offer already consumed");
      accepted = true;
      if (routed) routed.owner = child; else this.#channelOwner = child;
      this.#stamp();
      return { read: maximum => { this.#charge(activation, child); return this.#nativeAsync(activation, () => this.#read(activation, child, maximum)); },
        readBytes: async maximum => {
          this.#charge(activation, child);
          const bytes = await this.#nativeAsync(activation, () => this.#read(activation, child, maximum, true));
          return this.#native(activation, () => stringBytes(bytes));
        },
        write: bytes => { this.#charge(activation, child); return this.#nativeAsync(activation, () => this.#write(activation, child, bytes)); },
        offerBack: () => this.#native(activation, () => {
          this.#live(activation, child);
          if (back || (routed ? routed.receiver : this.#receiver)) throw fault("retained.handoff-unavailable", "pending receive or repeated handback");
          back = this.#identity("offer");
          this.#stamp(); return { offerId: back };
        }) };
    }) }, context);
    this.#live(activation, child);
    if (!accepted || !back || result.handback.offerId !== back) throw fault("retained.handoff-unavailable", "helper did not offer its raw buffer back");
    const value = this.#native(activation, () => result.value instanceof Uint8Array ? boundedBytes(result.value) : text(result.value));
    if (value instanceof Uint8Array && parent === activation.id && !this.#options.execution.dispatchBytes)
      throw fault("retained.unsupported-bytes", "caller cannot accept byte handback");
    if (routed) routed.owner = parent; else this.#channelOwner = parent;
    this.#native(activation, () => this.#stamp());
    return value;
    } finally {
      this.#helperTasks--;
      for (const held of holdings) held.release();
      frame.release();
    }
  }
  #finish(activation: Activation, outcome: OperationResult["outcome"], result: PublicValue, error?: PdrError): void {
    if (activation.finished || activation.cleanupPending) return;
    const terminalUs = this.#time ? this.#options.clock.monotonicUs() : undefined;
    let unsafeCleanup = false;
    try {
      if (this.#closed || this.#captureFailure || this.#options.execution.terminated) this.#expiries?.clear("generation-ended");
      else this.#expiries?.terminal(activation.id, terminalUs!);
    } catch (cause) { this.#expiries?.clear("terminal-failed"); unsafeCleanup = true; error = errorValue(cause); outcome = "failed"; }
    if (activation.cleanupChild) {
      const child = activation.cleanupChild;
      delete activation.cleanupChild; // one-shot transfer; no cancellation can renew it
      let unsafe = unsafeCleanup || this.#closed || this.#captureFailure || this.#options.execution.terminated || activation.workFailure
        || !child.terminal || error?.code.includes("exhausted") || error?.code.includes("allocation-limit");
      let terminal: AuthoredClockObservation | undefined;
      if (!unsafe && child.declaration!.requires.includes("clock.observe")) {
        try { terminal = this.#terminal(activation, () => this.#clockObservation(activation, "ordinary-terminal", this.#stamp(), terminalUs)); }
        catch (cause) { unsafe = true; error = errorValue(cause); outcome = "failed"; }
      }
      if (unsafe) {
        unsafeCleanup = true;
        this.#tasks--; this.#cleanupTimers--; child.terminal?.close();
        error = { ...(error ?? { code: "authored.cleanup.skipped", message: "cleanup unavailable in unsafe execution", responsibility: "definition", retryability: "no" }),
          details: { ...(error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {}), cleanup: { outcome: "skipped" } } };
        if (outcome === "completed") outcome = "failed";
      } else {
        let resolve!: () => void;
        activation.cleanupPending = new Promise<void>(yes => { resolve = yes; });
        this.#terminal(activation, () => {
          this.#revokeActivation(activation, false);
          this.#stamp();
          for (const [lock, owner] of nativeWalk(this.#lockOwners)) if (owner === activation) this.#lockOwners.set(lock, child);
        });
        child.generation = this.#generation;
        child.arguments = { outcome, code: error?.code ?? "", ...(terminal ? { terminal: { ...terminal } } : {}) };
        child.locksAcquired = true;
        if (!this.#options.scheduling) { this.#channelOwner = child.id; this.#channelFunding = child; }
        this.#activations.set(child.id, child);
        child.cleanupComplete = cleanupError => {
          child.cleanupTimer?.dispose(); this.#cleanupTimers--;
          const cleanup = { outcome: cleanupError ? "failed" : "completed", owner: child.id,
            consumed: child.consumed, work: child.work, ...(cleanupError ? { error: { code: cleanupError.code, message: cleanupError.message,
              ...(cleanupError.details === undefined ? {} : { details: cleanupError.details }) } } : {}) };
          let terminalError = error;
          if (cleanupError && !terminalError) terminalError = { code: "authored.cleanup.failed", message: "ordinary return did not complete protocol restoration", responsibility: "definition", retryability: "no" };
          if (terminalError) terminalError = { ...terminalError, details: {
            ...(terminalError.details && typeof terminalError.details === "object" && !Array.isArray(terminalError.details) ? terminalError.details : {}), cleanup } };
          try { this.#terminal(activation, () => this.#finishReserved(activation,
            cleanupError && outcome === "resume-required" ? "failed-with-incomplete-cleanup"
              : outcome === "completed" && cleanupError ? "failed" : outcome,
            cleanupError ? null : result, terminalError)); }
          finally { resolve(); }
          if (cleanupError && !this.#closed) void this.#disconnect(cleanupError);
        };
        const c = activation.declaration!.cleanup!;
        child.cleanupTimer = this.#options.clock.timer(c.maximumMilliseconds, () => {
          if (child.live) this.#finish(child, "cancelled", null, { code: "authored.cleanup.timeout", message: "prepaid cleanup wall bound expired", responsibility: "definition", retryability: "no" });
        });
        try { this.#native(child, () => this.#stamp()); }
        catch (cause) { this.#finish(child, "failed", null, errorValue(cause)); }
        void this.#run(child, "protocol-cleanup");
        return;
      }
    }
    this.#terminal(activation,()=>this.#finishReserved(activation,outcome,result,error));
    if (unsafeCleanup && !this.#closed) void this.#disconnect(error);
  }
  #revokeActivation(activation: Activation, releaseLocks = true): void {
    activation.live = false;
    if (releaseLocks) this.#releaseLocks(activation);
    for (const revoke of nativeWalk(activation.revokers)) revoke();
    activation.revokers.clear();
    for (const [id, timer] of nativeWalk(this.#timers)) if (timer.activation === activation) this.#dropTimer(id, timer, "owner-ended");
    for (const deadline of nativeWalk(this.#deadlines.values())) if (deadline.activation === activation) this.#dropDeadline(deadline, "owner-ended");
    const waiting = this.#waiting.get(activation.id);
    if (waiting) { this.#waiting.delete(activation.id); this.#mailbox.delete("wait:" + activation.id); waiting.reject(fault("retained.revoked", "wait cancelled")); }
    for (const [id, tap] of nativeWalk(this.#taps)) if (tap.owner === activation) { this.#taps.delete(id); this.#mailbox.delete(id); }
    if (this.#receiver?.activation === activation) {
      const receiver = this.#receiver; this.#receiver = undefined; receiver.reject(fault("retained.revoked", "receive cancelled"));
    }
    const routed = this.#routed.get(activation.id);
    if (routed) {
      this.#routed.delete(activation.id); this.#mailbox.delete("routed:" + activation.id);
      routed.receiver?.reject(fault("retained.revoked", "routed receive cancelled"));
      // Unread messages remain owned by the broker, not flushed by retirement.
      this.#scheduleWait();
    }
  }
  #finishReserved(activation: Activation, outcome: OperationResult["outcome"], result: PublicValue, error?: PdrError): void {
    if (activation.finished) return;
    if (activation.entryDone && this.#options.description?.entry?.handoffTo && !activation.entryHandoff && outcome === "completed") {
      outcome = "failed";
      error = { code: "authored.entry.handoff-incomplete", message: "entry returned without accepted handoff", responsibility: "definition", retryability: "no" };
    }
    activation.finished = true;
    this.#revokeActivation(activation);
    if (error?.code === "retained.cancelled") {
      // Host-owned timers are now retired; unlike an unabortable platform
      // write, their outcome is no longer pending at cancellation completion.
      error = { ...error, details: { ...(error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {}),
        effects: nativeList(activation.effects.values()).map(effect => ({ ...effect })), effectsEvicted: activation.effectsEvicted ?? 0 } };
    }
    // Only host-local / not-submitted work can terminate just because the
    // owner ended. Native promises keep their slot until their own finally.
    for (const effect of nativeWalk(activation.effects.values())) {
      if (!this.#pendingEffects.has(effect)) this.#settleEffect(activation, effect);
    }
    if (error && activation.effectsEvicted) error = { ...error, details: {
      ...(error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : { cause: error.details ?? null }),
      effects: nativeList(activation.effects.values()).map(effect => ({ ...effect })), effectsEvicted: activation.effectsEvicted,
    } };
    if (!this.#options.scheduling && !activation.cleanupPending) { this.#channelOwner = undefined; this.#channelFunding = undefined; }
    const history = nativeList(activation.effects.values());
    this.#stamp();
    if (activation.cleanupOwner) {
      // A terminal reserve cannot serialize an arbitrary author failure tree.
      // Keep a bounded diagnostic summary and make the omission explicit.
      if (error) {
        activeNativeScratch()?.reserve(32 + (128 + 512) * 3);
        activeNativeScratch()?.work(2 + Math.ceil((Math.min(error.code.length, 128) + Math.min(error.message.length, 512)) / 256));
        error = { code: error.code.slice(0, 128), message: error.message.slice(0, 512),
          ...(error.responsibility === undefined ? {} : { responsibility: error.responsibility }), retryability: "no",
          details: { detailsOmitted: error.details !== undefined, codeTruncated: error.code.length > 128, messageTruncated: error.message.length > 512 } };
      }
      this.#stamp();
      activation.cleanupComplete?.(error ?? (outcome === "completed" ? undefined : { code: "authored.cleanup.cancelled", message: "cleanup revoked", responsibility: "operation", retryability: "no" }));
      return;
    }
    if (activation.handler) {
      if (error) {
        // Authored/platform failure details are variable payload, not fixed
        // cleanup. Prepare them from the original ordinary account. If that
        // account cannot afford publication, its bounded refusal still has
        // reserved authority to end the handler and connection visibly.
        try {
          this.#nativeTransient(activation, () => this.#stamp());
        } catch (cause) {
          error = errorValue(cause);
          this.#stamp();
        }
      } else this.#stamp();
      activation.entryDone?.(error ?? (outcome === "completed" ? undefined : { code: "authored.entry.cancelled", message: "entry revoked", responsibility: "operation", retryability: "no" }));
      activation.acceptanceDone?.(result, error ?? (outcome === "completed" ? undefined : { code: "retained.revoked", message: "acceptance revoked", responsibility: "operation", retryability: "no" }));
      if (outcome === "failed" && !activation.entryDone && !activation.acceptanceDone) void this.#disconnect(error);
      return;
    }
    // Loss while recording the terminal fact cannot be promoted to a complete
    // result. finished already prevents the loss observer from recursing.
    if (outcome === "completed" && this.#captureFailure) { outcome = "cancelled"; result = null; error = this.#captureFailure; }
    const terminal: OperationResult = { operationId: activation.id, outcome, result,
      ...(activation.sourcePreparation ? { sourcePreparation: { ...activation.sourcePreparation } } : {}),
      ...(activation.transfer ? { transferReceipt: activation.transfer.receipt ?? activation.transfer.retirement ?? { checkpointId: activation.transfer.checkpoint?.id ?? null,
        committedSourceOffset: activation.transfer.checkpoint?.confirmedRanges[0]?.length ?? 0, verified: false } } : {}),
      ...(outcome === "completed" && activation.output?.receipt ? { resourceResult: activation.output.receipt } : {}),
      ...(activation.output?.stream ? { outputProgress: { subject: activation.output.stream.subject,
        acceptedBytes: activation.output.bytes, complete: outcome === "completed", resume: "restart-required" } } : {}),
      ...(outcome === "resume-required" && activation.authoredCause ? { authoredCause: activation.authoredCause } : {}),
      durationMs: (this.#options.clock.monotonicUs() - activation.startedUs) / 1000,
      ...(error ? { error } : {}) };
    this.#retention.complete(terminal);
    activation.completed = outcome === "completed";
    this.#publish({ kind: "operation-end", result: terminal });
    if (activation.poll) this.#poll?.terminal(activation.id, terminal);
  }
  #cancel(id: OperationId, error?: PdrError): void {
    const activation = this.#activations.get(id);
    if (!activation || activation.finished || !activation.live) return;
    this.#finish(activation, "cancelled", null, error ?? { code: "retained.cancelled", message: "ordinary authority revoked",
      responsibility: "operation", retryability: "no" });
    if (activation.delivery) {
      this.#revokeDelivery(activation.delivery);
      for (const sibling of this.#activations.values()) if (sibling !== activation && sibling.delivery === activation.delivery) this.#cancel(sibling.id, error);
    }
  }
  #disconnect(error?: PdrError): Promise<void> {
    if (!this.#disconnectPromise) {
      // Publish the join handle before teardown invokes any synchronous
      // cancellation callbacks that could themselves request disconnect.
      let resolve!: () => void, reject!: (cause: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      this.#disconnectPromise = promise;
      void this.#disconnectOnce(error).then(resolve, reject);
    }
    return this.#disconnectPromise!;
  }
  async #disconnectOnce(error?: PdrError): Promise<void> {
    this.#terminalError = error;
    this.#closed = true; this.#generation++;
    this.#retirement?.close(); this.#revokeRetirement();
    this.#expiries?.clear("session-ended");
    this.#revokeDeliveries();
    this.#poll?.close();
    this.#state.close();
    this.#capabilities = undefined;
    this.#readyChannel.port1.close(); this.#readyChannel.port2.close();
    this.#turns.close();
    for (const activation of this.#activations.values()) this.#cancel(activation.id, error);
    const lease = this.#lease, connection = this.#connection, group = this.#channelGroup;
    this.#rawTerminal = undefined;
    this.#channelGroup = undefined; this.#groupPumps = []; this.#inputPump = undefined;
    const cleanup = (async () => { try { if (group) await group.release(); else await lease?.release(); } finally { await connection?.close(); } })();
    if (this.#outbound.size) {
      this.#stamp();
      void cleanup.then(() => this.#stamp(), cause => this.#stamp()).catch(() => undefined);
    } else await cleanup;
    this.#lease = undefined; this.#connection = undefined; this.#buffer = ""; this.#inputRanges.length = 0; this.#inputUtf8Bytes = 0;
    this.#discardDeferred(); this.#preparedEntry = undefined; this.#mailbox.clear();
    this.#messages.clear(); this.#taps.clear(); this.#waiting.clear();
    await this.#options.execution.close();
    if (this.#capture) { const capture = this.#capture; this.#capture = undefined; await capture.close(); }
    this.#publish({ kind: "connection-close", reason: error?.message ?? "session closed", ...(error ? { error } : {}) });
  }
}
