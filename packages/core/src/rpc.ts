import type {
  CandidateRequest,
  CaptureDestinationId,
  CaptureId,
  CaptureOptions,
  CaptureSummary,
  CheckpointAssurance,
  CheckpointId,
  ClientId,
  ClientLeasePolicy,
  Clock,
  ConnectRequest,
  ConnectResult,
  DeviceSessionClient,
  DiagnosticBatch,
  DiagnosticSubscriptionOptions,
  Disposable,
  OperationHandle,
  OperationId,
  OperationRequest,
  OperationResult,
  PdrError,
  RawTerminalExitResult,
  RawTerminalHandle,
  RawTerminalId,
  ResumeTransferRequest,
  ResumeTransferResult,
  RpcCallId,
  RpcSessionEvent,
  SerializableCandidate,
  SessionRpcEvent,
  SessionRpcMethod,
  SessionRpcParams,
  SessionRpcRequest,
  SessionRpcResponse,
  SessionRpcResult,
  SessionSnapshot,
  SessionSubscription,
  SizeAccounting,
  SubscriptionId,
  SubscriptionOptions,
  WriteReceipt,
} from "@protodriver/contracts";
import { isPdrFailureResponsibility } from "@protodriver/contracts";
import { RealClock } from "@protodriver/core/clock";
import {
  CanonicalSizeAccounting,
  DEFAULT_PHASE_ONE_LIMITS,
  HostResourceLimitError,
} from "@protodriver/core/limits";
import {
  DEFAULT_MAXIMUM_LOSSLESS_QUEUE_DEPTH,
  SessionEventDelivery,
} from "@protodriver/core/events";

type RequestFor<K extends SessionRpcMethod> = Extract<SessionRpcRequest, { readonly kind: K }>;

export interface SessionRpcServer {
  readonly events: AsyncIterable<SessionRpcEvent>;
  handle(request: SessionRpcRequest): Promise<SessionRpcResponse>;
}

/**
 * The adapter sees DTOs only. Facade listeners stay in DeviceSessionRpcClient,
 * and an AsyncIterable carries events back without turning a user callback
 * into part of the wire surface.
 */
export interface SessionRpcAdapter {
  readonly events: AsyncIterable<SessionRpcEvent>;
  request(request: SessionRpcRequest): Promise<SessionRpcResponse>;
  /** Called by the owning platform when the worker/context dies abruptly. */
  workerLost(cause?: unknown): void;
  close(): Promise<void>;
}

export interface PostMessageEndpoint {
  postMessage(message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<SessionRpcRequest | SessionRpcResponse | SessionRpcEvent>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<SessionRpcRequest | SessionRpcResponse | SessionRpcEvent>) => void,
  ): void;
  start?(): void;
  close?(): void;
}

export class SessionRpcError extends Error {
  readonly error: PdrError;

  constructor(error: PdrError) {
    super(error.message);
    this.name = "SessionRpcError";
    this.error = error;
  }
}

export class SessionRpcClosedError extends Error {
  constructor(message = "session RPC adapter is closed") {
    super(message);
    this.name = "SessionRpcClosedError";
  }
}

function workerLostPdrError(cause?: unknown): PdrError {
  return {
    code: "session.worker-lost",
    message: "the session worker was lost; reconnect is required",
    responsibility: "operation",
    retryability: "after-reconnect",
    ...(cause instanceof Error
      ? {
          platformCause: {
            typeName: cause.constructor.name,
            name: cause.name,
            message: cause.message,
            ...(cause.stack === undefined ? {} : { stack: cause.stack }),
          },
        }
      : {}),
  };
}

export class SessionWorkerLostError extends SessionRpcError {
  constructor(cause?: unknown) {
    super(workerLostPdrError(cause));
    this.name = "SessionWorkerLostError";
  }
}

