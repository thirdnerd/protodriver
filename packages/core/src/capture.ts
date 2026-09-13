import type {
  CaptureBlobRef,
  BrokerCallId,
  CaptureOptions,
  CaptureFooter,
  CaptureHeader,
  CaptureId,
  CaptureRecord,
  CaptureSummary,
  Clock,
  HostByteSink,
  HostCaptureDestination,
  PdrError,
  Recorder,
  ResourceBrokerClient,
  ResourceId,
  ReplayabilityClass,
} from "@protodriver/contracts";
import { assertCapturePartName } from "./capture-path.ts";
export { assertCapturePartName, CapturePartNameError } from "./capture-path.ts";

const textEncoder = new TextEncoder();

type CaptureRecordInput = CaptureRecord extends infer RecordType
  ? RecordType extends CaptureRecord
    ? Omit<RecordType, "seq" | "tUs">
    : never
  : never;

export type CaptureObservation = Exclude<CaptureRecordInput, { readonly kind: "gap" }>;

export interface CaptureWriterOptions {
  /** Host policy callback; notified synchronously on first known recording loss. */
  readonly onRecordingLoss?: (error: PdrError) => void;
  readonly sink: HostByteSink;
  readonly clock: Clock;
  readonly captureId: CaptureId;
  readonly logicalDevice: string;
  readonly host: CaptureHeader["host"];
  readonly maximumBufferedBytes: number;
  /** Omission is conservative: the writer does not claim facts its owner did not promise. */
  readonly causalFacts?: CaptureHeader["causalFacts"];
  readonly sidecarThresholdBytes?: number;
  readonly writeSidecar?: (
    partIndex: number,
    data: Uint8Array,
  ) => Promise<CaptureBlobRef>;
}

interface QueuedLine {
  readonly kind: "line";
  readonly encoded: Uint8Array;
  readonly record: CaptureRecord;
  readonly bufferedBytes: number;
}

export interface CaptureByteObservation {
  readonly kind: "tx-requested" | "rx-delivered";
  readonly conn: number;
  readonly ch: string;
  readonly commandInvocation?: string;
}

interface QueuedSidecar {
  readonly kind: "sidecar";
  readonly record: CaptureByteObservation & { readonly seq: number; readonly tUs: number };
  readonly bytes: Uint8Array;
  readonly partIndex: number;
  readonly bufferedBytes: number;
}

type QueuedRecord = QueuedLine | QueuedSidecar;

interface PendingGap {
  readonly seq: number;
  readonly tUs: number;
  droppedBytes: number;
  droppedRecords: number;
}

function requireSafeNonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireFiniteNonNegative(
  value: unknown,
  name: string,
  { positive = false }: { readonly positive?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)
      || (positive ? value <= 0 : value < 0)) {
    throw new CaptureFormatError(
      `${name} must be a ${positive ? "positive" : "non-negative"} finite number`,
    );
  }
  return value;
}

