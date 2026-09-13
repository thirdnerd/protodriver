import type { Brand } from "./brand.js";
import type { PhysicalDeviceIdentity, UsbSpeed } from "./acquisition.js";
import type { PdrError, PlatformCauseSnapshot, PublicValue } from "./values.js";
import type { DiagnosticTap } from "./capture.js";
import type { Clock } from "./clock.js";

export type ChannelId = Brand<string, "ChannelId">;

export type SerialDataBits = 7 | 8;
export type SerialParity = "none" | "even" | "odd";
export type SerialStopBits = 1 | 2;
export type SerialFlowControl = "none" | "hardware";
export type SerialProtocolDuplex = "half-duplex" | "full-duplex";

/** Externally defined serial line domain; no device-derived value is implicit. */
export interface SerialLineParameters {
  readonly baudRate: number;
  readonly dataBits: SerialDataBits;
  readonly parity: SerialParity;
  readonly stopBits: SerialStopBits;
  readonly flowControl: SerialFlowControl;
}

export interface PostTerminationSilencePolicy {
  readonly minimumMs: number;
  readonly afterAbnormalTermination: boolean;
  readonly afterModeExit: boolean;
}

export interface SerialProfileLifecyclePolicy {
  /** Zero preserves all octets received after open. */
  readonly openingDrainQuietMs: number;
  readonly postTerminationSilence: PostTerminationSilencePolicy;
}

/** USB endpoint kinds demonstrated by bulk transports. Control remains out of band. */
export type UsbEndpointTransferType = "bulk" | "interrupt";
export type UsbEndpointSpeed = Extract<UsbSpeed, "full" | "high">;
export type UsbMaximumPacketBytesBySpeed = Readonly<
  Partial<Record<UsbEndpointSpeed, number>>
>;

export interface UsbInputEndpointPolicy {
  /** Endpoint zero belongs to the control pipe and is never a byte channel. */
  readonly endpointNumber: number;
  readonly transferType: UsbEndpointTransferType;
  readonly maximumPacketBytes: UsbMaximumPacketBytesBySpeed;
}

export interface UsbOutputEndpointPolicy {
  /** Endpoint zero belongs to the control pipe and is never a byte channel. */
  readonly endpointNumber: number;
  readonly transferType: UsbEndpointTransferType;
  readonly maximumPacketBytes: UsbMaximumPacketBytesBySpeed;
}

export interface UsbChannelPolicy {
  readonly id: ChannelId;
  readonly input: UsbInputEndpointPolicy | null;
  readonly output: UsbOutputEndpointPolicy | null;
}

/** Transport-owned USB profile shape; the manifest embeds this directly. */
export interface UsbProfilePolicy {
  readonly kind: "usb";
  readonly configurationValue: number | "preserve-active";
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly channels: readonly [UsbChannelPolicy, ...UsbChannelPolicy[]];
}

export type UsbProfilePolicyDiagnosticCode =
  | "transport.usb.invalid-profile"
  | "transport.usb.invalid-channel"
  | "transport.usb.duplicate-channel-id"
  | "transport.usb.invalid-endpoint"
  | "transport.usb.illegal-packet-size"
  | "transport.usb.empty-packet-size-record"
  | "transport.usb.missing-negotiated-speed"
  | "transport.usb.no-common-packet-size-speed"
  | "transport.usb.duplicate-endpoint-address"
  | "transport.usb.endpoint-descriptor-mismatch";

export interface UsbProfilePolicyDiagnostic {
  readonly code: UsbProfilePolicyDiagnosticCode;
  readonly declarationPath: string;
  readonly message: string;
}

export type SerialProfilePolicyDiagnosticCode =
  | "transport.serial.invalid-line-parameters"
  | "transport.serial.invalid-protocol-duplex"
  | "transport.serial.invalid-opening-drain"
  | "transport.serial.invalid-post-termination-silence";

export interface SerialProfilePolicyDiagnostic {
  readonly code: SerialProfilePolicyDiagnosticCode;
  readonly declarationPath: string;
  readonly message: string;
}

/**
 * EVERYTHING HERE IS A LIVE OBJECT and none of it crosses a boundary. These
 * interfaces live on the session's side — in the worker, in the browser.
 * That is the whole reason `DeviceSessionClient` exists: decoded results
 * cross, and the objects below do not.
 *
 * They are in this package so the compiler can catch one leaking into a
 * message rather than relying on a prose-only boundary.
 */

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Why a connection ended. Distinguishing these is what lets a session
 * decide between reconnecting, faulting, and reporting — an undifferentiated
 * "it broke" forces the same response to a pulled cable and a policy denial.
 */
export type TransportTermination =
  | { readonly kind: "closed-by-host" }
  | { readonly kind: "closed-by-device" }
  | { readonly kind: "device-lost" }
  | { readonly kind: "permission-revoked" }
  | {
      readonly kind: "receive-overflow";
      readonly limitBytes: number;
      readonly channel: ChannelId;
    }
  | { readonly kind: "fault"; readonly error: PdrError };

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Most platform APIs report only that a write resolved, rejected, or that
 * the connection vanished — not how many bytes reached an OS buffer, a
 * driver, a controller, or the device. An adapter returning an exact count
 * in that situation invents a number everything above it then trusts.
 */
