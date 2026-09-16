import { endianness } from "node:os";
import { createRequire } from "node:module";

import type {
  ByteChannel,
  CallOptions,
  ChannelId,
  ChannelLease,
  InputCustodySink,
  ChannelLeaseHolder,
  ChannelMode,
  Clock,
  ControlRequest,
  ControlResponse,
  DeviceConnection,
  DiagnosticRecord,
  DiagnosticTap,
  Disposable,
  PdrError,
  PhysicalDeviceIdentity,
  PlatformCauseSnapshot,
  ReceivedChunk,
  SerialLineParameters,
  SerialProtocolDuplex,
  SerialProfileLifecyclePolicy,
  TransportTermination,
  WriteReceipt,
} from "@protodriver/contracts";
import { DiagnosticTapFanout } from "@protodriver/core/diagnostics";
import { BoundedIngress, ReceiveTerminatedError } from "@protodriver/core/ingress";
import { ChannelLeaseConflictError } from "@protodriver/core/leases";
import { snapshotPlatformCause } from "@protodriver/core/limits";
import { RealClock } from "@protodriver/core/clock";
import {
  postTerminationSilenceMs,
  validateSerialProfilePolicy,
} from "@protodriver/core/serial-profile";
import { SerialPort } from "serialport";

// Load the POSIX exclusion primitive before any port can be opened. Resolving
// the native addon inside open() would lengthen the unavoidable open-to-ioctl
// interval on the first connection.
type Ioctl = (fd: number, request: number, argument?: Buffer) => number;
interface LoadedIoctl {
  readonly invoke: Ioctl;
  readonly moduleShape: "callable" | "object.ioctl";
  readonly selected: "package" | "explicit-addon";
}

const require = createRequire(import.meta.url);
let loadedPosixIoctl: LoadedIoctl | undefined;

function unwrapIoctl(
  module: unknown,
): Pick<LoadedIoctl, "invoke" | "moduleShape"> {
  if (typeof module === "function") {
    return { invoke: module as Ioctl, moduleShape: "callable" };
  }
  if (
    typeof module === "object"
    && module !== null
    && "ioctl" in module
    && typeof module.ioctl === "function"
  ) {
    return {
      invoke: module.ioctl as Ioctl,
      moduleShape: "object.ioctl",
    };
  }
  throw new TypeError(
    "selected ioctl addon exports neither a function nor an ioctl function",
  );
}

function platformIoctl(): Ioctl | undefined {
  if (process.platform === "win32") return undefined;
  // Portable evidence bundles may carry more than one platform's native
  // addon. The launcher selects a tuple-qualified binary rather than letting
  // Node load whichever build happened to occupy ioctl/build/Release. An
  // earlier macOS-arm64 bundle reached its target with a Linux-x64 ELF in
  // that path, so an implicit package lookup is not evidence of compatibility.
  if (loadedPosixIoctl === undefined) {
    const explicitAddon = process.env.PDR_IOCTL_NODE_PATH;
    loadedPosixIoctl = {
      ...unwrapIoctl(
        require(explicitAddon === undefined ? "ioctl" : explicitAddon),
      ),
      selected: explicitAddon === undefined ? "package" : "explicit-addon",
    };
  }
  return loadedPosixIoctl.invoke;
}

export interface SerialExclusionNativeSmoke {
  readonly required: boolean;
  readonly loaded?: boolean;
  readonly selected?: "package" | "explicit-addon";
  readonly moduleShape?: "callable" | "object.ioctl";
  readonly invocation?: "native-error";
  readonly platformCause?: PlatformCauseSnapshot;
  readonly status?: "not-verified-by-smoke";
  readonly reason?: string;
}

/**
 * Target-machine preflight for the POSIX exclusion primitive. The invalid file
 * descriptor cannot affect a real port; reaching the native EBADF proves that
 * the tuple-selected addon was both loaded and invoked through its actual ABI.
 */
export function smokeSerialExclusionNative(): SerialExclusionNativeSmoke {
  if (process.platform === "win32") {
    return {
      required: false,
      status: "not-verified-by-smoke",
      reason: "Windows cross-process exclusion is measured separately; smoke only loads the runtime and native binding",
    };
  }

  const ioctl = platformIoctl();
  if (ioctl === undefined || loadedPosixIoctl === undefined) {
    throw new Error("POSIX ioctl addon did not load");
  }
  try {
    // UINT32_MAX reaches the native addon as file descriptor -1. Request zero
    // is immaterial because the kernel rejects the descriptor first.
    ioctl(0xffff_ffff, 0);
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error(`selected ioctl addon was not callable: ${cause.message}`);
    }
    return {
      required: true,
      loaded: true,
      selected: loadedPosixIoctl.selected,
      moduleShape: loadedPosixIoctl.moduleShape,
      invocation: "native-error",
      platformCause: snapshotPlatformCause(
        typeof cause === "object" && cause !== null ? cause : String(cause),
      ),
    };
  }
  throw new Error("invalid-descriptor ioctl probe unexpectedly succeeded");
}

