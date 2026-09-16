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

const DEFAULT_MAXIMUM_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

export interface WebSerialPortInfo {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

export interface WebSerialPortLike extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  readonly connected?: boolean;
  getInfo(): WebSerialPortInfo;
  open(options: {
    readonly baudRate: number;
    readonly dataBits: SerialLineParameters["dataBits"];
    readonly stopBits: SerialLineParameters["stopBits"];
    readonly parity: SerialLineParameters["parity"];
    readonly flowControl: SerialLineParameters["flowControl"];
    readonly bufferSize: number;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSerialPlatformEvent {
  readonly kind: "disconnect-event" | "read-eof" | "read-error" | "write-error";
  readonly sequence: number;
  readonly tUs: number;
  readonly cause?: PlatformCauseSnapshot;
}

export interface BrowserSerialOpenOptions {
  readonly port: WebSerialPortLike;
  readonly profileId: string;
  readonly modeId: string;
  readonly identity: PhysicalDeviceIdentity;
  readonly line: SerialLineParameters;
  readonly lifecycle: SerialProfileLifecyclePolicy;
  readonly protocolDuplex: SerialProtocolDuplex;
  readonly bufferSize?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumDiagnosticBytes?: number;
  /** Override only when acquisition can name one physical port more narrowly. */
  readonly contextLockName?: string;
}

export interface BrowserLockManagerLike {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

export interface BrowserSerialTransportOptions {
  readonly clock?: Clock;
  readonly lockManager?: BrowserLockManagerLike | false;
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

function causeSnapshot(cause: unknown): PlatformCauseSnapshot {
  return snapshotPlatformCause(
    typeof cause === "object" && cause !== null ? cause : String(cause),
  );
}

export class BrowserSerialPortHeldError extends Error {
  readonly error: PdrError;

  constructor(cause: unknown) {
    const error = pdrError(
      "transport.port-held",
      "serial port is held by another browser tab or context",
      "after-recovery",
      causeSnapshot(cause),
      "host",
    );
    super(error.message);
    this.name = "BrowserSerialPortHeldError";
    this.error = error;
  }
}

export class BrowserSerialOpenError extends Error {
  readonly error: PdrError;

  constructor(cause: unknown) {
    const error = pdrError(
      "transport.open-failed",
      `could not open serial port: ${cause instanceof Error ? cause.message : String(cause)}; `
        + "Web Serial did not report whether another process holds it",
      "unknown",
      causeSnapshot(cause),
      "host",
    );
    super(error.message);
    this.name = "BrowserSerialOpenError";
    this.error = error;
  }
}

export class BrowserSerialHalfDuplexError extends Error {
  readonly error: PdrError;

  constructor() {
    const error = pdrError(
      "transport.half-duplex-conflict",
      "serial port cannot transmit while an authoritative read is outstanding",
      "no",
    );
    super(error.message);
    this.name = "BrowserSerialHalfDuplexError";
    this.error = error;
  }
}

export class BrowserSerialConnectionClosedError extends Error {
  readonly termination: TransportTermination;

  constructor(termination: TransportTermination) {
    super(`browser serial connection terminated: ${termination.kind}`);
    this.name = "BrowserSerialConnectionClosedError";
    this.termination = termination;
  }
}

export async function drainBrowserSerialUntilQuiet(options: {
  readonly port: WebSerialPortLike;
  readonly clock: Clock;
  readonly quietWindowMs: number;
  readonly maximumDiscardedBytes: number;
}): Promise<void> {
  let discardedBytes = 0;
  if (options.quietWindowMs === 0) {
    return;
  }

  for (;;) {
    const readable = options.port.readable;
    if (readable === null) throw new Error("serial readable stream ended during initial drain");
    const reader = readable.getReader();
    const abort = new AbortController();
    const read = reader.read().then(
      (value) => ({ kind: "read" as const, value }),
      (cause: unknown) => ({ kind: "read-error" as const, cause }),
    );
    const quiet = options.clock.sleep(options.quietWindowMs, abort.signal).then(
      () => ({ kind: "quiet" as const }),
      () => ({ kind: "cancelled" as const }),
    );
    const result = await Promise.race([read, quiet]);
    if (result.kind === "quiet") {
      // Releasing a lock with a pending read interrupts that read without
      // cancelling the stream. Bytes arriving later remain for the live pump.
      reader.releaseLock();
      await read;
      return;
    }
    abort.abort();
    await quiet;
    reader.releaseLock();
    if (result.kind === "read-error") throw result.cause;
    if (result.kind === "cancelled") continue;
    if (result.value.done) throw new Error("serial readable stream ended during initial drain");
    const bytes = result.value.value;
    if (bytes.byteLength === 0) continue;
    if (discardedBytes + bytes.byteLength > options.maximumDiscardedBytes) {
      throw new Error(
        `initial browser serial drain exceeded ${options.maximumDiscardedBytes} discarded bytes`,
      );
    }
    discardedBytes += bytes.byteLength;
  }
}

class BrowserSerialLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;
  readonly holder: ChannelLeaseHolder;
  readonly #channel: BrowserSerialChannel;
  #iterator: AsyncIterator<ReceivedChunk> | undefined;
  #released = false;
  #custodyBinding: { dispose(): void } | undefined;
  #invalidated = false;

  constructor(channel: BrowserSerialChannel, holder: ChannelLeaseHolder) {
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
    // Preserve the ingress consumer after a non-local termination so the
    // iterator reports ReceiveTerminatedError even between active reads.
    this.#invalidated = true;
  }

  #assertUsable(): void {
    if (this.#released) throw new Error(`the ${this.mode} lease has been released`);
    this.#channel.assertUsable();
  }
}

class BrowserSerialChannel implements ByteChannel {
  readonly id = "main" as ChannelId;
  readonly direction = "duplex" as const;
  readonly protocolDuplex: SerialProtocolDuplex;
  readonly #connection: BrowserSerialConnection;
  readonly #clock: Clock;
  readonly #port: WebSerialPortLike;
  readonly #ingress: BoundedIngress;
  readonly #diagnostics: DiagnosticTapFanout;
  #lease: BrowserSerialLease | undefined;
  #authoritativeReader: BrowserSerialLease | undefined;
  #writeOutstanding = false;

  constructor(
    connection: BrowserSerialConnection,
    clock: Clock,
    port: WebSerialPortLike,
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
    const lease = new BrowserSerialLease(this, holder);
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
    const copy = Uint8Array.from(bytes);
    this.#diagnostics.publish(this.#diagnosticRecord("rx", copy));
    this.#ingress.push(copy);
  }

  beginAuthoritativeRead(lease: BrowserSerialLease): void {
    this.assertUsable();
    if (lease.mode !== "raw-terminal" && this.protocolDuplex === "half-duplex"
      && this.#writeOutstanding) {
      throw new Error("cannot read while a serial write is outstanding");
    }
    if (this.#authoritativeReader !== undefined) throw new Error("a serial read is already outstanding");
    this.#authoritativeReader = lease;
  }

  endAuthoritativeRead(lease: BrowserSerialLease): void {
    if (this.#authoritativeReader === lease) this.#authoritativeReader = undefined;
  }

  async write(lease: BrowserSerialLease, data: Uint8Array): Promise<WriteReceipt> {
    this.assertUsable();
    if (lease.mode !== "raw-terminal" && this.protocolDuplex === "half-duplex"
      && this.#authoritativeReader !== undefined) {
      throw new BrowserSerialHalfDuplexError();
    }
    if (this.#writeOutstanding) throw new Error("a browser serial write is already outstanding");
    const writable = this.#port.writable;
    if (writable === null) throw new BrowserSerialConnectionClosedError(this.#connection.termination!);
    const bytes = Uint8Array.from(data);
    this.#writeOutstanding = true;
    const writer = writable.getWriter();
    try {
      await writer.write(bytes);
      this.#diagnostics.publish(this.#diagnosticRecord("tx", bytes));
      return {
        outcome: { kind: "accepted-by-platform" },
        requestedBytes: bytes.byteLength,
        atSequence: this.#clock.nextSequence(),
        taintsSession: false,
      };
    } catch (cause) {
      const receipt: WriteReceipt = {
        outcome: {
          kind: "may-be-partial",
          knownAcceptedBytes: 0,
          possiblyAcceptedBytesUpTo: bytes.byteLength,
        },
        requestedBytes: bytes.byteLength,
        atSequence: this.#clock.nextSequence(),
        platformCause: causeSnapshot(cause),
        taintsSession: true,
      };
      this.#connection.failFromStream(cause, "write-error");
      return receipt;
    } finally {
      writer.releaseLock();
      this.#writeOutstanding = false;
    }
  }

  release(lease: BrowserSerialLease): void {
    if (this.#lease === lease) this.#lease = undefined;
    this.endAuthoritativeRead(lease);
  }

  terminate(termination: TransportTermination): void {
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
      throw new BrowserSerialConnectionClosedError(this.#connection.termination!);
    }
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

export class BrowserSerialConnection implements DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  termination: TransportTermination | undefined;
  terminationEvidence: PlatformCauseSnapshot | undefined;
  /** Ordered Web Serial observations retained verbatim as clone-safe snapshots. */
  readonly platformEvents: BrowserSerialPlatformEvent[] = [];
  readonly #port: WebSerialPortLike;
  readonly #clock: Clock;
  readonly #channel: BrowserSerialChannel;
  readonly #lifecycle: SerialProfileLifecyclePolicy;
  readonly #contextLock: BrowserContextLock | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #pump: Promise<void> | undefined;
  #releasePromise: Promise<void> | undefined;
  #recoveryPromise: Promise<void> | undefined;
  #postTerminationSilenceMs = 0;
  #resolveTermination!: (termination: TransportTermination) => void;
  #hostClosing = false;
  #closePromise: Promise<void> | undefined;
  readonly #onDisconnect: () => void;

  constructor(options: {
    readonly port: WebSerialPortLike;
    readonly clock: Clock;
    readonly open: BrowserSerialOpenOptions;
    readonly lifecycle: SerialProfileLifecyclePolicy;
    readonly contextLock: BrowserContextLock | undefined;
  }) {
    this.#port = options.port;
    this.#clock = options.clock;
    this.identity = options.open.identity;
    this.modeId = options.open.modeId;
    this.profileId = options.open.profileId;
    this.#lifecycle = options.lifecycle;
    this.#contextLock = options.contextLock;
    this.terminated = new Promise((resolve) => { this.#resolveTermination = resolve; });
    this.#channel = new BrowserSerialChannel(
      this,
      this.#clock,
      this.#port,
      options.open.protocolDuplex,
      options.open.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
      options.open.maximumDiagnosticBytes ?? DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES,
    );
    this.channels = Object.freeze([this.#channel]);
    this.#onDisconnect = () => {
      this.#recordPlatformEvent("disconnect-event");
      this.#finish({ kind: "device-lost" });
    };
    this.#port.addEventListener("disconnect", this.#onDisconnect);
    this.#startPump();
  }

  get usable(): boolean {
    return this.termination === undefined;
  }

  async control(_request: ControlRequest, _options?: CallOptions): Promise<ControlResponse> {
    if (!this.usable) throw new BrowserSerialConnectionClosedError(this.termination!);
    return { settled: "unsupported", atSequence: this.#clock.nextSequence() };
  }

  invalidate(termination: TransportTermination): void {
    if (!this.usable) return;
    this.#finish(termination);
    // Keep both the Web Serial handle and the origin lock until recovery has
    // elapsed. The termination is still delivered at the probe boundary.
    void this.#ensurePortReleased(true);
  }

  close(_reason?: string): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  terminateFromChannel(termination: TransportTermination): void {
    this.invalidate(termination);
  }

  failFromStream(
    cause: unknown,
    kind: "read-error" | "write-error" = "read-error",
  ): void {
    if (this.#hostClosing) return;
    const snapshot = causeSnapshot(cause);
    this.terminationEvidence = snapshot;
    this.#recordPlatformEvent(kind, snapshot);
    if (!this.usable) return;
    this.#finish({ kind: "device-lost" });
    void this.#ensurePortReleased();
  }

  async #close(): Promise<void> {
    const hostInitiated = this.usable;
    if (hostInitiated) {
      this.#hostClosing = true;
    }
    try {
      await this.#ensurePortReleased();
      if (hostInitiated && this.usable) {
        this.#finish({ kind: "closed-by-host" });
      }
    } catch (cause) {
      this.terminationEvidence = causeSnapshot(cause);
      if (hostInitiated && this.usable) {
        this.#finish({
          kind: "fault",
          error: pdrError(
            "transport.close-failed",
            cause instanceof Error ? cause.message : String(cause),
            "unknown",
            this.terminationEvidence,
          ),
        });
      }
    }
    await this.#waitForRecovery();
  }

  #ensurePortReleased(afterRecovery = false): Promise<void> {
    this.#releasePromise ??= afterRecovery
      ? this.#waitForRecovery().then(() => this.#releasePort())
      : this.#releasePort();
    return this.#releasePromise;
  }

  #waitForRecovery(): Promise<void> {
    this.#recoveryPromise ??= this.#postTerminationSilenceMs > 0
      ? this.#clock.sleep(this.#postTerminationSilenceMs)
      : Promise.resolve();
    return this.#recoveryPromise;
  }

  #startPump(): void {
    const readable = this.#port.readable;
    if (readable === null) {
      this.failFromStream(new Error("serial readable stream is unavailable"));
      return;
    }
    this.#reader = readable.getReader();
    this.#pump = this.#readLoop(this.#reader);
  }

  async #readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        this.#channel.receive(result.value);
      }
      if (!this.#hostClosing && this.usable) {
        this.#recordPlatformEvent("read-eof");
        this.#finish({ kind: "closed-by-device" });
      }
    } catch (cause) {
      if (!this.#hostClosing) {
        const snapshot = causeSnapshot(cause);
        this.terminationEvidence = snapshot;
        this.#recordPlatformEvent("read-error", snapshot);
        if (this.usable) {
          this.#finish({ kind: "device-lost" });
          void this.#ensurePortReleased();
        }
      }
    } finally {
      reader.releaseLock();
      if (this.#reader === reader) this.#reader = undefined;
    }
  }

  async #releasePort(): Promise<void> {
    try {
      const reader = this.#reader;
      if (reader !== undefined) await reader.cancel().catch(() => {});
      await this.#pump?.catch(() => {});
      if (this.#port.readable !== null || this.#port.writable !== null) {
        await this.#port.close();
      }
    } finally {
      await this.#contextLock?.release();
    }
  }

  #finish(termination: TransportTermination): void {
    if (!this.usable) return;
    this.termination = termination;
    this.#postTerminationSilenceMs = postTerminationSilenceMs(
      this.#lifecycle,
      termination.kind === "closed-by-host" ? "closed-by-host" : "abnormal",
    );
    void this.#waitForRecovery();
    this.#channel.terminate(termination);
    this.#port.removeEventListener("disconnect", this.#onDisconnect);
    this.#resolveTermination(termination);
  }

  #recordPlatformEvent(
    kind: BrowserSerialPlatformEvent["kind"],
    cause?: PlatformCauseSnapshot,
  ): void {
    this.platformEvents.push({
      kind,
      sequence: this.#clock.nextSequence(),
      tUs: Math.floor(this.#clock.monotonicUs()),
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class BrowserSerialTransport {
  readonly #clock: Clock;
  readonly #lockManager: BrowserLockManagerLike | undefined;

  constructor(options: BrowserSerialTransportOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
    this.#lockManager = options.lockManager === false
      ? undefined
      : options.lockManager ?? browserLockManager();
  }

  async open(options: BrowserSerialOpenOptions): Promise<BrowserSerialConnection> {
    validateSerialProfilePolicy(options.line, options.lifecycle, options.protocolDuplex);
    if (options.port.readable !== null || options.port.writable !== null) {
      throw new BrowserSerialPortHeldError(new DOMException("port is already open", "InvalidStateError"));
    }
    const contextLock = await BrowserContextLock.acquire(
      this.#lockManager,
      options.contextLockName ?? defaultContextLockName(options.identity),
    );
    const serialOptions = {
      baudRate: options.line.baudRate,
      dataBits: options.line.dataBits,
      stopBits: options.line.stopBits,
      parity: options.line.parity,
      flowControl: options.line.flowControl,
      bufferSize: options.bufferSize ?? 64 * 1024,
    };
    try {
      await options.port.open(serialOptions);
    } catch (cause) {
      await contextLock?.release();
      if (isHeldOpenFailure(cause)) throw new BrowserSerialPortHeldError(cause);
      throw new BrowserSerialOpenError(cause);
    }
    try {
      await drainBrowserSerialUntilQuiet({
        port: options.port,
        clock: this.#clock,
        quietWindowMs: options.lifecycle.openingDrainQuietMs,
        maximumDiscardedBytes: options.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
      });
      return new BrowserSerialConnection({
        port: options.port,
        clock: this.#clock,
        open: options,
        lifecycle: options.lifecycle,
        contextLock,
      });
    } catch (cause) {
      await options.port.close().catch(() => {});
      await contextLock?.release();
      const silenceMs = postTerminationSilenceMs(options.lifecycle, "abnormal");
      if (silenceMs > 0) await this.#clock.sleep(silenceMs);
      throw new BrowserSerialOpenError(cause);
    }
  }
}

class BrowserContextLock {
  readonly #releaseLock: () => void;
  readonly #request: Promise<void>;
  #released = false;

  private constructor(releaseLock: () => void, request: Promise<void>) {
    this.#releaseLock = releaseLock;
    this.#request = request;
  }

  static async acquire(
    manager: BrowserLockManagerLike | undefined,
    name: string,
  ): Promise<BrowserContextLock | undefined> {
    if (manager === undefined) return undefined;
    let signalEntered!: (acquired: boolean) => void;
    let signalRelease!: () => void;
    const entered = new Promise<boolean>((resolve) => { signalEntered = resolve; });
    const released = new Promise<void>((resolve) => { signalRelease = resolve; });
    const request = manager.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      signalEntered(lock !== null);
      if (lock !== null) await released;
    });
    if (!(await entered)) {
      await request;
      throw new BrowserSerialPortHeldError(
        new DOMException(`browser context lock ${name} is held`, "InvalidStateError"),
      );
    }
    return new BrowserContextLock(signalRelease, request);
  }

  async release(): Promise<void> {
    if (this.#released) return this.#request;
    this.#released = true;
    this.#releaseLock();
    await this.#request;
  }
}

function browserLockManager(): BrowserLockManagerLike | undefined {
  const locks = (globalThis.navigator as Navigator & {
    readonly locks?: BrowserLockManagerLike;
  } | undefined)?.locks;
  return locks;
}

function defaultContextLockName(identity: PhysicalDeviceIdentity): string {
  const vendor = identity.vendorId?.toString(16).padStart(4, "0") ?? "unknown";
  const product = identity.productId?.toString(16).padStart(4, "0") ?? "unknown";
  return `protodriver.serial.${vendor}.${product}`;
}

function isHeldOpenFailure(cause: unknown): boolean {
  if (!(cause instanceof DOMException)) return false;
  // This names only state the adapter can establish. Web Serial collapses
  // operating-system open failures into NetworkError, which cannot prove a
  // competing process is the cause.
  return cause.name === "InvalidStateError";
}
