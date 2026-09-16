import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthoredDescription } from "@protodriver/contracts";
import { RealClock } from "@protodriver/core/clock";
import { DEFAULT_AUTHORED_POLL_POLICY, grantRequiredPollPlans, pollPlans } from "@protodriver/core/authored-poll";
import type { NodeAuthoredAcquisition } from "./authored-run.ts";
import { listNodeAuthoredCandidates } from "./node-authored-candidates.ts";
import { NodeTransferCheckpointStore } from "./transfer-checkpoints.ts";
import { expectedCliError } from "./expected-error.ts";

export function selectAuthoredProfile(description: AuthoredDescription,
  selection: { readonly modeId?: string; readonly profileId?: string }) {
  const requests = description.connectionProfiles;
  if (!requests) throw expectedCliError("authored.acquisition.required", "package admitted; execution needs an explicit host-supplied connection grant", "host");
  const modeId = selection.modeId ?? (description.modes.length === 1 ? description.modes[0] : undefined);
  if (!modeId || !description.modes.includes(modeId)) throw expectedCliError("authored.acquisition.mode", "pass --mode with one of " + description.modes.join(", "), "invocation");
  const profiles = description.profiles.filter(id => requests[id]!.modes.includes(modeId));
  const profileId = selection.profileId ?? (profiles.length === 1 ? profiles[0] : undefined);
  if (!profileId || !profiles.includes(profileId)) throw expectedCliError("authored.acquisition.profile", "mode " + modeId + " requires --profile with one of " + profiles.join(", "), "invocation");
  return { modeId, profileId, profile: requests[profileId]! };
}

/** Host policy. The injectable enumerator is trusted host composition, never package data. */
export function createNodeAuthoredAcquisition(
  enumerate: typeof listNodeAuthoredCandidates = listNodeAuthoredCandidates,
): NodeAuthoredAcquisition {
  return async (description, selection) => {
    const { modeId, profileId, profile } = selectAuthoredProfile(description, selection);
    const pollPolicy = grantRequiredPollPlans(pollPlans(description), DEFAULT_AUTHORED_POLL_POLICY,
      { minimumIntervalMs: 200, maximumNominalPollsPerSecond: 5 });
    const clock = new RealClock();
    let candidates;
    try { candidates = await enumerate({ ...profile, id: profileId }, modeId, clock); }
    catch (cause) { throw expectedCliError("authored.acquisition.refused", String(cause) + "; an explicit F87 host-supplied grant remains available", "host", cause); }
    const selected = selection.candidateId === undefined
      ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find(({ candidate }) => candidate.candidateId === selection.candidateId);
    if (!selected) throw expectedCliError("authored.acquisition.candidate", (candidates.length
      ? "device selection is required; pass --candidate with one of " + candidates.map(({ candidate }) => `${candidate.candidateId} (${candidate.displayName})`).join(", ")
      : "no candidate matches connection profile " + profileId), "invocation");
    if (selected.candidate.matchedProfileId !== profileId) throw new Error("authored.acquisition.refused: enumerator returned a different profile");
    const checkpointDirectory = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "protodriver", "transfer-checkpoints");
    return { modeId, profileId, clock, channelId: "main", helpers: {},
      pollPolicy,
      inputRetirementSupport: { adapter: "bounded-ingress-v1", clock },
      usbControl: { available: profile.transport.kind === "usb", limitation: "Node host grants bounded USB control on the selected interface" },
      checkpointStore: new NodeTransferCheckpointStore(checkpointDirectory),
      open: selected.open,
    };
  };
}
