import type {
  DeviceSessionClient,
  HostByteSink,
  HostByteSource,
  HostCaptureDestination,
  PdrError,
  ResourceId,
  SessionId,
} from "@protodriver/contracts";
import {
  DEFAULT_CAPTURE_CAPACITY_POLICY,
  DEFAULT_HOST_RESOURCE_LIMITS,
} from "@protodriver/contracts/limits";
import {
  CaptureDestinationRegistry,
  serveCaptureDestinationRpc,
} from "@protodriver/core/capture-rpc";
import { assertCapturePartName } from "@protodriver/core/capture-path";
import {
  ResourceBrokerHost,
  serveResourceRpc,
} from "@protodriver/core/resources";
import {
  DeviceSessionRpcClient,
  PostMessageSessionRpcAdapter,
} from "@protodriver/core/rpc";

import type {
  BrowserSessionWorkerBootstrapMessage,
} from "./session-worker-bootstrap.ts";
import type { BrowserLoadedDevice } from "./browser-device-admission.ts";

export interface BrowserCaptureLimits {
  /** Maximum bytes pending in the worker's capture-writer queue. */
  readonly maximumCaptureQueueBytes: number;
  readonly maximumCaptureInMemoryBytes: number;
}

export const CAPTURE_SUPPORTED_PAYLOAD_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.supportedPayloadBytes;
export const CAPTURE_MEASURED_SOURCE_CUT_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.measuredSourceCutBytes;
export const CAPTURE_MEASURED_COMPLETE_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.measuredCompleteBytes;
/** Larger byte observations use sidecars; this is not a per-record limit. */
export const DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES = 4 * 1024 * 1024;

export function browserCaptureMemoryPolicy(limits: BrowserCaptureLimits) {
  const queue = limits.maximumCaptureQueueBytes;
  const aggregate = limits.maximumCaptureInMemoryBytes;
  if (!Number.isSafeInteger(queue) || queue <= 0) {
    throw new RangeError("maximumCaptureQueueBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(aggregate) || aggregate <= queue) {
    throw new RangeError("maximumCaptureInMemoryBytes must exceed maximumCaptureQueueBytes");
  }
  return Object.freeze({
    maximumQueueBytes: queue,
    maximumRetainedBytes: aggregate - queue,
    maximumAggregateBytes: aggregate,
  });
}

export const DEFAULT_BROWSER_CAPTURE_LIMITS = Object.freeze({
  maximumCaptureQueueBytes: DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes,
  maximumCaptureInMemoryBytes: DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
});

export const BROWSER_CAPTURE_MEMORY_POLICY = browserCaptureMemoryPolicy(DEFAULT_BROWSER_CAPTURE_LIMITS);

export function browserCaptureSidecarThresholdBytes(limits: BrowserCaptureLimits): number {
  return Math.min(browserCaptureMemoryPolicy(limits).maximumQueueBytes, DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES);
}

export function requiredBrowserCaptureBytes(payloadBytes: number): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new RangeError("payloadBytes must be a non-negative safe integer");
  const required = Math.ceil(payloadBytes * (CAPTURE_MEASURED_COMPLETE_BYTES / CAPTURE_SUPPORTED_PAYLOAD_BYTES));
  return Number.isSafeInteger(required) ? required : Number.MAX_SAFE_INTEGER;
}