function encodeLine(value: CaptureHeader | CaptureRecord | CaptureFooter): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value)}\n`);
}

function errorSnapshot(error: object | string): PdrError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "capture.storage-failed",
    message,
    retryability: "no",
    ...(error instanceof Error
      ? {
          platformCause: {
            typeName: error.constructor.name,
            name: error.name,
            message: error.message,
            ...(error.stack === undefined ? {} : { stack: error.stack }),
          },
        }
      : {}),
  };
}

function payloadLength(record: CaptureRecord): number {
  if (record.kind !== "tx-requested" && record.kind !== "rx-delivered") return 0;
  if (record.blob !== undefined) return record.blob.length;
  const data = record.data;
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

function base64Length(value: string, name: string): number {
  if (value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CaptureFormatError(`${name} must be canonical base64`);
  }
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding;
}

/**
 * Append-only NDJSON capture writer.
 *
 * record() never waits on storage. Once its bounded queue fills, subsequent
 * observations collapse into one positioned gap until storage catches up.
 */
export class CaptureWriter {
  readonly captureId: CaptureId;
  readonly #sink: HostByteSink;
  readonly #clock: Clock;
  readonly #maximumBufferedBytes: number;
  readonly #sidecarThresholdBytes: number;
  readonly #writeSidecar: CaptureWriterOptions["writeSidecar"];
  #queue: Array<QueuedRecord | undefined> = [];
  #queueHead = 0;
  readonly #connections = new Set<number>();
  #queuedBytes = 0;
  #reservedBytes = 0;
  #bytesWritten = 0;
  #recordCount = 0;
  #gapCount = 0;
  #rxBytes = 0;
  #txBytes = 0;
  #pendingGap: PendingGap | undefined;
  #drainPromise: Promise<void> | undefined;
  #storageError: PdrError | undefined;
  #completeness: "recording" | "complete" | "incomplete" = "recording";
  #closing = false;
  #nextSidecarIndex = 0;
  readonly #onRecordingLoss: CaptureWriterOptions["onRecordingLoss"];
  #lossNotified = false;

  private constructor(options: CaptureWriterOptions) {
    this.captureId = options.captureId;
    this.#sink = options.sink;
    this.#clock = options.clock;
    this.#maximumBufferedBytes = requireSafeNonNegative(
      options.maximumBufferedBytes,
      "maximumBufferedBytes",
    );
    this.#sidecarThresholdBytes = requireSafeNonNegative(
      options.sidecarThresholdBytes ?? Number.MAX_SAFE_INTEGER,
      "sidecarThresholdBytes",
    );
    this.#writeSidecar = options.writeSidecar;
    this.#onRecordingLoss = options.onRecordingLoss;
  }

  static async create(options: CaptureWriterOptions): Promise<CaptureWriter> {
    if (options.maximumBufferedBytes === 0) {
      throw new RangeError("maximumBufferedBytes must be greater than zero");
    }
    const writer = new CaptureWriter(options);
    const header: CaptureHeader = {
      kind: "header",
      formatVersion: 1,
      captureId: options.captureId,
      startedAtUnixMs: options.clock.wallClockUnixMs(),
      timebase: "monotonic-us",
      clockResolutionUs: options.clock.resolutionUs,
      logicalDevice: options.logicalDevice,
      host: options.host,
      completeness: "recording",
      causalFacts: options.causalFacts ?? "incomplete",
    };
    await writer.#writeDirect(encodeLine(header));
    if (writer.#storageError !== undefined) {
      await writer.#closeSink();
      throw new Error(writer.#storageError.message);
    }
    return writer;
  }

  get completeness(): "recording" | "complete" | "incomplete" {
    return this.#completeness;
  }

  record(observation: CaptureObservation): void {
    this.recordStamped(
      observation,
      this.#clock.nextSequence(),
      Math.floor(this.#clock.monotonicUs()),
    );
  }

  reserveObservation(maximumBytes: number): { record(observation: CaptureObservation, seq: number, tUs: number): void; release(): void } {
    requireSafeNonNegative(maximumBytes, "record reservation");
    if (this.#closing || this.#storageError || this.#pendingGap || maximumBytes > this.#maximumBufferedBytes - this.#queuedBytes - this.#reservedBytes)
      throw new Error("capture.reservation-refused: no complete-record capacity before host effect");
    this.#reservedBytes += maximumBytes;
    let held = true;
    const release = () => { if (held) { held = false; this.#reservedBytes -= maximumBytes; } };
    return { release, record: (observation, seq, tUs) => {
      if (!held) throw new Error("capture.reservation-used");
      release();
      if (encodeLine({ ...observation, seq, tUs } as CaptureRecord).length > maximumBytes) {
        this.#noteDropAt(seq, tUs, maximumBytes);
        throw new Error("capture.reservation-exceeded");
      }
      this.recordStamped(observation, seq, tUs);
    } };
  }
  /** Records an observation whose session-wide ordering stamp already exists. */
  recordStamped(observation: CaptureObservation, seq: number, tUs: number): void {
    if (this.#closing) throw new Error("capture writer is closing or closed");
    if (this.#storageError !== undefined) return;

    const record = { ...observation, seq, tUs } as CaptureRecord;
    const encoded = encodeLine(record);

    if (this.#pendingGap !== undefined
        || this.#queuedBytes + this.#reservedBytes + encoded.byteLength > this.#maximumBufferedBytes) {
      this.#noteDrop(record);
      return;
    }

    this.#queue.push({
      kind: "line",
      encoded,
      record,
      bufferedBytes: encoded.byteLength,
    });
    this.#queuedBytes += encoded.byteLength;
    this.#startDrain();
  }

  /** Records a byte observation without forcing a large payload through base64. */
  recordBytes(observation: CaptureByteObservation, data: Uint8Array): void {
    this.recordBytesStamped(
      observation,
      data,
      this.#clock.nextSequence(),
      Math.floor(this.#clock.monotonicUs()),
    );
  }

  /** Records bytes whose session-wide ordering stamp already exists. */
  recordBytesStamped(
    observation: CaptureByteObservation,
    data: Uint8Array,
    seq: number,
    tUs: number,
  ): void {
    if (this.#closing) throw new Error("capture writer is closing or closed");
    if (this.#storageError !== undefined) return;
    if (data.byteLength <= this.#sidecarThresholdBytes) {
      this.recordStamped({ ...observation, data: encodeBase64(data) }, seq, tUs);
      return;
    }
    if (this.#writeSidecar === undefined) {
      throw new Error("oversized capture payload has no sidecar destination");
    }

    const stamped = {
      ...observation,
      seq,
      tUs,
    };
    if (this.#pendingGap !== undefined
        || this.#queuedBytes + this.#reservedBytes + data.byteLength > this.#maximumBufferedBytes) {
      this.#noteDropAt(stamped.seq, stamped.tUs, data.byteLength);
      return;
    }

    const bytes = Uint8Array.from(data);
    this.#queue.push({
      kind: "sidecar",
      record: stamped,
      bytes,
      partIndex: this.#nextSidecarIndex,
      bufferedBytes: bytes.byteLength,
    });
    this.#nextSidecarIndex += 1;
    this.#queuedBytes += bytes.byteLength;
    this.#startDrain();
  }

  /** Waits until every observation accepted so far is on the sink. */
  async flush(): Promise<void> {
    for (;;) {
      const drain = this.#drainPromise;
      if (drain !== undefined) await drain;
      if (this.#drainPromise === undefined) return;
    }
  }

  async close(): Promise<CaptureSummary> {
    if (this.#closing) throw new Error("capture writer close called more than once");
    // A reservation represents an already submitted observation whose native
    // completion may never arrive. Closing cannot certify that missing tail.
    if (this.#reservedBytes) this.#noteDropAt(this.#clock.nextSequence(), Math.floor(this.#clock.monotonicUs()), 0);
    this.#closing = true;
    await this.flush();

    const incomplete = this.#gapCount !== 0 || this.#storageError !== undefined;
    this.#completeness = incomplete ? "incomplete" : "complete";

    const footer: CaptureFooter = {
      kind: "footer",
      endedAtUnixMs: this.#clock.wallClockUnixMs(),
      completeness: this.#completeness,
      replayability: this.#completeness === "complete"
        ? "byte-exact-replayable"
        : "diagnostic-only",
      recordCount: this.#recordCount,
      gapCount: this.#gapCount,
      connections: this.#connections.size,
      rxBytes: this.#rxBytes,
      txBytes: this.#txBytes,
      ...(this.#storageError === undefined ? {} : { storageError: this.#storageError }),
    };
    await this.#writeDirect(encodeLine(footer), true);

    await this.#closeSink();
    if (this.#storageError !== undefined) this.#completeness = "incomplete";

    return {
      captureId: this.captureId,
      completeness: this.#completeness,
      bytesWritten: this.#bytesWritten,
      recordCount: this.#recordCount,
      gapCount: this.#gapCount,
      partCount: 1,
      ...(this.#storageError === undefined ? {} : { storageError: this.#storageError }),
    };
  }

  /** Closes the record stream without a footer, preserving crash evidence. */
  async abort(): Promise<CaptureSummary> {
    if (this.#closing) throw new Error("capture writer is closing or closed");
    this.#closing = true;
    await this.flush();
    this.#completeness = "incomplete";
    await this.#closeSink();
    return {
      captureId: this.captureId,
      completeness: "incomplete",
      bytesWritten: this.#bytesWritten,
      recordCount: this.#recordCount,
      gapCount: this.#gapCount,
      partCount: 1,
      ...(this.#storageError === undefined ? {} : { storageError: this.#storageError }),
    };
  }

  #noteDrop(record: CaptureRecord): void {
    this.#noteDropAt(record.seq, record.tUs, payloadLength(record));
  }

  #noteDropAt(seq: number, tUs: number, droppedBytes: number): void {
    if (this.#pendingGap === undefined) {
      this.#pendingGap = {
        seq,
        tUs,
        droppedBytes,
        droppedRecords: 1,
      };
    } else {
      this.#pendingGap.droppedBytes += droppedBytes;
      this.#pendingGap.droppedRecords += 1;
    }
    // Publish loss only after its position is retained: an owner may emit a
    // terminal observation synchronously while revoking an operation.
    this.#notifyLoss({ code: "capture.recorder-overrun", message: "capture queue lost records", retryability: "no" });
    this.#startDrain();
  }

  #startDrain(): void {
    if (this.#drainPromise !== undefined || this.#storageError !== undefined) return;
    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = undefined;
      if ((this.#queueHead < this.#queue.length || this.#pendingGap !== undefined)
          && this.#storageError === undefined) {
        this.#startDrain();
      }
    });
  }

  #takeQueued(): QueuedRecord | undefined {
    const record = this.#queue[this.#queueHead];
    if (!record) return undefined;
    this.#queue[this.#queueHead++] = undefined;
    if (this.#queueHead === this.#queue.length) { this.#queue.length = 0; this.#queueHead = 0; }
    else if (this.#queueHead >= 1024 && this.#queueHead * 2 >= this.#queue.length) {
      this.#queue = this.#queue.slice(this.#queueHead); this.#queueHead = 0;
    }
    return record;
  }

  async #drain(): Promise<void> {
    while (this.#storageError === undefined) {
      const queued = this.#takeQueued();
      if (queued !== undefined) {
        if (queued.kind === "line") {
          const lines = [queued]; let length = queued.encoded.length;
          // No timer or wait for more input. Only already queued adjacent
          // lines may share a storage crossing; a sidecar is an order barrier.
          const capacity = Math.min(65536, this.#maximumBufferedBytes - this.#queuedBytes - this.#reservedBytes);
          for (;;) {
            const next = this.#queue[this.#queueHead];
            if (!next || next.kind !== "line" || length + next.encoded.length > capacity) break;
            lines.push(this.#takeQueued() as typeof queued); length += next.encoded.length;
          }
          let encoded = queued.encoded;
          const scratch = lines.length > 1 ? length : 0;
          if (scratch) {
            this.#queuedBytes += scratch; // copy and original bytes coexist until write settlement
            encoded = new Uint8Array(length); let offset = 0;
            for (const line of lines) { encoded.set(line.encoded, offset); offset += line.encoded.length; }
          }
          await this.#writeDirect(encoded);
          if (this.#storageError === undefined) {
            this.#queuedBytes -= length + scratch;
            for (const line of lines) this.#countRecord(line.record);
          }
        } else {
          try {
            const blob = await this.#writeSidecar?.(queued.partIndex, queued.bytes);
            if (blob === undefined) throw new Error("sidecar writer returned no reference");
            const record: CaptureRecord = { ...queued.record, blob };
            await this.#writeDirect(encodeLine(record));
            if (this.#storageError === undefined) this.#countRecord(record);
          } catch (error) {
            this.#storageError = errorSnapshot(
              typeof error === "object" && error !== null ? error : String(error),
            );
            this.#notifyLoss(this.#storageError);
            this.#queue.length = 0;
            this.#queueHead = 0;
            this.#pendingGap = undefined;
            this.#queuedBytes = queued.bufferedBytes;
          } finally {
            if (this.#storageError === undefined) this.#queuedBytes -= queued.bufferedBytes;
            else this.#queuedBytes = 0;
          }
        }
        continue;
      }

      const pending = this.#pendingGap;
      if (pending === undefined) return;
      this.#pendingGap = undefined;
      const gap: CaptureRecord = {
        kind: "gap",
        seq: pending.seq,
        tUs: pending.tUs,
        reason: "recorder-overrun",
        droppedBytes: pending.droppedBytes,
        droppedRecords: pending.droppedRecords,
      };
      await this.#writeDirect(encodeLine(gap));
      if (this.#storageError === undefined) this.#countRecord(gap);
    }
  }

  #countRecord(record: CaptureRecord): void {
    this.#recordCount += 1;
    if ("conn" in record) this.#connections.add(record.conn);
    if (record.kind === "gap") this.#gapCount += 1;
    else if (record.kind === "rx-delivered") this.#rxBytes += payloadLength(record);
    else if (record.kind === "tx-requested") this.#txBytes += payloadLength(record);
  }

  async #writeDirect(encoded: Uint8Array, attemptAfterFailure = false): Promise<void> {
    if (this.#storageError !== undefined && !attemptAfterFailure) return;
    const previousError = this.#storageError;
    try {
      await this.#sink.write(encoded);
      this.#bytesWritten += encoded.byteLength;
    } catch (error) {
      this.#storageError = previousError ?? errorSnapshot(
        typeof error === "object" && error !== null ? error : String(error),
      );
      this.#notifyLoss(this.#storageError);
      this.#queue.length = 0;
      this.#queueHead = 0;
      this.#queuedBytes = 0;
      this.#pendingGap = undefined;
    }
  }

  async #closeSink(): Promise<void> {
    try {
      await this.#sink.close();
    } catch (error) {
      if (this.#storageError === undefined) {
        this.#storageError = errorSnapshot(
          typeof error === "object" && error !== null ? error : String(error),
        );
        this.#notifyLoss(this.#storageError);
      }
    }
  }

  #notifyLoss(error: PdrError): void {
    if (this.#lossNotified) return;
    this.#lossNotified = true;
    try { this.#onRecordingLoss?.(error); }
    catch (cause) {
      this.#storageError ??= { code: "capture.loss-observer-failed", message: String(cause), retryability: "no" };
    }
  }
}

export const DEFAULT_SIDECAR_THRESHOLD_BYTES = 4 * 1024;
const SIDECAR_WRITE_CHUNK_BYTES = 1024 * 1024;

class BrokerByteSink implements HostByteSink {
  readonly #broker: ResourceBrokerClient;
  readonly #resourceId: ResourceId;
  readonly #nextCallId: () => BrokerCallId;
  #closed = false;

  constructor(
    broker: ResourceBrokerClient,
    resourceId: ResourceId,
    nextCallId: () => BrokerCallId,
  ) {
    this.#broker = broker;
    this.#resourceId = resourceId;
    this.#nextCallId = nextCallId;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("capture resource is closed");
    const copy = Uint8Array.from(data);
    await this.#broker.write(this.#resourceId, copy.buffer, {
      callId: this.#nextCallId(),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#broker.close(this.#resourceId);
  }
}

export interface DestinationCaptureRecorderOptions {
  readonly onRecordingLoss?: CaptureWriterOptions["onRecordingLoss"];
  readonly destination: HostCaptureDestination;
  readonly broker: ResourceBrokerClient;
  readonly clock: Clock;
  readonly captureId: CaptureId;
  readonly logicalDevice: string;
  readonly host: CaptureHeader["host"];
  readonly maximumBufferedBytes: number;
  readonly capture?: Partial<Pick<CaptureOptions, "sidecarThresholdBytes">>;
}

/** Recorder wired to the contract's multi-part destination and resource broker. */
export class DestinationCaptureRecorder implements Recorder {
  readonly captureId: CaptureId;
  readonly #destination: HostCaptureDestination;
  readonly #broker: ResourceBrokerClient;
  readonly #writer: CaptureWriter;
  readonly #calls: { value: number };
  #partCount = 1;
  #sidecarBytes = 0;

  private constructor(
    options: DestinationCaptureRecorderOptions,
    writer: CaptureWriter,
    calls: { value: number },
  ) {
    this.captureId = options.captureId;
    this.#destination = options.destination;
    this.#broker = options.broker;
    this.#writer = writer;
    this.#calls = calls;
  }

  static async create(
    options: DestinationCaptureRecorderOptions,
  ): Promise<DestinationCaptureRecorder> {
    let recorder: DestinationCaptureRecorder | undefined;
    const calls = { value: 0 };
    const nextCallId = (): BrokerCallId => {
      calls.value += 1;
      return `capture-${calls.value}` as BrokerCallId;
    };
    const recordId = await options.destination.openPart("session.pdcap", {
      contentType: "application/x-ndjson",
    });
    const recordSink = new BrokerByteSink(options.broker, recordId, nextCallId);
    let writer: CaptureWriter;
    try {
      writer = await CaptureWriter.create({
        ...(options.onRecordingLoss === undefined ? {} : { onRecordingLoss: options.onRecordingLoss }),
        sink: recordSink,
        clock: options.clock,
        captureId: options.captureId,
        logicalDevice: options.logicalDevice,
        host: options.host,
        maximumBufferedBytes: options.maximumBufferedBytes,
        sidecarThresholdBytes: options.capture?.sidecarThresholdBytes
          ?? DEFAULT_SIDECAR_THRESHOLD_BYTES,
        writeSidecar: async (partIndex, data) => {
          if (recorder === undefined) throw new Error("capture recorder is not initialized");
          return recorder.#writeSidecar(partIndex, data);
        },
      });
    } catch (error) {
      await recordSink.close();
      throw error;
    }
    recorder = new DestinationCaptureRecorder(options, writer, calls);
    return recorder;
  }

  get completeness(): "recording" | "complete" | "incomplete" {
    return this.#writer.completeness;
  }

  reserveObservation(maximumBytes: number) { return this.#writer.reserveObservation(maximumBytes); }

  record(observation: CaptureObservation): void {
    this.#writer.record(observation);
  }

  recordStamped(observation: CaptureObservation, seq: number, tUs: number): void {
    this.#writer.recordStamped(observation, seq, tUs);
  }

  recordBytes(observation: CaptureByteObservation, data: Uint8Array): void {
    this.#writer.recordBytes(observation, data);
  }

  recordBytesStamped(
    observation: CaptureByteObservation,
    data: Uint8Array,
    seq: number,
    tUs: number,
  ): void {
    this.#writer.recordBytesStamped(observation, data, seq, tUs);
  }

  async close(): Promise<CaptureSummary> {
    let summary = await this.#writer.close();
    if (summary.storageError === undefined) {
      try {
        await this.#destination.commit();
      } catch (error) {
        summary = this.#withStorageError(summary, error);
      }
    } else {
      await this.#destination.abort(summary.storageError);
    }
    return {
      ...summary,
      bytesWritten: summary.bytesWritten + this.#sidecarBytes,
      partCount: this.#partCount,
    };
  }

  async abort(error: PdrError): Promise<CaptureSummary> {
    const summary = await this.#writer.abort();
    await this.#destination.abort(error);
    return {
      ...summary,
      bytesWritten: summary.bytesWritten + this.#sidecarBytes,
      partCount: this.#partCount,
    };
  }

  async #writeSidecar(partIndex: number, data: Uint8Array): Promise<CaptureBlobRef> {
    const name = `payload.${partIndex}.bin`;
    const resourceId = await this.#destination.openPart(name, {
      contentType: "application/octet-stream",
    });
    this.#partCount += 1;
    try {
      for (let offset = 0; offset < data.byteLength; offset += SIDECAR_WRITE_CHUNK_BYTES) {
        const chunk = Uint8Array.from(
          data.subarray(offset, offset + SIDECAR_WRITE_CHUNK_BYTES),
        );
        await this.#broker.write(resourceId, chunk.buffer, {
          callId: this.#nextCallId(),
        });
        this.#sidecarBytes += chunk.byteLength;
      }
    } finally {
      await this.#broker.close(resourceId);
    }
    return {
      file: name,
      offset: 0,
      length: data.byteLength,
    };
  }

  #nextCallId(): BrokerCallId {
    this.#calls.value += 1;
    return `capture-${this.#calls.value}` as BrokerCallId;
  }

  #withStorageError(summary: CaptureSummary, error: unknown): CaptureSummary {
    const storageError = errorSnapshot(
      typeof error === "object" && error !== null ? error : String(error),
    );
    return {
      ...summary,
      completeness: "incomplete",
      storageError,
    };
  }
}

