import type {
  SerialLineParameters,
  SerialProtocolDuplex,
  SerialProfileLifecyclePolicy,
  SerialProfilePolicyDiagnostic,
} from "@protodriver/contracts";

export class SerialProfilePolicyError extends Error {
  readonly diagnostic: SerialProfilePolicyDiagnostic;

  constructor(diagnostic: SerialProfilePolicyDiagnostic) {
    super(diagnostic.message);
    this.name = "SerialProfilePolicyError";
    this.diagnostic = diagnostic;
  }
}

/** Fail closed before a serial adapter touches a native or browser port. */
export function validateSerialProfilePolicy(
  line: SerialLineParameters,
  lifecycle: SerialProfileLifecyclePolicy,
  protocolDuplex: SerialProtocolDuplex,
  declarationPath = "$open",
): void {
  if (!Number.isSafeInteger(line.baudRate) || line.baudRate <= 0 || line.baudRate > 0xffff_ffff
    || !([7, 8] as const).includes(line.dataBits)
    || !(["none", "even", "odd"] as const).includes(line.parity)
    || !([1, 2] as const).includes(line.stopBits)
    || !(["none", "hardware"] as const).includes(line.flowControl)) {
    fail(
      "transport.serial.invalid-line-parameters",
      `${declarationPath}.line`,
      "serial line parameters must belong to the declared standard domains",
    );
  }
  if (!("half-duplex" === protocolDuplex || "full-duplex" === protocolDuplex)) {
    fail(
      "transport.serial.invalid-protocol-duplex",
      `${declarationPath}.protocolDuplex`,
      "serial protocol duplex must belong to the closed declared domain",
    );
  }
  if (!Number.isSafeInteger(lifecycle.openingDrainQuietMs)
    || lifecycle.openingDrainQuietMs < 0) {
    fail(
      "transport.serial.invalid-opening-drain",
      `${declarationPath}.lifecycle.openingDrainQuietMs`,
      "opening drain quiet time must be a non-negative safe integer",
    );
  }
  const silence = lifecycle.postTerminationSilence;
  if (!Number.isSafeInteger(silence.minimumMs) || silence.minimumMs < 0
    || (silence.minimumMs === 0 && (silence.afterAbnormalTermination || silence.afterModeExit))
    || (silence.minimumMs > 0 && !silence.afterAbnormalTermination && !silence.afterModeExit)) {
    fail(
      "transport.serial.invalid-post-termination-silence",
      `${declarationPath}.lifecycle.postTerminationSilence`,
      "post-termination silence needs a non-negative bound and causes consistent with whether the bound is zero",
    );
  }
}

export function postTerminationSilenceMs(
  lifecycle: SerialProfileLifecyclePolicy,
  terminationKind: "closed-by-host" | "abnormal",
): number {
  const silence = lifecycle.postTerminationSilence;
  const applies = terminationKind === "closed-by-host"
    ? silence.afterModeExit
    : silence.afterAbnormalTermination;
  return applies ? silence.minimumMs : 0;
}

function fail(
  code: SerialProfilePolicyDiagnostic["code"],
  declarationPath: string,
  message: string,
): never {
  throw new SerialProfilePolicyError({ code, declarationPath, message });
}