function explicitBoundaryError(cause: unknown): PdrError | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const wrapper = cause as Readonly<Record<string, unknown>>;
  for (const member of [wrapper.error, wrapper.diagnostic, wrapper.causeDiagnostic]) {
    if (typeof member !== "object" || member === null) continue;
    const value = member as Readonly<Record<string, unknown>>;
    if (typeof value.code !== "string" || typeof value.message !== "string") continue;
    const retryability = value.retryability === "no" || value.retryability === "after-reconnect"
      || value.retryability === "after-recovery" || value.retryability === "unknown"
      ? value.retryability : "no";
    const responsibility = isPdrFailureResponsibility(value.responsibility)
      ? value.responsibility
      : isPdrFailureResponsibility(wrapper.responsibility) ? wrapper.responsibility : undefined;
    return {
      code: value.code,
      message: value.message,
      retryability,
      ...(responsibility === undefined ? {} : { responsibility }),
      ...(value.details === undefined
        ? {} : { details: value.details as NonNullable<PdrError["details"]> }),
      ...(value.platformCause === undefined
        ? {} : { platformCause: value.platformCause as NonNullable<PdrError["platformCause"]> }),
    };
  }
  return undefined;
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function assertCorrelated(request: SessionRpcRequest, response: SessionRpcResponse): void {
  if (response.callId !== request.callId) {
    throw new Error(`RPC response callId ${response.callId} does not match ${request.callId}`);
  }
  if (response.method !== request.kind) {
    throw new Error(`RPC response method ${response.method} does not match ${request.kind}`);
  }
}

