import type {
  PlatformCauseSnapshot,
  PublicValue,
  Retryability,
} from "@protodriver/contracts";

export interface GeneratedCliErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details?: PublicValue;
  readonly retryability?: Retryability;
  readonly platformCause?: PlatformCauseSnapshot;
}

export type GeneratedCliErrorCategory =
  | "unexpected"
  | "definition"
  | "operation"
  | "host"
  | "uncategorized"
  | "cancelled";

export const GENERATED_CLI_ERROR_CATEGORIES = Object.freeze([
  "unexpected",
  "definition",
  "operation",
  "host",
  "uncategorized",
  "cancelled",
] as const satisfies readonly GeneratedCliErrorCategory[]);

const EXIT_CODE_BY_CATEGORY = Object.freeze({
  unexpected: 1,
  definition: 2,
  operation: 3,
  host: 4,
  uncategorized: 5,
  cancelled: 130,
} as const satisfies Readonly<Record<GeneratedCliErrorCategory, number>>);

// This is deliberately a category decision, not a code catalogue. Diagnostic
// codes are still declared across their owning packages; an unfamiliar
// namespace remains visible as uncategorized instead of being absorbed here.
const DEFINITION_NAMESPACES = new Set([
  "admission",
  "codec",
  "control-model",
  "lua-invocation",
  "lua-source-set",
  "lua-vm",
  "pdpkg",
  "usb",
  "value",
]);
const OPERATION_NAMESPACES = new Set([
  "acquisition",
  "device",
  "protocol",
  "transfer",
  "transport",
]);
const HOST_NAMESPACES = new Set([
  "capture",
  "diagnostic",
  "operation",
  "resource",
  "rpc",
  "session",
]);

export interface GeneratedCliFailure {
  readonly error: GeneratedCliErrorEnvelope;
  readonly category: GeneratedCliErrorCategory;
  readonly exitCode: number;
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

function copyKnownError(value: unknown): GeneratedCliErrorEnvelope | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return Object.freeze({
    code: value.code,
    message: value.message,
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
    const boundary = copyKnownError(cause.error);
    if (boundary !== undefined) return boundary;
    const diagnostic = copyKnownError(cause.diagnostic);
    if (diagnostic !== undefined) return diagnostic;
    const destructiveCause = copyKnownError(cause.causeDiagnostic);
    if (destructiveCause !== undefined) return destructiveCause;
  }
  return Object.freeze({
    code: "cli.failed",
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
  });
}

export function generatedCliErrorCategory(error: GeneratedCliErrorEnvelope): GeneratedCliErrorCategory {
  if (error.code === "cli.cancelled") return "cancelled";
  if (error.code === "cli.failed") return "unexpected";
  if (error.code.startsWith("manifest.execution.")
      || error.code.startsWith("manifest.transfer.")
      || error.code.startsWith("manifest.workflow.")
      || error.code.startsWith("cli.workflow-")
      || error.code.startsWith("cli.maintenance-")) return "operation";
  const separator = error.code.indexOf(".");
  const namespace = separator < 0 ? error.code : error.code.slice(0, separator);
  if (namespace === "manifest" || DEFINITION_NAMESPACES.has(namespace)) return "definition";
  if (OPERATION_NAMESPACES.has(namespace)) return "operation";
  if (HOST_NAMESPACES.has(namespace)) return "host";
  return "uncategorized";
}

export function generatedCliExitCode(category: GeneratedCliErrorCategory): number {
  return EXIT_CODE_BY_CATEGORY[category];
}

export function generatedCliFailure(cause: unknown): GeneratedCliFailure {
  const error = generatedCliError(cause);
  const category = generatedCliErrorCategory(error);
  return Object.freeze({ error, category, exitCode: generatedCliExitCode(category) });
}