// The largest retained causal-platform-event-to-iterator span is 324.000 ms
// (Linux Web Serial read error to iterator ending). One additional observed
// span allows for scheduling jitter while keeping this arbitration well inside
// the matrix's 5,000 ms machine deadline. This wait applies only after
// serialport has already begun a non-local close; it is not a general I/O
// timeout.
export const SERIAL_DISCONNECT_ARBITRATION_MS = 648;
const INITIAL_DRAIN_POLL_MS = 2;
const DEFAULT_MAXIMUM_BUFFERED_BYTES = 4 * 1024 * 1024;
// Mirrors the type-only contracts package's host-resource envelope.
const DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const SERIAL_CAUSE_DETAIL_KEYS = [
  "errno",
  "syscall",
  "path",
  "disconnected",
] as const;

/** Target-side OS inventory used by the physical disconnect harness. */
export function listNodeSerialPorts(): ReturnType<typeof SerialPort.list> {
  return SerialPort.list();
}

export interface NodeSerialPlatformEvent {
  readonly kind: "error" | "close" | "disconnect-arbitration-timeout";
  readonly sequence: number;
  readonly tUs: number;
  readonly cause?: PlatformCauseSnapshot;
  /** True only when close() had been requested before this native event. */
  readonly localCloseInProgress?: boolean;
  /** Present when a non-local close failed to supply its promised close event. */
  readonly waitedMs?: number;
}

export interface NodeSerialOpenOptions {
  readonly path: string;
  readonly profileId: string;
  readonly modeId: string;
  readonly identity: PhysicalDeviceIdentity;
  readonly line: SerialLineParameters;
  readonly lifecycle: SerialProfileLifecyclePolicy;
  readonly protocolDuplex: SerialProtocolDuplex;
  readonly maximumBufferedBytes?: number;
  readonly maximumDiagnosticBytes?: number;
}

interface SerialPortLike {
  readonly isOpen: boolean;
  readonly port?: { readonly fd?: number | null };
  read(size?: number): string | Buffer | null;
  open(callback: (error: Error | null | undefined) => void): void;
  close(callback: (error: Error | null | undefined) => void): void;
  write(data: Buffer, callback: (error: Error | null | undefined) => void): boolean;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error" | "close", listener: (error?: Error | null) => void): this;
  off(event: "data", listener: (data: Buffer) => void): this;
  off(event: "error" | "close", listener: (error?: Error | null) => void): this;
}

export interface SerialPortFactoryOptions {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: SerialLineParameters["dataBits"];
  readonly stopBits: SerialLineParameters["stopBits"];
  readonly parity: SerialLineParameters["parity"];
  readonly rtscts: boolean;
  readonly xon: false;
  readonly xoff: false;
  readonly lock: true;
  readonly autoOpen: false;
}

export interface NodeSerialTransportOptions {
  readonly clock?: Clock;
  readonly createPort?: (options: SerialPortFactoryOptions) => SerialPortLike;
  readonly configureTermios?: (port: SerialPortLike) => Promise<void>;
  readonly enforceExclusive?: (port: SerialPortLike) => Promise<void>;
}

function pdrError(
  code: string,
  message: string,
  retryability: PdrError["retryability"],
  platformCause?: PlatformCauseSnapshot,
  responsibility: NonNullable<PdrError["responsibility"]> = "operation",
): PdrError {
  return {
    code,
    message,
    responsibility,
    retryability,
    ...(platformCause === undefined ? {} : { platformCause }),
  };
}

function errorObject(cause: object | string): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function errorCause(cause: unknown): object | string {
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null) return cause;
  return String(cause);
}

function snapshotSerialCause(cause: object | string): PlatformCauseSnapshot {
  return snapshotPlatformCause(cause, SERIAL_CAUSE_DETAIL_KEYS);
}

function looksHeld(cause: object | string): boolean {
  const error = errorObject(cause) as Error & { readonly code?: string };
  return error.code === "EBUSY"
    || /(?:cannot lock|resource temporarily unavailable|resource busy|access is denied)/i.test(
      error.message,
    );
}

function isDisconnectedCause(cause: object | string): boolean {
  return typeof cause === "object"
    && cause !== null
    && "disconnected" in cause
    && (cause as { readonly disconnected?: unknown }).disconnected === true;
}

export class SerialPortHeldError extends Error {
  readonly error: PdrError;
  readonly path: string;