interface PendingResponse {
  readonly request: SessionRpcRequest;
  readonly resolve: (response: SessionRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

export interface SessionRpcAdapterOptions {
  readonly maximumMessageBytes?: number;
  readonly maximumPendingCalls?: number;
  readonly maximumSubscriptionsPerClient?: number;
  readonly sizeAccounting?: SizeAccounting;
  readonly onMessageMeasured?: (
    message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent,
    bytes: number,
  ) => void;
}

class SessionRpcEnvelope {
  readonly #maximumMessageBytes: number;
  readonly #maximumPendingCalls: number;
  readonly #maximumSubscriptions: number;
  readonly #sizeAccounting: SizeAccounting;
  readonly #onMessageMeasured: SessionRpcAdapterOptions["onMessageMeasured"];
  readonly #activeSubscriptions = new Set<SubscriptionId>();
  readonly #subscriptionReservations = new Set<SubscriptionId>();

  constructor(options: SessionRpcAdapterOptions) {
    this.#maximumMessageBytes = options.maximumMessageBytes
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumRpcMessageBytes;
    this.#maximumPendingCalls = options.maximumPendingCalls
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumPendingRpcCalls;
    this.#maximumSubscriptions = options.maximumSubscriptionsPerClient
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumSubscriptionsPerClient;
    this.#sizeAccounting = options.sizeAccounting ?? new CanonicalSizeAccounting();
    this.#onMessageMeasured = options.onMessageMeasured;
  }

  beforeRequest(request: SessionRpcRequest, pendingCalls: number): void {
    this.measure(request);
    if (pendingCalls >= this.#maximumPendingCalls) {
      throw new HostResourceLimitError(
        "rpc.pending-call-limit",
        "maximumPendingRpcCalls",
        this.#maximumPendingCalls,
        pendingCalls + 1,
        "rpc",
      );
    }
    if (request.kind !== "subscribe") return;
    const id = request.params.subscriptionId;
    if (this.#activeSubscriptions.has(id) || this.#subscriptionReservations.has(id)) return;
    const observed = this.#activeSubscriptions.size + this.#subscriptionReservations.size + 1;
    if (observed > this.#maximumSubscriptions) {
      throw new HostResourceLimitError(
        "rpc.subscription-limit",
        "maximumSubscriptionsPerClient",
        this.#maximumSubscriptions,
        observed,
        "rpc",
      );
    }
    // Reserve before the request crosses. Counting only successful replies
    // lets a burst allocate past the per-client limit while replies are pending.
    this.#subscriptionReservations.add(id);
  }

  settle(request: SessionRpcRequest, response?: SessionRpcResponse): void {
    if (response !== undefined) this.measure(response);
    if (request.kind === "subscribe") {
      const id = request.params.subscriptionId;
      this.#subscriptionReservations.delete(id);
      if (response?.kind === "ok") this.#activeSubscriptions.add(id);
    } else if (request.kind === "unsubscribe" && response?.kind === "ok") {
      this.#activeSubscriptions.delete(request.params.subscriptionId);
    }
  }

  abandon(request: SessionRpcRequest): void {
    if (request.kind === "subscribe") {
      this.#subscriptionReservations.delete(request.params.subscriptionId);
    }
  }

  measure(message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent): number {
    const bytes = this.#sizeAccounting.rpcMessageBytes(message);
    this.#onMessageMeasured?.(message, bytes);
    if (bytes > this.#maximumMessageBytes) {
      throw new HostResourceLimitError(
        "rpc.message-too-large",
        "maximumRpcMessageBytes",
        this.#maximumMessageBytes,
        bytes,
        "rpc",
      );
    }
    return bytes;
  }
}

export class DirectSessionRpcAdapter implements SessionRpcAdapter {
  readonly #server: SessionRpcServer;
  readonly #events = new AsyncMessageQueue<SessionRpcEvent>();
  readonly #pending = new Map<RpcCallId, PendingResponse>();
  readonly #envelope: SessionRpcEnvelope;
  #closed = false;
  #terminalError: Error = new SessionRpcClosedError();

  constructor(server: SessionRpcServer, options: SessionRpcAdapterOptions = {}) {
    this.#server = server;
    this.#envelope = new SessionRpcEnvelope(options);
    void this.#pumpEvents();
  }

  get events(): AsyncIterable<SessionRpcEvent> {
    return this.#events;
  }

  request(request: SessionRpcRequest): Promise<SessionRpcResponse> {
    if (this.#closed) return Promise.reject(this.#terminalError);
    if (this.#pending.has(request.callId)) {
      return Promise.reject(new Error(`duplicate RPC callId ${request.callId}`));
    }
    try {
      this.#envelope.beforeRequest(request, this.#pending.size);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return new Promise<SessionRpcResponse>((resolve, reject) => {
      this.#pending.set(request.callId, { request, resolve, reject });
      // Direct calls are deliberately queued too: user code must never run
      // in the session's current stack merely because this host needs no clone.
      queueMicrotask(() => void this.#dispatch(request));
    });
  }

  async close(): Promise<void> {
    this.#terminate(new SessionRpcClosedError());
  }

  workerLost(cause?: unknown): void {
    this.#terminate(new SessionWorkerLostError(cause));
  }

  async #pumpEvents(): Promise<void> {
    for await (const event of this.#server.events) {
      if (this.#closed) return;
      this.#deliverEvent(event);
    }
    this.#events.close();
  }

  #deliverEvent(event: SessionRpcEvent): void {
    try {
      this.#envelope.measure(event);
      this.#events.push(event);
    } catch (cause) {
      if (cause instanceof HostResourceLimitError && "subscriptionId" in event) {
        this.#events.push({
          kind: "subscriber-evicted",
          subscriptionId: event.subscriptionId,
          reason: cause.error,
        });
      }
      // An event has no call to reject. Its addressed subscriber is evicted;
      // the session and every other subscriber remain live.
    }
  }

  async #dispatch(request: SessionRpcRequest): Promise<void> {
    if (!this.#pending.has(request.callId)) return;
    try {
      const response = await this.#server.handle(request);
      const pending = this.#pending.get(request.callId);
      if (pending === undefined) return;
      this.#pending.delete(request.callId);
      assertCorrelated(request, response);
      this.#envelope.settle(request, response);
      pending.resolve(response);
    } catch (cause) {
      const pending = this.#pending.get(request.callId);
      if (pending === undefined) return;
      this.#pending.delete(request.callId);
      this.#envelope.abandon(request);
      pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #terminate(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminalError = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#events.close();
  }
}

function isResponse(
  message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent,
): message is SessionRpcResponse {
  return message.kind === "ok" || message.kind === "error";
}

function isEvent(
  message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent,
): message is SessionRpcEvent {
  return message.kind === "event"
    || message.kind === "diagnostics"
    || message.kind === "client-evicted"
    || message.kind === "subscriber-evicted";
}

export class PostMessageSessionRpcAdapter implements SessionRpcAdapter {
  readonly #endpoint: PostMessageEndpoint;
  readonly #events = new AsyncMessageQueue<SessionRpcEvent>();
  readonly #pending = new Map<RpcCallId, PendingResponse>();
  readonly #envelope: SessionRpcEnvelope;
  readonly #onMessage: (
    event: MessageEvent<SessionRpcRequest | SessionRpcResponse | SessionRpcEvent>,
  ) => void;
  #closed = false;
  #terminalError: Error = new SessionRpcClosedError();

  constructor(endpoint: PostMessageEndpoint, options: SessionRpcAdapterOptions = {}) {
    this.#endpoint = endpoint;
    this.#envelope = new SessionRpcEnvelope(options);
    this.#onMessage = ({ data }) => this.#receive(data);
    endpoint.addEventListener("message", this.#onMessage);
    endpoint.start?.();
  }

  get events(): AsyncIterable<SessionRpcEvent> {
    return this.#events;
  }

  request(request: SessionRpcRequest): Promise<SessionRpcResponse> {
    if (this.#closed) return Promise.reject(this.#terminalError);
    if (this.#pending.has(request.callId)) {
      return Promise.reject(new Error(`duplicate RPC callId ${request.callId}`));
    }
    try {
      this.#envelope.beforeRequest(request, this.#pending.size);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return new Promise<SessionRpcResponse>((resolve, reject) => {
      this.#pending.set(request.callId, { request, resolve, reject });
      try {
        this.#endpoint.postMessage(request);
      } catch (error) {
        this.#pending.delete(request.callId);
        this.#envelope.abandon(request);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.#terminate(new SessionRpcClosedError());
  }

  workerLost(cause?: unknown): void {
    this.#terminate(new SessionWorkerLostError(cause));
  }

  #receive(message: SessionRpcRequest | SessionRpcResponse | SessionRpcEvent): void {
    if (this.#closed) return;
    if (isEvent(message)) {
      try {
        this.#envelope.measure(message);
        this.#events.push(message);
      } catch (cause) {
        if (cause instanceof HostResourceLimitError && "subscriptionId" in message) {
          this.#events.push({
            kind: "subscriber-evicted",
            subscriptionId: message.subscriptionId,
            reason: cause.error,
          });
        }
      }
      return;
    }
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.callId);
    if (pending === undefined) return;
    this.#pending.delete(message.callId);
    try {
      assertCorrelated(pending.request, message);
      this.#envelope.settle(pending.request, message);
      pending.resolve(message);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #terminate(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminalError = error;
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.close?.();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#events.close();
  }
}

export function serveSessionRpc(
  endpoint: PostMessageEndpoint,
  server: SessionRpcServer,
): Disposable {
  let closed = false;
  const onMessage = ({ data }: MessageEvent<SessionRpcRequest | SessionRpcResponse | SessionRpcEvent>) => {
    if (closed || isResponse(data) || isEvent(data)) return;
    void server.handle(data).then(
      (response) => {
        if (!closed) endpoint.postMessage(response);
      },
      (cause) => {
        if (closed) return;
        const error: PdrError = explicitBoundaryError(cause) ?? {
          code: "rpc.handler-failed",
          message: cause instanceof Error ? cause.message : String(cause),
          retryability: "unknown",
        };
        endpoint.postMessage({
          kind: "error",
          method: data.kind,
          callId: data.callId,
          error,
        });
      },
    );
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();
  void (async () => {
    for await (const event of server.events) {
      if (closed) return;
      endpoint.postMessage(event);
    }
  })();
  return {
    dispose() {
      if (closed) return;
      closed = true;
      endpoint.removeEventListener("message", onMessage);
      endpoint.close?.();
    },
  };
}

export interface DeviceSessionRpcClientOptions {
  readonly clock?: Clock;
  readonly maximumLosslessQueueDepth?: number;
  readonly onHeartbeatError?: (clientId: ClientId, cause: unknown) => void;
  readonly onDiagnosticListenerError?: (subscriptionId: SubscriptionId, cause: unknown) => void;
  readonly onListenerError?: (subscriptionId: SubscriptionId, cause: unknown) => void;
  readonly onSubscriberTerminated?: (subscriptionId: SubscriptionId, reason: PdrError) => void;
}

export class DeviceSessionRpcClient implements DeviceSessionClient {
  readonly #adapter: SessionRpcAdapter;
  readonly #clock: Clock;
  readonly #eventDelivery: SessionEventDelivery;
  readonly #diagnosticListeners = new Map<SubscriptionId, (batch: DiagnosticBatch) => void>();
  readonly #heartbeats = new Map<ClientId, Disposable>();
  readonly #onHeartbeatError: ((clientId: ClientId, cause: unknown) => void) | undefined;
  readonly #onDiagnosticListenerError: (
    (subscriptionId: SubscriptionId, cause: unknown) => void
  ) | undefined;
  #nextCall = 1;
  #nextSubscription = 1;
  #closed = false;

  constructor(adapter: SessionRpcAdapter, options: DeviceSessionRpcClientOptions = {}) {
    this.#adapter = adapter;
    this.#clock = options.clock ?? new RealClock();
    this.#onHeartbeatError = options.onHeartbeatError;
    this.#onDiagnosticListenerError = options.onDiagnosticListenerError;
    this.#eventDelivery = new SessionEventDelivery({
      maximumLosslessQueueDepth: options.maximumLosslessQueueDepth
        ?? DEFAULT_MAXIMUM_LOSSLESS_QUEUE_DEPTH,
      // Replay is owned by the worker subscription. Addressed events arrive
      // here already selected for this subscriber.
      maximumReplayCount: 0,
      ...(options.onListenerError === undefined ? {} : { onListenerError: options.onListenerError }),
      onSubscriberTerminated: (subscriptionId, reason) => {
        try {
          options.onSubscriberTerminated?.(subscriptionId, reason);
        } finally {
          this.#requestUnsubscribe(subscriptionId);
        }
      },
    });
    void this.#pumpEvents();
  }

  async attach(clientId: ClientId): Promise<ClientLeasePolicy> {
    const policy = await this.#call("attach-client", { clientId });
    this.#startHeartbeat(clientId, policy);
    return policy;
  }

  async detach(clientId: ClientId): Promise<void> {
    this.#heartbeats.get(clientId)?.dispose();
    this.#heartbeats.delete(clientId);
    await this.#call("detach-client", { clientId });
  }

  getSnapshot(): Promise<SessionSnapshot> {
    return this.#call("get-snapshot", {});
  }

  resolveCandidates(request: CandidateRequest): Promise<readonly SerializableCandidate[]> {
    return this.#call("resolve-candidates", { request });
  }

  connect(request: ConnectRequest): Promise<ConnectResult> {
    return this.#call("connect", { request });
  }

  async disconnect(reason?: string): Promise<void> {
    await this.#call("disconnect", reason === undefined ? {} : { reason });
  }

  startOperation(request: OperationRequest): Promise<OperationHandle> {
    return this.#call("start-operation", { request });
  }

  awaitOperation(operationId: OperationId): Promise<OperationResult> {
    return this.#call("await-operation", { operationId });
  }

  async acknowledgeOperation(operationId: OperationId): Promise<void> {
    await this.#call("acknowledge-operation", { operationId });
  }

  async cancelOperation(operationId: OperationId): Promise<void> {
    await this.#call("cancel-operation", { operationId });
  }

  subscribe(
    listener: (event: RpcSessionEvent) => void,
    options?: SubscriptionOptions,
  ): SessionSubscription {
    const subscriptionId = this.#subscriptionId();
    this.#eventDelivery.subscribe(subscriptionId, listener);
    void this.#call("subscribe", options === undefined
      ? { subscriptionId }
      : { subscriptionId, options }).catch(() => this.#eventDelivery.unsubscribe(subscriptionId));
    let disposed = false;
    return {
      subscriptionId,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#eventDelivery.unsubscribe(subscriptionId);
        this.#requestUnsubscribe(subscriptionId);
      },
    };
  }

