import type { PdrError, SessionId } from "@protodriver/contracts";
import type { BrowserLoadedDevice } from "./browser-device-admission.ts";

export interface BrowserSessionWorkerBootstrapRequest {
  readonly kind: "bootstrap";
  /** Clone-safe opt-in to the existing chooser/grant/candidate acquisition boundary. */
  readonly authoredAcquisition: { readonly kind: "permission-broker-v1" };
  readonly deviceBytes: Uint8Array;
  readonly sessionId: SessionId;
  readonly sessionPort: MessagePort;
  readonly resourcePort: MessagePort;
  readonly capturePort: MessagePort;
  readonly captureLimits: {
    readonly maximumCaptureQueueBytes: number;
    readonly maximumCaptureInMemoryBytes: number;
  };
}

export type BrowserSessionWorkerBootstrapResponse =
  | { readonly kind: "bootstrap-ready"; readonly loaded: BrowserLoadedDevice }
  | { readonly kind: "bootstrap-error"; readonly error: PdrError };

export type BrowserSessionWorkerBootstrapMessage =
  | BrowserSessionWorkerBootstrapRequest
  | BrowserSessionWorkerBootstrapResponse;
