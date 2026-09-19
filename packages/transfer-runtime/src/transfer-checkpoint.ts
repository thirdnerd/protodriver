import type {
  DecodedLayout,
  HostToDeviceTransferOptions,
  HostToDeviceTransferOutcome,
  TransferCheckpoint,
  TransferCheckpointClaim,
  TransferCheckpointDiagnostic,
  TransferCheckpointDiagnosticCode,
  TransferCheckpointStore,
  TransferResumeIdentity,
  TransferVerificationContract,
  TransferVerificationResult,
  PdrFailureResponsibility,
} from "@protodriver/contracts";
import { isTransferDigestAlgorithm } from "@protodriver/contracts";
import { executeHostToDeviceTransferOutcome } from "./transfer.ts";

export class TransferCheckpointError extends Error {
  readonly responsibility: PdrFailureResponsibility;
  readonly diagnostic: TransferCheckpointDiagnostic;

  constructor(diagnostic: TransferCheckpointDiagnostic, responsibility: PdrFailureResponsibility = "operation") {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "TransferCheckpointError";
    this.responsibility = responsibility;
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function checkpointError(
  code: TransferCheckpointDiagnosticCode,
  declarationPath: string,
  message: string,
  details?: TransferCheckpointDiagnostic["details"],
): TransferCheckpointError {
  return new TransferCheckpointError({
    code,
    declarationPath,
    message,
    ...(details === undefined ? {} : { details }),
  }, "host");
}

function lowercaseDigest(value: string, path: string): string {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) {
    throw checkpointError("transfer.checkpoint-invalid", path, "digest must be nonempty lowercase hexadecimal");
  }
  return value;
}

function sourceSetIdentity(
  value: TransferCheckpoint["sourceSetIdentity"],
  path: string,
): TransferCheckpoint["sourceSetIdentity"] {
  if (value === undefined) return undefined;
  if (value.algorithm !== "sha256") {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.algorithm`, "source-set digest algorithm must be sha256");
  }
  if (!/^[0-9a-f]{64}$/u.test(value.hex)) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.hex`, "source-set identity must be 64 lowercase hexadecimal digits");
  }
  return value;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu)!.map((octet) => Number.parseInt(octet, 16)));
}

async function resumeReportedDigest(
  adapter: HostToDeviceTransferOptions["adapter"],
  verification: TransferVerificationContract,
  path: string,
): Promise<string> {
  const value = adapter.binding?.(verification.reportedBinding);
  if (!(value instanceof Uint8Array)) throw checkpointError("transfer.checkpoint-invalid", path, `reported binding ${JSON.stringify(verification.reportedBinding)} is unavailable`);
  return [...value].map((octet) => octet.toString(16).padStart(2, "0")).join("");
}

function nonempty(value: string, path: string): string {
  if (value.length === 0) throw checkpointError("transfer.checkpoint-invalid", path, "value must not be empty");
  return value;
}

function safeInteger(value: number, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw checkpointError("transfer.checkpoint-invalid", path, `value must be a safe integer at least ${minimum}`);
  }
  return value;
}

