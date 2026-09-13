import type { BrowserLoadedDevice } from "./browser-device-admission.ts";

interface PackageLoadDependencies {
  readonly loadDeviceBytes: (bytes: Uint8Array) => Promise<BrowserLoadedDevice>;
  readonly remember: (bytes: Uint8Array) => Promise<number>;
  readonly refreshRemembered: (preferredId: number) => Promise<void>;
  readonly setRememberedStatus: (message: string) => void;
  readonly reportRememberError: (cause: unknown) => void;
}

// File imports and catalog selections both enter this same admission and
// remembering step. A storage error does not undo a successfully loaded device.
export async function loadAndRememberPackage(bytes: Uint8Array, dependencies: PackageLoadDependencies): Promise<void> {
  const admitted = await dependencies.loadDeviceBytes(bytes);
  if (admitted.admission.kind !== "pdpkg") return;
  try {
    const id = await dependencies.remember(bytes);
    await dependencies.refreshRemembered(id);
    dependencies.setRememberedStatus(`Remembered as package ${id}.`);
  } catch (cause) {
    dependencies.reportRememberError(cause);
  }
}
