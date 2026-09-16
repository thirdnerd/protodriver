export interface LuaResourcePolicy {
  readonly maximumEncodedInputBytes: number;
  readonly maximumEncodedOutputBytes: number;
  readonly maximumVmAllocationBytes: number;
}

export const LUA_RESOURCE_POLICY_DEFAULTS: LuaResourcePolicy = Object.freeze({
  maximumEncodedInputBytes: 1_048_576,
  maximumEncodedOutputBytes: 1_048_576,
  maximumVmAllocationBytes: 16_777_216,
});

export const LUA_RESOURCE_POLICY_MAXIMA: LuaResourcePolicy = Object.freeze({
  maximumEncodedInputBytes: 4_194_304,
  maximumEncodedOutputBytes: 4_194_304,
  maximumVmAllocationBytes: 67_108_864,
});

export type LuaResourcePolicyRequest = Partial<LuaResourcePolicy>;

/** Explicit product failure; callers assign responsibility for the admission or execution context. */
export class LuaResourceError extends Error {
  declare readonly code: string;
  declare readonly fuelConsumed?: number;

  constructor(code: string, detail: string, fuelConsumed?: number) {
    super(detail.startsWith(`${code}:`) ? detail : `${code}: ${detail}`);
    this.name = "LuaResourceError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
    if (fuelConsumed !== undefined) {
      Object.defineProperty(this, "fuelConsumed", { value: fuelConsumed, enumerable: true });
    }
  }
}

export function resolveLuaResourcePolicy(request: LuaResourcePolicyRequest = {}): LuaResourcePolicy {
  return Object.freeze({
    maximumEncodedInputBytes: member("maximumEncodedInputBytes", request),
    maximumEncodedOutputBytes: member("maximumEncodedOutputBytes", request),
    maximumVmAllocationBytes: member("maximumVmAllocationBytes", request),
  });
}

export function luaResourceError(code: string, detail: string, fuelConsumed?: number): LuaResourceError {
  return new LuaResourceError(code, detail, fuelConsumed);
}

function member(name: keyof LuaResourcePolicy, request: LuaResourcePolicyRequest): number {
  const value = request[name] ?? LUA_RESOURCE_POLICY_DEFAULTS[name];
  if (!Number.isSafeInteger(value) || value <= 0 || value > LUA_RESOURCE_POLICY_MAXIMA[name]) {
    throw luaResourceError(
      "lua-vm.resource.policy-limit",
      `${name} must be a positive integer no greater than ${LUA_RESOURCE_POLICY_MAXIMA[name]}; observed ${value}`,
    );
  }
  return value;
}
