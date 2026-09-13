import type { AuthoredDescription, AuthoredValueType, FixedSemanticUnitContract, AuthoredResourceResult, OperationResult, ResourceId, StateCellSnapshot } from "@protodriver/contracts";
import type { GeneratedResultValueModel } from "./index.ts";

/** Recursive public-result projection. No legacy workflow/decoder inference. */
export type AuthoredResultControl = {
  readonly declaration: AuthoredValueType;
  readonly label?: string;
} & (
  | { readonly kind: "leaf"; readonly value: GeneratedResultValueModel }
  | { readonly kind: "record"; readonly fields: Readonly<Record<string, AuthoredResultControl>> }
  | { readonly kind: "array"; readonly item: AuthoredResultControl }
  | { readonly kind: "variant"; readonly variants: Readonly<Record<string, AuthoredResultControl>> }
);
export function generateAuthoredResultControl(type: AuthoredValueType, label?: string): AuthoredResultControl {
  const declaration = structuredClone(type);
  const children = (fields: Readonly<Record<string, AuthoredValueType>>) => Object.freeze(Object.fromEntries(
    Object.keys(fields).sort().map(name => [name, generateAuthoredResultControl(fields[name]!, type.fieldLabels?.[name])])));
  if (type.kind === "record") return Object.freeze({ declaration, ...(label === undefined ? {} : {label}), kind: "record", fields: children(type.fields!) });
  if (type.kind === "array") return Object.freeze({ declaration, ...(label === undefined ? {} : {label}), kind: "array", item: generateAuthoredResultControl(type.item!) });
  if (type.kind === "variant") return Object.freeze({ declaration, ...(label === undefined ? {} : {label}), kind: "variant", variants: children(type.variants!) });
  const value: GeneratedResultValueModel = type.kind === "bytes" ? { kind: "bytes" }
    : type.kind === "enum" || type.kind === "flags" ? { kind: type.kind === "enum" ? "member" : "flags", members: type.members!.map(name => ({ name })) }
    : { kind: "scalar", unit: (type.unit as FixedSemanticUnitContract | undefined) ?? null };
  return Object.freeze({ declaration, ...(label === undefined ? {} : {label}), kind: "leaf", value });
}
export function generateAuthoredControlModel(description: AuthoredDescription) {
  return Object.freeze({ apiVersion: description.apiVersion, id: description.id,
    ...(description.displayName === undefined ? {} : {displayName:description.displayName}),
    ...(description.description === undefined ? {} : {description:description.description}),
    ...(description.modePresentation === undefined ? {} : {modePresentation:description.modePresentation}),
    modes: description.modes, profiles: description.profiles,
    state: Object.fromEntries(Object.entries(description.state ?? {}).map(([id, cell]) => [id, { ...cell, valueControl: generateAuthoredResultControl(cell.type) }])),
    operations: description.operations.map(operation => Object.freeze({ ...operation,
      argumentControls: Object.fromEntries(Object.entries(operation.arguments).map(([name, type]) => [name,
        type.kind === "byte-source" || type.kind === "stream-source" ? { kind: "file" as const, minimumBytes: type.minimumBytes, maximumBytes: type.maximumBytes,
          ...(type.label === undefined ? {} : {label:type.label}),...(type.description === undefined ? {} : {description:type.description}) }
          : { kind: "value" as const, type, ...(type.label === undefined ? {} : {label:type.label}),...(type.description === undefined ? {} : {description:type.description}) }])),
      resultControl: operation.result.kind === "value" ? generateAuthoredResultControl(operation.result.type) : null,
    })) });
}

/** Author cannot turn arbitrary returned bytes or a nested record into a file. */
export function requireAuthoredOutput(model: AuthoredResourceResult, outcome: OperationResult, destinationId: ResourceId, bytes: number): void {
  const r = outcome.resourceResult;
  if (outcome.outcome !== "completed" || outcome.result !== null || !r || r.destinationId !== destinationId || r.kind !== model.kind
    || r.content !== model.content || r.mediaType !== model.mediaType || r.suggestedExtension !== model.suggestedExtension
    || r.byteLength !== bytes || bytes < model.minimumBytes || bytes > model.maximumBytes) throw new Error("declared operation output did not complete with its resource receipt: " + JSON.stringify(outcome));
}
export function authoredStateLabel(cell: StateCellSnapshot): string {
  return cell.quality === "unknown" ? "Unknown (not observed)" : cell.quality === "stale" ? "Stale" : cell.quality === "invalid" ? "Invalid" : "Current";
}
