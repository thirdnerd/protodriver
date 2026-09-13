import type {
  Clock,
  DiagnosticBatch,
  DiagnosticDropSummary,
  DiagnosticRecord,
  DiagnosticSubscriptionOptions,
  DiagnosticTap,
  Disposable,
  SessionRpcEvent,
  SubscriptionId,
} from "@protodriver/contracts";
import { HostResourceLimitError } from "@protodriver/core/limits";

interface PendingNext {
  readonly resolve: (result: IteratorResult<DiagnosticRecord>) => void;
  readonly reject: (error: Error) => void;
}

export interface BoundedDiagnosticTapOptions {
  readonly maximumBufferedBytes: number;
  /** Optional delivery ceiling; larger records are counted as dropped. */
  readonly maximumRecordBytes?: number;
  readonly channelId?: string;
  readonly direction?: "tx" | "rx";
  readonly onClose?: () => void;
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function cloneRecord(record: DiagnosticRecord): DiagnosticRecord {
  return {
    sequence: requireNonNegativeSafeInteger(record.sequence, "record.sequence"),
    tUs: requireNonNegativeSafeInteger(record.tUs, "record.tUs"),
    direction: record.direction,
    channelId: record.channelId,
    bytes: Uint8Array.from(record.bytes),
    ...(record.commandInvocation === undefined
      ? {}
      : { commandInvocation: record.commandInvocation }),
  };
}

/**
 * A lossy observation ring. It can render bytes but cannot produce a capture:
 * it has no capture id, completeness, record framing, footer, or fixture API.
 */
export class BoundedDiagnosticTap implements DiagnosticTap {
  readonly #maximumBufferedBytes: number;
  readonly #maximumRecordBytes: number;
  readonly #channelId: string | undefined;
  readonly #direction: "tx" | "rx" | undefined;
  readonly #onClose: (() => void) | undefined;
  readonly #queue: DiagnosticRecord[] = [];
  readonly #waiters: PendingNext[] = [];
  #bufferedBytes = 0;
  #closed = false;
  #terminalError: Error | undefined;
  #iteratorClaimed = false;
  #droppedRecords = 0;
  #droppedBytes = 0;
  #firstDroppedUs: number | undefined;
  #lastDroppedUs: number | undefined;