export function requireBrowserCaptureCapacity(
  payloadBytes: number,
  limits: BrowserCaptureLimits,
  alreadyRetainedBytes = 0,
  reservedQueuedBytes = 0,
): void {
  const policy = browserCaptureMemoryPolicy(limits);
  const required = requiredBrowserCaptureBytes(payloadBytes);
  for (const [name, value] of [["alreadyRetainedBytes", alreadyRetainedBytes], ["reservedQueuedBytes", reservedQueuedBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  const projected = alreadyRetainedBytes + reservedQueuedBytes + required;
  if (Number.isSafeInteger(projected) && projected <= policy.maximumRetainedBytes) return;
  const message = `capturing ${payloadBytes} known source bytes projects ${projected} retained bytes under the measured authored-transfer population, above the configured ${policy.maximumRetainedBytes}`;
  throw Object.assign(new Error(message), { error: {
    code: "capture.capacity.insufficient",
    message,
    retryability: "no" as const,
    details: {
      payloadBytes,
      requiredRetainedBytes: required,
      alreadyRetainedBytes,
      reservedQueuedBytes,
      projectedRetainedBytes: projected,
      maximumCaptureQueueBytes: policy.maximumQueueBytes,
      maximumCaptureInMemoryBytes: policy.maximumAggregateBytes,
      maximumRetainedCaptureBytes: policy.maximumRetainedBytes,
      remedy: "raise the browser capture envelope before loading the device, or use a streaming capture destination",
    },
  } });
}

interface BrowserWorkerEndpoint {
  postMessage(message: BrowserSessionWorkerBootstrapMessage, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<BrowserSessionWorkerBootstrapMessage>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<BrowserSessionWorkerBootstrapMessage>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface BrowserSessionContext<Loaded = BrowserLoadedDevice> {
  readonly sessionId: SessionId;
  readonly loaded: Loaded;
  readonly client: DeviceSessionClient;
  readonly resources: ResourceBrokerHost;
  readonly captureDestinations: CaptureDestinationRegistry;
  registerResource(resource: HostByteSource | HostByteSink): Promise<ResourceId>;
  registerCaptureDestination(destination: HostCaptureDestination): Promise<import("@protodriver/contracts").CaptureDestinationId>;
  close(): Promise<void>;
}

export async function openBrowserSessionContext<Loaded = BrowserLoadedDevice>(
  deviceBytes: Uint8Array,
  workerFactory: () => BrowserWorkerEndpoint = () => new Worker(
    new URL("./sessionWorker.js", import.meta.url),
    { type: "module", name: "protodriver-device-session" },
  ),
  captureLimits: BrowserCaptureLimits = DEFAULT_BROWSER_CAPTURE_LIMITS,
): Promise<BrowserSessionContext<Loaded>> {
  browserCaptureMemoryPolicy(captureLimits);
  const sessionId = crypto.randomUUID() as SessionId;
  const worker = workerFactory();
  const sessionChannel = new MessageChannel();
  const resourceChannel = new MessageChannel();
  const captureChannel = new MessageChannel();
  const resources = new ResourceBrokerHost();
  const captureDestinations = new CaptureDestinationRegistry();
  const resourceService = serveResourceRpc(resourceChannel.port1, resources);
  const captureService = serveCaptureDestinationRpc(captureChannel.port1, captureDestinations, sessionId);
  const adapter = new PostMessageSessionRpcAdapter(sessionChannel.port1);
  const loaded = await new Promise<Loaded>((resolve, reject) => {
    const onMessage = ({ data }: MessageEvent<BrowserSessionWorkerBootstrapMessage>) => {
      if (data.kind !== "bootstrap-ready" && data.kind !== "bootstrap-error") return;
      worker.removeEventListener("message", onMessage);
      if (data.kind === "bootstrap-error") reject(new BrowserBootstrapError(data.error));
      else resolve(data.loaded as unknown as Loaded);
    };
    const onError = (event: ErrorEvent) => {
      adapter.workerLost(new Error(`session worker failed: ${event.message}`));
      reject(new Error(`session worker failed: ${event.message}`));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({
      kind: "bootstrap",
      authoredAcquisition: { kind: "permission-broker-v1" },
      deviceBytes: Uint8Array.from(deviceBytes),
      sessionId,
      sessionPort: sessionChannel.port2,
      resourcePort: resourceChannel.port2,
      capturePort: captureChannel.port2,
      captureLimits,
    }, [sessionChannel.port2, resourceChannel.port2, captureChannel.port2]);
  }).catch((cause) => {
    resourceService.dispose();
    captureService.dispose();
    worker.terminate();
    throw cause;
  });
  const client = new DeviceSessionRpcClient(adapter);
  return {
    sessionId,
    loaded,
    client,
    resources,
    captureDestinations,
    registerResource(resource) {
      const scope = { kind: "session" as const, sessionId };
      return "read" in resource
        ? resources.registerSource(resource, scope)
        : resources.registerSink(resource, scope);
    },
    registerCaptureDestination(destination) {
      return captureDestinations.register(destination, sessionId);
    },
    async close() {
      await client.close();
      captureService.dispose();
      resourceService.dispose();
      worker.terminate();
    },
  };
}

export class BrowserBootstrapError extends Error {
  readonly error: PdrError;
  constructor(error: PdrError) {
    super(error.message);
    this.name = "BrowserBootstrapError";
    this.error = error;
  }
}

export class BrowserFileByteSource implements HostByteSource {
  readonly origin = "file" as const;
  readonly byteLength: number;
  readonly #file: File;
  #offset = 0;
  #closed = false;
  constructor(file: File) { this.#file = file; this.byteLength = file.size; }
  async read(into: Uint8Array) {
    if (this.#closed) throw new Error("browser file source is closed");
    const bytes = new Uint8Array(await this.#file.slice(this.#offset, this.#offset + into.byteLength).arrayBuffer());
    into.set(bytes);
    this.#offset += bytes.byteLength;
    return { bytesRead: bytes.byteLength, eof: this.#offset === this.byteLength };
  }
  async seek(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength) throw new RangeError("source seek is outside the file");
    this.#offset = offset;
  }
  async close(): Promise<void> { this.#closed = true; }
}

export interface BrowserWritableFileHandle {
  readonly kind: "file";
  readonly name: string;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
}

export class BrowserFileByteSink implements HostByteSink {
  readonly #handle: BrowserWritableFileHandle;
  #stream: Awaited<ReturnType<BrowserWritableFileHandle["createWritable"]>> | undefined;
  #closed = false;
  constructor(handle: BrowserWritableFileHandle) { this.#handle = handle; }
  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("browser file sink is closed");
    this.#stream ??= await this.#handle.createWritable();
    await this.#stream.write(data);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#stream?.close();
  }
}

class MemoryByteSink implements HostByteSink {
  readonly #chunks: Uint8Array[] = [];
  readonly #reserve: (bytes: number) => void;
  #length = 0;
  #closed = false;
  constructor(reserve: (bytes: number) => void) { this.#reserve = reserve; }
  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("capture part is closed");
    this.#reserve(data.byteLength);
    this.#chunks.push(Uint8Array.from(data));
    this.#length += data.byteLength;
  }
  async close(): Promise<void> { this.#closed = true; }
  bytes(): Uint8Array {
    const bytes = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
}

/** Main-thread capture owner. Only its registry id crosses postMessage. */
export class BrowserMemoryCaptureDestination implements HostCaptureDestination {
  readonly #resources: ResourceBrokerHost;
  readonly #sessionId: SessionId;
  readonly #parts = new Map<string, MemoryByteSink>();
  #committed = false;
  readonly #maximumRetainedBytes: number;
  #retainedBytes = 0;
  constructor(resources: ResourceBrokerHost, sessionId: SessionId, limits: BrowserCaptureLimits = DEFAULT_BROWSER_CAPTURE_LIMITS) {
    this.#resources = resources;
    this.#sessionId = sessionId;
    this.#maximumRetainedBytes = browserCaptureMemoryPolicy(limits).maximumRetainedBytes;
  }
  async openPart(name: string): Promise<ResourceId> {
    assertCapturePartName(name);
    const sink = new MemoryByteSink((bytes) => {
      if (bytes > this.#maximumRetainedBytes - this.#retainedBytes) {
        throw new Error("browser capture exceeds maximumCaptureInMemoryBytes after reserving maximumCaptureQueueBytes");
      }
      this.#retainedBytes += bytes;
    });
    this.#parts.set(name, sink);
    return this.#resources.registerSink(sink, { kind: "session", sessionId: this.#sessionId });
  }
  async commit(): Promise<void> { this.#committed = true; }
  async abort(_error: PdrError): Promise<void> { this.#committed = false; }
  retainedBytes(): number { return this.#retainedBytes; }
  bytes(name = "session.pdcap"): Uint8Array {
    if (!this.#committed) throw new Error("capture destination is not committed");
    const part = this.#parts.get(name);
    if (part === undefined) throw new Error(`capture part ${name} does not exist`);
    return part.bytes();
  }
}
