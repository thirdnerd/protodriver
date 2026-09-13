/**
 * Host-side resource envelopes, separate from maxima a module declares.
 * A declaration cannot contain itself. Where admission compares a declared
 * bound with a host envelope, an oversized declaration must be refused rather
 * than silently clamped: otherwise module and host disagree about behavior.
 *
 * Most values below are implementation defaults, not operator settings.
 */
export interface HostResourceLimits {
  // Transport
  readonly maximumBufferedBytesPerChannel: number;
  readonly maximumConcurrentTimers: number;

  // Bulk
  readonly maximumTransferWindowBytes: number;
  readonly maximumChunksInFlight: number;

  // RPC and resources
  readonly maximumRpcMessageBytes: number;
  readonly maximumResourceChunkBytes: number;

  // Diagnostics, events, capture
  readonly maximumDiagnosticBufferBytes: number;
  readonly maximumEventReplayCount: number;

  /**
   * Pending LOSSLESS events per subscriber. Lossless, non-blocking, and
   * unbounded session lifetime are three claims that cannot all hold: a
   * subscriber that stops reading grows a queue forever.
   *
   * Coalescible events (operation-progress, transfer-progress, state-cells)
   * do not consume a slot per update — they replace in place, so a stalled
   * UI costs one slot per operation and one per cell rather than one per
   * message.
   *
   * On overflow the SUBSCRIBER is terminated with `rpc.subscriber-overflow`,
   * never the session. One stalled UI must not take the device down mid-flash.
   */
  readonly maximumLosslessQueueDepth: number;

  /**
   * Finished operations whose results are retained for `awaitOperation`
   * before acknowledgement. Retention is what closes the race between a
   * fast operation and a caller that has not subscribed yet, so it needs a
   * bound or it is a leak with a nicer name. Oldest unacknowledged is
   * dropped first, and `SessionSnapshot.retainedResults` says what is
   * still collectable.
   */
  readonly maximumRetainedOperationResults: number;

  /**
   * A UI and a diagnostics window are both legitimate clients; an unbounded
   * number is not. The session ends when the last one detaches.
   */
  readonly maximumClientsPerSession: number;

  /* --------------------------------------------------------------- *
   * Cardinality
   *
   * Byte limits bound how big one thing may be. They say nothing about
   * how MANY things may exist. Without these bounds, a client could open
   * subscriptions until memory ran out without exceeding a single declared
   * maximum. A containment story with only size limits contains nothing
   * that arrives in quantity.
   * --------------------------------------------------------------- */
  readonly maximumPendingRpcCalls: number;
  readonly maximumSubscriptionsPerClient: number;
  readonly maximumDiagnosticSubscribers: number;
  readonly maximumConcurrentOperations: number;
  readonly maximumOpenResources: number;
  readonly maximumOutstandingBrokerCalls: number;
  readonly maximumCaptureParts: number;

  /**
   * A browser session recording a 16 MB transfer cannot accumulate it in
   * memory. Reaching this limit forces a streaming sink or fails the
   * recording loudly — it never quietly grows.
   */
  readonly maximumCaptureInMemoryBytes: number;
}

/** Owner-selected browser in-memory workload and its measured capacity basis. */
export const DEFAULT_CAPTURE_CAPACITY_POLICY = Object.freeze({
  supportedPayloadBytes: 1_048_576,
  measuredSourceCutBytes: 9_472_207,
  measuredCompleteBytes: 64_737_185,
  headroomNumerator: 11,
  headroomDenominator: 10,
  maximumQueueBytes: 4 * 1024 * 1024,
  maximumRetainedBytes: Math.ceil(64_737_185 * 11 / 10),
});

export const DEFAULT_HOST_RESOURCE_LIMITS: HostResourceLimits = {
  maximumBufferedBytesPerChannel: 4 * 1024 * 1024,
  maximumConcurrentTimers: 1024,

  maximumTransferWindowBytes: 4 * 1024 * 1024,
  maximumChunksInFlight: 64,

  maximumRpcMessageBytes: 8 * 1024 * 1024,
  maximumResourceChunkBytes: 1024 * 1024,

  maximumDiagnosticBufferBytes: 2 * 1024 * 1024,
  maximumEventReplayCount: 256,
  maximumLosslessQueueDepth: 1024,
  maximumRetainedOperationResults: 64,
  maximumClientsPerSession: 4,

  maximumPendingRpcCalls: 256,
  maximumSubscriptionsPerClient: 16,
  maximumDiagnosticSubscribers: 4,
  maximumConcurrentOperations: 32,
  maximumOpenResources: 64,
  maximumOutstandingBrokerCalls: 64,
  maximumCaptureParts: 4096,
  // The largest of three complete 1 MiB Device 3 captures was 64,737,185
  // encoded bytes. Retain 10% measured-population variance headroom, then add
  // the separately reserved browser capture queue to form the host envelope.
  maximumCaptureInMemoryBytes: DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes
    + DEFAULT_CAPTURE_CAPACITY_POLICY.maximumRetainedBytes,
};
