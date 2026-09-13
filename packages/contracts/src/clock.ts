import type { Disposable } from "./session.js";

/**
 * The single source of session time and total ordering.
 *
 * Sequence determines precedence. Timestamps describe when an observation
 * happened, but two observations may legitimately have the same timestamp.
 */
export interface Clock {
  /** Microseconds since session start, immune to wall-clock adjustment. */
  monotonicUs(): number;

  /** Best measured resolution of the underlying monotonic source. */
  readonly resolutionUs: number;

  /** Unix milliseconds for human correlation only, never ordering. */
  wallClockUnixMs(): number;

  /** Session-wide total order, monotonic and never reused. */
  nextSequence(): number;

  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  timer(ms: number, fn: () => void): Disposable;
  interval(ms: number, fn: () => void): Disposable;
}

/**
 * An overdue heartbeat proves that execution continuity was not observed.
 * Raw deltas preserve what each host clock reported without claiming that a
 * particular operating-system sleep state caused the gap.
 */
export interface SuspendEvent {
  readonly observedGapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatLateByMs: number;
  readonly wallDeltaMs: number;
  readonly monotonicDeltaMs: number;
  readonly detectedAtSequence: number;
  readonly source: "heartbeat-overdue";
}
