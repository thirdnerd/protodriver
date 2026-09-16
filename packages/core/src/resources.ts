import type {
  BrokerCall,
  BrokerCallId,
  BrokerCallOptions,
  HostByteSink,
  HostByteSource,
  OperationId,
  PdrError,
  ResourceBrokerClient,
  ResourceDescriptor,
  ResourceId,
  ResourceReadResult,
  ResourceReadGrant,
  ResourceRegistrar,
  ResourceRpcRequest,
  ResourceRpcResponse,
  ResourceScope,
  SessionId,
} from "@protodriver/contracts";
import {
  DEFAULT_PHASE_ONE_LIMITS,
  HostResourceLimitError,
  snapshotPlatformCause,
} from "@protodriver/core/limits";

type ResourceKind = "source" | "sink";

interface ResourceEntry {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  readonly scope: ResourceScope;
  readonly registrationOrder: number;
  readonly source?: HostByteSource;
  readonly sink?: HostByteSink;
  readGrant?: ResourceReadGrant;
  writeGrant?: { id: string; maximumBytes: number; submitted: number; failed?: boolean };
  written?: boolean;
  grantedReadBytes?: number;
  rewound?: boolean;
  streamOffset?: number;
  bufferedRead?: {
    readonly data: ArrayBuffer;
    readonly eof: boolean;
    offset: number;
  };
}

interface PendingResourceCall {
  cancelled: boolean;
  settled: boolean;
}

export interface ResourceBrokerMetrics {
  readonly currentReadBufferBytes: number;
  readonly highWaterReadBufferBytes: number;
  readonly openResources: number;
  readonly callsInFlight: number;
}

export interface ResourceShutdownReport {
  readonly outstandingHostResources: readonly ResourceId[];
}

export class ResourceBrokerError extends Error {
  readonly error: PdrError;

  constructor(error: PdrError) {
    super(error.message);
    this.name = "ResourceBrokerError";
    this.error = error;
  }
}

/** A sink uses this when it knows that rejection followed partial acceptance. */
export class PartialResourceWriteError extends Error {
  readonly knownAcceptedBytes: number;
  readonly requestedBytes: number;

