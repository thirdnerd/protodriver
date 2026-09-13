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
  ReceivedChunk,
  TransportTermination,
  UsbProfilePolicy,
  WriteReceipt,
} from "@protodriver/contracts";
import { DEFAULT_HOST_RESOURCE_LIMITS as DEFAULT_LIMITS } from "@protodriver/contracts/limits";
import { RealClock } from "@protodriver/core/clock";
import { DiagnosticTapFanout } from "@protodriver/core/diagnostics";
import { BoundedIngress, ReceiveTerminatedError } from "@protodriver/core/ingress";
import { ChannelLeaseConflictError } from "@protodriver/core/leases";
import { snapshotPlatformCause } from "@protodriver/core/limits";
import { parseUsbControlRequest, type ParsedUsbControlRequest } from "@protodriver/core/usb-control";
import {
  nativeUsbInRequestBytes,
  UsbProfilePolicyError,
  validateUsbProfilePolicy,
  type UsbProfileDescriptorEvidence,
  type ValidatedUsbEndpoint,
} from "@protodriver/core/usb-profile";

const USB_REQUEST_GET_INTERFACE = 0x0a;
const WEB_USB_BULK_INPUT_CONCURRENCY = 8;

export type WebUsbTransferStatus = "ok" | "stall" | "babble";

export interface WebUsbEndpointLike {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
  readonly packetSize: number;
}

export interface WebUsbAlternateInterfaceLike {
  readonly alternateSetting: number;
  readonly endpoints: readonly WebUsbEndpointLike[];
}

export interface WebUsbInterfaceLike {
  readonly interfaceNumber: number;
  readonly claimed: boolean;
  readonly alternate: WebUsbAlternateInterfaceLike;
  readonly alternates: readonly WebUsbAlternateInterfaceLike[];
}

export interface WebUsbConfigurationLike {
  readonly configurationValue: number;
  readonly interfaces: readonly WebUsbInterfaceLike[];
}

export interface WebUsbInTransferResultLike {
  readonly status: WebUsbTransferStatus;
  readonly data?: DataView;
}

export interface WebUsbOutTransferResultLike {
  readonly status: WebUsbTransferStatus;
  readonly bytesWritten: number;
}

export interface WebUsbControlTransferParametersLike {
  readonly requestType: "standard" | "class" | "vendor";
  readonly recipient: "device" | "interface" | "endpoint" | "other";
  readonly request: number;
  readonly value: number;
  readonly index: number;
}

export interface WebUsbDeviceLike {
  readonly opened: boolean;
  readonly configuration: WebUsbConfigurationLike | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<WebUsbInTransferResultLike>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<WebUsbOutTransferResultLike>;
  controlTransferIn(
    setup: WebUsbControlTransferParametersLike,
    length: number,
  ): Promise<WebUsbInTransferResultLike>;
  controlTransferOut(
    setup: WebUsbControlTransferParametersLike,
    data?: BufferSource,
  ): Promise<WebUsbOutTransferResultLike>;
}

export interface WebUsbDisconnectEventLike extends Event {
  readonly device: WebUsbDeviceLike;
}

export interface WebUsbDisconnectSourceLike {
  addEventListener(type: "disconnect", listener: (event: WebUsbDisconnectEventLike) => void): void;
  removeEventListener(type: "disconnect", listener: (event: WebUsbDisconnectEventLike) => void): void;
}

export interface BrowserUsbOpenOptions {
  readonly device: WebUsbDeviceLike;
  readonly disconnectSource?: WebUsbDisconnectSourceLike;
  readonly profileId: string;
  readonly modeId: string;
  readonly identity: PhysicalDeviceIdentity;
  readonly profile: UsbProfilePolicy;
  readonly requiredProductName?: string;
  /** Declared codec frame ceiling; absent only when no declaration exists. */
  readonly declaredMaximumFrameBytes?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumDiagnosticBytes?: number;
}

export interface BrowserUsbTransportOptions {
  readonly clock?: Clock;
}

export class BrowserUsbOpenError extends Error {
  readonly error: PdrError;

  constructor(code: string, message: string, cause?: unknown) {
    const error = pdrError(code, message, "unknown", cause);
    super(error.message);
    this.name = "BrowserUsbOpenError";
    this.error = error;
  }
}

export class BrowserUsbConnectionClosedError extends Error {
  readonly termination: TransportTermination | undefined;