function encodeBase64(data: Uint8Array): string {
  let binary = "";
  const chunkBytes = 0x8000;
  for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkBytes));
  }
  return btoa(binary);
}

export type CaptureChunk = string | Uint8Array;
export type CaptureChunkSource = AsyncIterable<CaptureChunk> | Iterable<CaptureChunk>;

export interface CaptureLoadResult {
  readonly header: CaptureHeader;
  readonly records: readonly CaptureRecord[];
  readonly footer: CaptureFooter | undefined;
  readonly completeness: "complete" | "incomplete";
  readonly replayability: ReplayabilityClass;
  readonly truncatedTail: boolean;
}

export class CaptureFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureFormatError";
  }
}

interface CaptureLine {
  readonly text: string;
  readonly terminated: boolean;
}

async function* lines(source: CaptureChunkSource): AsyncGenerator<CaptureLine> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for await (const chunk of source) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      yield { text: line.endsWith("\r") ? line.slice(0, -1) : line, terminated: true };
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") yield { text: buffered, terminated: false };
}

function parseObject(text: string, position: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CaptureFormatError(`${position} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CaptureFormatError(`${position} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireNumber(
  value: unknown,
  name: string,
  { positive = false }: { readonly positive?: boolean } = {},
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number"
      || (positive ? value <= 0 : value < 0)) {
    throw new CaptureFormatError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function parseHeader(line: CaptureLine): CaptureHeader {
  if (!line.terminated) throw new CaptureFormatError("capture header is incomplete");
  const value = parseObject(line.text, "capture header");
  if (value.kind !== "header" || value.formatVersion !== 1
      || value.completeness !== "recording" || value.timebase !== "monotonic-us") {
    throw new CaptureFormatError("capture header framing is invalid or unsupported");
  }
  requireFiniteNonNegative(value.startedAtUnixMs, "header.startedAtUnixMs");
  requireFiniteNonNegative(value.clockResolutionUs, "header.clockResolutionUs", {
    positive: true,
  });
  if (typeof value.captureId !== "string" || value.captureId === ""
      || typeof value.logicalDevice !== "string" || value.logicalDevice === "") {
    throw new CaptureFormatError("capture header identifiers must be non-empty strings");
  }
  if (value.replayability !== undefined) {
    throw new CaptureFormatError("capture header must not declare final replayability");
  }
  const host = value.host;
  if (typeof host !== "object" || host === null || Array.isArray(host)) {
    throw new CaptureFormatError("header.host must be an object");
  }
  const hostRecord = host as Record<string, unknown>;
  if (hostRecord.platform !== "node" && hostRecord.platform !== "web") {
    throw new CaptureFormatError("header.host is invalid");
  }
  if (value.causalFacts !== undefined
      && value.causalFacts !== "complete"
      && value.causalFacts !== "incomplete") {
    throw new CaptureFormatError("header.causalFacts is invalid");
  }
  return {
    ...value,
    causalFacts: value.causalFacts ?? "incomplete",
  } as unknown as CaptureHeader;
}

function parseRecord(
  value: Record<string, unknown>,
  previousSequence: number,
  previousTimeUs: number,
): CaptureRecord {
  const sequence = requireNumber(value.seq, "record.seq", { positive: true });
  const timeUs = requireNumber(value.tUs, "record.tUs");
  if (sequence <= previousSequence) {
    throw new CaptureFormatError("record sequences must be strictly increasing");
  }
  if (timeUs < previousTimeUs) {
    throw new CaptureFormatError("record monotonic timestamps must not decrease");
  }
  if (typeof value.kind !== "string" || value.kind === "header" || value.kind === "footer") {
    throw new CaptureFormatError("event record kind is invalid");
  }

  const requireString = (field: string): string => {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue === "") {
      throw new CaptureFormatError(`${value.kind}.${field} must be a non-empty string`);
    }
    return fieldValue;
  };
  const requireConnection = (): void => {
    requireNumber(value.conn, `${value.kind}.conn`, { positive: true });
  };
  const requirePayload = (): void => {
    const hasData = Object.hasOwn(value, "data");
    const hasBlob = Object.hasOwn(value, "blob");
    if (hasData === hasBlob) {
      throw new CaptureFormatError(`${value.kind} must contain exactly one of data or blob`);
    }
    if (hasData) {
      if (typeof value.data !== "string") {
        throw new CaptureFormatError(`${value.kind}.data must be base64 text`);
      }
      base64Length(value.data, `${value.kind}.data`);
      return;
    }
    if (typeof value.blob !== "object" || value.blob === null || Array.isArray(value.blob)) {
      throw new CaptureFormatError(`${value.kind}.blob must be an object`);
    }
    const blob = value.blob as Record<string, unknown>;
    if (typeof blob.file !== "string" || blob.file === "") {
      throw new CaptureFormatError(`${value.kind}.blob identifiers are invalid`);
    }
    assertCapturePartName(blob.file);
    requireNumber(blob.offset, `${value.kind}.blob.offset`);
    requireNumber(blob.length, `${value.kind}.blob.length`);
  };

  switch (value.kind) {
    case "tx-requested":
    case "rx-delivered":
      requireConnection();
      requireString("ch");
      requirePayload();
      if (value.commandInvocation !== undefined
          && typeof value.commandInvocation !== "string") {
        throw new CaptureFormatError(`${value.kind}.commandInvocation must be a string`);
      }
      break;
    case "tx-settled":
      requireNumber(value.ref, "tx-settled.ref", { positive: true });
      if (!Object.hasOwn(value, "outcome")) {
        throw new CaptureFormatError("tx-settled.outcome is required");
      }
      break;
    case "byte-attribution":
      requireNumber(value.ref, "byte-attribution.ref", { positive: true });
      requireNumber(value.offsetBytes, "byte-attribution.offsetBytes");
      requireNumber(value.lengthBytes, "byte-attribution.lengthBytes", { positive: true });
      requireString("commandInvocation");
      if ((value.ref as number) >= sequence) {
        throw new CaptureFormatError("byte-attribution.ref must name an earlier record");
      }
      break;
    case "control-requested":
      requireConnection();
      requireString("capability");
      if (!Object.hasOwn(value, "request")) {
        throw new CaptureFormatError("control-requested.request is required");
      }
      if (value.payload !== undefined) {
        if (typeof value.payload !== "string") {
          throw new CaptureFormatError("control-requested.payload must be base64 text");
        }
        base64Length(value.payload, "control-requested.payload");
      }
      break;
    case "control-settled":
      requireNumber(value.ref, "control-settled.ref", { positive: true });
      if (!Object.hasOwn(value, "result")) {
        throw new CaptureFormatError("control-settled.result is required");
      }
      break;
    case "connection-open":
      requireConnection();
      requireString("profileId");
      break;
    case "connection-close":
      requireConnection();
      if (value.termination === undefined && value.reason === undefined) {
        throw new CaptureFormatError("connection-close requires termination or legacy reason");
      }
      if (value.reason !== undefined) requireString("reason");
      break;
    case "state":
      requireString("from");
      requireString("to");
      requireString("reason");
      break;
    case "event":
      requireString("name");
      break;
    case "gap":
      if (value.reason !== "recorder-overrun") {
        throw new CaptureFormatError("gap reason is invalid");
      }
      requireNumber(value.droppedBytes, "gap.droppedBytes");
      requireNumber(value.droppedRecords, "gap.droppedRecords", { positive: true });
      break;
    case "suspend":
      requireFiniteNonNegative(value.observedGapMs, "suspend.observedGapMs");
      break;
    default:
      throw new CaptureFormatError(`unsupported capture record kind ${value.kind}`);
  }
  return value as unknown as CaptureRecord;
}

function parseFooter(value: Record<string, unknown>): CaptureFooter {
  if (value.kind !== "footer"
      || (value.completeness !== "complete" && value.completeness !== "incomplete")) {
    throw new CaptureFormatError("capture footer framing is invalid");
  }
  if (value.replayability !== "byte-exact-replayable"
      && value.replayability !== "diagnostic-only") {
    throw new CaptureFormatError("footer.replayability is invalid");
  }
  requireFiniteNonNegative(value.endedAtUnixMs, "footer.endedAtUnixMs");
  for (const name of [
    "recordCount",
    "gapCount",
    "connections",
    "rxBytes",
    "txBytes",
  ] as const) {
    requireNumber(value[name], `footer.${name}`);
  }
  return value as unknown as CaptureFooter;
}

/** Loads framing and event records while accepting arbitrary input chunks. */
export async function loadCapture(source: CaptureChunkSource): Promise<CaptureLoadResult> {
  const iterator = lines(source)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new CaptureFormatError("capture is empty");
  const header = parseHeader(first.value);
  const records: CaptureRecord[] = [];
  let footer: CaptureFooter | undefined;
  let previousSequence = 0;
  let previousTimeUs = 0;
  let gapCount = 0;
  let rxBytes = 0;
  let txBytes = 0;
  const connections = new Set<number>();
  let truncatedTail = false;

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    if (!next.value.terminated) {
      truncatedTail = true;
      break;
    }
    if (next.value.text === "") throw new CaptureFormatError("blank capture line");
    const value = parseObject(next.value.text, `capture line ${records.length + 2}`);
    if (value.kind === "footer") {
      footer = parseFooter(value);
      const trailing = await iterator.next();
      if (!trailing.done) throw new CaptureFormatError("capture contains data after its footer");
      break;
    }
    const record = parseRecord(value, previousSequence, previousTimeUs);
    previousSequence = record.seq;
    previousTimeUs = record.tUs;
    records.push(record);
    if (record.kind === "gap") gapCount += 1;
    else if (record.kind === "rx-delivered") rxBytes += payloadLength(record);
    else if (record.kind === "tx-requested") txBytes += payloadLength(record);
    if ("conn" in record) connections.add(record.conn);
  }

  if (footer !== undefined) {
    if (footer.recordCount !== records.length
        || footer.gapCount !== gapCount
        || footer.connections !== connections.size
        || footer.rxBytes !== rxBytes
        || footer.txBytes !== txBytes) {
      throw new CaptureFormatError("capture footer counts do not match its records");
    }
    if (footer.completeness === "complete" && gapCount !== 0) {
      throw new CaptureFormatError("a capture with gaps cannot claim completeness");
    }
    if (footer.replayability === "byte-exact-replayable"
        && (footer.completeness !== "complete" || gapCount !== 0)) {
      throw new CaptureFormatError("an incomplete capture cannot claim byte-exact replayability");
    }
  }

  const completeness = footer?.completeness === "complete" && !truncatedTail
    ? "complete"
    : "incomplete";
  const replayability = completeness === "complete"
    ? footer?.replayability ?? "diagnostic-only"
    : "diagnostic-only";

  validateByteAttributions(records, completeness, gapCount);

  return {
    header,
    records,
    footer,
    completeness,
    replayability,
    truncatedTail,
  };
}

function validateByteAttributions(
  records: readonly CaptureRecord[],
  completeness: "complete" | "incomplete",
  gapCount: number,
): void {
  const deliveries = new Map<number, number>();
  const ranges = new Map<number, { readonly start: number; readonly end: number }[]>();
  for (const record of records) {
    if (record.kind === "rx-delivered") {
      deliveries.set(record.seq, payloadLength(record));
      continue;
    }
    if (record.kind !== "byte-attribution") continue;
    const deliveryBytes = deliveries.get(record.ref);
    if (deliveryBytes === undefined) {
      if (completeness === "complete" || gapCount === 0) {
        throw new CaptureFormatError(
          `byte-attribution.ref ${record.ref} does not name a retained rx-delivered record`,
        );
      }
      continue;
    }
    const end = record.offsetBytes + record.lengthBytes;
    if (!Number.isSafeInteger(end) || end > deliveryBytes) {
      throw new CaptureFormatError(
        `byte-attribution range ${record.offsetBytes}..${end} exceeds ${deliveryBytes}-byte delivery ${record.ref}`,
      );
    }
    const prior = ranges.get(record.ref) ?? [];
    if (prior.some((range) => record.offsetBytes < range.end && range.start < end)) {
      throw new CaptureFormatError(
        `byte-attribution range ${record.offsetBytes}..${end} overlaps attribution for delivery ${record.ref}`,
      );
    }
    prior.push({ start: record.offsetBytes, end });
    ranges.set(record.ref, prior);
  }
}
