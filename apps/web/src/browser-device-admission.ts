import type { LuaSourceSetIdentity } from "@protodriver/contracts";

/** Admission result sent once while the worker is bootstrapped, before session RPC starts. */
export interface BrowserLoadedDevice {
  readonly authored: {
    readonly model: ReturnType<typeof import("@protodriver/control-model").generateAuthoredControlModel>;
    readonly hostGrant: { readonly modeId: string; readonly profileId: string } | null;
  };
  readonly profiles: readonly BrowserWorkerProfile[];
  readonly admission: {
    readonly kind: "pdpkg";
    readonly generatorContract: 2;
    readonly sourceSetIdentity: LuaSourceSetIdentity;
    readonly executionIdentity: string;
    readonly publicDescriptionHash: string;
  };
}

export interface BrowserWorkerProfile {
  readonly modeId: string;
  readonly profileId: string;
  readonly transport: "serial" | "usb";
  readonly supported: boolean;
  readonly rawTerminal:
    | { readonly kind: "available"; readonly channelId: string }
    | { readonly kind: "unavailable"; readonly reason: string };
  readonly acquisitionFilters: readonly {
    readonly vendorId?: number;
    readonly productId?: number;
    readonly usbClass?: number;
  }[];
}