  constructor(termination?: TransportTermination) {
    super(termination === undefined
      ? "browser USB connection is closing"
      : `browser USB connection terminated: ${termination.kind}`);
    this.name = "BrowserUsbConnectionClosedError";
    this.termination = termination;
  }
}

class BrowserUsbLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;
  readonly holder: ChannelLeaseHolder;
  readonly #channel: BrowserUsbChannel;
  #iterator: AsyncIterator<ReceivedChunk> | undefined;
  #released = false;
  #custodyBinding: { dispose(): void } | undefined;
  #invalidated = false;

  constructor(channel: BrowserUsbChannel, holder: ChannelLeaseHolder) {
    this.#channel = channel;
    this.channelId = channel.id;
    this.mode = holder.mode;
    this.holder = holder;
  }

  incoming(_options?: CallOptions): AsyncIterable<ReceivedChunk> {
    this.#assertUsable();
    if (!this.#channel.hasInput) throw new Error(`USB channel ${this.channelId} has no input endpoint`);
    if (this.#iterator !== undefined) throw new Error("lease incoming() may only be acquired once");
    const inner = this.#channel.incoming()[Symbol.asyncIterator]();
    this.#iterator = inner;
    let claimed = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (claimed) throw new Error("lease incoming iterable already has an iterator");
        claimed = true;
        return {
          next: () => {
            if (!this.#invalidated) this.#assertUsable();
            return inner.next();
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

  write(data: Uint8Array, options?: CallOptions): Promise<WriteReceipt> {
    this.#assertUsable();
    return this.#channel.write(data, options);
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
    this.#invalidated = true;
  }

  #assertUsable(): void {
    if (this.#released) throw new Error(`the ${this.mode} lease has been released`);
    this.#channel.assertUsable();
  }
}

class BrowserUsbChannel implements ByteChannel {
  readonly id: ChannelId;
  readonly direction: "in" | "out" | "duplex";
  readonly protocolDuplex = null;
  readonly #connection: BrowserUsbConnection;
  readonly #device: WebUsbDeviceLike;
  readonly #clock: Clock;
  readonly #input: ValidatedUsbEndpoint | undefined;
  readonly #output: ValidatedUsbEndpoint | undefined;
  readonly #ingress: BoundedIngress;
  readonly #diagnostics: DiagnosticTapFanout;
  readonly #pending = new Set<Promise<void>>();
  #lease: BrowserUsbLease | undefined;
  #inputPending = 0;

  constructor(options: {
    readonly connection: BrowserUsbConnection;
    readonly device: WebUsbDeviceLike;
    readonly clock: Clock;
    readonly id: ChannelId;
    readonly input?: ValidatedUsbEndpoint;
    readonly output?: ValidatedUsbEndpoint;
    readonly maximumBufferedBytes: number;
    readonly maximumDiagnosticBytes: number;
  }) {
    this.#connection = options.connection;
    this.#device = options.device;
    this.#clock = options.clock;
    this.id = options.id;
    this.#input = options.input;
    this.#output = options.output;
    this.direction = options.input === undefined
      ? "out"
      : options.output === undefined ? "in" : "duplex";
    this.#diagnostics = new DiagnosticTapFanout(options.maximumDiagnosticBytes);
    this.#ingress = new BoundedIngress({
      channelId: this.id,
      hardLimitBytes: options.maximumBufferedBytes,
      clock: options.clock,
      onTerminate: (termination) => this.#connection.terminateFromChannel(termination),
    });
  }

  get hasInput(): boolean {
    return this.#input !== undefined;
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
    const lease = new BrowserUsbLease(this, holder);
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

  startInput(): void {
    const input = this.#input;
    if (input === undefined || !this.#connection.acceptingIo) return;
    const limit = input.transferType === "bulk" ? WEB_USB_BULK_INPUT_CONCURRENCY : 1;
    while (this.#inputPending < limit && this.#connection.acceptingIo) {
      this.#submitInput(input);
    }
  }

  #submitInput(input: ValidatedUsbEndpoint): void {
    this.#inputPending += 1;
    const transfer = this.#device.transferIn(
      input.endpointNumber,
      nativeUsbInRequestBytes(input),
    );
    const settlement = transfer.then(
      (result) => {
        this.#inputPending -= 1;
        if (!this.#connection.acceptingIo) return;
        if (result.status !== "ok") {
          this.#connection.terminateFromNative(
            new Error(`WebUSB IN transfer returned ${result.status}`),
          );
          return;
        }
        // Refill at the binding-settlement boundary, before copying or
        // publishing the completed bytes, so downstream work cannot drain the
        // native receive window.
        this.startInput();
        const bytes = dataViewBytes(result.data);
        if (bytes.byteLength > 0) {
          this.#diagnostics.publish(this.#record("rx", bytes));
          this.#ingress.push(bytes);
        }
      },
      (cause: unknown) => {
        this.#inputPending -= 1;
        if (this.#connection.acceptingIo) this.#connection.terminateFromNative(cause);
      },
    ).finally(() => { this.#pending.delete(settlement); });
    this.#pending.add(settlement);
  }

  async write(data: Uint8Array, options?: CallOptions): Promise<WriteReceipt> {
    this.assertUsable();
    const output = this.#output;
    if (output === undefined) throw new Error(`USB channel ${this.id} has no output endpoint`);
    const bytes = Uint8Array.from(data);
    const primary = await this.#submitOutput(output, bytes, options);
    if (primary.outcome.kind !== "accepted-by-platform") return primary;
    this.#diagnostics.publish(this.#record("tx", bytes));
    return primary;
  }

  release(lease: BrowserUsbLease): void {
    if (this.#lease === lease) this.#lease = undefined;
  }

  async settlePending(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
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
  }

  assertUsable(): void {
    if (!this.#connection.acceptingIo) {
      throw new BrowserUsbConnectionClosedError(this.#connection.termination);
    }
  }

  #submitOutput(
    output: ValidatedUsbEndpoint,
    data: Uint8Array,
    options?: CallOptions,
  ): Promise<WriteReceipt> {
    if (options?.signal?.aborted === true) {
      return Promise.resolve({
        outcome: {
          kind: "rejected",
          error: pdrError("transport.usb.transfer-cancelled", "USB transfer was cancelled before submission", "no"),
        },
        requestedBytes: data.byteLength,
        atSequence: this.#clock.nextSequence(),
        taintsSession: false,
      });
    }
    const transfer = this.#device.transferOut(output.endpointNumber, data);
    const receipt = transfer.then(
      (result): WriteReceipt => {
        if (result.status !== "ok") {
          return partialReceipt(data.byteLength, 0, this.#clock, webUsbStatusCause(result.status));
        }
        const accepted = Math.max(0, Math.min(result.bytesWritten, data.byteLength));
        return accepted === data.byteLength
          ? {
              outcome: { kind: "accepted-by-platform" },
              requestedBytes: data.byteLength,
              atSequence: this.#clock.nextSequence(),
              taintsSession: false,
            }
          : partialReceipt(data.byteLength, accepted, this.#clock);
      },
      (cause: unknown): WriteReceipt => partialReceipt(data.byteLength, 0, this.#clock, cause),
    );
    const settlement = receipt.then(() => undefined)
      .finally(() => { this.#pending.delete(settlement); });
    this.#pending.add(settlement);
    return receipt;
  }

  #record(direction: "tx" | "rx", bytes: Uint8Array): DiagnosticRecord {
    return {
      sequence: this.#clock.nextSequence(),
      tUs: Math.floor(this.#clock.monotonicUs()),
      direction,
      channelId: this.id,
      bytes,
    };
  }
}

export class BrowserUsbConnection implements DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  termination: TransportTermination | undefined;
  readonly #device: WebUsbDeviceLike;
  readonly #interfaceNumber: number;
  readonly #disconnectSource: WebUsbDisconnectSourceLike | undefined;
  readonly #clock: Clock;
  readonly #channels: readonly BrowserUsbChannel[];
  readonly #onDisconnect: (event: WebUsbDisconnectEventLike) => void;
  #resolveTermination!: (termination: TransportTermination) => void;
  #closePromise: Promise<void> | undefined;
  #closing = false;

  constructor(options: {
    readonly device: WebUsbDeviceLike;
    readonly clock: Clock;
    readonly open: BrowserUsbOpenOptions;
    readonly validated: readonly ValidatedUsbEndpoint[];
  }) {
    this.#device = options.device;
    this.#interfaceNumber = options.open.profile.interfaceNumber;
    this.#disconnectSource = options.open.disconnectSource;
    this.#clock = options.clock;
    this.identity = options.open.identity;
    this.modeId = options.open.modeId;
    this.profileId = options.open.profileId;
    this.terminated = new Promise((resolve) => { this.#resolveTermination = resolve; });
    const byAddress = new Map(options.validated.map((endpoint) => [endpoint.address, endpoint]));
    const maximumBufferedBytes = options.open.maximumBufferedBytes
      ?? DEFAULT_LIMITS.maximumBufferedBytesPerChannel;
    const maximumDiagnosticBytes = options.open.maximumDiagnosticBytes
      ?? DEFAULT_LIMITS.maximumDiagnosticBufferBytes;
    this.#channels = options.open.profile.channels.map((policy) => {
      const inputAddress = policy.input === null ? undefined : policy.input.endpointNumber | 0x80;
      const outputAddress = policy.output === null ? undefined : policy.output.endpointNumber;
      return new BrowserUsbChannel({
        connection: this,
        device: this.#device,
        clock: this.#clock,
        id: policy.id,
        ...(inputAddress === undefined ? {} : { input: byAddress.get(inputAddress)! }),
        ...(outputAddress === undefined ? {} : { output: byAddress.get(outputAddress)! }),
        maximumBufferedBytes,
        maximumDiagnosticBytes,
      });
    });
    this.channels = Object.freeze(this.#channels);
    this.#onDisconnect = (event) => {
      if (event.device === this.#device && this.usable) {
        this.#finish({ kind: "device-lost" });
        void this.close().catch(() => {});
      }
    };
    this.#disconnectSource?.addEventListener("disconnect", this.#onDisconnect);
  }

  get usable(): boolean {
    return this.termination === undefined;
  }

  get acceptingIo(): boolean {
    return this.usable && !this.#closing;
  }

  startInput(): void {
    for (const channel of this.#channels) channel.startInput();
  }

  async control(request: ControlRequest, options?: CallOptions): Promise<ControlResponse> {
    if (!this.acceptingIo) throw new BrowserUsbConnectionClosedError(this.termination);
    if (request.kind !== "usb.control") {
      return { settled: "unsupported", atSequence: this.#clock.nextSequence() };
    }
    const parsed = parseUsbControlRequest(request);
    if (parsed.kind === "invalid") {
      return {
        settled: "failed",
        error: pdrError("transport.usb.invalid-control-request", parsed.message, "no"),
        atSequence: this.#clock.nextSequence(),
      };
    }
    if (options?.signal?.aborted === true) {
      return {
        settled: "failed",
        error: pdrError("transport.usb.control-failed", "USB control transfer was cancelled before submission", "no"),
        atSequence: this.#clock.nextSequence(),
      };
    }
    try {
      const result = parsed.direction === "device-to-host"
        ? await this.#device.controlTransferIn(browserControlSetup(parsed), parsed.length)
        : await this.#device.controlTransferOut(browserControlSetup(parsed), parsed.payload);
      if (result.status !== "ok") {
        return {
          settled: "failed",
          error: pdrError(
            "transport.usb.control-failed",
            `WebUSB control transfer returned ${result.status}`,
            "after-reconnect",
            webUsbStatusCause(result.status),
          ),
          atSequence: this.#clock.nextSequence(),
        };
      }
      return {
        settled: "completed",
        ...(parsed.direction === "device-to-host"
          ? { payload: dataViewBytes((result as WebUsbInTransferResultLike).data) }
          : {}),
        atSequence: this.#clock.nextSequence(),
      };
    } catch (cause) {
      return {
        settled: "failed",
        error: pdrError(
          "transport.usb.control-failed",
          `WebUSB control transfer failed: ${errorMessage(cause)}`,
          "after-reconnect",
          cause,
        ),
        atSequence: this.#clock.nextSequence(),
      };
    }
  }

  invalidate(termination: TransportTermination): void {
    if (!this.usable) return;
    this.#finish(termination);
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

  terminateFromNative(cause: unknown): void {
    if (!this.usable) return;
    this.#finish({
      kind: "fault",
      error: pdrError(
        "transport.usb.platform-error",
        `WebUSB endpoint transfer failed: ${errorMessage(cause)}`,
        "after-reconnect",
        cause,
      ),
    });
    void this.close().catch(() => {});
  }

  async #close(): Promise<void> {
    const hostClose = this.usable;
    this.#closing = true;
    this.#disconnectSource?.removeEventListener("disconnect", this.#onDisconnect);
    let releaseCause: unknown;
    try {
      // WebUSB has no transfer cancellation operation. Releasing the interface
      // is its cancellation boundary; every resulting promise settles below
      // before the native handle is closed.
      await this.#device.releaseInterface(this.#interfaceNumber);
    } catch (cause) {
      releaseCause = cause;
    }
    await Promise.all(this.#channels.map((channel) => channel.settlePending()));
    try {
      await this.#device.close();
    } catch (cause) {
      releaseCause ??= cause;
    }
    if (releaseCause !== undefined && this.usable) {
      this.#finish({
        kind: "fault",
        error: pdrError(
          "transport.usb.close-failed",
          `WebUSB release or close failed: ${errorMessage(releaseCause)}`,
          "unknown",
          releaseCause,
        ),
      });
    } else if (hostClose && this.usable) {
      this.#finish({ kind: "closed-by-host" });
    }
  }

  #finish(termination: TransportTermination): void {
    if (!this.usable) return;
    this.termination = termination;
    for (const channel of this.#channels) channel.terminate(termination);
    this.#resolveTermination(termination);
  }
}

export class BrowserUsbTransport {
  readonly #clock: Clock;

  constructor(options: BrowserUsbTransportOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
  }

  async open(options: BrowserUsbOpenOptions): Promise<BrowserUsbConnection> {
    const { device, profile } = options;
    let opened = false;
    let claimed = false;
    try {
      requireProductName(options.requiredProductName, options.identity.productName);
      await device.open();
      opened = true;
      let selectedConfiguration = device.configuration;
      if (profile.configurationValue !== "preserve-active"
        && selectedConfiguration?.configurationValue !== profile.configurationValue) {
        await device.selectConfiguration(profile.configurationValue);
        selectedConfiguration = device.configuration;
      }
      if (selectedConfiguration === null
        || (profile.configurationValue !== "preserve-active"
          && selectedConfiguration.configurationValue !== profile.configurationValue)) {
        throw new BrowserUsbOpenError(
          "transport.usb.configuration-postcondition-failed",
          profile.configurationValue === "preserve-active"
            ? "WebUSB preserve-active profile requires an active configuration"
            : `WebUSB configuration selection did not activate declared configuration ${profile.configurationValue}`,
        );
      }
      const declaredDescriptor = descriptorEvidence(selectedConfiguration, profile, false);
      const validated = validateUsbProfilePolicy(
        profile,
        { kind: "unreported" },
        declaredDescriptor,
      );
      await device.claimInterface(profile.interfaceNumber);
      claimed = true;
      let selectedAlternate = await getAlternate(device, profile.interfaceNumber);
      if (selectedAlternate !== profile.alternateSetting) {
        await device.selectAlternateInterface(profile.interfaceNumber, profile.alternateSetting);
        selectedAlternate = await getAlternate(device, profile.interfaceNumber);
      }
      if (selectedAlternate !== profile.alternateSetting) {
        throw new BrowserUsbOpenError(
          "transport.usb.alternate-postcondition-failed",
          `WebUSB alternate selection did not activate declared setting ${profile.alternateSetting}`,
        );
      }
      const liveDescriptor = descriptorEvidence(device.configuration, profile, true);
      if (liveDescriptor.alternateSetting !== selectedAlternate) {
        throw new BrowserUsbOpenError(
          "transport.usb.alternate-host-view-mismatch",
          `WebUSB host view does not expose observed alternate setting ${selectedAlternate}`,
        );
      }
      validateUsbProfilePolicy(profile, { kind: "unreported" }, liveDescriptor);
      const connection = new BrowserUsbConnection({
        device,
        clock: this.#clock,
        open: options,
        validated: validated.endpoints,
      });
      connection.startInput();
      return connection;
    } catch (cause) {
      if (claimed) await device.releaseInterface(profile.interfaceNumber).catch(() => {});
      if (opened) await device.close().catch(() => {});
      if (cause instanceof BrowserUsbOpenError || cause instanceof UsbProfilePolicyError) throw cause;
      throw new BrowserUsbOpenError(
        "transport.open-failed",
        `could not open the declared WebUSB profile: ${errorMessage(cause)}`,
        cause,
      );
    }
  }
}

function requireProductName(required: string | undefined, observed: string | undefined): void {
  if (required === undefined || observed === required) return;
  throw new BrowserUsbOpenError(
    "transport.usb.product-name-mismatch",
    observed === undefined
      ? `WebUSB profile requires product name ${JSON.stringify(required)}, but acquisition reported none`
      : `WebUSB profile requires product name ${JSON.stringify(required)}, acquired device reports ${JSON.stringify(observed)}`,
  );
}

async function getAlternate(device: WebUsbDeviceLike, interfaceNumber: number): Promise<number> {
  let result: WebUsbInTransferResultLike;
  try {
    result = await device.controlTransferIn({
      requestType: "standard",
      recipient: "interface",
      request: USB_REQUEST_GET_INTERFACE,
      value: 0,
      index: interfaceNumber,
    }, 1);
  } catch (cause) {
    throw new BrowserUsbOpenError(
      "transport.usb.alternate-observation-failed",
      `GET_INTERFACE for WebUSB interface ${interfaceNumber} failed: ${errorMessage(cause)}`,
      cause,
    );
  }
  const bytes = dataViewBytes(result.data);
  if (result.status !== "ok" || bytes.byteLength !== 1) {
    throw new BrowserUsbOpenError(
      "transport.usb.alternate-observation-failed",
      `GET_INTERFACE for WebUSB interface ${interfaceNumber} did not return exactly one octet`,
    );
  }
  return bytes[0]!;
}

function descriptorEvidence(
  configuration: WebUsbConfigurationLike | null,
  profile: UsbProfilePolicy,
  active: boolean,
): UsbProfileDescriptorEvidence {
  const usbInterface = configuration?.interfaces.find(
    (candidate) => candidate.interfaceNumber === profile.interfaceNumber,
  );
  const alternate = active
    ? usbInterface?.alternate
    : usbInterface?.alternates.find(
        (candidate) => candidate.alternateSetting === profile.alternateSetting,
      );
  return {
    configurationValue: configuration?.configurationValue ?? 0,
    interfaceNumber: profile.interfaceNumber,
    alternateSetting: alternate?.alternateSetting ?? profile.alternateSetting,
    endpoints: (alternate?.endpoints ?? []).flatMap((endpoint) => {
      if (!(endpoint.type === "bulk" || endpoint.type === "interrupt")) return [];
      const direction = endpoint.direction === "in" ? "input" : "output";
      return [{
        address: endpoint.endpointNumber | (direction === "input" ? 0x80 : 0),
        direction,
        transferType: endpoint.type,
        maximumPacketBytes: endpoint.packetSize,
      }];
    }),
  };
}

function browserControlSetup(parsed: ParsedUsbControlRequest): WebUsbControlTransferParametersLike {
  const requestTypeBits = parsed.requestType & 0x60;
  const recipientBits = parsed.requestType & 0x1f;
  return {
    requestType: requestTypeBits === 0x00 ? "standard" : requestTypeBits === 0x20 ? "class" : "vendor",
    recipient: recipientBits === 0x00
      ? "device"
      : recipientBits === 0x01 ? "interface" : recipientBits === 0x02 ? "endpoint" : "other",
    request: parsed.request,
    value: parsed.value,
    index: parsed.index,
  };
}

function dataViewBytes(data: DataView | undefined): Uint8Array {
  if (data === undefined || data.byteLength === 0) return new Uint8Array();
  return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

function partialReceipt(
  requestedBytes: number,
  knownAcceptedBytes: number,
  clock: Clock,
  cause?: unknown,
): WriteReceipt {
  return {
    outcome: {
      kind: "may-be-partial",
      knownAcceptedBytes,
      possiblyAcceptedBytesUpTo: requestedBytes,
    },
    requestedBytes,
    atSequence: clock.nextSequence(),
    ...(cause === undefined ? {} : { platformCause: snapshotUsbCause(cause) }),
    taintsSession: true,
  };
}

function webUsbStatusCause(status: WebUsbTransferStatus): string {
  return `WebUSB transfer status: ${status}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function snapshotUsbCause(cause: unknown) {
  return snapshotPlatformCause(
    typeof cause === "object" && cause !== null ? cause : String(cause),
  );
}

function pdrError(
  code: string,
  message: string,
  retryability: PdrError["retryability"],
  cause?: unknown,
): PdrError {
  const platformCause = cause === undefined ? undefined : snapshotUsbCause(cause);
  return {
    code,
    message,
    retryability,
    ...(platformCause === undefined ? {} : { platformCause }),
  };
}
