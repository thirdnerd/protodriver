import type { AuthoredOperation, AuthoredValueType, BrokerCallId, OperationArgument, OperationId, PublicValue,
  ResourceBrokerClient, ResourceId, ResourceReadGrant } from "@protodriver/contracts";
import { nativeArray, nativeEntries, nativeRecord, nativeValue } from "@protodriver/lua-vm/retained";
import { resolveTransferSourceRange } from "./effective-source-range.ts";

export function sourceValueTypes(operation: AuthoredOperation): Readonly<Record<string, AuthoredValueType>> {
  return nativeRecord(nativeArray(nativeEntries(operation.arguments)).map(([key, type]) => [key, type.kind === "byte-source"
    ? { kind: "bytes", minimumLength: type.minimumBytes, maximumLength: type.maximumBytes }
    : type.kind === "stream-source" ? { kind: "string", maximumLength: 128 } : type]));
}
function refuse(message: string): never {
  throw Object.assign(new Error(message), { error: { code: "authored.source.invalid", message, retryability: "no" } });
}
export interface SourcePreparationContext {
  readonly id: OperationId;
  readonly broker: ResourceBrokerClient;
  live(): void;
  iteration(): void;
  reserve(bytes: number): { release(): void };
  /** Synchronous preparation only; never carries authority across an await. */
  native?<T>(run: () => T): T;
  preflight(args: Readonly<Record<string, PublicValue>>, lengths: Readonly<Record<string, number>>): number;
  /** Owns effect identity, pending slot, cancellation and terminal recording. */
  call<T>(kind: string, fields: Record<string, unknown>, run: (id: BrokerCallId) => Promise<T>,
    observed?: (value: T) => Record<string, unknown>): Promise<T>;
  read(fields: Record<string, unknown>, maximum: number, run: (id: BrokerCallId) => Promise<{ data: ArrayBuffer; eof: boolean }>): Promise<{ data: ArrayBuffer; eof: boolean }>;
  mark(kind: string, fields: Record<string, unknown>): void;
}