  constructor(path: string, cause: object | string) {
    const platformCause = snapshotSerialCause(cause);
    const error = pdrError(
      "transport.port-held",
      `serial port ${path} is held by another context`,
      "after-recovery",
      platformCause,
      "host",
    );
    super(error.message);
    this.name = "SerialPortHeldError";
    this.error = error;
    this.path = path;
  }
}

export class SerialPortOpenError extends Error {
  readonly error: PdrError;

  constructor(path: string, cause: object | string) {
    const platformCause = snapshotSerialCause(cause);
    const error = pdrError(
      "transport.open-failed",
      `could not open serial port ${path}: ${errorObject(cause).message}`,
      "unknown",
      platformCause,
      "host",
    );
    super(error.message);
    this.name = "SerialPortOpenError";
    this.error = error;
  }
}

export class SerialHalfDuplexError extends Error {
  readonly error: PdrError;

  constructor(path: string) {
    const error = pdrError(
      "transport.half-duplex-conflict",
      `serial port ${path} cannot transmit while an authoritative read is outstanding`,
      "no",
    );
    super(error.message);
    this.name = "SerialHalfDuplexError";
    this.error = error;
  }
}

export class SerialConnectionClosedError extends Error {
  readonly termination: TransportTermination;

  constructor(termination: TransportTermination) {
    super(`serial connection terminated: ${termination.kind}`);
    this.name = "SerialConnectionClosedError";
    this.termination = termination;
  }
}

function openPort(port: SerialPortLike): Promise<void> {
  return new Promise((resolve, reject) => {
    port.open((error) => error === null || error === undefined ? resolve() : reject(error));
  });
}

function writePort(port: SerialPortLike, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (error) => error === null || error === undefined ? resolve() : reject(error));
  });
}

function closePort(port: SerialPortLike): Promise<void> {
  if (!port.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    port.close((error) => error === null || error === undefined ? resolve() : reject(error));
  });
}

async function inspectNativeTermios(port: SerialPortLike): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  if (process.platform === "linux") await readLinuxTermios(serialDescriptor(port));
}

async function readLinuxTermios(fd: number): Promise<void> {
  const TCGETS = 0x5401;
  const IXON = 0x400;
  const IXOFF = 0x1000;
  const ECHO = 0x8;
  const CRTSCTS = 0x80000000;
  const state = Buffer.alloc(64);
  const ioctl = platformIoctl();
  if (ioctl === undefined) throw new Error("TCGETS is unavailable on this platform");
  ioctl(fd, TCGETS, state);
  const read32 = endianness() === "LE"
    ? (offset: number) => state.readUInt32LE(offset)
    : (offset: number) => state.readUInt32BE(offset);
  const input = read32(0);
  const control = read32(8);
  const local = read32(12);
  if ((input & (IXON | IXOFF)) !== 0 || (control & CRTSCTS) !== 0 || (local & ECHO) !== 0) {
    throw new Error(
      "node-serialport did not establish the declared no-echo, no-flow-control termios state",
    );
  }
}

function serialDescriptor(port: SerialPortLike): number {
  const fd = port.port?.fd;
  if (!Number.isInteger(fd) || fd === null || fd === undefined || fd < 0) {
    throw new Error("node-serialport did not expose an open serial descriptor");
  }
  return fd;
}

export function serialExclusiveRequest(platform: NodeJS.Platform = process.platform): number | undefined {
  if (platform === "linux") return 0x540c;
  // Darwin: TIOCEXCL is _IO('t', 13), where IOC_VOID is 0x20000000.
  if (platform === "darwin") return 0x2000740d;
  return undefined;
}

async function enforcePlatformExclusive(
  port: SerialPortLike,
): Promise<void> {
  if (process.platform === "win32") {
    // The Windows binding opens serial handles exclusively; lock:false is not
    // supported there. The exclusive native open remains the ownership gate.
    return;
  }

  const request = serialExclusiveRequest();
  if (request === undefined) {
    throw new Error(`serial exclusion has no implementation for ${process.platform}`);
  }
  const fd = serialDescriptor(port);
  // ioctl is optional so Windows installs do not attempt to build a POSIX
  // addon. A POSIX host must have it: silently falling back recreates the
  // cross-process corruption this exclusion exists to prevent.
  const ioctl = platformIoctl();
  if (ioctl === undefined) throw new Error("TIOCEXCL is unavailable on this platform");
  ioctl(fd, request);
}

