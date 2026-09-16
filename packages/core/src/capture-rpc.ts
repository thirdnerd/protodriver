import type {
  CaptureDestinationId,
  CaptureDestinationRegistrar,
  CaptureRpcRequest,
  CaptureRpcResponse,
  HostCaptureDestination,
  PdrError,
  ResourceId,
  SessionId,
} from "@protodriver/contracts";
import {
  DEFAULT_PHASE_ONE_LIMITS,
  HostResourceLimitError,
  snapshotPlatformCause,
} from "@protodriver/core/limits";
import { assertCapturePartName } from "./capture-path.ts";

interface DestinationEntry {
  readonly id: CaptureDestinationId;
  readonly destination: HostCaptureDestination;
  readonly sessionId: SessionId;
  partsOpened: number;
}

function causeSnapshot(cause: unknown): PdrError["platformCause"] | undefined {
  if (!(cause instanceof Error)) return undefined;
  return snapshotPlatformCause(cause);
}

function captureError(code: string, message: string, cause?: unknown): PdrError {
  const platformCause = causeSnapshot(cause);
  return {
    code,
    message,
    responsibility: "host",
    retryability: "no",
    ...(platformCause === undefined ? {} : { platformCause }),
  };
}

/** Main-thread owner of method-bearing capture destinations. */
export class CaptureDestinationRegistry implements CaptureDestinationRegistrar {
  readonly #destinations = new Map<CaptureDestinationId, DestinationEntry>();
  readonly #maximumPartsPerDestination: number;
  #nextId = 1;

  constructor(maximumPartsPerDestination = DEFAULT_PHASE_ONE_LIMITS.maximumCaptureParts) {
    this.#maximumPartsPerDestination = maximumPartsPerDestination;
  }

  get size(): number {
    return this.#destinations.size;
  }

  async register(
    destination: HostCaptureDestination,
    sessionId: SessionId,
  ): Promise<CaptureDestinationId> {
    const id = `capture-destination-${this.#nextId++}` as CaptureDestinationId;
    this.#destinations.set(id, { id, destination, sessionId, partsOpened: 0 });
    return id;
  }

  async release(id: CaptureDestinationId): Promise<void> {
    this.#destinations.delete(id);
  }

  async handle(
    request: CaptureRpcRequest,
    sessionId: SessionId,
  ): Promise<CaptureRpcResponse> {
    const entry = this.#destinations.get(request.destinationId);
    if (entry === undefined || entry.sessionId !== sessionId) {
      return {
        kind: "error",
        error: captureError(
          "capture.destination-unknown",
          `capture destination ${request.destinationId} is not registered`,
        ),
      };
    }

    try {
      switch (request.kind) {
        case "open-part": {
          assertCapturePartName(request.name);
          if (entry.partsOpened >= this.#maximumPartsPerDestination) {
            throw new HostResourceLimitError(
              "capture.part-limit",
              "maximumCaptureParts",
              this.#maximumPartsPerDestination,
              entry.partsOpened + 1,
              "capture",
            );
          }
          // Reserve before awaiting storage; otherwise two concurrent opens
          // can both observe the last free slot and cross the cardinality cap.
          entry.partsOpened += 1;
          let resourceId: ResourceId;
          try {
            resourceId = await entry.destination.openPart(
              request.name,
              request.contentType === undefined
                ? undefined
                : { contentType: request.contentType },
            );
          } catch (cause) {
            entry.partsOpened -= 1;
            throw cause;
          }
          return {
            kind: "part-opened",
            resourceId,
          };
        }
        case "commit-destination":
          await entry.destination.commit();
          return { kind: "ok" };
        case "abort-destination":
          await entry.destination.abort(request.error);
          return { kind: "ok" };
      }
    } catch (cause) {
      if (cause instanceof HostResourceLimitError) {
        return { kind: "error", error: cause.error };
      }
      return {
        kind: "error",
        error: captureError(
          `capture.${request.kind}-failed`,
          cause instanceof Error ? cause.message : String(cause),
          cause,
        ),
      };
    }
  }
}

export interface CaptureDestinationRpcAdapter {
  request(request: CaptureRpcRequest): Promise<CaptureRpcResponse>;
  close(): Promise<void>;
}

export class CaptureDestinationRpcError extends Error {
  readonly error: PdrError;

  constructor(error: PdrError) {
    super(error.message);
    this.name = "CaptureDestinationRpcError";
    this.error = error;
  }
}

