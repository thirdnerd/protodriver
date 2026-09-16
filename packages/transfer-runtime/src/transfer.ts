import type {
  DeviceToHostTransferOptions,
  DeviceToHostTransferResult,
  HostToDeviceTransferOptions,
  HostToDeviceTransferOutcome,
  HostToDeviceTransferResult,
  TransferAdmittedAction,
  TransferByteDomain,
  TransferDirectionContract,
  TransferEffectiveRange,
  TransferVerificationContract,
  TransferVerificationResult,
  TransferRecipeActionContract,
  TransferRuntimeDiagnostic,
  TransferRuntimeDiagnosticCause,
  TransferRuntimeDiagnosticCode,
  TransferSettlementObservation,
  TransferStreamingDigest,
} from "@protodriver/contracts";
import type { PdrFailureResponsibility } from "@protodriver/contracts";

export class TransferRuntimeError extends Error {
  readonly responsibility: PdrFailureResponsibility;
  readonly diagnostic: TransferRuntimeDiagnostic;

  constructor(diagnostic: TransferRuntimeDiagnostic, responsibility: PdrFailureResponsibility = "operation") {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "TransferRuntimeError";
    this.responsibility = responsibility;
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function transferError(
  code: TransferRuntimeDiagnosticCode,
  declarationPath: string,
  message: string,
  details?: TransferRuntimeDiagnostic["details"],
  cause?: TransferRuntimeDiagnosticCause,
  responsibility: PdrFailureResponsibility = "operation",
): TransferRuntimeError {
  return new TransferRuntimeError({
    code,
    declarationPath,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  }, responsibility);
}

function immediateCause(cause: unknown): TransferRuntimeDiagnosticCause {
  if (cause instanceof TransferRuntimeError) {
    return Object.freeze({
      owner: "transfer",
      code: cause.diagnostic.code,
      message: cause.diagnostic.message,
      path: cause.diagnostic.declarationPath,
      ...(cause.diagnostic.details === undefined ? {} : { details: cause.diagnostic.details }),
    });
  }
  const diagnostic = typeof cause === "object" && cause !== null && "diagnostic" in cause
    ? (cause as { readonly diagnostic?: unknown }).diagnostic
    : undefined;
  if (typeof diagnostic === "object" && diagnostic !== null) {
    const record = diagnostic as Readonly<Record<string, unknown>>;
    const code = typeof record.code === "string" ? record.code : "runtime.diagnostic";
    const message = typeof record.message === "string"
      ? record.message
      : cause instanceof Error ? cause.message : String(cause);
    const path = typeof record.declarationPath === "string"
      ? record.declarationPath
      : typeof record.command === "string" ? record.command : undefined;
    const details = scalarDetails(record.details);
    const platformCause = platformCauseSnapshot(record.platformCause);
    return Object.freeze({
      owner: diagnosticOwner(code),
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(details === undefined ? {} : { details }),
      ...(platformCause === undefined ? {} : { platformCause }),
    });
  }
  return Object.freeze({
    owner: "runtime",
    code: cause instanceof Error && cause.name.length > 0 ? cause.name : "runtime.unknown-cause",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function platformCauseSnapshot(value: unknown): TransferRuntimeDiagnosticCause["platformCause"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.typeName !== "string") return undefined;
  return Object.freeze({
    typeName: record.typeName,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.code === "string" || typeof record.code === "number" ? { code: record.code } : {}),
    ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
  });
}

function diagnosticOwner(code: string): TransferRuntimeDiagnosticCause["owner"] {
  if (code.startsWith("transfer.")) return "transfer";
  if (code.startsWith("protocol.") || code.startsWith("session.")) return "protocol";
  if (code.startsWith("transport.")) return "transport";
  if (code.startsWith("manifest.")) return "manifest";
  if (code.startsWith("platform.")) return "platform";
  return "runtime";
}

function scalarDetails(value: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean",
  );
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}

function requireSafeInteger(
  value: number,
  path: string,
  options: { readonly positive?: boolean } = {},
): number {
  const minimum = options.positive === true ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw transferError(
      "transfer.declaration.invalid-integer",
      path,
      `${path} must be a ${options.positive === true ? "positive" : "non-negative"} safe integer`,
      { value },
    );
  }
  return value;
}

function checkedAdd(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw transferError(
      "transfer.range.not-explicit",
      path,
      `${path} exceeds the safe-integer range`,
      { left, right },
    );
  }
  return result;
}

function sameRange(left: TransferEffectiveRange, right: TransferEffectiveRange): boolean {
  return left.sourceOffset === right.sourceOffset
    && left.targetOffset === right.targetOffset
    && left.length === right.length;
}

function sameSelection(
  left: string | import("@protodriver/contracts").MessageSelector,
  right: string | import("@protodriver/contracts").MessageSelector,
): boolean {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : left.kind === right.kind && left.opcode === right.opcode;
}

function normalizeHex(value: string, path: string): string {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) {
    throw transferError(
      "transfer.verification.invalid-digest",
      path,
      `${path} must be nonempty lowercase hexadecimal`,
    );
  }
  return value;
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((octet) => octet.toString(16).padStart(2, "0")).join("");
}

async function reportedDigest(
  adapter: DeviceToHostTransferOptions["adapter"] | HostToDeviceTransferOptions["adapter"],
  verification: TransferVerificationContract,
  path: string,
): Promise<string> {
  const value = adapter.binding?.(verification.reportedBinding);
  if (!(value instanceof Uint8Array)) {
    throw transferError(
      "transfer.binding.unavailable",
      path,
      `reported digest binding ${JSON.stringify(verification.reportedBinding)} is unavailable after completion`,
    );
  }
  return bytesHex(value);
}

interface ValidatedDirection {
  readonly declaration: TransferDirectionContract;
  readonly effectiveChunkBytes: number;
  readonly sourceEnd: number;
  readonly targetEnd: number;
}

