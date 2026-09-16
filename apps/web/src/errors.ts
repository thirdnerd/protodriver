import type {
  PdrFailure,
  PdrFailureResponsibility,
  PlatformCauseSnapshot,
  PublicValue,
  Retryability,
} from "@protodriver/contracts";
import { isPdrFailureResponsibility } from "@protodriver/contracts";

export interface BrowserFailure {
  readonly code: string;
  readonly message: string;
  readonly responsibility?: PdrFailureResponsibility;
  readonly classification?: "unexpected" | "cancelled";
  readonly details?: PublicValue;
  readonly retryability?: Retryability;
  readonly platformCause?: PlatformCauseSnapshot;
}

export function browserExpectedError(code: string, message: string,
  responsibility: PdrFailureResponsibility, cause?: unknown): Error & { readonly error: PdrFailure } {
  const error: PdrFailure = { code, message, responsibility, retryability: "no" };
  return Object.assign(new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }), { error });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function retryability(value: unknown): value is Retryability {
  return value === "no" || value === "after-reconnect" || value === "after-recovery" || value === "unknown";
}

function copyTypedFailure(value: unknown, wrapperResponsibility?: unknown): BrowserFailure | undefined {
  if (!record(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const responsibility = isPdrFailureResponsibility(value.responsibility)
    ? value.responsibility
    : isPdrFailureResponsibility(wrapperResponsibility) ? wrapperResponsibility : undefined;
  return Object.freeze({
    code: value.code,
    message: value.message,
    ...(responsibility === undefined ? { classification: "unexpected" as const } : { responsibility }),
    ...(Object.hasOwn(value, "details") && value.details !== undefined ? { details: value.details as PublicValue } : {}),
    ...(retryability(value.retryability) ? { retryability: value.retryability } : {}),
    ...(Object.hasOwn(value, "platformCause") && value.platformCause !== undefined
      ? { platformCause: value.platformCause as PlatformCauseSnapshot } : {}),
  });
}

/** Normalize only explicit product envelopes; Error.code alone is never typed status. */
export function browserFailure(cause: unknown): BrowserFailure {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return Object.freeze({ code: "web.cancelled", message: cause.message, classification: "cancelled" });
  }
  if (record(cause)) {
    for (const member of [cause.error, cause.diagnostic, cause.causeDiagnostic]) {
      const failure = copyTypedFailure(member, cause.responsibility);
      if (failure !== undefined) return failure;
    }
  }
  return Object.freeze({
    code: "web.failed",
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    classification: "unexpected",
  });
}

export function browserFailureText(error: BrowserFailure): string {
  if (error.responsibility !== undefined) {
    const label: Record<PdrFailureResponsibility, string> = {
      invocation: "Change this request",
      definition: "Fix the device definition",
      operation: "Recover or inspect the device session",
      host: "Repair the host environment",
    };
    return `${label[error.responsibility]}: ${error.message}`;
  }
  if (error.classification === "cancelled") return `Cancelled: ${error.message}`;
  return `Unexpected failure: ${error.message}`;
}
