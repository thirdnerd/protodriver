/**
 * Shared declarations and boundary contracts for Protodriver.
 *
 * This barrel exposes wire DTOs, host-local interfaces, authored description
 * shapes, and transfer-adapter vocabulary. A declaration here does not by
 * itself mean a product host admits or executes it. Transfer adapters supply
 * protocol-specific observations; authored-v2 sessions execute through the
 * retained Lua runtime, not a declarative protocol-contract interpreter.
 *
 * Rules:
 *   - No `unknown` in a public signature. Open values are PublicValue or a
 *     declared union.
 *   - Anything crossing RPC must be structured-clone-safe. Live objects —
 *     connections, channels, leases, sources — are absent from RPC messages.
 *   - Opaque placeholders are branded types, so they are deliberate rather
 *     than accidental omissions.
 *
 * The live objects are here ON PURPOSE. An earlier draft covered only the
 * RPC surface, which meant a compiler could not see the objects that must
 * NOT reach a message — and three of them leaked into one anyway. Having
 * both sides in view is what lets wire-guard.ts assert the difference.
 *
 * This is the TypeScript declaration surface selected by the package's
 * `types` export condition. Node executes runtime.js instead; relative `.js`
 * specifiers here are therefore resolved by TypeScript and erased where the
 * corresponding declaration has no runtime value.
 */
export type { Brand } from "./brand.js";
export * from "./values.js";
export type { AuthoredConnectionProfile, AuthoredInputRetirement, AuthoredClockObservation, AuthoredExpiryObservation, AuthoredDescription, AuthoredOperation, AuthoredOperationArgument, AuthoredValueType, AuthoredSourceArgument, AuthoredChannelRoles, AuthoredResourceResult, AuthoredStateCell, AuthoredHandler, AuthoredPollRefresh, AuthoredPollPolicy } from "./authored.js";
export * from "./units.js";
export * from "./limits.js";
export * from "./sizing.js";
export * from "./clock.js";
export * from "./acquisition.js";
export * from "./transport.js";
export * from "./resources.js";
export * from "./session.js";
export * from "./raw-terminal.js";
export * from "./capture.js";
export * from "./transfer.js";
export {
  isLuaValueAbiV1ValueKind,
  LUA_VALUE_ABI_V1_VALUE_KIND_TAGS,
} from "./lua-value-abi.js";
export type {
  LuaValueAbiV1ValueKind,
  LuaValueAbiV1ValueKindTag,
} from "./lua-value-abi.js";
export {
  LuaSourceSetVerificationError,
  verifyLuaSourceSet,
} from "./lua-source-set.js";
export {
  buildPdpkg,
  PdpkgReadError,
  readPdpkg,
  readAuthoredDirectorySnapshot,
} from "./pdpkg.js";
export type {
  PdpkgBuildResult,
  PdpkgClaimLevels,
  PdpkgDiagnostic,
  PdpkgDiagnosticCode,
  PdpkgReadResult,
} from "./pdpkg.js";
export type {
  LuaBootstrapCompatibilityVerdict,
  LuaPackageBootstrapCompatibility,
  LuaSourceMemberCandidate,
  LuaSourceSetCandidate,
  LuaSourceSetDiagnostic,
  LuaSourceSetDiagnosticCode,
  LuaSourceSetIdentity,
  VerifiedLuaSourceSet,
} from "./lua-source-set.js";

// Compile-time proof that the wire types are clone-safe, plus negative
// controls proving the check still rejects what it should. Importing it
// here is what puts it on the `tsc --noEmit` path.
export * from "./wire-guard.js";