  constructor(options: BoundedDiagnosticTapOptions) {
    this.#maximumBufferedBytes = requireNonNegativeSafeInteger(
      options.maximumBufferedBytes,
      "maximumBufferedBytes",
    );
    this.#maximumRecordBytes = requireNonNegativeSafeInteger(
      options.maximumRecordBytes ?? options.maximumBufferedBytes,
      "maximumRecordBytes",
    );
    this.#channelId = options.channelId;
    this.#direction = options.direction;
    this.#onClose = options.onClose;
  }

  get records(): AsyncIterable<DiagnosticRecord> {
    return this;
  }

  get dropped(): DiagnosticDropSummary {
    return {
      records: this.#droppedRecords,
      bytes: this.#droppedBytes,
      ...(this.#firstDroppedUs === undefined ? {} : { firstUs: this.#firstDroppedUs }),
      ...(this.#lastDroppedUs === undefined ? {} : { lastUs: this.#lastDroppedUs }),
    };
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  get bufferedRecords(): number {
    return this.#queue.length;
  }

  observe(record: DiagnosticRecord): void {
    if (this.#closed || record.bytes.byteLength === 0 || !this.#matches(record)) return;
    const copy = cloneRecord(record);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: copy });
      return;
    }

    if (copy.bytes.byteLength > this.#maximumBufferedBytes
        || copy.bytes.byteLength > this.#maximumRecordBytes) {
      this.#noteDrop(copy);
      return;
    }
    while (this.#bufferedBytes + copy.bytes.byteLength > this.#maximumBufferedBytes) {
      const dropped = this.#queue.shift();
      if (dropped === undefined) break;
      this.#bufferedBytes -= dropped.bytes.byteLength;
      this.#noteDrop(dropped);
    }
    this.#queue.push(copy);
    this.#bufferedBytes += copy.bytes.byteLength;
  }

  /** Worker-side non-blocking batch drain; not part of DiagnosticTap. */
  drainAvailable(maximumBytes: number): readonly DiagnosticRecord[] {
    requireNonNegativeSafeInteger(maximumBytes, "maximumBytes");
    const records: DiagnosticRecord[] = [];
    let bytes = 0;
    while (this.#queue.length > 0) {
      const next = this.#queue[0]!;
      if (records.length > 0 && bytes + next.bytes.byteLength > maximumBytes) break;
      if (records.length === 0 && next.bytes.byteLength > maximumBytes) {
        this.#queue.shift();
        this.#bufferedBytes -= next.bytes.byteLength;
        this.#noteDrop(next);
        continue;
      }
      this.#queue.shift();
      this.#bufferedBytes -= next.bytes.byteLength;
      bytes += next.bytes.byteLength;
      records.push(next);
    }
    return records;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#bufferedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
    this.#onClose?.();
  }

  /** Connection termination keeps the observation error distinct from EOF. */
  terminate(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminalError = error;
    this.#queue.length = 0;
    this.#bufferedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#onClose?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<DiagnosticRecord> {
    if (this.#iteratorClaimed) throw new Error("a diagnostic tap has one consumption sequence");
    this.#iteratorClaimed = true;
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) {
          this.#bufferedBytes -= value.bytes.byteLength;
          return Promise.resolve({ done: false, value });
        }
        if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<DiagnosticRecord>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  #matches(record: DiagnosticRecord): boolean {
    return (this.#channelId === undefined || record.channelId === this.#channelId)
      && (this.#direction === undefined || record.direction === this.#direction);
  }

  #noteDrop(record: DiagnosticRecord): void {
    this.#droppedRecords = saturatingAdd(this.#droppedRecords, 1);
    this.#droppedBytes = saturatingAdd(this.#droppedBytes, record.bytes.byteLength);
    this.#firstDroppedUs = this.#firstDroppedUs === undefined
      ? record.tUs
      : Math.min(this.#firstDroppedUs, record.tUs);
    this.#lastDroppedUs = this.#lastDroppedUs === undefined
      ? record.tUs
      : Math.max(this.#lastDroppedUs, record.tUs);
  }
}

/** Copies observations to independent taps without joining the authoritative path. */
export class DiagnosticTapFanout {
  readonly #maximumBufferedBytes: number;
  readonly #taps = new Set<BoundedDiagnosticTap>();
  readonly #onTapError: ((cause: unknown) => void) | undefined;

  constructor(maximumBufferedBytes: number, onTapError?: (cause: unknown) => void) {
    this.#maximumBufferedBytes = requireNonNegativeSafeInteger(
      maximumBufferedBytes,
      "maximumBufferedBytes",
    );
    this.#onTapError = onTapError;
  }

  get tapCount(): number {
    return this.#taps.size;
  }

  open(
    options: Pick<DiagnosticSubscriptionOptions, "channelId" | "direction"> = {},
    maximumRecordBytes?: number,
  ): BoundedDiagnosticTap {
    let tap: BoundedDiagnosticTap;
    tap = new BoundedDiagnosticTap({
      maximumBufferedBytes: this.#maximumBufferedBytes,
      ...(maximumRecordBytes === undefined ? {} : { maximumRecordBytes }),
      ...(options.channelId === undefined ? {} : { channelId: options.channelId }),
      ...(options.direction === undefined ? {} : { direction: options.direction }),
      onClose: () => this.#taps.delete(tap),
    });
    this.#taps.add(tap);
    return tap;
  }

  publish(record: DiagnosticRecord): void {
    for (const tap of this.#taps) {
      try {
        tap.observe(record);
      } catch (cause) {
        tap.terminate(cause instanceof Error ? cause : new Error(String(cause)));
        try {
          this.#onTapError?.(cause);
        } catch {
          // A best-effort diagnostic reporter cannot enter the byte path.
        }
      }
    }
  }

  close(): void {
    for (const tap of [...this.#taps]) tap.close();
  }

  terminate(error: Error): void {
    for (const tap of [...this.#taps]) tap.terminate(error);
  }
}

export class DiagnosticSubscriberLimitError extends HostResourceLimitError {
  readonly maximumSubscribers: number;

  constructor(maximumSubscribers: number) {
    super(
      "diagnostic.subscriber-limit",
      "maximumDiagnosticSubscribers",
      maximumSubscribers,
      maximumSubscribers + 1,
      "diagnostic",
    );
    this.name = "DiagnosticSubscriberLimitError";
    this.maximumSubscribers = maximumSubscribers;
  }
}

interface RpcDiagnosticSubscription {
  readonly id: SubscriptionId;
  readonly tap: BoundedDiagnosticTap;
  readonly interval: Disposable;
  readonly maximumBytesPerBatch: number;
  lastDropRecords: number;
  lastDropBytes: number;
}

export interface DiagnosticRpcBridgeOptions {
  readonly clock: Clock;
  readonly fanout: DiagnosticTapFanout;
  readonly emit: (event: SessionRpcEvent) => void;
  readonly defaultBatchIntervalMs?: number;
  readonly defaultMaximumBytesPerBatch?: number;
  readonly maximumSubscribers?: number;
  readonly onDeliveryError?: (subscriptionId: SubscriptionId, cause: unknown) => void;
}

/** Worker-side bridge from copied byte observations to diagnostic RPC events. */
export class DiagnosticRpcBridge {
  readonly #clock: Clock;
  readonly #fanout: DiagnosticTapFanout;
  readonly #emit: (event: SessionRpcEvent) => void;
  readonly #defaultBatchIntervalMs: number;
  readonly #defaultMaximumBytesPerBatch: number;
  readonly #maximumSubscribers: number;
  readonly #onDeliveryError: (
    (subscriptionId: SubscriptionId, cause: unknown) => void
  ) | undefined;
  readonly #subscriptions = new Map<SubscriptionId, RpcDiagnosticSubscription>();

  constructor(options: DiagnosticRpcBridgeOptions) {
    this.#clock = options.clock;
    this.#fanout = options.fanout;
    this.#emit = options.emit;
    this.#defaultBatchIntervalMs = requirePositiveFinite(
      options.defaultBatchIntervalMs ?? 16,
      "defaultBatchIntervalMs",
    );
    this.#defaultMaximumBytesPerBatch = requireNonNegativeSafeInteger(
      options.defaultMaximumBytesPerBatch ?? 64 * 1024,
      "defaultMaximumBytesPerBatch",
    );
    if (this.#defaultMaximumBytesPerBatch === 0) {
      throw new RangeError("defaultMaximumBytesPerBatch must be greater than zero");
    }
    this.#maximumSubscribers = requireNonNegativeSafeInteger(
      options.maximumSubscribers ?? 4,
      "maximumSubscribers",
    );
    this.#onDeliveryError = options.onDeliveryError;
  }

  subscribe(
    subscriptionId: SubscriptionId,
    options: DiagnosticSubscriptionOptions = {},
  ): void {
    if (this.#subscriptions.has(subscriptionId)) {
      throw new Error(`diagnostic subscription ${subscriptionId} already exists`);
    }
    if (this.#subscriptions.size >= this.#maximumSubscribers) {
      throw new DiagnosticSubscriberLimitError(this.#maximumSubscribers);
    }
    const maximumBytesPerBatch = requireNonNegativeSafeInteger(
      options.maximumBytesPerBatch ?? this.#defaultMaximumBytesPerBatch,
      "maximumBytesPerBatch",
    );
    if (maximumBytesPerBatch === 0) throw new RangeError(
      "maximumBytesPerBatch must be greater than zero",
    );
    const tap = this.#fanout.open(options, maximumBytesPerBatch);
    let interval: Disposable;
    try {
      interval = this.#clock.interval(
        requirePositiveFinite(
          options.batchIntervalMs ?? this.#defaultBatchIntervalMs,
          "batchIntervalMs",
        ),
        () => this.flush(subscriptionId),
      );
    } catch (cause) {
      tap.close();
      throw cause;
    }
    const subscription: RpcDiagnosticSubscription = {
      id: subscriptionId,
      tap,
      interval,
      maximumBytesPerBatch,
      lastDropRecords: 0,
      lastDropBytes: 0,
    };
    this.#subscriptions.set(subscriptionId, subscription);
  }

  unsubscribe(subscriptionId: SubscriptionId): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) return;
    subscription.interval.dispose();
    subscription.tap.close();
    this.#subscriptions.delete(subscriptionId);
  }

  flush(subscriptionId: SubscriptionId): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) return;
    const records = subscription.tap.drainAvailable(subscription.maximumBytesPerBatch);
    const dropped = subscription.tap.dropped;
    const dropChanged = dropped.records !== subscription.lastDropRecords
      || dropped.bytes !== subscription.lastDropBytes;
    if (records.length === 0 && !dropChanged) return;
    subscription.lastDropRecords = dropped.records;
    subscription.lastDropBytes = dropped.bytes;
    const batch: DiagnosticBatch = {
      subscriptionId,
      records,
      dropped,
    };
    try {
      this.#emit({ kind: "diagnostics", subscriptionId, batch });
    } catch (cause) {
      this.unsubscribe(subscriptionId);
      try {
        this.#onDeliveryError?.(subscriptionId, cause);
      } catch {
        // Failure reporting remains outside the authoritative session path.
      }
    }
  }

  close(): void {
    for (const subscriptionId of [...this.#subscriptions.keys()]) {
      this.unsubscribe(subscriptionId);
    }
  }
}
