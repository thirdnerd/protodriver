/**
 * Compile-time proof that the wire types are structured-clone-safe.
 *
 * WHY THIS FILE EXISTS
 *
 * A plain `tsc --noEmit` once accepted an un-cloneable RPC field: adding
 *
 *     readonly impossibleCallback?: () => void;
 *
 * to a SessionRpcRequest variant compiled clean. TypeScript checks declared
 * types for internal consistency; without this guard, nothing tells it that
 * SessionRpcMessage has a restricted value domain.
 *
 * This file makes the claim real. It is also SELF-TESTED: the negative
 * controls at the bottom fail to compile if the predicate stops rejecting
 * what it is supposed to reject. A guard nobody tested is how the original
 * gap survived review, so the guard tests itself.
 *
 * BOUNDS. The predicate is depth-limited (see Depth below) because the
 * value domains are recursive by definition — PublicValue contains arrays
 * of PublicValue. At the limit it yields `true` rather than recursing
 * forever, so this check is sound for shallow violations and incomplete
 * for ones buried deeper than the limit. That incompleteness is precisely
 * why the runtime `structuredClone` conformance tests in ../test exist;
 * neither check subsumes the other.
 */

import type {
  CheckpointAssurance,
  ClientLeasePolicy,
  DeviceSessionClient,
  ResumeTransferRequest,
  SessionRpcMessage,
  SessionRpcRequest,
} from "./session.js";
import type {
  RawTerminalExitResult,
  RawTerminalHandle,
} from "./raw-terminal.js";
import type {
  BrokerCall,
  BrokerCallOptions,
  HostByteSink,
  HostByteSource,
  ResourceBrokerClient,
  ResourceDescriptor,
  ResourceReadResult,
  ResourceRegistrar,
  ResourceRpcRequest,
  ResourceRpcResponse,
  ResourceScope,
} from "./resources.js";
import type {
  CaptureDestinationRegistrar,
  CaptureLine,
  CaptureRpcRequest,
  CaptureRpcResponse,
  CaptureSummary,
  DiagnosticBatch,
  DiagnosticTap,
  HostCaptureDestination,
} from "./capture.js";
import type {
  AcquisitionService,
  GrantDescriptor,
  PermissionBroker,
  PhysicalDeviceIdentity,
  SerializableCandidate,
} from "./acquisition.js";
import type { ByteChannel, ChannelLease, DeviceConnection } from "./transport.js";
import type { Clock } from "./clock.js";
import type { PdrError, PublicValue, RpcValue } from "./values.js";

/* ------------------------------------------------------------------ *
 * The value domain
 * ------------------------------------------------------------------ */

/**
 * Carried by value through structuredClone, in the subset this project uses.
 *
 * `PublicValue` and `RpcValue` are included ON PURPOSE, and the reason is
 * worth stating because it looks like a shortcut. Both are CLOSED
 * clone-safe domains: a type matching either one has, by construction, only
 * clone-safe members all the way down. Admitting them as leaves is
 * therefore sound rather than a bypass — and a type that gains a function
 * member stops matching them and falls through to the structural walk
 * below, where it is caught.
 *
 * It also keeps the predicate finite. Both domains are recursive
 * (`readonly PublicValue[]`), and walking them structurally makes the
 * instantiation count exponential in the depth limit for no added
 * information. What they actually contain is verified against the real
 * platform primitive in ../test/clone.test.mjs, on values rather than on
 * declarations.
 */
type CloneLeaf =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | ArrayBuffer
  | Uint8Array
  | Date
  | PublicValue
  | RpcValue;

/**
 * Explicitly rejected. Named individually rather than inferred, because a
 * reader needs to see what the boundary refuses.
 *
 * MessagePort is transferable but not cloneable BY VALUE, which is the
 * property being asserted here.
 */
type NeverCloneable =
  // eslint-disable-next-line @typescript-eslint/ban-types
  | Function
  | symbol
  | Promise<unknown>
  | AbortSignal
  | AbortController
  | MessagePort
  | ReadableStream<unknown>
  | WritableStream<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>;

/* ------------------------------------------------------------------ *
 * The predicate
 * ------------------------------------------------------------------ */

// Six is ample now that the recursive value domains are leaves: nothing
// remaining in the wire types nests anywhere near that deep. Raising it
// costs instantiations exponentially and buys nothing.
type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type Prev = [never, 0, 1, 2, 3, 4, 5];

