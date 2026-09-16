const SOURCE_SET_MAGIC = new TextEncoder().encode("PDRV-LUA-SOURCE-SET");
const SOURCE_SET_VERSION = 0x01;
const SOURCE_SET_ENTRY = "device.lua" as const;
const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type LuaBootstrapCompatibilityVerdict = "supported" | "unsupported";

export interface LuaPackageBootstrapCompatibility {
  readonly packageFormat: LuaBootstrapCompatibilityVerdict;
  readonly generatorContract: LuaBootstrapCompatibilityVerdict;
}

export interface LuaSourceMemberCandidate {
  readonly logicalName: string;
  readonly sourceBytes: Uint8Array;
}

export interface LuaSourceSetCandidate {
  readonly bootstrap: LuaPackageBootstrapCompatibility;
  readonly members: readonly LuaSourceMemberCandidate[];
}

export interface LuaSourceSetIdentity {
  readonly algorithm: "sha256";
  readonly hex: string;
}

export interface VerifiedLuaSourceSet {
  readonly identity: LuaSourceSetIdentity;
  readonly entryLogicalName: typeof SOURCE_SET_ENTRY;
  sourceBytes(logicalName: string, beforeCopy?: (length: number) => void): Uint8Array | undefined;
}

export type LuaSourceSetDiagnosticCode =
  | "lua-source-set.bootstrap.package-format-unsupported"
  | "lua-source-set.bootstrap.generator-contract-unsupported"
  | "lua-source-set.empty"
  | "lua-source-set.logical-name.invalid-utf8"
  | "lua-source-set.logical-name.duplicate"
  | "lua-source-set.source.invalid-utf8"
  | "lua-source-set.entry.missing"
  | "lua-source-set.framing.limit-exceeded";