export async function drainSerialUntilQuiet(options: {
  readonly clock: Clock;
  readonly readAvailable: () => Uint8Array | undefined;
  readonly quietWindowMs: number;
  readonly maximumDiscardedBytes: number;
}): Promise<void> {
  let discardedBytes = 0;
  if (options.quietWindowMs === 0) {
    return;
  }
  let quietSinceUs = Math.floor(options.clock.monotonicUs());
  for (;;) {
    const bytes = options.readAvailable();
    const observedUs = Math.floor(options.clock.monotonicUs());
    if (bytes !== undefined && bytes.byteLength > 0) {
      if (discardedBytes + bytes.byteLength > options.maximumDiscardedBytes) {
        throw new Error(
          `initial serial drain exceeded ${options.maximumDiscardedBytes} discarded bytes`,
        );
      }
      discardedBytes += bytes.byteLength;
      quietSinceUs = observedUs;
      continue;
    }
    const quietForUs = observedUs - quietSinceUs;
    const requiredUs = options.quietWindowMs * 1_000;
    if (quietForUs >= requiredUs) {
      return;
    }
    await options.clock.sleep(Math.min(
      INITIAL_DRAIN_POLL_MS,
      (requiredUs - quietForUs) / 1_000,
    ));
  }
}

class NodeSerialLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;
  readonly holder: ChannelLeaseHolder;
  readonly #channel: NodeSerialChannel;
  #iterator: AsyncIterator<ReceivedChunk> | undefined;
  #released = false;
  #custodyBinding: { dispose(): void } | undefined;
  #invalidated = false;

  constructor(channel: NodeSerialChannel, holder: ChannelLeaseHolder) {
    this.#channel = channel;
    this.channelId = channel.id;
    this.mode = holder.mode;
    this.holder = holder;
  }

  incoming(_options?: CallOptions): AsyncIterable<ReceivedChunk> {
    this.#assertUsable();
    if (this.#iterator !== undefined) throw new Error("lease incoming() may only be acquired once");
    const inner = this.#channel.incoming()[Symbol.asyncIterator]();
    this.#iterator = inner;
    let claimed = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (claimed) throw new Error("lease incoming iterable already has an iterator");
        claimed = true;
        return {
          next: async () => {
            if (this.#invalidated) return inner.next();
            this.#assertUsable();
            this.#channel.beginAuthoritativeRead(this);
            try {
              return await inner.next();
            } finally {
              this.#channel.endAuthoritativeRead(this);
            }
          },
          return: async () => {
            await inner.return?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  bindInputCustody(sink: InputCustodySink): { dispose(): void } {
    this.#assertUsable();
    if (this.#custodyBinding) throw new Error("input.retirement.cut-already-bound");
    this.#custodyBinding = this.#channel.bindInputCustody(sink);
    return this.#custodyBinding;
  }

  write(data: Uint8Array, _options?: CallOptions): Promise<WriteReceipt> {
    this.#assertUsable();
    return this.#channel.write(this, data);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try { this.#custodyBinding?.dispose(); }
    finally {
      this.#custodyBinding = undefined;
      await this.#iterator?.return?.();
      this.#channel.release(this);
    }
  }

  invalidate(): void {
    // A non-local termination is not an ordinary lease release. Keeping the
    // ingress consumer attached lets its next() retain the typed terminal
    // cause even when the unplug lands between reads.
    this.#invalidated = true;
  }

  #assertUsable(): void {
    if (this.#released) throw new Error(`the ${this.mode} lease has been released`);
    this.#channel.assertUsable();
  }
}

interface PendingWrite {
  readonly requestedBytes: number;
  readonly resolve: (receipt: WriteReceipt) => void;
  settled: boolean;
}

class NodeSerialChannel implements ByteChannel {
  readonly id = "main" as ChannelId;
  readonly direction = "duplex" as const;
  readonly protocolDuplex: SerialProtocolDuplex;
  readonly #connection: NodeSerialConnection;
  readonly #clock: Clock;
  readonly #port: SerialPortLike;
  readonly #ingress: BoundedIngress;
  readonly #diagnostics: DiagnosticTapFanout;
  #lease: NodeSerialLease | undefined;
  #authoritativeReader: NodeSerialLease | undefined;
  #pendingWrite: PendingWrite | undefined;

  constructor(
    connection: NodeSerialConnection,
    clock: Clock,
    port: SerialPortLike,
    protocolDuplex: SerialProtocolDuplex,
    maximumBufferedBytes: number,
    maximumDiagnosticBytes: number,
  ) {
    this.#connection = connection;
    this.#clock = clock;
    this.#port = port;
    this.protocolDuplex = protocolDuplex;
    this.#diagnostics = new DiagnosticTapFanout(maximumDiagnosticBytes);
    this.#ingress = new BoundedIngress({
      channelId: this.id,
      hardLimitBytes: maximumBufferedBytes,
      clock,
      onTerminate: (termination) => this.#connection.terminateFromChannel(termination),
    });
  }

  acquire(mode: ChannelMode, _options?: CallOptions): Promise<ChannelLease> {
    this.assertUsable();
    if (this.#lease !== undefined) {
      return Promise.reject(new ChannelLeaseConflictError(mode, this.#lease.holder));
    }
    const holder: ChannelLeaseHolder = Object.freeze({
      channelId: this.id,
      mode,
      acquiredAtSequence: this.#clock.nextSequence(),
      acquiredAtMonotonicUs: Math.floor(this.#clock.monotonicUs()),
    });
    const lease = new NodeSerialLease(this, holder);
    this.#lease = lease;
    return Promise.resolve(lease);
  }

  observe(): DiagnosticTap {
    this.assertUsable();
    return this.#diagnostics.open();
  }

 incoming(): AsyncIterable<ReceivedChunk> {
    return this.#ingress.incoming();
  }

  bindInputCustody(sink: InputCustodySink): { dispose(): void } {
    return this.#ingress.bindInputCustody(sink);
  }

  receive(bytes: Uint8Array): void {
    if (!this.#connection.usable || bytes.byteLength === 0) return;
    const record = this.#diagnosticRecord("rx", bytes);
    this.#diagnostics.publish(record);
    this.#ingress.push(bytes);
  }

  beginAuthoritativeRead(lease: NodeSerialLease): void {
    this.assertUsable();
    if (lease.mode !== "raw-terminal" && this.protocolDuplex === "half-duplex"
      && this.#pendingWrite !== undefined) {
      throw new Error("cannot begin an authoritative read while a serial write is outstanding");
    }
    if (this.#authoritativeReader !== undefined) {
      throw new Error("a serial read is already outstanding");
    }
    this.#authoritativeReader = lease;
  }

  endAuthoritativeRead(lease: NodeSerialLease): void {
    if (this.#authoritativeReader === lease) this.#authoritativeReader = undefined;
  }

  write(lease: NodeSerialLease, data: Uint8Array): Promise<WriteReceipt> {
    this.assertUsable();
    if (lease.mode !== "raw-terminal" && this.protocolDuplex === "half-duplex"
      && this.#authoritativeReader !== undefined) {
      return Promise.reject(new SerialHalfDuplexError(this.#connection.path));
    }
    if (this.#pendingWrite !== undefined) {
      return Promise.reject(new Error("a serial write is already outstanding"));
    }
    const bytes = Buffer.from(data);
    return new Promise<WriteReceipt>((resolve) => {
      const pending: PendingWrite = { requestedBytes: bytes.byteLength, resolve, settled: false };
      this.#pendingWrite = pending;
      void writePort(this.#port, bytes).then(
        () => {
          if (pending.settled) return;
          pending.settled = true;
          this.#pendingWrite = undefined;
          this.#diagnostics.publish(this.#diagnosticRecord("tx", bytes));
          resolve({
            outcome: { kind: "accepted-by-platform" },
            requestedBytes: bytes.byteLength,
            atSequence: this.#clock.nextSequence(),
            taintsSession: false,
          });
        },
        (cause) => {
          if (!pending.settled) this.#settlePartial(pending, errorCause(cause));
        },
      );
    });
  }

  release(lease: NodeSerialLease): void {
    if (this.#lease === lease) this.#lease = undefined;
    this.endAuthoritativeRead(lease);
  }

  terminate(termination: TransportTermination, cause?: object | string): void {
    const pending = this.#pendingWrite;
    if (pending !== undefined && !pending.settled) {
      this.#settlePartial(pending, cause ?? `connection terminated: ${termination.kind}`);
    }
    if (termination.kind === "closed-by-host") {
      this.#ingress.discardAndClose();
      this.#diagnostics.close();
    } else {
      this.#ingress.discardAndTerminate(termination);
      this.#diagnostics.terminate(new ReceiveTerminatedError(termination));
    }
    this.#lease?.invalidate();
    this.#lease = undefined;
    this.#authoritativeReader = undefined;
  }

  assertUsable(): void {
    if (!this.#connection.usable) {
      throw new SerialConnectionClosedError(this.#connection.termination!);
    }
  }

  #settlePartial(pending: PendingWrite, cause: object | string): void {
    pending.settled = true;
    if (this.#pendingWrite === pending) this.#pendingWrite = undefined;
    pending.resolve({
      outcome: {
        kind: "may-be-partial",
        knownAcceptedBytes: 0,
        possiblyAcceptedBytesUpTo: pending.requestedBytes,
      },
      requestedBytes: pending.requestedBytes,
      atSequence: this.#clock.nextSequence(),
      platformCause: snapshotSerialCause(cause),
      taintsSession: true,
    });
  }

  #diagnosticRecord(direction: "tx" | "rx", bytes: Uint8Array): DiagnosticRecord {
    return {
      sequence: this.#clock.nextSequence(),
      tUs: Math.floor(this.#clock.monotonicUs()),
      direction,
      channelId: this.id,
      bytes,
    };
  }
}

export class NodeSerialConnection implements DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  readonly path: string;
  terminationEvidence: PlatformCauseSnapshot | undefined;
  /** Raw, ordered adapter observations retained for disconnect diagnostics. */
  readonly platformEvents: NodeSerialPlatformEvent[] = [];
  termination: TransportTermination | undefined;
  readonly #port: SerialPortLike;
  readonly #channel: NodeSerialChannel;
  readonly #clock: Clock;
  readonly #lifecycle: SerialProfileLifecyclePolicy;
  readonly #noteRecovery: (path: string, minimumMs: number) => void;
  readonly #waitForRecovery: (path: string) => Promise<void>;
  #resolveTermination!: (termination: TransportTermination) => void;
  readonly #onData: (data: Buffer) => void;
  readonly #onError: (error?: Error | null) => void;
  readonly #onClose: (error?: Error | null) => void;
  #hostClosing = false;
  #closePromise: Promise<void> | undefined;
  #disconnectArbitration: {
    readonly cause: object | string;
    readonly timer: Disposable;
  } | undefined;

  constructor(options: {
    readonly port: SerialPortLike;
    readonly clock: Clock;
    readonly open: NodeSerialOpenOptions;
    readonly lifecycle: SerialProfileLifecyclePolicy;
    readonly noteRecovery: (path: string, minimumMs: number) => void;
    readonly waitForRecovery: (path: string) => Promise<void>;
  }) {
    this.#port = options.port;
    this.#clock = options.clock;
    this.path = options.open.path;
    this.identity = options.open.identity;
    this.modeId = options.open.modeId;
    this.profileId = options.open.profileId;
    this.#lifecycle = options.lifecycle;
    this.#noteRecovery = options.noteRecovery;
    this.#waitForRecovery = options.waitForRecovery;
    this.terminated = new Promise((resolve) => { this.#resolveTermination = resolve; });
    this.#channel = new NodeSerialChannel(
      this,
      this.#clock,
      this.#port,
      options.open.protocolDuplex,
      options.open.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
      options.open.maximumDiagnosticBytes ?? DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES,
    );
    this.channels = Object.freeze([this.#channel]);
    this.#onData = (data) => this.#channel.receive(data);
    // The native routes are platform- and operation-dependent. Linux commonly
    // reports a disconnected error followed by close. Windows can report only
    // an ordinary error while a write is pending. An unhandled EventEmitter
    // error is process-fatal, so every non-local error must terminate here.
    this.#onError = (error) => {
      if (error !== undefined && error !== null && !this.#hostClosing) {
        const cause = snapshotSerialCause(error);
        this.terminationEvidence = cause;
        this.platformEvents.push({
          kind: "error",
          sequence: this.#clock.nextSequence(),
          tUs: Math.floor(this.#clock.monotonicUs()),
          cause,
        });
        if (!this.usable) return;
        if (isDisconnectedCause(error)) {
          this.#finish({ kind: "device-lost" }, error);
        } else if (!this.#port.isOpen) {
          // @serialport/stream sets closing before it reports a rejected native
          // write. The bare poller error may carry no errno or disconnected
          // marker, but the ensuing non-local close carries DisconnectedError.
          // Let that stronger evidence win without interpreting error text.
          this.#awaitDisconnectClose(error);
        } else {
          this.#finishPlatformError(error);
        }
      }
    };
    this.#onClose = (error) => {
      const cause = error === undefined || error === null ? undefined : snapshotSerialCause(error);
      this.platformEvents.push({
        kind: "close",
        sequence: this.#clock.nextSequence(),
        tUs: Math.floor(this.#clock.monotonicUs()),
        localCloseInProgress: this.#hostClosing,
        ...(cause === undefined ? {} : { cause }),
      });
      if (this.#hostClosing) this.#finish({ kind: "closed-by-host" });
      else this.#finish({ kind: "device-lost" }, error ?? undefined);
    };
    this.#port.on("data", this.#onData);
    this.#port.on("error", this.#onError);
    this.#port.on("close", this.#onClose);
  }

  get usable(): boolean {
    return this.termination === undefined;
  }

  async control(_request: ControlRequest, _options?: CallOptions): Promise<ControlResponse> {
    if (!this.usable) throw new SerialConnectionClosedError(this.termination!);
    return { settled: "unsupported", atSequence: this.#clock.nextSequence() };
  }

  invalidate(termination: TransportTermination): void {
    if (!this.usable) return;
    this.#finish(termination);
    // Keep the native handle, and therefore kernel/platform exclusion, until
    // the recovery silence has elapsed. The typed termination is observable
    // immediately; physical release remains owned by this connection.
    void this.close().catch(() => {});
  }

  close(_reason?: string): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  terminateFromChannel(termination: TransportTermination): void {
    if (!this.usable) return;
    this.#finish(termination);
    void this.close().catch(() => {});
  }

  async #close(): Promise<void> {
    if (!this.usable) {
      await this.#waitForRecovery(this.path);
      await closePort(this.#port).catch(() => {});
      return;
    }
    if (this.usable) {
      this.#hostClosing = true;
      try {
        await closePort(this.#port);
      } catch (cause) {
        const normalized = errorCause(cause);
        if (this.usable) this.#finish({ kind: "fault", error: pdrError(
          "transport.close-failed",
          errorObject(normalized).message,
          "unknown",
          snapshotSerialCause(normalized),
        ) }, normalized);
      }
      if (this.usable) this.#finish({ kind: "closed-by-host" });
    }
    await this.#waitForRecovery(this.path);
  }

  #awaitDisconnectClose(cause: object | string): void {
    if (this.#disconnectArbitration !== undefined) return;
    const pending = {
      cause,
      timer: this.#clock.timer(SERIAL_DISCONNECT_ARBITRATION_MS, () => {
        if (!this.usable || this.#disconnectArbitration !== pending) return;
        this.#disconnectArbitration = undefined;
        this.platformEvents.push({
          kind: "disconnect-arbitration-timeout",
          sequence: this.#clock.nextSequence(),
          tUs: Math.floor(this.#clock.monotonicUs()),
          waitedMs: SERIAL_DISCONNECT_ARBITRATION_MS,
          cause: snapshotSerialCause(cause),
        });
        this.#finishPlatformError(cause);
      }),
    };
    this.#disconnectArbitration = pending;
  }

  #finishPlatformError(cause: object | string): void {
    const error = errorObject(cause);
    const snapshot = snapshotSerialCause(cause);
    this.#finish({
      kind: "fault",
      error: pdrError(
        "transport.platform-error",
        `serial port ${this.path} failed: ${error.message}`,
        "after-reconnect",
        snapshot,
      ),
    }, cause);
  }

  #finish(termination: TransportTermination, cause?: object | string): void {
    if (!this.usable) return;
    this.#disconnectArbitration?.timer.dispose();
    this.#disconnectArbitration = undefined;
    this.termination = termination;
    if (cause !== undefined) this.terminationEvidence = snapshotSerialCause(cause);
    const silenceMs = postTerminationSilenceMs(
      this.#lifecycle,
      termination.kind === "closed-by-host" ? "closed-by-host" : "abnormal",
    );
    if (silenceMs > 0) this.#noteRecovery(this.path, silenceMs);
    this.#channel.terminate(termination, cause);
    this.#port.off("data", this.#onData);
    // Keep the error listener for the lifetime of the native port object.
    // @serialport/stream can emit close from _disconnected(), then deliver the
    // write callback error on the stream. Removing the listener at close makes
    // that legitimate second signal an unhandled EventEmitter error and kills
    // the process. The listener records late non-local errors but cannot alter
    // an already-settled termination.
    this.#port.off("close", this.#onClose);
    this.#resolveTermination(termination);
  }
}

export class NodeSerialTransport {
  readonly #clock: Clock;
  readonly #createPort: (options: SerialPortFactoryOptions) => SerialPortLike;
  readonly #configureTermios: NonNullable<NodeSerialTransportOptions["configureTermios"]>;
  readonly #enforceExclusive: NonNullable<NodeSerialTransportOptions["enforceExclusive"]>;
  readonly #recoveryNotBeforeUs = new Map<string, number>();
  readonly #openingPaths = new Set<string>();

  constructor(options: NodeSerialTransportOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
    this.#createPort = options.createPort ?? ((serialOptions) => new SerialPort(serialOptions));
    this.#configureTermios = options.configureTermios ?? inspectNativeTermios;
    this.#enforceExclusive = options.enforceExclusive ?? enforcePlatformExclusive;
  }

  async open(options: NodeSerialOpenOptions): Promise<NodeSerialConnection> {
    validateSerialProfilePolicy(options.line, options.lifecycle, options.protocolDuplex);
    if (this.#openingPaths.has(options.path)) {
      throw new SerialPortHeldError(options.path, "the same context is already opening this path");
    }
    this.#openingPaths.add(options.path);
    try {
      await this.#waitForRecovery(options.path);
      const portOptions: SerialPortFactoryOptions = {
        path: options.path,
        baudRate: options.line.baudRate,
        dataBits: options.line.dataBits,
        stopBits: options.line.stopBits,
        parity: options.line.parity,
        rtscts: options.line.flowControl === "hardware",
        xon: false,
        xoff: false,
        lock: true,
        autoOpen: false,
      };
      const port = this.#createPort(portOptions);
      let openingError: Error | undefined;
      let openingClosed = false;
      const onOpeningError = (error?: Error | null) => {
        if (error !== undefined && error !== null) openingError = error;
      };
      const onOpeningClose = (error?: Error | null) => {
        openingClosed = true;
        if (error !== undefined && error !== null) openingError = error;
      };
      const removeOpeningListeners = (): void => {
        port.off("error", onOpeningError);
        port.off("close", onOpeningClose);
      };
      port.on("error", onOpeningError);
      port.on("close", onOpeningClose);
      try {
        await openPort(port);
      } catch (cause) {
        removeOpeningListeners();
        const normalized = errorCause(cause);
        if (looksHeld(normalized)) throw new SerialPortHeldError(options.path, normalized);
        throw new SerialPortOpenError(options.path, normalized);
      }
      if (openingError !== undefined || openingClosed) {
        const cause = openingError ?? "serial port closed while opening";
        removeOpeningListeners();
        await this.#abandonOpenedPort(
          port,
          options.path,
          abnormalSilenceMs(options.lifecycle),
        );
        throw new SerialPortOpenError(options.path, cause);
      }

      // node-serialport applies its native termios state inside openPort().
      // Kernel exclusion and inspection happen through the same fd.
      try {
        await this.#enforceExclusive(port);
      } catch (cause) {
        removeOpeningListeners();
        await this.#abandonOpenedPort(
          port,
          options.path,
          abnormalSilenceMs(options.lifecycle),
        );
        throw new SerialPortOpenError(options.path, errorCause(cause));
      }

      try {
        await this.#configureTermios(port);
      } catch (cause) {
        removeOpeningListeners();
        await this.#abandonOpenedPort(
          port,
          options.path,
          abnormalSilenceMs(options.lifecycle),
        );
        throw new SerialPortOpenError(options.path, errorCause(cause));
      }
      try {
        await drainSerialUntilQuiet({
          clock: this.#clock,
          readAvailable: () => {
            const value = port.read();
            if (value === null) return undefined;
            if (typeof value === "string") return Buffer.from(value);
            return value;
          },
          quietWindowMs: options.lifecycle.openingDrainQuietMs,
          maximumDiscardedBytes: options.maximumBufferedBytes
            ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
        });
      } catch (cause) {
        removeOpeningListeners();
        await this.#abandonOpenedPort(
          port,
          options.path,
          abnormalSilenceMs(options.lifecycle),
        );
        throw new SerialPortOpenError(options.path, errorCause(cause));
      } finally {
        removeOpeningListeners();
      }

      if (openingError !== undefined || openingClosed) {
        const cause = openingError ?? "serial port closed during initial drain";
        await this.#abandonOpenedPort(
          port,
          options.path,
          abnormalSilenceMs(options.lifecycle),
        );
        throw new SerialPortOpenError(options.path, cause);
      }

      return new NodeSerialConnection({
        port,
        clock: this.#clock,
        open: options,
        lifecycle: options.lifecycle,
        noteRecovery: (path, minimumMs) => this.#noteRecovery(path, minimumMs),
        waitForRecovery: (path) => this.#waitForRecovery(path),
      });
    } finally {
      this.#openingPaths.delete(options.path);
    }
  }

  #noteRecovery(path: string, minimumMs: number): void {
    const deadline = Math.floor(this.#clock.monotonicUs()) + minimumMs * 1_000;
    this.#recoveryNotBeforeUs.set(path, Math.max(
      deadline,
      this.#recoveryNotBeforeUs.get(path) ?? 0,
    ));
  }

  async #abandonOpenedPort(
    port: SerialPortLike,
    path: string,
    minimumMs: number,
  ): Promise<void> {
    await closePort(port).catch(() => {});
    this.#noteRecovery(path, minimumMs);
    await this.#waitForRecovery(path);
  }

  async #waitForRecovery(path: string): Promise<void> {
    const deadline = this.#recoveryNotBeforeUs.get(path);
    if (deadline === undefined) return;
    const remainingUs = deadline - Math.floor(this.#clock.monotonicUs());
    if (remainingUs > 0) await this.#clock.sleep(remainingUs / 1_000);
    if (Math.floor(this.#clock.monotonicUs()) >= deadline) {
      this.#recoveryNotBeforeUs.delete(path);
    }
  }
}

function abnormalSilenceMs(lifecycle: SerialProfileLifecyclePolicy): number {
  return postTerminationSilenceMs(lifecycle, "abnormal");
}
