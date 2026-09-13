import assert from "node:assert/strict";
import test from "node:test";
import { resolveLuaResourcePolicy, LUA_RESOURCE_POLICY_MAXIMA } from "../src/resource-policy.ts";
import { resolveRetainedLuaPolicy } from "../src/retained.ts";

test("retained policy keeps the three supported byte and allocation limits", () => {
  const policy = resolveRetainedLuaPolicy({ maximumEncodedInputBytes: 7, maximumEncodedOutputBytes: 8, maximumVmAllocationBytes: 9 });
  assert.deepEqual(policy, { maximumEncodedInputBytes: 7, maximumEncodedOutputBytes: 8, maximumVmAllocationBytes: 9 });
  assert.throws(() => resolveRetainedLuaPolicy({ maximumFuel: 1 }), /unsupported retained/u);
});

test("policy ceilings reject requests beyond hard maxima", () => {
  assert.throws(() => resolveLuaResourcePolicy({ maximumVmAllocationBytes: LUA_RESOURCE_POLICY_MAXIMA.maximumVmAllocationBytes + 1 }), /lua-vm\.resource\.policy-limit/u);
});
