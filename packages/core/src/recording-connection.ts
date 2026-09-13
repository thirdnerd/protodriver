import type {
  ByteChannel,
  CallOptions,
  ChannelLease,
  ChannelMode,
  Clock,
  ControlRequest,
  ControlResponse,
  DeviceConnection,
  ReceivedChunk,
  InputCustodySink,
  TransportTermination,
  WriteOutcome,
  WriteReceipt,
} from "@protodriver/contracts";
import type { CaptureWriter } from "./capture.js";

interface RecordingContext {
  commandInvocation: string | undefined;
}

function outcomeValue(outcome: WriteOutcome): WriteOutcome {
  return outcome;
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class RecordingLease implements ChannelLease {
  readonly mode: ChannelMode;
  readonly channelId: ChannelLease["channelId"];
  readonly #inner: ChannelLease;
  readonly #writer: CaptureWriter;
  readonly #clock: Clock;
  readonly #connectionOrdinal: number;
  readonly #context: RecordingContext;

  constructor(
    inner: ChannelLease,
    writer: CaptureWriter,
    clock: Clock,
    connectionOrdinal: number,
    context: RecordingContext,
  ) {
    this.#inner = inner;
    this.mode = inner.mode;
    this.channelId = inner.channelId;
    this.#writer = writer;
    this.#clock = clock;
    this.#connectionOrdinal = connectionOrdinal;
    this.#context = context;
  }

  incoming(options?: CallOptions): AsyncIterable<ReceivedChunk> {
    const inner = this.#inner.incoming(options)[Symbol.asyncIterator]();
    let claimed = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (claimed) throw new Error("recording incoming iterable already has an iterator");
        claimed = true;
        return {
          next: async () => {
            const result = await inner.next();
            if (!result.done) {
              this.#writer.recordBytesStamped({
                kind: "rx-delivered",
                conn: this.#connectionOrdinal,
                ch: this.channelId,
              }, result.value.bytes, result.value.atSequence, result.value.tUs);
            }
            return result;
          },
          return: async () => inner.return?.() ?? { done: true, value: undefined },
        };
      },
    };
  }

  bindInputCustody(sink: InputCustodySink): { dispose(): void } {
    if (!this.#inner.bindInputCustody) throw new Error("input.retirement.cut-unavailable");
    return this.#inner.bindInputCustody(sink);
  }

  write(data: Uint8Array, options?: CallOptions): Promise<WriteReceipt> {
    return this.#recordWrite(data, () => this.#inner.write(data, options));
  }

  release(): Promise<void> {
    return this.#inner.release();
  }

  async #recordWrite(
    data: Uint8Array,
    write: () => Promise<WriteReceipt>,
  ): Promise<WriteReceipt> {
    const ref = this.#clock.nextSequence();
    this.#writer.recordBytesStamped({
      kind: "tx-requested",
      conn: this.#connectionOrdinal,
      ch: this.channelId,
      ...(this.#context.commandInvocation === undefined
        ? {}
        : { commandInvocation: this.#context.commandInvocation }),
    }, data, ref, Math.floor(this.#clock.monotonicUs()));
    const receipt = await write();
    this.#writer.recordStamped({
      kind: "tx-settled",
      ref,
      outcome: outcomeValue(receipt.outcome),
    }, receipt.atSequence, Math.floor(this.#clock.monotonicUs()));
    return receipt;
  }
}

class RecordingChannel implements ByteChannel {
  readonly id: ByteChannel["id"];
  readonly direction: ByteChannel["direction"];
  readonly protocolDuplex: ByteChannel["protocolDuplex"];
  readonly #inner: ByteChannel;
  readonly #writer: CaptureWriter;
  readonly #clock: Clock;
  readonly #connectionOrdinal: number;
  readonly #context: RecordingContext;

  constructor(
    inner: ByteChannel,
    writer: CaptureWriter,
    clock: Clock,
    ordinal: number,
    context: RecordingContext,
  ) {
    this.#inner = inner;
    this.id = inner.id;
    this.direction = inner.direction;
    this.protocolDuplex = inner.protocolDuplex;
    this.#writer = writer;
    this.#clock = clock;
    this.#connectionOrdinal = ordinal;
    this.#context = context;
  }

  async acquire(mode: ChannelMode, options?: CallOptions): Promise<ChannelLease> {
    return new RecordingLease(
      await this.#inner.acquire(mode, options),
      this.#writer,
      this.#clock,
      this.#connectionOrdinal,
      this.#context,
    );
  }

  observe(): ReturnType<ByteChannel["observe"]> {
    return this.#inner.observe();
  }
}

/** Session-owned observation wrapper; the platform transport remains capture-agnostic. */
export class RecordingDeviceConnection implements DeviceConnection {
  readonly identity: DeviceConnection["identity"];
  readonly modeId: string;
  readonly profileId: string;
  readonly channels: readonly ByteChannel[];
  readonly terminated: Promise<TransportTermination>;
  readonly #inner: DeviceConnection;
  readonly #writer: CaptureWriter;
  readonly #clock: Clock;
  readonly #ordinal: number;
  readonly #context: RecordingContext = { commandInvocation: undefined };
  #closeRecorded = false;

  constructor(inner: DeviceConnection, writer: CaptureWriter, clock: Clock, ordinal = 1) {
    this.#inner = inner;
    this.#writer = writer;
    this.#clock = clock;
    this.#ordinal = ordinal;
    this.identity = inner.identity;
    this.modeId = inner.modeId;
    this.profileId = inner.profileId;
    this.channels = inner.channels.map(
      (channel) => new RecordingChannel(channel, writer, clock, ordinal, this.#context),
    );
    this.#writer.record({
      kind: "connection-open",
      conn: ordinal,
      profileId: inner.profileId,
      modeId: inner.modeId,
      identity: inner.identity,
      channels: inner.channels.map(({ id, direction }) => ({ id, direction })),
    });
    this.terminated = inner.terminated.then((termination) => {
      this.#recordClose(termination);
      return termination;
    });
  }

  async control(request: ControlRequest, options?: CallOptions): Promise<ControlResponse> {
    const ref = this.#clock.nextSequence();
    this.#writer.recordStamped({
      kind: "control-requested",
      conn: this.#ordinal,
      capability: request.kind,
      request: request.parameters,
      ...(request.payload === undefined ? {} : { payload: bytesBase64(request.payload) }),
    }, ref, Math.floor(this.#clock.monotonicUs()));
    const response = await this.#inner.control(request, options);
    this.#writer.recordStamped({
      kind: "control-settled",
      ref,
      result: {
        settled: response.settled,
        ...(response.payload === undefined ? {} : { payload: bytesBase64(response.payload) }),
        ...(response.error === undefined ? {} : { error: response.error }),
      },
    }, response.atSequence, Math.floor(this.#clock.monotonicUs()));
    return response;
  }

  invalidate(termination: TransportTermination): void {
    this.#inner.invalidate(termination);
  }

  async close(reason?: string): Promise<void> {
    await this.#inner.close(reason);
    this.#recordClose({ kind: "closed-by-host" });
  }

  async withCommandInvocation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#context.commandInvocation !== undefined) {
      throw new Error(`command invocation ${this.#context.commandInvocation} is still active`);
    }
    this.#context.commandInvocation = id;
    try {
      return await operation();
    } finally {
      this.#context.commandInvocation = undefined;
    }
  }

  #recordClose(termination: TransportTermination): void {
    if (this.#closeRecorded) return;
    this.#closeRecorded = true;
    this.#writer.record({ kind: "connection-close", conn: this.#ordinal, termination });
  }
}
