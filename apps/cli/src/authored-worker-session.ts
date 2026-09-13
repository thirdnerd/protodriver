import { readFile } from "node:fs/promises";

import type { AuthoredDescription } from "@protodriver/contracts";
import { admitAuthoredModule, createAuthoredSession } from "@protodriver/core/authored-module";
import type { CaptureDestinationRpcAdapter } from "@protodriver/core/capture-rpc";
import type { ResourceBrokerClient } from "@protodriver/contracts";
import type { AuthoredWorkerOpenRequest } from "./authored-worker-client.ts";

import { createNodeAuthoredAcquisition } from "./authored-acquisition.ts";

export interface AuthoredWorkerSessionInput {
  readonly kind: "authored-v2";
  readonly selection: {
    readonly modeId: string;
    readonly profileId: string;
    readonly candidateId?: string;
  };
  readonly expectedSourceSetSha256?: string;
}

export function isAuthoredWorkerSessionInput(value: unknown): value is AuthoredWorkerSessionInput {
  return typeof value === "object" && value !== null
    && (value as { readonly kind?: unknown }).kind === "authored-v2";
}

/** Stock serialized host: admission, candidate enumeration and native open all remain in the worker. */
export async function createNodeAuthoredWorkerSession(
  request: AuthoredWorkerOpenRequest<AuthoredWorkerSessionInput>,
  services: {
    readonly resourceBroker: ResourceBrokerClient;
    readonly captureDestinationAdapter: CaptureDestinationRpcAdapter;
  },
) {
  const input = request.generatedLua;
  if (!isAuthoredWorkerSessionInput(input)) throw new Error("authored worker binding is missing");
  const artifact = new Uint8Array(await readFile(new URL(
    "../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
    import.meta.url,
  )));
  const module = await admitAuthoredModule(request.canonicalBytes, artifact,
    input.expectedSourceSetSha256 === undefined
      ? {}
      : { expectedSourceSetSha256: input.expectedSourceSetSha256 });
  assertWorkerSelection(module.description, input.selection);
  const grant = await createNodeAuthoredAcquisition()(module.description, input.selection);
  if (grant.modeId !== input.selection.modeId || grant.profileId !== input.selection.profileId) {
    throw new Error("authored.acquisition.selection-mismatch: worker grant differs from admitted selection");
  }
  return (await createAuthoredSession(request.canonicalBytes, artifact, {
    ...grant,
    platform: "node",
    resourceBroker: services.resourceBroker,
    captureDestinationAdapter: services.captureDestinationAdapter,
  }, input.expectedSourceSetSha256)).server;
}

function assertWorkerSelection(
  description: AuthoredDescription,
  selection: AuthoredWorkerSessionInput["selection"],
): void {
  if (!description.modes.includes(selection.modeId)) {
    throw new Error(`authored.acquisition.mode-mismatch: ${selection.modeId} is not admitted`);
  }
  const profile = description.connectionProfiles?.[selection.profileId];
  if (profile === undefined || !profile.modes.includes(selection.modeId)) {
    throw new Error(`authored.acquisition.profile-mismatch: ${selection.profileId} is not admitted for ${selection.modeId}`);
  }
}
