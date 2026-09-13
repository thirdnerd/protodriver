import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort, nativeValue, nativeEncode, nativeJson } from "@protodriver/lua-vm/retained";
import { PdpkgReadError, readPdpkg, readAuthoredDirectorySnapshot, verifyLuaSourceSet, type LuaSourceMemberCandidate } from "@protodriver/contracts";
import { openRetainedLua, RETAINED_VM_SHA256, resolveRetainedLuaPolicy, assertSourceDeclarationPolicy, sourceMemberAdmissionError, type RetainedLuaResourcePolicyRequest, type NativeDataAccount, activeNativeScratch } from "@protodriver/lua-vm/retained";
import { admitAuthoredDescription, canonicalAuthoredBytes, AuthoredAdmissionError, validateAuthoredTopologyGrant } from "./authored-admission.ts";
import { RetainedSessionRpcServer, type RetainedSessionOptions } from "./retained-session.ts";
import { DEFAULT_AUTHORED_POLL_POLICY, grantPollPlans, pollPlans } from "./authored-poll.ts";
import { NativeHelperData } from "./native-helper.ts";
import { DEFAULT_HOST_RESOURCE_LIMITS } from "@protodriver/contracts/limits";
import { TRANSFER_SOURCE_QUANTUM } from "./authored-transfer.ts";

/** Trusted host composition only. Packages cannot supply connection factories. */
export type AuthoredHostGrant = Omit<Parameters<typeof createAuthoredSession>[2],
  "platform" | "resourceBroker" | "captureDestinationAdapter">;

