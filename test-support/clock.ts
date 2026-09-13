import type { Clock, Disposable } from "@protodriver/contracts";

const MICROSECONDS_PER_MILLISECOND = 1_000;

function requireFiniteNonNegative(value: number, name: string): number {
  if(!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function delayUs(milliseconds: number): number {
  return Math.ceil(
    requireFiniteNonNegative(milliseconds, "delay")
      * MICROSECONDS_PER_MILLISECOND,
  );
}

function nextSequence(current: number): number {
  if(current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("clock sequence exhausted Number.MAX_SAFE_INTEGER");
  }
  return current + 1;
}

class CallbackDisposable implements Disposable {
  #callback: (() => void) | undefined;

  constructor(callback: () => void) {
    this.#callback = callback;
  }

  dispose(): void {
    const callback = this.#callback;
    this.#callback = undefined;
    callback?.();
  }
}

interface ScheduledTimer {
  readonly dueUs: number;
}

interface TimerSeries {
  cancelled: boolean;
}

interface QueuedTimer {
  readonly dueUs: number;
  readonly order: number;
  readonly callback: () => void;
  readonly series: TimerSeries;
  readonly intervalUs?: number;
}

/** Deterministic Clock implementation for tests and controlled experiments. */
export class VirtualClock implements Clock {
  readonly resolutionUs = 1;
  readonly #wallClockStartMs: number;
  #nowUs = 0;
  #sequence = 0;
  #scheduleOrder = 0;
  #queue: QueuedTimer[] = [];
  #advancing = false;

  constructor(wallClockStartUnixMs = 0) {
    this.#wallClockStartMs = requireFiniteNonNegative(
      wallClockStartUnixMs,
      "wall clock start",
    );
  }

  monotonicUs(): number {
    return this.#nowUs;
  }

  wallClockUnixMs(): number {
    return this.#wallClockStartMs
      + this.#nowUs / MICROSECONDS_PER_MILLISECOND;
  }

  nextSequence(): number {
    this.#sequence = nextSequence(this.#sequence);
    return this.#sequence;
  }

  get pending(): readonly ScheduledTimer[] {
    const pending = this.#orderedQueue().map(({ dueUs }) =>
      Object.freeze({ dueUs }));
    return Object.freeze(pending);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if(signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise((resolve, reject) => {
      const scheduled = this.timer(ms, () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      const abort = (): void => {
        scheduled.dispose();
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  timer(ms: number, fn: () => void): Disposable {
    return this.#schedule(delayUs(ms), fn);
  }

  interval(ms: number, fn: () => void): Disposable {
    const intervalUs = delayUs(ms);
    if(intervalUs === 0) {
      throw new RangeError("interval must be at least one microsecond");
    }
    return this.#schedule(intervalUs, fn, intervalUs);
  }

  async advance(us: number): Promise<void> {
    requireFiniteNonNegative(us, "advance");
    if(this.#advancing) {
      throw new Error("VirtualClock.advance must not overlap");
    }
    const targetUs = this.#nowUs + us;
    if(!Number.isSafeInteger(targetUs)) {
      throw new RangeError("virtual monotonic time exceeds the safe integer range");
    }

    this.#advancing = true;
    try {
      for(;;) {
        const next = this.#takeNextDue(targetUs);
        if(next === undefined) break;
        if(next.series.cancelled) continue;

        this.#nowUs = next.dueUs;
        try {
          next.callback();
        } finally {
          if(next.intervalUs !== undefined && !next.series.cancelled) {
            this.#enqueue({
              dueUs: next.dueUs + next.intervalUs,
              callback: next.callback,
              series: next.series,
              intervalUs: next.intervalUs,
            });
          }
        }

        // Let a resolved sleep continuation schedule work at this same
        // instant before selecting the next due timer. Scheduling order still
        // keeps that work behind timers which were already due.
        await Promise.resolve();
      }
      this.#nowUs = targetUs;
    } finally {
      this.#advancing = false;
    }
  }

  #schedule(
    afterUs: number,
    callback: () => void,
    intervalUs?: number,
  ): Disposable {
    const series: TimerSeries = { cancelled: false };
    this.#enqueue({
      dueUs: this.#nowUs + afterUs,
      callback,
      series,
      ...(intervalUs === undefined ? {} : { intervalUs }),
    });
    return new CallbackDisposable(() => {
      series.cancelled = true;
      this.#queue = this.#queue.filter((timer) => timer.series !== series);
    });
  }

  #enqueue(timer: Omit<QueuedTimer, "order">): void {
    this.#scheduleOrder = nextSequence(this.#scheduleOrder);
    this.#queue.push({ ...timer, order: this.#scheduleOrder });
  }

  #orderedQueue(): readonly QueuedTimer[] {
    const ordered = this.#queue
      .filter(({ series }) => !series.cancelled);
    ordered.sort((left, right) =>
      left.dueUs - right.dueUs || left.order - right.order);
    return ordered;
  }

  #takeNextDue(targetUs: number): QueuedTimer | undefined {
    let selectedIndex = -1;
    let selected: QueuedTimer | undefined;

    for(let index = 0; index < this.#queue.length; index += 1) {
      const candidate = this.#queue[index];
      if(candidate === undefined || candidate.series.cancelled) continue;
      if(candidate.dueUs > targetUs) continue;
      if(selected === undefined
          || candidate.dueUs < selected.dueUs
          || (candidate.dueUs === selected.dueUs
              && candidate.order < selected.order)) {
        selected = candidate;
        selectedIndex = index;
      }
    }

    if(selectedIndex >= 0) this.#queue.splice(selectedIndex, 1);
    return selected;
  }
}
