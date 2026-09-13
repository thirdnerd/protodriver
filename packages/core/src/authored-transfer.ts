import type { AuthoredOperation, PublicValue, TransferCheckpoint, TransferCheckpointClaim, TransferCheckpointStore } from "@protodriver/contracts";
import { canonicalAuthoredBytes } from "./authored-admission.ts";
import { nativeArray, nativeKeys, nativeRecord, nativeSort } from "@protodriver/lua-vm/retained";
import type { StreamingSource } from "./streaming-source.ts";
import { resolveTransferSourceRange, type EffectiveSourceRange } from "./effective-source-range.ts";

export function transferFault(code: string, message: string): never {
  throw Object.assign(new Error(message), { error: { code, message, retryability: "no" } });
}
function requireThat(value: unknown, code: string, message: string): asserts value {
  if (!value) transferFault(code, message);
}
const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** D7 anti-gaming policy, not a protocol framing or author-selected bound. */
export const TRANSFER_SOURCE_QUANTUM = 65536;
export function transferSegmentCount(length: number): number {
  requireThat(integer(length) && length > 0, "authored.transfer.segment-plan", "finite nonempty source required");
  return Math.ceil(length / TRANSFER_SOURCE_QUANTUM);
}
export interface TransferServiceContext {
  live(): void;
  charge(units: number): void;
  reserve(bytes: number): { release(): void };
  native<T>(run: () => T): T;
  takeEvidence(): { sequence: number; bytes: number } | undefined;
  call<T>(kind: string, run: () => Promise<T>): Promise<T>;
  progress(checkpoint: TransferCheckpoint): void;
}
/** Bounded native hashing: account every input block before native submission.
 * SHA-256 implementation internals belong to the platform, not unmetered JS. */
async function digest(bytes: Uint8Array, c: TransferServiceContext): Promise<string> {
  const held = c.reserve(256 + bytes.length);
  try {
    for (let at = 0; at < bytes.length; at += 64) { c.live(); c.charge(128); }
    const result = await c.call("transfer-hash", () => crypto.subtle.digest("SHA-256", bytes));
    c.live(); let value = "";
    for (const b of new Uint8Array(result)) { c.charge(1); value += b.toString(16).padStart(2, "0"); }
    return value;
  } finally { held.release(); }
}
async function valueDigest(value: unknown, c: TransferServiceContext): Promise<string> {
  const encoded = c.native(() => canonicalAuthoredBytes(value));
  requireThat(encoded.length <= 65536, "transfer.checkpoint-invalid", "checkpoint identity input exceeds 64 KiB");
  return digest(encoded, c);
}
function prefix(checkpoint: TransferCheckpoint): number {
  return checkpoint.confirmedRanges[0]?.length ?? 0;
}
export interface TransferServiceIdentity {
  readonly execution: string;
  readonly mode: string;
  readonly device: string | null;
  readonly policy: string;
}

