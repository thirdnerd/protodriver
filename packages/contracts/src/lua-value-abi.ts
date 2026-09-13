/**
 * Executable kind authority for PDRV value ABI version 1.
 *
 * The specification owns each kind's meaning. This registry owns the complete
 * tag population consumed by structural corpus coverage; a fixture or test
 * must not maintain a second completeness list.
 */
export const LUA_VALUE_ABI_V1_VALUE_KIND_TAGS = Object.freeze({
  false: 0x01,
  true: 0x02,
  "signed-bounded-integer": 0x03,
  "unsigned-bounded-integer": 0x04,
  "arbitrary-integer": 0x05,
  "finite-float": 0x06,
  text: 0x07,
  bytes: 0x08,
  array: 0x09,
  record: 0x0a,
  "tagged-variant": 0x0b,
  null: 0x0c,
} as const);

export type LuaValueAbiV1ValueKind = keyof typeof LUA_VALUE_ABI_V1_VALUE_KIND_TAGS;
export type LuaValueAbiV1ValueKindTag = (typeof LUA_VALUE_ABI_V1_VALUE_KIND_TAGS)[LuaValueAbiV1ValueKind];

export function isLuaValueAbiV1ValueKind(value: unknown): value is LuaValueAbiV1ValueKind {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(LUA_VALUE_ABI_V1_VALUE_KIND_TAGS, value);
}
