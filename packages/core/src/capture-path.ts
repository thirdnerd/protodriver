export type CapturePartNameRule =
  | "length"
  | "character-set"
  | "leading-dot"
  | "trailing-dot"
  | "reserved-device";

export class CapturePartNameError extends Error {
  readonly rule: CapturePartNameRule;

  constructor(name: string, rule: CapturePartNameRule) {
    super(`capture part name ${JSON.stringify(name)} rejected by ${rule} rule`);
    this.name = "CapturePartNameError";
    this.rule = rule;
  }
}

const MAX_CAPTURE_PART_NAME_LENGTH = 255;
const PORTABLE_CAPTURE_PART_NAME = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** The canonical, backend-independent leaf-name language used by every destination. */
export function assertCapturePartName(name: string): void {
  if (name.length === 0 || name.length > MAX_CAPTURE_PART_NAME_LENGTH) {
    throw new CapturePartNameError(name, "length");
  }
  if (!PORTABLE_CAPTURE_PART_NAME.test(name)) {
    throw new CapturePartNameError(name, "character-set");
  }
  if (name.startsWith(".")) {
    throw new CapturePartNameError(name, "leading-dot");
  }
  if (name.endsWith(".")) {
    throw new CapturePartNameError(name, "trailing-dot");
  }
  const basename = name.split(".", 1)[0];
  if (basename !== undefined && WINDOWS_RESERVED_DEVICE.test(basename)) {
    throw new CapturePartNameError(name, "reserved-device");
  }
}
