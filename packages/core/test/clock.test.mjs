import assert from "node:assert/strict";
import test from "node:test";

import { RealClock } from "../src/clock.ts";

test("resolution is sampled from the monotonic source at construction", () => {
  const originalPerformance = globalThis.performance;
  let now = 10;
  let sample = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now() {
        sample += 1;
        if(sample % 2 === 0) now += 0.005;
        return now;
      },
    },
  });

  try {
    const clock = new RealClock();
    assert.ok(Math.abs(clock.resolutionUs - 5) < 1e-6);
  } finally {
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: originalPerformance,
    });
  }
});

test("measured sub-microsecond resolution is reported as one microsecond", () => {
  const originalPerformance = globalThis.performance;
  let now = 20;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now() {
        now += 0.00025;
        return now;
      },
    },
  });

  try {
    assert.equal(new RealClock().resolutionUs, 1);
  } finally {
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: originalPerformance,
    });
  }
});
