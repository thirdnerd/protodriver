import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";

import type {
  CaptureDestinationId,
  DeviceSessionClient,
  HostByteSink,
  HostByteSource,
  ResourceId,
  SessionId,
} from "@protodriver/contracts";
import { CaptureDestinationRegistry, serveCaptureDestinationRpc, type CapturePostMessageEndpoint } from "@protodriver/core/capture-rpc";
import {
  ResourceBrokerHost,
  serveResourceRpc,
  type ResourcePostMessageEndpoint,
} from "@protodriver/core/resources";
import {
  DeviceSessionRpcClient,
  PostMessageSessionRpcAdapter,
  type PostMessageEndpoint,
} from "@protodriver/core/rpc";

import { NodeCaptureDestination } from "./capture-destination.ts";
export interface AuthoredWorkerOpenRequest<SessionInput> {
  readonly source: string;
  readonly canonicalBytes: Uint8Array;
  readonly modeId: string;
  readonly profileId?: string;
  readonly candidateId?: string;
  readonly serialPath?: string;
  readonly generatedLua?: SessionInput;
}

export interface AuthoredWorkerRunDependencies<SessionInput> {
  readonly openClient: (request: AuthoredWorkerOpenRequest<SessionInput>) => Promise<DeviceSessionClient>;
  readonly registerResource?: (client: DeviceSessionClient, resource: HostByteSource | HostByteSink) => Promise<ResourceId>;
  readonly registerCaptureDestination?: (client: DeviceSessionClient, directory: string) => Promise<{
    readonly destinationId: CaptureDestinationId;
    readonly path: string;
    release(): Promise<void>;
  }>;
  readonly closeClient?: (client: DeviceSessionClient) => Promise<void>;
}

interface WorkerNodeClientContext {
  readonly sessionId: SessionId;
  readonly client: DeviceSessionRpcClient;
  readonly resources: ResourceBrokerHost;
  readonly captureDestinations: CaptureDestinationRegistry;
  readonly resourceService: { dispose(): void };
  readonly captureService: { dispose(): void };
  readonly worker: Worker;
}

export interface WorkerNodeAuthoredRunOptions {
  /** Test seam: a worker may supply a controlled transport while retaining the product RPC route. */
  readonly workerUrl?: URL;
}

/** Runs the authored session server behind structured-clone MessagePorts. */
export function createWorkerNodeAuthoredRunDependencies<SessionInput>(
  options: WorkerNodeAuthoredRunOptions = {},
): AuthoredWorkerRunDependencies<SessionInput> {
  const contexts = new WeakMap<DeviceSessionClient, WorkerNodeClientContext>();
  return {
    async openClient(request) {
      const sessionId = randomUUID() as SessionId;
      const sessionChannel = new MessageChannel();
      const resourceChannel = new MessageChannel();
      const captureChannel = new MessageChannel();
      const resources = new ResourceBrokerHost();
      const captureDestinations = new CaptureDestinationRegistry();
      const resourceService = serveResourceRpc(
        resourceChannel.port1 as unknown as ResourcePostMessageEndpoint,
        resources,
      );
      const captureService = serveCaptureDestinationRpc(
        captureChannel.port1 as unknown as CapturePostMessageEndpoint,
        captureDestinations,
        sessionId,
      );
      const sessionAdapter = new PostMessageSessionRpcAdapter(
        sessionChannel.port1 as unknown as PostMessageEndpoint,
      );
      const worker = new Worker(
        options.workerUrl ?? new URL("./node-session-worker.ts", import.meta.url),
        {
          workerData: {
            request,
            sessionPort: sessionChannel.port2,
            resourcePort: resourceChannel.port2,
            capturePort: captureChannel.port2,
          },
          transferList: [sessionChannel.port2, resourceChannel.port2, captureChannel.port2],
        },
      );
      worker.once("error", (cause) => sessionAdapter.workerLost(cause));
      worker.once("exit", (code) => {
        if (code !== 0) sessionAdapter.workerLost(new Error(`authored session worker exited ${code}`));
      });
      const client = new DeviceSessionRpcClient(sessionAdapter);
      contexts.set(client, {
        sessionId,
        client,
        resources,
        captureDestinations,
        resourceService,
        captureService,
        worker,
      });
      return client;
    },
    async registerResource(client, resource) {
      const context = requireContext(contexts, client);
      const scope = { kind: "session" as const, sessionId: context.sessionId };
      return isByteSource(resource)
        ? context.resources.registerSource(resource, scope)
        : context.resources.registerSink(resource, scope);
    },
    async registerCaptureDestination(client, directory) {
      const context = requireContext(contexts, client);
      const destination = await NodeCaptureDestination.create({
        directory,
        registrar: context.resources,
        sessionId: context.sessionId,
      });
      const destinationId = await context.captureDestinations.register(
        destination,
        context.sessionId,
      );
      return {
        destinationId,
        path: join(directory, "session.pdcap"),
        release: () => context.captureDestinations.release(destinationId),
      };
    },
    async closeClient(client) {
      const context = requireContext(contexts, client);
      contexts.delete(client);
      await context.client.close();
      context.captureService.dispose();
      context.resourceService.dispose();
      await context.worker.terminate();
    },
  };
}

function requireContext<Context>(
  contexts: WeakMap<DeviceSessionClient, Context>,
  client: DeviceSessionClient,
): Context {
  const context = contexts.get(client);
  if (context === undefined) throw new Error("authored Node client context is closed or unknown");
  return context;
}

function isByteSource(resource: HostByteSource | HostByteSink): resource is HostByteSource {
  return "read" in resource;
}
