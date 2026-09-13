import type { Brand } from "./brand.js";

export type CandidateId = Brand<string, "CandidateId">;
export type GrantId = Brand<string, "GrantId">;
export type UsbSpeed = "low" | "full" | "high" | "super" | "super-plus";

/**
 * What the operator authorized. Serializable BY CONSTRUCTION, because it is
 * obtained on the main thread inside a click handler and then handed to a
 * session that may be in a worker.
 *
 * `matchedFilters` indexes into the filters that were requested, so the
 * session can tell which profile the grant actually covers. An earlier
 * draft passed only a bare `grantId` across, which meant the worker
 * received an identifier for a descriptor it had no way to resolve — the
 * grant changed shape at the boundary and the far side got the half without
 * the information in it.
 */
export interface GrantDescriptor {
  readonly grantId: GrantId;
  readonly matchedFilters: readonly number[];
}

export interface SerializableProfileFilter {
  readonly profileId: string;
  readonly transport: "serial" | "usb";
  readonly vendorId?: number;
  readonly productId?: number;
  readonly usbClass?: number;
}

/**
 * `stableKey` is ABSENT when assurance is "none", rather than present and
 * meaningless. A required string alongside "no assurance" invites a caller
 * to use it as a key, which is how the wrong board gets flashed on a bench
 * with four identical units.
 */
export type PhysicalDeviceIdentity = {
  readonly transport: "serial" | "usb" | "mock" | "replay";
  readonly vendorId?: number;
  readonly productId?: number;
  /** Raw descriptor text, including vendor whitespace or contradictions. */
  readonly manufacturerName?: string;
  /** Raw descriptor text; displayName is the human-formatted counterpart. */
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly portPath?: string;
  readonly usbInterface?: number;
  readonly usbSpeed?: UsbSpeed;
} & (
  | { readonly stableKeyAssurance: "serial-number" | "path-derived"; readonly stableKey: string }
  | { readonly stableKeyAssurance: "none"; readonly stableKey?: undefined }
);

export interface SerializableCandidate {
  readonly candidateId: CandidateId;
  readonly identity: PhysicalDeviceIdentity;
  readonly displayName: string;
  readonly matchedProfileId: string;
  /**
   * Candidates the grant cannot reliably narrow away from this entry. A
   * port path may distinguish current endpoints without identifying the
   * physical units attached to them.
   *
   * Id references into the full candidate list returned beside this entry.
   * Keeping summaries at the list level avoids recursive duplication while
   * still giving the operator every port path and descriptor observation.
   */
  readonly ambiguousWith?: readonly CandidateId[];
}

/**
 * APPLICATION / MAIN THREAD ONLY. Never proxied, never reachable from a
 * session. Called synchronously inside a user-gesture handler.
 *
 * This is a LOCAL interface: it is not part of the session RPC protocol and
 * has no wire representation. The only thing that crosses is its result.
 */
export interface PermissionBroker {
  requestGrant(filters: readonly SerializableProfileFilter[]): Promise<GrantDescriptor>;
}

/**
 * SESSION SIDE — the worker in the browser, in-process in Node.
 *
 * Deliberately has NO method capable of opening a chooser, in either host.
 * That absence is the enforcement; a documented convention is not. A
 * session that could summon a chooser would do so from a reconnect, a
 * retry, or a poll, at a moment nobody clicked anything.
 *
 * `open` returns a live DeviceConnection and is therefore NOT part of the
 * wire protocol — it is called by the session, on the session's own side.
 */
export interface AcquisitionService {
  listAuthorized(
    profiles: readonly string[],
    grant?: GrantDescriptor,
  ): Promise<readonly SerializableCandidate[]>;
}