/** True only when every member of the union is true. */
type AllTrue<U> = [U] extends [true] ? true : false;

type CloneSafe<T, D extends Depth = 6> = [T] extends [never]
  ? true
  : D extends 0
    ? true
    : CloneSafeDistributed<T, D>;

// T is naked here on purpose: the conditional distributes over unions, so
// each member of a union is judged separately and the results are unioned.
type CloneSafeDistributed<T, D extends Depth> = T extends NeverCloneable
  ? false
  : T extends CloneLeaf
    ? true
    : T extends ReadonlySet<infer E>
      ? CloneSafe<E, Prev[D]>
      : T extends ReadonlyMap<infer K, infer V>
        ? AllTrue<CloneSafe<K, Prev[D]> | CloneSafe<V, Prev[D]>>
        : T extends readonly (infer E)[]
          ? CloneSafe<E, Prev[D]>
          : T extends object
            ? AllTrue<{ [K in keyof T]-?: CloneSafe<T[K], Prev[D]> }[keyof T]>
            : false;

/** Non-distributive wrapper: a union is safe only if every member is. */
export type IsCloneSafe<T> = [CloneSafe<T>] extends [true] ? true : false;

/** Fails to compile with "false does not satisfy the constraint true". */
type Assert<T extends true> = T;

/* ------------------------------------------------------------------ *
 * The assertions this file exists for
 * ------------------------------------------------------------------ */

// PublicValue and RpcValue are deliberately NOT asserted here. They are
// admitted as leaves above, so asserting them would be circular and would
// read as evidence while proving nothing. Their contents are covered by the
// runtime tests instead, which is the honest place for a closed recursive
// domain.
export type _SessionRpcMessageIsCloneSafe = Assert<IsCloneSafe<SessionRpcMessage>>;
export type _PdrErrorIsCloneSafe = Assert<IsCloneSafe<PdrError>>;
export type _ClientLeasePolicyIsCloneSafe = Assert<IsCloneSafe<ClientLeasePolicy>>;
export type _CheckpointAssuranceIsCloneSafe = Assert<IsCloneSafe<CheckpointAssurance>>;
export type _ResumeTransferRequestIsCloneSafe = Assert<IsCloneSafe<ResumeTransferRequest>>;
export type _RawTerminalHandleIsCloneSafe = Assert<IsCloneSafe<RawTerminalHandle>>;
export type _RawTerminalExitResultIsCloneSafe = Assert<IsCloneSafe<RawTerminalExitResult>>;

// The broker's wire surface. `BrokerCallOptions` is deliberately ABSENT:
// it carries an AbortSignal, is local-facade only, and asserting it here
// would be asserting the opposite of what it is for. `ResourceRegistrar`,
// `HostByteSource`, `HostByteSink`, `HostCaptureDestination` and
// `DiagnosticTap` are absent for the same reason — they are live objects,
// deliberately, and each one is a compile error away from the wire.
export type _BrokerCallIsCloneSafe = Assert<IsCloneSafe<BrokerCall>>;
export type _ResourceDescriptorIsCloneSafe = Assert<IsCloneSafe<ResourceDescriptor>>;
export type _ResourceReadResultIsCloneSafe = Assert<IsCloneSafe<ResourceReadResult>>;
export type _ResourceScopeIsCloneSafe = Assert<IsCloneSafe<ResourceScope>>;
export type _ResourceRpcRequestIsCloneSafe = Assert<IsCloneSafe<ResourceRpcRequest>>;
export type _ResourceRpcResponseIsCloneSafe = Assert<IsCloneSafe<ResourceRpcResponse>>;

// Acquisition. These cross by construction — a grant is obtained on the
// main thread and used in the worker.
export type _GrantDescriptorIsCloneSafe = Assert<IsCloneSafe<GrantDescriptor>>;
export type _SerializableCandidateIsCloneSafe = Assert<IsCloneSafe<SerializableCandidate>>;
export type _PhysicalDeviceIdentityIsCloneSafe = Assert<IsCloneSafe<PhysicalDeviceIdentity>>;

// Capture: the destination-control protocol, the diagnostic batches, and
// the on-disk record union.
export type _CaptureRpcRequestIsCloneSafe = Assert<IsCloneSafe<CaptureRpcRequest>>;
export type _CaptureRpcResponseIsCloneSafe = Assert<IsCloneSafe<CaptureRpcResponse>>;
export type _CaptureSummaryIsCloneSafe = Assert<IsCloneSafe<CaptureSummary>>;
export type _DiagnosticBatchIsCloneSafe = Assert<IsCloneSafe<DiagnosticBatch>>;
export type _CaptureLineIsCloneSafe = Assert<IsCloneSafe<CaptureLine>>;