/** A compact cumulative-prefix checkpoint. No action-history array grows with DATA. */
export function inspectAuthoredCheckpoint(value: TransferCheckpoint | null, identity: TransferServiceIdentity, operation?: AuthoredOperation): TransferCheckpoint {
  requireThat(value && value.formatVersion === 1 && value.authoredTransfer?.version === 1,
    "transfer.checkpoint-invalid", "missing or non-authored checkpoint; old checkpoints are not converted");
  const a = value.authoredTransfer;
  const subject = value.source?.subject;
  requireThat(subject === undefined || (subject && subject.kind === "effective-range" && integer(subject.offset) && integer(subject.length)
    && subject.length > 0 && Number.isSafeInteger(subject.offset + subject.length) && subject.length === value.source.byteLength),
    "transfer.checkpoint-invalid", "invalid source digest subject");
  requireThat(typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
    && integer(value.revision) && hex(value.manifestHash) && hex(value.definitionHash)
    && hex(a.argumentsDigest) && hex(a.policyDigest) && typeof a.operation === "string" && a.operation.length <= 128
    && typeof a.cookie === "string" && /^[0-9a-f]{0,256}$/.test(a.cookie)
    && integer(a.targetOffset) && integer(a.targetLength) && integer(a.admittedEnd)
    && value.source?.algorithm === "sha256" && hex(value.source.digest) && integer(value.source.byteLength)
    && value.source.byteLength > 0 && (a.streamed ? a.streamed.version === 1 && hex(a.streamed.committedDigest) && hex(a.streamed.submittedDigest) : value.source.byteLength <= 65536)
    && a.targetOffset + value.source.byteLength <= a.targetLength && a.admittedEnd <= value.source.byteLength
    && value.direction === "hostToDevice" && ["repeatable", "not-repeatable"].includes(value.finalization)
    && ["preparing", "prepared", "transferring", "finalizing", "verifying"].includes(value.phase)
    && Array.isArray(value.confirmedRanges) && value.confirmedRanges.length <= 1
    && (value.confirmedRanges.length === 0 || (value.confirmedRanges[0]!.targetOffset === a.targetOffset
      && integer(value.confirmedRanges[0]!.length) && value.confirmedRanges[0]!.length > 0
      && value.confirmedRanges[0]!.length <= a.admittedEnd)), "transfer.checkpoint-invalid", "invalid authored checkpoint fields");
  requireThat(value.manifestHash === identity.execution, "transfer.resume.manifest-mismatch", "complete execution identity changed");
  requireThat(value.modeId === identity.mode, "transfer.resume.mode-mismatch", "mode changed");
  requireThat(value.identity?.stableKey === identity.device, "transfer.resume.identity-mismatch", "host device identity changed");
  requireThat(value.identity.generation === null || (typeof value.identity.generation === "string" && /^[0-9]{1,16}$/.test(value.identity.generation)),
    "transfer.checkpoint-invalid", "invalid generation");
  requireThat(value.identity.assurance === (identity.device !== null || value.identity.generation !== null ? "verified" : "unverified"),
    "transfer.checkpoint-invalid", "identity assurance does not follow recorded evidence");
  requireThat(a.policyDigest === identity.policy, "transfer.resume.definition-mismatch", "settlement resource policy changed");
  if (operation) {
    requireThat(operation.id === a.operation && operation.transfer, "transfer.resume.definition-mismatch", "operation or transfer service changed");
    requireThat(Boolean(operation.transfer.sourceRange) === Boolean(subject), "transfer.resume.source-mismatch", "range-selected checkpoint requires its explicit digest subject");
  }
  return value;
}

