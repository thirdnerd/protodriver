import { verifyLuaSourceSet } from "./lua-source-set.js";
import type {
  LuaPackageBootstrapCompatibility,
  LuaSourceMemberCandidate,
  LuaSourceSetCandidate,
  LuaSourceSetIdentity,
} from "./lua-source-set.js";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x0403_4b50;
const ZIP64_END_SIGNATURE = 0x0606_4b50;
const ZIP64_LOCATOR_SIGNATURE = 0x0706_4b50;
const STORED_METHOD = 0;
const DEFLATE_METHOD = 8;
const UTF8_FLAG = 1 << 11;
const ENCRYPTED_FLAG = 1 << 0;
const DATA_DESCRIPTOR_FLAG = 1 << 3;
const SUPPORTED_VERSION = 1;
const MAX_MEMBERS = 64;
const MAX_NAME_BYTES = 255;
const MAX_SEGMENT_BYTES = 64;
const MAX_MEMBER_EXPANDED_BYTES = 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_COMMENT_BYTES = 1024;
const MAX_MEMBER_COMMENT_BYTES = 1024;
const MAX_EXTRA_FIELD_BYTES = 4096;
const MAX_ZIP_COMMENT_FIELD_BYTES = 0xffff;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

export type PdpkgDiagnosticCode =
  | "pdpkg.archive.invalid"
  | "pdpkg.archive.encrypted"
  | "pdpkg.archive.data-descriptor"
  | "pdpkg.archive.zip64-record"
  | "pdpkg.archive.zip64-sentinel"
  | "pdpkg.archive.spanned"
  | "pdpkg.archive.comment-limit"
  | "pdpkg.archive.member-count-limit"
  | "pdpkg.archive.expanded-limit"
  | "pdpkg.member.compression-method"
  | "pdpkg.member.comment-limit"
  | "pdpkg.member.extra-field-limit"
  | "pdpkg.member.name-invalid-utf8"
  | "pdpkg.member.name-utf8-flag-required"
  | "pdpkg.member.name-empty"
  | "pdpkg.member.name-absolute"
  | "pdpkg.member.name-backslash"
  | "pdpkg.member.name-nul"
  | "pdpkg.member.name-control"
  | "pdpkg.member.name-directory"
  | "pdpkg.member.name-dot-segment"
  | "pdpkg.member.name-dotdot-segment"
  | "pdpkg.member.name-duplicate"
  | "pdpkg.member.name-case-collision"
  | "pdpkg.member.name-length-limit"
  | "pdpkg.member.segment-length-limit"
  | "pdpkg.member.local-name-mismatch"
  | "pdpkg.member.local-method-mismatch"
  | "pdpkg.member.local-crc-mismatch"
  | "pdpkg.member.local-compressed-size-mismatch"
  | "pdpkg.member.local-expanded-size-mismatch"
  | "pdpkg.member.expanded-limit"
  | "pdpkg.member.expanded-size-mismatch"
  | "pdpkg.member.crc-mismatch"
  | "pdpkg.bootstrap.missing"
  | "pdpkg.bootstrap.invalid-utf8"
  | "pdpkg.bootstrap.invalid-json"
  | "pdpkg.bootstrap.invalid-shape"
  | "pdpkg.bootstrap.source-set-sha256-invalid"
  | "pdpkg.integrity.source-set-mismatch";

