import type { AuthoredOperation, OperationArgument, PublicValue, ResourceId, ResourceReadGrant, TransferCheckpoint } from "@protodriver/contracts";
import { nativeEntries, nativeRecord } from "@protodriver/lua-vm/retained";
import type { SourcePreparationContext } from "./source-materialization.ts";
import { StreamingSha256 } from "./streaming-sha256.ts";
import { validateEffectiveSourceRange, type EffectiveSourceRange } from "./effective-source-range.ts";

function requireSource(ok: unknown, message: string, code = "authored.source.invalid"): asserts ok {
  if (!ok) throw Object.assign(new Error(message), { error: { code, message, retryability: "no" } });
}
const WINDOW = 65536;
/** One exclusive cursor; neither its registrar ID nor any method enters Lua. */
export class StreamingSource {
  readonly token = "stream-" + crypto.randomUUID();
  #length: number;
  get length(): number { return this.#length; }
  get descriptorLength(): number { return this.#grant.byteLength!; }
  #range: EffectiveSourceRange | undefined;
  readonly #context: SourcePreparationContext;
  readonly #source: ResourceId;
  readonly #grant: ResourceReadGrant;
  readonly #name: string;
  readonly #held: Array<{ release(): void }>;
  #offset = 0;
  #eof = false;
  #released = false;
  #window: Uint8Array | undefined;
  #start = 0;
  #end = 0;
  #protectedEnd = 0;
  #ready = false;
  #submitted: StreamingSha256 | undefined;
  #committed: StreamingSha256 | undefined;
  digest = "";
  get complete(): boolean { return this.#eof && this.#offset === this.length; }
  private constructor(name: string, source: ResourceId, grant: ResourceReadGrant, context: SourcePreparationContext, held: Array<{ release(): void }>) {
    this.#name = name; this.#source = source; this.#grant = grant; this.#context = context; this.#held = held;
    this.#length = grant.byteLength!;
  }
  static async open(name: string, source: ResourceId, minimum: number, maximum: number, c: SourcePreparationContext): Promise<StreamingSource> {
    requireSource(c.broker.grantStream && c.broker.releaseRead, "broker has no streaming source delegation");
    const held = [c.reserve(2048 + name.length * 3)]; let result: StreamingSource | undefined;
    try {
      await c.call("source-grant", { argument: name, source, direction: "read", streaming: true, maximumBytes: maximum }, async callId => {
        const grant = await c.broker.grantStream!(source, c.id, maximum, { callId });
        result = new StreamingSource(name, source, grant, c, held); return grant;
      }, grant => ({ grant }));
      c.live(); const stream = result!;
      requireSource(stream.#grant.streaming && Number.isSafeInteger(stream.length) && stream.length >= minimum && stream.length <= maximum
        && stream.#grant.seekable, "stream requires a finite in-range descriptor and an exclusive seekable origin");
      await stream.#seek(0); return stream;
    } catch (cause) { if (result) await result.release(); else for (const h of held) h.release(); throw cause; }
  }
  /** Trusted transfer preparation only, before any content read or hash. */
  selectTransferRange(range: EffectiveSourceRange): void {
    this.#context.live();
    requireSource(!this.#released && !this.#window && this.#offset === 0 && !this.#range, "source range selection is no longer available");
    validateEffectiveSourceRange(range, this.descriptorLength);
    this.#range = { ...range }; this.#length = range.length;
  }
  #fields() { return { argument: this.#name, source: this.#source, grant: this.#grant.id, origin: this.#grant.origin,
    direction: "read", streaming: true, range: { offset: this.#range?.offset ?? 0, maximumBytes: this.length },
    ...(this.#range ? { sourceSubject: { kind: "effective-range", ...this.#range } } : {}) }; }
  async #seek(offset: number): Promise<void> {
    this.#context.live(); requireSource(!this.#released && Number.isSafeInteger(offset) && offset >= 0 && offset <= this.length, "stream seek out of range");
    const physicalOffset = (this.#range?.offset ?? 0) + offset;
    await this.#context.call("source-seek", { ...this.#fields(), offset: physicalOffset, ...(this.#range ? { relativeOffset: offset } : {}) }, callId => this.#context.broker.seek(this.#source, physicalOffset, { callId, readGrantId: this.#grant.id }));
    this.#context.live(); this.#offset = offset; this.#eof = false;
  }
  async seek(offset: number): Promise<void> {
    requireSource(!this.#window, "checkpoint service, not Lua, owns this source cursor"); await this.#seek(offset);
  }
  async fingerprint(): Promise<{ digest: string; byteLength: number }> {
    const held = this.#context.reserve(4096), hash = new StreamingSha256(() => this.#context.iteration());
    try {
      await this.#seek(0);
      while (!this.complete) { this.#context.iteration(); hash.update(await this.#read(256)); }
      const digest = hash.hex(); await this.#seek(0); return { digest, byteLength: this.length };
    } finally { held.release(); }
  }
  async #read(maximum: number): Promise<Uint8Array> {
    const c = this.#context; c.live();
    requireSource(!this.#released && Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 256, "stream read requires 1..256 bytes");
    if (this.#eof) return new Uint8Array();
    const requested = Math.min(maximum, this.length - this.#offset), held = c.reserve(1024 + maximum * 4);
    try {
      const read = async (count: number, probe: boolean) => {
        // The ledger's pre-submission charge and recording reservation precede this callback.
        c.iteration(); c.live();
        const r = await c.read({ ...this.#fields(), offset: (this.#range?.offset ?? 0) + this.#offset, ...(this.#range ? { relativeOffset: this.#offset } : {}), probe }, count,
          callId => c.broker.read(this.#source, count, { callId, readGrantId: this.#grant.id }));
        c.live(); requireSource(r.data instanceof ArrayBuffer && r.data.byteLength <= count && typeof r.eof === "boolean", "malformed streamed source completion");
        return r;
      };
      let bytes = new Uint8Array();
      if (requested) {
        const r = await read(requested, false); bytes = new Uint8Array(r.data);
        this.#offset += bytes.length; this.#eof = r.eof;
        requireSource(!r.eof || this.#offset === this.length, "stream ended before declared length");
        requireSource(bytes.length || r.eof, "stream made no progress without EOF");
      }
      if (this.#offset === this.length && this.#range) this.#eof = true; // selected extent, never a whole-file EOF claim
      if (this.#offset === this.length && !this.#eof) {
        const probe = await read(1, true);
        requireSource(probe.data.byteLength === 0 && probe.eof, "stream length contradicted or EOF unresolved");
        this.#eof = true;
      }
      return bytes;
    } finally { held.release(); }
  }
  async read(maximum: number): Promise<Uint8Array> {
    if (!this.#window) return this.#read(maximum);
    requireSource(this.#ready, "stream DATA requires quiescent resume", "transfer.resume.preparation-incomplete");
    requireSource(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 256 && this.#offset - this.#start + Math.min(maximum, this.length - this.#offset) <= WINDOW,
      "uncommitted source window is full", "authored.source.window-full");
    const offset = this.#offset, bytes = await this.#read(maximum);
    for (let i = 0; i < bytes.length; i++) {
      this.#context.iteration();
      if (offset + i < this.#protectedEnd) requireSource(this.#window[(offset + i) % WINDOW] === bytes[i], "source changed inside resumed possible prefix", "transfer.resume.source-mismatch");
      this.#window[(offset + i) % WINDOW] = bytes[i]!;
    }
    this.#end = Math.max(this.#end, this.#offset); return bytes;
  }
  /** Full-source prehash retains only two SHA states and the bounded unsettled window. */
  async prepareTransfer(cp?: TransferCheckpoint): Promise<void> {
    const c = this.#context, committed = cp?.confirmedRanges[0]?.length ?? 0, possible = cp?.authoredTransfer?.admittedEnd ?? 0;
    requireSource(possible >= committed && possible - committed <= WINDOW, "checkpoint possible range exceeds stream window", "transfer.checkpoint-invalid");
    this.#held.push(c.reserve(WINDOW + 4096)); this.#window = new Uint8Array(WINDOW);
    const hash = new StreamingSha256(() => c.iteration());
    let committedHash: StreamingSha256 | undefined = committed === 0 ? hash.clone() : undefined;
    let possibleHash: StreamingSha256 | undefined = possible === 0 ? hash.clone() : undefined;
    await this.#seek(0);
    while (this.#offset < this.length) {
      c.iteration(); const at = this.#offset;
      const boundary = Math.min(this.length, committed > at ? committed : this.length, possible > at ? possible : this.length);
      const bytes = await this.#read(Math.min(256, boundary - at)); hash.update(bytes);
      if (this.#offset === committed) committedHash = hash.clone();
      if (this.#offset === possible) possibleHash = hash.clone();
      for (let i = 0; i < bytes.length; i++) { c.iteration(); if (at + i >= committed && at + i < possible) this.#window[(at + i) % WINDOW] = bytes[i]!; }
    }
    if (!this.#eof) await this.#read(1);
    this.digest = hash.hex();
    if (cp) {
      requireSource(cp.source.byteLength === this.length && cp.source.digest === this.digest, "fresh streamed source differs from checkpoint", "transfer.resume.source-mismatch");
      const evidence = cp.authoredTransfer?.streamed;
      requireSource(evidence && evidence.version === 1 && evidence.committedDigest === committedHash?.hex()
        && evidence.submittedDigest === possibleHash?.hex(), "actual submitted/committed source prefix changed or is absent", "transfer.resume.source-mismatch");
    }
    this.#committed = committedHash!; this.#submitted = possibleHash!;
    this.#start = committed; this.#end = possible; this.#protectedEnd = possible; this.#ready = !cp;
    await this.#seek(committed);
    c.mark("source-stream-prepared", { ...this.#fields(), payloadBytes: this.length, complete: true, committedOffset: committed, possibleOffset: possible });
  }
  get evidence() { return { version: 1 as const, committedDigest: this.#committed!.hex(), submittedDigest: this.#submitted!.hex() }; }
  admit(offset: number, payloadOffset: number, bytes: Uint8Array, length: number): string {
    requireSource(this.#ready && offset >= this.#start && offset + length <= this.#offset, "carrier has no matching delivered source range", "transfer.resume.source-mismatch");
    for (let i = 0; i < length; i++) { this.#context.iteration(); requireSource(bytes[payloadOffset + i] === this.#window![(offset + i) % WINDOW], "carrier differs from streamed source", "transfer.resume.source-mismatch"); }
    this.#submitted!.update(bytes.subarray(payloadOffset, payloadOffset + length)); return this.#submitted!.hex();
  }
  commit(offset: number): string {
    requireSource(offset >= this.#start && offset <= this.#end, "committed source is outside retained window", "transfer.resume.offset-mismatch");
    while (this.#start < offset) {
      this.#context.iteration(); const at = this.#start % WINDOW, n = Math.min(offset - this.#start, WINDOW - at);
      this.#committed!.update(this.#window!.subarray(at, at + n)); this.#start += n;
    }
    return this.#committed!.hex();
  }
  async reconcile(offset: number): Promise<void> {
    this.commit(offset); this.#submitted = this.#committed!.clone(); this.#ready = true; await this.#seek(offset);
    // A repeatable finalization may resume with no DATA left to request. Its
    // exact-end cursor still needs EOF evidence, not an authored dummy read.
    if (offset === this.length) await this.#read(1);
  }
  finalizable(): void {
    requireSource(this.#offset === this.length && this.#eof && this.#submitted!.hex() === this.digest,
      "actual submitted source differs from prehash or is incomplete", "transfer.verification.digest-mismatch");
  }
  async release(): Promise<void> {
    if (this.#released) return; this.#released = true;
    try { await this.#context.call("source-release", { ...this.#fields(), closesSource: this.#grant.scope === "operation" },
      callId => this.#context.broker.releaseRead!(this.#source, this.#grant.id, { callId })); }
    finally { this.#window = undefined; for (const hold of this.#held.splice(0)) hold.release(); }
  }
}
export async function openStreamingSources(op: AuthoredOperation, supplied: Readonly<Record<string, OperationArgument>>,
  values: Readonly<Record<string, PublicValue>>, c: SourcePreparationContext) {
  const streams = new Map<string, StreamingSource>();
  const result = c.native ? c.native(() => nativeRecord(nativeEntries(values))) : { ...values };
  try {
    const entries = c.native ? c.native(() => nativeEntries(op.arguments)) : Object.entries(op.arguments);
    for (const [name, type] of entries) if (type.kind === "stream-source") {
      c.iteration(); const arg = supplied[name]; requireSource(arg?.kind === "resource", "stream source resource required");
      const stream = await StreamingSource.open(name, arg.id, type.minimumBytes, type.maximumBytes, c);
      streams.set(stream.token, stream); result[name] = stream.token;
    }
    return { values: result, streams };
  } catch (cause) { for (const stream of streams.values()) await stream.release(); throw cause; }
}
