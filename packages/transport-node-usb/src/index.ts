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
import { parseUsbControlRequest } from "@protodriver/core/usb-control";
import {
  nativeUsbInRequestBytes,
  UsbProfilePolicyError,
  validateUsbProfilePolicy,
  type UsbNegotiatedSpeedEvidence,
  type UsbProfileDescriptorEvidence,
  type ValidatedUsbEndpoint,
} from "@protodriver/core/usb-profile";

const USB_ENDPOINT_DIRECTION_MASK = 0x80;
const USB_ENDPOINT_TRANSFER_TYPE_MASK = 0x03;
const USB_TRANSFER_TYPE_BULK = 2;
const USB_TRANSFER_TYPE_INTERRUPT = 3;
const USB_REQUEST_TYPE_INTERFACE_IN = 0x81;
const USB_REQUEST_GET_INTERFACE = 0x0a;
const USB_ERROR_NO_DEVICE = -4;
const USB_ERROR_BUSY = -6;
const USB_ERROR_NOT_SUPPORTED = -12;

export interface NodeUsbNativeError extends Error {
  readonly errno?: number;
}

export interface NodeUsbTransfer {
  submit(buffer: Buffer): NodeUsbTransfer;
  cancel(): boolean;
}

export interface NodeUsbEndpoint {
  readonly direction: "in" | "out";
  readonly descriptor: {
    readonly bEndpointAddress: number;
    readonly bmAttributes: number;
    readonly wMaxPacketSize: number;
  };
  makeTransfer(
    timeoutMs: number,
    callback: (
      error: NodeUsbNativeError | undefined,
      buffer: Buffer,
      actualLength: number,
    ) => void,
  ): NodeUsbTransfer;
}

export interface NodeUsbInterface {
  altSetting: number;
  refresh(): void;
  isKernelDriverActive(): boolean;
  claim(): void;
  endpoint(address: number): NodeUsbEndpoint | undefined;
  setAltSetting(
    alternateSetting: number,
    callback: (error: NodeUsbNativeError | undefined) => void,
  ): void;
  release(
    closeEndpoints: boolean,
    callback: (error: NodeUsbNativeError | undefined) => void,
  ): void;
}

export interface NodeUsbConfigurationDescriptor {
  readonly bConfigurationValue: number;
  readonly interfaces: readonly (readonly {
    readonly bInterfaceNumber: number;
    readonly bAlternateSetting: number;
    readonly endpoints: readonly {
      readonly bEndpointAddress: number;
      readonly bmAttributes: number;
      readonly wMaxPacketSize: number;
    }[];
  }[])[];
}

export interface NodeUsbDevice {
  timeout: number;
  readonly deviceDescriptor: {
    readonly iProduct: number;
    readonly iSerialNumber: number;
  };
  readonly configDescriptor: NodeUsbConfigurationDescriptor | undefined;
  open(defaultConfiguration: boolean): void;
  close(): void;
  getStringDescriptor(
    descriptorIndex: number,
    callback: (error: NodeUsbNativeError | undefined, value?: string) => void,
  ): void;
  setConfiguration(
    configurationValue: number,
    callback: (error: NodeUsbNativeError | undefined) => void,
  ): void;
  interface(interfaceNumber: number): NodeUsbInterface;
  controlTransfer(
    requestType: number,
    request: number,
    value: number,
    index: number,
    dataOrLength: number | Buffer,
    callback: (
      error: NodeUsbNativeError | undefined,
      result: Buffer | number | undefined,
    ) => void,
  ): NodeUsbDevice;
}

export interface NodeUsbOpenOptions {
  readonly device: NodeUsbDevice;
  readonly profileId: string;
  readonly modeId: string;
  /** Acquisition owns speed evidence; bcdUSB is never consulted for it. */
  readonly speedEvidence: UsbNegotiatedSpeedEvidence;
  readonly identity: PhysicalDeviceIdentity;
  readonly profile: UsbProfilePolicy;
  readonly requiredProductName?: string;
  /** Declared codec frame ceiling; absent only when no declaration exists. */
  readonly declaredMaximumFrameBytes?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumDiagnosticBytes?: number;
  /**
   * Instrument hook invoked synchronously before an inbound record reaches
   * protocol ingress. Observer failures are ignored: an instrument cannot
   * prevent received bytes from reaching the authoritative stream.
   */
  readonly observeBeforeIngress?: (record: DiagnosticRecord) => void;
}