export interface LuaSourceSetDiagnostic {
  readonly code: LuaSourceSetDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export class LuaSourceSetVerificationError extends Error {
  readonly responsibility = "definition" as const;
  readonly diagnostic: LuaSourceSetDiagnostic;

  constructor(diagnostic: LuaSourceSetDiagnostic) {
    super(`${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    this.name = "LuaSourceSetVerificationError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

interface PreparedSourceMember {
  readonly logicalName: string;
  readonly logicalNameBytes: Uint8Array;
  readonly sourceBytes: Uint8Array;
}

class VerifiedLuaSourceSetValue implements VerifiedLuaSourceSet {
  readonly identity: LuaSourceSetIdentity;
  readonly entryLogicalName = SOURCE_SET_ENTRY;
  readonly #sources: ReadonlyMap<string, Uint8Array>;

  constructor(identity: LuaSourceSetIdentity, members: readonly PreparedSourceMember[]) {
    this.identity = Object.freeze({ ...identity });
    this.#sources = new Map(members.map((member) => [member.logicalName, member.sourceBytes]));
    Object.freeze(this);
  }

  sourceBytes(logicalName: string, beforeCopy?: (length: number) => void): Uint8Array | undefined {
    const source = this.#sources.get(logicalName);
    if (source !== undefined) beforeCopy?.(source.length);
    return source === undefined ? undefined : Uint8Array.from(source);
  }
}

export async function verifyLuaSourceSet(candidate: LuaSourceSetCandidate): Promise<VerifiedLuaSourceSet> {
  verifyBootstrap(candidate.bootstrap);
  if (candidate.members.length === 0) {
    failure("lua-source-set.empty", "$sourceSet.members", "source set must contain at least device.lua");
  }

  const members = prepareMembers(candidate.members);
  if (!members.some((member) => member.logicalName === SOURCE_SET_ENTRY)) {
    failure("lua-source-set.entry.missing", "$sourceSet.members", "source set requires exact logical name device.lua");
  }

  const framed = framePreparedLuaSourceSetIdentity(members);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", framed));
  const identity = Object.freeze({
    algorithm: "sha256" as const,
    hex: [...digest].map((octet) => octet.toString(16).padStart(2, "0")).join(""),
  });
  return new VerifiedLuaSourceSetValue(identity, members);
}

/** Mechanism seam for the hand-authored framing anchor; not exported at the package root. */
export function frameLuaSourceSetIdentityBytes(
  members: readonly LuaSourceMemberCandidate[],
): Uint8Array {
  return framePreparedLuaSourceSetIdentity(prepareMembers(members));
}

function verifyBootstrap(bootstrap: LuaPackageBootstrapCompatibility): void {
  if (bootstrap.packageFormat !== "supported") {
    failure(
      "lua-source-set.bootstrap.package-format-unsupported",
      "$bootstrap.packageFormat",
      "package format is not supported by this host",
    );
  }
  if (bootstrap.generatorContract !== "supported") {
    failure(
      "lua-source-set.bootstrap.generator-contract-unsupported",
      "$bootstrap.generatorContract",
      "Lua generator contract is not supported by this host",
    );
  }
}

function prepareMembers(members: readonly LuaSourceMemberCandidate[]): readonly PreparedSourceMember[] {
  if (members.length > 0xffff_ffff) {
    failure("lua-source-set.framing.limit-exceeded", "$sourceSet.members", "member count exceeds u32 framing");
  }

  const prepared: PreparedSourceMember[] = [];
  const seen = new Set<string>();
  for (const [index, member] of members.entries()) {
    const path = `$sourceSet.members[${index}]`;
    const logicalNameBytes = encodeScalarString(member.logicalName, `${path}.logicalName`);
    if (seen.has(member.logicalName)) {
      failure(
        "lua-source-set.logical-name.duplicate",
        `${path}.logicalName`,
        `logical name ${JSON.stringify(member.logicalName)} is duplicated`,
      );
    }
    seen.add(member.logicalName);
    if (!(member.sourceBytes instanceof Uint8Array)) {
      failure("lua-source-set.source.invalid-utf8", `${path}.sourceBytes`, "source must be Uint8Array UTF-8 bytes");
    }
    const sourceBytes = Uint8Array.from(member.sourceBytes);
    try {
      fatalUtf8Decoder.decode(sourceBytes);
    } catch {
      failure("lua-source-set.source.invalid-utf8", `${path}.sourceBytes`, "source bytes are not fatal UTF-8");
    }
    prepared.push(Object.freeze({ logicalName: member.logicalName, logicalNameBytes, sourceBytes }));
  }
  prepared.sort((left, right) => compareBytes(left.logicalNameBytes, right.logicalNameBytes));
  return Object.freeze(prepared);
}

function framePreparedLuaSourceSetIdentity(members: readonly PreparedSourceMember[]): Uint8Array {
  let byteLength = SOURCE_SET_MAGIC.byteLength + 1 + 1 + 4;
  for (const [index, member] of members.entries()) {
    assertU32(member.logicalNameBytes.byteLength, `$sourceSet.members[${index}].logicalName`);
    assertU32(member.sourceBytes.byteLength, `$sourceSet.members[${index}].sourceBytes`);
    byteLength += 4 + member.logicalNameBytes.byteLength + 4 + member.sourceBytes.byteLength;
  }
  const framed = new Uint8Array(byteLength);
  const view = new DataView(framed.buffer);
  let offset = 0;
  framed.set(SOURCE_SET_MAGIC, offset);
  offset += SOURCE_SET_MAGIC.byteLength;
  framed[offset] = 0x00;
  offset += 1;
  framed[offset] = SOURCE_SET_VERSION;
  offset += 1;
  view.setUint32(offset, members.length, false);
  offset += 4;
  for (const member of members) {
    view.setUint32(offset, member.logicalNameBytes.byteLength, false);
    offset += 4;
    framed.set(member.logicalNameBytes, offset);
    offset += member.logicalNameBytes.byteLength;
    view.setUint32(offset, member.sourceBytes.byteLength, false);
    offset += 4;
    framed.set(member.sourceBytes, offset);
    offset += member.sourceBytes.byteLength;
  }
  return framed;
}

function encodeScalarString(value: string, path: string): Uint8Array {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        failure("lua-source-set.logical-name.invalid-utf8", path, "logical name contains an unpaired high surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      failure("lua-source-set.logical-name.invalid-utf8", path, "logical name contains an unpaired low surrogate");
    }
  }
  return utf8Encoder.encode(value);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function assertU32(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    failure("lua-source-set.framing.limit-exceeded", path, "length exceeds u32 framing");
  }
}

function failure(code: LuaSourceSetDiagnosticCode, path: string, message: string): never {
  throw new LuaSourceSetVerificationError({ code, path, message });
}
