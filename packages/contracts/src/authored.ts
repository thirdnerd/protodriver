import type { TypeDescriptor } from "./values.js";
import type { SerialLineParameters, SerialProfileLifecyclePolicy, SerialProtocolDuplex, UsbProfilePolicy } from "./transport.js";

/** Inert physical requests. Only the host can turn a request into a grant. */
export type AuthoredConnectionProfile = {
  readonly modes: readonly string[];
  readonly acquisitionFilters: readonly { readonly transport: "serial"; readonly vendorId?: number; readonly productId?: number }[];
  readonly transport: SerialLineParameters & { readonly kind: "serial" };
  readonly channels: readonly [{ readonly id: string; readonly protocolDuplex: SerialProtocolDuplex }];
  readonly lifecycle: SerialProfileLifecyclePolicy;
} | {
  readonly modes: readonly string[];
  readonly acquisitionFilters: readonly { readonly transport: "usb"; readonly vendorId?: number; readonly productId?: number; readonly usbClass?: number }[];
  readonly requiredProductName?: string;
  readonly transport: UsbProfilePolicy;
};

/** One immutable cut, not permission to consume or to reuse a wire token. */
export interface AuthoredInputRetirement {
  readonly kind: "input-retirement";
  readonly basisId: string;
  readonly generation: number;
  readonly fromSequence: number;
  readonly beforeSequence: number;
  readonly sequence: number;
  readonly retired: boolean;
}

/** Host evidence, never a clock handle or reusable effect capability. */
export interface AuthoredClockObservation {
  readonly basisId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly elapsedUs: number;
}

/** Sequence and elapsedUs are zero until the expiry event actually occurs. */
export interface AuthoredExpiryObservation extends AuthoredClockObservation {
  readonly kind: "expiry";
  readonly id: string;
  readonly status: "reserved" | "armed" | "expired";
}

