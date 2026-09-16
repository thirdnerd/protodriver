import type {
  PdrFailure,
  PdrFailureResponsibility,
  PlatformCauseSnapshot,
  PublicValue,
  Retryability,
} from "@protodriver/contracts";
import { isPdrFailureResponsibility } from "@protodriver/contracts";

export interface GeneratedCliErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly responsibility?: PdrFailureResponsibility;
  readonly details?: PublicValue;
  readonly retryability?: Retryability;
  readonly platformCause?: PlatformCauseSnapshot;
}

export type GeneratedCliErrorCategory =
  | "unexpected"
  | "invocation"
  | "definition"
  | "operation"
  | "host"
  | "cancelled";

export const GENERATED_CLI_ERROR_CATEGORIES = Object.freeze([
  "invocation",
  "definition",
  "operation",
  "host",
  "unexpected",
  "cancelled",
] as const satisfies readonly GeneratedCliErrorCategory[]);

const EXIT_CODE_BY_CATEGORY = Object.freeze({
  invocation: 5,
  definition: 2,
  operation: 3,
  host: 4,
  unexpected: 1,
  cancelled: 130,
} as const satisfies Readonly<Record<GeneratedCliErrorCategory, number>>);

export interface GeneratedCliFailure {
  readonly error: GeneratedCliErrorEnvelope;
  readonly category: GeneratedCliErrorCategory;
  readonly exitCode: number;
}

/** Mark a failure as expected at the CLI boundary; arbitrary Error.code values remain untyped. */
export function generatedCliExpectedError(code: string, message: string,
  responsibility: PdrFailureResponsibility, cause?: unknown): Error & { readonly error: PdrFailure } {
  const error: PdrFailure = { code, message, responsibility, retryability: "no" };
  return Object.assign(new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }), { error });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isRetryability(value: unknown): value is Retryability {
  return value === "no"
    || value === "after-reconnect"
    || value === "after-recovery"
    || value === "unknown";
}

function copyKnownError(value: unknown, wrapperResponsibility?: unknown): GeneratedCliErrorEnvelope | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const responsibility = isPdrFailureResponsibility(value.responsibility)
    ? value.responsibility
    : isPdrFailureResponsibility(wrapperResponsibility) ? wrapperResponsibility : undefined;
  return Object.freeze({
    code: value.code,
    message: value.message,
    ...(responsibility === undefined ? {} : { responsibility }),
    ...(Object.hasOwn(value, "details") && value.details !== undefined
      ? { details: value.details as PublicValue }
      : typeof value.declarationPath === "string"
        ? { details: { declarationPath: value.declarationPath } }
        : {}),
    ...(isRetryability(value.retryability) ? { retryability: value.retryability } : {}),
    ...(Object.hasOwn(value, "platformCause") && value.platformCause !== undefined
      ? { platformCause: value.platformCause as PlatformCauseSnapshot }
      : {}),
  });
}

/** Preserve a boundary error or typed diagnostic without inventing absent facts. */
export function generatedCliError(cause: unknown): GeneratedCliErrorEnvelope {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return Object.freeze({ code: "cli.cancelled", message: cause.message });
  }
  if (isRecord(cause)) {
    const boundary = copyKnownError(cause.error, cause.responsibility);
    if (boundary !== undefined) return boundary;
    const diagnostic = copyKnownError(cause.diagnostic, cause.responsibility);
    if (diagnostic !== undefined) return diagnostic;
    const destructiveCause = copyKnownError(cause.causeDiagnostic, cause.responsibility);
    if (destructiveCause !== undefined) return destructiveCause;
  }
  return Object.freeze({
    code: "cli.failed",
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
  });
}

export function generatedCliErrorCategory(error: GeneratedCliErrorEnvelope): GeneratedCliErrorCategory {
  if (error.code === "cli.cancelled") return "cancelled";
  return error.responsibility ?? "unexpected";
}

export function generatedCliExitCode(category: GeneratedCliErrorCategory): number {
  return EXIT_CODE_BY_CATEGORY[category];
}

export function generatedCliFailure(cause: unknown): GeneratedCliFailure {
  const error = generatedCliError(cause);
  const category = generatedCliErrorCategory(error);
  return Object.freeze({ error, category, exitCode: generatedCliExitCode(category) });
}