type TransferExecutionOptions = DeviceToHostTransferOptions | HostToDeviceTransferOptions;

function validateDirection(options: TransferExecutionOptions, directionName: "deviceToHost" | "hostToDevice" = "deviceToHost"): ValidatedDirection {
  const path = `transfers.${options.definition.id}.directions.${directionName}`;
  const declaration = options.definition.directions[directionName];
  if (declaration === null) {
    throw transferError(
      "transfer.direction.unavailable",
      path,
      `the transfer has no ${directionName} direction`,
    );
  }

  const dataPath = `${path}.data`;
  const sourceOffset = requireSafeInteger(declaration.data.sourceOffset, `${dataPath}.sourceOffset`);
  const targetOffset = requireSafeInteger(declaration.data.targetOffset, `${dataPath}.targetOffset`);
  const length = requireSafeInteger(declaration.data.length, `${dataPath}.length`, { positive: true });
  const maximumChunkBytes = requireSafeInteger(
    declaration.data.maximumChunkBytes,
    `${dataPath}.maximumChunkBytes`,
    { positive: true },
  );
  const alignmentBytes = requireSafeInteger(
    declaration.data.alignmentBytes,
    `${dataPath}.alignmentBytes`,
    { positive: true },
  );
  const maximumInFlight = requireSafeInteger(
    declaration.data.maximumInFlight,
    `${dataPath}.maximumInFlight`,
    { positive: true },
  );
  requireSafeInteger(
    declaration.data.maximumWaitMs,
    `${dataPath}.maximumWaitMs`,
    { positive: true },
  );
  if (typeof declaration.settlement.selection === "string" && declaration.settlement.selection.length === 0) {
    throw transferError(
      "transfer.settlement.selection-mismatch",
      `${path}.settlement.selection`,
      "the settlement selection reference must not be empty",
    );
  }
  if (declaration.data.action.length === 0) {
    throw transferError(
      "transfer.recipe.action-empty",
      `${dataPath}.action`,
      "the data action reference must not be empty",
    );
  }
  if (maximumInFlight > options.limits.maximumChunksInFlight) {
    throw transferError(
      "transfer.limit.chunks-in-flight",
      `${dataPath}.maximumInFlight`,
      "declared chunks in flight exceed the host envelope",
      { declared: maximumInFlight, envelope: options.limits.maximumChunksInFlight },
    );
  }
  const effectiveChunkBytes = maximumChunkBytes
    - (maximumChunkBytes % alignmentBytes);
  if (effectiveChunkBytes === 0
      || sourceOffset % alignmentBytes !== 0
      || targetOffset % alignmentBytes !== 0) {
    throw transferError(
      "transfer.data.alignment-invalid",
      dataPath,
      "the range start and at least one data chunk must satisfy the declared alignment",
      { sourceOffset, targetOffset, maximumChunkBytes, alignmentBytes },
    );
  }
  const windowBytes = effectiveChunkBytes * maximumInFlight;
  if (!Number.isSafeInteger(windowBytes)
      || windowBytes > options.limits.maximumTransferWindowBytes) {
    throw transferError(
      "transfer.limit.window-bytes",
      dataPath,
      "the declared transfer window exceeds the host envelope",
      { declared: windowBytes, envelope: options.limits.maximumTransferWindowBytes },
    );
  }

  requireSafeInteger(
    declaration.settlement.maximumWaitMs,
    `${path}.settlement.maximumWaitMs`,
    { positive: true },
  );
  requireSafeInteger(
    declaration.settlement.maximumObservations,
    `${path}.settlement.maximumObservations`,
    { positive: true },
  );
  for (const [phase, recipe] of [
    ["preparation", declaration.preparation],
    ["completion", declaration.completion],
  ] as const) {
    recipe.forEach((action, index) => {
      if (action.action.length === 0) {
        throw transferError(
          "transfer.recipe.action-empty",
          `${path}.${phase}.${index}.action`,
          "a recipe action reference must not be empty",
        );
      }
      requireSafeInteger(
        action.maximumWaitMs,
        `${path}.${phase}.${index}.maximumWaitMs`,
        { positive: true },
      );
      if (typeof action.destructive !== "boolean") {
        throw transferError(
          "transfer.recipe.destructive-not-declared",
          `${path}.${phase}.${index}.destructive`,
          "a recipe action must declare whether starting it may be destructive",
        );
      }
    });
  }
  declaration.verification.forEach((verification, index) => {
    requireSafeInteger(
      verification.maximumWaitMs,
      `${path}.verification.${index}.maximumWaitMs`,
      { positive: true },
    );
  });
  if (declaration.retry.kind !== "none") {
    throw transferError(
      "transfer.retry.not-admitted",
      `${path}.retry.kind`,
      "automatic transfer retry has no admitted policy",
    );
  }

  return {
    declaration,
    effectiveChunkBytes,
    sourceEnd: checkedAdd(sourceOffset, length, `${dataPath}.sourceOffset`),
    targetEnd: checkedAdd(targetOffset, length, `${dataPath}.targetOffset`),
  };
}