  subscribeDiagnostics(
    listener: (batch: DiagnosticBatch) => void,
    options?: DiagnosticSubscriptionOptions,
  ): Disposable {
    const subscriptionId = this.#subscriptionId();
    this.#diagnosticListeners.set(subscriptionId, listener);
    void this.#call("subscribe-diagnostics", options === undefined
      ? { subscriptionId }
      : { subscriptionId, options }).catch(() => this.#diagnosticListeners.delete(subscriptionId));
    return this.#subscription(subscriptionId, this.#diagnosticListeners);
  }

  inspectTransferCheckpoint(checkpointId: CheckpointId): Promise<CheckpointAssurance> {
    return this.#call("inspect-checkpoint", { checkpointId });
  }

  resumeTransfer(request: ResumeTransferRequest): Promise<ResumeTransferResult> {
    return this.#call("resume-transfer", { request });
  }

  openRawTerminal(subscriptionId: SubscriptionId): Promise<RawTerminalHandle> {
    return this.#call("open-raw-terminal", { subscriptionId });
  }

  writeRawTerminal(terminalId: RawTerminalId, bytes: Uint8Array): Promise<WriteReceipt> {
    return this.#call("write-raw-terminal", { terminalId, bytes });
  }

  exitRawTerminal(terminalId: RawTerminalId): Promise<RawTerminalExitResult> {
    return this.#call("exit-raw-terminal", { terminalId });
  }