export interface NodeUsbTransportOptions {
  readonly clock?: Clock;
}

export class NodeUsbOpenError extends Error {
  readonly error: PdrError;

  constructor(code: string, message: string, cause?: unknown) {
    const platformCause = cause === undefined ? undefined : snapshotUsbCause(cause);
    const error: PdrError = {
      code,
      message,
      responsibility: "host",
      retryability: code === "transport.port-held" ? "after-recovery" : "unknown",
      ...(platformCause === undefined ? {} : { platformCause }),
    };
    super(error.message);
    this.name = "NodeUsbOpenError";
    this.error = error;
  }
}

export class NodeUsbConnectionClosedError extends Error {
  readonly termination: TransportTermination;

  constructor(termination: TransportTermination) {
    super(`Node USB connection terminated: ${termination.kind}`);
    this.name = "NodeUsbConnectionClosedError";
    this.termination = termination;
  }
}

class NodeUsbLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;
  readonly holder: ChannelLeaseHolder;
  readonly #channel: NodeUsbChannel;
  #iterator: AsyncIterator<ReceivedChunk> | undefined;
  #released = false;
  #custodyBinding: { dispose(): void } | undefined;
  #invalidated = false;

  constructor(channel: NodeUsbChannel, holder: ChannelLeaseHolder) {
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

interface PendingTransfer {
  readonly transfer: NodeUsbTransfer;
  readonly settled: Promise<void>;
}

class NodeUsbChannel implements ByteChannel {
  readonly id: ChannelId;
  readonly direction: "in" | "out" | "duplex";
  readonly protocolDuplex = null;
  readonly #connection: NodeUsbConnection;
  readonly #clock: Clock;
  readonly #input: { readonly endpoint: NodeUsbEndpoint; readonly policy: ValidatedUsbEndpoint } | undefined;
  readonly #output: { readonly endpoint: NodeUsbEndpoint; readonly policy: ValidatedUsbEndpoint } | undefined;
  readonly #ingress: BoundedIngress;
  readonly #diagnostics: DiagnosticTapFanout;
  readonly #observeBeforeIngress: ((record: DiagnosticRecord) => void) | undefined;
  #lease: NodeUsbLease | undefined;
  #inputTransfer: PendingTransfer | undefined;
  readonly #outputTransfers = new Set<PendingTransfer>();

  constructor(options: {
    readonly connection: NodeUsbConnection;
    readonly clock: Clock;
    readonly id: ChannelId;
    readonly input?: { readonly endpoint: NodeUsbEndpoint; readonly policy: ValidatedUsbEndpoint };
    readonly output?: { readonly endpoint: NodeUsbEndpoint; readonly policy: ValidatedUsbEndpoint };
    readonly maximumBufferedBytes: number;
    readonly maximumDiagnosticBytes: number;
    readonly observeBeforeIngress?: (record: DiagnosticRecord) => void;
  }) {
    this.#connection = options.connection;
    this.#clock = options.clock;
    this.id = options.id;
    this.#input = options.input;
    this.#output = options.output;
    this.direction = options.input === undefined
      ? "out"
      : options.output === undefined ? "in" : "duplex";
    this.#diagnostics = new DiagnosticTapFanout(options.maximumDiagnosticBytes);
    this.#observeBeforeIngress = options.observeBeforeIngress;
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
    const lease = new NodeUsbLease(this, holder);
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
    if (input === undefined) return;
    const submit = (): void => {
      if (!this.#connection.usable || this.#inputTransfer !== undefined) return;
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const transfer = input.endpoint.makeTransfer(
        0,
        (error, buffer, actualLength) => {
          this.#inputTransfer = undefined;
          settle();
          if (!this.#connection.usable || this.#connection.closing) return;
          if (error !== undefined) {
            this.#connection.terminateFromNative(error);
            return;
          }
          if (actualLength > 0) {
            const bytes = Uint8Array.from(buffer.subarray(0, actualLength));
            const record = this.#record("rx", bytes);
            try {
              this.#observeBeforeIngress?.(record);
            } catch {
              // Observation is non-authoritative and cannot own ingress fate.
            }
            this.#diagnostics.publish(record);
            this.#ingress.push(bytes);
          }
          submit();
        },
      );
      this.#inputTransfer = { transfer, settled };
      transfer.submit(Buffer.alloc(nativeUsbInRequestBytes(input.policy)));
    };
    submit();
  }

  async write(data: Uint8Array, options?: CallOptions): Promise<WriteReceipt> {
    this.assertUsable();
    const output = this.#output;
    if (output === undefined) throw new Error(`USB channel ${this.id} has no output endpoint`);
    const bytes = Buffer.from(data);
    const primary = await this.#submitOutput(output.endpoint, bytes, options);
    if (primary.outcome.kind !== "accepted-by-platform") return primary;
    this.#diagnostics.publish(this.#record("tx", bytes));
    return primary;
  }

  release(lease: NodeUsbLease): void {
    if (this.#lease === lease) this.#lease = undefined;
  }

  async cancelPending(): Promise<void> {
    const pending = [
      ...(this.#inputTransfer === undefined ? [] : [this.#inputTransfer]),
      ...this.#outputTransfers,
    ];
    for (const { transfer } of pending) transfer.cancel();
    await Promise.allSettled(pending.map(({ settled }) => settled));
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
    if (!this.#connection.usable) {
      throw new NodeUsbConnectionClosedError(this.#connection.termination!);
    }
  }

  async #submitOutput(
    endpoint: NodeUsbEndpoint,
    data: Buffer,
    options?: CallOptions,
  ): Promise<WriteReceipt> {
    if (options?.signal?.aborted === true) {
      return {
        outcome: {
          kind: "rejected",
          error: pdrError("transport.usb.transfer-cancelled", "USB transfer was cancelled before submission", "no"),
        },
        requestedBytes: data.byteLength,
        atSequence: this.#clock.nextSequence(),
        taintsSession: false,
      };
    }
    const timeoutMs = timeoutMilliseconds(options?.timeoutUs);
    return new Promise<WriteReceipt>((resolve) => {
      let settle!: () => void;
      const settled = new Promise<void>((settledResolve) => { settle = settledResolve; });
      let pending!: PendingTransfer;
      const transfer = endpoint.makeTransfer(timeoutMs, (error, _buffer, actualLength) => {
        this.#outputTransfers.delete(pending);
        options?.signal?.removeEventListener("abort", abort);
        settle();
        if (error !== undefined) {
          resolve({
            outcome: {
              kind: "may-be-partial",
              knownAcceptedBytes: 0,
              possiblyAcceptedBytesUpTo: data.byteLength,
            },
            requestedBytes: data.byteLength,
            atSequence: this.#clock.nextSequence(),
            platformCause: snapshotUsbCause(error),
            taintsSession: true,
          });
          return;
        }
        const accepted = Math.max(0, Math.min(actualLength, data.byteLength));
        resolve(accepted === data.byteLength
          ? {
              outcome: { kind: "accepted-by-platform" },
              requestedBytes: data.byteLength,
              atSequence: this.#clock.nextSequence(),
              taintsSession: false,
            }
          : {
              outcome: {
                kind: "may-be-partial",
                knownAcceptedBytes: accepted,
                possiblyAcceptedBytesUpTo: data.byteLength,
              },
              requestedBytes: data.byteLength,
              atSequence: this.#clock.nextSequence(),
              taintsSession: true,
            });
      });
      const abort = () => { transfer.cancel(); };
      pending = { transfer, settled };
      this.#outputTransfers.add(pending);
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted === true) abort();
      else transfer.submit(data);
    });
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

export class NodeUsbConnection implements DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  termination: TransportTermination | undefined;
  readonly #device: NodeUsbDevice;
  readonly #interface: NodeUsbInterface;
  readonly #clock: Clock;
  readonly #channels: readonly NodeUsbChannel[];
  #resolveTermination!: (termination: TransportTermination) => void;
  #closePromise: Promise<void> | undefined;
  #closing = false;

  constructor(options: {
    readonly device: NodeUsbDevice;
    readonly usbInterface: NodeUsbInterface;
    readonly clock: Clock;
    readonly open: NodeUsbOpenOptions;
    readonly endpoints: readonly { readonly endpoint: NodeUsbEndpoint; readonly policy: ValidatedUsbEndpoint }[];
  }) {
    this.#device = options.device;
    this.#interface = options.usbInterface;
    this.#clock = options.clock;
    this.identity = options.open.identity;
    this.modeId = options.open.modeId;
    this.profileId = options.open.profileId;
    this.terminated = new Promise((resolve) => { this.#resolveTermination = resolve; });
    const byAddress = new Map(options.endpoints.map((entry) => [entry.policy.address, entry]));
    const maximumBufferedBytes = options.open.maximumBufferedBytes
      ?? DEFAULT_LIMITS.maximumBufferedBytesPerChannel;
    const maximumDiagnosticBytes = options.open.maximumDiagnosticBytes
      ?? DEFAULT_LIMITS.maximumDiagnosticBufferBytes;
    this.#channels = options.open.profile.channels.map((policy) => {
      const inputAddress = policy.input === null ? undefined : policy.input.endpointNumber | 0x80;
      const outputAddress = policy.output === null ? undefined : policy.output.endpointNumber;
      return new NodeUsbChannel({
        connection: this,
        clock: this.#clock,
        id: policy.id,
        ...(inputAddress === undefined ? {} : { input: byAddress.get(inputAddress)! }),
        ...(outputAddress === undefined ? {} : { output: byAddress.get(outputAddress)! }),
        maximumBufferedBytes,
        maximumDiagnosticBytes,
        ...(options.open.observeBeforeIngress === undefined
          ? {}
          : { observeBeforeIngress: options.open.observeBeforeIngress }),
      });
    });
    this.channels = Object.freeze(this.#channels);
  }

  get usable(): boolean {
    return this.termination === undefined;
  }

  get closing(): boolean {
    return this.#closing;
  }

  startInput(): void {
    for (const channel of this.#channels) channel.startInput();
  }

  async control(request: ControlRequest, options?: CallOptions): Promise<ControlResponse> {
    if (!this.usable) throw new NodeUsbConnectionClosedError(this.termination!);
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
    try {
      const result = await controlTransfer(
        this.#device,
        parsed.requestType,
        parsed.request,
        parsed.value,
        parsed.index,
        parsed.direction === "device-to-host" ? parsed.length : Buffer.from(parsed.payload),
        options,
      );
      return {
        settled: "completed",
        ...(parsed.direction === "device-to-host"
          ? { payload: Uint8Array.from(result as Buffer) }
          : {}),
        atSequence: this.#clock.nextSequence(),
      };
    } catch (cause) {
      return {
        settled: "failed",
        error: pdrError(
          "transport.usb.control-failed",
          `USB control transfer failed: ${errorMessage(cause)}`,
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

  terminateFromNative(cause: NodeUsbNativeError): void {
    if (!this.usable) return;
    this.#finish(cause.errno === USB_ERROR_NO_DEVICE
      ? { kind: "device-lost" }
      : {
          kind: "fault",
          error: pdrError(
            "transport.usb.platform-error",
            `USB endpoint transfer failed: ${cause.message}`,
            "after-reconnect",
            cause,
          ),
        });
    void this.close().catch(() => {});
  }

  async #close(): Promise<void> {
    const hostClose = this.usable;
    this.#closing = true;
    for (const channel of this.#channels) await channel.cancelPending();
    let releaseCause: unknown;
    try {
      await releaseInterface(this.#interface);
    } catch (cause) {
      releaseCause = cause;
    }
    try {
      this.#device.close();
    } catch (cause) {
      releaseCause ??= cause;
    }
    if (releaseCause !== undefined && this.usable) {
      this.#finish({
        kind: "fault",
        error: pdrError(
          "transport.usb.close-failed",
          `USB release or close failed: ${errorMessage(releaseCause)}`,
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

export class NodeUsbTransport {
  readonly #clock: Clock;

  constructor(options: NodeUsbTransportOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
  }

  async open(options: NodeUsbOpenOptions): Promise<NodeUsbConnection> {
    const { device, profile } = options;
    let opened = false;
    let claimedInterface: NodeUsbInterface | undefined;
    try {
      requireSpeedEvidenceIdentity(options.speedEvidence, options.identity);
      device.open(true);
      opened = true;
      const identity = await enrichUsbIdentity(device, options.identity);
      requireProductName(options.requiredProductName, identity.productName);
      let selectedConfiguration = device.configDescriptor;
      if (profile.configurationValue !== "preserve-active"
        && selectedConfiguration?.bConfigurationValue !== profile.configurationValue) {
        await setConfiguration(device, profile.configurationValue);
        selectedConfiguration = device.configDescriptor;
      }
      if (selectedConfiguration === undefined
        || (profile.configurationValue !== "preserve-active"
          && selectedConfiguration.bConfigurationValue !== profile.configurationValue)) {
        throw new NodeUsbOpenError(
          "transport.usb.configuration-postcondition-failed",
          profile.configurationValue === "preserve-active"
            ? "USB preserve-active profile requires an active configuration"
            : `USB configuration selection did not activate declared configuration ${profile.configurationValue}`,
        );
      }
      const descriptor = descriptorEvidence(selectedConfiguration, profile);
      const validated = validateUsbProfilePolicy(
        profile,
        options.speedEvidence,
        descriptor,
      );
      const usbInterface = device.interface(profile.interfaceNumber);
      inspectKernelDriver(usbInterface, profile.interfaceNumber);
      usbInterface.claim();
      claimedInterface = usbInterface;
      let selectedAlternate = await getAlternate(device, profile.interfaceNumber);
      if (selectedAlternate !== profile.alternateSetting) {
        await setAlternate(usbInterface, profile.alternateSetting);
        selectedAlternate = await getAlternate(device, profile.interfaceNumber);
      }
      if (selectedAlternate !== profile.alternateSetting) {
        throw new NodeUsbOpenError(
          "transport.usb.alternate-postcondition-failed",
          `USB alternate selection did not activate declared setting ${profile.alternateSetting}`,
        );
      }
      hydrateAlternate(usbInterface, selectedAlternate);
      const endpoints = validated.endpoints.map((policy) => {
        const endpoint = usbInterface.endpoint(policy.address);
        if (endpoint === undefined || !endpointMatches(endpoint, policy)) {
          throw new NodeUsbOpenError(
            "transport.usb.endpoint-descriptor-mismatch",
            `resolved USB endpoint 0x${policy.address.toString(16).padStart(2, "0")} changed after alternate selection`,
          );
        }
        return { endpoint, policy };
      });
      const connection = new NodeUsbConnection({
        device,
        usbInterface,
        clock: this.#clock,
        open: { ...options, identity },
        endpoints,
      });
      connection.startInput();
      return connection;
    } catch (cause) {
      if (claimedInterface !== undefined) await releaseInterface(claimedInterface).catch(() => {});
      if (opened) {
        try { device.close(); } catch { /* preserve the opening failure */ }
      }
      if (cause instanceof NodeUsbOpenError || cause instanceof UsbProfilePolicyError) throw cause;
      throw new NodeUsbOpenError(
        nativeErrorCode(cause) === USB_ERROR_BUSY ? "transport.port-held" : "transport.open-failed",
        `could not open the declared USB profile: ${errorMessage(cause)}`,
        cause,
      );
    }
  }
}

function inspectKernelDriver(
  usbInterface: NodeUsbInterface,
  interfaceNumber: number,
): void {
  let active: boolean;
  try {
    active = usbInterface.isKernelDriverActive();
  } catch (cause) {
    if (nativeErrorCode(cause) === USB_ERROR_NOT_SUPPORTED) {
      // Some libusb backends, including Windows, have no kernel-driver
      // inspection or detach operation. Claim remains the ownership gate,
      // and this transport never detaches.
      return;
    }
    throw cause;
  }
  if (active) {
    throw new NodeUsbOpenError(
      "transport.port-held",
      `USB interface ${interfaceNumber} has an active kernel driver; automatic detachment is forbidden`,
    );
  }
}

function requireSpeedEvidenceIdentity(
  speedEvidence: UsbNegotiatedSpeedEvidence,
  identity: PhysicalDeviceIdentity,
): void {
  const consistent = speedEvidence.kind === "reported"
    ? identity.usbSpeed === speedEvidence.speed
    : identity.usbSpeed === undefined;
  if (consistent) return;
  throw new NodeUsbOpenError(
    "transport.usb.speed-evidence-mismatch",
    "USB identity speed must exactly reflect the supplied negotiated-speed evidence",
  );
}

async function enrichUsbIdentity(
  device: NodeUsbDevice,
  identity: PhysicalDeviceIdentity,
): Promise<PhysicalDeviceIdentity> {
  const acquiredSerialNumber = identity.serialNumber === undefined;
  const productName = identity.productName ?? await optionalStringDescriptor(
    device,
    device.deviceDescriptor.iProduct,
  );
  const serialNumber = identity.serialNumber ?? await optionalStringDescriptor(
    device,
    device.deviceDescriptor.iSerialNumber,
  );
  if (acquiredSerialNumber && serialNumber !== undefined) {
    return Object.freeze({
      ...identity,
      ...(productName === undefined ? {} : { productName }),
      serialNumber,
      stableKeyAssurance: "serial-number",
      stableKey: serialNumber,
    });
  }
  return Object.freeze({
    ...identity,
    ...(productName === undefined ? {} : { productName }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
  });
}

function optionalStringDescriptor(
  device: NodeUsbDevice,
  descriptorIndex: number,
): Promise<string | undefined> {
  if (descriptorIndex === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      device.getStringDescriptor(descriptorIndex, (error, value) => {
        resolve(error === undefined && value !== undefined && value.length > 0 ? value : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function requireProductName(required: string | undefined, observed: string | undefined): void {
  if (required === undefined || observed === required) return;
  throw new NodeUsbOpenError(
    "transport.usb.product-name-mismatch",
    observed === undefined
      ? `USB profile requires product name ${JSON.stringify(required)}, but acquisition reported none`
      : `USB profile requires product name ${JSON.stringify(required)}, acquired device reports ${JSON.stringify(observed)}`,
  );
}

function descriptorEvidence(
  configuration: NodeUsbConfigurationDescriptor,
  profile: UsbProfilePolicy,
): UsbProfileDescriptorEvidence {
  const alternate = configuration.interfaces
    .flat()
    .find((candidate) => candidate.bInterfaceNumber === profile.interfaceNumber
      && candidate.bAlternateSetting === profile.alternateSetting);
  return {
    configurationValue: configuration.bConfigurationValue,
    interfaceNumber: profile.interfaceNumber,
    alternateSetting: profile.alternateSetting,
    endpoints: (alternate?.endpoints ?? []).flatMap((endpoint) => {
      const transferType = descriptorTransferType(endpoint.bmAttributes);
      if (transferType === undefined) return [];
      const address = endpoint.bEndpointAddress;
      return [{
        address,
        direction: (address & USB_ENDPOINT_DIRECTION_MASK) === 0 ? "output" : "input",
        transferType,
        maximumPacketBytes: endpoint.wMaxPacketSize & 0x7ff,
      }];
    }),
  };
}

function endpointMatches(endpoint: NodeUsbEndpoint, policy: ValidatedUsbEndpoint): boolean {
  const descriptor = endpoint.descriptor;
  return descriptor.bEndpointAddress === policy.address
    && descriptorTransferType(descriptor.bmAttributes) === policy.transferType
    && (descriptor.wMaxPacketSize & 0x7ff) === policy.maximumPacketBytes
    && endpoint.direction === (policy.direction === "input" ? "in" : "out");
}

function descriptorTransferType(attributes: number): "bulk" | "interrupt" | undefined {
  const value = attributes & USB_ENDPOINT_TRANSFER_TYPE_MASK;
  return value === USB_TRANSFER_TYPE_BULK
    ? "bulk"
    : value === USB_TRANSFER_TYPE_INTERRUPT ? "interrupt" : undefined;
}

function setConfiguration(device: NodeUsbDevice, value: number): Promise<void> {
  return new Promise((resolve, reject) => {
    device.setConfiguration(value, (error) => error === undefined ? resolve() : reject(error));
  });
}

function setAlternate(usbInterface: NodeUsbInterface, value: number): Promise<void> {
  return new Promise((resolve, reject) => {
    usbInterface.setAltSetting(value, (error) => error === undefined ? resolve() : reject(error));
  });
}

async function getAlternate(device: NodeUsbDevice, interfaceNumber: number): Promise<number> {
  let result: Buffer | number;
  try {
    result = await controlTransfer(
      device,
      USB_REQUEST_TYPE_INTERFACE_IN,
      USB_REQUEST_GET_INTERFACE,
      0,
      interfaceNumber,
      1,
    );
  } catch (cause) {
    throw new NodeUsbOpenError(
      "transport.usb.alternate-observation-failed",
      `GET_INTERFACE for USB interface ${interfaceNumber} failed: ${errorMessage(cause)}`,
      cause,
    );
  }
  if (!(result instanceof Buffer) || result.byteLength !== 1) {
    throw new NodeUsbOpenError(
      "transport.usb.alternate-observation-failed",
      `GET_INTERFACE for USB interface ${interfaceNumber} did not return exactly one octet`,
    );
  }
  return result[0]!;
}

function hydrateAlternate(usbInterface: NodeUsbInterface, alternateSetting: number): void {
  usbInterface.altSetting = alternateSetting;
  usbInterface.refresh();
}

function releaseInterface(usbInterface: NodeUsbInterface): Promise<void> {
  return new Promise((resolve, reject) => {
    // Transfers are explicitly cancelled and settled before this call. `true`
    // remains defence in depth for a native endpoint stream not owned here.
    usbInterface.release(true, (error) => error === undefined ? resolve() : reject(error));
  });
}

function controlTransfer(
  device: NodeUsbDevice,
  requestType: number,
  request: number,
  value: number,
  index: number,
  dataOrLength: number | Buffer,
  options?: CallOptions,
): Promise<Buffer | number> {
  device.timeout = timeoutMilliseconds(options?.timeoutUs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (!settled) reject(new Error("USB control transfer was aborted"));
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    device.controlTransfer(requestType, request, value, index, dataOrLength, (error, result) => {
      settled = true;
      options?.signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else if (result === undefined) reject(new Error("USB control transfer returned no result"));
      else resolve(result);
    });
    if (options?.signal?.aborted === true) abort();
  });
}

function timeoutMilliseconds(timeoutUs: number | undefined): number {
  if (timeoutUs === undefined) return 0;
  if (!Number.isSafeInteger(timeoutUs) || timeoutUs <= 0) {
    throw new RangeError("timeoutUs must be a positive safe integer");
  }
  return Math.max(1, Math.ceil(timeoutUs / 1_000));
}

function nativeErrorCode(cause: unknown): number | undefined {
  return typeof cause === "object" && cause !== null && "errno" in cause
    && typeof cause.errno === "number" ? cause.errno : undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function snapshotUsbCause(cause: unknown) {
  return snapshotPlatformCause(
    typeof cause === "object" && cause !== null ? cause : String(cause),
    ["errno"],
  );
}

function pdrError(
  code: string,
  message: string,
  retryability: PdrError["retryability"],
  cause?: unknown,
  responsibility: NonNullable<PdrError["responsibility"]> = "operation",
): PdrError {
  const platformCause = cause === undefined ? undefined : snapshotUsbCause(cause);
  return {
    code,
    message,
    responsibility,
    retryability,
    ...(platformCause === undefined ? {} : { platformCause }),
  };
}