export function validateTransferCheckpoint(checkpoint: TransferCheckpoint): TransferCheckpoint {
  const path = `checkpoints.${checkpoint.id}`;
  if (checkpoint.formatVersion !== 2) throw checkpointError("transfer.checkpoint-invalid", `${path}.formatVersion`, "unsupported checkpoint format");
  nonempty(checkpoint.id, `${path}.id`);
  safeInteger(checkpoint.revision, `${path}.revision`);
  lowercaseDigest(checkpoint.manifestHash, `${path}.manifestHash`);
  sourceSetIdentity(checkpoint.sourceSetIdentity, `${path}.sourceSetIdentity`);
  lowercaseDigest(checkpoint.definitionHash, `${path}.definitionHash`);
  if (checkpoint.manifestTransfer !== undefined) {
    const materialization: unknown = checkpoint.manifestTransfer;
    if (typeof materialization !== "object" || materialization === null || Array.isArray(materialization)) {
      throw checkpointError("transfer.checkpoint-invalid", `${path}.manifestTransfer`, "manifest transfer context must be a record");
    }
    const record = materialization as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw checkpointError("transfer.checkpoint-invalid", `${path}.manifestTransfer.id`, "manifest transfer id must be nonempty");
    }
    if (typeof record.parameters !== "object" || record.parameters === null || Array.isArray(record.parameters)) {
      throw checkpointError("transfer.checkpoint-invalid", `${path}.manifestTransfer.parameters`, "manifest transfer parameters must be a record");
    }
    for (const [name, value] of Object.entries(record.parameters)) {
      nonempty(name, `${path}.manifestTransfer.parameters`);
      if (!Number.isSafeInteger(value)) {
        throw checkpointError(
          "transfer.checkpoint-invalid",
          `${path}.manifestTransfer.parameters.${name}`,
          "materialized transfer parameter must be a safe integer",
        );
      }
    }
  }
  nonempty(checkpoint.modeId, `${path}.modeId`);
  if (checkpoint.direction !== "hostToDevice" && checkpoint.direction !== "deviceToHost") {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.direction`, "direction is not a transfer direction");
  }
  if (!["preparing", "prepared", "transferring", "verifying", "finalizing"].includes(checkpoint.phase)) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.phase`, "phase is not a checkpoint phase");
  }
  if (checkpoint.finalization !== "repeatable" && checkpoint.finalization !== "not-repeatable") {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.finalization`, "finalization is not a checkpoint policy");
  }
  if (!isTransferDigestAlgorithm(checkpoint.source.algorithm)) {
    throw checkpointError(
      "transfer.checkpoint-invalid",
      `${path}.source.algorithm`,
      `transfer digest algorithm ${JSON.stringify(checkpoint.source.algorithm)} is not admitted`,
    );
  }
  lowercaseDigest(checkpoint.source.digest, `${path}.source.digest`);
  safeInteger(checkpoint.source.byteLength, `${path}.source.byteLength`, 1);
  if (!["serial-number", "path-derived", "none"].includes(checkpoint.identity.stableKeyAssurance)) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.identity.stableKeyAssurance`, "stable-key assurance is not recognized");
  }
  if (checkpoint.identity.stableKeyAssurance === "none") {
    if (checkpoint.identity.stableKey !== null) {
      throw checkpointError("transfer.checkpoint-invalid", `${path}.identity.stableKey`, "identity without stable-key assurance must not carry a stable key");
    }
  } else if (checkpoint.identity.stableKey === null) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.identity.stableKey`, "assured identity must carry a stable key");
  } else nonempty(checkpoint.identity.stableKey, `${path}.identity.stableKey`);
  if (checkpoint.identity.generation !== null) nonempty(checkpoint.identity.generation, `${path}.identity.generation`);

  let previousEnd = -1;
  for (const [index, range] of checkpoint.confirmedRanges.entries()) {
    const rangePath = `${path}.confirmedRanges.${index}`;
    safeInteger(range.targetOffset, `${rangePath}.targetOffset`);
    safeInteger(range.length, `${rangePath}.length`, 1);
    const end = range.targetOffset + range.length;
    if (!Number.isSafeInteger(end) || range.targetOffset < previousEnd) {
      throw checkpointError("transfer.checkpoint-invalid", rangePath, "confirmed ranges must be ordered, non-overlapping safe ranges");
    }
    previousEnd = end;
  }
  return checkpoint;
}

function cloneCheckpoint(checkpoint: TransferCheckpoint): TransferCheckpoint {
  return Object.freeze(structuredClone(validateTransferCheckpoint(checkpoint)));
}

interface StoredCheckpoint {
  checkpoint: TransferCheckpoint;
  claim: { readonly owner: string; readonly token: string } | null;
}

/** Deterministic in-process implementation used where one process owns the store. */
export class InMemoryTransferCheckpointStore implements TransferCheckpointStore {
  readonly #records = new Map<string, StoredCheckpoint>();
  #nextToken = 1;

  async create(checkpoint: TransferCheckpoint): Promise<void> {
    validateTransferCheckpoint(checkpoint);
    if (this.#records.has(checkpoint.id)) {
      throw checkpointError("transfer.checkpoint-conflict", `checkpoints.${checkpoint.id}`, "checkpoint already exists");
    }
    this.#records.set(checkpoint.id, { checkpoint: cloneCheckpoint(checkpoint), claim: null });
  }

  async read(id: string): Promise<TransferCheckpoint | null> {
    return this.#records.has(id) ? cloneCheckpoint(this.#records.get(id)!.checkpoint) : null;
  }

  async claim(id: string, owner: string): Promise<TransferCheckpointClaim> {
    nonempty(owner, `checkpoints.${id}.claim.owner`);
    const stored = this.#records.get(id);
    if (stored === undefined) throw checkpointError("transfer.checkpoint-invalid", `checkpoints.${id}`, "checkpoint does not exist");
    if (stored.claim !== null) {
      throw checkpointError(
        "transfer.checkpoint-held",
        `checkpoints.${id}.claim`,
        `checkpoint is already claimed by ${stored.claim.owner}`,
      );
    }
    const token = `claim-${this.#nextToken++}`;
    stored.claim = { owner, token };
    return Object.freeze({ checkpoint: cloneCheckpoint(stored.checkpoint), owner, token });
  }

  async commit(claim: TransferCheckpointClaim, checkpoint: TransferCheckpoint): Promise<TransferCheckpointClaim> {
    validateTransferCheckpoint(checkpoint);
    const stored = this.#records.get(claim.checkpoint.id);
    if (stored === undefined
        || stored.claim?.token !== claim.token
        || stored.claim.owner !== claim.owner
        || checkpoint.id !== claim.checkpoint.id
        || checkpoint.revision !== stored.checkpoint.revision + 1) {
      throw checkpointError("transfer.checkpoint-conflict", `checkpoints.${claim.checkpoint.id}`, "checkpoint claim or revision is stale");
    }
    stored.checkpoint = cloneCheckpoint(checkpoint);
    return Object.freeze({ checkpoint: cloneCheckpoint(stored.checkpoint), owner: claim.owner, token: claim.token });
  }

  async release(claim: TransferCheckpointClaim): Promise<void> {
    const stored = this.#records.get(claim.checkpoint.id);
    if (stored === undefined || stored.claim?.token !== claim.token || stored.claim.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", `checkpoints.${claim.checkpoint.id}.claim`, "checkpoint claim is stale");
    }
    stored.claim = null;
  }

  async complete(claim: TransferCheckpointClaim): Promise<void> {
    const stored = this.#records.get(claim.checkpoint.id);
    if (stored === undefined || stored.claim?.token !== claim.token || stored.claim.owner !== claim.owner) {
      throw checkpointError("transfer.checkpoint-conflict", `checkpoints.${claim.checkpoint.id}.claim`, "checkpoint claim is stale");
    }
    this.#records.delete(claim.checkpoint.id);
  }
}

