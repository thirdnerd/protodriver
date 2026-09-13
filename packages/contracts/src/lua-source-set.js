// TypeScript resolves the declaration-style .js specifier to lua-source-set.ts;
// plain Node needs this runtime bridge when pdpkg.ts calls the shared verifier.
export { verifyLuaSourceSet } from "./lua-source-set.ts";