/** Host-owned B1 preparation. No read exists during public-description evaluation. */
export async function materializeSourceArguments(operation: AuthoredOperation,
  supplied: Readonly<Record<string, OperationArgument>>, values: Readonly<Record<string, PublicValue>>, context: SourcePreparationContext) {
  const native = <T>(run: () => T): T => context.native ? context.native(run) : run();
  const sources = native(() => nativeArray(nativeEntries(operation.arguments)).filter(([, type]) => type.kind === "byte-source"));
  if (!sources.length) return { values, release() {} };
  const { broker } = context;
  if (!broker.grantRead || !broker.releaseRead) refuse("owning broker has no bounded source delegation");
  const grants: Array<{ name: string; source: ResourceId; grant: ResourceReadGrant; length: number }> = [];
  const holds: Array<{ release(): void }> = [];
  let completed = false;
  const release = () => { for (const held of holds.splice(0)) held.release(); };
  try {
    for (const [name, type] of sources) {
      context.iteration(); context.live();
      if (type.kind !== "byte-source") throw new Error("source selection invariant");
      const argument = supplied[name];
      if (argument?.kind !== "resource") refuse("source resource required: " + name);
      // The extra octet is an explicit granted reservation, not payload. The
      // broker refuses a probe if this reservation is removed.
      const grantedCapacity = type.maximumBytes + 1;
      // The descriptor must remain retainable even when its promise settles
      // after revocation. Reserve it before delegating, not in that callback.
      holds.push(context.reserve(512 + name.length * 3));
      await context.call("source-grant", { argument: name, source: argument.id, direction: "read", maximumBytes: grantedCapacity }, async callId => {
        const grant = await broker.grantRead!(argument.id, context.id, grantedCapacity, { callId });
        // Retain even a late grant so cancellation cannot leak its delegation.
        grants.push({ name, source: argument.id, grant, length: grant.byteLength ?? -1 });
        return grant;
      }, grant => ({ grant }));
      context.live();
      const { grant, length } = grants.at(-1)!;
      if (!Number.isSafeInteger(length) || length < type.minimumBytes || length > type.maximumBytes)
        refuse("source descriptor is unknown or outside declared bounds: " + name);
      if (!grant.seekable) refuse("source has no granted zero-origin rewind: " + name);
      if (operation.transfer?.sourceArgument === name) resolveTransferSourceRange(operation, values, length);
    }
    native(() => context.preflight(values, nativeRecord(nativeArray(grants).map(g => [g.name, g.length]))));
    // B1's complete input preflight still precedes the first read. F24 now
    // reserves actual ABI/VM buffers at their allocation sites; reserving the
    // old frame*256 estimate here as well would charge those copies twice.
    // This owner retains only source preparation's own storage.
    const result: Record<string, PublicValue> = native(() => ({ ...nativeValue(values) }));
    for (const { name, source, grant, length } of grants) {
      const fields = { argument: name, source, grant: grant.id, origin: grant.origin,
        direction: "read", range: { offset: 0, maximumBytes: grant.maximumBytes } };
      await context.call("source-rewind", fields,
        callId => broker.seek(source, 0, { callId, readGrantId: grant.id }));
      context.live();
      const staging = context.reserve(32 + length * 3); // payload + binary string
      try {
      const payload = new Uint8Array(length);
      let offset = 0, eof = false, observed = 0;
      const read = async (maximum: number, probe: boolean) => {
        const chunk = await context.read({ ...fields, offset, probe }, maximum,
          callId => broker.read(source, maximum, { callId, readGrantId: grant.id }));
        // The read wrapper records late bytes before this validity check.
        context.live();
        if (!(chunk.data instanceof ArrayBuffer) || chunk.data.byteLength > maximum || typeof chunk.eof !== "boolean")
          refuse("malformed source completion");
        observed += chunk.data.byteLength;
        return chunk;
      };
      while (offset < length) {
        context.iteration();
        const chunk = await read(Math.min(256, length - offset), false);
        const bytes = new Uint8Array(chunk.data);
        for (let i = 0; i < bytes.length; i++) { context.iteration(); payload[offset++] = bytes[i]!; }
        eof = chunk.eof;
        if (eof && offset !== length) refuse("source ended before its declared length");
        if (!bytes.length && !eof) refuse("source made no progress without establishing EOF");
      }
      if (!eof) {
        const probe = await read(1, true);
        if (probe.data.byteLength !== 0 || !probe.eof) refuse("source length contradicted or EOF unresolved"); // B1 completeness mutation target
      }
      let binary = "";
      for (const octet of payload) { context.iteration(); binary += String.fromCharCode(octet); }
      holds.push(context.reserve(128 + 8 * Math.ceil(length / 3)));
      // btoa is a native scan; the per-octet string construction above does
      // not pay for this separate pass.
      for (let i = 0; i < length; i += 256) context.iteration();
      result[name] = Object.freeze({ type: "bytes", encoding: "base64", value: btoa(binary) });
      context.mark("source-materialized", { ...fields, observedBytes: observed, payloadBytes: length,
        valueArgument: name, complete: true });
      } finally { staging.release(); }
    }
    context.live(); completed = true;
    return { values: Object.freeze(result), release };
  } finally {
    const failures: unknown[] = [];
    try {
      // Cleanup uses the same operation/effect ledger but does not require
      // live Lua authority. Native calls have settled before releasing grants.
      for (const { name, source, grant } of grants) {
        try { await context.call("source-release",
          { argument: name, source, grant: grant.id, closesSource: grant.scope === "operation" },
          callId => broker.releaseRead!(source, grant.id, { callId })); }
        catch (cause) { failures.push(cause); }
      }
      if (failures.length) throw new AggregateError(failures, "source grant cleanup failed");
    } finally { if (!completed || failures.length) release(); }
  }
}