export class DirectCaptureDestinationRpcAdapter implements CaptureDestinationRpcAdapter {
  readonly #registry: CaptureDestinationRegistry;
  readonly #sessionId: SessionId;
  #closed = false;

  constructor(registry: CaptureDestinationRegistry, sessionId: SessionId) {
    this.#registry = registry;
    this.#sessionId = sessionId;
  }

  request(request: CaptureRpcRequest): Promise<CaptureRpcResponse> {
    if (this.#closed) return Promise.reject(new Error("capture destination RPC is closed"));
    return this.#registry.handle(request, this.#sessionId);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export interface CapturePostMessageEndpoint {
  postMessage(message: CaptureRpcRequest | CaptureRpcResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<CaptureRpcRequest | CaptureRpcResponse>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<CaptureRpcRequest | CaptureRpcResponse>) => void,
  ): void;
  start?(): void;
  close?(): void;
}

function isCaptureResponse(
  message: CaptureRpcRequest | CaptureRpcResponse,
): message is CaptureRpcResponse {
  return message.kind === "part-opened" || message.kind === "ok" || message.kind === "error";
}

/**
 * The capture-control protocol is deliberately one-at-a-time. Its DTOs have
 * no call id, and the recorder itself serializes part creation and finalization.
 */
export class PostMessageCaptureDestinationRpcAdapter implements CaptureDestinationRpcAdapter {
  readonly #endpoint: CapturePostMessageEndpoint;
  readonly #onMessage: (
    event: MessageEvent<CaptureRpcRequest | CaptureRpcResponse>,
  ) => void;
  #pending: {
    readonly resolve: (response: CaptureRpcResponse) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  #closed = false;

  constructor(endpoint: CapturePostMessageEndpoint) {
    this.#endpoint = endpoint;
    this.#onMessage = ({ data }) => {
      if (!isCaptureResponse(data)) return;
      const pending = this.#pending;
      if (pending === undefined) return;
      this.#pending = undefined;
      pending.resolve(data);
    };
    endpoint.addEventListener("message", this.#onMessage);
    endpoint.start?.();
  }

  request(request: CaptureRpcRequest): Promise<CaptureRpcResponse> {
    if (this.#closed) return Promise.reject(new Error("capture destination RPC is closed"));
    if (this.#pending !== undefined) {
      return Promise.reject(new Error("a capture destination call is already in flight"));
    }
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      try {
        this.#endpoint.postMessage(request);
      } catch (cause) {
        this.#pending = undefined;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.close?.();
    this.#pending?.reject(new Error("capture destination RPC is closed"));
    this.#pending = undefined;
  }
}

export function serveCaptureDestinationRpc(
  endpoint: CapturePostMessageEndpoint,
  registry: CaptureDestinationRegistry,
  sessionId: SessionId,
): { dispose(): void } {
  let closed = false;
  const onMessage = ({ data }: MessageEvent<CaptureRpcRequest | CaptureRpcResponse>) => {
    if (closed || isCaptureResponse(data)) return;
    void registry.handle(data, sessionId).then((response) => {
      if (!closed) endpoint.postMessage(response);
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

/** Worker-side method-bearing proxy. Only its destination id crosses. */
export class RemoteCaptureDestination implements HostCaptureDestination {
  readonly #id: CaptureDestinationId;
  readonly #adapter: CaptureDestinationRpcAdapter;

  constructor(id: CaptureDestinationId, adapter: CaptureDestinationRpcAdapter) {
    this.#id = id;
    this.#adapter = adapter;
  }

  async openPart(
    name: string,
    options?: { readonly contentType?: string },
  ): Promise<ResourceId> {
    const response = await this.#adapter.request({
      kind: "open-part",
      destinationId: this.#id,
      name,
      ...(options?.contentType === undefined ? {} : { contentType: options.contentType }),
    });
    if (response.kind === "error") throw new CaptureDestinationRpcError(response.error);
    if (response.kind !== "part-opened") {
      throw new Error(`open-part returned ${response.kind}`);
    }
    return response.resourceId;
  }

  async commit(): Promise<void> {
    await this.#expectOk({ kind: "commit-destination", destinationId: this.#id });
  }

  async abort(error: PdrError): Promise<void> {
    await this.#expectOk({ kind: "abort-destination", destinationId: this.#id, error });
  }

  async #expectOk(request: CaptureRpcRequest): Promise<void> {
    const response = await this.#adapter.request(request);
    if (response.kind === "error") throw new CaptureDestinationRpcError(response.error);
    if (response.kind !== "ok") throw new Error(`${request.kind} returned ${response.kind}`);
  }
}