  constructor(knownAcceptedBytes: number, requestedBytes: number, message = "resource write was partial") {
    super(message);
    this.name = "PartialResourceWriteError";
    this.knownAcceptedBytes = requireNonNegativeSafeInteger(knownAcceptedBytes, "knownAcceptedBytes");
    this.requestedBytes = requireNonNegativeSafeInteger(requestedBytes, "requestedBytes");
    if (knownAcceptedBytes >= requestedBytes) {
      throw new RangeError("a partial write must accept fewer bytes than requested");
    }
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function pdrError(code: string, message: string, details?: PdrError["details"]): PdrError {
  return {
    code,
    message,
    responsibility: "operation",
    retryability: "no",
    ...(details === undefined ? {} : { details }),
  };
}

function causeSnapshot(cause: unknown): PdrError["platformCause"] | undefined {
  if (!(cause instanceof Error)) return undefined;
  return snapshotPlatformCause(cause);
}

function failure(cause: unknown, operation: string): PdrError {
  if (cause instanceof ResourceBrokerError) return cause.error;
  if (cause instanceof PartialResourceWriteError) {
    const base = pdrError(
      "resource.partial-write",
      cause.message,
      {
        knownAcceptedBytes: cause.knownAcceptedBytes,
        requestedBytes: cause.requestedBytes,
      },
    );
    const platformCause = causeSnapshot(cause);
    return platformCause === undefined ? { ...base, responsibility: "host" } : { ...base, responsibility: "host", platformCause };
  }
  const base = pdrError(
    `resource.${operation}-failed`,
    cause instanceof Error ? cause.message : String(cause),
  );
  const platformCause = causeSnapshot(cause);
  return platformCause === undefined ? { ...base, responsibility: "host" } : { ...base, responsibility: "host", platformCause };
}

function responseError(callId: BrokerCallId, error: PdrError): ResourceRpcResponse {
  return { kind: "error", callId, error };
}

function sameSession(scope: ResourceScope, sessionId: SessionId): boolean {
  return scope.kind !== "host" && scope.sessionId === sessionId;
}

/**
 * Host-side owner of live resources. Its registrar facet is local; handle()
 * is the DTO boundary consumed by direct or postMessage adapters.
 */
export class ResourceBrokerHost implements ResourceRegistrar {
  readonly #namespace = crypto.randomUUID();
  readonly #resources = new Map<ResourceId, ResourceEntry>();
  readonly #callsById = new Map<BrokerCallId, PendingResourceCall>();
  readonly #callByResource = new Map<ResourceId, BrokerCallId>();
  readonly #maximumOpenResources: number;
  readonly #maximumOutstandingCalls: number;
  readonly #maximumChunkBytes: number;
  #nextResource = 1;
  #nextRegistrationOrder = 1;
  #currentReadBufferBytes = 0;
  #highWaterReadBufferBytes = 0;

  constructor(options: ResourceBrokerHostOptions = {}) {
    this.#maximumOpenResources = options.maximumOpenResources
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumOpenResources;
    this.#maximumOutstandingCalls = options.maximumOutstandingCalls
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumOutstandingBrokerCalls;
    this.#maximumChunkBytes = options.maximumChunkBytes
      ?? DEFAULT_PHASE_ONE_LIMITS.maximumResourceChunkBytes;
  }

  get metrics(): ResourceBrokerMetrics {
    return {
      currentReadBufferBytes: this.#currentReadBufferBytes,
      highWaterReadBufferBytes: this.#highWaterReadBufferBytes,
      openResources: this.#resources.size,
      callsInFlight: this.#callsById.size,
    };
  }

  async registerSource(source: HostByteSource, scope: ResourceScope): Promise<ResourceId> {
    return this.#register({ kind: "source", source, scope });
  }

  async registerSink(sink: HostByteSink, scope: ResourceScope): Promise<ResourceId> {
    return this.#register({ kind: "sink", sink, scope });
  }

  async outstanding(): Promise<readonly ResourceId[]> {
    return [...this.#resources.values()]
      .filter(({ scope }) => scope.kind === "host")
      .sort((left, right) => left.registrationOrder - right.registrationOrder)
      .map(({ id }) => id);
  }

  async handle(request: ResourceRpcRequest): Promise<ResourceRpcResponse> {
    const callId = request.call.callId;
    if (this.#callsById.has(callId)) {
      return responseError(callId, pdrError(
        "resource.call-id-in-use",
        `broker call id ${callId} is already in flight`,
      ));
    }

    if (request.kind === "cancel") return this.#cancel(request);
    if (request.kind === "close" && !this.#resources.has(request.id)) {
      return { kind: "ok", callId };
    }

    const entry = this.#resources.get(request.id);
    if (entry === undefined) {
      return responseError(callId, pdrError(
        "resource.unknown-id",
        `resource ${request.id} is not open`,
      ));
    }
    if (entry.readGrant && request.kind !== "release-read" && request.call.readGrantId !== entry.readGrant.id) {
      return responseError(callId, pdrError("resource.delegated", "source is exclusively delegated to " + entry.readGrant.operationId));
    }
    if (request.call.readGrantId !== undefined && request.call.readGrantId !== entry.readGrant?.id) {
      return responseError(callId, pdrError("resource.stale-grant", "read delegation is unavailable"));
    }
    if (request.kind === "read" && request.maximumBytes > this.#maximumChunkBytes) {
      return responseError(callId, new HostResourceLimitError(
        "resource.chunk-too-large",
        "maximumResourceChunkBytes",
        this.#maximumChunkBytes,
        request.maximumBytes,
        "resource",
      ).error);
    }
    if (request.kind === "write" && request.data.byteLength > this.#maximumChunkBytes) {
      return responseError(callId, new HostResourceLimitError(
        "resource.chunk-too-large",
        "maximumResourceChunkBytes",
        this.#maximumChunkBytes,
        request.data.byteLength,
        "resource",
      ).error);
    }
    const active = this.#callByResource.get(request.id);
    if (active !== undefined) {
      return responseError(callId, pdrError(
        "resource.call-in-flight",
        `resource ${request.id} already has call ${active} in flight`,
        { resourceId: request.id, holderCallId: active },
      ));
    }
    if (this.#callsById.size >= this.#maximumOutstandingCalls) {
      return responseError(callId, new HostResourceLimitError(
        "resource.outstanding-call-limit",
        "maximumOutstandingBrokerCalls",
        this.#maximumOutstandingCalls,
        this.#callsById.size + 1,
        "resource",
      ).error);
    }

    const pending: PendingResourceCall = {
      cancelled: false,
      settled: false,
    };
    this.#callsById.set(callId, pending);
    this.#callByResource.set(request.id, callId);
    try {
      const response = await this.#execute(entry, request);
      pending.settled = true;
      // A read is observational and its chunk can be retained atomically.
      // Side-effecting calls cannot honestly be called cancelled after their
      // host method resolved, so their settled outcome wins.
      if (pending.cancelled && request.kind === "read" && !entry.readGrant) {
        if (response.kind === "read") this.#stageRead(entry, response.result);
        return responseError(callId, pdrError(
          "resource.cancelled",
          `resource call ${callId} was cancelled before completion`,
        ));
      }
      return response;
    } catch (cause) {
      pending.settled = true;
      if (pending.cancelled && request.kind === "read") {
        return responseError(callId, pdrError(
          "resource.cancelled",
          `resource call ${callId} was cancelled before completion`,
        ));
      }
      return responseError(callId, failure(cause, request.kind));
    } finally {
      this.#callsById.delete(callId);
      this.#callByResource.delete(request.id);
    }
  }

  async endOperation(sessionId: SessionId, operationId: OperationId): Promise<void> {
    this.#throwCloseFailures(await this.#closeMatching(({ scope }) => scope.kind === "operation"
      && scope.sessionId === sessionId
      && scope.operationId === operationId));
  }

  async endSession(sessionId: SessionId): Promise<ResourceShutdownReport> {
    const failures = [
      ...await this.#closeMatching(({ scope }) => scope.kind === "operation" && sameSession(scope, sessionId)),
      ...await this.#closeMatching(({ scope }) => scope.kind === "session" && sameSession(scope, sessionId)),
    ];
    this.#throwCloseFailures(failures);
    return { outstandingHostResources: await this.outstanding() };
  }

  async shutdown(): Promise<ResourceShutdownReport> {
    const failures = [
      ...await this.#closeMatching(({ scope }) => scope.kind === "operation"),
      ...await this.#closeMatching(({ scope }) => scope.kind === "session"),
    ];
    this.#throwCloseFailures(failures);
    return { outstandingHostResources: await this.outstanding() };
  }

  async closeResource(id: ResourceId): Promise<void> {
    const entry = this.#resources.get(id);
    if (entry === undefined) return;
    if (this.#callByResource.has(id)) {
      throw new ResourceBrokerError(pdrError(
        "resource.call-in-flight",
        `resource ${id} has a call in flight`,
      ));
    }
    await this.#closeEntry(entry);
  }

  #register(options: {
    readonly kind: ResourceKind;
    readonly source?: HostByteSource;
    readonly sink?: HostByteSink;
    readonly scope: ResourceScope;
  }): ResourceId {
    if (this.#resources.size >= this.#maximumOpenResources) {
      throw new HostResourceLimitError(
        "resource.open-limit",
        "maximumOpenResources",
        this.#maximumOpenResources,
        this.#resources.size + 1,
        "resource",
      );
    }
    const id = `resource-${this.#namespace}-${this.#nextResource++}` as ResourceId;
    this.#resources.set(id, {
      id,
      kind: options.kind,
      scope: options.scope,
      registrationOrder: this.#nextRegistrationOrder++,
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(options.sink === undefined ? {} : { sink: options.sink }),
    });
    return id;
  }

  #cancel(request: Extract<ResourceRpcRequest, { readonly kind: "cancel" }>): ResourceRpcResponse {
    const pending = this.#callsById.get(request.targetCallId);
    if (pending !== undefined && !pending.settled) pending.cancelled = true;
    return { kind: "ok", callId: request.call.callId };
  }

  async #execute(entry: ResourceEntry, request: Exclude<ResourceRpcRequest, { readonly kind: "cancel" }>): Promise<ResourceRpcResponse> {
    const callId = request.call.callId;
    switch (request.kind) {
      case "grant-write": {
        if (entry.kind !== "sink") throw new ResourceBrokerError(pdrError("resource.wrong-kind", "streamed output requires a sink"));
        if (entry.scope.kind === "operation" && entry.scope.operationId !== request.operationId)
          throw new ResourceBrokerError(pdrError("resource.wrong-owner", "sink belongs to another operation"));
        if (typeof request.operationId !== "string" || !request.operationId || request.operationId.length > 256 || !Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 1)
          throw new ResourceBrokerError(pdrError("resource.write-grant", "finite operation output extent required"));
        if (entry.written || entry.writeGrant) throw new ResourceBrokerError(pdrError("resource.destination-used", "streamed result requires a fresh destination"));
        entry.writeGrant = { id: callId, maximumBytes: request.maximumBytes, submitted: 0 };
        return { kind: "write-granted", callId, grantId: callId };
      }
      case "grant-stream":
      case "grant-read": {
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError("resource.wrong-kind", "bounded input requires a source"));
        if (entry.scope.kind === "operation" && entry.scope.operationId !== request.operationId)
          throw new ResourceBrokerError(pdrError("resource.wrong-owner", "source belongs to another operation"));
        const maximumBytes = requireNonNegativeSafeInteger(request.maximumBytes, "maximumBytes");
        if ((request.kind === "grant-read" && maximumBytes > 65537) || maximumBytes >= Number.MAX_SAFE_INTEGER || !request.operationId || request.operationId.length > 256)
          throw new ResourceBrokerError(pdrError("resource.read-grant", "bounded operation read grant required"));
        if (entry.readGrant) throw new ResourceBrokerError(pdrError("resource.delegated", "source already delegated"));
        const grant: ResourceReadGrant = { id: callId, operationId: request.operationId, maximumBytes,
          ...(request.kind === "grant-stream" ? { streaming: true as const } : {}),
          byteLength: entry.source!.byteLength, seekable: entry.source!.seek !== undefined,
          origin: entry.source!.origin ?? "other", scope: entry.scope.kind };
        entry.readGrant = grant; entry.grantedReadBytes = 0; entry.rewound = false;
        return { kind: "read-granted", callId, grant };
      }
      case "release-read": {
        if (!entry.readGrant || entry.readGrant.id !== request.grantId)
          throw new ResourceBrokerError(pdrError("resource.stale-grant", "read delegation is unavailable"));
        delete entry.readGrant; delete entry.grantedReadBytes; delete entry.rewound; delete entry.streamOffset;
        if (entry.scope.kind === "operation") await this.#closeEntry(entry, callId);
        return { kind: "ok", callId };
      }
      case "describe":
        return {
          kind: "described",
          callId,
          descriptor: entry.kind === "source"
            ? {
                byteLength: entry.source!.byteLength,
                seekable: entry.source!.seek !== undefined,
              }
            : { byteLength: undefined, seekable: false },
        };
      case "read": {
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a source`,
        ));
        const maximumBytes = requireNonNegativeSafeInteger(request.maximumBytes, "maximumBytes");
        if (maximumBytes === 0) throw new RangeError("maximumBytes must be greater than zero");
        if (entry.readGrant) {
          if (!entry.rewound || (entry.readGrant.streaming
            ? maximumBytes > 256 || maximumBytes > entry.readGrant.maximumBytes + 1 - (entry.streamOffset ?? 0)
            : maximumBytes > entry.readGrant.maximumBytes - entry.grantedReadBytes!))
            throw new ResourceBrokerError(pdrError("resource.read-grant-exhausted", "read exceeds the reserved operation range or has no origin"));
          // Debit requested capacity before native submission, including EOF
          // probes. Short reads refund only what demonstrably did not arrive.
          entry.grantedReadBytes! += maximumBytes;
        }
        if (entry.bufferedRead !== undefined) {
          return { kind: "read", callId, result: this.#takeBufferedRead(entry, maximumBytes) };
        }
        const workspace = new Uint8Array(maximumBytes);
        this.#retainReadBuffer(maximumBytes);
        try {
          const result = await entry.source!.read(workspace);
          const bytesRead = requireNonNegativeSafeInteger(result.bytesRead, "bytesRead");
          if (bytesRead > maximumBytes) {
            throw new RangeError(`source reported ${bytesRead} bytes into a ${maximumBytes}-byte buffer`);
          }
          if (entry.readGrant) entry.grantedReadBytes! -= maximumBytes - bytesRead;
          if (entry.readGrant?.streaming) entry.streamOffset = (entry.streamOffset ?? 0) + bytesRead;
          let data: ArrayBuffer;
          if (bytesRead === maximumBytes) {
            data = workspace.buffer;
          } else {
            // Both allocations coexist briefly; account for that overlap so
            // the high-water figure describes the failure-prone instant.
            this.#retainReadBuffer(bytesRead);
            try {
              data = workspace.buffer.slice(0, bytesRead);
            } finally {
              this.#releaseReadBuffer(bytesRead);
            }
          }
          return { kind: "read", callId, result: { data, eof: result.eof } };
        } finally {
          this.#releaseReadBuffer(maximumBytes);
        }
      }
      case "seek":
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a source`,
        ));
        if (entry.source!.seek === undefined) throw new ResourceBrokerError(pdrError(
          "resource.not-seekable",
          `resource ${entry.id} is not seekable`,
        ));
        if (entry.readGrant && !entry.readGrant.streaming && (request.offset !== 0 || entry.rewound))
          throw new ResourceBrokerError(pdrError("resource.read-origin", "bounded grant permits exactly one initial rewind"));
        if (entry.readGrant?.streaming && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > entry.readGrant.maximumBytes))
          throw new ResourceBrokerError(pdrError("resource.read-origin", "stream seek exceeds delegated source domain"));
        this.#discardBufferedRead(entry);
        await entry.source!.seek(requireNonNegativeSafeInteger(request.offset, "offset"));
        if (entry.readGrant) entry.rewound = true;
        if (entry.readGrant?.streaming) entry.streamOffset = request.offset;
        return { kind: "ok", callId };
      case "write":
        if (entry.kind !== "sink") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a sink`,
        ));
        if (entry.writeGrant) {
          const g = entry.writeGrant;
          if (g.failed || request.call.writeGrantId !== g.id || request.data.byteLength > 256 || request.data.byteLength > g.maximumBytes - g.submitted)
            throw new ResourceBrokerError(pdrError("resource.write-grant", "write is outside its append grant"));
          g.submitted += request.data.byteLength; // failure/partial acceptance never refunds authority
        } else if (request.call.writeGrantId) throw new ResourceBrokerError(pdrError("resource.stale-grant", "write grant is unavailable"));
        entry.written = true;
        try { await entry.sink!.write(new Uint8Array(request.data)); }
        catch (cause) { if (entry.writeGrant) entry.writeGrant.failed = true; throw cause; }
        return { kind: "ok", callId };
      case "close":
        await this.#closeEntry(entry, callId);
        return { kind: "ok", callId };
    }
  }

  async #closeMatching(predicate: (entry: ResourceEntry) => boolean): Promise<unknown[]> {
    const entries = [...this.#resources.values()]
      .filter(predicate)
      .sort((left, right) => left.registrationOrder - right.registrationOrder);
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        await this.#closeEntry(entry);
      } catch (cause) {
        failures.push(cause);
      }
    }
    return failures;
  }

  #throwCloseFailures(failures: readonly unknown[]): void {
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more resources failed to close");
    }
  }

  async #closeEntry(entry: ResourceEntry, allowedCallId?: BrokerCallId): Promise<void> {
    if (!this.#resources.has(entry.id)) return;
    const activeCallId = this.#callByResource.get(entry.id);
    if (activeCallId !== undefined && activeCallId !== allowedCallId) {
      throw new ResourceBrokerError(pdrError(
        "resource.call-in-flight",
        `resource ${entry.id} has a call in flight`,
      ));
    }
    await (entry.kind === "source" ? entry.source!.close() : entry.sink!.close());
    this.#discardBufferedRead(entry);
    this.#resources.delete(entry.id);
  }

  #stageRead(entry: ResourceEntry, result: ResourceReadResult): void {
    if (entry.bufferedRead !== undefined) {
      throw new Error(`resource ${entry.id} already has a buffered read`);
    }
    entry.bufferedRead = { data: result.data, eof: result.eof, offset: 0 };
    this.#retainReadBuffer(result.data.byteLength);
  }

  #takeBufferedRead(entry: ResourceEntry, maximumBytes: number): ResourceReadResult {
    const buffered = entry.bufferedRead!;
    const remaining = buffered.data.byteLength - buffered.offset;
    const bytesRead = Math.min(remaining, maximumBytes);
    const finishesBuffer = bytesRead === remaining;
    let data: ArrayBuffer;
    if (buffered.offset === 0 && finishesBuffer) {
      data = buffered.data;
    } else {
      this.#retainReadBuffer(bytesRead);
      try {
        data = buffered.data.slice(buffered.offset, buffered.offset + bytesRead);
      } finally {
        this.#releaseReadBuffer(bytesRead);
      }
    }
    buffered.offset += bytesRead;
    if (finishesBuffer) {
      this.#releaseReadBuffer(buffered.data.byteLength);
      delete entry.bufferedRead;
    }
    return { data, eof: finishesBuffer && buffered.eof };
  }

  #discardBufferedRead(entry: ResourceEntry): void {
    if (entry.bufferedRead === undefined) return;
    this.#releaseReadBuffer(entry.bufferedRead.data.byteLength);
    delete entry.bufferedRead;
  }

  #retainReadBuffer(bytes: number): void {
    this.#currentReadBufferBytes += bytes;
    this.#highWaterReadBufferBytes = Math.max(
      this.#highWaterReadBufferBytes,
      this.#currentReadBufferBytes,
    );
  }

  #releaseReadBuffer(bytes: number): void {
    this.#currentReadBufferBytes -= bytes;
  }
}

export interface ResourceBrokerHostOptions {
  readonly maximumOpenResources?: number;
  readonly maximumOutstandingCalls?: number;
  readonly maximumChunkBytes?: number;
}

export interface ResourceRpcAdapter {
  request(request: ResourceRpcRequest): Promise<ResourceRpcResponse>;
  close(): Promise<void>;
}

export interface ResourcePostMessageEndpoint {
  postMessage(message: ResourceRpcRequest | ResourceRpcResponse, transfer?: readonly Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ResourceRpcRequest | ResourceRpcResponse>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<ResourceRpcRequest | ResourceRpcResponse>) => void,
  ): void;
  start?(): void;
  close?(): void;
}

export class DirectResourceRpcAdapter implements ResourceRpcAdapter {
  readonly #host: ResourceBrokerHost;
  #closed = false;

  constructor(host: ResourceBrokerHost) {
    this.#host = host;
  }

  async request(request: ResourceRpcRequest): Promise<ResourceRpcResponse> {
    if (this.#closed) throw new Error("resource RPC adapter is closed");
    await Promise.resolve();
    if (this.#closed) throw new Error("resource RPC adapter is closed");
    return this.#host.handle(request);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

interface PendingResponse {
  readonly resolve: (response: ResourceRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

function isResourceResponse(message: ResourceRpcRequest | ResourceRpcResponse): message is ResourceRpcResponse {
  return message.kind === "described" || message.kind === "read-granted" || message.kind === "write-granted" || message.kind === "ok" || message.kind === "error"
    || (message.kind === "read" && "result" in message);
}

export class PostMessageResourceRpcAdapter implements ResourceRpcAdapter {
  readonly #endpoint: ResourcePostMessageEndpoint;
  readonly #pending = new Map<BrokerCallId, PendingResponse>();
  readonly #onMessage: (event: MessageEvent<ResourceRpcRequest | ResourceRpcResponse>) => void;
  #closed = false;

  constructor(endpoint: ResourcePostMessageEndpoint) {
    this.#endpoint = endpoint;
    this.#onMessage = ({ data }) => this.#receive(data);
    endpoint.addEventListener("message", this.#onMessage);
    endpoint.start?.();
  }

  request(request: ResourceRpcRequest): Promise<ResourceRpcResponse> {
    if (this.#closed) return Promise.reject(new Error("resource RPC adapter is closed"));
    if (this.#pending.has(request.call.callId)) {
      return Promise.reject(new Error(`duplicate pending broker call ${request.call.callId}`));
    }
    return new Promise<ResourceRpcResponse>((resolve, reject) => {
      this.#pending.set(request.call.callId, { resolve, reject });
      try {
        const transfer = request.kind === "write" ? [request.data] : undefined;
        this.#endpoint.postMessage(request, transfer);
      } catch (cause) {
        this.#pending.delete(request.call.callId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.close?.();
    for (const pending of this.#pending.values()) pending.reject(new Error("resource RPC adapter is closed"));
    this.#pending.clear();
  }

  #receive(message: ResourceRpcRequest | ResourceRpcResponse): void {
    if (!isResourceResponse(message)) return;
    const pending = this.#pending.get(message.callId);
    if (pending === undefined) return;
    this.#pending.delete(message.callId);
    pending.resolve(message);
  }
}

export function serveResourceRpc(
  endpoint: ResourcePostMessageEndpoint,
  host: ResourceBrokerHost,
): { dispose(): void } {
  let closed = false;
  const onMessage = ({ data }: MessageEvent<ResourceRpcRequest | ResourceRpcResponse>) => {
    if (closed || isResourceResponse(data)) return;
    void host.handle(data).then((response) => {
      if (closed) return;
      const transfer = response.kind === "read" ? [response.result.data] : undefined;
      endpoint.postMessage(response, transfer);
    });
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();
  return {
    dispose() {
      if (closed) return;
      closed = true;
      endpoint.removeEventListener("message", onMessage);
      endpoint.close?.();
    },
  };
}

export class ResourceBrokerRpcClient implements ResourceBrokerClient {
  readonly #adapter: ResourceRpcAdapter;
  #nextControlCall = 1;

  constructor(adapter: ResourceRpcAdapter) {
    this.#adapter = adapter;
  }

  async describe(id: ResourceId): Promise<ResourceDescriptor> {
    const response = await this.#request({ kind: "describe", call: this.#controlCall(), id });
    if (response.kind !== "described") throw new Error(`describe returned ${response.kind}`);
    return response.descriptor;
  }
  async grantRead(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadGrant> {
    const response = await this.#request({ kind: "grant-read", id, operationId, maximumBytes, call });
    if (response.kind !== "read-granted") throw new Error(`grant-read returned ${response.kind}`);
    return response.grant;
  }
  async grantStream(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadGrant> {
    const response = await this.#request({ kind: "grant-stream", id, operationId, maximumBytes, call });
    if (response.kind !== "read-granted") throw new Error(`grant-stream returned ${response.kind}`);
    return response.grant;
  }
  async grantWrite(id: ResourceId, operationId: OperationId, maximumBytes: number, call: BrokerCall): Promise<string> {
    const response = await this.#request({ kind: "grant-write", id, operationId, maximumBytes, call });
    if (response.kind !== "write-granted") throw new Error(`grant-write returned ${response.kind}`);
    return response.grantId;
  }
  async releaseRead(id: ResourceId, grantId: string, call: BrokerCall): Promise<void> {
    const response = await this.#request({ kind: "release-read", id, grantId, call });
    if (response.kind !== "ok") throw new Error(`release-read returned ${response.kind}`);
  }

  async read(id: ResourceId, maximumBytes: number, call: BrokerCall): Promise<ResourceReadResult> {
    const response = await this.#requestWithSignal(
      { kind: "read", call: { callId: call.callId, ...(call.readGrantId ? { readGrantId: call.readGrantId } : {}) }, id, maximumBytes },
      (call as BrokerCallOptions).signal,
    );
    if (response.kind !== "read") throw new Error(`read returned ${response.kind}`);
    return response.result;
  }

  async seek(id: ResourceId, offset: number, call: BrokerCall): Promise<void> {
    const response = await this.#requestWithSignal(
      { kind: "seek", call: { callId: call.callId, ...(call.readGrantId ? { readGrantId: call.readGrantId } : {}) }, id, offset },
      (call as BrokerCallOptions).signal,
    );
    if (response.kind !== "ok") throw new Error(`seek returned ${response.kind}`);
  }

  async write(id: ResourceId, data: ArrayBuffer, call: BrokerCall): Promise<void> {
    const response = await this.#requestWithSignal(
      { kind: "write", call: { callId: call.callId, ...(call.writeGrantId ? { writeGrantId: call.writeGrantId } : {}) }, id, data },
      (call as BrokerCallOptions).signal,
    );
    if (response.kind !== "ok") throw new Error(`write returned ${response.kind}`);
  }

  async cancel(callId: BrokerCallId): Promise<void> {
    const response = await this.#request({
      kind: "cancel",
      call: this.#controlCall(),
      targetCallId: callId,
    });
    if (response.kind !== "ok") throw new Error(`cancel returned ${response.kind}`);
  }

  async close(id: ResourceId): Promise<void> {
    const response = await this.#request({ kind: "close", call: this.#controlCall(), id });
    if (response.kind !== "ok") throw new Error(`close returned ${response.kind}`);
  }

  async closeAdapter(): Promise<void> {
    await this.#adapter.close();
  }

  async #requestWithSignal(
    request: ResourceRpcRequest,
    signal: AbortSignal | undefined,
  ): Promise<ResourceRpcResponse> {
    const pending = this.#request(request);
    if (signal === undefined) return pending;
    const cancel = () => {
      void this.cancel(request.call.callId).catch(() => {
        // Best effort by contract. The authoritative request still settles
        // with its own result or boundary failure.
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      return await pending;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async #request(request: ResourceRpcRequest): Promise<ResourceRpcResponse> {
    const response = await this.#adapter.request(request);
    if (response.callId !== request.call.callId) {
      throw new Error(`broker response ${response.callId} does not match ${request.call.callId}`);
    }
    if (response.kind === "error") throw new ResourceBrokerError(response.error);
    return response;
  }

  #controlCall(): BrokerCall {
    return { callId: `broker-control-${this.#nextControlCall++}` as BrokerCallId };
  }
}
