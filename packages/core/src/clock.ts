import type {
  Clock,
  Disposable,
} from "@protodriver/contracts";

const RESOLUTION_SAMPLE_LIMIT = 100_000;
const RESOLUTION_CHANGES_REQUIRED = 32;
const MICROSECONDS_PER_MILLISECOND = 1_000;

function requireFiniteNonNegative(value: number, name: string): number {
  if(!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function nextSequence(current: number): number {
  if(current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("clock sequence exhausted Number.MAX_SAFE_INTEGER");
  }
  return current + 1;
}

function measureResolutionUs(readMilliseconds: () => number): {
  readonly originMs: number;
  readonly resolutionUs: number;
} {
  const originMs = readMilliseconds();
  let previousMs = originMs;
  let minimumUs = Number.POSITIVE_INFINITY;
  let changes = 0;

  for(let sample = 0;
      sample < RESOLUTION_SAMPLE_LIMIT
        && changes < RESOLUTION_CHANGES_REQUIRED;
      sample += 1) {
    const currentMs = readMilliseconds();
    const deltaUs = (currentMs - previousMs) * MICROSECONDS_PER_MILLISECOND;
    if(deltaUs > 0) {
      minimumUs = Math.min(minimumUs, deltaUs);
      changes += 1;
    }
    previousMs = currentMs;
  }

  return {
    originMs,
    resolutionUs: Number.isFinite(minimumUs) ? Math.max(1, minimumUs) : 1,
  };
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

/** Clock backed by the host's monotonic and wall-clock sources. */
export class RealClock implements Clock {
  readonly resolutionUs: number;
  readonly #originMs: number;
  #sequence = 0;

  constructor() {
    const measured = measureResolutionUs(() => performance.now());
    this.#originMs = measured.originMs;
    this.resolutionUs = measured.resolutionUs;
  }

  monotonicUs(): number {
    return (performance.now() - this.#originMs)
      * MICROSECONDS_PER_MILLISECOND;
  }

  wallClockUnixMs(): number {
    return Date.now();
  }

  nextSequence(): number {
    this.#sequence = nextSequence(this.#sequence);
    return this.#sequence;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    requireFiniteNonNegative(ms, "delay");
    if(signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise((resolve, reject) => {
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = (): void => {
        clearTimeout(handle);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  timer(ms: number, fn: () => void): Disposable {
    requireFiniteNonNegative(ms, "delay");
    const handle = setTimeout(fn, ms);
    return new CallbackDisposable(() => clearTimeout(handle));
  }

  interval(ms: number, fn: () => void): Disposable {
    requireFiniteNonNegative(ms, "delay");
    const handle = setInterval(fn, ms);
    return new CallbackDisposable(() => clearInterval(handle));
  }
}
