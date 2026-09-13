import type {
  AuthoredConnectionProfile, AuthoredDescription, CandidateId, CandidateRequest,
  ClientId, ClientLeasePolicy, ConnectRequest, DeviceConnection, PdrError,
  PhysicalDeviceIdentity, ResourceBrokerClient, SerializableCandidate,
  SessionRpcEvent, SessionRpcRequest, SessionRpcResponse, SessionSnapshot,
  SubscriptionId, TransferCheckpointStore,
} from "@protodriver/contracts";
import { DEFAULT_CAPTURE_CAPACITY_POLICY, DEFAULT_HOST_RESOURCE_LIMITS } from "@protodriver/contracts/limits";
import { generateAuthoredControlModel } from "@protodriver/control-model";
import { admitAuthoredModule, createAuthoredSession, type AuthoredHostGrant } from "@protodriver/core/authored-module";
import { DEFAULT_AUTHORED_POLL_POLICY, grantRequiredPollPlans, pollPlans } from "@protodriver/core/authored-poll";
import type { CaptureDestinationRpcAdapter } from "@protodriver/core/capture-rpc";
import { RealClock } from "@protodriver/core/clock";
import { snapshotPlatformCause } from "@protodriver/core/limits";
import type { SessionRpcServer } from "@protodriver/core/rpc";
import { TransferCheckpointError } from "@protodriver/transfer-runtime/transfer-checkpoint";
import { BrowserSerialTransport, type WebSerialPortInfo, type WebSerialPortLike } from "@protodriver/transport-browser-serial";
import { BrowserUsbTransport, type WebUsbDeviceLike, type WebUsbDisconnectSourceLike } from "@protodriver/transport-browser-usb";

import type { BrowserLoadedDevice, BrowserWorkerProfile } from "./browser-device-admission.ts";
import { usbFilterMatches, type WebUsbFilterDevice } from "./webusb-filter.ts";

class AsyncEventQueue implements AsyncIterable<SessionRpcEvent> {
  readonly #values: SessionRpcEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<SessionRpcEvent>) => void> = [];
  push(value: SessionRpcEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }
  [Symbol.asyncIterator](): AsyncIterator<SessionRpcEvent> {
    return { next: () => {
      const value = this.#values.shift();
      return value === undefined
        ? new Promise((resolve) => this.#waiters.push(resolve))
        : Promise.resolve({ done: false, value });
    } };
  }
}

const LEASE_POLICY: ClientLeasePolicy = Object.freeze({
  heartbeatIntervalMs: 1_000,
  missesAllowed: 5,
  declaredGoneAfterMs: 5_000,
  reattachAllowed: true,
  multipleClientsAllowed: true,
});

export interface WorkerWebSerialApi {
  getPorts(): Promise<readonly WebSerialPortLike[]>;
}

interface NativeWebUsbDevice extends WebUsbDeviceLike, WebUsbFilterDevice {
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly serialNumber?: string;
}

export interface WorkerWebUsbApi extends WebUsbDisconnectSourceLike {
  getDevices(): Promise<readonly NativeWebUsbDevice[]>;
}

interface CandidateEntry {
  readonly candidate: SerializableCandidate;
  readonly modeId: string;
  readonly profileId: string;
  open(): Promise<DeviceConnection>;
}

type AdmittedAuthoredModule = Awaited<ReturnType<typeof admitAuthoredModule>>;
type BrowserPhysicalProfile = AuthoredConnectionProfile & { readonly id: string };
type BrowserSerialProfile = Extract<AuthoredConnectionProfile, { readonly transport: { readonly kind: "serial" } }> & { readonly id: string };
type BrowserUsbProfile = Extract<AuthoredConnectionProfile, { readonly transport: { readonly kind: "usb" } }> & { readonly id: string };

export class BrowserSessionWorkerHost implements SessionRpcServer {
  readonly #authoredAcquisition: ((description: AuthoredDescription) => Promise<AuthoredHostGrant>) | undefined;
  readonly #authoredAcquisitionBinding: { readonly kind: "permission-broker-v1" } | undefined;
  readonly #authoredArtifact: Uint8Array | undefined;
  readonly #serial: WorkerWebSerialApi | undefined;
  readonly #usb: WorkerWebUsbApi | undefined;
  readonly #clock: RealClock;
  readonly #checkpointStore: TransferCheckpointStore | undefined;
  readonly #resourceBroker: ResourceBrokerClient | undefined;
  readonly #captureDestinationAdapter: CaptureDestinationRpcAdapter | undefined;
  readonly #captureLimits: { readonly maximumCaptureQueueBytes: number; readonly maximumCaptureInMemoryBytes: number };
  readonly #events = new AsyncEventQueue();
  readonly #clients = new Set<ClientId>();
  readonly #attachRequests = new Map<ClientId, Extract<SessionRpcRequest, { readonly kind: "attach-client" }>>();
  readonly #subscriptionRequests = new Map<SubscriptionId, Extract<SessionRpcRequest, { readonly kind: "subscribe" }>>();
  readonly #candidateIds = new WeakMap<object, Map<string, string>>();
  #nextCandidateId = 1;
  #module: AdmittedAuthoredModule | undefined;
  #archive: Uint8Array | undefined;
  #loaded: BrowserLoadedDevice | undefined;
  #server: SessionRpcServer | undefined;
  #candidates = new Map<string, CandidateEntry>();
  #candidateGrants = new Map<CandidateId, import("@protodriver/contracts").GrantId>();
  #pendingCapture: {
    readonly request: Extract<SessionRpcRequest, { readonly kind: "start-capture" }>;
    readonly settle: (response: SessionRpcResponse) => void;
  } | undefined;

