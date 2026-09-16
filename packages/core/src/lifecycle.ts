import type {
  ClientId,
  ClientLeasePolicy,
  Clock,
  Disposable,
  OperationId,
  OperationResult,
  PdrError,
  SessionRpcEvent,
  SessionRpcRequest,
  SessionRpcResponse,
} from "@protodriver/contracts";
import { DEFAULT_PHASE_ONE_LIMITS, HostResourceLimitError } from "@protodriver/core/limits";

type ClientLeaseRequest = Extract<SessionRpcRequest, {
  readonly kind: "attach-client" | "client-heartbeat" | "detach-client";
}>;

type OperationRetentionRequest = Extract<SessionRpcRequest, {
  readonly kind: "await-operation" | "acknowledge-operation";
}>;

export type CleanupStepResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: PdrError }
  | { readonly status: "not-attempted" };

export interface OrderlyClientCleanupResult {
  readonly cancelOperations: CleanupStepResult;
  readonly hostCleanup: CleanupStepResult;
  readonly closeConnection: CleanupStepResult;
  readonly closeCapture: CleanupStepResult;
}

interface ClientLossResultBase {
  readonly clientId?: ClientId;
  readonly detectedAtSequence: number;
  readonly detectedAtMonotonicUs: number;
  readonly sessionEnded: boolean;
}

export type ClientLossResult =
  | (ClientLossResultBase & {
      readonly kind: "normal-detach";
      readonly cleanup: OrderlyClientCleanupResult;
    })
  | (ClientLossResultBase & {
      readonly kind: "heartbeat-timeout";
      readonly elapsedSinceHeartbeatMs: number;
      readonly declaredGoneAfterMs: number;
      readonly cleanup: OrderlyClientCleanupResult;
    })
  | (ClientLossResultBase & {
      readonly kind: "abrupt-termination";
      readonly orderlyCleanup: "not-guaranteed";
      readonly contextRelease: CleanupStepResult;
      readonly cause?: PdrError;
    });

export interface ClientLeaseOwner {
  cancelOperations(reason: string): Promise<void>;
  runHostCleanup(reason: string): Promise<void>;
  closeConnection(reason: string): Promise<void>;
  /** Orderly paths close the recorder and therefore write its footer. */
  closeCapture(): Promise<void>;
  /** Synchronous model of the platform releasing a dead context's device. */
  releaseDeviceWithContext(): void;
}

interface ClientRecord {
  readonly clientId: ClientId;
  heartbeatSequence: number;
  lastHeartbeatUs: number;
  deadline: Disposable;
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireFinitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
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

function causeError(code: string, cause: unknown): PdrError {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return {
    code,
    message: error.message,
    responsibility: "host",
    retryability: "unknown",
    platformCause: {
      typeName: error.constructor.name,
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    },
  };
}

function rpcError(request: ClientLeaseRequest, error: PdrError): SessionRpcResponse {
  return { kind: "error", method: request.kind, callId: request.callId, error };
}

function notAttemptedCleanup(): OrderlyClientCleanupResult {
  const result: CleanupStepResult = { status: "not-attempted" };
  return {
    cancelOperations: result,
    hostCleanup: result,
    closeConnection: result,
    closeCapture: result,
  };
}
export class ClientLeaseError extends Error {
  readonly error: PdrError;

  constructor(error: PdrError) {
    super(error.message);
    this.name = "ClientLeaseError";
    this.error = error;
  }
}

export class OperationResultUnavailableError extends Error {
  readonly error: PdrError;

  constructor(operationId: OperationId) {
    const error = pdrError(
      "operation.result-unavailable",
      `operation ${operationId} has no retained result`,
      { operationId },
    );
    super(error.message);
    this.name = "OperationResultUnavailableError";
    this.error = error;
  }
}

interface ResultWaiter {
  readonly resolve: (result: OperationResult) => void;
}

/** Result ownership independent of lifecycle subscriptions. */
export class OperationResultRetention {
  readonly #maximumResults: number;
  readonly #maximumConcurrentOperations: number;
  readonly #active = new Set<OperationId>();
  readonly #retained = new Map<OperationId, OperationResult>();
  readonly #waiters = new Map<OperationId, ResultWaiter[]>();

  constructor(
    maximumResults: number,
    maximumConcurrentOperations = DEFAULT_PHASE_ONE_LIMITS.maximumConcurrentOperations,
  ) {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 0) {
      throw new RangeError("maximumResults must be a non-negative safe integer");
    }
    this.#maximumResults = maximumResults;
    if (!Number.isSafeInteger(maximumConcurrentOperations) || maximumConcurrentOperations < 0) {
      throw new RangeError("maximumConcurrentOperations must be a non-negative safe integer");
    }
    this.#maximumConcurrentOperations = maximumConcurrentOperations;
  }

  get activeOperations(): readonly OperationId[] {
    return [...this.#active];
  }

  get retainedResults(): readonly OperationId[] {
    return [...this.#retained.keys()];
  }

  begin(operationId: OperationId): void {
    if (this.#active.has(operationId) || this.#retained.has(operationId)) {
      throw new Error(`operation ${operationId} already exists`);
    }
    if (this.#active.size >= this.#maximumConcurrentOperations) {
      throw new HostResourceLimitError(
        "operation.concurrent-limit",
        "maximumConcurrentOperations",
        this.#maximumConcurrentOperations,
        this.#active.size + 1,
        "operation",
      );
    }
    this.#active.add(operationId);
  }

  complete(result: OperationResult): void {
    if (!this.#active.delete(result.operationId)) {
      throw new Error(`operation ${result.operationId} is not active`);
    }
    this.#retained.set(result.operationId, result);
    while (this.#retained.size > this.#maximumResults) {
      const oldest = this.#retained.keys().next().value as OperationId | undefined;
      if (oldest === undefined) break;
      this.#retained.delete(oldest);
    }
    const waiters = this.#waiters.get(result.operationId);
    this.#waiters.delete(result.operationId);
    for (const waiter of waiters ?? []) waiter.resolve(result);
  }

  awaitResult(operationId: OperationId): Promise<OperationResult> {
    const retained = this.#retained.get(operationId);
    if (retained !== undefined) return Promise.resolve(retained);
    if (!this.#active.has(operationId)) {
      return Promise.reject(new OperationResultUnavailableError(operationId));
    }
    return new Promise<OperationResult>((resolve) => {
      const waiters = this.#waiters.get(operationId) ?? [];
      waiters.push({ resolve });
      this.#waiters.set(operationId, waiters);
    });
  }

  acknowledge(operationId: OperationId): void {
    this.#retained.delete(operationId);
  }

  async handle(request: OperationRetentionRequest): Promise<SessionRpcResponse> {
    try {
      if (request.kind === "await-operation") {
        return {
          kind: "ok",
          method: request.kind,
          callId: request.callId,
          result: await this.awaitResult(request.params.operationId),
        };
      }
      this.acknowledge(request.params.operationId);
      return { kind: "ok", method: request.kind, callId: request.callId, result: null };
    } catch (cause) {
      return {
        kind: "error",
        method: request.kind,
        callId: request.callId,
        error: cause instanceof OperationResultUnavailableError
          ? cause.error
          : causeError("operation.result-retention-failed", cause),
      };
    }
  }
}
