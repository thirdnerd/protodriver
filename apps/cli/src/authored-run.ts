import { readFile, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { buildPdpkg, type AuthoredDescription, type CheckpointId, type ClientId, type DeviceSessionClient, type LuaSourceMemberCandidate, type OperationArgument, type SessionId } from "@protodriver/contracts";
import { generateAuthoredControlModel, stringifyGeneratedPublicJson } from "@protodriver/control-model";
import { admitAuthoredModule, createAuthoredSession, type AuthoredHostGrant } from "@protodriver/core/authored-module";
import { ResourceBrokerHost, ResourceBrokerRpcClient, DirectResourceRpcAdapter } from "@protodriver/core/resources";
import { CaptureDestinationRegistry, DirectCaptureDestinationRpcAdapter } from "@protodriver/core/capture-rpc";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "@protodriver/core/rpc";
import { registerAuthoredFileArgument, renderAuthoredCliHelp, renderAuthoredCliResult, renderAuthoredCliState, saveAuthoredOutput } from "@protodriver/generated-cli";
import { NodeCaptureDestination } from "./capture-destination.ts";
import { createNodeAuthoredAcquisition, selectAuthoredProfile } from "./authored-acquisition.ts";
import { createWorkerNodeAuthoredRunDependencies, type WorkerNodeAuthoredRunOptions } from "./authored-worker-client.ts";
import type { AuthoredWorkerSessionInput } from "./authored-worker-session.ts";

const DEFAULT_CLI_CAPTURE_SIDECAR_THRESHOLD_BYTES = 1024 * 1024;

export type NodeAuthoredAcquisition = (description: AuthoredDescription,
  selection: { readonly modeId?: string; readonly profileId?: string; readonly candidateId?: string }) => Promise<AuthoredHostGrant>;

export interface AuthoredRunIo {
  readonly input?: AsyncIterable<Uint8Array | string>;
  readonly output: Writable;
  readonly error?: Writable;
}

export async function runAuthoredCli(argv: readonly string[], io: AuthoredRunIo,
  acquire?: NodeAuthoredAcquisition, workerOptions?: WorkerNodeAuthoredRunOptions): Promise<void> {
  const path = argv[0];
  if (!path) throw new Error("usage: pdr run <device-directory-or-package> [--mode id] <operation> [flags]");
  const archive = await loadAuthoredArchive(path);
  const artifact = new Uint8Array(await readFile(new URL("../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
  const flags = new Map<string, string>();
  let operationId: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      if (operationId !== undefined) throw new Error("unexpected authored command argument: " + token);
      operationId = token; continue;
    }
    const key = token.slice(2);
    if (flags.has(key)) throw new Error("duplicate option: " + token);
    if (["help", "json"].includes(key)) flags.set(key, "true");
    else { const value = argv[++i]; if (value === undefined || value.startsWith("--")) throw new Error("value required for " + token); flags.set(key, value); }
  }
  const expected = flags.get("expect-source-set-sha256");
  const module = await admitAuthoredModule(archive, artifact,
    expected === undefined ? {} : { expectedSourceSetSha256: expected });
  const model = generateAuthoredControlModel(module.description);
  if (operationId === undefined) {
    io.output.write(renderAuthoredCliHelp(module.description));
    return;
  }
  const operation = model.operations.find(op => op.id === operationId);
  if (!operation) throw new Error("unknown authored operation: " + operationId);
  if (flags.has("help")) {
    io.output.write(renderAuthoredCliHelp(module.description, operationId));
    return;
  }
  const reserved = new Set(["mode", "profile", "candidate", "capture", "json", "save-result", "resume", "expect-source-set-sha256"]);
  for (const key of flags.keys()) if (!reserved.has(key) && !Object.hasOwn(operation.arguments, key)) throw new Error("unknown option: --" + key);
  for (const key of Object.keys(operation.arguments)) if (!flags.has(key)) throw new Error("missing argument: --" + key);
  let selection = {
    ...(flags.has("mode") ? { modeId: flags.get("mode")! } : {}),
    ...(flags.has("profile") ? { profileId: flags.get("profile")! } : {}),
    ...(flags.has("candidate") ? { candidateId: flags.get("candidate")! } : {}),
  };
  if (module.description.connectionProfiles) {
    const selected = selectAuthoredProfile(module.description, selection);
    if (!operation.availability.modes.includes(selected.modeId) || !operation.availability.profiles.includes(selected.profileId))
      throw new Error("authored.acquisition.operation-unavailable: operation does not allow the selected mode/profile");
    selection = { modeId: selected.modeId, profileId: selected.profileId,
      ...(selection.candidateId === undefined ? {} : { candidateId: selection.candidateId }) };
  }
  if (workerOptions !== undefined) {
    if (acquire !== undefined) {
      throw new Error("authored.acquisition.worker-callback-unavailable: a live embedding callback cannot cross the serialized worker boundary; supply a host-owned worker instead");
    }
    if (!module.description.connectionProfiles || selection.modeId === undefined || selection.profileId === undefined) {
      throw new Error("authored.acquisition.required: serialized worker needs an admitted physical connection profile");
    }
    await runAuthoredWorker({ path, archive,
      ...(expected === undefined ? {} : { expected }),
      flags, operation, model, selection: {
      modeId: selection.modeId,
      profileId: selection.profileId,
      ...(selection.candidateId === undefined ? {} : { candidateId: selection.candidateId }),
    }, io, workerOptions });
    return;
  }
  const grant = await (acquire ?? createNodeAuthoredAcquisition())(module.description, selection);
  if ((flags.has("mode") && flags.get("mode") !== grant.modeId)
    || (flags.has("profile") && flags.get("profile") !== grant.profileId)) throw new Error("authored.acquisition.selection-mismatch");
  const resources = new ResourceBrokerHost(), sessionId = randomUUID() as SessionId;
  const resourceAdapter = new DirectResourceRpcAdapter(resources);
  const destinations = new CaptureDestinationRegistry();
  const captureAdapter = new DirectCaptureDestinationRpcAdapter(destinations, sessionId);
  const register = (resource: Parameters<typeof resources.registerSource>[0] | Parameters<typeof resources.registerSink>[0]) =>
    "read" in resource ? resources.registerSource(resource, { kind: "session", sessionId }) : resources.registerSink(resource, { kind: "session", sessionId });
  let client: DeviceSessionRpcClient | undefined;
  let observations: { dispose(): void } | undefined;
  const sources: Array<{ close(): Promise<void> }> = [];
  try {
    const { server } = await createAuthoredSession(archive, artifact, { ...grant, platform: "node",
      resourceBroker: new ResourceBrokerRpcClient(resourceAdapter), captureDestinationAdapter: captureAdapter }, expected);
    client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
    await client.attach(randomUUID() as ClientId);
    observations = observeAuthoredPublicSurface(client, model, io);
    const args: Record<string, OperationArgument> = {};
    for (const [name, type] of Object.entries(operation.arguments)) {
      const value = flags.get(name)!;
      if (type.kind === "byte-source" || type.kind === "stream-source") {
        const source = await registerAuthoredFileArgument(operation, name, value, register); sources.push(source); args[name] = source.argument;
      } else args[name] = { kind: "value", value: type.kind === "string" || type.kind === "enum" ? value : JSON.parse(value) };
    }
    const capture = flags.get("capture");
    if (capture) {
      const destination = await NodeCaptureDestination.create({ directory: capture, registrar: resources, sessionId });
      await client.startCapture(await destinations.register(destination, sessionId), { sidecarThresholdBytes: DEFAULT_CLI_CAPTURE_SIDECAR_THRESHOLD_BYTES });
    }
    await client.connect({ mode: grant.modeId });
    let outcome;
    if (operation.result.kind === "resource" || operation.result.kind === "file") {
      if (flags.has("resume")) throw new Error("authored resource output has no resume recipe");
      const output = flags.get("save-result"); if (!output) throw new Error("--save-result is required for declared resource output");
      outcome = await saveAuthoredOutput(client, operation, args, output, register);
    } else {
      if (flags.has("save-result")) throw new Error("operation has no declared resource output");
      const request = { operation: operation.id, arguments: args };
      const handle = flags.has("resume") ? await client.resumeTransfer({ ...request, checkpointId: flags.get("resume")! as CheckpointId }) : await client.startOperation(request);
      outcome = await client.awaitOperation(handle.operationId);
      await client.acknowledgeOperation(handle.operationId);
    }
    // Close the owning session before its capture so outstanding tails cannot be certified away.
    await client.disconnect();
    io.output.write((flags.has("json") ? stringifyGeneratedPublicJson(outcome) : renderAuthoredCliResult(operation.resultControl, outcome.result)) + "\n");
    if (outcome.outcome !== "completed") throw new Error(stringifyGeneratedPublicJson(outcome));
  } finally {
    observations?.dispose();
    await client?.disconnect().catch(() => undefined);
    await client?.close();
    for (const source of sources) await source.close();
    await captureAdapter.close(); await resourceAdapter.close();
  }
}

async function loadAuthoredArchive(path: string): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (metadata.isFile()) return new Uint8Array(await readFile(path));
  if (!metadata.isDirectory()) throw new Error(`${path} must name a Lua source directory or package file`);
  const logicalNames = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
    .map((entry) => entry.name)
    .sort();
  if (!logicalNames.includes("device.lua")) {
    throw new Error(`${path} must contain the exact Lua entry device.lua`);
  }
  const members: readonly LuaSourceMemberCandidate[] = await Promise.all(logicalNames.map(async (logicalName) => ({
    logicalName,
    sourceBytes: new Uint8Array(await readFile(resolve(path, logicalName))),
  })));
  return (await buildPdpkg(members)).archive;
}

async function runAuthoredWorker(options: {
  readonly path: string;
  readonly archive: Uint8Array;
  readonly expected?: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly operation: ReturnType<typeof generateAuthoredControlModel>["operations"][number];
  readonly model: ReturnType<typeof generateAuthoredControlModel>;
  readonly selection: AuthoredWorkerSessionInput["selection"];
  readonly io: AuthoredRunIo;
  readonly workerOptions: WorkerNodeAuthoredRunOptions;
}): Promise<void> {
  const dependencies = createWorkerNodeAuthoredRunDependencies<AuthoredWorkerSessionInput>(options.workerOptions);
  const generatedLua: AuthoredWorkerSessionInput = {
    kind: "authored-v2",
    selection: options.selection,
    ...(options.expected === undefined ? {} : { expectedSourceSetSha256: options.expected }),
  };
  const client = await dependencies.openClient({
    source: options.path,
    canonicalBytes: options.archive,
    modeId: options.selection.modeId,
    profileId: options.selection.profileId,
    ...(options.selection.candidateId === undefined ? {} : { candidateId: options.selection.candidateId }),
    generatedLua,
  });
  const sources: Array<{ close(): Promise<void> }> = [];
  let observations: { dispose(): void } | undefined;
  let captureRegistration: Awaited<ReturnType<NonNullable<typeof dependencies.registerCaptureDestination>>> | undefined;
  try {
    await client.attach(randomUUID() as ClientId);
    observations = observeAuthoredPublicSurface(client, options.model, options.io);
    const register = (resource: Parameters<NonNullable<typeof dependencies.registerResource>>[1]) =>
      dependencies.registerResource!(client, resource);
    const args: Record<string, OperationArgument> = {};
    for (const [name, type] of Object.entries(options.operation.arguments)) {
      const value = options.flags.get(name)!;
      if (type.kind === "byte-source" || type.kind === "stream-source") {
        const source = await registerAuthoredFileArgument(options.operation, name, value, register);
        sources.push(source);
        args[name] = source.argument;
      } else {
        args[name] = { kind: "value", value: type.kind === "string" || type.kind === "enum" ? value : JSON.parse(value) };
      }
    }
    const capture = options.flags.get("capture");
    if (capture) {
      captureRegistration = await dependencies.registerCaptureDestination!(client, capture);
      await client.startCapture(captureRegistration.destinationId, { sidecarThresholdBytes: DEFAULT_CLI_CAPTURE_SIDECAR_THRESHOLD_BYTES });
    }
    await client.connect({ mode: options.selection.modeId, profile: options.selection.profileId });
    let outcome;
    if (options.operation.result.kind === "resource" || options.operation.result.kind === "file") {
      if (options.flags.has("resume")) throw new Error("authored resource output has no resume recipe");
      const output = options.flags.get("save-result");
      if (!output) throw new Error("--save-result is required for declared resource output");
      outcome = await saveAuthoredOutput(client, options.operation, args, output, register);
    } else {
      if (options.flags.has("save-result")) throw new Error("operation has no declared resource output");
      const request = { operation: options.operation.id, arguments: args };
      const handle = options.flags.has("resume")
        ? await client.resumeTransfer({ ...request, checkpointId: options.flags.get("resume")! as CheckpointId })
        : await client.startOperation(request);
      outcome = await client.awaitOperation(handle.operationId);
      await client.acknowledgeOperation(handle.operationId);
    }
    await client.disconnect();
    options.io.output.write((options.flags.has("json")
      ? stringifyGeneratedPublicJson(outcome)
      : renderAuthoredCliResult(options.operation.resultControl, outcome.result)) + "\n");
    if (outcome.outcome !== "completed") throw new Error(stringifyGeneratedPublicJson(outcome));
  } finally {
    observations?.dispose();
    await client.disconnect().catch(() => undefined);
    for (const source of sources) await source.close();
    await captureRegistration?.release().catch(() => undefined);
    await dependencies.closeClient?.(client);
  }
}

function observeAuthoredPublicSurface(
  client: DeviceSessionClient,
  model: { readonly state: Readonly<Record<string, { readonly valueControl: Parameters<typeof renderAuthoredCliState>[0] }>> },
  io: AuthoredRunIo,
): { dispose(): void } {
  const report = io.error;
  if (report === undefined) return { dispose() {} };
  const events = client.subscribe(event => {
    if (event.kind === "operation-progress") {
      report.write(`${stringifyGeneratedPublicJson({ operationProgress: {
        operationId: event.operationId,
        phase: event.phase,
        completed: event.completed,
        ...(event.total === undefined ? {} : { total: event.total }),
        assurance: "module-reported",
      } })}\n`);
      return;
    }
    if (event.kind === "transfer-progress") {
      report.write(`${stringifyGeneratedPublicJson({ operationProgress: {
        operationId: event.operationId,
        phase: event.phase,
        checkpointId: event.checkpointId,
        assurance: "host-counted-transfer",
      } })}\n`);
      return;
    }
    if (event.kind !== "state-cells") return;
    for (const [cell, snapshot] of Object.entries(event.changed)) {
      const control = model.state[cell]?.valueControl;
      if (control !== undefined) report.write(`${stringifyGeneratedPublicJson({ state: {
        cell,
        presentation: renderAuthoredCliState(control, snapshot),
        assurance: "authored-observation",
      } })}\n`);
    }
  });
  const diagnostics = client.subscribeDiagnostics(batch => {
    report.write(`${stringifyGeneratedPublicJson({ diagnostics: {
      records: batch.records,
      dropped: batch.dropped,
      assurance: "bounded-observation",
    } })}\n`);
  });
  return { dispose() { events.dispose(); diagnostics.dispose(); } };
}
