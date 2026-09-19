import { open, stat } from "node:fs/promises";
import type {
  AuthoredDescription,
  AuthoredOperation,
  AuthoredValueType,
  FixedSemanticUnitContract,
  HostByteSource,
  ResourceId,
} from "@protodriver/contracts";
import { generatedCliExpectedError } from "./errors.ts";
import {
  formatGeneratedHumanBase64Bytes,
  formatGeneratedHumanBytes,
  formatGeneratedHumanUnitValue,
  type AuthoredResultControl,
  type GeneratedResultValueModel,
} from "@protodriver/control-model";

export { saveAuthoredOutput } from "./authored-output.ts";

export function renderAuthoredCliHelp(description: AuthoredDescription, operationId?: string): string {
  const displayName = description.displayName ?? description.id;
  if (operationId !== undefined) {
    const operation = description.operations.find(({ id }) => id === operationId);
    if (operation === undefined) throw new Error(`unknown authored operation: ${operationId}`);
    const inputs = Object.entries(operation.arguments).flatMap(([name, argument]) => [
      `  ${name}: ${argument.label ?? name}`,
      ...(argument.description === undefined ? [] : indentAuthoredText(argument.description, "    ")),
    ]);
    return renderAuthoredOperationHelpDocument({
      heading: `${displayName} — ${operation.title}`,
      description: operation.description,
      usage: `pdr run <package> [--mode id] [--profile id] [--candidate id | --serial-path path] [--expect-source-set-sha256 hex] [--json]${operation.result.kind === "file" || operation.result.kind === "resource" ? " [--save-result path]" : ""} ${operation.id}${Object.keys(operation.arguments).length === 0 ? "" : " [flags]"}`,
      risk: operation.risk,
      repeatability: operation.repeatability,
      inputs,
      result: authoredResultHelp(operation, "  "),
      file: operation.result.kind === "file" ? `  --save-result <path.${operation.result.suggestedExtension}> writes the declared ${operation.result.mediaType} bytes unchanged.` : undefined,
    });
  }
  const lines = [
    `${displayName} (${description.id}, device/v2)`,
    ...(description.description === undefined ? [] : ["", ...indentAuthoredText(description.description, "")]),
    "",
    "Modes:",
    ...description.modes.flatMap((modeId) => {
      const presentation = description.modePresentation?.[modeId];
      return [
        `  ${modeId.padEnd(28)} ${presentation?.label ?? `mode ${modeId}`}`,
        ...(presentation?.description === undefined ? [] : indentAuthoredText(presentation.description, "    ")),
      ];
    }),
    "",
    "Tasks:",
    ...description.operations.flatMap((operation) => [
      `  ${operation.id}: ${operation.title} [${operation.risk}; ${operation.repeatability}; ${authoredResultSummary(operation)}]`,
      ...(operation.description === undefined ? [] : indentAuthoredText(operation.description, "    ")),
    ]),
    "",
    description.connectionProfiles
      ? "Transport requests declared; acquisition remains subject to host approval."
      : "Host-supplied acquisition required; this protocol-only package is not self-contained.",
    ...Object.entries(description.connectionProfiles ?? {}).map(([id, profile]) =>
      `Profile ${id}: ${profile.transport.kind}; modes ${profile.modes.join(", ")}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function authoredResultSummary(operation: AuthoredOperation): string {
  const result = operation.result;
  if (result.kind === "none") return "no result";
  if (result.kind === "value") return "value";
  return `${result.kind} ${result.mediaType}${result.suggestedExtension === undefined ? "" : ` .${result.suggestedExtension}`}`;
}

function authoredResultHelp(operation: AuthoredOperation, prefix: string): string[] {
  const result = operation.result;
  if (result.kind === "none") return [`${prefix}(no result)`];
  if (result.kind === "value") return [`${prefix}value`, ...authoredValueTypeHelp(result.type, `${prefix}  `)];
  return [
    `${prefix}${result.kind} (${result.mediaType}${result.suggestedExtension === undefined ? "" : `, .${result.suggestedExtension}`})`,
    `${prefix}  ${result.content}`,
    `${prefix}  declared bytes ${result.minimumBytes}..${result.maximumBytes}`,
  ];
}

function authoredValueTypeHelp(type: AuthoredValueType, prefix: string): string[] {
  if (type.kind === "record" && type.fields !== undefined) return [
    `${prefix}record`,
    ...Object.entries(type.fields).flatMap(([name, field]) => [
      `${prefix}  ${type.fieldLabels?.[name] ?? name} (${name})`,
      ...authoredValueTypeHelp(field, `${prefix}    `),
    ]),
  ];
  if (type.kind === "array" && type.item !== undefined)
    return [`${prefix}array`, ...authoredValueTypeHelp(type.item, `${prefix}  `)];
  if (type.kind === "variant" && type.variants !== undefined) return [
    `${prefix}variant`,
    ...Object.entries(type.variants).flatMap(([name, variant]) => [
      `${prefix}  ${name}`,
      ...authoredValueTypeHelp(variant, `${prefix}    `),
    ]),
  ];
  const bounds = type.minimumLength !== undefined || type.maximumLength !== undefined
    ? ` bytes ${type.minimumLength ?? 0}..${type.maximumLength ?? "unbounded"}`
    : type.minimum !== undefined || type.maximum !== undefined
      ? ` ${type.minimum ?? "unbounded"}..${type.maximum ?? "unbounded"}`
      : "";
  return [`${prefix}${type.kind}${bounds}`];
}

export function renderAuthoredCliState(model: AuthoredResultControl, cell: import("@protodriver/contracts").StateCellSnapshot): string {
  return (cell.quality === "unknown" ? "Unknown (not observed)" : cell.quality === "stale" ? "Stale" : cell.quality === "invalid" ? "Invalid" : "Current")
    + (cell.value === undefined ? "" : ": " + renderAuthoredCliResult(model, cell.value));
}
export function renderAuthoredCliResult(model: AuthoredResultControl | null, value: unknown, path = "$.result"): string {
  if (model === null) return "";
  if (model.kind === "leaf") return formatCliResultValue(model.value, value, path);
  if (model.kind === "array") {
    if (!Array.isArray(value)) throw new Error("authored result array required at " + path);
    return value.map((item, i) => '[' + i + '] ' + renderAuthoredCliResult(model.item, item, path + '[' + i + ']')).join('\n');
  }
  if (!cliIsObjectRecord(value)) throw new Error("authored result record required at " + path);
  if (model.kind === "variant") {
    if (value.kind !== "variant" || typeof value.tag !== "string" || !Object.hasOwn(model.variants, value.tag)) throw new Error("undeclared authored variant");
    return cliLabel(value.tag) + ': ' + renderAuthoredCliResult(model.variants[value.tag]!, value.value, path + '.' + value.tag);
  }
  return Object.entries(model.fields).map(([key, child]) => cliLabel(key) + ': ' + renderAuthoredCliResult(child, value[key], path + '.' + key)).join('\n');
}

function cliUnknownKind(subject: string, path: string, kind: string): never {
  throw new Error(`CLI renderer has no ${subject} kind ${JSON.stringify(kind)} at ${path}`);
}

function renderAuthoredOperationHelpDocument(view: {
  readonly heading: string;
  readonly description: string | undefined;
  readonly usage: string;
  readonly risk: string;
  readonly repeatability: string;
  readonly inputs: readonly string[];
  readonly result: readonly string[];
  readonly file: string | undefined;
}): string {
  const lines = [
    view.heading,
    ...(view.description === undefined ? [] : ["", ...indentAuthoredText(view.description, "")]),
    "",
    `Usage: ${view.usage}`,
    "",
    `Risk: ${view.risk}`,
    `Repeatability: ${view.repeatability}`,
    ...(view.inputs.length === 0 ? [] : ["", "Inputs:", ...view.inputs]),
    "",
    "Result:",
    ...view.result,
    "",
    "JSON:",
    "  --json emits one fixed operation envelope; result contains every declared field.",
    ...(view.file === undefined ? [] : ["", "File result:", view.file]),
  ];
  return `${lines.join("\n")}\n`;
}

function indentAuthoredText(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

function formatCliResultValue(model: GeneratedResultValueModel, value: unknown, path: string): string {
  if (value === undefined) return "Not observed";
  switch (model.kind) {
    case "scalar": return formatCliScalarWithUnit(value, model.unit, path);
    case "bytes": return formatCliBytes(value, path);
    case "member": {
      if (typeof value !== "string") return cliUnrenderableValue(model.kind, path);
      const member = model.members.find(({ name }) => name === value);
      if (member === undefined) throw new Error(`CLI renderer has no declared member ${JSON.stringify(value)} at ${path}`);
      return member.label ?? cliLabel(member.name);
    }
    case "flags": {
      const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : undefined;
      if (values === undefined || values.some((member) => typeof member !== "string")) return cliUnrenderableValue(model.kind, path);
      if (values.length === 0) return "None";
      return values.map((name) => {
        const member = model.members.find((candidate) => candidate.name === name);
        if (member === undefined) throw new Error(`CLI renderer has no declared flag ${JSON.stringify(name)} at ${path}`);
        return member.label ?? cliLabel(member.name);
      }).join(", ");
    }
    case "packed-bcd": {
      const tagged = cliTaggedKind(value, path);
      if (tagged.kind === "value") return formatCliScalarWithUnit(tagged.value, model.unit, `${path}.value`);
      if (tagged.kind === "special" && typeof tagged.name === "string") {
        const special = model.specialValues.find(({ name }) => name === tagged.name);
        if (special === undefined) throw new Error(`CLI renderer has no declared special value ${JSON.stringify(tagged.name)} at ${path}`);
        return special.label ?? cliLabel(special.name);
      }
      return cliUnknownKind("result value", path, tagged.kind);
    }
    case "variant": {
      const tagged = cliTaggedKind(value, path);
      const variant = model.variants.find(({ name }) => name === tagged.kind);
      if (variant === undefined) return cliUnknownKind("result variant", path, tagged.kind);
      if (!("fields" in tagged) || !cliIsObjectRecord(tagged.fields)) return cliUnrenderableValue(model.kind, path);
      const fields = tagged.fields;
      const title = variant.label ?? cliLabel(variant.name);
      if (variant.fields.length === 0) return title;
      return `${title} — ${variant.fields.map((field) => (
        `${field.label ?? cliLabel(field.name)}: ${formatCliResultValue(field.value, fields[field.name], `${path}.fields.${field.name}`)}`
      )).join(", ")}`;
    }
  }
}

function formatCliScalar(value: unknown, path: string): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length === 0 ? "Empty text" : value;
  if (cliIsObjectRecord(value) && "type" in value && "value" in value && typeof value.value === "string") {
    if (value.type === "u64" || value.type === "i64" || value.type === "decimal") return value.value;
    if (value.type === "bytes") {
      return formatGeneratedHumanUnitValue(String(cliBase64ByteLength(value.value)), { kind: "fixed", id: "byte" });
    }
    return cliUnknownKind("public scalar", path, String(value.type));
  }
  if (cliIsObjectRecord(value) && value.kind === "decimal" && typeof value.value === "number"
    && (value.suffix === null || typeof value.suffix === "string")) {
    return `${value.value}${value.suffix ?? ""}`;
  }
  if (cliIsObjectRecord(value) && typeof value.kind === "string") {
    return cliUnknownKind("result value", path, value.kind);
  }
  return cliUnrenderableValue("scalar", path);
}

function formatCliScalarWithUnit(
  value: unknown,
  unit: FixedSemanticUnitContract | null,
  path: string,
): string {
  if (unit === null) return formatCliScalar(value, path);
  const decimal = cliDecimalValueText(value);
  if (decimal === null) return cliUnrenderableValue("numeric scalar", path);
  return formatGeneratedHumanUnitValue(decimal, unit);
}

function cliDecimalValueText(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return value.toString(10);
  if (cliIsObjectRecord(value) && (value.type === "u64" || value.type === "i64" || value.type === "decimal")
    && typeof value.value === "string") return value.value;
  return null;
}

function formatCliBytes(value: unknown, path: string): string {
  if (value instanceof Uint8Array) {
    return formatGeneratedHumanBytes(value);
  }
  if (cliIsObjectRecord(value) && value.type === "bytes" && value.encoding === "base64" && typeof value.value === "string") {
    return formatGeneratedHumanBase64Bytes(value.value);
  }
  return cliUnrenderableValue("bytes", path);
}

function cliBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length === 0 ? 0 : value.length / 4 * 3 - padding;
}

function cliTaggedKind(value: unknown, path: string): Readonly<Record<string, unknown>> & { readonly kind: string } {
  if (!cliIsObjectRecord(value) || typeof value.kind !== "string") return cliUnrenderableValue("tagged", path);
  return value as Readonly<Record<string, unknown>> & { readonly kind: string };
}

function cliIsObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function cliUnrenderableValue(kind: string, path: string): never {
  throw new Error(`CLI renderer cannot render ${kind} value at ${path}`);
}

function cliLabel(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

export class FileByteSource implements HostByteSource {
  readonly origin = "file" as const;
  readonly byteLength: number;
  readonly #handle: Awaited<ReturnType<typeof open>>;
  #offset = 0;
  #closed = false;

  private constructor(handle: Awaited<ReturnType<typeof open>>, byteLength: number) {
    this.#handle = handle;
    this.byteLength = byteLength;
  }

  static async open(path: string, byteLength: number): Promise<FileByteSource> {
    return new FileByteSource(await open(path, "r"), byteLength);
  }

  async read(into: Uint8Array): Promise<{ readonly bytesRead: number; readonly eof: boolean }> {
    if (this.#closed) throw new Error("byte source is closed");
    const { bytesRead } = await this.#handle.read(into, 0, into.byteLength, this.#offset);
    this.#offset += bytesRead;
    // Metadata is not EOF: a file can have grown since stat. A zero-byte read
    // witnesses its observed end without silently truncating to cached size.
    return { bytesRead, eof: bytesRead === 0 };
  }

  async seek(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength) {
      throw new Error(`byte source seek ${offset} is outside [0, ${this.byteLength}]`);
    }
    this.#offset = offset;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

/** File selection stays local; content reads happen only in operation preparation. */
export async function registerAuthoredFileArgument(operation: import("@protodriver/contracts").AuthoredOperation,
  name: string, path: string, register: (source: HostByteSource) => Promise<ResourceId>) {
  const type = operation.arguments[name];
  if (type?.kind !== "byte-source" && type?.kind !== "stream-source") throw new Error("argument is not a declared file source: " + name);
  let metadata;
  try { metadata = await stat(path); }
  catch (cause) {
    const code = cause instanceof Error && "code" in cause ? (cause as NodeJS.ErrnoException).code : undefined;
    throw generatedCliExpectedError(code === "ENOENT" || code === "ENOTDIR" ? "cli.path.not-found" : "cli.filesystem.failed",
      code === "ENOENT" || code === "ENOTDIR" ? `source file ${path} does not exist` : `cannot inspect source file ${path}`,
      code === "ENOENT" || code === "ENOTDIR" ? "invocation" : "host", cause);
  }
  if (!metadata.isFile()) throw generatedCliExpectedError("cli.argument.file-required", "source selection must be a file", "invocation");
  let source: FileByteSource;
  try { source = await FileByteSource.open(path, metadata.size); }
  catch (cause) {
    const code = cause instanceof Error && "code" in cause ? (cause as NodeJS.ErrnoException).code : undefined;
    throw generatedCliExpectedError(code === "ENOENT" || code === "ENOTDIR" ? "cli.path.not-found" : "cli.filesystem.failed",
      code === "ENOENT" || code === "ENOTDIR" ? `source file ${path} no longer exists` : `cannot open source file ${path}`,
      code === "ENOENT" || code === "ENOTDIR" ? "invocation" : "host", cause);
  }
  try { return { argument: { kind: "resource" as const, id: await register(source) }, close: () => source.close() }; }
  catch (cause) { await source.close(); throw cause; }
}
