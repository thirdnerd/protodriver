import { PostMessageCaptureDestinationRpcAdapter } from "@protodriver/core/capture-rpc";
import { PostMessageResourceRpcAdapter, ResourceBrokerRpcClient } from "@protodriver/core/resources";
import { serveSessionRpc } from "@protodriver/core/rpc";

import type {
  BrowserSessionWorkerBootstrapMessage,
  BrowserSessionWorkerBootstrapRequest,
} from "./session-worker-bootstrap.ts";
import {
  serializeWorkerError,
  type WorkerWebSerialApi,
  type WorkerWebUsbApi,
} from "./session-worker-host.ts";
import { BrowserTransferCheckpointStore } from "./transfer-checkpoints.ts";
import { createBrowserSessionRuntime } from "./session-runtime.ts";

interface DedicatedWorkerScope {
  readonly navigator: Navigator;
  postMessage(message: BrowserSessionWorkerBootstrapMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<BrowserSessionWorkerBootstrapMessage>) => void): void;
}

const worker = self as unknown as DedicatedWorkerScope;
let bootstrapped = false;

worker.addEventListener("message", ({ data }) => {
  if (data.kind !== "bootstrap" || bootstrapped) return;
  bootstrapped = true;
  void bootstrap(data);
});

async function bootstrap(request: BrowserSessionWorkerBootstrapRequest): Promise<void> {
  const serial = (worker.navigator as Navigator & { readonly serial?: WorkerWebSerialApi }).serial;
  const usb = (worker.navigator as Navigator & { readonly usb?: WorkerWebUsbApi }).usb;
  const resourceAdapter = new PostMessageResourceRpcAdapter(request.resourcePort);
  const captureAdapter = new PostMessageCaptureDestinationRpcAdapter(request.capturePort);
  const host = createBrowserSessionRuntime({
    authoredAcquisitionBinding: request.authoredAcquisition,
    ...(serial === undefined ? {} : { serial }),
    ...(usb === undefined ? {} : { usb }),
    checkpointStore: new BrowserTransferCheckpointStore(indexedDB, worker.navigator.locks),
    resourceBroker: new ResourceBrokerRpcClient(resourceAdapter),
    captureDestinationAdapter: captureAdapter,
    captureLimits: request.captureLimits,
  });
  try {
    const loaded = await host.admission.admit(request.deviceBytes);
    serveSessionRpc(request.sessionPort, host.server);
    worker.postMessage({ kind: "bootstrap-ready", loaded });
  } catch (cause) {
    await resourceAdapter.close().catch(() => undefined);
    await captureAdapter.close().catch(() => undefined);
    worker.postMessage({ kind: "bootstrap-error", error: serializeWorkerError(cause) });
  }
}
