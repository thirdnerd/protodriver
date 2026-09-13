import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort } from "@protodriver/lua-vm/retained";
import { activeNativeScratch, nativeValue, nativeJson, nativeEncode } from "@protodriver/lua-vm/retained";
import type { PublicValue, TypeDescriptor, OperationArgument, AuthoredDescription, AuthoredOperation, AuthoredValueType } from "@protodriver/contracts";
export type { AuthoredDescription, AuthoredOperation, AuthoredValueType } from "@protodriver/contracts";
import { SEMANTIC_UNIT_IDENTIFIERS } from "@protodriver/contracts";
import { DEFAULT_HOST_RESOURCE_LIMITS } from "@protodriver/contracts/limits";
import { DefaultValueCodec } from "./values.ts";
import { pollPlans } from "./authored-poll.ts";
import { validateStreamedResult } from "./streaming-result.ts";
import { validateSerialProfilePolicy } from "./serial-profile.ts";
import { validateUsbProfilePolicyDeclaration } from "./usb-profile.ts";

export class AuthoredAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(code + ": " + message); this.code = code; }
}
const bad = (path: string, detail: string): never => { throw new AuthoredAdmissionError("authored.declaration.invalid", path + ": " + detail); };
function record(value: unknown, path: string): Record<string, unknown> {
  activeNativeScratch()?.node();
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad(path, "record required");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) bad(path, "missing " + key);
  for (const key of nativeKeys(value)) if (![...required, ...optional].includes(key)) bad(path, "unexpected " + key);
}
function name(value: unknown, path: string): string {
  if (typeof value === "string") activeNativeScratch()?.text(value);
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(value)) bad(path, "bounded identifier required");
  return value as string;
}
function authoredText(value: unknown, path: string): string {
  if (typeof value === "string") activeNativeScratch()?.text(value);
  if (typeof value !== "string" || !value.trim()) bad(path, "nonblank authored text required");
  return value as string;
}
function names(value: unknown, path: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.length > 128 || (nonempty && !value.length)) bad(path, "bounded identifier array required");
  const result = nativeArray((value as unknown[])).map(item => name(item, path));
  if (new Set(result).size !== result.length) bad(path, "duplicate identifier");
  return result;
}
function validateConnectionProfiles(d: Record<string, unknown>, modes: string[], profiles: string[]): void {
  const requests = record(d.connectionProfiles, "connectionProfiles");
  keys(requests, profiles, [], "connectionProfiles");
  for (const [id, raw] of nativeEntries(requests)) {
    const path = "connectionProfiles." + id, p = record(raw, path), transport = record(p.transport, path + ".transport");
    const serial = transport.kind === "serial";
    if (!serial && transport.kind !== "usb") bad(path, "unsupported transport kind; explicit host-supplied grant requires a supported declaration");
    keys(p, ["modes", "acquisitionFilters", "transport", ...(serial ? ["channels", "lifecycle"] : [])], serial ? [] : ["requiredProductName"], path);
    if (names(p.modes, path + ".modes", true).some(mode => !modes.includes(mode))) bad(path, "unknown mode");
    if (!Array.isArray(p.acquisitionFilters) || !p.acquisitionFilters.length || p.acquisitionFilters.length > 128) bad(path, "1..128 candidate filters required");
    for (const raw of nativeArray(p.acquisitionFilters as unknown[])) {
      const f = record(raw, path + ".acquisitionFilters");
      keys(f, ["transport"], serial ? ["vendorId", "productId"] : ["vendorId", "productId", "usbClass"], path);
      if (f.transport !== transport.kind) bad(path, "matcher transport disagrees with profile");
      for (const key of ["vendorId", "productId", "usbClass"]) if (f[key] !== undefined
        && (!Number.isSafeInteger(f[key]) || (f[key] as number) < 0 || (f[key] as number) > (key === "usbClass" ? 255 : 65535))) bad(path, "invalid " + key);
      if (f.productId !== undefined && f.vendorId === undefined) bad(path, "product matcher requires vendorId");
    }
    let channels: string[];
    if (serial) {
      keys(transport, ["kind", "baudRate", "dataBits", "parity", "stopBits", "flowControl"], [], path);
      if (!Array.isArray(p.channels) || p.channels.length !== 1) bad(path, "serial requires exactly one channel");
      const channel = record((p.channels as unknown[])[0], path + ".channels"); keys(channel, ["id", "protocolDuplex"], [], path);
      channels = [name(channel.id, path + ".channels.id")];
      const lifecycle = record(p.lifecycle, path + ".lifecycle"); keys(lifecycle, ["openingDrainQuietMs", "postTerminationSilence"], [], path);
      const silence = record(lifecycle.postTerminationSilence, path); keys(silence, ["minimumMs", "afterAbnormalTermination", "afterModeExit"], [], path);
      if (typeof silence.afterAbnormalTermination !== "boolean" || typeof silence.afterModeExit !== "boolean") bad(path, "silence causes require booleans");
      try { validateSerialProfilePolicy(transport as unknown as import("@protodriver/contracts").SerialLineParameters,
        lifecycle as unknown as import("@protodriver/contracts").SerialProfileLifecyclePolicy, channel.protocolDuplex as import("@protodriver/contracts").SerialProtocolDuplex, path); }
      catch (cause) { bad(path, String(cause)); }
    } else {
      keys(transport, ["kind", "configurationValue", "interfaceNumber", "alternateSetting", "channels"], [], path);
      if (!Array.isArray(transport.channels) || !transport.channels.length || transport.channels.length > 128) bad(path, "1..128 USB channels required");
      channels = nativeArray(transport.channels as unknown[]).map(raw => {
        const channel = record(raw, path); keys(channel, ["id", "input", "output"], [], path);
        for (const direction of ["input", "output"]) if (channel[direction] !== null) {
          const endpoint = record(channel[direction], path); keys(endpoint, ["endpointNumber", "transferType", "maximumPacketBytes"], [], path);
          keys(record(endpoint.maximumPacketBytes, path), [], ["full", "high"], path);
        }
        return name(channel.id, path + ".channels.id");
      });
      if (p.requiredProductName !== undefined && (typeof p.requiredProductName !== "string" || !p.requiredProductName.length || p.requiredProductName.length > 256)) bad(path, "bounded exact product name required");
      try { validateUsbProfilePolicyDeclaration(transport as unknown as import("@protodriver/contracts").UsbProfilePolicy, path); }
      catch (cause) { bad(path, String(cause)); }
    }
    const roles = (d.channelRoles as Record<string, Record<string, string>> | undefined)?.[id];
    if (roles && nativeValues(roles).some(channel => !channels.includes(channel))) bad(path, "channel role is not a physical channel in this profile");
    if (!roles && (channels.length !== 1 || channels[0] !== "main")) bad(path, "non-main physical topology requires explicit channelRoles");
    if (roles && !serial) {
      const physical = transport.channels as Array<{ id: string; input: unknown; output: unknown }>;
      if (physical.find(c => c.id === roles.request)!.output === null
        || physical.find(c => c.id === roles.response)!.input === null || physical.find(c => c.id === roles.event)!.input === null) bad(path, "channel role direction is unavailable");
    }
  }
}
function type(value: unknown, path: string, depth = 0, presentation = false): AuthoredValueType {
  activeNativeScratch()?.node();
  if (depth > 16) bad(path, "type nesting exceeds 16");
  const v = record(value, path), kind = v.kind;
  const fields: Record<string, string[]> = { null: [], boolean: [], integer: ["widthBits", "signed", "minimum", "maximum", "unit"],
    float: ["minimum", "maximum", "unit"], decimal: ["unit"], string: ["minimumLength", "maximumLength"], bytes: ["minimumLength", "maximumLength"],
    enum: ["members"], flags: ["members"], array: ["item", "minimumLength", "maximumLength"], record: ["fields", "fieldLabels"], variant: ["variants"] };
  if (typeof kind !== "string" || !Object.hasOwn(fields, kind)) bad(path, "unknown value kind");
  keys(v, ["kind"], [...fields[kind as string]!, ...(presentation ? ["label", "description"] : [])], path);
  if (presentation) for (const member of ["label", "description"]) if (v[member] !== undefined) authoredText(v[member], path + "." + member);
  if (kind === "integer" && (![8, 16, 32, 64].includes(v.widthBits as number) || typeof v.signed !== "boolean")) bad(path, "integer width and signedness required");
  if (kind === "enum" || kind === "flags") {
    if (!Array.isArray(v.members) || !v.members.length || v.members.length > 128 || nativeArray(v.members).some(member => typeof member !== "string" || nativeEncode(member).length > 256)
      || new Set(v.members).size !== v.members.length) bad(path, "bounded unique text members required");
  }
  if (kind === "array") type(v.item, path + ".item", depth + 1);
  for (const field of kind === "record" ? ["fields"] : kind === "variant" ? ["variants"] : []) {
    const children = record(v[field], path + "." + field);
    if (nativeKeys(children).length > 128 || (kind === "variant" && !nativeKeys(children).length)) bad(path, "invalid member population");
    for (const [key, child] of nativeEntries(children)) { name(key, path); type(child, path + "." + key, depth + 1); }
  }
  if (kind === "record" && v.fieldLabels !== undefined) {
    const labels = record(v.fieldLabels, path + ".fieldLabels"), children = v.fields as Record<string, unknown>;
    if (nativeKeys(labels).length > 128) bad(path, "result field label population exceeds 128");
    for (const [key, label] of nativeEntries(labels)) {
      if (!Object.hasOwn(children, key)) bad(path + ".fieldLabels", "label names an unknown field " + key);
      authoredText(label, path + ".fieldLabels." + key);
    }
  }
  for (const bound of ["minimum", "maximum", "minimumLength", "maximumLength"]) if (v[bound] !== undefined) {
    if (typeof v[bound] !== "number" || !Number.isFinite(v[bound]) || Object.is(v[bound], -0)) bad(path, "invalid " + bound);
    if (kind === "integer" && !bound.endsWith("Length") && !Number.isSafeInteger(v[bound])) bad(path, "integer restriction must be an exact safe integer");
    if (bound.endsWith("Length") && (!Number.isSafeInteger(v[bound]) || (v[bound] as number) < 0 || (v[bound] as number) > 65536)) bad(path, "invalid length bound");
  }
  if (typeof v.minimum === "number" && typeof v.maximum === "number" && v.minimum > v.maximum) bad(path, "inverted value range");
  if (kind === "integer") {
    const width = BigInt(v.widthBits as number), lowest = v.signed ? -(1n << (width - 1n)) : 0n,
      highest = v.signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
    for (const bound of [v.minimum, v.maximum]) if (typeof bound === "number" && (BigInt(bound) < lowest || BigInt(bound) > highest)) bad(path, "restriction outside integer type range");
  }
  if (typeof v.minimumLength === "number" && typeof v.maximumLength === "number" && v.minimumLength > v.maximumLength) bad(path, "inverted length range");
  if (v.unit !== undefined) {
    const unit = record(v.unit, path + ".unit"); keys(unit, ["kind", "id"], [], path);
    if (unit.kind !== "fixed" || !(SEMANTIC_UNIT_IDENTIFIERS as readonly unknown[]).includes(unit.id)) bad(path, "unknown fixed unit");
  }
  return v as unknown as AuthoredValueType;
}
export function canonicalAuthoredBytes(value: unknown): Uint8Array {
  const sort = (v: unknown): unknown => {
    // JSON would turn NaN/Infinity into null, silently granting unaged state.
    if (typeof v === "number" && !Number.isFinite(v)) bad("description", "non-finite number is not an explicit null");
    return Array.isArray(v) ? nativeArray(v).map(sort) : v && typeof v === "object"
      ? nativeRecord(nativeSort(nativeArray(nativeKeys(v))).map(key => [key, sort((v as Record<string, unknown>)[key])])) : v;
  };
  return nativeEncode(nativeJson(sort(value)));
}
/** Takes an owned, deeply frozen canonical description; no caller mutations survive. */
export function admitAuthoredDescription(value: unknown, bindings: readonly string[]): AuthoredDescription {
  const encoded = canonicalAuthoredBytes(value);
  if (encoded.length > 65536) bad("description", "description exceeds 64 KiB");
  // Parsing retains a second description, not just the UTF-8 buffer. The
  // structural copy and decoder workspace are reserved before either call.
  nativeValue(value);
  activeNativeScratch()?.reserve(8 + encoded.length * 3);
  activeNativeScratch()?.work(1 + Math.ceil(encoded.length / 256));
  const d = record(JSON.parse(new TextDecoder().decode(encoded)), "description");
  if (d.apiVersion !== "device/v2") throw new AuthoredAdmissionError("authored.api-version", "device/v2 required");
  keys(d, ["apiVersion", "id", "modes", "profiles", "operations"], ["displayName", "description", "modePresentation", "invalidation", "entry", "state", "maintenance", "handlers", "mailboxes", "channelRoles", "connectionProfiles"], "description");
  name(d.id, "id"); const modes = names(d.modes, "modes", true), profiles = names(d.profiles, "profiles", true);
  for (const member of ["displayName", "description"]) if (d[member] !== undefined) authoredText(d[member], member);
  if (d.modePresentation !== undefined) {
    const presentation = record(d.modePresentation, "modePresentation");
    for (const [mode, raw] of nativeEntries(presentation)) {
      if (!modes.includes(mode)) bad("modePresentation", "unknown mode " + mode);
      const item = record(raw, "modePresentation." + mode);keys(item, [], ["label", "description"], "modePresentation." + mode);
      if (!nativeKeys(item).length) bad("modePresentation." + mode, "label or description required");
      for (const member of ["label", "description"]) if (item[member] !== undefined) authoredText(item[member], "modePresentation." + mode + "." + member);
    }
  }
  if (d.channelRoles !== undefined) for (const [profile, raw] of nativeEntries(record(d.channelRoles, "channelRoles"))) {
    if (!profiles.includes(profile)) bad("channelRoles", "unknown profile");
    const roles = record(raw, "channelRoles." + profile); keys(roles, ["request", "response", "event"], [], "channelRoles");
    for (const role of ["request", "response", "event"]) { activeNativeScratch()?.iteration(); name(roles[role], "channelRoles." + role); }
  }
  if (d.connectionProfiles !== undefined) validateConnectionProfiles(d, modes, profiles);
  names([...bindings], "callable bindings");
  if (d.invalidation !== undefined && !bindings.includes(name(d.invalidation, "invalidation"))) throw new AuthoredAdmissionError("authored.binding.unresolved", "invalidation binding is unresolved");
  if (d.entry !== undefined) {
    const entry = record(d.entry, "entry"); keys(entry, ["binding", "locks", "requires"], ["handoffTo", "inputEvidence"], "entry");
    if (entry.inputEvidence !== undefined && (entry.inputEvidence !== "consumed-ranges" || entry.handoffTo === undefined))
      bad("entry.inputEvidence", "consumed-ranges requires a named handoff recipient");
    if (entry.handoffTo !== undefined) name(entry.handoffTo, "entry.handoffTo");
    if (!bindings.includes(name(entry.binding, "entry.binding"))) throw new AuthoredAdmissionError("authored.binding.unresolved", "entry binding is unresolved");
    names(entry.locks, "entry.locks"); names(entry.requires, "entry.requires");
    if ((entry.requires as string[]).includes("operation.deadline")) bad("entry.requires", "operation deadlines are not entry authority");
  }
  if (!Array.isArray(d.operations) || !d.operations.length || d.operations.length > 128) bad("operations", "1..128 operations required");
  const ids = new Set<string>();
  for (const raw of d.operations as unknown[]) {
    const op = record(raw, "operation");
    const id = name(op.id, "operation.id"); if (ids.has(id)) bad(id, "duplicate operation"); ids.add(id);
    keys(op, ["id", "title", "binding", "arguments", "result", "risk", "repeatability", "locks", "availability", "requires"], ["description", "writeVia", "cleanup", "releaseAfterIdleMs", "reentry", "transfer"], "operation");
    if (op.releaseAfterIdleMs !== undefined && (!Number.isSafeInteger(op.releaseAfterIdleMs)
      || (op.releaseAfterIdleMs as number) < 1 || (op.releaseAfterIdleMs as number) > 2147483647)) bad(id, "invalid releaseAfterIdleMs");
    if (op.reentry !== undefined) {
      const r = record(op.reentry, id + ".reentry"); keys(r, ["binding", "requires"], [], id + ".reentry");
      if (!bindings.includes(name(r.binding, id + ".reentry.binding"))) throw new AuthoredAdmissionError("authored.binding.unresolved", "reentry binding unresolved");
      names(r.requires, id + ".reentry.requires");
    }
    if (typeof op.title !== "string" || !op.title.length || op.title.length > 256) bad(id, "bounded title required");
    if (op.description !== undefined) authoredText(op.description, id + ".description");
    if (!bindings.includes(name(op.binding, id + ".binding"))) throw new AuthoredAdmissionError("authored.binding.unresolved", id + ": " + op.binding);
    if (!["read-only", "changes-state", "destructive", "firmware"].includes(op.risk as string)) bad(id, "risk claim required");
    if (!["not-repeatable", "safe-to-repeat"].includes(op.repeatability as string)) bad(id, "repeatability claim required");
    names(op.locks, id + ".locks"); names(op.requires, id + ".requires");
    if (op.cleanup !== undefined) {
      const c = record(op.cleanup, id + ".cleanup");
      keys(c, ["binding", "requires", "maximumMilliseconds", "maximumLuaFuel", "maximumWork"], ["writeVia"], id + ".cleanup");
      if (!bindings.includes(name(c.binding, id + ".cleanup.binding"))) throw new AuthoredAdmissionError("authored.binding.unresolved", id + ": cleanup binding unresolved");
      const allowed = ["channel.read", "channel.write", "timer", "clock.observe", "expiry.observe", "input.retirement", "usb.control", "connection.lifecycle", "transfer.cleanup", "channel.write-via", "mailbox"];
      if (names(c.requires, id + ".cleanup.requires").some(r => !allowed.includes(r))) bad(id, "unsupported cleanup authority");
      if (c.writeVia !== undefined) name(c.writeVia, id + ".cleanup.writeVia");
      if ((c.writeVia !== undefined) !== (c.requires as string[]).includes("channel.write-via"))
        bad(id, "cleanup writeVia and channel.write-via must occur together");
      if ((c.requires as string[]).includes("mailbox") && c.writeVia === undefined)
        bad(id, "cleanup mailbox requires its explicit owner route");
      if (c.writeVia !== undefined && (c.requires as string[]).some(r => r === "channel.read" || r === "channel.write"))
        bad(id, "cleanup relay does not grant direct channel authority");
      if ((c.requires as string[]).includes("transfer.cleanup") && op.transfer === undefined) bad(id, "transfer cleanup requires the operation's transfer service");
      for (const [key, maximum] of [["maximumMilliseconds", 10000], ["maximumLuaFuel", 100000], ["maximumWork", 3200000]] as const)
        if (!Number.isSafeInteger(c[key]) || (c[key] as number) < 1 || (c[key] as number) > maximum) bad(id, "invalid cleanup " + key);
    }
    if (op.writeVia !== undefined) name(op.writeVia, id + ".writeVia");
    if ((op.writeVia !== undefined) !== (op.requires as string[]).includes("channel.write-via"))
      bad(id, "writeVia and channel.write-via requirement must occur together");
    if (op.writeVia !== undefined && nativeArray((op.requires as string[])).some(r => r === "channel.write" || r === "channel.read"))
      bad(id, "a relay route does not grant direct channel authority");
    const availability = record(op.availability, id + ".availability"); keys(availability, ["modes", "profiles"], [], id);
    if (nativeArray(names(availability.modes, id, true)).some(mode => !modes.includes(mode)) || nativeArray(names(availability.profiles, id, true)).some(profile => !profiles.includes(profile))) bad(id, "availability references an unknown mode/profile");
    const args = record(op.arguments, id + ".arguments");
    if (nativeKeys(args).length > 32) bad(id, "argument count exceeds 32");
    for (const [key, arg] of nativeEntries(args)) {
      name(key, id);
      const a = record(arg, id + ".arguments." + key);
      if (a.kind !== "byte-source" && a.kind !== "stream-source") { type(a, id + ".arguments." + key, 0, true); continue; }
      keys(a, ["kind", "minimumBytes", "maximumBytes"], ["label", "description"], id);
      for (const member of ["label", "description"]) if (a[member] !== undefined) authoredText(a[member], id + ".arguments." + key + "." + member);
      if (!Number.isSafeInteger(a.minimumBytes) || !Number.isSafeInteger(a.maximumBytes)
        || (a.minimumBytes as number) < 0 || (a.maximumBytes as number) < (a.minimumBytes as number)
        || (a.kind === "byte-source" ? (a.maximumBytes as number) > 65536 : (a.maximumBytes as number) >= Number.MAX_SAFE_INTEGER)) bad(id, "bounded source requires 0 <= minimumBytes <= maximumBytes <= 65536 for B1; streaming requires a safe finite domain with EOF probe room");
    }
    if ((op.transfer !== undefined) !== (op.requires as string[]).includes("transfer.checkpoint")) bad(id, "transfer metadata and checkpoint requirement must occur together");
    let sourceSegments = 1;
    if (op.transfer !== undefined) {
      const t = record(op.transfer, id + ".transfer");
      keys(t, ["sourceArgument", "targetOffset", "targetLength", "resumeBinding", "finalization"], ["maximumCarrierBytes", "segmented", "sourceRange"], id);
      if (t.segmented !== undefined && t.segmented !== true) bad(id, "segmented must be true or absent; its quantum is host-fixed");
      if (t.maximumCarrierBytes !== undefined && (!Number.isSafeInteger(t.maximumCarrierBytes)
        || (t.maximumCarrierBytes as number) < 1 || (t.maximumCarrierBytes as number) > 65536)) bad(id, "maximumCarrierBytes requires an integer in 1..65536");
      const source = args[name(t.sourceArgument, id)] as Record<string, unknown> | undefined;
      if (!source || !["byte-source", "stream-source"].includes(source.kind as string) || (source.minimumBytes as number) < 1) bad(id, "transfer requires a nonempty source argument");
      let effectiveMaximum = source!.maximumBytes as number;
      if (t.sourceRange !== undefined) {
        const range = record(t.sourceRange, id); keys(range, ["offset", "length"], [], id);
        const bounds = (v: unknown, minimum: number): [number, number] => {
          if (typeof v === "number") {
            if (!Number.isSafeInteger(v) || v < minimum) bad(id, "invalid source range constant");
            return [v, v];
          }
          const ref = record(v, id); keys(ref, ["argument"], [], id);
          const a = args[name(ref.argument, id)] as Record<string, unknown> | undefined;
          if (a?.kind !== "integer" || !Number.isSafeInteger(a.minimum) || !Number.isSafeInteger(a.maximum)
            || (a.minimum as number) < minimum) bad(id, "source range requires a bounded integer argument");
          return [a!.minimum as number, a!.maximum as number];
        };
        const offset = bounds(range.offset, 0), length = bounds(range.length, 1);
        if (!Number.isSafeInteger(offset[1] + length[1]) || offset[0] + length[0] > effectiveMaximum)
          bad(id, "source range is impossible or has unsafe endpoints");
        effectiveMaximum = Math.min(length[1], effectiveMaximum - offset[0]);
        if (typeof range.offset !== "number" && typeof range.length !== "number"
          && (range.offset as { argument: string }).argument === (range.length as { argument: string }).argument)
          effectiveMaximum = Math.min(length[1], Math.floor((source!.maximumBytes as number) / 2));
      }
      if (t.segmented && !Number.isSafeInteger(Math.ceil(effectiveMaximum / 65536) * 32000000))
        bad(id, "segmented maximum source domain has unrepresentable aggregate work");
      if (t.segmented) sourceSegments = Math.max(1, Math.ceil(effectiveMaximum / 65536));
      if (!bindings.includes(name(t.resumeBinding, id))) throw new AuthoredAdmissionError("authored.binding.unresolved", "transfer resume binding is unresolved");
      if (!["repeatable", "not-repeatable"].includes(t.finalization as string)) bad(id, "transfer finalization policy required");
      if (!Number.isSafeInteger(t.targetOffset) || (t.targetOffset as number) < 0 || !Number.isSafeInteger(t.targetLength)
        || (t.targetLength as number) < (t.targetOffset as number) + effectiveMaximum) bad(id, "source range cannot fit target domain");
    }
    const result = record(op.result, id + ".result");
    if (result.kind === "none") keys(result, ["kind"], [], id);
    else if (result.kind === "value") { keys(result, ["kind", "type"], [], id); type(result.type, id + ".result.type"); }
    else if (result.kind === "file" || result.kind === "resource") {
      keys(result, ["kind", "direction", "content", "mediaType", "minimumBytes", "maximumBytes", ...(result.kind === "file" ? ["suggestedExtension"] : [])], ["streamed"], id);
      if (result.direction !== "out" || typeof result.content !== "string" || !result.content.length || result.content.length > 256
        || typeof result.mediaType !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(result.mediaType) || result.mediaType.length > 128) bad(id, "output direction and bounded content/media meaning required");
      if (!Number.isSafeInteger(result.minimumBytes) || !Number.isSafeInteger(result.maximumBytes) || (result.minimumBytes as number) < 0
        || (result.maximumBytes as number) < (result.minimumBytes as number) || (result.streamed === undefined && (result.maximumBytes as number) > 1024 * 1024)) bad(id, "invalid output byte bounds (selected maximum 1 MiB)");
      if (result.streamed !== undefined) {
        try {
          const resultSegments = validateStreamedResult(result as unknown as import("@protodriver/contracts").AuthoredResourceResult, args as AuthoredOperation["arguments"]);
          if (!Number.isSafeInteger((sourceSegments + resultSegments - 1) * 32000000)) bad(id, "combined input/output aggregate work is unrepresentable");
        }
        catch (cause) { bad(id, String(cause)); }
      }
      if (result.kind === "file" && (typeof result.suggestedExtension !== "string" || !/^[a-zA-Z0-9]{1,16}$/.test(result.suggestedExtension))) bad(id, "safe file extension required");
    }
    else bad(id, "this admission implementation does not yet support this result form");
  }
  const validatePoll = (raw: unknown, id: string): void => {
    const p = record(raw, id);
    keys(p, ["kind", "mode", "operation", "intervalMs", "failureBackoffMs", "suspendWhileLocksHeld"], ["timing", "maximumInterTransactionGapMs"], id);
    if (p.kind !== "poll") bad(id, "unknown refresh service");
    const op = (d.operations as unknown as AuthoredOperation[]).find(op => op.id === name(p.operation, id));
    if (!op || !op.availability.modes.includes(name(p.mode, id)) || !modes.includes(p.mode as string)
      || nativeKeys(op.arguments).length || op.result.kind !== "value" || op.risk !== "read-only" || op.repeatability !== "safe-to-repeat")
      bad(id, "poll requires available argument-free read-only safe-to-repeat value operation");
    for (const key of ["intervalMs", "failureBackoffMs"]) if (!Number.isSafeInteger(p[key]) || (p[key] as number) < 1 || (p[key] as number) > 2147483647)
      bad(id, "poll durations require 1..2147483647 milliseconds");
    if ((p.failureBackoffMs as number) < (p.intervalMs as number)) bad(id, "backoff must be at least the interval");
    const knownLocks = new Set(nativeArray((d.operations as unknown as AuthoredOperation[])).flatMap(op => [...op.locks]));
    for (const holder of [...(d.handlers as Array<{ locks?: string[] }> ?? []), ...(d.entry ? [d.entry as { locks?: string[] }] : [])])
      if (Array.isArray(holder.locks)) for (const lock of holder.locks) knownLocks.add(lock);
    if (nativeArray(names(p.suspendWhileLocksHeld, id)).some(lock => !knownLocks.has(lock))) bad(id, "poll suspension references an unknown lock");
    if (p.timing !== undefined) {
      const timing = record(p.timing, id + ".timing");
      keys(timing, ["kind", "activity"], [], id + ".timing");
      if (timing.kind !== "idle-reset" || timing.activity !== "foreground-lifecycle")
        bad(id + ".timing", "unsupported timing/activity basis " + String(timing.kind) + "/" + String(timing.activity));
    }
    if (p.maximumInterTransactionGapMs !== undefined) {
      if (!Number.isSafeInteger(p.maximumInterTransactionGapMs) || (p.maximumInterTransactionGapMs as number) < 1
        || (p.maximumInterTransactionGapMs as number) > 2147483647) bad(id, "maximum inter-transaction gap requires 1..2147483647 milliseconds");
      if ((p.intervalMs as number) >= (p.maximumInterTransactionGapMs as number)) bad(id, "poll interval must be strictly below the maximum inter-transaction gap");
      if (p.timing === undefined) bad(id, "maximum inter-transaction gap requires idle-reset foreground-lifecycle timing");
    }
  };
  if (d.maintenance !== undefined) {
    if (!Array.isArray(d.maintenance) || d.maintenance.length > 128) bad("maintenance", "bounded plan array required");
    for (const [index, plan] of (d.maintenance as unknown[]).entries()) validatePoll(plan, "maintenance." + index);
  }
  if (d.state !== undefined) {
    const cells = record(d.state, "state");
    if (nativeKeys(cells).length > 128) bad("state", "maximum 128 cells");
    for (const [id, raw] of nativeEntries(cells)) {
      name(id, "state"); const cell = record(raw, "state." + id);
      keys(cell, ["type", "freshForMs"], ["refresh", "dependsOn"], "state." + id); type(cell.type, "state." + id);
      if (cell.freshForMs !== null && (!Number.isSafeInteger(cell.freshForMs) || (cell.freshForMs as number) < 1 || (cell.freshForMs as number) > 86400000)) bad(id, "freshness must be null (unaged) or 1..86400000 milliseconds");
      if (typeof cell.refresh === "string") {
        if (!ids.has(name(cell.refresh, id + ".refresh"))) bad(id, "refresh must name a declared operation");
      } else if (cell.refresh !== undefined) {
        validatePoll(cell.refresh, id + ".refresh");
      }
      if (cell.dependsOn !== undefined) {
        if (cell.freshForMs !== null) bad(id, "inherited validity requires null age, not an independent timer");
        if (!Array.isArray(cell.dependsOn) || !cell.dependsOn.length || cell.dependsOn.length > 128
          || new Set(cell.dependsOn).size !== cell.dependsOn.length) bad(id, "dependsOn requires 1..128 unique cell names");
        for (const dependency of cell.dependsOn as unknown[]) {
          const input = name(dependency, id + ".dependsOn");
          if (!Object.hasOwn(cells, input)) bad(id, "unknown validity input " + input);
        }
      }
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) bad(id, "cyclic validity dependency");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const input of (cells[id] as { dependsOn?: string[] }).dependsOn ?? []) visit(input);
      visiting.delete(id); visited.add(id);
    };
    for (const id of nativeKeys(cells)) visit(id);
  }
  const roles = new Map<string, string>();
  const role = (binding: string, kind: string): void => {
    const previous = roles.get(binding);
    if (previous !== undefined && (previous !== "operation" || kind !== "operation"))
      throw new AuthoredAdmissionError("authored.handler.binding-role", "binding " + binding + " is already used by " + previous);
    roles.set(binding, kind);
  };
  for (const op of d.operations as unknown as AuthoredOperation[]) role(op.binding, "operation");
  for (const op of d.operations as unknown as AuthoredOperation[]) if (op.reentry) {
    const previous = roles.get(op.reentry.binding);
    if (previous !== undefined && previous !== "reentry") bad(op.id, "reentry cannot alias another binding role");
    roles.set(op.reentry.binding, "reentry");
  }
  for (const op of d.operations as unknown as AuthoredOperation[]) if (op.cleanup) {
    const previous = roles.get(op.cleanup.binding);
    if (previous !== undefined && previous !== "cleanup") throw new AuthoredAdmissionError("authored.handler.binding-role", "cleanup cannot alias an ordinary binding");
    roles.set(op.cleanup.binding, "cleanup");
  }
  if (d.entry !== undefined) role((d.entry as { binding: string }).binding, "entry");
  if (d.invalidation !== undefined) role(d.invalidation as string, "invalidation");
  const handlers = d.handlers ?? [];
  if (!Array.isArray(handlers) || handlers.length > 64) throw new AuthoredAdmissionError("authored.handler.task-limit", "at most 64 handler declarations");
  const channels = new Set<string>(), handlerIds = new Set<string>();
  let reserved = Math.max(DEFAULT_HOST_RESOURCE_LIMITS.maximumConcurrentOperations, d.entry ? 1 : 0) + (d.invalidation ? 1 : 0);
  for (const raw of handlers) {
    const h = record(raw, "handler");
    keys(h, ["id", "binding", "event", "maximumConcurrent", "locks", "requires"], ["acceptHandoff", "authorizeWrite", "inputEvidence"], "handler");
    if (h.inputEvidence !== undefined && h.inputEvidence !== "consumed-ranges") bad("handler.inputEvidence", "expected consumed-ranges");
    const id = name(h.id, "handler.id");
    if (handlerIds.has(id) || ids.has(id)) throw new AuthoredAdmissionError("authored.handler.identity", "duplicate handler/operation ID " + id);
    handlerIds.add(id);
    const binding = name(h.binding, "handler.binding");
    if (!bindings.includes(binding)) throw new AuthoredAdmissionError("authored.binding.unresolved", "handler " + id + ": " + binding);
    role(binding, "handler " + id);
    if (h.authorizeWrite !== undefined) {
      const authorization = name(h.authorizeWrite, "handler.authorizeWrite");
      if (!bindings.includes(authorization)) throw new AuthoredAdmissionError("authored.binding.unresolved", "write authorization binding is unresolved");
      role(authorization, "write authorization");
      if (!nativeArray((d.operations as unknown as AuthoredOperation[])).some(op => op.writeVia === id || op.cleanup?.writeVia === id)) bad(id, "authorization binding requires a referring operation or cleanup");
      reserved++; // one active relay control per owner; queued requests are not tasks
    }
    if (h.acceptHandoff !== undefined) {
      const acceptance = name(h.acceptHandoff, "handler.acceptHandoff");
      if (!bindings.includes(acceptance)) throw new AuthoredAdmissionError("authored.binding.unresolved", "acceptance binding is unresolved");
      role(acceptance, "handoff acceptance");
      if ((d.entry as { handoffTo?: string } | undefined)?.handoffTo !== id)
        bad(id, "acceptHandoff requires the corresponding entry.handoffTo relation");
      reserved++;
    }
    const event = record(h.event, "handler.event"); keys(event, ["kind", "channelId"], [], "handler.event");
    if (event.kind !== "channel-input") throw new AuthoredAdmissionError("authored.handler.event", "only channel-input consuming handlers are supported");
    const channel = name(event.channelId, "handler.event.channelId");
    if (channels.has(channel)) throw new AuthoredAdmissionError("authored.handler.consumer", "two reliable consumers target " + channel);
    channels.add(channel);
    if (!Number.isSafeInteger(h.maximumConcurrent) || (h.maximumConcurrent as number) < 1 || (h.maximumConcurrent as number) > 64)
      throw new AuthoredAdmissionError("authored.handler.task-limit", "handler concurrency must be in 1..64");
    reserved += h.maximumConcurrent as number;
    names(h.locks, "handler.locks"); names(h.requires, "handler.requires");
    if ((h.requires as string[]).includes("operation.deadline")) bad("handler.requires", "operation deadlines are not input-handler authority");
  }
  const target = (d.entry as { handoffTo?: string } | undefined)?.handoffTo;
  if ((d.entry as { inputEvidence?: string } | undefined)?.inputEvidence === "consumed-ranges"
    && !nativeArray(handlers).some(raw => (raw as { id: string }).id === target && (raw as { inputEvidence?: string }).inputEvidence === "consumed-ranges"))
    bad("entry.inputEvidence", "recipient must accept consumed-range custody");
  for (const op of d.operations as unknown as AuthoredOperation[]) for (const route of [op.writeVia, op.cleanup?.writeVia])
    if (route !== undefined && !nativeArray(handlers).some(raw => (raw as { id: string; authorizeWrite?: string }).id === route
      && (raw as { authorizeWrite?: string }).authorizeWrite !== undefined)) bad(op.id, "writeVia requires a handler with write authorization");
  if (target !== undefined && !nativeArray(handlers).some(raw => {
    const handler = raw as { id: string; acceptHandoff?: string };
    return handler.id === target && handler.acceptHandoff !== undefined;
  })) bad("entry.handoffTo", "target handler and acceptance binding required");
  if (reserved > 64) throw new AuthoredAdmissionError("authored.handler.task-limit", "handler reservations plus operations/invalidation exceed 64 logical tasks");
  if (d.mailboxes !== undefined) {
    const boxes = names(d.mailboxes, "mailboxes");
    if (boxes.length > 32 || nativeArray(boxes).some(box => !/^[a-zA-Z0-9_-]{1,64}$/.test(box))) bad("mailboxes", "at most 32 bounded route names");
    if (boxes.length && !handlers.length) bad("mailboxes", "mailbox topology requires a consuming handler");
  }
  const plans = pollPlans(d as unknown as AuthoredDescription); // agreement after all structural checks
  for (const op of d.operations as unknown as AuthoredOperation[]) if (op.releaseAfterIdleMs !== undefined
    && !plans.some(p => p.operation === op.id)) bad(op.id, "idle release requires a poll reference");
  for (const mode of modes) {
    const releasing = plans.filter(p => p.mode === mode && p.releaseAfterIdleMs !== undefined);
    if (!releasing.length) continue;
    if (releasing.length !== 1 || plans.some(p => p.mode === mode && !p.timing)) bad(mode, "idle release requires one target and C5 timing throughout its mode");
    if ((d.handlers as unknown[] | undefined)?.length) bad(mode, "idle release requires direct-channel topology");
    for (const op of d.operations as unknown as AuthoredOperation[]) if (op.availability.modes.includes(mode) && !op.reentry)
      bad(op.id, "released mode requires an admitted reentry binding on every operation");
  }
  const freeze = (v: unknown): void => { if (v && typeof v === "object") { for (const child of nativeValues(v)) freeze(child); Object.freeze(v); } };
  freeze(d); return d as unknown as AuthoredDescription;
}
const codec = new DefaultValueCodec();
/** Host-context preflight, still effect-free. A declared target is not a grant. */
export function validateAuthoredTopologyGrant(description: AuthoredDescription, channelId: string,
  capabilities: Readonly<Record<string, { readonly available: boolean; readonly limitation: string }>>): void {
  for (const handler of description.handlers ?? []) {
    if (handler.event.channelId !== channelId) throw new AuthoredAdmissionError("authored.handler.channel-unavailable", "host has not granted handler channel " + handler.event.channelId);
    for (const requirement of handler.requires) if (!capabilities[requirement]?.available)
      throw new AuthoredAdmissionError("authored.handler.capability-unavailable", "handler " + handler.id + " requires " + requirement);
  }
}
export function authoredPublicValue(value: unknown, schema: AuthoredValueType): PublicValue {
  activeNativeScratch()?.node();
  const fail = (message: string): never => { throw new AuthoredAdmissionError("authored.value.invalid", message); };
  let result: PublicValue;
  if (schema.kind === "null") { if (value !== null) fail("null required"); result = null; }
  else if (schema.kind === "record") {
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) fail("record required");
    const fields = schema.fields!, entries = nativeEntries(value as Record<string, unknown>);
    if (entries.length !== nativeKeys(fields).length || nativeArray(entries).some(([key]) => !Object.hasOwn(fields, key))) fail("record field set differs");
    result = nativeRecord(nativeArray(entries).map(([key, member]) => [key, authoredPublicValue(member, fields[key]!)]));
  } else if (schema.kind === "array") {
    if (!Array.isArray(value)) fail("array required");
    result = nativeArray((value as unknown[])).map(member => authoredPublicValue(member, schema.item!));
  } else if (schema.kind === "variant") {
    const v = value as { kind?: string; tag?: string; value?: unknown };
    if (!v || v.kind !== "variant" || typeof v.tag !== "string" || !Object.hasOwn(schema.variants!, v.tag) || nativeSort(nativeKeys(v)).join(",") !== "kind,tag,value") fail("declared tagged variant required");
    result = { kind: "variant", tag: v.tag!, value: authoredPublicValue(v.value, schema.variants![v.tag!]!) };
  } else {
    let internal = value;
    if (schema.kind === "decimal" && (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || /^-0(?:\.0+)?$/.test(value))) fail("exact finite decimal text required");
    if (schema.kind === "flags" && Array.isArray(value)) internal = new Set(value);
    result = codec.toPublic(nativeValue(internal), schema as TypeDescriptor);
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    if (schema.kind === "integer") {
      const numeric = BigInt(typeof result === "number" ? result : (result as { value: string }).value);
      if ((schema.minimum !== undefined && numeric < BigInt(schema.minimum)) || (schema.maximum !== undefined && numeric > BigInt(schema.maximum))) fail("value outside declared range");
    } else {
      if (typeof result !== "number" || (schema.minimum !== undefined && result < schema.minimum) || (schema.maximum !== undefined && result > schema.maximum)) fail("value outside declared range");
    }
  }
  const length = typeof value === "string" ? nativeEncode(value).length : value instanceof Uint8Array || Array.isArray(value) ? value.length : undefined;
  if ((schema.minimumLength !== undefined && (length === undefined || length < schema.minimumLength)) || (schema.maximumLength !== undefined && (length === undefined || length > schema.maximumLength))) fail("value outside declared length");
  return result;
}
export function validateAuthoredArguments(operation: AuthoredOperation, supplied: Readonly<Record<string, OperationArgument>>): Readonly<Record<string, PublicValue>> {
  if (nativeKeys(supplied).length !== nativeKeys(operation.arguments).length) throw new AuthoredAdmissionError("authored.arguments.invalid", "argument population differs");
  return Object.freeze(nativeRecord(nativeArray(nativeEntries(operation.arguments)).flatMap(([key, schema]) => {
    const argument = supplied[key];
    if (schema.kind === "byte-source" || schema.kind === "stream-source") {
      if (!argument || argument.kind !== "resource" || typeof argument.id !== "string" || !argument.id.length || argument.id.length > 256)
        throw new AuthoredAdmissionError("authored.arguments.invalid", "source resource required: " + key);
      return [];
    }
    if (!argument || argument.kind !== "value") throw new AuthoredAdmissionError("authored.arguments.invalid", "value argument required: " + key);
    // fromPublic is deliberately used before toPublic: tagged public integers
    // are not interchangeable with arbitrary author records.
    const internal = decodeAuthoredArgument(argument.value, schema);
    return [[key, authoredPublicValue(internal, schema)]];
  })));
}

function decodeAuthoredArgument(value: PublicValue, schema: AuthoredValueType): unknown {
  activeNativeScratch()?.node();
  if (schema.kind === "record") {
    const v = record(value, "argument");
    keys(v, nativeKeys(schema.fields!), [], "argument");
    return nativeRecord(nativeArray(nativeEntries(schema.fields!)).map(([key, child]) => [key, decodeAuthoredArgument(v[key] as PublicValue, child)]));
  }
  if (schema.kind === "array") {
    if (!Array.isArray(value)) bad("argument", "array required");
    return nativeArray((value as readonly PublicValue[])).map(child => decodeAuthoredArgument(child, schema.item!));
  }
  if (schema.kind === "variant") {
    const v = record(value, "argument"); keys(v, ["kind", "tag", "value"], [], "argument");
    if (v.kind !== "variant" || typeof v.tag !== "string" || !Object.hasOwn(schema.variants!, v.tag)) bad("argument", "unknown variant");
    return { kind: "variant", tag: v.tag, value: decodeAuthoredArgument(v.value as PublicValue, schema.variants![v.tag as string]!) };
  }
  if (schema.kind === "null") return value;
  return codec.fromPublic(nativeValue(value), schema as TypeDescriptor);
}