/* ------------------------------------------------------------------ *
 * Negative controls — the guard testing itself
 *
 * Each asserts that the predicate REJECTS something. If a change makes
 * CloneSafe vacuously true, these stop compiling. Without them, a broken
 * predicate and a correct one look identical from the outside, which is
 * the exact failure this file was written to correct.
 * ------------------------------------------------------------------ */

// NOT wrapped in Assert here: inside a generic alias, IsCloneSafe<T> cannot
// resolve while T is still a parameter, so the conditional widens to
// `boolean` and fails `extends true` at the DECLARATION. Asserting at each
// use site, where T is concrete, is what makes it evaluate.
type Rejects<T> = IsCloneSafe<T> extends false ? true : false;

export type _RejectsBareFunction = Assert<Rejects<() => void>>;
export type _RejectsFunctionProperty = Assert<Rejects<{ readonly onDone: () => void }>>;
export type _RejectsOptionalFunction = Assert<Rejects<{ readonly onDone?: () => void }>>;
export type _RejectsAbortSignal = Assert<Rejects<{ readonly signal: AbortSignal }>>;
export type _RejectsPromise = Assert<Rejects<{ readonly pending: Promise<number> }>>;
export type _RejectsSymbol = Assert<Rejects<{ readonly tag: symbol }>>;
export type _RejectsNestedFunction = Assert<Rejects<{ readonly a: { readonly b: readonly { readonly c: () => void }[] } }>>;
export type _RejectsUnionWithOneBadMember = Assert<Rejects<{ readonly ok: string } | { readonly bad: () => void }>>;
export type _RejectsMethodBearingObject = Assert<Rejects<{ read(into: Uint8Array): Promise<number> }>>;

// Tied to the concrete open-raw-terminal request: this negative control fails
// if method-bearing objects become admissible on that RPC boundary.
type UnsafeRawTerminalOpenRequest = Extract<
  SessionRpcRequest,
  { readonly kind: "open-raw-terminal" }
> & {
  readonly terminal: { write(bytes: Uint8Array): Promise<number> };
};
export type _RejectsMethodBearingRawTerminalRequest = Assert<Rejects<UnsafeRawTerminalOpenRequest>>;

/* ------------------------------------------------------------------ *
 * The live objects, asserted UNSENDABLE.
 *
 * These are the types that actually leaked. Each one was, at some point in
 * this design, placed directly into something that crosses a boundary:
 * HostCaptureDestination into RecorderOptions, HostByteSource into the
 * interface documented as "the broker IS the boundary". Asserting they are
 * NOT clone-safe means adding one to a message is now a compile error at
 * the message, and stripping the methods off one here is a compile error
 * on these lines.
 * ------------------------------------------------------------------ */

export type _HostByteSourceIsNotSendable = Assert<Rejects<HostByteSource>>;
export type _HostByteSinkIsNotSendable = Assert<Rejects<HostByteSink>>;
export type _ResourceRegistrarIsNotSendable = Assert<Rejects<ResourceRegistrar>>;
export type _HostCaptureDestinationIsNotSendable = Assert<Rejects<HostCaptureDestination>>;
export type _CaptureDestinationRegistrarIsNotSendable = Assert<Rejects<CaptureDestinationRegistrar>>;
export type _DiagnosticTapIsNotSendable = Assert<Rejects<DiagnosticTap>>;
export type _PermissionBrokerIsNotSendable = Assert<Rejects<PermissionBroker>>;
export type _AcquisitionServiceIsNotSendable = Assert<Rejects<AcquisitionService>>;
export type _ClockIsNotSendable = Assert<Rejects<Clock>>;
export type _DeviceConnectionIsNotSendable = Assert<Rejects<DeviceConnection>>;
export type _ByteChannelIsNotSendable = Assert<Rejects<ByteChannel>>;
export type _ChannelLeaseIsNotSendable = Assert<Rejects<ChannelLease>>;
export type _BrokerCallOptionsIsNotSendable = Assert<Rejects<BrokerCallOptions>>;
export type _ResourceBrokerClientIsNotSendable = Assert<Rejects<ResourceBrokerClient>>;
export type _DeviceSessionClientIsNotSendable = Assert<Rejects<DeviceSessionClient>>;
