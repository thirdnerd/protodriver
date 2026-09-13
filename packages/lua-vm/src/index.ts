// Reproducible source/toolchain recipe for the shipped retained VM. Binary
// identity and the digests of its inputs live in artifacts/*.wasm.json.
export const RETAINED_LUA_BUILD_RECIPE = Object.freeze({
  lua: Object.freeze({
    version: "5.5.1",
    sourceArchiveSha256: "1c4b4068d67061f2a2231ad2b5422e77acea1487ea9890f6320af614f4373dce",
    sourceSetSha256: "c0a63d4d1ac35dad034a552385c14ce98823ad0a7cd250dded744ff0207162c1",
    sourceMemberCount: 61,
    integerBits: 64,
    numberBits: 64,
    deterministicSeedHex: "50445256",
  }),
  expectedVm: Object.freeze({
    artifactContract: 11,
    smokeResult: 42,
  }),
  emscripten: Object.freeze({
    version: "6.0.8",
    commit: "aeb67926e7de656da38bc807d83050af93578758",
    emsdkCheckoutCommit: "e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59",
  }),
  inputs: Object.freeze({
    bridgeSha256: "4eb42b632206004d98cc11b9309993deedc466a5bc3de0c5cca401eb39cb7529",
    sourceVerifierSha256: "f15b97b4e8b001a75cb3b074d9ccebd79c9adc22d55f2d2bacde189737dc0d27",
    compiledLuaSources: Object.freeze([
      "lapi.c", "lcode.c", "lctype.c", "ldebug.c", "ldo.c", "ldump.c", "lfunc.c",
      "lgc.c", "llex.c", "lmem.c", "lobject.c", "lopcodes.c", "lparser.c", "lstate.c",
      "lstring.c", "ltable.c", "ltm.c", "lundump.c", "lvm.c", "lzio.c", "lauxlib.c",
      "lbaselib.c", "lcorolib.c", "lmathlib.c", "lstrlib.c", "ltablib.c", "lutf8lib.c",
    ]),
    flags: Object.freeze([
      "-O2", "-flto", "-DNDEBUG", "-ULUA_32BITS", "-ULUA_USE_C89",
      "-Dluai_makeseed()=0x50445256u", "-sSTANDALONE_WASM=1", "-sFILESYSTEM=0",
      "-sMALLOC=emmalloc", "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=16777216",
      "-sSTACK_SIZE=65536", "-sASSERTIONS=0", "-sSUPPORT_LONGJMP=wasm",
      "-sERROR_ON_UNDEFINED_SYMBOLS=1", "--no-entry",
    ]),
  }),
} as const);
