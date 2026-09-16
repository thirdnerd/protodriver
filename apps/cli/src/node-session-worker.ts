import { workerData } from "node:worker_threads";

import {
  PostMessageCaptureDestinationRpcAdapter,
  type CapturePostMessageEndpoint,
} from "@protodriver/core/capture-rpc";
import {
  PostMessageResourceRpcAdapter,
  ResourceBrokerRpcClient,
  type ResourcePostMessageEndpoint,
} from "@protodriver/core/resources";
import { serveSessionRpc, type PostMessageEndpoint } from "@protodriver/core/rpc";
import { snapshotPlatformCause } from "@protodriver/core/limits";

import {
  createNodeAuthoredWorkerSession,
  isAuthoredWorkerSessionInput,
  type AuthoredWorkerSessionInput,
} from "./authored-worker-session.ts";

const data = workerData as {
  readonly request: import("./authored-worker-client.ts").AuthoredWorkerOpenRequest<AuthoredWorkerSessionInput>;
  readonly sessionPort: import("node:worker_threads").MessagePort;
  readonly resourcePort: import("node:worker_threads").MessagePort;
  readonly capturePort: import("node:worker_threads").MessagePort;
};

const resources = new PostMessageResourceRpcAdapter(
  data.resourcePort as unknown as ResourcePostMessageEndpoint,
);
const captures = new PostMessageCaptureDestinationRpcAdapter(
  data.capturePort as unknown as CapturePostMessageEndpoint,
);
const services = {
  resourceBroker: new ResourceBrokerRpcClient(resources),
  captureDestinationAdapter: captures,
};
let server;
try {
  if (!isAuthoredWorkerSessionInput(data.request.generatedLua)) throw new Error("authored worker binding is missing");
  server = await createNodeAuthoredWorkerSession(data.request, services);
} catch (cause) {
  const reported = typeof cause === "object" && cause !== null && "error" in cause
    ? (cause as { readonly error?: import("@protodriver/contracts").PdrError }).error : undefined;
  const error = reported ?? {
    code: "session.worker-initialization",
    message: cause instanceof Error ? cause.message : String(cause),
    retryability: "no" as const,
    platformCause: snapshotPlatformCause(typeof cause === "object" && cause !== null ? cause : String(cause)),
  };
  server = {
    events: { async *[Symbol.asyncIterator]() { /* failed workers have no lifecycle events */ } },
    async handle(request: import("@protodriver/contracts").SessionRpcRequest) {
      return { kind: "error" as const, method: request.kind, callId: request.callId,
        error };
    },
  };
}

serveSessionRpc(data.sessionPort as unknown as PostMessageEndpoint, server);