function materialize(v: unknown): unknown {
  activeNativeScratch()?.node();
  if (Array.isArray(v)) return nativeArray(v).map(materialize);
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    if (["float64", "i64", "u64", "integer"].includes(String(r.kind)) && typeof r.decimal === "string" && nativeKeys(r).length === 2) {
      const n = Number(r.decimal);
      if (!Number.isFinite(n) || (r.kind !== "float64" && !Number.isSafeInteger(n))) throw new AuthoredAdmissionError("authored.declaration.numeric-range", "public description requires representable numbers");
      return n;
    }
    return nativeRecord(nativeArray(nativeEntries(r)).map(([k, x]) => [k, materialize(x)]));
  }
  return v;
}
export async function authoredDigest(domain: string, bytes: Uint8Array): Promise<string> {
  const label = nativeEncode(domain);
  activeNativeScratch()?.reserve(8 + label.length + bytes.length);
  activeNativeScratch()?.work(2 + Math.ceil((label.length + bytes.length) / 256));
  const framed = new Uint8Array(8 + label.length + bytes.length);
  const view = new DataView(framed.buffer); view.setUint32(0, label.length); framed.set(label, 4);
  view.setUint32(4 + label.length, bytes.length); framed.set(bytes, 8 + label.length);
  return nativeArray([...new Uint8Array(await crypto.subtle.digest("SHA-256", framed))]).map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function admitAuthoredModule(input: Uint8Array | readonly LuaSourceMemberCandidate[], artifact: Uint8Array,
  options: { readonly expectedSourceSetSha256?: string; readonly luaResourcePolicy?: RetainedLuaResourcePolicyRequest } = {}) {
  const policy = resolveRetainedLuaPolicy(options.luaResourcePolicy);
  // Both entry forms hit exactly the bounded archive member/bootstrap rules.
  let population;
  try {
    population = input instanceof Uint8Array ? await readPdpkg(input) : await readAuthoredDirectorySnapshot(input);
  } catch (cause) {
    if (input instanceof Uint8Array && cause instanceof PdpkgReadError
        && cause.diagnostic.code === "pdpkg.member.crc-mismatch" && cause.sourceMember === "device.lua") {
      throw sourceMemberAdmissionError("device.lua", "initialization-failed");
    }
    throw cause;
  }
  const snapshot = await verifyLuaSourceSet(population);
  const vmBytes = artifact.slice();
  if (options.expectedSourceSetSha256 !== undefined && options.expectedSourceSetSha256 !== snapshot.identity.hex)
    throw new AuthoredAdmissionError("authored.expectation.mismatch", "source-set expectation not reached");
  const first = await openRetainedLua(snapshot, vmBytes, policy).catch((cause: unknown) => {
    const failure = cause as { readonly code?: unknown; readonly phase?: unknown };
    if (failure?.code === "lua-vm.environment.program" && failure.phase === "admission")
      throw sourceMemberAdmissionError("device.lua", "initialization-failed");
    throw cause;
  });
  try {
  const { description, canonical, bindings } = first.admission(() => {
    const description = admitAuthoredDescription(materialize(first.description), first.bindings);
    for (const operation of description.operations) {
      activeNativeScratch()?.iteration(); assertSourceDeclarationPolicy(operation, policy.maximumEncodedInputBytes);
    }
    const canonical = canonicalAuthoredBytes(description);
    nativeValue(first.bindings);
    return { description, canonical, bindings: [...first.bindings] };
  });
  const publicDigest = await first.admission(() => ({ pending: authoredDigest("PDRV-PUBLIC-DESCRIPTION-V2", canonical) })).pending;
  const identityFields = { packageFormat: 1, generatorContract: 2, apiVersion: "device/v2", sourceSet: snapshot.identity.hex,
    publicDescription: publicDigest, vm: RETAINED_VM_SHA256, helpers: Object.freeze([]) };
  const identity = Object.freeze({ ...identityFields, digest: await first.admission(() => ({ pending:
    authoredDigest("PDRV-EXECUTION-IDENTITY-V1", canonicalAuthoredBytes(identityFields)) })).pending });
  return Object.freeze({ description, bindings: Object.freeze(bindings),
    get canonicalBytes() { return canonical.slice(); },
    identity,
    claimLevels: Object.freeze({ integrity: population.claimLevels.integrity }),
    async openExecution(nativeData?: NativeDataAccount) {
      // No effect port exists during either evaluation. The exact owned source
      // population, not a path or caller-supplied cached graph, enters this VM.
      const fresh = await openRetainedLua(snapshot, vmBytes, policy, nativeData);
      try {
        fresh.admission(() => {
          const admitted = admitAuthoredDescription(materialize(fresh.description), fresh.bindings);
          const bytes = canonicalAuthoredBytes(admitted);
          activeNativeScratch()?.reserve(16 + (bytes.length + canonical.length) * 3);
          activeNativeScratch()?.work(2 + Math.ceil((bytes.length + canonical.length) / 256));
          if (new TextDecoder().decode(bytes) !== new TextDecoder().decode(canonical)
            || nativeJson(fresh.bindings) !== nativeJson(bindings)) throw new AuthoredAdmissionError("authored.identity.mismatch", "fresh public description or callable bindings differ");
        });
        return fresh.execution;
      } catch (cause) { fresh.close(); throw cause; }
    },
  });
  } finally { first.close(); }
}

/** Product-owned admission and fresh-context barrier, shared by both hosts. */
export async function createAuthoredSession(input: Uint8Array | readonly LuaSourceMemberCandidate[], artifact: Uint8Array,
  options: Omit<RetainedSessionOptions, "execution" | "description" | "operations" | "logicalDevice" | "executionIdentity"> & { readonly luaResourcePolicy?: RetainedLuaResourcePolicyRequest },
  expectation?: string) {
  if (nativeKeys(options.helpers).length) throw new AuthoredAdmissionError("authored.helpers.unavailable", "participating native helpers require an identity inventory before use");
  const module = await admitAuthoredModule(input, artifact, {
    ...(expectation === undefined ? {} : { expectedSourceSetSha256: expectation }),
    ...(options.luaResourcePolicy === undefined ? {} : { luaResourcePolicy: options.luaResourcePolicy }),
  });
  const nativeData = new NativeHelperData(options.maximumNativeHelperBytes);
  const execution = await module.openExecution(nativeData);
  try {
  const checkpointPolicyDigest = await execution.admission(() => ({ pending: authoredDigest("PDRV-AUTHORED-TRANSFER-POLICY-V1",
    canonicalAuthoredBytes({ profile: options.profileId, ...(module.description.channelRoles ? { channelRoles: module.description.channelRoles[options.profileId] ?? null } : {}), maximumMaterializedSourceBytes: 65536, maximumStreamReadBytes: 256, maximumUnsettledSourceBytes: 65536,
      transferSourceQuantum: TRANSFER_SOURCE_QUANTUM, maximumEffectWork: options.maximumEffectWork ?? 32000000, maximumConcurrentTimers: options.maximumConcurrentTimers ?? DEFAULT_HOST_RESOURCE_LIMITS.maximumConcurrentTimers,
      maximumNativeHelperBytes: options.maximumNativeHelperBytes ?? 16777216 })) })).pending;
  return execution.admission(() => {
  if (!module.description.modes.includes(options.modeId)) throw new AuthoredAdmissionError("authored.mode.unavailable", `host selected unavailable mode ${JSON.stringify(options.modeId) ?? "<missing>"}`);
  if (!module.description.profiles.includes(options.profileId)) throw new AuthoredAdmissionError("authored.profile.unavailable", `host selected unavailable profile ${JSON.stringify(options.profileId) ?? "<missing>"}`);
  const request = module.description.connectionProfiles?.[options.profileId];
  if (request && !request.modes.includes(options.modeId)) throw new AuthoredAdmissionError("authored.profile.unavailable", "profile does not allow the host-selected mode");
  const scheduled = Boolean(module.description.handlers?.length);
  const plans = pollPlans(module.description);
  const pollPolicy = grantPollPlans(plans, options.pollPolicy === undefined ? DEFAULT_AUTHORED_POLL_POLICY : options.pollPolicy);
  const capabilities = {
    "usb.control": options.usbControl ?? { available: false, limitation: "host has not granted USB control" },
    "channel.read": { available: !scheduled, limitation: scheduled ? "reliable input is delegated to the declared handler" : "bounded granted channel" },
    "channel.write": { available: !scheduled, limitation: scheduled ? "channel effects are delegated to the declared handler" : "bounded granted channel" },
    "channel.write-via": { available: Boolean(nativeArray(module.description.handlers)?.some(h => h.authorizeWrite)), limitation: "exact-byte approval by the admitted channel owner" },
    "mailbox": { available: scheduled, limitation: "only admitted bounded routes" },
    "timer": { available: true, limitation: "bounded relative timers" },
    "clock.observe": { available: true, limitation: "accounted session-relative monotonic observations; no ambient clock or surviving timer" },
    "expiry.observe": { available: true, limitation: "prepaid generation-scoped ordered evidence; no callback or revoked continuation" },
    "input.retirement": { available: options.inputRetirementSupport?.adapter === "bounded-ingress-v1"
      && options.inputRetirementSupport.clock === options.clock
      && module.description.entry?.inputEvidence === "consumed-ranges"
      && module.description.handlers?.length === 1 && module.description.handlers[0]?.inputEvidence === "consumed-ranges",
      limitation: "host-selected original-stamp adapter; complete binding attested before entry, consumed ranges only" },
    "operation.deadline": { available: true, limitation: "ordinary-operation revocation; unresolved native calls retain slots and outbound ordering" },
    "transfer.checkpoint": { available: options.checkpointStore !== undefined, limitation: "host-granted atomic durable store; authored carrier reports remain protocol assertions" },
    "transfer.cleanup": { available: options.checkpointStore !== undefined, limitation: "cleanup-only retirement of the operation's existing settled claim" },
    "state.poll": { available: pollPolicy !== null, limitation: JSON.stringify(pollPolicy) },
    "connection.lifecycle": { available: module.description.invalidation !== undefined, limitation: "requires an admitted invalidation handler" },
  };
  validateAuthoredTopologyGrant(module.description, options.channelId, { ...capabilities,
    "channel.input": { available: true, limitation: "one native delivery per external activation" },
    "channel.write": { available: true, limitation: "granted consuming handler channel" } });
  for (const plan of plans) {
    activeNativeScratch()?.iteration();
    const op = nativeArray(module.description.operations).find(op => op.id === plan.operation)!;
    if (!op.availability.profiles.includes(options.profileId) || nativeArray(op.requires).some(r => !capabilities[r as keyof typeof capabilities]?.available))
      throw new AuthoredAdmissionError("authored.poll.unavailable", "host cannot execute the requested poll target");
  }
  if (scheduled && nativeArray(module.description.entry?.requires)?.some(requirement =>
    !(module.description.entry?.handoffTo && ["channel.read", "channel.write"].includes(requirement))
    && !capabilities[requirement as keyof typeof capabilities]?.available))
    throw new AuthoredAdmissionError("authored.capability.unavailable", "entry requires authority owned by the input handler or unavailable on this host");
    return { module, server: new RetainedSessionRpcServer({ ...options, channelRoles: module.description.channelRoles?.[options.profileId], checkpointPolicyDigest, nativeData, pollPolicy, capabilities, execution, description: module.description,
      logicalDevice: module.description.id, operations: nativeArray(module.description.operations).map(operation => operation.id),
      executionIdentity: { digest: module.identity.digest },
    }) };
  }); } catch (cause) { await execution.close(); throw cause; }
}