/** Public authored value declaration; no protocol steps or executable objects. */
export interface AuthoredValueType {
  readonly kind: TypeDescriptor["kind"] | "null" | "variant";
  readonly widthBits?: 8 | 16 | 32 | 64;
  readonly signed?: boolean;
  readonly members?: readonly string[];
  readonly fields?: Readonly<Record<string, AuthoredValueType>>;
  /** Inert presentation only; keys must name declared record fields. */
  readonly fieldLabels?: Readonly<Record<string, string>>;
  readonly item?: AuthoredValueType;
  readonly variants?: Readonly<Record<string, AuthoredValueType>>;
  readonly unit?: { readonly kind: "fixed"; readonly id: string };
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
}
export type AuthoredOperationArgument = (AuthoredValueType | AuthoredSourceArgument) & {
  readonly label?: string;
  readonly description?: string;
};
export interface AuthoredOperation {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly binding: string;
  readonly arguments: Readonly<Record<string, AuthoredOperationArgument>>;
  readonly result: { readonly kind: "none" } | { readonly kind: "value"; readonly type: AuthoredValueType } | AuthoredResourceResult;
  readonly risk: "read-only" | "changes-state" | "destructive" | "firmware";
  readonly repeatability: "not-repeatable" | "safe-to-repeat";
  readonly locks: readonly string[];
  readonly availability: { readonly modes: readonly string[]; readonly profiles: readonly string[] };
  readonly requires: readonly string[];
  readonly writeVia?: string;
  readonly releaseAfterIdleMs?: number;
  readonly reentry?: { readonly binding: string; readonly requires: readonly string[] };
  /** Optional common durable-transfer service, not protocol control flow. */
  readonly transfer?: {
    readonly sourceArgument: string;
    readonly sourceRange?: {
      readonly offset: number | { readonly argument: string };
      readonly length: number | { readonly argument: string };
    };
    readonly targetOffset: number;
    readonly targetLength: number;
    readonly resumeBinding: string;
    readonly finalization: "repeatable" | "not-repeatable";
    /** Complete encoded carrier, including overhead; default 256, maximum 65536. */
    readonly maximumCarrierBytes?: number;
    /** Opt into host-fixed source-byte grants; no authored quantum. */
    readonly segmented?: true;
  };
  readonly cleanup?: {
    readonly binding: string;
    readonly writeVia?: string;
    readonly requires: readonly string[];
    readonly maximumMilliseconds: number;
    readonly maximumLuaFuel: number;
    readonly maximumWork: number;
  };
}
/** A byte source supplies immutable bytes; a stream source an operation-local handle. */
export type AuthoredSourceArgument = {
  readonly kind: "byte-source";
  readonly minimumBytes: number;
  readonly maximumBytes: number;
} | {
  readonly kind: "stream-source";
  readonly minimumBytes: number;
  readonly maximumBytes: number;
};
export interface AuthoredResourceResult {
  readonly kind: "file" | "resource";
  readonly direction: "out";
  readonly content: string;
  readonly mediaType: string;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly suggestedExtension?: string;
  readonly streamed?: { readonly subject: string; readonly offset: number | { readonly argument: string }; readonly length: number | { readonly argument: string } };
}
export interface AuthoredStateCell {
  readonly type: AuthoredValueType;
  /** Null disables age expiry, not explicit or connection/session invalidation. */
  readonly freshForMs: number | null;
  /** Optional validity inputs, not computation expressions. Requires null age. */
  readonly dependsOn?: readonly string[];
  /** An ordinary declared operation, never a private out-of-band Lua call. */
  readonly refresh?: string | AuthoredPollRefresh;
}
export interface AuthoredPollRefresh {
  readonly kind: "poll";
  readonly mode: string;
  readonly operation: string;
  readonly intervalMs: number;
  /** Device constraint requesting cadence below an ordinary host minimum. */
  readonly maximumInterTransactionGapMs?: number;
  readonly failureBackoffMs: number;
  readonly suspendWhileLocksHeld: readonly string[];
  readonly timing?: { readonly kind: "idle-reset"; readonly activity: "foreground-lifecycle" };
}
/** Host policy, never an authored description field. One grant per session. */
export interface AuthoredPollPolicy {
  readonly burst: number;
  readonly refillEveryMs: number;
  readonly minimumIntervalMs: number;
  readonly maximumPlans: number;
}
export interface AuthoredHandler {
  readonly id: string;
  readonly binding: string;
  readonly acceptHandoff?: string;
  readonly authorizeWrite?: string;
  readonly inputEvidence?: "consumed-ranges";
  readonly event: { readonly kind: "channel-input"; readonly channelId: string };
  readonly maximumConcurrent: number;
  readonly locks: readonly string[];
  readonly requires: readonly string[];
}
export interface AuthoredDescription {
  readonly apiVersion: "device/v2";
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly modes: readonly string[];
  readonly modePresentation?: Readonly<Record<string, { readonly label?: string; readonly description?: string }>>;
  readonly profiles: readonly string[];
  readonly connectionProfiles?: Readonly<Record<string, AuthoredConnectionProfile>>;
  /** Optional atomic protocol groups, keyed by profile; values name physical channels. */
  readonly channelRoles?: Readonly<Record<string, AuthoredChannelRoles>>;
  readonly operations: readonly AuthoredOperation[];
  readonly invalidation?: string;
  /** Called with immutable host-selected { modeId, profileId }, then the local effect facade. */
  readonly entry?: { readonly binding: string; readonly locks: readonly string[]; readonly requires: readonly string[]; readonly handoffTo?: string; readonly inputEvidence?: "consumed-ranges" };
  readonly state?: Readonly<Record<string, AuthoredStateCell>>;
  readonly maintenance?: readonly AuthoredPollRefresh[];
  readonly handlers?: readonly AuthoredHandler[];
  readonly mailboxes?: readonly string[];
}
export interface AuthoredChannelRoles { readonly request: string; readonly response: string; readonly event: string }
