import type {
  AcquisitionService,
  CandidateId,
  CandidateRequest,
  ConnectRequest,
  ConnectResult,
  GrantDescriptor,
  PdrError,
  SerializableCandidate,
} from "@protodriver/contracts";

type ConnectedResult = Extract<ConnectResult, { readonly kind: "connected" }>;

export interface SessionAcquisitionOptions {
  readonly service: AcquisitionService;
  readonly profileIdsForMode: (mode: string | undefined) => readonly string[];
  readonly connectCandidate: (
    candidate: SerializableCandidate,
    request: ConnectRequest,
  ) => Promise<ConnectedResult>;
}

export class AcquisitionError extends Error {
  readonly error: PdrError;

  constructor(error: PdrError) {
    super(error.message);
    this.name = "AcquisitionError";
    this.error = error;
  }
}

function fail(code: string, message: string, details?: PdrError["details"]): never {
  throw new AcquisitionError({
    code,
    message,
    retryability: "no",
    ...(details === undefined ? {} : { details }),
  });
}

function assertGrant(grant: GrantDescriptor | undefined): void {
  if (grant === undefined) return;
  if (typeof grant !== "object" || grant === null
      || typeof grant.grantId !== "string" || grant.grantId.length === 0
      || !Array.isArray(grant.matchedFilters)) {
    fail(
      "acquisition.invalid-grant",
      "the whole grant descriptor, including matchedFilters, is required",
    );
  }
  const seen = new Set<number>();
  for (const index of grant.matchedFilters) {
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) {
      fail(
        "acquisition.invalid-grant",
        "grant matchedFilters must contain unique non-negative safe integers",
      );
    }
    seen.add(index);
  }
}

function assertCandidateShape(
  candidate: SerializableCandidate,
  requestedProfiles: ReadonlySet<string>,
): void {
  if (typeof candidate.candidateId !== "string" || candidate.candidateId.length === 0) {
    fail("acquisition.invalid-candidate", "candidateId must be a non-empty string");
  }
  if (typeof candidate.displayName !== "string" || candidate.displayName.length === 0) {
    fail(
      "acquisition.invalid-candidate",
      `candidate ${candidate.candidateId} has no operator-facing display name`,
    );
  }
  if (!requestedProfiles.has(candidate.matchedProfileId)) {
    fail(
      "acquisition.invalid-candidate",
      `candidate ${candidate.candidateId} names profile ${candidate.matchedProfileId} outside the request`,
    );
  }
  if (candidate.identity.stableKeyAssurance === "none"
      && candidate.identity.stableKey !== undefined) {
    fail(
      "acquisition.invalid-candidate",
      `candidate ${candidate.candidateId} carries a stable key with no assurance`,
    );
  }
  if (candidate.identity.stableKeyAssurance !== "none"
      && (typeof candidate.identity.stableKey !== "string"
        || candidate.identity.stableKey.length === 0)) {
    fail(
      "acquisition.invalid-candidate",
      `candidate ${candidate.candidateId} is missing its assured stable key`,
    );
  }
}

function validateCandidates(
  values: readonly SerializableCandidate[],
  requestedProfiles: readonly string[],
): readonly SerializableCandidate[] {
  const profiles = new Set(requestedProfiles);
  const byId = new Map<CandidateId, SerializableCandidate>();
  for (const candidate of values) {
    assertCandidateShape(candidate, profiles);
    if (byId.has(candidate.candidateId)) {
      fail(
        "acquisition.duplicate-candidate-id",
        `candidate id ${candidate.candidateId} appeared more than once`,
      );
    }
    byId.set(candidate.candidateId, candidate);
  }

  for (const candidate of values) {
    const ambiguous = candidate.ambiguousWith ?? [];
    const seen = new Set<CandidateId>();
    for (const otherId of ambiguous) {
      if (otherId === candidate.candidateId || seen.has(otherId) || !byId.has(otherId)) {
        fail(
          "acquisition.invalid-ambiguity",
          `candidate ${candidate.candidateId} has an invalid ambiguousWith reference ${otherId}`,
        );
      }
      seen.add(otherId);
      const reverse = byId.get(otherId)!.ambiguousWith ?? [];
      if (!reverse.includes(candidate.candidateId)) {
        fail(
          "acquisition.invalid-ambiguity",
          `ambiguity between ${candidate.candidateId} and ${otherId} is not symmetric`,
        );
      }
    }
  }

  // Direct and postMessage callers receive detached DTOs with the same
  // ownership semantics. No provider-owned array or identity object leaks.
  return structuredClone(values);
}

/** Worker-side acquisition flow. It has no permission/chooser capability. */
export class SessionAcquisition {
  readonly #service: AcquisitionService;
  readonly #profileIdsForMode: SessionAcquisitionOptions["profileIdsForMode"];
  readonly #connectCandidate: SessionAcquisitionOptions["connectCandidate"];

  constructor(options: SessionAcquisitionOptions) {
    this.#service = options.service;
    this.#profileIdsForMode = options.profileIdsForMode;
    this.#connectCandidate = options.connectCandidate;
  }

  async resolveCandidates(
    request: CandidateRequest,
  ): Promise<readonly SerializableCandidate[]> {
    assertGrant(request.grant);
    const profiles = [...this.#profileIdsForMode(request.mode)];
    if (profiles.length === 0 || profiles.some((profile) => profile.length === 0)) {
      fail("acquisition.no-profiles", "the requested mode has no connection profiles");
    }
    const candidates = await this.#service.listAuthorized(profiles, request.grant);
    return validateCandidates(candidates, profiles);
  }

  async connect(request: ConnectRequest): Promise<ConnectResult> {
    const candidates = await this.resolveCandidates({
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.grant === undefined ? {} : { grant: request.grant }),
    });
    if (candidates.length === 0) {
      fail("acquisition.no-candidates", "no authorized candidate matches the request");
    }

    let selected: SerializableCandidate | undefined;
    if (request.candidateId !== undefined) {
      selected = candidates.find(({ candidateId }) => candidateId === request.candidateId);
      if (selected === undefined) {
        fail(
          "acquisition.unknown-candidate",
          `candidate ${request.candidateId} is not authorized by this request`,
        );
      }
    } else if (candidates.length === 1
        && (candidates[0]!.ambiguousWith?.length ?? 0) === 0) {
      selected = candidates[0];
    }

    if (selected === undefined) {
      return { kind: "selection-required", candidates };
    }
    return this.#connectCandidate(selected, request);
  }
}