export class AuthoredTransfer {
  #claim: TransferCheckpointClaim | undefined;
  #held: { release(): void };
  #source: Uint8Array;
  #stream: StreamingSource | undefined;
  #range: EffectiveSourceRange | undefined;
  get #length(): number { return this.#stream?.length ?? this.#source.length; }
  #identity: TransferServiceIdentity;
  #sourceDigest = "";
  #argumentsDigest = "";
  #definitionDigest = "";
  #quiet = false;
  #resuming: boolean;
  #submitted = 0;
  #segmentOrigin = 0;
  #lastEvidence = -1;
  #pending: Promise<void> | undefined;
  #releasing = false;
  receipt?: PublicValue;
  retirement?: PublicValue;
  readonly store: TransferCheckpointStore;
  readonly operation: AuthoredOperation;
  readonly context: TransferServiceContext;
  private constructor(store: TransferCheckpointStore, operation: AuthoredOperation,
    context: TransferServiceContext, identity: TransferServiceIdentity, source: Uint8Array,
    held: { release(): void }, resuming: boolean) {
    this.store = store; this.operation = operation; this.context = context;
    this.#source = source; this.#held = held; this.#identity = identity; this.#resuming = resuming;
  }
  static async prepare(store: TransferCheckpointStore, operation: AuthoredOperation, values: Readonly<Record<string, PublicValue>>,
    identity: TransferServiceIdentity, context: TransferServiceContext, resumeId?: string, stream?: StreamingSource,
    streams?: ReadonlyMap<string, StreamingSource>): Promise<AuthoredTransfer> {
    const config = operation.transfer!;
    const value = values[config.sourceArgument] as { value: string };
    const held = context.reserve(stream ? 2048 : 16384 + value.value.length * 3);
    let service: AuthoredTransfer | undefined;
    try {
      const decoded = stream ? "" : atob(value.value);
      const range = resolveTransferSourceRange(operation, values, stream?.descriptorLength ?? decoded.length);
      if (stream && range) stream.selectTransferRange(range);
      const source = new Uint8Array(stream ? 0 : (range?.length ?? decoded.length));
      for (let i = 0; i < source.length; i++) { context.charge(1); source[i] = decoded.charCodeAt((range?.offset ?? 0) + i); }
      service = new AuthoredTransfer(store, operation, context, identity, source, held, resumeId !== undefined);
      service.#stream = stream;
      service.#range = range;
      if (!stream) service.#sourceDigest = await digest(source, context);
      service.#definitionDigest = await valueDigest(config, context);
      const ordinary = context.native(() => nativeRecord(nativeSort(nativeArray(nativeKeys(values))).filter(k => k !== config.sourceArgument).map(k => [k, values[k]])));
      for (const key of context.native(() => nativeArray(nativeKeys(ordinary)))) {
        context.charge(1);
        if (operation.arguments?.[key]?.kind === "stream-source") {
          const other = streams?.get(ordinary[key] as string);
          requireThat(other, "authored.source.unavailable", "secondary source handle is unavailable");
          ordinary[key] = await other.fingerprint(); // stable source identity, never an invocation-local handle
        }
      }
      service.#argumentsDigest = await valueDigest(ordinary, context);
      if (resumeId !== undefined) {
        service.#claim = await context.call("checkpoint-claim", () => store.claim(resumeId, crypto.randomUUID()));
        context.live();
        const checkpoint = inspectAuthoredCheckpoint(service.#claim.checkpoint, identity, operation);
        requireThat(!range || (checkpoint.source.subject?.offset === range.offset && checkpoint.source.subject.length === range.length),
          "transfer.resume.source-mismatch", "effective source range changed");
        if (stream) { await stream.prepareTransfer(checkpoint); service.#sourceDigest = stream.digest; }
        requireThat(checkpoint.source.digest === service.#sourceDigest && checkpoint.source.byteLength === service.#length,
          "transfer.resume.source-mismatch", "freshly read source differs from checkpoint");
        requireThat(checkpoint.definitionHash === service.#definitionDigest && checkpoint.authoredTransfer!.argumentsDigest === service.#argumentsDigest,
          "transfer.resume.definition-mismatch", "transfer definition or ordinary arguments changed");
        requireThat(!["finalizing", "verifying"].includes(checkpoint.phase) || checkpoint.finalization === "repeatable",
          "transfer.resume.finalization-not-repeatable", "interrupted finalization is not repeatable");
        service.#submitted = prefix(checkpoint);
      }
      else if (stream) { await stream.prepareTransfer(); service.#sourceDigest = stream.digest; }
      return service;
    } catch (error) { if (service) await service.release(); else held.release(); throw error; }
  }
  get checkpoint(): TransferCheckpoint | undefined { return this.#claim?.checkpoint; }
  get sourceSubject() { return this.#range ? { kind: "effective-range" as const, ...this.#range } : undefined; }
  get segmentCount(): number { return transferSegmentCount(this.#length); }
  get segmentProgress() {
    const count = Math.max(1, Math.ceil((this.#length - this.#segmentOrigin) / TRANSFER_SOURCE_QUANTUM));
    return { quantum: TRANSFER_SOURCE_QUANTUM, count,
      eligibleIndex: this.#resuming ? 0 : Math.min(count - 1, Math.floor((this.#submitted - this.#segmentOrigin) / TRANSFER_SOURCE_QUANTUM)),
      submittedSourceOffset: this.#submitted, committedSourceOffset: this.#claim ? prefix(this.#claim.checkpoint) : this.#length };
  }
  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    requireThat(!this.#pending && !this.#releasing, "authored.transfer.cleanup-pending", "transfer mutation or release is still pending");
    let resolve!: () => void;
    this.#pending = new Promise<void>(yes => { resolve = yes; });
    try { return await run(); } finally { this.#pending = undefined; resolve(); }
  }
  cleanupState(): string {
    if (this.#pending || this.#releasing) return "pending";
    if (this.receipt) return "verified";
    if (this.retirement) return "retired";
    const cp = this.#claim?.checkpoint;
    return cp ? ["checkpoint", cp.id, prefix(cp), cp.authoredTransfer!.cookie, cp.identity.generation ?? ""].join("|") : "none";
  }
  resumeRequired(): { readonly checkpointId: string; readonly committedSourceOffset: number } {
    requireThat(!this.#pending && !this.#releasing, "authored.transfer.resume-disposition-refused",
      "transfer mutation or claim release is still pending");
    requireThat(!this.receipt && !this.retirement, "authored.transfer.resume-disposition-refused",
      "resume-required is unavailable after a verification or retirement receipt");
    const cp = this.#claim?.checkpoint;
    requireThat(cp && cp.phase === "transferring"
      && cp.identity.generation !== null && prefix(cp) <= cp.authoredTransfer!.admittedEnd,
    "authored.transfer.resume-disposition-refused",
    "resume-required needs a live identity-bound transferring checkpoint");
    return { checkpointId: cp.id, committedSourceOffset: prefix(cp) };
  }
  async retire(context: Pick<TransferServiceContext, "live" | "charge" | "takeEvidence" | "call">, cookie: unknown, generation: unknown): Promise<string> {
    return this.#exclusive(async () => {
      context.live(); context.charge(1);
      const claim = this.#claim, cp = claim?.checkpoint;
      requireThat(cp && !this.receipt && !this.retirement, "transfer.checkpoint-invalid", "no interrupted checkpoint to retire");
      requireThat(typeof cookie === "string" && integer(generation) && cp.identity.generation !== null
        && cookie === cp.authoredTransfer!.cookie && String(generation) === cp.identity.generation,
        "transfer.resume.identity-mismatch", "cleanup device binding differs from the interrupted transfer");
      const evidence = context.takeEvidence();
      requireThat(evidence && evidence.bytes > 0 && evidence.sequence > this.#lastEvidence,
        "authored.transfer.report-unobserved", "retirement requires fresh cleanup input, not write acceptance");
      this.#lastEvidence = evidence.sequence;
      await context.call("checkpoint-retire", async () => {
        await this.store.complete(claim!);
        // Storage has acted even if timeout/revocation won while pending, or
        // recording its completion subsequently fails. Release must see the
        // settled state before the caller's terminal observation can throw.
        this.#claim = undefined;
        this.retirement = { checkpointId: cp.id, committedSourceOffset: prefix(cp), verified: false,
          retirement: { authority: "authored-protocol-confirmed", independentRollback: false } };
      });
      context.live(); return "retired";
    });
  }
  #current(): TransferCheckpoint {
    this.context.live();
    requireThat(this.#claim, "transfer.checkpoint-invalid", "transfer-open is required");
    return this.#claim.checkpoint;
  }
  #observe(): void {
    const evidence = this.context.takeEvidence();
    requireThat(evidence && evidence.bytes > 0 && evidence.sequence > this.#lastEvidence,
      "authored.transfer.report-unobserved", "decoded report requires new host-observed input, not a replayed mailbox basis");
    this.#lastEvidence = evidence.sequence;
  }
  async #commit(changes: Partial<TransferCheckpoint>): Promise<void> {
    const old = this.#current();
    requireThat(Number.isSafeInteger(old.revision + 1), "transfer.checkpoint-invalid", "revision exhausted");
    // Keep the *settled* claim even if revocation won while storage was pending.
    // release() must never release a stale pre-commit revision/claim.
    this.#claim = await this.context.call("checkpoint-commit", () => this.store.commit(this.#claim!, { ...old, ...changes, revision: old.revision + 1 }));
    this.context.live(); this.context.progress(this.#claim.checkpoint);
  }
  open(): Promise<string> { return this.#exclusive(() => this.#open()); }
  async #open(): Promise<string> {
    this.context.live();
    requireThat(!this.receipt, "transfer.checkpoint-invalid", "completed transfer cannot create a second checkpoint");
    if (!this.#claim) {
      const config = this.operation.transfer!;
      const checkpoint: TransferCheckpoint = { formatVersion: 1, id: "authored-" + crypto.randomUUID(), revision: 0,
        manifestHash: this.#identity.execution, definitionHash: this.#definitionDigest, modeId: this.#identity.mode,
        direction: "hostToDevice", source: { algorithm: "sha256", digest: this.#sourceDigest, byteLength: this.#length,
          ...(this.sourceSubject ? { subject: this.sourceSubject } : {}) },
        identity: { stableKey: this.#identity.device, generation: null, assurance: this.#identity.device === null ? "unverified" : "verified" },
        phase: "preparing", confirmedRanges: [], finalization: config.finalization,
        authoredTransfer: { version: 1, operation: this.operation.id, argumentsDigest: this.#argumentsDigest,
          policyDigest: this.#identity.policy, targetOffset: config.targetOffset, targetLength: config.targetLength, admittedEnd: 0, cookie: "",
          ...(this.#stream ? { streamed: this.#stream.evidence } : {}) } };
      await this.context.call("checkpoint-create", () => this.store.create(checkpoint));
      this.context.live();
      this.#claim = await this.context.call("checkpoint-claim", () => this.store.claim(checkpoint.id, crypto.randomUUID()));
      this.context.live(); this.context.progress(this.#claim.checkpoint);
    }
    const cp = this.#current();
    return [cp.id, this.#sourceDigest, prefix(cp), cp.authoredTransfer!.cookie, cp.identity.generation ?? "", this.#resuming ? "resume" : "fresh"].join("|");
  }
  report(cookie: unknown, generation: unknown, committed: unknown, volatile: unknown, buffered: unknown): Promise<string> {
    return this.#exclusive(() => this.#report(cookie, generation, committed, volatile, buffered));
  }
  async #report(cookie: unknown, generation: unknown, committed: unknown, volatile: unknown, buffered: unknown): Promise<string> {
    const cp = this.#current(), a = cp.authoredTransfer!;
    this.#observe();
    requireThat(this.#resuming || cp.phase === "preparing" || cp.phase === "transferring",
      "transfer.checkpoint-invalid", "ordinary progress cannot undo finalization");
    requireThat(typeof cookie === "string" && /^[0-9a-f]{2,256}$/.test(cookie) && cookie.length % 2 === 0 && integer(generation)
      && integer(committed) && integer(volatile) && integer(buffered) && buffered <= 65536,
      "transfer.resume.identity-mismatch", "invalid decoded durable-report fields");
    requireThat(committed >= prefix(cp) && committed <= a.admittedEnd && volatile >= committed && volatile <= a.admittedEnd,
      "transfer.resume.offset-mismatch", "durable/volatile report exceeds admitted horizon or rolls back commitment");
    if (cp.identity.generation !== null) requireThat(cp.identity.generation === String(generation) && a.cookie === cookie,
      "transfer.resume.identity-mismatch", "decoded device cookie or transfer generation changed");
    else requireThat(!this.#resuming, "transfer.resume.preparation-incomplete", "interrupted begin has no bound device generation");
    await this.#commit({ phase: "transferring", identity: { ...cp.identity, generation: String(generation), assurance: "verified" },
      authoredTransfer: { ...a, cookie, ...(this.#stream ? { streamed: { ...a.streamed!, committedDigest: this.#stream.commit(committed) } } : {}) },
      confirmedRanges: committed ? [{ targetOffset: a.targetOffset, length: committed }] : [] });
    this.#quiet = buffered === 0 && volatile === committed;
    if (this.#resuming && this.#quiet) { await this.#stream?.reconcile(committed); this.#submitted = committed; this.#segmentOrigin = committed; this.#resuming = false; }
    return (this.#resuming ? "not-quiescent" : "committed") + "|" + committed;
  }
  admit(offset: unknown, payloadOffset: unknown, bytes: Uint8Array, length: unknown): Promise<void> {
    return this.#exclusive(() => this.#admit(offset, payloadOffset, bytes, length));
  }
  async #admit(offset: unknown, payloadOffset: unknown, bytes: Uint8Array, length: unknown): Promise<void> {
    const maximum = this.operation.transfer!.maximumCarrierBytes ?? 256;
    if (bytes.length > maximum) throw Object.assign(new Error("carrier exceeds operation declaration"), {
      error: { code: "authored.transfer.carrier-bound", message: "carrier exceeds operation declaration", retryability: "no",
        details: { maximumCarrierBytes: maximum, actualBytes: bytes.length, submitted: false } },
    });
    const cp = this.#current();
    requireThat(!this.#resuming && cp.identity.generation !== null && cp.phase === "transferring", "transfer.resume.preparation-incomplete", "DATA requires a bound generation and quiescent resume report before finalization");
    requireThat(integer(offset) && integer(payloadOffset) && integer(length) && length > 0 && offset === this.#submitted
      && offset + length <= this.#length && payloadOffset + length <= bytes.length,
      "transfer.resume.offset-mismatch", "carrier source range is not the exact next source suffix");
    if (!this.#stream) for (let i = 0; i < length; i++) { this.context.charge(1); requireThat(bytes[payloadOffset + i] === this.#source[offset + i],
      "transfer.resume.source-mismatch", "carrier payload differs from host-prehashed source"); }
    const submittedDigest = this.#stream?.admit(offset, payloadOffset, bytes, length);
    // Persist the possible horizon BEFORE submitting DATA: crash/partial write
    // may have acted, but cannot advance the independently reported prefix.
    await this.#commit({ authoredTransfer: { ...cp.authoredTransfer!, admittedEnd: Math.max(cp.authoredTransfer!.admittedEnd, offset + length),
      ...(submittedDigest && offset + length >= cp.authoredTransfer!.admittedEnd
        ? { streamed: { ...cp.authoredTransfer!.streamed!, submittedDigest } } : {}) } });
    this.#submitted = offset + length;
  }
  finalize(): Promise<string> { return this.#exclusive(() => this.#finalize()); }
  async #finalize(): Promise<string> {
    const cp = this.#current();
    requireThat(!this.#resuming && prefix(cp) === this.#length, "transfer.resume.offset-mismatch", "accepted DATA is not complete durable settlement");
    this.#stream?.finalizable();
    requireThat(cp.phase === "transferring" || (cp.phase === "finalizing" && cp.finalization === "repeatable"),
      "transfer.resume.finalization-not-repeatable", "finalization cannot be repeated under this policy");
    await this.#commit({ phase: "finalizing" }); return "finalizing";
  }
  verify(source: unknown, target: unknown): Promise<string> { return this.#exclusive(() => this.#verify(source, target)); }
  async #verify(source: unknown, target: unknown): Promise<string> {
    const cp = this.#current();
    this.#observe();
    requireThat(cp.phase === "finalizing" && hex(source) && hex(target), "transfer.verification.invalid-digest", "finalization and two SHA-256 reports are required");
    requireThat(source === this.#sourceDigest, "transfer.verification.digest-mismatch", "device source digest differs from actual submitted source");
    await this.#commit({ phase: "verifying" });
    await this.context.call("checkpoint-complete", () => this.store.complete(this.#claim!));
    this.#claim = undefined;
    this.context.live();
    this.receipt = { source: { authority: "host-computed-device-confirmed", algorithm: "sha256", value: source, length: this.#length,
      ...(this.sourceSubject ? { subject: this.sourceSubject } : {}) },
      target: { authority: "device-reported", algorithm: "sha256", value: target, length: this.operation.transfer!.targetLength }, independentReadBack: false };
    return "verified-source|device-reported-target";
  }
  async release(): Promise<void> {
    this.#releasing = true;
    // A cleanup store call can outlive its wall bound and ordinary result.
    // Its eventual settled revision/removal, not timeout, decides this release.
    await this.#pending;
    try { if (this.#claim) { const claim = this.#claim; this.#claim = undefined; await this.context.call("checkpoint-release", () => this.store.release(claim)); } }
    finally { this.#source = new Uint8Array(); this.#held.release(); }
  }
}
