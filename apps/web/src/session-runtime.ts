import { BrowserSessionWorkerHost } from "./session-worker-host.ts";
import type { SessionRpcServer } from "@protodriver/core/rpc";

/** Application composition root. Generated controls receive only the client. */
export function createBrowserSessionRuntime(
  options: ConstructorParameters<typeof BrowserSessionWorkerHost>[0],
): { admission: BrowserSessionWorkerHost; server: SessionRpcServer } {
  const admission = new BrowserSessionWorkerHost(options);
  return { admission, server: admission };
}
