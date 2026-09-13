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
  PhysicalDeviceIdentity,
  ReceivedChunk,
  TransportTermination,
  WriteOutcome,
  WriteReceipt,
} from "@protodriver/contracts";
import {
  BoundedIngress,
  ReceiveTerminatedError,
  type IngressMetrics,
  type IngressPushResult,
} from "@protodriver/core/ingress";
import { DiagnosticTapFanout } from "@protodriver/core/diagnostics";
import { ChannelLeaseConflictError } from "@protodriver/core/leases";

export { ChannelLeaseConflictError } from "@protodriver/core/leases";

export class MockConnectionClosedError extends Error {
  readonly termination: TransportTermination | undefined;

  constructor(termination?: TransportTermination) {
    super(termination === undefined
      ? "mock connection is no longer usable"
      : `mock connection terminated: ${termination.kind}`);
    this.name = "MockConnectionClosedError";
    this.termination = termination;
  }
}

export class MockLeaseReleasedError extends Error {
  readonly channelId: ChannelId;
  readonly mode: ChannelMode;

  constructor(channelId: ChannelId, mode: ChannelMode) {
    super(`the ${mode} lease on channel ${channelId} has been released`);
    this.name = "MockLeaseReleasedError";
    this.channelId = channelId;
    this.mode = mode;
  }
}

class MockChannelLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelId;
  readonly holder: ChannelLeaseHolder;
  readonly #channel: MockByteChannel;
  #incoming: AsyncIterator<ReceivedChunk> | undefined;
  #released = false;
  #custodyBinding: { dispose(): void } | undefined;
  #invalidated = false;

  constructor(channel: MockByteChannel, holder: ChannelLeaseHolder) {
    this.#channel = channel;
    this.channelId = channel.id;
    this.mode = holder.mode;
    this.holder = holder;
  }

  incoming(_options?: CallOptions): AsyncIterable<ReceivedChunk> {
    this.#assertUsable();
    if (this.#incoming !== undefined) {
      throw new Error("lease incoming() may only be acquired once");
    }
    const inner = this.#channel.deliverBuffered()[Symbol.asyncIterator]();
    this.#incoming = inner;
    let iteratorCreated = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (iteratorCreated) throw new Error("lease incoming iterable already has an iterator");
        iteratorCreated = true;
        return {
          next: async () => {
            // An ingress overflow terminates the connection but the current
            // lease must still drain every previously accepted octet before
            // it observes ReceiveTerminatedError. Replacement, by contrast,
            // invalidates the lease itself and cannot leak old bytes.
            if (this.#released) this.#assertUsable();
            if (this.#invalidated) return inner.next();
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

  async write(data: Uint8Array, _options?: CallOptions): Promise<WriteReceipt> {
    this.#assertUsable();
    return this.#channel.write(data);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try { this.#custodyBinding?.dispose(); }
    finally {
      this.#custodyBinding = undefined;
      await this.#incoming?.return?.();
      this.#channel.release(this);
    }
  }

  invalidate(): void {
    this.#invalidated = true;
  }

  #assertUsable(): void {
    if (!this.#channel.valid) throw this.#channel.closedError();
    if (this.#released) throw new MockLeaseReleasedError(this.channelId, this.mode);
  }
}

export class MockByteChannel implements ByteChannel {
  readonly id: ChannelId;
  readonly direction = "duplex" as const;
  readonly protocolDuplex = null;
  readonly #clock: Clock;
  readonly #writeOutcome: WriteOutcome;
  readonly #ingress: BoundedIngress;
  readonly #diagnosticFanout: DiagnosticTapFanout;
  readonly #onTerminate: (termination: TransportTermination) => void;
  #lease: MockChannelLease | undefined;
  #valid = true;
  #termination: TransportTermination | undefined;

  constructor(
    id: string,
    clock: Clock,
    writeOutcome: WriteOutcome,
    hardLimitBytes: number,
    maximumDiagnosticBytes: number,
    onTerminate: (termination: TransportTermination) => void,
  ) {
    this.id = id as ChannelId;
    this.#clock = clock;
    this.#writeOutcome = writeOutcome;
    this.#onTerminate = onTerminate;
    this.#diagnosticFanout = new DiagnosticTapFanout(maximumDiagnosticBytes);
    this.#ingress = new BoundedIngress({
      channelId: this.id,
      hardLimitBytes,
      clock,
      onTerminate,
    });
  }

  get valid(): boolean {
    return this.#valid;
  }

  get bufferedBytes(): number {
    return this.#ingress.metrics.retainedBytes;
  }

  get ingressMetrics(): IngressMetrics {
    return this.#ingress.metrics;
  }

  closedError(): MockConnectionClosedError {
    return new MockConnectionClosedError(this.#termination);
  }

  enqueueReceived(bytes: Uint8Array): IngressPushResult {
    this.#assertValid();
    const result = this.#ingress.push(bytes);
    this.#publish("rx", bytes);
    return result;
  }

  async acquire(mode: ChannelMode, _options?: CallOptions): Promise<ChannelLease> {
    this.#assertValid();
    if (this.#lease !== undefined) {
      throw new ChannelLeaseConflictError(mode, this.#lease.holder);
    }
    const holder: ChannelLeaseHolder = Object.freeze({
      channelId: this.id,
      mode,
      acquiredAtSequence: this.#clock.nextSequence(),
      acquiredAtMonotonicUs: Math.floor(this.#clock.monotonicUs()),
    });
    const lease = new MockChannelLease(this, holder);
    this.#lease = lease;
    return lease;
  }

  observe(): DiagnosticTap {
    this.#assertValid();
    return this.#diagnosticFanout.open();
  }

 deliverBuffered(): AsyncIterable<ReceivedChunk> {
    this.#assertValid();
    return this.#ingress.incoming();
  }

  bindInputCustody(sink: InputCustodySink): { dispose(): void } {
    return this.#ingress.bindInputCustody(sink);
  }

  write(data: Uint8Array): WriteReceipt {
    this.#assertValid();
    this.#publish("tx", data);
    return this.#writeReceipt(data.byteLength);
  }

  writeReceipt(requestedBytes: number): WriteReceipt {
    this.#assertValid();
    return this.#writeReceipt(requestedBytes);
  }

  #writeReceipt(requestedBytes: number): WriteReceipt {
    return {
      outcome: this.#writeOutcome,
      requestedBytes,
      atSequence: this.#clock.nextSequence(),
      taintsSession: this.#writeOutcome.kind === "may-be-partial",
    };
  }

  nextSequence(): number {
    this.#assertValid();
    return this.#clock.nextSequence();
  }

  release(lease: MockChannelLease): void {
    if (this.#lease === lease) this.#lease = undefined;
  }

  invalidate(): void {
    if (!this.#valid) return;
    this.#valid = false;
    this.#termination = { kind: "closed-by-host" };
    this.#ingress.discardAndClose();
    this.#lease?.invalidate();
    this.#lease = undefined;
    this.#diagnosticFanout.close();
  }

  terminate(termination: TransportTermination, preserveIngress = false): void {
    this.#valid = false;
    this.#termination = termination;
    if (!preserveIngress) {
      this.#ingress.discardAndTerminate(termination);
      this.#lease?.invalidate();
      this.#lease = undefined;
    }
    const error = new ReceiveTerminatedError(termination);
    this.#diagnosticFanout.terminate(error);
  }

  #assertValid(): void {
    if (!this.#valid) throw new MockConnectionClosedError(this.#termination);
  }

  #publish(direction: "tx" | "rx", bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || this.#diagnosticFanout.tapCount === 0) return;
    const record: DiagnosticRecord = {
      sequence: this.#clock.nextSequence(),
      tUs: Math.floor(this.#clock.monotonicUs()),
      direction,
      channelId: this.id,
      bytes,
    };
    this.#diagnosticFanout.publish(record);
  }
}

export interface MockConnectionOptions {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channelIds?: readonly string[];
  readonly writeOutcome?: WriteOutcome;
  readonly maximumBufferedBytesPerChannel?: number;
  readonly maximumDiagnosticBytesPerTap?: number;
}

export class MockDeviceConnection implements DeviceConnection {
  readonly identity: PhysicalDeviceIdentity;
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly MockByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  #resolveTermination!: (termination: TransportTermination) => void;
  #terminated = false;
  #disposed = false;
  #termination: TransportTermination | undefined;

  constructor(clock: Clock, options: MockConnectionOptions) {
    this.identity = options.identity;
    this.modeId = options.modeId;
    this.profileId = options.profileId;
    this.channels = (options.channelIds ?? ["main"])
      .map((id) => new MockByteChannel(
        id,
        clock,
        options.writeOutcome ?? { kind: "accepted-by-platform" },
        options.maximumBufferedBytesPerChannel ?? 4 * 1024 * 1024,
        options.maximumDiagnosticBytesPerTap ?? 64 * 1024,
        (termination) => this.#terminate(termination),
      ));
    this.terminated = new Promise((resolve) => {
      this.#resolveTermination = resolve;
    });
  }

  get closed(): boolean {
    return this.#terminated;
  }

  channel(id: string): MockByteChannel {
    const channel = this.channels.find(({ id: channelId }) => channelId === id);
    if (channel === undefined) throw new Error(`mock channel ${id} does not exist`);
    return channel;
  }

  async control(
    _request: ControlRequest,
    _options?: CallOptions,
  ): Promise<ControlResponse> {
    if (this.#terminated) throw new MockConnectionClosedError(this.#termination);
    return {
      settled: "unsupported",
      atSequence: 0,
    };
  }

  async close(_reason?: string): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.channels) channel.invalidate();
    this.#terminate({ kind: "closed-by-host" });
  }

  invalidate(termination: TransportTermination): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminate(termination);
  }

  #terminate(termination: TransportTermination): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#termination = termination;
    for (const channel of this.channels) {
      const preservesOverflowingIngress = termination.kind === "receive-overflow"
        && termination.channel === channel.id;
      channel.terminate(termination, preservesOverflowingIngress);
    }
    this.#resolveTermination(termination);
  }
}

export class MockTransport {
  readonly #clock: Clock;
  readonly connections: MockDeviceConnection[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  openConnection(options: MockConnectionOptions): MockDeviceConnection {
    const connection = new MockDeviceConnection(this.#clock, options);
    this.connections.push(connection);
    return connection;
  }
}