async function bounded<T>(
  options: TransferExecutionOptions,
  maximumWaitMs: number,
  path: string,
  operation: (signal: AbortSignal) => Promise<T>,
  policy: { readonly ignoreExternalAbort?: boolean } = {},
): Promise<T> {
  const external = options.signal;
  if (external?.aborted && policy.ignoreExternalAbort !== true) {
    throw external.reason ?? new DOMException("transfer aborted", "AbortError");
  }
  const controller = new AbortController();
  let rejectBoundary: ((reason: unknown) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const onExternalAbort = (): void => {
    const reason = external?.reason ?? new DOMException("transfer aborted", "AbortError");
    controller.abort(reason);
    rejectBoundary?.(reason);
  };
  if (policy.ignoreExternalAbort !== true) {
    external?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeout = options.clock.timer(maximumWaitMs, () => {
    const error = transferError(
      "transfer.settlement.timeout",
      path,
      `transfer work did not settle within ${maximumWaitMs} ms`,
      { maximumWaitMs },
    );
    controller.abort(error);
    rejectBoundary?.(error);
  });
  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    timeout.dispose();
    if (policy.ignoreExternalAbort !== true) {
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}

interface VerificationState {
  readonly declaration: TransferVerificationContract;
  readonly stream: TransferStreamingDigest | null;
  readonly offset: number | null;
  readonly length: number | null;
  observedBytes: number;
}

function createVerificationStates(
  options: TransferExecutionOptions,
  direction: TransferDirectionContract,
  directionName: "deviceToHost" | "hostToDevice",
  path: string,
): readonly VerificationState[] {
  const identifiers = new Set<string>();
  return direction.verification.map((verification, index) => {
    const verificationPath = `${path}.verification.${index}`;
    if (verification.id.length === 0 || identifiers.has(verification.id)) {
      throw transferError(
        "transfer.verification.id-invalid",
        `${verificationPath}.id`,
        `verification id ${JSON.stringify(verification.id)} must be nonempty and unique`,
      );
    }
    identifiers.add(verification.id);
    if (verification.authority !== "host-computed-device-confirmed"
        && verification.authority !== "device-reported") {
      throw transferError("transfer.verification.authority-invalid", `${verificationPath}.authority`, "verification authority is not declared");
    }
    let offset: number | null = null;
    let length: number | null = null;
    if (verification.domain === "transmitted") {
      if (verification.coverage.kind !== "complete-attempt-sequence") {
        throw transferError("transfer.verification.coverage-invalid", `${verificationPath}.coverage`, "transmitted verification must cover the complete attempt sequence");
      }
    } else {
      const domainOffset = verification.domain === "source" ? direction.data.sourceOffset : direction.data.targetOffset;
      if (verification.coverage.kind === "complete-effective-range") {
        offset = domainOffset;
        length = direction.data.length;
      } else if (verification.coverage.kind === "explicit-range") {
        offset = requireSafeInteger(verification.coverage.offset, `${verificationPath}.coverage.offset`);
        length = requireSafeInteger(verification.coverage.length, `${verificationPath}.coverage.length`, { positive: true });
        const coverageEnd = checkedAdd(offset, length, `${verificationPath}.coverage.length`);
        const domainEnd = checkedAdd(domainOffset, direction.data.length, `${path}.data.length`);
        if (verification.authority === "host-computed-device-confirmed"
            && (offset < domainOffset || coverageEnd > domainEnd)) {
          throw transferError("transfer.verification.coverage-invalid", `${verificationPath}.coverage`, "verification coverage lies outside its declared byte domain");
        }
      } else {
        throw transferError("transfer.verification.coverage-invalid", `${verificationPath}.coverage`, "source or target verification coverage is not declared");
      }
    }
    if (verification.authority === "host-computed-device-confirmed"
        && directionName === "hostToDevice"
        && verification.domain === "target") {
      throw transferError("transfer.verification.domain-unavailable", verificationPath, "host-to-device execution has no authoritative target-byte acquisition");
    }
    return {
      declaration: verification,
      stream: verification.authority === "host-computed-device-confirmed"
        ? options.digestProvider.create(verification.algorithm)
        : null,
      offset,
      length,
      observedBytes: 0,
    };
  });
}

function observeVerificationDomain(
  states: readonly VerificationState[],
  domain: TransferByteDomain,
  bytes: Uint8Array,
  offset?: number,
): void {
  for (const state of states) {
    if (state.stream === null || state.declaration.domain !== domain) continue;
    if (domain === "transmitted") {
      state.stream.update(bytes);
      state.observedBytes += bytes.byteLength;
      continue;
    }
    if (offset === undefined || state.offset === null || state.length === null) {
      throw new Error("positioned verification-domain observation invariant failed");
    }
    const start = Math.max(offset, state.offset);
    const end = Math.min(offset + bytes.byteLength, state.offset + state.length);
    if (end <= start) continue;
    state.stream.update(bytes.subarray(start - offset, end - offset));
    state.observedBytes += end - start;
  }
}

async function completeVerification(
  options: TransferExecutionOptions,
  states: readonly VerificationState[],
  path: string,
): Promise<readonly TransferVerificationResult[]> {
  const results: TransferVerificationResult[] = [];
  for (const [index, state] of states.entries()) {
    const verification = state.declaration;
    const verificationPath = `${path}.verification.${index}`;
    const reported = normalizeHex(
      await bounded(options, verification.maximumWaitMs, `${verificationPath}.reported`, () =>
        reportedDigest(options.adapter, verification, `${verificationPath}.reported`)),
      `${verificationPath}.reported`,
    );
    let value = reported;
    if (verification.authority === "host-computed-device-confirmed") {
      if (state.stream === null) throw new Error("host verification stream invariant failed");
      if (state.length !== null && state.observedBytes !== state.length) {
        throw transferError(
          "transfer.verification.coverage-invalid",
          `${verificationPath}.coverage`,
          "host observations did not cover the complete declared verification range",
          { expectedBytes: state.length, observedBytes: state.observedBytes },
        );
      }
      const computed = normalizeHex(await state.stream.digestHex(), `${verificationPath}.computed`);
      if (computed !== reported) {
        throw transferError(
          "transfer.verification.digest-mismatch",
          verificationPath,
          `${verification.domain} ${verification.algorithm} digest did not match the device report`,
          { computed, reported },
        );
      }
      value = computed;
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

/**
 * Streams one declared device-to-host range. The adapter admits carrier work;
 * this correlator advances only from direction-selected settlement records.
 */
export async function executeDeviceToHostTransfer(
  options: DeviceToHostTransferOptions,
): Promise<DeviceToHostTransferResult> {
  const validated = validateDirection(options);
  const { declaration } = validated;
  const path = `transfers.${options.definition.id}.directions.deviceToHost`;
  options.adapter.initializeBindings?.(Object.freeze(Object.fromEntries(
    (options.definition.bindings ?? []).flatMap((binding) => binding.initialize?.kind === "source-length"
      ? [[binding.name, declaration.data.length] as const]
      : []),
  )));

  for (const [index, action] of declaration.preparation.entries()) {
    await bounded(options, action.maximumWaitMs, `${path}.preparation.${index}`, (boundedSignal) =>
      options.adapter.executeRecipeAction(action, "preparation", boundedSignal));
  }

  const verificationStates = createVerificationStates(options, declaration, "deviceToHost", path);

  const inFlight = new Map<number, TransferAdmittedAction>();
  const pendingWrites = new Map<number, { readonly action: TransferAdmittedAction; readonly bytes: Uint8Array }>();
  let nextActionId = 1;
  let nextSourceOffset = declaration.data.sourceOffset;
  let nextTargetOffset = declaration.data.targetOffset;
  let nextWriteTargetOffset = declaration.data.targetOffset;
  let settledActions = 0;
  let admittedActions = 0;
  let observations = 0;
  let sourceCount = 0;
  let transmittedCount = 0;
  let targetCount = 0;

  const admitAvailable = async (): Promise<void> => {
    while (inFlight.size < declaration.data.maximumInFlight
        && nextSourceOffset < validated.sourceEnd) {
      const length = Math.min(
        validated.effectiveChunkBytes,
        validated.sourceEnd - nextSourceOffset,
      );
      const action: TransferAdmittedAction = {
        id: nextActionId,
        action: declaration.data.action,
        range: {
          sourceOffset: nextSourceOffset,
          targetOffset: nextTargetOffset,
          length,
        },
      };
      inFlight.set(action.id, action);
      await bounded(
        options,
        declaration.data.maximumWaitMs,
        `${path}.data`,
        (boundedSignal) => options.adapter.admit(
          action,
          boundedSignal,
          (bytes) => {
            observeVerificationDomain(verificationStates, "transmitted", bytes);
            transmittedCount += bytes.byteLength;
          },
        ),
      );
      admittedActions += 1;
      nextActionId += 1;
      nextSourceOffset += length;
      nextTargetOffset += length;
    }
  };

  await admitAvailable();
  while (inFlight.size > 0) {
    observations += 1;
    if (observations > declaration.settlement.maximumObservations) {
      throw transferError(
        "transfer.settlement.observation-bound",
        `${path}.settlement.maximumObservations`,
        "settlement exceeded its declared observation bound",
        { observations, maximumObservations: declaration.settlement.maximumObservations },
      );
    }
    const observation = await bounded(
      options,
      declaration.settlement.maximumWaitMs,
      `${path}.settlement`,
      (boundedSignal) => options.adapter.nextSettlement(
        declaration.settlement,
        boundedSignal,
      ),
    );
    if (observation.kind !== declaration.settlement.kind) {
      throw transferError(
        "transfer.settlement.kind-mismatch",
        `${path}.settlement.kind`,
        `expected ${declaration.settlement.kind}, received ${observation.kind}`,
      );
    }
    if (!sameSelection(observation.selection, declaration.settlement.selection)) {
      throw transferError(
        "transfer.settlement.selection-mismatch",
        `${path}.settlement.selection`,
        `expected ${declaration.settlement.selection}, received ${observation.selection}`,
      );
    }
    if (!("ranges" in observation)) {
      throw transferError("transfer.settlement.kind-mismatch", `${path}.settlement.kind`, "device-to-host settlement must carry admitted ranges");
    }
    if (observation.ranges.length === 0) {
      throw transferError(
        "transfer.settlement.empty",
        `${path}.settlement`,
        "a settlement observation must settle at least one admitted range",
      );
    }

    for (const settled of observation.ranges) {
      const action = inFlight.get(settled.actionId);
      if (action === undefined) {
        throw transferError(
          "transfer.settlement.action-not-in-flight",
          `${path}.settlement`,
          `settlement named action ${settled.actionId}, which is not in flight`,
          { actionId: settled.actionId },
        );
      }
      if (!sameRange(action.range, settled.range)) {
        throw transferError(
          "transfer.settlement.range-mismatch",
          `${path}.settlement`,
          `settlement for action ${settled.actionId} did not preserve its effective range`,
          { actionId: settled.actionId },
        );
      }
      if (settled.sourceBytes.byteLength !== action.range.length) {
        throw transferError(
          "transfer.settlement.data-length",
          `${path}.settlement`,
          `settlement for action ${settled.actionId} returned ${settled.sourceBytes.byteLength} source bytes for a ${action.range.length}-byte range`,
          { actionId: settled.actionId },
        );
      }
      if (pendingWrites.has(action.range.targetOffset)) {
        throw transferError(
          "transfer.settlement.duplicate",
          `${path}.settlement`,
          `target offset ${action.range.targetOffset} settled more than once`,
        );
      }
      pendingWrites.set(action.range.targetOffset, { action, bytes: settled.sourceBytes });
      inFlight.delete(action.id);
      settledActions += 1;
    }

    // Settlement frees carrier capacity. Refill it before ordered verification
    // and sink work so downstream consumption cannot serialize admissions.
    await admitAvailable();
    while (true) {
      const pending = pendingWrites.get(nextWriteTargetOffset);
      if (pending === undefined) break;
      observeVerificationDomain(verificationStates, "source", pending.bytes, pending.action.range.sourceOffset);
      sourceCount += pending.bytes.byteLength;
      await options.sink.write(pending.bytes);
      observeVerificationDomain(verificationStates, "target", pending.bytes, pending.action.range.targetOffset);
      targetCount += pending.bytes.byteLength;
      pendingWrites.delete(nextWriteTargetOffset);
      nextWriteTargetOffset += pending.bytes.byteLength;
    }
  }

  if (settledActions !== admittedActions
      || pendingWrites.size !== 0
      || nextWriteTargetOffset !== validated.targetEnd) {
    throw transferError(
      "transfer.read.incomplete",
      `${path}.data`,
      "the device-to-host transfer ended without a complete target range",
      { admittedActions, settledActions, targetBytes: targetCount },
    );
  }

  for (const [index, action] of declaration.completion.entries()) {
    await bounded(options, action.maximumWaitMs, `${path}.completion.${index}`, (boundedSignal) =>
      options.adapter.executeRecipeAction(action, "completion", boundedSignal));
  }

  const verification = await completeVerification(options, verificationStates, path);

  return Object.freeze({
    direction: "deviceToHost" as const,
    counts: Object.freeze({
      source: sourceCount,
      transmitted: transmittedCount,
      target: targetCount,
    }),
    verification,
  });
}

async function readExactSource(
  source: HostToDeviceTransferOptions["source"],
  length: number,
  maximumChunkBytes: number,
  path: string,
): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = output.subarray(offset, Math.min(length, offset + maximumChunkBytes));
    const result = await source.read(chunk);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > chunk.byteLength) {
      throw transferError("transfer.write.source-incomplete", path, "byte source returned an invalid byte count");
    }
    offset += result.bytesRead;
    if (result.eof && offset !== length) {
      throw transferError("transfer.write.source-incomplete", path, `byte source ended after ${offset} of ${length} octets`, { expected: length, actual: offset });
    }
    if (result.bytesRead === 0 && !result.eof) {
      throw transferError("transfer.write.source-incomplete", path, "byte source made no progress before EOF");
    }
  }
  return output;
}

async function hashExactSource(
  source: HostToDeviceTransferOptions["source"],
  length: number,
  maximumChunkBytes: number,
  digest: TransferStreamingDigest,
  path: string,
): Promise<string> {
  let offset = 0;
  while (offset < length) {
    const chunk = new Uint8Array(Math.min(maximumChunkBytes, length - offset));
    const result = await source.read(chunk);
    if (!Number.isSafeInteger(result.bytesRead)
        || result.bytesRead < 0
        || result.bytesRead > chunk.byteLength) {
      throw transferError("transfer.write.source-incomplete", path, "byte source returned an invalid byte count while hashing");
    }
    if (result.bytesRead > 0) digest.update(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
    if (result.eof && offset !== length) {
      throw transferError("transfer.write.source-incomplete", path, `byte source ended after ${offset} of ${length} octets while hashing`, { expected: length, actual: offset });
    }
    if (result.bytesRead === 0 && !result.eof) {
      throw transferError("transfer.write.source-incomplete", path, "byte source made no progress while hashing");
    }
  }
  return normalizeHex(await digest.digestHex(), `${path}.digest`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

/** Guarded byte-range write. The exact-current comparison precedes the first admitted write. */
export async function executeHostToDeviceTransfer(
  options: HostToDeviceTransferOptions,
): Promise<HostToDeviceTransferResult> {
  const validated = validateDirection(options, "hostToDevice");
  const { declaration } = validated;
  const path = `transfers.${options.definition.id}.directions.hostToDevice`;
  const signal = options.signal ?? new AbortController().signal;

  const engineBindings: Record<string, number | Uint8Array> = Object.fromEntries(Object.entries(options.initialBindings ?? {}).map(([name, value]) => [name, value instanceof Uint8Array ? Uint8Array.from(value) : value]));
  const freshlyHashedSourceBindings = new Map<string, Uint8Array>();
  for (const [index, binding] of (options.definition.bindings ?? []).entries()) {
    if (Object.hasOwn(engineBindings, binding.name)) continue;
    if (binding.initialize?.kind === "source-length") {
      engineBindings[binding.name] = declaration.data.length;
      continue;
    }
    if (binding.initialize?.kind !== "source-digest") continue;
    if (options.source.seek === undefined) {
      throw transferError("transfer.range.not-explicit", `${path}.bindings.${index}`, "source-digest binding requires a seekable byte source");
    }
    await options.source.seek(declaration.data.sourceOffset);
    const value = await hashExactSource(
      options.source,
      declaration.data.length,
      options.limits.maximumResourceChunkBytes,
      options.digestProvider.create(binding.initialize.algorithm),
      `${path}.bindings.${index}`,
    );
    const digestBytes = Uint8Array.from(value.match(/../gu)!.map((octet) => Number.parseInt(octet, 16)));
    engineBindings[binding.name] = digestBytes;
    freshlyHashedSourceBindings.set(binding.name, digestBytes);
  }
  options.adapter.initializeBindings?.(Object.freeze(engineBindings));
  const initializedSourceDigests = (options.definition.bindings ?? []).flatMap((binding) => {
    if (binding.initialize?.kind !== "source-digest") return [];
    const value = freshlyHashedSourceBindings.get(binding.name);
    if (value === undefined) return [];
    return [{
      binding: binding.name,
      expected: bytesHex(value),
      stream: options.digestProvider.create(binding.initialize.algorithm),
    }];
  });

  const expectedSourceDigest = options.expectedSourceDigest === undefined
    ? undefined
    : {
        algorithm: options.expectedSourceDigest.algorithm,
        value: normalizeHex(options.expectedSourceDigest.value, `${path}.expectedSourceDigest.value`),
      };
  const admittedSourceDigest = expectedSourceDigest === undefined
    ? undefined
    : options.digestProvider.create(expectedSourceDigest.algorithm);
  const verificationStates = createVerificationStates(options, declaration, "hostToDevice", path);

  if (expectedSourceDigest !== undefined) {
    if (options.source.seek === undefined) {
      throw transferError(
        "transfer.range.not-explicit",
        `${path}.expectedSourceDigest`,
        "pre-move source identity requires a seekable byte source",
      );
    }
    await options.source.seek(declaration.data.sourceOffset);
    const prehash = await hashExactSource(
      options.source,
      declaration.data.length,
      options.limits.maximumResourceChunkBytes,
      options.digestProvider.create(expectedSourceDigest.algorithm),
      `${path}.expectedSourceDigest.prehash`,
    );
    if (prehash !== expectedSourceDigest.value) {
      throw transferError(
        "transfer.verification.source-changed",
        `${path}.expectedSourceDigest`,
        "source prehash does not match the caller-supplied digest; no device work was admitted",
        { expected: expectedSourceDigest.value, actual: prehash, stage: "prehash" },
      );
    }
  }

  const wholeRange: TransferEffectiveRange = {
    sourceOffset: declaration.data.sourceOffset,
    targetOffset: declaration.data.targetOffset,
    length: declaration.data.length,
  };
  if (options.expectedCurrent !== undefined) {
    if (options.expectedCurrent.seek !== undefined) await options.expectedCurrent.seek(0);
    const expected = await readExactSource(
      options.expectedCurrent,
      declaration.data.length,
      options.limits.maximumResourceChunkBytes,
      `${path}.expectedCurrent`,
    );
    const current = await bounded(options, declaration.data.maximumWaitMs, `${path}.expectedCurrent`, (boundedSignal) =>
      options.adapter.readTarget(wholeRange, boundedSignal));
    if (!bytesEqual(current, expected)) {
      throw transferError(
        "transfer.write.expected-current-mismatch",
        `${path}.expectedCurrent`,
        "fresh target bytes do not equal the caller-supplied expected-current value",
        { expectedBytes: expected.byteLength, actualBytes: current.byteLength },
      );
    }
  }

  // Keep the recipe's declared order intact, but never let preparation—whose
  // declaration may itself be destructive—run before the optimistic guard.
  for (const [index, action] of declaration.preparation.entries()) {
    await bounded(options, action.maximumWaitMs, `${path}.preparation.${index}`, (boundedSignal) =>
      options.adapter.executeRecipeAction(action, "preparation", boundedSignal));
  }
  await options.checkpoint?.phase("prepared");
  await options.checkpoint?.phase("transferring");

  if (options.source.seek !== undefined) await options.source.seek(declaration.data.sourceOffset);
  else if (declaration.data.sourceOffset !== 0) {
    throw transferError("transfer.range.not-explicit", `${path}.data.sourceOffset`, "nonzero source offset requires a seekable ByteSource");
  }
  const inFlight = new Map<number, {
    readonly action: TransferAdmittedAction;
    readonly bytes: Uint8Array;
    confirmedBytes: number;
  }>();
  let nextActionId = 1;
  let nextOffset = 0;
  let transmittedCount = 0;
  let settledCount = 0;
  let observations = 0;
  let cancellationObserved = signal.aborted;
  let partialSettlements = 0;
  let durableSourceOffset = declaration.data.sourceOffset;
  let durableTargetOffset = declaration.data.targetOffset;
  const pendingTargetDigests = new Map<number, Uint8Array>();
  let nextTargetDigestOffset = declaration.data.targetOffset;

  const admitPending = async (pending: {
    readonly action: TransferAdmittedAction;
    readonly bytes: Uint8Array;
  }): Promise<void> => {
    try {
      await bounded(options, declaration.data.maximumWaitMs, `${path}.data`, (boundedSignal) =>
        options.adapter.admit(
          pending.action,
          pending.bytes,
          boundedSignal,
          (bytes) => {
            observeVerificationDomain(verificationStates, "transmitted", bytes);
            transmittedCount += bytes.byteLength;
          },
        ));
    } catch (cause) {
      if (signal.aborted) {
        cancellationObserved = true;
        return;
      }
      throw cause;
    }
  };

  const admitAvailable = async (): Promise<void> => {
    while (inFlight.size < declaration.data.maximumInFlight && nextOffset < declaration.data.length) {
      if (signal.aborted) {
        cancellationObserved = true;
        break;
      }
      const length = Math.min(validated.effectiveChunkBytes, declaration.data.length - nextOffset);
      const bytes = await readExactSource(
        options.source,
        length,
        Math.min(length, options.limits.maximumResourceChunkBytes),
        `${path}.source`,
      );
      const action: TransferAdmittedAction = {
        id: nextActionId++,
        action: declaration.data.action,
        range: {
          sourceOffset: declaration.data.sourceOffset + nextOffset,
          targetOffset: declaration.data.targetOffset + nextOffset,
          length,
        },
      };
      admittedSourceDigest?.update(bytes);
      for (const authority of initializedSourceDigests) authority.stream.update(bytes);
      observeVerificationDomain(verificationStates, "source", bytes, action.range.sourceOffset);
      const pending = { action, bytes, confirmedBytes: 0 };
      inFlight.set(action.id, pending);
      await admitPending(pending);
      nextOffset += length;
      if (cancellationObserved) break;
    }
  };

  await admitAvailable();
  while (inFlight.size > 0) {
    observations += 1;
    if (observations > declaration.settlement.maximumObservations) {
      throw transferError("transfer.settlement.observation-bound", `${path}.settlement.maximumObservations`, "write settlement exceeded its declared observation bound");
    }
    let observation: TransferSettlementObservation;
    try {
      observation = await bounded(
        options,
        declaration.settlement.maximumWaitMs,
        `${path}.settlement`,
        (boundedSignal) => options.adapter.nextSettlement(declaration.settlement, boundedSignal),
        { ignoreExternalAbort: cancellationObserved || signal.aborted },
      );
    } catch (cause) {
      if (cancellationObserved || signal.aborted) {
        throw transferError(
          "transfer.cancelled.failed-mid-write",
          `${path}.settlement`,
          "cancellation could not settle every admitted range within the declared boundary",
          { confirmedActions: settledCount, unresolvedActions: inFlight.size },
        );
      }
      if (cause instanceof TransferRuntimeError
          && cause.diagnostic.code === "transfer.settlement.timeout"
          && declaration.settlement.kind === "cumulative-prefix-report"
          && declaration.resume?.kind === "durable-reported-offset") {
        throw transferError(
          "transfer.resume.required-after-settlement-timeout",
          `${path}.settlement`,
          "cumulative durable progress stopped within its declared wait; replacement-connection resume is required",
          { confirmedActions: settledCount, unresolvedActions: inFlight.size, committedSourceOffset: durableSourceOffset },
          immediateCause(cause),
        );
      }
      throw cause;
    }
    if (observation.kind !== declaration.settlement.kind || !sameSelection(observation.selection, declaration.settlement.selection)) {
      throw transferError("transfer.settlement.kind-mismatch", `${path}.settlement`, "write settlement did not match the direction declaration");
    }
    if ("offset" in observation) {
      if (declaration.settlement.kind !== "cumulative-prefix-report"
          || observation.domain !== declaration.settlement.domain) {
        throw transferError("transfer.settlement.prefix-domain-mismatch", `${path}.settlement.domain`, "cumulative prefix byte domain does not match the direction declaration");
      }
      const base = observation.domain === "source" ? declaration.data.sourceOffset : declaration.data.targetOffset;
      const durable = observation.domain === "source" ? durableSourceOffset : durableTargetOffset;
      if (!Number.isSafeInteger(observation.offset) || observation.offset < durable) {
        throw transferError("transfer.settlement.prefix-regressed", `${path}.settlement`, "cumulative durable prefix regressed", { previous: durable, reported: observation.offset });
      }
      const advance = observation.offset - durable;
      if (advance > 0) {
        const sourceStart = durableSourceOffset;
        const targetStart = durableTargetOffset;
        let remaining = advance;
        const ordered = [...inFlight.values()].sort((left, right) => left.action.range.sourceOffset - right.action.range.sourceOffset);
        for (const pending of ordered) {
          if (remaining === 0) break;
          const available = pending.action.range.length - pending.confirmedBytes;
          const count = Math.min(available, remaining);
          if (count === 0) continue;
          pending.confirmedBytes += count;
          remaining -= count;
          if (pending.confirmedBytes === pending.action.range.length) {
            inFlight.delete(pending.action.id);
            settledCount += 1;
          }
        }
        if (remaining !== 0) {
          throw transferError(
            "transfer.settlement.prefix-unadmitted",
            `${path}.settlement`,
            "cumulative prefix cannot be mapped through the admitted range sequence",
            { admittedHorizon: base + nextOffset, reported: observation.offset },
          );
        }
        durableSourceOffset += advance;
        durableTargetOffset += advance;
        nextTargetDigestOffset = durableTargetOffset;
        const exact: TransferEffectiveRange = { sourceOffset: sourceStart, targetOffset: targetStart, length: advance };
        const recorded = await options.checkpoint?.confirmed(exact);
        if (recorded !== undefined && !sameRange(recorded, exact)) {
          throw transferError(
            "transfer.settlement.checkpoint-rounded",
            `${path}.settlement`,
            "checkpoint did not preserve the exact cumulative durable prefix",
            { expectedLength: exact.length, recordedLength: recorded.length },
          );
        }
      }
    } else {
      if (observation.ranges.length === 0) throw transferError("transfer.settlement.empty", `${path}.settlement`, "write settlement contained no ranges");
      for (const settled of observation.ranges) {
        const pending = inFlight.get(settled.actionId);
        if (pending === undefined || !sameRange(pending.action.range, settled.range)) {
          throw transferError("transfer.settlement.range-mismatch", `${path}.settlement`, "write settlement names no matching admitted range");
        }
        if (!bytesEqual(settled.sourceBytes, pending.bytes)) {
          throw transferError("transfer.settlement.data-length", `${path}.settlement`, "write settlement source bytes differ from the admitted source");
        }
        if (settled.status === "may-be-partial") partialSettlements += 1;
        pendingTargetDigests.set(settled.range.targetOffset, pending.bytes);
        while (true) {
          const targetBytes = pendingTargetDigests.get(nextTargetDigestOffset);
          if (targetBytes === undefined) break;
          pendingTargetDigests.delete(nextTargetDigestOffset);
          nextTargetDigestOffset += targetBytes.byteLength;
        }
        inFlight.delete(settled.actionId);
        settledCount += 1;
        if (settled.status !== "may-be-partial") await options.checkpoint?.confirmed(settled.range);
        durableSourceOffset = Math.max(durableSourceOffset, settled.range.sourceOffset + settled.range.length);
        durableTargetOffset = Math.max(durableTargetOffset, settled.range.targetOffset + settled.range.length);
      }
    }
    if (signal.aborted) cancellationObserved = true;
    if (!cancellationObserved) await admitAvailable();
  }

  if (cancellationObserved) {
    if (partialSettlements > 0) {
      throw transferError(
        "transfer.cancelled.failed-mid-write",
        `${path}.settlement`,
        "cancellation settled a range as may-be-partial",
        { confirmedActions: settledCount - partialSettlements, unresolvedActions: partialSettlements },
      );
    }
    if (declaration.cancellation !== undefined) {
      if (options.adapter.connectionUsable !== true || options.adapter.executeCancellation === undefined) {
        throw transferError(
          "transfer.cancellation.skipped-dead-link",
          `${path}.cancellation`,
          "device-side cancellation was skipped because the connection is not usable; checkpoint retained",
          { confirmedActions: settledCount },
        );
      }
      try {
        await bounded(options, declaration.cancellation.maximumWaitMs, `${path}.cancellation`, (boundedSignal) =>
          options.adapter.executeCancellation!(declaration.cancellation!, boundedSignal), { ignoreExternalAbort: true });
        if (declaration.cancellation.retireCheckpointOnSuccess) await options.checkpoint?.retire?.();
      } catch (cause) {
        throw transferError(
          "transfer.cancellation.failed",
          `${path}.cancellation`,
          `device-side cancellation failed; checkpoint retained: ${cause instanceof Error ? cause.message : String(cause)}`,
          { confirmedActions: settledCount },
        );
      }
    }
    throw transferError(
      "transfer.cancelled",
      `${path}.data`,
      "cancellation stopped admission and every admitted range settled",
      { confirmedActions: settledCount, unresolvedActions: 0 },
    );
  }
  if (partialSettlements > 0) {
    throw transferError(
      "transfer.write.indeterminate",
      `${path}.settlement`,
      "a settled range remains may-be-partial",
      { confirmedActions: settledCount - partialSettlements, unresolvedActions: partialSettlements },
    );
  }

  if (expectedSourceDigest !== undefined && admittedSourceDigest !== undefined) {
    const actual = normalizeHex(
      await admittedSourceDigest.digestHex(),
      `${path}.expectedSourceDigest.actual`,
    );
    if (actual !== expectedSourceDigest.value) {
      throw transferError(
        "transfer.verification.source-changed",
        `${path}.expectedSourceDigest`,
        "bytes read for admission do not match the caller-supplied source digest",
        { expected: expectedSourceDigest.value, actual },
      );
    }
  }
  for (const authority of initializedSourceDigests) {
    const actual = normalizeHex(await authority.stream.digestHex(), `${path}.bindings.${authority.binding}.actual`);
    if (actual !== authority.expected) {
      throw transferError(
        "transfer.verification.source-changed",
        `${path}.bindings.${authority.binding}`,
        "bytes read for admission do not match the source digest supplied to preparation",
        { expected: authority.expected, actual },
      );
    }
  }

  await options.checkpoint?.phase("verifying");

  if (pendingTargetDigests.size !== 0
      || nextTargetDigestOffset !== declaration.data.targetOffset + declaration.data.length) {
    throw transferError(
      "transfer.write.indeterminate",
      `${path}.verification`,
      "confirmed target bytes do not form the complete declared range",
    );
  }

  // The streamed source authority is complete before finalization, but a
  // protocol finalizer may be the action which produces reported digests.
  if (declaration.completion.length > 0) await options.checkpoint?.phase("finalizing");
  for (const [index, action] of declaration.completion.entries()) {
    await bounded(options, action.maximumWaitMs, `${path}.completion.${index}`, (boundedSignal) =>
      options.adapter.executeRecipeAction(action, "completion", boundedSignal));
  }

  const verification = await completeVerification(options, verificationStates, path);

  return Object.freeze({
    direction: "hostToDevice" as const,
    counts: Object.freeze({ source: declaration.data.length, transmitted: transmittedCount, target: declaration.data.length }),
    settledActions: settledCount,
    verification,
    outcome: "completed" as const,
  });
}

/** Phase-aware wrapper used by workflows which must report honest destructive uncertainty. */
export async function executeHostToDeviceTransferOutcome(
  options: HostToDeviceTransferOptions,
): Promise<HostToDeviceTransferOutcome> {
  let destructiveActions = 0;
  const adapter = {
    ...(options.adapter.initializeBindings === undefined ? {} : { initializeBindings: options.adapter.initializeBindings.bind(options.adapter) }),
    executeRecipeAction: async (
      action: TransferRecipeActionContract,
      phase: "preparation" | "completion",
      signal: AbortSignal,
    ): Promise<void> => {
      if (action.destructive) destructiveActions += 1;
      await options.adapter.executeRecipeAction(action, phase, signal);
    },
    readTarget: options.adapter.readTarget.bind(options.adapter),
    admit: async (action: TransferAdmittedAction, bytes: Uint8Array, signal: AbortSignal, observeTransmitted: (bytes: Uint8Array) => void): Promise<void> => {
      destructiveActions += 1;
      await options.adapter.admit(action, bytes, signal, observeTransmitted);
    },
    nextSettlement: options.adapter.nextSettlement.bind(options.adapter),
    ...(options.adapter.binding === undefined ? {} : { binding: options.adapter.binding.bind(options.adapter) }),
    ...(options.adapter.executeCancellation === undefined ? {} : { executeCancellation: options.adapter.executeCancellation.bind(options.adapter) }),
    get connectionUsable(): boolean { return options.adapter.connectionUsable ?? false; },
  };
  try {
    return await executeHostToDeviceTransfer({ ...options, adapter });
  } catch (cause) {
    const diagnostic = cause instanceof TransferRuntimeError
      ? cause.diagnostic
      : {
          code: "transfer.write.indeterminate" as const,
          declarationPath: `transfers.${options.definition.id}.directions.hostToDevice`,
          message: cause instanceof Error ? cause.message : String(cause),
          cause: immediateCause(cause),
        };
    const confirmedActions = typeof diagnostic.details?.confirmedActions === "number"
      ? diagnostic.details.confirmedActions
      : 0;
    const unresolvedActions = typeof diagnostic.details?.unresolvedActions === "number"
      ? diagnostic.details.unresolvedActions
      : 0;
    if (diagnostic.code === "transfer.cancelled") {
      return Object.freeze({
        direction: "hostToDevice",
        outcome: "cancelled",
        confirmedActions,
        cause: diagnostic,
      });
    }
    if (diagnostic.code === "transfer.cancelled.failed-mid-write") {
      return Object.freeze({
        direction: "hostToDevice",
        outcome: "failed-mid-write",
        confirmedActions,
        unresolvedActions,
        cause: diagnostic,
      });
    }
    if (diagnostic.code === "transfer.resume.required-after-settlement-timeout") {
      return Object.freeze({
        direction: "hostToDevice",
        outcome: "resume-required",
        confirmedActions,
        unresolvedActions,
        cause: diagnostic,
      });
    }
    return destructiveActions === 0
      ? Object.freeze({ direction: "hostToDevice", outcome: "failed-before-destructive-work", cause: diagnostic })
      : Object.freeze({ direction: "hostToDevice", outcome: "indeterminate-after-destructive-work", destructiveActions, cause: diagnostic });
  }
}
