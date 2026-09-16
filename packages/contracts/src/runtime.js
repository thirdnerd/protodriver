// Node runtime surface for the package root. TypeScript consumers use
// index.ts through the package's `types` condition; keep runtime values here
// so Node never evaluates the declaration barrel's erased `.js` specifiers.
export { isPdrFailureResponsibility, NOT_REPRESENTABLE } from "./values.ts";
export { SEMANTIC_UNIT_IDENTIFIERS } from "./units.ts";
export { TRANSFER_DIGEST_ALGORITHMS, isTransferDigestAlgorithm } from "./transfer.ts";
export { DEFAULT_CAPTURE_CAPACITY_POLICY, DEFAULT_HOST_RESOURCE_LIMITS } from "./limits.ts";
export { SIZE_NODE_OVERHEAD } from "./sizing.ts";
export { LUA_VALUE_ABI_V1_VALUE_KIND_TAGS, isLuaValueAbiV1ValueKind } from "./lua-value-abi.ts";
export {
  LuaSourceSetVerificationError,
  verifyLuaSourceSet,
} from "./lua-source-set.ts";
export { buildPdpkg, PdpkgReadError, readPdpkg, readAuthoredDirectorySnapshot } from "./pdpkg.ts";