  startCapture(destinationId: CaptureDestinationId, options: CaptureOptions): Promise<CaptureId> {
    return this.#call("start-capture", { destinationId, options });
  }

  stopCapture(captureId: CaptureId): Promise<CaptureSummary> {
    return this.#call("stop-capture", { captureId });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const heartbeat of this.#heartbeats.values()) heartbeat.dispose();
    this.#heartbeats.clear();
    this.#eventDelivery.clear();
    this.#diagnosticListeners.clear();
    await this.#adapter.close();
  }

  async #call<K extends SessionRpcMethod>(
    kind: K,
    params: SessionRpcParams<K>,
  ): Promise<SessionRpcResult<K>> {
    if (this.#closed) throw new SessionRpcClosedError("session RPC client is closed");
    const callId = `call-${this.#nextCall++}` as RpcCallId;
    const request = { kind, callId, params } as RequestFor<K>;
    const response = await this.#adapter.request(request);
    if (response.kind === "error") throw new SessionRpcError(response.error);
    return (response as Extract<SessionRpcResponse, { readonly kind: "ok"; readonly method: K }>).result;
  }

  #subscriptionId(): SubscriptionId {
    return `subscription-${this.#nextSubscription++}` as SubscriptionId;
  }

  #startHeartbeat(clientId: ClientId, policy: ClientLeasePolicy): void {
    this.#heartbeats.get(clientId)?.dispose();
    let sequence = 0;
    const heartbeat = this.#clock.interval(policy.heartbeatIntervalMs, () => {
      sequence += 1;
      void this.#call("client-heartbeat", { clientId, sequence }).catch((cause) => {
        try {
          this.#onHeartbeatError?.(clientId, cause);
        } catch {
          // Reporting a failed heartbeat must not create a second failure.
        }
      });
    });
    this.#heartbeats.set(clientId, heartbeat);
  }

  #subscription<T>(subscriptionId: SubscriptionId, listeners: Map<SubscriptionId, T>): Disposable {
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(subscriptionId);
        this.#requestUnsubscribe(subscriptionId);
      },
    };
  }

  #requestUnsubscribe(subscriptionId: SubscriptionId): void {
    if (this.#closed) return;
    void this.#call("unsubscribe", { subscriptionId }).catch(() => {
      // Disposal is already complete locally. If the boundary is gone there
      // is no peer left to notify, and cleanup must not reject out of band.
    });
  }

  async #pumpEvents(): Promise<void> {
    for await (const message of this.#adapter.events) {
      if (this.#closed) return;
      if (message.kind === "event") {
        this.#eventDelivery.publishTo(message.subscriptionId, message.event);
      } else if (message.kind === "diagnostics") {
        const listener = this.#diagnosticListeners.get(message.subscriptionId);
        if (listener !== undefined) {
          queueMicrotask(() => {
            if (this.#diagnosticListeners.get(message.subscriptionId) !== listener) return;
            void Promise.resolve().then(() => listener(message.batch)).catch((cause) => {
              try {
                this.#onDiagnosticListenerError?.(message.subscriptionId, cause);
              } catch {
                // Diagnostic rendering errors cannot abort lifecycle delivery.
              }
            });
          });
        }
      } else if (message.kind === "subscriber-evicted") {
        this.#eventDelivery.terminate(message.subscriptionId, message.reason);
        this.#diagnosticListeners.delete(message.subscriptionId);
      }
    }
  }
}