export interface PdpkgDiagnostic {
  readonly code: PdpkgDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export class PdpkgReadError extends Error {
  readonly responsibility = "definition" as const;
  readonly diagnostic: PdpkgDiagnostic;
  declare readonly sourceMember?: string;

  constructor(diagnostic: PdpkgDiagnostic, sourceMember?: string) {
    super(`${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    this.name = "PdpkgReadError";
    this.diagnostic = Object.freeze({ ...diagnostic });
    if (sourceMember !== undefined) Object.defineProperty(this, "sourceMember", { value: sourceMember });
  }
}

interface CentralMember {
  readonly index: number;
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly localHeaderOffset: number;
}

interface LocatedMember extends CentralMember {
  readonly compressedBytes: Uint8Array;
  readonly localRecordEnd: number;
}

export interface PdpkgClaimLevels {
  /** An absent declaration is legacy compatibility, not a failed claim. */
  readonly integrity: "reached" | "not-evaluated";
}

export interface PdpkgReadResult extends LuaSourceSetCandidate {
  readonly claimLevels: PdpkgClaimLevels;
}

export interface PdpkgBuildResult {
  readonly archive: Uint8Array;
  readonly sourceSetIdentity: LuaSourceSetIdentity;
}

/** Data-only directory snapshot uses exactly the archive member/bootstrap rules. */
export async function readAuthoredDirectorySnapshot(members: readonly LuaSourceMemberCandidate[]): Promise<PdpkgReadResult> {
  enforceMemberCount(members.length);
  let total = 0;
  for (const member of members) {
    enforceNameLength(utf8Encoder.encode(member.logicalName).length, member.logicalName);
    enforceMemberExpandedLimit(member.sourceBytes.length, member.logicalName);
    total += member.sourceBytes.length;
    enforceArchiveExpandedLimit(total);
  }
  return readPdpkg(encodeStoredZip(members));
}

interface ParsedBootstrap {
  readonly compatibility: LuaPackageBootstrapCompatibility;
  readonly sourceSetSha256?: string;
}

/**
 * Builds the deterministic stored-member `.pdpkg` representation of one Lua
 * source set. Package versions and the adjacent source-set identity are
 * derived here; callers supply only the executable source population.
 */
export async function buildPdpkg(sourceMembers: readonly LuaSourceMemberCandidate[]): Promise<PdpkgBuildResult> {
  return buildPackage(sourceMembers);
}

async function buildPackage(
  sourceMembers: readonly LuaSourceMemberCandidate[],
): Promise<PdpkgBuildResult> {
  const members = sourceMembers.map((member) => Object.freeze({
    logicalName: member.logicalName,
    sourceBytes: Uint8Array.from(member.sourceBytes),
  }));
  members.sort((left, right) => compareBytes(
    utf8Encoder.encode(left.logicalName),
    utf8Encoder.encode(right.logicalName),
  ));
  const sourceSet = Object.freeze({
    bootstrap: Object.freeze({
      packageFormat: "supported" as const,
      generatorContract: "supported" as const,
    }),
    members: Object.freeze(members),
  });
  const expected = await verifyLuaSourceSet(sourceSet);
  const bootstrapBytes = utf8Encoder.encode(`${JSON.stringify({
    packageFormat: SUPPORTED_VERSION,
    generatorContract: 2,
    sourceSetSha256: expected.identity.hex,
  })}\n`);
  const archive = encodeStoredZip([
    Object.freeze({ logicalName: "pdpkg.json", sourceBytes: bootstrapBytes }),
    ...members,
  ]);

  const read = await readPdpkg(archive);
  if (read.claimLevels.integrity !== "reached") {
    throw new Error("pdpkg.build.integrity-not-reached: generated package omitted its derived identity");
  }
  const admitted = await verifyLuaSourceSet(read);
  if (admitted.identity.hex !== expected.identity.hex) {
    throw new Error(
      `pdpkg.build.identity-mismatch: generated ${admitted.identity.hex}; expected ${expected.identity.hex}`,
    );
  }
  return Object.freeze({
    archive,
    sourceSetIdentity: expected.identity,
  });
}

/**
 * Reads the bounded `.pdpkg` ZIP subset into the source-set candidate and
 * evaluates an adjacent source-set claim when one is declared. The check uses
 * the shared frozen framing; pdpkg.json itself is never a source member.
 */
export async function readPdpkg(archiveBytes: Uint8Array): Promise<PdpkgReadResult> {
  if (!(archiveBytes instanceof Uint8Array)) {
    failure("pdpkg.archive.invalid", "$archive", "archive bytes must be a Uint8Array");
  }
  const bytes = Uint8Array.from(archiveBytes);
  const members = locateMembers(bytes);
  const bootstrapMember = members.find((member) => member.name === "pdpkg.json");
  if (bootstrapMember === undefined) {
    failure("pdpkg.bootstrap.missing", "$archive", "archive requires exact member pdpkg.json");
  }

  let expandedTotal = 0;
  async function readExpandedMember(member: LocatedMember): Promise<Uint8Array> {
    enforceMemberExpandedLimit(member.expandedSize, memberPath(member));
    enforceArchiveExpandedLimit(expandedTotal + member.expandedSize);
    const memberBytes = await expandMember(member, expandedTotal);
    enforceMemberExpandedLimit(memberBytes.byteLength, memberPath(member));
    enforceArchiveExpandedLimit(expandedTotal + memberBytes.byteLength);
    if (memberBytes.byteLength !== member.expandedSize) {
      failure(
        "pdpkg.member.expanded-size-mismatch",
        memberPath(member),
        `expanded ${memberBytes.byteLength} bytes but central directory declares ${member.expandedSize}`,
      );
    }
    enforceCrc(member, memberBytes);
    expandedTotal += memberBytes.byteLength;
    return memberBytes;
  }

  const parsedBootstrap = parseBootstrap(await readExpandedMember(bootstrapMember));
  const sourceMembers: LuaSourceMemberCandidate[] = [];
  for (const member of members) {
    if (member === bootstrapMember) continue;
    sourceMembers.push(Object.freeze({
      logicalName: member.name,
      sourceBytes: await readExpandedMember(member),
    }));
  }
  const sourceSet = Object.freeze({
    bootstrap: parsedBootstrap.compatibility,
    members: Object.freeze(sourceMembers),
  });
  if (parsedBootstrap.sourceSetSha256 === undefined) {
    return Object.freeze({
      ...sourceSet,
      claimLevels: Object.freeze({ integrity: "not-evaluated" as const }),
    });
  }
  const computed = (await verifyLuaSourceSet(sourceSet)).identity;
  enforceSourceSetIdentity(parsedBootstrap.sourceSetSha256, computed);
  return Object.freeze({
    ...sourceSet,
    claimLevels: Object.freeze({ integrity: "reached" as const }),
  });
}

function locateMembers(bytes: Uint8Array): readonly LocatedMember[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  requireRange(view, endOffset, 22, "$archive.endOfCentralDirectory");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);

  enforceArchiveCommentLimit(commentLength);
  if (endOffset + 22 + commentLength !== view.byteLength) {
    failure("pdpkg.archive.invalid", "$archive", "end record does not account for every trailing byte");
  }
  enforceSpanned(disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount);
  const zip64Sentinel = entriesOnDisk === 0xffff
    || entryCount === 0xffff
    || centralSize === 0xffff_ffff
    || centralOffset === 0xffff_ffff;
  enforceZip64Sentinel(zip64Sentinel);
  enforceMemberCount(entryCount);
  requireRange(view, centralOffset, centralSize, "$archive.centralDirectory");
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > endOffset) {
    failure("pdpkg.archive.invalid", "$archive.centralDirectory", "central directory overlaps its end record");
  }
  const interveningZip64 = containsSignature(view, centralEnd, endOffset, ZIP64_END_SIGNATURE)
    || containsSignature(view, centralEnd, endOffset, ZIP64_LOCATOR_SIGNATURE);

  let cursor = centralOffset;
  const centralMembers: CentralMember[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const path = `$archive.centralDirectory[${index}]`;
    requireSignature(view, cursor, CENTRAL_DIRECTORY_SIGNATURE, path);
    requireRange(view, cursor, 46, path);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const memberCommentLength = view.getUint16(cursor + 32, true);
    const memberDisk = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const recordLength = 46 + nameLength + extraLength + memberCommentLength;
    requireRange(view, cursor, recordLength, path);
    enforceExtraFieldLimit(extraLength, `${path}.extra`);
    enforceMemberCommentLimit(memberCommentLength, `${path}.comment`);
    enforceSpanned(memberDisk !== 0);
    const nameBytes = slice(view, cursor + 46, nameLength);
    enforceZip64Sentinel(
      compressedSize === 0xffff_ffff
        || expandedSize === 0xffff_ffff
        || localHeaderOffset === 0xffff_ffff,
    );
    const name = decodeMemberName(nameBytes, flags, `${path}.name`);
    validateMemberName(name, nameBytes, `${path}.name`);
    centralMembers.push(Object.freeze({
      index,
      name,
      nameBytes,
      flags,
      method,
      crc32,
      compressedSize,
      expandedSize,
      localHeaderOffset,
    }));
    cursor += recordLength;
  }
  if (cursor !== centralEnd) {
    failure("pdpkg.archive.invalid", "$archive.centralDirectory", "entry count does not consume central directory");
  }
  enforceZip64Record(interveningZip64);
  if (centralEnd !== endOffset && !interveningZip64) {
    failure("pdpkg.archive.invalid", "$archive", "records between central directory and end record are not admitted");
  }

  validateDistinctNames(centralMembers);
  const located = centralMembers.map((member) => locateMemberData(view, member, centralOffset));
  validateNonOverlappingMembers(located);
  return Object.freeze(located);
}

function locateMemberData(view: DataView, member: CentralMember, centralOffset: number): LocatedMember {
  const path = memberPath(member);
  const offset = member.localHeaderOffset;
  requireSignature(view, offset, LOCAL_FILE_HEADER_SIGNATURE, `${path}.localHeader`);
  requireRange(view, offset, 30, `${path}.localHeader`);
  const flags = view.getUint16(offset + 6, true);
  const method = view.getUint16(offset + 8, true);
  const crc32 = view.getUint32(offset + 14, true);
  const compressedSize = view.getUint32(offset + 18, true);
  const expandedSize = view.getUint32(offset + 22, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const headerLength = 30 + nameLength + extraLength;
  requireRange(view, offset, headerLength, `${path}.localHeader`);
  enforceExtraFieldLimit(extraLength, `${path}.localHeader.extra`);
  const nameBytes = slice(view, offset + 30, nameLength);
  enforceZip64Sentinel(compressedSize === 0xffff_ffff || expandedSize === 0xffff_ffff);
  enforceEncryption((member.flags & ENCRYPTED_FLAG) !== 0 || (flags & ENCRYPTED_FLAG) !== 0, path);
  enforceDataDescriptor(
    (member.flags & DATA_DESCRIPTOR_FLAG) !== 0 || (flags & DATA_DESCRIPTOR_FLAG) !== 0,
    path,
  );
  enforceCompressionMethod(member.method, path);
  enforceLocalNameMismatch(!equalBytes(member.nameBytes, nameBytes), path);
  enforceLocalMethodMismatch(method !== member.method, path);
  enforceLocalCrcMismatch(crc32 !== member.crc32, path);
  enforceLocalCompressedSizeMismatch(compressedSize !== member.compressedSize, path);
  enforceLocalExpandedSizeMismatch(expandedSize !== member.expandedSize, path);
  if ((!isPureAscii(nameBytes) && (flags & UTF8_FLAG) === 0)
      || (!isPureAscii(member.nameBytes) && (member.flags & UTF8_FLAG) === 0)) {
    failure(
      "pdpkg.member.name-utf8-flag-required",
      `${path}.name`,
      "a non-ASCII UTF-8 name requires general-purpose bit 11 in both headers",
    );
  }
  const dataOffset = offset + headerLength;
  requireRange(view, dataOffset, member.compressedSize, `${path}.data`);
  if (dataOffset + member.compressedSize > centralOffset) {
    failure("pdpkg.archive.invalid", `${path}.data`, "member data overlaps the central directory");
  }
  return Object.freeze({
    ...member,
    compressedBytes: viewBytes(view, dataOffset, member.compressedSize),
    localRecordEnd: dataOffset + member.compressedSize,
  });
}

function validateDistinctNames(members: readonly CentralMember[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    enforceDuplicateName(seen.has(member.name), memberPath(member));
    for (const previous of seen) {
      enforceCaseCollision(previous !== member.name && simpleCaseEqual(previous, member.name), memberPath(member));
    }
    seen.add(member.name);
  }
}

function validateMemberName(name: string, bytes: Uint8Array, path: string): void {
  enforceNameEmpty(bytes.byteLength === 0, path);
  enforceNameLength(bytes.byteLength, path);
  enforceNameAbsolute(name.startsWith("/") || /^[A-Za-z]:\//u.test(name), path);
  enforceNameBackslash(name.includes("\\"), path);
  enforceNameNul(name.includes("\u0000"), path);
  enforceNameControl([...name].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 0 && codePoint <= 0x1f;
  }), path);
  enforceNameDirectory(name.endsWith("/"), path);
  const segments = bytesSplit(bytes, 0x2f);
  enforceDotSegment(segments.some((segment) => equalBytes(segment, Uint8Array.of(0x2e))), path);
  enforceDotdotSegment(
    segments.some((segment) => equalBytes(segment, Uint8Array.of(0x2e, 0x2e))),
    path,
  );
  enforceSegmentLength(segments.some((segment) => segment.byteLength > MAX_SEGMENT_BYTES), path);
}

function decodeMemberName(bytes: Uint8Array, flags: number, path: string): string {
  if (!isPureAscii(bytes) && (flags & UTF8_FLAG) === 0) {
    failure(
      "pdpkg.member.name-utf8-flag-required",
      path,
      "a non-ASCII name requires general-purpose bit 11",
    );
  }
  try {
    return utf8.decode(bytes);
  } catch {
    failure("pdpkg.member.name-invalid-utf8", path, "member name is not fatal UTF-8");
  }
}

async function expandMember(member: LocatedMember, archiveBytesBefore: number): Promise<Uint8Array> {
  if (member.method !== DEFLATE_METHOD) {
    enforceMemberExpandedLimit(member.compressedBytes.byteLength, memberPath(member));
    enforceArchiveExpandedLimit(archiveBytesBefore + member.compressedBytes.byteLength);
    return Uint8Array.from(member.compressedBytes);
  }
  try {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(member.compressedBytes);
        controller.close();
      },
    });
    const reader = input.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        enforceMemberExpandedLimit(byteLength + chunk.byteLength, memberPath(member));
        enforceArchiveExpandedLimit(archiveBytesBefore + byteLength + chunk.byteLength);
        byteLength += chunk.byteLength;
        chunks.push(Uint8Array.from(chunk));
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    if (error instanceof PdpkgReadError) throw error;
    failure(
      "pdpkg.archive.invalid",
      `${memberPath(member)}.data`,
      `deflate stream is invalid: ${errorMessage(error)}`,
    );
  }
}

function parseBootstrap(bytes: Uint8Array): ParsedBootstrap {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    failure("pdpkg.bootstrap.invalid-utf8", "$archive.pdpkg.json", "bootstrap is not fatal UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    failure("pdpkg.bootstrap.invalid-json", "$archive.pdpkg.json", "bootstrap is not valid JSON");
  }
  if (!isRecord(value)) {
    failure("pdpkg.bootstrap.invalid-shape", "$archive.pdpkg.json", "bootstrap must be a JSON object");
  }
  const sourceSetSha256 = value.sourceSetSha256;
  if (sourceSetSha256 !== undefined
      && (typeof sourceSetSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sourceSetSha256))) {
    failure(
      "pdpkg.bootstrap.source-set-sha256-invalid",
      "$archive.pdpkg.json.sourceSetSha256",
      "sourceSetSha256 must be exactly 64 lowercase hexadecimal digits",
    );
  }
  return Object.freeze({
    compatibility: Object.freeze({
      packageFormat: value.packageFormat === SUPPORTED_VERSION ? "supported" : "unsupported",
      generatorContract: value.generatorContract === 2 ? "supported" : "unsupported",
    }),
    ...(sourceSetSha256 === undefined ? {} : { sourceSetSha256 }),
  });
}

function enforceSourceSetIdentity(declared: string, computed: LuaSourceSetIdentity): void {
  if (declared === computed.hex) return;
  failure(
    "pdpkg.integrity.source-set-mismatch",
    "$archive.pdpkg.json.sourceSetSha256",
    `declared source-set identity ${declared} does not match computed ${computed.hex}`,
  );
}

function enforceEncryption(violation: boolean, path: string): void {
  enforce("pdpkg.archive.encrypted", () => (violation), path, "encrypted members are not admitted");
}

function enforceDataDescriptor(violation: boolean, path: string): void {
  enforce("pdpkg.archive.data-descriptor", () => (violation), path, "data descriptors are not admitted");
}

function enforceZip64Record(violation: boolean): void {
  enforce(
    "pdpkg.archive.zip64-record",
    () => (violation),
    "$archive",
    "Zip64 end records and locators are not admitted",
  );
}

function enforceZip64Sentinel(violation: boolean): void {
  enforce(
    "pdpkg.archive.zip64-sentinel",
    () => (violation),
    "$archive",
    "a 0xFFFFFFFF Zip64 placeholder is not an ordinary ZIP size or offset",
  );
}

function enforceSpanned(violation: boolean): void {
  enforce("pdpkg.archive.spanned", () => (violation), "$archive", "spanned and multi-disk archives are not admitted");
}

function enforceCompressionMethod(method: number, path: string): void {
  enforce(
    "pdpkg.member.compression-method",
    () => (method !== STORED_METHOD && method !== DEFLATE_METHOD),
    path,
    `compression method ${method} is not admitted; required 0 or 8`,
  );
}

function enforceNameEmpty(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-empty", () => (violation), path, "member name is empty");
}

function enforceNameAbsolute(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-absolute", () => (violation), path, "absolute member name is not admitted");
}

function enforceNameBackslash(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-backslash", () => (violation), path, "member name contains a backslash");
}

function enforceNameNul(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-nul", () => (violation), path, "member name contains NUL");
}

function enforceNameControl(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-control", () => (violation), path, "member name contains a C0 control");
}

function enforceNameDirectory(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-directory", () => (violation), path, "directory members are not admitted");
}

function enforceDotSegment(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-dot-segment", () => (violation), path, "member name contains a . segment");
}

function enforceDotdotSegment(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-dotdot-segment", () => (violation), path, "member name contains a .. segment");
}

function enforceDuplicateName(violation: boolean, path: string): void {
  enforce("pdpkg.member.name-duplicate", () => (violation), path, "member name is duplicated byte-for-byte");
}

function enforceCaseCollision(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.name-case-collision",
    () => (violation),
    path,
    "member name collides under Unicode simple case-folding",
  );
}

function enforceArchiveCommentLimit(length: number): void {
  enforce(
    "pdpkg.archive.comment-limit",
    () => (length > MAX_ARCHIVE_COMMENT_BYTES),
    "$archive.comment",
    `archive comment exceeds ${MAX_ARCHIVE_COMMENT_BYTES} bytes`,
  );
}

function enforceMemberCommentLimit(length: number, path: string): void {
  enforce(
    "pdpkg.member.comment-limit",
    () => (length > MAX_MEMBER_COMMENT_BYTES),
    path,
    `member comment exceeds ${MAX_MEMBER_COMMENT_BYTES} bytes`,
  );
}

function enforceExtraFieldLimit(length: number, path: string): void {
  enforce(
    "pdpkg.member.extra-field-limit",
    () => (length > MAX_EXTRA_FIELD_BYTES),
    path,
    `extra field exceeds ${MAX_EXTRA_FIELD_BYTES} bytes`,
  );
}

function enforceLocalNameMismatch(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.local-name-mismatch",
    () => (violation),
    path,
    "local-header name disagrees with the central directory",
  );
}

function enforceLocalMethodMismatch(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.local-method-mismatch",
    () => (violation),
    path,
    "local-header method disagrees with the central directory",
  );
}

function enforceLocalCrcMismatch(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.local-crc-mismatch",
    () => (violation),
    path,
    "local-header CRC-32 disagrees with the central directory",
  );
}

function enforceLocalCompressedSizeMismatch(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.local-compressed-size-mismatch",
    () => (violation),
    path,
    "local-header compressed size disagrees with the central directory",
  );
}

function enforceLocalExpandedSizeMismatch(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.local-expanded-size-mismatch",
    () => (violation),
    path,
    "local-header expanded size disagrees with the central directory",
  );
}

function enforceMemberCount(count: number): void {
  enforce(
    "pdpkg.archive.member-count-limit",
    () => (count > MAX_MEMBERS),
    "$archive.centralDirectory",
    `member count exceeds ${MAX_MEMBERS}`,
  );
}

function enforceNameLength(length: number, path: string): void {
  enforce(
    "pdpkg.member.name-length-limit",
    () => (length > MAX_NAME_BYTES),
    path,
    `member name exceeds ${MAX_NAME_BYTES} bytes`,
  );
}

function enforceSegmentLength(violation: boolean, path: string): void {
  enforce(
    "pdpkg.member.segment-length-limit",
    () => (violation),
    path,
    `member name segment exceeds ${MAX_SEGMENT_BYTES} bytes`,
  );
}

function enforceMemberExpandedLimit(length: number, path: string): void {
  enforce(
    "pdpkg.member.expanded-limit",
    () => (length > MAX_MEMBER_EXPANDED_BYTES),
    path,
    `expanded member exceeds ${MAX_MEMBER_EXPANDED_BYTES} bytes`,
  );
}

function enforceArchiveExpandedLimit(length: number): void {
  enforce(
    "pdpkg.archive.expanded-limit",
    () => (length > MAX_ARCHIVE_EXPANDED_BYTES),
    "$archive",
    `expanded members exceed ${MAX_ARCHIVE_EXPANDED_BYTES} bytes`,
  );
}

function enforceCrc(member: CentralMember, bytes: Uint8Array): void {
  enforce(
    "pdpkg.member.crc-mismatch",
    () => (crc32(bytes) !== member.crc32),
    memberPath(member),
    "expanded member CRC-32 does not match the central directory",
    member.name,
  );
}

function enforce(
  code: PdpkgDiagnosticCode,
  violation: () => boolean,
  path: string,
  message: string,
  sourceMember?: string,
): void {
  if (violation()) failure(code, path, message, sourceMember);
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstCandidate = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_FIELD_BYTES);
  for (let offset = view.byteLength - 22; offset >= firstCandidate; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  failure("pdpkg.archive.invalid", "$archive", "ZIP end-of-central-directory record is missing");
}

function containsSignature(view: DataView, start: number, end: number, signature: number): boolean {
  for (let offset = start; offset + 4 <= end; offset += 1) {
    if (view.getUint32(offset, true) === signature) return true;
  }
  return false;
}

function validateNonOverlappingMembers(members: readonly LocatedMember[]): void {
  const ranges = members.map((member) => ({
    start: member.localHeaderOffset,
    end: member.localRecordEnd,
    member,
  })).sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      failure(
        "pdpkg.archive.invalid",
        memberPath(ranges[index]!.member),
        "local member records overlap",
      );
    }
  }
}

function encodeStoredZip(members: readonly LuaSourceMemberCandidate[]): Uint8Array {
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;
  for (const member of members) {
    const nameBytes = utf8Encoder.encode(member.logicalName);
    const sourceBytes = Uint8Array.from(member.sourceBytes);
    const flags = nameBytes.every((octet) => octet < 0x80) ? 0 : UTF8_FLAG;
    const crc = crc32(sourceBytes);
    const local = new Uint8Array(30 + nameBytes.byteLength + sourceBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, STORED_METHOD, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, sourceBytes.byteLength, true);
    localView.setUint32(22, sourceBytes.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(sourceBytes, 30 + nameBytes.byteLength);
    localRecords.push(local);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, STORED_METHOD, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, sourceBytes.byteLength, true);
    centralView.setUint32(24, sourceBytes.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralRecords.push(central);
    localOffset += local.byteLength;
  }

  const centralSize = centralRecords.reduce((total, record) => total + record.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(8, members.length, true);
  endView.setUint16(10, members.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return concatenate([...localRecords, ...centralRecords, end]);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function simpleCaseEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const escaped = left.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  return new RegExp(`^(?:${escaped})$(?![\\s\\S])`, "iu").test(right);
}

function isPureAscii(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte <= 0x7f);
}

function bytesSplit(bytes: Uint8Array, separator: number): readonly Uint8Array[] {
  const result: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index === bytes.byteLength || bytes[index] === separator) {
      result.push(bytes.slice(start, index));
      start = index + 1;
    }
  }
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function slice(view: DataView, offset: number, length: number): Uint8Array {
  return Uint8Array.from(viewBytes(view, offset, length));
}

function viewBytes(view: DataView, offset: number, length: number): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + offset, length);
}

function requireSignature(view: DataView, offset: number, signature: number, path: string): void {
  requireRange(view, offset, 4, path);
  if (view.getUint32(offset, true) !== signature) {
    failure("pdpkg.archive.invalid", path, "required ZIP record signature is missing");
  }
}

function requireRange(view: DataView, offset: number, length: number, path: string): void {
  if (!Number.isSafeInteger(offset)
      || !Number.isSafeInteger(length)
      || offset < 0
      || length < 0
      || offset + length > view.byteLength) {
    failure("pdpkg.archive.invalid", path, "ZIP record exceeds archive bounds");
  }
}

function memberPath(member: Pick<CentralMember, "index">): string {
  return `$archive.centralDirectory[${member.index}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb8_8320;
  }
  return value >>> 0;
}));

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffff_ffff) >>> 0;
}

function failure(code: PdpkgDiagnosticCode, path: string, message: string, sourceMember?: string): never {
  throw new PdpkgReadError(Object.freeze({ code, path, message }), sourceMember);
}