  constructor(options: {
    readonly authoredAcquisition?: (description: AuthoredDescription) => Promise<AuthoredHostGrant>;
    readonly authoredAcquisitionBinding?: { readonly kind: "permission-broker-v1" };
    readonly authoredArtifact?: Uint8Array;
    readonly serial?: WorkerWebSerialApi;
    readonly usb?: WorkerWebUsbApi;
    readonly clock?: RealClock;
    readonly checkpointStore?: TransferCheckpointStore;
    readonly resourceBroker?: ResourceBrokerClient;
    readonly captureDestinationAdapter?: CaptureDestinationRpcAdapter;
    readonly captureLimits?: { readonly maximumCaptureQueueBytes: number; readonly maximumCaptureInMemoryBytes: number };
  }) {
    this.#authoredAcquisition = options.authoredAcquisition;
    this.#authoredAcquisitionBinding = options.authoredAcquisitionBinding;
    this.#authoredArtifact = options.authoredArtifact;
    this.#serial = options.serial;
    this.#usb = options.usb;
    this.#clock = options.clock ?? new RealClock();
    this.#checkpointStore = options.checkpointStore;
    this.#resourceBroker = options.resourceBroker;
    this.#captureDestinationAdapter = options.captureDestinationAdapter;
    this.#captureLimits = options.captureLimits ?? {
      maximumCaptureQueueBytes: DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes,
      maximumCaptureInMemoryBytes: DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
    };
    if (!Number.isSafeInteger(this.#captureLimits.maximumCaptureQueueBytes)
        || this.#captureLimits.maximumCaptureQueueBytes <= 0
        || !Number.isSafeInteger(this.#captureLimits.maximumCaptureInMemoryBytes)
        || this.#captureLimits.maximumCaptureInMemoryBytes <= this.#captureLimits.maximumCaptureQueueBytes) {
      throw new RangeError("invalid browser capture limits");
    }
  }

  get events(): AsyncIterable<SessionRpcEvent> { return this.#events; }
  get wireRecordsBeforeFailure(): number { return 0; }

  async admit(deviceBytes: Uint8Array): Promise<BrowserLoadedDevice> {
    if (this.#module !== undefined) throw new Error("replace the authored session before loading another package");
    const artifact = this.#authoredArtifact
      ?? (await import("../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm")).default;
    const archive = Uint8Array.from(deviceBytes);
    const module = await admitAuthoredModule(archive, artifact);
    const grant = await this.#authoredAcquisition?.(module.description);
    if (grant !== undefined) {
      if (!this.#resourceBroker || !this.#captureDestinationAdapter) throw new Error("authored product services required");
      const created = await createAuthoredSession(archive, artifact, {
        ...grant,
        platform: "web",
        resourceBroker: this.#resourceBroker,
        captureDestinationAdapter: this.#captureDestinationAdapter,
        maximumCaptureBufferedBytes: this.#captureLimits.maximumCaptureQueueBytes,
      });
      this.#installServer(created.server);
    }
    this.#module = module;
    this.#archive = archive;
    const profiles = Object.entries(module.description.connectionProfiles ?? {}).flatMap(([profileId, profile]) =>
      profile.modes.map((modeId): BrowserWorkerProfile => Object.freeze({
        modeId,
        profileId,
        transport: profile.transport.kind,
        supported: profile.transport.kind === "serial" ? this.#serial !== undefined : this.#usb !== undefined,
        rawTerminal: profile.transport.kind === "serial"
          ? Object.freeze({ kind: "available" as const, channelId: (profile as BrowserSerialProfile).channels[0].id })
          : Object.freeze({ kind: "unavailable" as const,
              reason: "This USB profile declares protocol bindings and no ordered byte-stream channel." }),
        acquisitionFilters: Object.freeze(profile.acquisitionFilters.map((filter) => Object.freeze({
          ...(filter.vendorId === undefined ? {} : { vendorId: filter.vendorId }),
          ...(filter.productId === undefined ? {} : { productId: filter.productId }),
          ...(filter.transport === "usb" && filter.usbClass !== undefined ? { usbClass: filter.usbClass } : {}),
        }))),
      })),
    );
    const loaded: BrowserLoadedDevice = Object.freeze({
      profiles: Object.freeze(profiles),
      authored: {
        model: generateAuthoredControlModel(module.description),
        hostGrant: grant ? { modeId: grant.modeId, profileId: grant.profileId } : null,
      },
      admission: {
        kind: "pdpkg",
        generatorContract: 2,
        sourceSetIdentity: { algorithm: "sha256", hex: module.identity.sourceSet },
        executionIdentity: module.identity.digest,
        publicDescriptionHash: module.identity.publicDescription,
      } as const,
    });
    this.#loaded = loaded;
    return loaded;
  }

  async handle(request: SessionRpcRequest): Promise<SessionRpcResponse> {
    if (request.kind === "subscribe-diagnostics") return ok(request, null);
    if (this.#server !== undefined) return this.#server.handle(request);
    try {
      if (request.kind === "attach-client") {
        if (!this.#clients.has(request.params.clientId)
            && this.#clients.size >= DEFAULT_HOST_RESOURCE_LIMITS.maximumClientsPerSession) {
          throw new Error("maximum clients per session exceeded");
        }
        this.#clients.add(request.params.clientId);
        this.#attachRequests.set(request.params.clientId, request);
        return ok(request, LEASE_POLICY);
      }
      this.#requireAttached();
      switch (request.kind) {
        case "resolve-candidates": return ok(request, await this.#resolveCandidates(request.params.request));
        case "connect": {
          if (this.#module?.description.connectionProfiles === undefined) {
            throw new Error("authored.acquisition.required: package admitted; execution needs an explicit host-supplied connection grant");
          }
          const server = await this.#createDeferredServer(request.params.request);
          return server.handle(request);
        }
        case "start-capture":
          if (this.#pendingCapture !== undefined) throw new Error("a capture is already awaiting authored session construction");
          return new Promise((settle) => { this.#pendingCapture = { request, settle }; });
        case "subscribe":
          this.#subscriptionRequests.set(request.params.subscriptionId, request);
          return ok(request, null);
        case "unsubscribe":
          this.#subscriptionRequests.delete(request.params.subscriptionId);
          return ok(request, null);
        case "client-heartbeat": return ok(request, null);
        case "detach-client":
          this.#clients.delete(request.params.clientId);
          this.#attachRequests.delete(request.params.clientId);
          return ok(request, null);
        case "get-snapshot": return ok(request, this.#snapshot());
        default: throw new Error("authored.acquisition.required: select an admitted mode, profile and authorized candidate before execution");
      }
    } catch (cause) {
      return failure(request, cause);
    }
  }

  async #resolveCandidates(request: CandidateRequest): Promise<readonly SerializableCandidate[]> {
    const module = this.#requireModule();
    const modeId = request.mode ?? module.description.modes[0];
    if (modeId === undefined || !module.description.modes.includes(modeId)) {
      throw workerError("acquisition.mode-mismatch", "mode selection is required");
    }
    const declared = Object.entries(module.description.connectionProfiles ?? {})
      .filter(([, profile]) => profile.modes.includes(modeId));
    if (declared.length === 0 && request.profile === undefined) return Object.freeze([]);
    const profiles = request.profile === undefined
      ? declared
      : declared.filter(([profileId]) => profileId === request.profile);
    if (request.profile === undefined && profiles.length !== 1) {
      throw workerError("acquisition.profile-required", `mode ${modeId} requires an admitted profile selection`);
    }
    if (request.profile !== undefined && profiles.length === 0) {
      throw workerError("acquisition.profile-mismatch", `profile ${request.profile} is not admitted for ${modeId}`);
    }
    const entries = (await Promise.all(profiles.map(([profileId, profile]) =>
      this.#candidateEntries(modeId, { ...profile, id: profileId }, request.grant)))).flat();
    const candidates = entries.map(({ candidate }, index) => Object.freeze({
      ...candidate,
      ambiguousWith: Object.freeze(entries.filter((_, other) => other !== index)
        .map(({ candidate: value }) => value.candidateId)),
    }));
    this.#candidates = new Map(entries.map((entry, index) => [candidates[index]!.candidateId,
      { ...entry, candidate: candidates[index]! }]));
    this.#candidateGrants.clear();
    if (request.grant !== undefined) {
      for (const candidate of candidates) this.#candidateGrants.set(candidate.candidateId, request.grant.grantId);
    }
    return Object.freeze(candidates);
  }

  async #candidateEntries(
    modeId: string,
    profile: BrowserPhysicalProfile,
    grant?: import("@protodriver/contracts").GrantDescriptor,
  ): Promise<CandidateEntry[]> {
    const filters = grant === undefined ? profile.acquisitionFilters : grant.matchedFilters.map((index) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= profile.acquisitionFilters.length) {
        throw workerError("acquisition.grant-filter-mismatch", `grant filter ${index} is outside admitted profile ${profile.id}`);
      }
      return profile.acquisitionFilters[index]!;
    });
    if (grant !== undefined && filters.length === 0) {
      throw workerError("acquisition.grant-filter-mismatch", `grant does not cover admitted profile ${profile.id}`);
    }
    const authorized = { ...profile, acquisitionFilters: filters } as BrowserPhysicalProfile;
    return isBrowserSerialProfile(authorized)
      ? this.#serialCandidates(modeId, authorized)
      : this.#usbCandidates(modeId, authorized as BrowserUsbProfile);
  }

  async #serialCandidates(
    modeId: string,
    profile: BrowserSerialProfile,
  ): Promise<CandidateEntry[]> {
    if (this.#serial === undefined) return [];
    const transport = new BrowserSerialTransport({ clock: this.#clock });
    const ports = (await this.#serial.getPorts()).filter((port) =>
      profile.acquisitionFilters.some((filter) => serialFilterMatches(filter, port.getInfo())));
    return ports.map((port, index) => {
      const info = port.getInfo();
      const identity = browserSerialIdentity(info);
      const candidateId = this.#candidateId(port, "serial", profile.id) as CandidateId;
      return {
        modeId,
        profileId: profile.id,
        candidate: {
          candidateId,
          displayName: `${hexId(info.usbVendorId)}:${hexId(info.usbProductId)} authorized serial port ${index + 1}`,
          identity,
          matchedProfileId: profile.id,
          ambiguousWith: [],
        },
        open: () => transport.open({
          port,
          profileId: profile.id,
          modeId,
          identity,
          line: profile.transport,
          lifecycle: profile.lifecycle,
          protocolDuplex: profile.channels[0].protocolDuplex,
        }),
      };
    });
  }

  async #usbCandidates(
    modeId: string,
    profile: BrowserUsbProfile,
  ): Promise<CandidateEntry[]> {
    if (this.#usb === undefined) return [];
    const transport = new BrowserUsbTransport({ clock: this.#clock });
    const devices = (await this.#usb.getDevices()).filter((device) =>
      profile.acquisitionFilters.some((filter) => usbFilterMatches(filter, device)));
    return devices.map((device, index) => {
      const identity: PhysicalDeviceIdentity = {
        transport: "usb",
        vendorId: device.vendorId,
        productId: device.productId,
        ...(device.manufacturerName === undefined ? {} : { manufacturerName: device.manufacturerName }),
        ...(device.productName === undefined ? {} : { productName: device.productName }),
        ...(device.serialNumber === undefined ? {} : { serialNumber: device.serialNumber }),
        usbInterface: profile.transport.interfaceNumber,
        ...(device.serialNumber === undefined
          ? { stableKeyAssurance: "none" }
          : { stableKeyAssurance: "serial-number", stableKey: device.serialNumber }),
      };
      const candidateId = this.#candidateId(device, "usb", profile.id) as CandidateId;
      return {
        modeId,
        profileId: profile.id,
        candidate: {
          candidateId,
          displayName: `${device.productName ?? "USB device"} ${hexId(device.vendorId)}:${hexId(device.productId)} authorized device ${index + 1}`,
          identity,
          matchedProfileId: profile.id,
          ambiguousWith: [],
        },
        open: () => transport.open({
          device,
          disconnectSource: this.#usb!,
          profileId: profile.id,
          modeId,
          identity,
          profile: profile.transport,
          ...(profile.requiredProductName === undefined ? {} : { requiredProductName: profile.requiredProductName }),
        }),
      };
    });
  }

  async #createDeferredServer(request: ConnectRequest): Promise<SessionRpcServer> {
    if (this.#authoredAcquisitionBinding?.kind !== "permission-broker-v1") {
      throw workerError("authored.acquisition.stock-unbound", "ordinary authored acquisition requires the clone-safe bootstrap binding");
    }
    const module = this.#requireModule();
    const archive = this.#archive!;
    const artifact = this.#authoredArtifact
      ?? (await import("../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm")).default;
    if (request.mode === undefined || request.profile === undefined || request.candidateId === undefined || request.grant === undefined) {
      throw workerError("authored.acquisition.selection-required", "grant, mode, profile and candidate are required before authored session construction");
    }
    if (!module.description.modes.includes(request.mode)) {
      throw workerError("authored.acquisition.mode-mismatch", `mode ${request.mode} is not admitted`);
    }
    const profile = module.description.connectionProfiles?.[request.profile];
    if (profile === undefined || !profile.modes.includes(request.mode)) {
      throw workerError("authored.acquisition.profile-mismatch", `profile ${request.profile} is not admitted for ${request.mode}`);
    }
    await this.#resolveCandidates({ mode: request.mode, profile: request.profile, grant: request.grant });
    const selected = this.#candidates.get(request.candidateId);
    if (selected === undefined || selected.modeId !== request.mode || selected.profileId !== request.profile) {
      throw workerError("authored.acquisition.candidate-mismatch", `candidate ${request.candidateId} is not authorized for ${request.mode}/${request.profile}`);
    }
    if (this.#candidateGrants.get(request.candidateId) !== request.grant.grantId) {
      throw workerError("authored.acquisition.grant-mismatch", `candidate ${request.candidateId} was not resolved under grant ${request.grant.grantId}`);
    }
    if (!this.#resourceBroker || !this.#captureDestinationAdapter) throw new Error("authored product services required");
    const pollPolicy = grantRequiredPollPlans(pollPlans(module.description), DEFAULT_AUTHORED_POLL_POLICY,
      { minimumIntervalMs: 200, maximumNominalPollsPerSecond: 5 });
    const pendingCapture = this.#pendingCapture;
    try {
      const created = await createAuthoredSession(archive, artifact, {
        platform: "web",
        modeId: request.mode,
        profileId: request.profile,
        channelId: "main",
        helpers: {},
        clock: this.#clock,
        pollPolicy,
        inputRetirementSupport: { adapter: "bounded-ingress-v1", clock: this.#clock },
        usbControl: { available: profile.transport.kind === "usb",
          limitation: "Browser host grants bounded USB control on the selected interface" },
        ...(this.#checkpointStore === undefined ? {} : { checkpointStore: this.#checkpointStore }),
        open: selected.open,
        resourceBroker: this.#resourceBroker,
        captureDestinationAdapter: this.#captureDestinationAdapter,
        maximumCaptureBufferedBytes: this.#captureLimits.maximumCaptureQueueBytes,
      });
      for (const replay of [...this.#attachRequests.values(), ...this.#subscriptionRequests.values()]) {
        const response = await created.server.handle(replay);
        if (response.kind === "error") throw new Error(`authored RPC replay failed: ${response.error.message}`);
      }
      if (pendingCapture !== undefined) {
        const response = await created.server.handle(pendingCapture.request);
        pendingCapture.settle(response);
        this.#pendingCapture = undefined;
        if (response.kind === "error") throw Object.assign(new Error(response.error.message), { error: response.error });
      }
      this.#installServer(created.server);
      return created.server;
    } catch (cause) {
      if (this.#pendingCapture === pendingCapture && pendingCapture !== undefined) {
        pendingCapture.settle({ kind: "error", method: pendingCapture.request.kind, callId: pendingCapture.request.callId,
          error: serializeWorkerErrorWithEvidence(cause, 0) });
        this.#pendingCapture = undefined;
      }
      throw cause;
    }
  }

  #installServer(server: SessionRpcServer): void {
    this.#server = server;
    void (async () => { for await (const event of server.events) this.#events.push(event); })();
  }

  #candidateId(candidate: object, transport: "serial" | "usb", profileId: string): string {
    let ids = this.#candidateIds.get(candidate);
    if (ids === undefined) { ids = new Map(); this.#candidateIds.set(candidate, ids); }
    let value = ids.get(profileId);
    if (value === undefined) { value = `${transport}:authorized-${this.#nextCandidateId++}`; ids.set(profileId, value); }
    return value;
  }

  #snapshot(): SessionSnapshot {
    return {
      takenAtSequence: 0,
      state: "idle",
      currentMode: this.#module?.description.modes[0] ?? "",
      stateCells: {},
      activeOperations: [],
      retainedResults: [],
      maintenanceStatus: "active",
    };
  }

  #requireAttached(): void {
    if (this.#clients.size === 0) throw new Error("attach-client is required before session calls");
  }

  #requireModule(): AdmittedAuthoredModule {
    if (this.#module === undefined || this.#loaded === undefined) throw new Error("no authored package is loaded in the worker");
    return this.#module;
  }
}

function serialFilterMatches(filter: { readonly vendorId?: number; readonly productId?: number }, info: WebSerialPortInfo): boolean {
  return (filter.vendorId === undefined || filter.vendorId === info.usbVendorId)
    && (filter.productId === undefined || filter.productId === info.usbProductId);
}

function browserSerialIdentity(info: WebSerialPortInfo): PhysicalDeviceIdentity {
  return {
    transport: "serial",
    ...(info.usbVendorId === undefined ? {} : { vendorId: info.usbVendorId }),
    ...(info.usbProductId === undefined ? {} : { productId: info.usbProductId }),
    stableKeyAssurance: "none",
  };
}

function hexId(value: number | undefined): string { return value?.toString(16).padStart(4, "0") ?? "unknown"; }

function isBrowserSerialProfile(profile: BrowserPhysicalProfile): profile is BrowserSerialProfile {
  return profile.transport.kind === "serial";
}

export function workerError(code: string, message: string, cause?: unknown): Error & { readonly error: PdrError } {
  const error: PdrError = { code, message, retryability: "no",
    ...(cause === undefined ? {} : { platformCause: snapshotCause(cause) }) };
  return Object.assign(new Error(message), { error });
}

export function serializeWorkerError(cause: unknown): PdrError {
  if (cause instanceof TransferCheckpointError) {
    return { code: cause.diagnostic.code, message: cause.diagnostic.message, retryability: "no",
      details: cause.diagnostic as unknown as NonNullable<PdrError["details"]> };
  }
  if (typeof cause === "object" && cause !== null && "error" in cause) return (cause as { readonly error: PdrError }).error;
  if (typeof cause === "object" && cause !== null && "diagnostic" in cause) {
    const diagnostic = (cause as { readonly diagnostic?: unknown }).diagnostic;
    if (typeof diagnostic === "object" && diagnostic !== null
      && typeof (diagnostic as { readonly code?: unknown }).code === "string"
      && typeof (diagnostic as { readonly message?: unknown }).message === "string") {
      const value = diagnostic as { readonly code: string; readonly message: string; readonly retryability?: unknown };
      const retryability = value.retryability === "no" || value.retryability === "after-reconnect"
        || value.retryability === "after-recovery" || value.retryability === "unknown"
        ? value.retryability : "no";
      return { code: value.code, message: value.message, retryability,
        details: ("details" in diagnostic
          ? (diagnostic as { readonly details: NonNullable<PdrError["details"]> }).details
          : diagnostic) as NonNullable<PdrError["details"]> };
    }
  }
  return {
    code: "web.worker-failed",
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    retryability: "unknown",
    ...(cause instanceof Error ? { platformCause: snapshotPlatformCause(cause) } : {}),
  };
}

export function serializeWorkerErrorWithEvidence(cause: unknown, wireRecordsBeforeFailure: number): PdrError {
  const error = serializeWorkerError(cause);
  const prior = error.details;
  const details = typeof prior === "object" && prior !== null && !Array.isArray(prior)
    ? { ...prior, wireRecordsBeforeFailure }
    : { ...(prior === undefined ? {} : { diagnosticDetails: prior }), wireRecordsBeforeFailure };
  return { ...error, details };
}

function ok(request: SessionRpcRequest, result: unknown): SessionRpcResponse {
  return { kind: "ok", method: request.kind, callId: request.callId, result } as SessionRpcResponse;
}

function failure(request: SessionRpcRequest, cause: unknown): SessionRpcResponse {
  return { kind: "error", method: request.kind, callId: request.callId,
    error: serializeWorkerErrorWithEvidence(cause, 0) };
}

function snapshotCause(cause: unknown): ReturnType<typeof snapshotPlatformCause> {
  return snapshotPlatformCause(typeof cause === "object" && cause !== null ? cause : String(cause));
}