export interface TransferResumeValidationInput {
  readonly checkpoint: TransferCheckpoint;
  readonly manifestHash: string;
  readonly sourceSetIdentity?: TransferCheckpoint["sourceSetIdentity"];
  readonly definitionHash: string;
  readonly modeId: string;
  readonly direction: "hostToDevice" | "deviceToHost";
  readonly sourceDigest: string;
  readonly identity: TransferResumeIdentity;
  /** Present after reconnect/suspend when the declaration can report it. */
  readonly reportedTargetOffset?: number;
  readonly targetStartOffset?: number;
}

export interface TransferResumeValidationResult {
  readonly assurance: "verified" | "unverified";
  readonly confirmedTargetOffset: number;
}

function confirmedTargetOffset(checkpoint: TransferCheckpoint, start: number): number {
  let offset = start;
  for (const range of checkpoint.confirmedRanges) {
    if (range.targetOffset !== offset) break;
    offset += range.length;
  }
  return offset;
}

function validateTransferResumeAtStage(
  input: TransferResumeValidationInput,
  allowUnknownGeneration: boolean,
): TransferResumeValidationResult {
  const checkpoint = validateTransferCheckpoint(input.checkpoint);
  const path = `checkpoints.${checkpoint.id}`;
  if (lowercaseDigest(input.manifestHash, `${path}.resume.manifestHash`) !== checkpoint.manifestHash) {
    throw checkpointError("transfer.resume.manifest-mismatch", `${path}.manifestHash`, "loaded manifest changed");
  }
  const suppliedSourceSetIdentity = sourceSetIdentity(input.sourceSetIdentity, `${path}.resume.sourceSetIdentity`);
  const recordedSourceSetIdentity = checkpoint.sourceSetIdentity;
  if (recordedSourceSetIdentity?.algorithm !== suppliedSourceSetIdentity?.algorithm
      || recordedSourceSetIdentity?.hex !== suppliedSourceSetIdentity?.hex) {
    throw checkpointError(
      "transfer.resume.source-set-mismatch",
      `${path}.sourceSetIdentity`,
      "authored Lua source set changed or is unavailable",
    );
  }
  if (lowercaseDigest(input.definitionHash, `${path}.resume.definitionHash`) !== checkpoint.definitionHash) {
    throw checkpointError("transfer.resume.definition-mismatch", `${path}.definitionHash`, "executable transfer definition changed");
  }
  if (input.modeId !== checkpoint.modeId) {
    throw checkpointError("transfer.resume.mode-mismatch", `${path}.modeId`, "replacement connection is in a different mode");
  }
  if (input.direction !== checkpoint.direction) {
    throw checkpointError("transfer.resume.direction-mismatch", `${path}.direction`, "checkpoint direction differs from the resumed transfer");
  }
  if (checkpoint.phase === "preparing") {
    throw checkpointError(
      "transfer.resume.preparation-incomplete",
      `${path}.phase`,
      "interrupted preparation has no confirmed post-preparation state and cannot be resumed",
    );
  }
  if (lowercaseDigest(input.sourceDigest, `${path}.resume.sourceDigest`) !== checkpoint.source.digest) {
    throw checkpointError("transfer.resume.source-mismatch", `${path}.source.digest`, "source digest changed");
  }
  if (checkpoint.phase === "finalizing" && checkpoint.finalization === "not-repeatable") {
    throw checkpointError("transfer.resume.finalization-not-repeatable", `${path}.finalization`, "interrupted finalization is not repeatable");
  }

  const expectedIdentity = checkpoint.identity;
  if (input.identity.stableKeyAssurance !== expectedIdentity.stableKeyAssurance
      || input.identity.stableKey !== expectedIdentity.stableKey) {
    throw checkpointError("transfer.resume.identity-mismatch", `${path}.identity`, "replacement connection does not match checkpoint identity");
  }
  if (expectedIdentity.generation !== null
      && input.identity.generation !== expectedIdentity.generation
      && !(allowUnknownGeneration && input.identity.generation === null)) {
    throw checkpointError("transfer.resume.identity-mismatch", `${path}.identity`, "replacement connection does not match checkpoint identity");
  }
  const assurance = expectedIdentity.stableKeyAssurance === "serial-number" ? "verified" : "unverified";
  const targetStartOffset = safeInteger(input.targetStartOffset ?? 0, `${path}.resume.targetStartOffset`);
  const maximumTargetOffset = targetStartOffset + checkpoint.source.byteLength;
  if (!Number.isSafeInteger(maximumTargetOffset)) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.source.byteLength`, "checkpoint transfer extent is not a safe integer");
  }
  const checkpointOffset = confirmedTargetOffset(checkpoint, targetStartOffset);
  if (checkpointOffset > maximumTargetOffset) {
    throw checkpointError("transfer.checkpoint-invalid", `${path}.confirmedRanges`, "durable confirmed progress exceeds the checkpoint transfer extent");
  }
  if (input.reportedTargetOffset === undefined) {
    return Object.freeze({ assurance, confirmedTargetOffset: checkpointOffset });
  }
  const reportedTargetOffset = safeInteger(input.reportedTargetOffset, `${path}.resume.reportedTargetOffset`);
  if (reportedTargetOffset < checkpointOffset) {
    throw checkpointError(
      "transfer.resume.offset-mismatch",
      `${path}.confirmedRanges`,
      "device-reported offset regresses behind durable confirmed progress",
      { checkpointOffset, reportedOffset: reportedTargetOffset },
    );
  }
  if (reportedTargetOffset > maximumTargetOffset) {
    throw checkpointError(
      "transfer.resume.offset-mismatch",
      `${path}.confirmedRanges`,
      "device-reported offset exceeds the checkpoint transfer extent",
      { checkpointOffset, reportedOffset: reportedTargetOffset, maximumOffset: maximumTargetOffset },
    );
  }
  return Object.freeze({ assurance, confirmedTargetOffset: reportedTargetOffset });
}

/** Refuses every mismatch before an executor is allowed to admit bytes. */
export function validateTransferResume(input: TransferResumeValidationInput): TransferResumeValidationResult {
  return validateTransferResumeAtStage(input, false);
}

function reconcileConfirmedPrefix(
  checkpoint: TransferCheckpoint,
  targetStartOffset: number,
  reportedTargetOffset: number,
): readonly TransferCheckpoint["confirmedRanges"][number][] {
  const ranges = [
    ...checkpoint.confirmedRanges,
    ...(reportedTargetOffset === targetStartOffset
      ? []
      : [{ targetOffset: targetStartOffset, length: reportedTargetOffset - targetStartOffset }]),
  ].sort((left, right) => left.targetOffset - right.targetOffset);
  const reconciled: Array<TransferCheckpoint["confirmedRanges"][number]> = [];
  for (const range of ranges) {
    const previous = reconciled.at(-1);
    if (previous === undefined || previous.targetOffset + previous.length < range.targetOffset) {
      reconciled.push(Object.freeze({ ...range }));
      continue;
    }
    const end = Math.max(previous.targetOffset + previous.length, range.targetOffset + range.length);
    reconciled[reconciled.length - 1] = Object.freeze({
      targetOffset: previous.targetOffset,
      length: end - previous.targetOffset,
    });
  }
  return Object.freeze(reconciled);
}

export interface ExecuteResumedHostToDeviceTransferOptions extends Omit<
  HostToDeviceTransferOptions,
  "definition" | "expectedSourceDigest" | "checkpoint"
> {
  readonly definition: HostToDeviceTransferOptions["definition"];
  readonly store: TransferCheckpointStore;
  readonly claim: TransferCheckpointClaim;
  readonly manifestHash: string;
  readonly sourceSetIdentity?: TransferCheckpoint["sourceSetIdentity"];
  readonly definitionHash: string;
  readonly modeId: string;
  readonly identity: TransferResumeIdentity;
  readonly observeReportedTargetOffset: (selection: string, signal: AbortSignal) => Promise<number>;
}

export interface ExecuteResumedHostToDeviceTransferResult {
  readonly assurance: "verified" | "unverified";
  readonly outcome: HostToDeviceTransferOutcome;
  /** Null after successful completion removes the durable checkpoint. */
  readonly claim: TransferCheckpointClaim | null;
}

async function hashSourceRange(
  options: ExecuteResumedHostToDeviceTransferOptions,
  sourceOffset: number,
  length: number,
  algorithm = options.claim.checkpoint.source.algorithm,
): Promise<string> {
  if (options.source.seek === undefined) {
    throw checkpointError("transfer.resume.source-mismatch", `checkpoints.${options.claim.checkpoint.id}.source`, "durable resume requires a seekable source");
  }
  await options.source.seek(sourceOffset);
  const digest = options.digestProvider.create(algorithm);
  let remaining = length;
  while (remaining > 0) {
    const bytes = new Uint8Array(Math.min(remaining, options.limits.maximumResourceChunkBytes));
    const read = await options.source.read(bytes);
    if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > bytes.byteLength) {
      throw checkpointError("transfer.resume.source-mismatch", `checkpoints.${options.claim.checkpoint.id}.source`, "source did not provide the declared resumable range");
    }
    digest.update(bytes.subarray(0, read.bytesRead));
    remaining -= read.bytesRead;
    if (read.eof && remaining !== 0) {
      throw checkpointError("transfer.resume.source-mismatch", `checkpoints.${options.claim.checkpoint.id}.source`, "source ended before the declared resumable range");
    }
  }
  return lowercaseDigest(await digest.digestHex(), `checkpoints.${options.claim.checkpoint.id}.source.digest`);
}

async function completeResumeVerification(
  options: ExecuteResumedHostToDeviceTransferOptions,
  direction: NonNullable<HostToDeviceTransferOptions["definition"]["directions"]["hostToDevice"]>,
): Promise<readonly TransferVerificationResult[]> {
  const results: TransferVerificationResult[] = [];
  for (const [index, verification] of direction.verification.entries()) {
    const verificationPath = `transfers.${options.definition.id}.directions.hostToDevice.verification.${index}`;
    const reported = lowercaseDigest(
      await checkpointBounded(
        options,
        verification.maximumWaitMs,
        `${verificationPath}.reported`,
        () => resumeReportedDigest(options.adapter, verification, `${verificationPath}.reported`),
      ),
      `${verificationPath}.reported`,
    );
    let value = reported;
    if (verification.authority === "host-computed-device-confirmed") {
      if (verification.domain !== "source") {
        throw checkpointError(
          "transfer.checkpoint-invalid",
          verificationPath,
          `${verification.domain} host verification cannot be reconstructed after resume`,
        );
      }
      const sourceOffset = verification.coverage.kind === "complete-effective-range"
        ? direction.data.sourceOffset
        : verification.coverage.offset;
      const length = verification.coverage.kind === "complete-effective-range"
        ? direction.data.length
        : verification.coverage.length;
      const computed = await hashSourceRange(options, sourceOffset, length, verification.algorithm);
      if (computed !== reported) {
        throw checkpointError(
          "transfer.resume.source-mismatch",
          verificationPath,
          `source ${verification.algorithm} digest differs after resume`,
          { computed, reported },
        );
      }
      value = computed;
    } else if (verification.authority !== "device-reported") {
      throw checkpointError("transfer.checkpoint-invalid", `${verificationPath}.authority`, "verification authority is not declared");
    }
    results.push(Object.freeze({
      id: verification.id,
      authority: verification.authority,
      algorithm: verification.algorithm,
      domain: verification.domain,
      coverage: Object.freeze({ ...verification.coverage }),
      value,
    }));
  }
  return Object.freeze(results);
}

async function checkpointBounded<T>(
  options: ExecuteResumedHostToDeviceTransferOptions,
  maximumWaitMs: number,
  path: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectBoundary: ((cause: unknown) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const onAbort = (): void => {
    const cause = options.signal?.reason ?? new DOMException("resume cancelled", "AbortError");
    controller.abort(cause);
    rejectBoundary?.(cause);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = options.clock.timer(maximumWaitMs, () => {
    const cause = checkpointError("transfer.resume.offset-mismatch", path, `reported offset was not observed within ${maximumWaitMs} ms`);
    controller.abort(cause);
    rejectBoundary?.(cause);
  });
  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    timer.dispose();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function observeReportedOffset(
  options: ExecuteResumedHostToDeviceTransferOptions,
  selection: string,
  maximumWaitMs: number,
): Promise<number> {
  const path = `checkpoints.${options.claim.checkpoint.id}.reportedOffset`;
  const offset = await checkpointBounded(
    options,
    maximumWaitMs,
    path,
    (signal) => options.observeReportedTargetOffset(selection, signal),
  );
  return safeInteger(offset, path);
}

function resumeReportInteger(message: DecodedLayout, path: readonly string[], declarationPath: string): number {
  if (path.length !== 2 || path[0] !== "fields") {
    throw checkpointError("transfer.checkpoint-invalid", declarationPath, "resume report path must name one decoded field");
  }
  const value = message.fields[path[1]!];
  if (typeof value !== "number") {
    throw checkpointError("transfer.checkpoint-invalid", declarationPath, "resume report path did not yield an integer");
  }
  return safeInteger(value, declarationPath);
}

function assertResumeGeneration(
  options: ExecuteResumedHostToDeviceTransferOptions,
  generation: number,
  path: string,
): void {
  if (options.claim.checkpoint.identity.generation !== null
      && String(generation) !== options.claim.checkpoint.identity.generation) {
    throw checkpointError(
      "transfer.resume.identity-mismatch",
      path,
      "resume recipe reported a different transfer generation",
      { expected: options.claim.checkpoint.identity.generation, actual: String(generation) },
    );
  }
}

function assertSameObservedGeneration(expected: number, actual: number, path: string): void {
  if (actual !== expected) {
    throw checkpointError(
      "transfer.resume.identity-mismatch",
      path,
      "resume initiation generation differs from the read-only probe",
      { expected: String(expected), actual: String(actual) },
    );
  }
}

/**
 * Claims are acquired by the host store before this function. Validation,
 * source prehash and reported-offset reconciliation all precede device work.
 */
export async function executeResumedHostToDeviceTransfer(
  options: ExecuteResumedHostToDeviceTransferOptions,
): Promise<ExecuteResumedHostToDeviceTransferResult> {
  const direction = options.definition.directions.hostToDevice;
  if (direction === null) {
    throw checkpointError("transfer.checkpoint-invalid", `checkpoints.${options.claim.checkpoint.id}.direction`, "checkpoint names an unavailable host-to-device direction");
  }
  if (direction.resume === null || direction.resume.kind !== "durable-reported-offset") {
    throw checkpointError("transfer.checkpoint-invalid", `checkpoints.${options.claim.checkpoint.id}.direction.resume`, "resumed execution requires a durable reported-offset declaration");
  }
  if (direction.verification.some((verification) => (
    verification.authority === "host-computed-device-confirmed"
    && verification.domain !== "source"
  ))) throw checkpointError(
    "transfer.checkpoint-invalid",
    `checkpoints.${options.claim.checkpoint.id}.direction.verification`,
    "durable resume can reconstruct only host-computed source verification",
  );
  if (direction.resume.sourceDigestAlgorithm !== options.claim.checkpoint.source.algorithm
      || direction.resume.finalization !== options.claim.checkpoint.finalization) {
    throw checkpointError("transfer.checkpoint-invalid", `checkpoints.${options.claim.checkpoint.id}.direction.resume`, "checkpoint digest or finalization policy differs from the resume declaration");
  }
  const fullSourceDigest = await hashSourceRange(options, direction.data.sourceOffset, direction.data.length);
  const initialBindings: Record<string, number | Uint8Array> = {};
  for (const binding of options.definition.bindings ?? []) {
    if (binding.initialize?.kind === "source-length") initialBindings[binding.name] = direction.data.length;
    else if (binding.initialize?.kind === "source-digest") initialBindings[binding.name] = hexBytes(fullSourceDigest);
  }
  options.adapter.initializeBindings?.(initialBindings);
  const validationInput = {
    checkpoint: options.claim.checkpoint,
    manifestHash: options.manifestHash,
    ...(options.sourceSetIdentity === undefined ? {} : { sourceSetIdentity: options.sourceSetIdentity }),
    definitionHash: options.definitionHash,
    modeId: options.modeId,
    direction: "hostToDevice" as const,
    sourceDigest: fullSourceDigest,
    identity: options.identity,
    targetStartOffset: direction.data.targetOffset,
  };
  const quiescence = direction.resume.recipe?.quiescence;
  const checkpointValidation = validateTransferResumeAtStage(validationInput, quiescence !== undefined);
  let observedIdentity = options.identity;
  let probedGeneration: number | undefined;
  let reportedTargetOffset: number | undefined;
  if (direction.resume.recipe !== undefined) {
    const recipe = direction.resume.recipe;
    if (quiescence !== undefined) {
      if (options.adapter.executeResumeProbe === undefined || options.adapter.nextResumeReport === undefined) {
        throw checkpointError(
          "transfer.checkpoint-invalid",
          `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.quiescence`,
          "resume adapter cannot observe declared quiescence",
        );
      }
      await checkpointBounded(
        options,
        quiescence.probe.maximumWaitMs,
        `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.quiescence.probe`,
        (signal) => options.adapter.executeResumeProbe!(quiescence.probe, quiescence.report.selection, signal),
      );
      const probePath = `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.quiescence.probe`;
      const probeReported = options.adapter.binding?.(recipe.reportedOffsetBinding);
      const probeGeneration = options.adapter.binding?.(quiescence.probedGenerationBinding);
      const probeVolatile = options.adapter.binding?.(quiescence.volatileOffsetBinding);
      const probeCount = options.adapter.binding?.(quiescence.bufferedRangeCountBinding);
      if (typeof probeReported !== "number" || typeof probeGeneration !== "number"
          || typeof probeVolatile !== "number" || typeof probeCount !== "number") {
        throw checkpointError("transfer.checkpoint-invalid", probePath, "resume quiescence probe did not reconstruct its integer bindings");
      }
      reportedTargetOffset = safeInteger(probeReported, `${probePath}.${recipe.reportedOffsetBinding}`);
      probedGeneration = safeInteger(probeGeneration, `${probePath}.${quiescence.probedGenerationBinding}`);
      assertResumeGeneration(options, probedGeneration, `${probePath}.${quiescence.probedGenerationBinding}`);
      observedIdentity = Object.freeze({
        stableKeyAssurance: options.identity.stableKeyAssurance,
        stableKey: options.identity.stableKey,
        generation: String(probedGeneration),
      });
      const volatileOffset = safeInteger(probeVolatile, `${probePath}.${quiescence.volatileOffsetBinding}`);
      const bufferedRangeCount = safeInteger(probeCount, `${probePath}.${quiescence.bufferedRangeCountBinding}`);
      if (bufferedRangeCount !== 0 || volatileOffset !== reportedTargetOffset) {
        const reportPath = `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.quiescence.report`;
        const accepted = await checkpointBounded(
          options,
          quiescence.report.maximumWaitMs,
          reportPath,
          async (signal) => {
            while (true) {
              const message = await options.adapter.nextResumeReport!(quiescence.report.selection, signal);
              const committed = resumeReportInteger(message, quiescence.report.reportedOffsetPath, `${reportPath}.reportedOffsetPath`);
              const volatile = resumeReportInteger(message, quiescence.report.volatileOffsetPath, `${reportPath}.volatileOffsetPath`);
              const count = resumeReportInteger(message, quiescence.report.bufferedRangeCountPath, `${reportPath}.bufferedRangeCountPath`);
              const generation = resumeReportInteger(message, quiescence.report.generationPath, `${reportPath}.generationPath`);
              if (count === 0 && volatile === committed) return { committed, generation };
            }
          },
        );
        assertResumeGeneration(options, accepted.generation, `${reportPath}.generationPath`);
        assertSameObservedGeneration(probedGeneration, accepted.generation, `${reportPath}.generationPath`);
        reportedTargetOffset = accepted.committed;
      }
      const quiescentTargetOffset = direction.settlement.kind === "cumulative-prefix-report"
          && direction.settlement.domain === "source"
        ? direction.data.targetOffset + (reportedTargetOffset - direction.data.sourceOffset)
        : reportedTargetOffset;
      validateTransferResume({ ...validationInput, identity: observedIdentity, reportedTargetOffset: quiescentTargetOffset });
    }
    for (const [index, action] of direction.resume.recipe.actions.entries()) await checkpointBounded(
      options,
      action.maximumWaitMs,
      `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.actions.${index}`,
      (signal) => options.adapter.executeRecipeAction(action, "preparation", signal),
    );
    const generation = options.adapter.binding?.(recipe.generationBinding);
    if (typeof generation !== "number") throw checkpointError(
      "transfer.checkpoint-invalid",
      `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe`,
      "resume recipe did not reconstruct its reported offset and generation bindings",
    );
    const initiationGeneration = safeInteger(generation, `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.generationBinding`);
    assertResumeGeneration(options, initiationGeneration, `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.generationBinding`);
    if (probedGeneration !== undefined) {
      assertSameObservedGeneration(probedGeneration, initiationGeneration, `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.generationBinding`);
    }
    if (quiescence === undefined) {
      const reported = options.adapter.binding?.(recipe.reportedOffsetBinding);
      if (typeof reported !== "number") throw checkpointError(
        "transfer.checkpoint-invalid",
        `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe`,
        "resume recipe did not reconstruct its reported offset and generation bindings",
      );
      reportedTargetOffset = safeInteger(reported, `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe.reportedOffsetBinding`);
    }
  } else {
    reportedTargetOffset = await observeReportedOffset(options, direction.resume.reportedOffsetSelection, direction.resume.maximumWaitMs);
  }
  if (reportedTargetOffset === undefined) throw checkpointError(
    "transfer.checkpoint-invalid",
    `transfers.${options.definition.id}.directions.hostToDevice.resume.recipe`,
    "resume recipe did not reconstruct a reported offset",
  );
  if (direction.settlement.kind === "cumulative-prefix-report" && direction.settlement.domain === "source") {
    reportedTargetOffset = direction.data.targetOffset + (reportedTargetOffset - direction.data.sourceOffset);
  }
  const validation = validateTransferResume({ ...validationInput, identity: observedIdentity, reportedTargetOffset });
  let currentClaim = options.claim;
  const commit = async (update: Partial<Pick<TransferCheckpoint, "phase" | "confirmedRanges">>): Promise<void> => {
    const next = {
      ...currentClaim.checkpoint,
      revision: currentClaim.checkpoint.revision + 1,
      ...update,
    };
    currentClaim = await options.store.commit(currentClaim, next);
  };
  if (validation.confirmedTargetOffset > checkpointValidation.confirmedTargetOffset) {
    await commit({
      confirmedRanges: reconcileConfirmedPrefix(
        currentClaim.checkpoint,
        direction.data.targetOffset,
        validation.confirmedTargetOffset,
      ),
    });
  }
  const consumed = validation.confirmedTargetOffset - direction.data.targetOffset;
  if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > direction.data.length) {
    throw checkpointError("transfer.checkpoint-invalid", `checkpoints.${options.claim.checkpoint.id}.confirmedRanges`, "confirmed progress lies outside the transfer range");
  }
  if (consumed === direction.data.length) {
    try {
      if (direction.completion.length > 0) await commit({ phase: "finalizing" });
      for (const [index, action] of direction.completion.entries()) {
        await checkpointBounded(
          options,
          action.maximumWaitMs,
          `transfers.${options.definition.id}.directions.hostToDevice.completion.${index}`,
          (signal) => options.adapter.executeRecipeAction(action, "completion", signal),
        );
      }
      await commit({ phase: "verifying" });
      const verification = await completeResumeVerification(options, direction);
      await options.store.complete(currentClaim);
      return Object.freeze({
        assurance: validation.assurance,
        outcome: Object.freeze({
          direction: "hostToDevice",
          outcome: "completed",
          counts: Object.freeze({ source: 0, transmitted: 0, target: 0 }),
          settledActions: 0,
          verification,
        }),
        claim: null,
      });
    } catch (cause) {
      await options.store.release(currentClaim);
      return Object.freeze({
        assurance: validation.assurance,
        outcome: Object.freeze({
          direction: "hostToDevice",
          outcome: "indeterminate-after-destructive-work",
          destructiveActions: Math.max(1, currentClaim.checkpoint.confirmedRanges.length),
          cause: Object.freeze({
            code: "transfer.write.indeterminate" as const,
            declarationPath: `transfers.${options.definition.id}.directions.hostToDevice`,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        }),
        claim: currentClaim,
      });
    }
  }

  const remainingLength = direction.data.length - consumed;
  const remainingDigest = await hashSourceRange(options, direction.data.sourceOffset + consumed, remainingLength);
  const resumedDefinition = {
    ...options.definition,
    directions: {
      ...options.definition.directions,
      hostToDevice: {
        ...direction,
        preparation: [],
        // Verification and finalization describe the complete image, not the
        // remaining suffix. Run both below after the suffix settles.
        completion: [],
        verification: [],
        data: {
          ...direction.data,
          sourceOffset: direction.data.sourceOffset + consumed,
          targetOffset: direction.data.targetOffset + consumed,
          length: remainingLength,
        },
      },
    },
  };
  const confirmed = [...currentClaim.checkpoint.confirmedRanges];
  const outcome = await executeHostToDeviceTransferOutcome({
    definition: resumedDefinition,
    adapter: options.adapter,
    source: options.source,
    digestProvider: options.digestProvider,
    clock: options.clock,
    limits: options.limits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    expectedSourceDigest: { algorithm: currentClaim.checkpoint.source.algorithm, value: remainingDigest },
    initialBindings,
    checkpoint: {
      confirmed: async (range) => {
        confirmed.push({ targetOffset: range.targetOffset, length: range.length });
        confirmed.sort((left, right) => left.targetOffset - right.targetOffset);
        await commit({ confirmedRanges: Object.freeze([...confirmed]) });
        return Object.freeze({ ...range });
      },
      phase: async (phase) => commit({ phase }),
    },
  });
  if (outcome.outcome !== "completed") {
    await options.store.release(currentClaim);
    return Object.freeze({ assurance: validation.assurance, outcome, claim: currentClaim });
  }

  try {
    if (direction.completion.length > 0) await commit({ phase: "finalizing" });
    for (const [index, action] of direction.completion.entries()) {
      await checkpointBounded(
        options,
        action.maximumWaitMs,
        `transfers.${options.definition.id}.directions.hostToDevice.completion.${index}`,
        (signal) => options.adapter.executeRecipeAction(action, "completion", signal),
      );
    }
    const verification = await completeResumeVerification(options, direction);
    await options.store.complete(currentClaim);
    return Object.freeze({
      assurance: validation.assurance,
      outcome: Object.freeze({ ...outcome, verification }),
      claim: null,
    });
  } catch (cause) {
    await options.store.release(currentClaim);
    return Object.freeze({
      assurance: validation.assurance,
      outcome: Object.freeze({
        direction: "hostToDevice",
        outcome: "indeterminate-after-destructive-work",
        destructiveActions: Math.max(1, currentClaim.checkpoint.confirmedRanges.length),
        cause: Object.freeze({
          code: "transfer.write.indeterminate" as const,
          declarationPath: `transfers.${options.definition.id}.directions.hostToDevice`,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }),
      claim: currentClaim,
    });
  }
}