export type WriteOutcome =
  | { readonly kind: "accepted-by-platform" }
  | { readonly kind: "rejected"; readonly error: PdrError }
  | {
      readonly kind: "may-be-partial";
      readonly knownAcceptedBytes: number;
      readonly possiblyAcceptedBytesUpTo: number;
    };

export interface WriteReceipt {
  readonly outcome: WriteOutcome;
  readonly requestedBytes: number;
  readonly atSequence: number;
  /** Clone-safe evidence from the platform; the live native error never crosses. */
  readonly platformCause?: PlatformCauseSnapshot;
  /**
   * Under ordered matching a `may-be-partial` TAINTS the session: the
   * device may hold a partial frame and will read the next bytes as its
   * continuation. In a transfer it blocks `confirmedOffset` from advancing.
   */
  readonly taintsSession: boolean;
}

/* ------------------------------------------------------------------ *
 * Channels and leases
 * ------------------------------------------------------------------ */

export type ChannelMode = "protocol" | "raw-read" | "raw-write" | "raw-terminal";

/** Human-actionable identity of the lease currently excluding an acquisition. */
export interface ChannelLeaseHolder {
  readonly channelId: ChannelId;
  readonly mode: ChannelMode;
  readonly acquiredAtSequence: number;
  readonly acquiredAtMonotonicUs: number;
}

export interface ReceivedChunk {
  readonly bytes: Uint8Array;
  readonly atSequence: number;
  readonly tUs: number;
}

/** Host-only B9 hook, installed before the first authoritative read. The
 * adapter calls this synchronously at the original stamp, including for its
 * already queued input. Missing support is not an empty custody inventory. */
export interface InputCustodySink {
  /** Host-only domain attestation. Equal timestamps from two clocks do not
   * establish a shared observation sequence. Never crosses a worker wire. */
  readonly clock?: Clock;
  /** Optional complete-cut receipt. Only a host-certified ingress may issue
   * it, after its synchronous queued census. It never crosses an authored wire. */
  attested?(receipt: object): void;
  /** The optional ticket stays with the native node until it is discarded.
   * Dequeue transfers custody to the host, including an already-settled next()
   * promise: it is NOT discard. The host releases that custody on receipt. */
  observed(sequence: number, bytes: number): void | { discarded(): void };
  revoked(reason: "released" | "terminated"): void;
}

export interface CallOptions {
  readonly timeoutUs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Everything touching an authoritative byte stream acquires that channel's
 * lease, and each channel admits one lease at a time. One logical protocol
 * session may hold several distinct channel leases as one all-or-nothing set.
 * The lease is the single exclusion authority for protocol work, raw access,
 * and host-owned input custody; consumers do not coordinate by convention or
 * invent independent locks around the same native channel.
 */
export interface ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;

  bindInputCustody?(sink: InputCustodySink): { dispose(): void };

  incoming(options?: CallOptions): AsyncIterable<ReceivedChunk>;
  write(data: Uint8Array, options?: CallOptions): Promise<WriteReceipt>;

  release(): Promise<void>;
}

export interface ByteChannel {
  readonly id: ChannelId;
  readonly direction: "in" | "out" | "duplex";
  /** Serial profile concurrency policy; null for direction-separated channels. */
  readonly protocolDuplex: SerialProtocolDuplex | null;

  /** Throws a typed error naming the holder if a lease exists. */
  acquire(mode: ChannelMode, options?: CallOptions): Promise<ChannelLease>;

  /**
   * OUTSIDE the lease deliberately: lossy and non-authoritative by
   * construction, which is exactly why a live hex view can run while the
   * protocol runtime holds the channel.
   */
  observe(): DiagnosticTap;
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

/**
 * REPLACEABLE. A firmware update replaces this two or three times inside
 * one session while one operation, one lock, one budget and one capture
 * continue uninterrupted.
 */
export interface DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];

  /** Resolves when the connection ends, for any reason. Never rejects. */
  readonly terminated: Promise<TransportTermination>;

  /**
   * Control-plane operations that are not byte traffic: DTR/RTS, baud
   * changes, USB control transfers. Commonly how a device is told to reboot
   * into its bootloader.
   */
  control(request: ControlRequest, options?: CallOptions): Promise<ControlResponse>;

  /**
   * Invalidates every live handle with the supplied non-local termination.
   * Used when continuity can no longer be trusted, without pretending the
   * host performed an ordinary clean close.
   */
  invalidate(termination: TransportTermination): void;

  close(reason?: string): Promise<void>;
}

export interface ControlRequest {
  readonly kind: string;
  readonly parameters: { readonly [name: string]: PublicValue };
  readonly payload?: Uint8Array;
}

export interface ControlResponse {
  readonly settled: "completed" | "unsupported" | "failed";
  readonly payload?: Uint8Array;
  readonly error?: PdrError;
  readonly atSequence: number;
}
