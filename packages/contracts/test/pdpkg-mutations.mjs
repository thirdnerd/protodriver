const END_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;

export const textBytes = (value) => new TextEncoder().encode(value);

export function mutateAnchor(anchorBytes, mutate) {
  const archive = parseAnchor(anchorBytes);
  mutate(archive);
  return encodeArchive(archive);
}

export function inspectAnchor(anchorBytes) {
  const archive = parseAnchor(anchorBytes);
  return archive.members.map((member) => ({
    name: new TextDecoder().decode(member.centralName),
    centralMethod: member.centralMethod,
    localMethod: member.localMethod,
    centralFlags: member.centralFlags,
    localFlags: member.localFlags,
    centralExtraLength: member.centralExtra.byteLength,
    localExtraLength: member.localExtra.byteLength,
  }));
}

export function copyMember(member) {
  return {
    ...member,
    centralName: member.centralName.slice(),
    localName: member.localName.slice(),
    centralExtra: member.centralExtra.slice(),
    localExtra: member.localExtra.slice(),
    comment: member.comment.slice(),
    data: member.data.slice(),
  };
}

export function replaceStoredContent(member, bytes) {
  member.data = Uint8Array.from(bytes);
  member.centralMethod = 0;
  member.localMethod = 0;
  member.centralCompressedSize = bytes.byteLength;
  member.localCompressedSize = bytes.byteLength;
  member.centralExpandedSize = bytes.byteLength;
  member.localExpandedSize = bytes.byteLength;
  member.centralCrc = crc32(bytes);
  member.localCrc = member.centralCrc;
}

export function renameMember(member, name) {
  const bytes = typeof name === "string" ? textBytes(name) : Uint8Array.from(name);
  member.centralName = bytes;
  member.localName = bytes.slice();
}

export function validExtraField(totalLength, identifier = 0x1234) {
  if (totalLength < 4 || totalLength - 4 > 0xffff) throw new RangeError("invalid extra-field length");
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, identifier, true);
  view.setUint16(2, totalLength - 4, true);
  return bytes;
}

function parseAnchor(anchorBytes) {
  const bytes = Uint8Array.from(anchorBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === END_SIGNATURE
        && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("positive anchor has no ZIP end record");
  const memberCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const members = [];
  for (let index = 0; index < memberCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`positive anchor central member ${index} is malformed`);
    }
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`positive anchor local member ${index} is malformed`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedSize = view.getUint32(centralOffset + 20, true);
    members.push({
      versionMadeBy: view.getUint16(centralOffset + 4, true),
      centralVersionNeeded: view.getUint16(centralOffset + 6, true),
      centralFlags: view.getUint16(centralOffset + 8, true),
      centralMethod: view.getUint16(centralOffset + 10, true),
      centralTime: view.getUint16(centralOffset + 12, true),
      centralDate: view.getUint16(centralOffset + 14, true),
      centralCrc: view.getUint32(centralOffset + 16, true),
      centralCompressedSize: compressedSize,
      centralExpandedSize: view.getUint32(centralOffset + 24, true),
      centralName: bytes.slice(centralOffset + 46, centralOffset + 46 + nameLength),
      centralExtra: bytes.slice(
        centralOffset + 46 + nameLength,
        centralOffset + 46 + nameLength + extraLength,
      ),
      comment: bytes.slice(
        centralOffset + 46 + nameLength + extraLength,
        centralOffset + 46 + nameLength + extraLength + commentLength,
      ),
      diskStart: view.getUint16(centralOffset + 34, true),
      internalAttributes: view.getUint16(centralOffset + 36, true),
      externalAttributes: view.getUint32(centralOffset + 38, true),
      localOffsetOverride: undefined,
      localVersionNeeded: view.getUint16(localOffset + 4, true),
      localFlags: view.getUint16(localOffset + 6, true),
      localMethod: view.getUint16(localOffset + 8, true),
      localTime: view.getUint16(localOffset + 10, true),
      localDate: view.getUint16(localOffset + 12, true),
      localCrc: view.getUint32(localOffset + 14, true),
      localCompressedSize: view.getUint32(localOffset + 18, true),
      localExpandedSize: view.getUint32(localOffset + 22, true),
      localName: bytes.slice(localOffset + 30, localOffset + 30 + localNameLength),
      localExtra: bytes.slice(
        localOffset + 30 + localNameLength,
        localOffset + 30 + localNameLength + localExtraLength,
      ),
      data: bytes.slice(dataOffset, dataOffset + compressedSize),
    });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    members,
    disk: view.getUint16(endOffset + 4, true),
    centralDisk: view.getUint16(endOffset + 6, true),
    entriesOnDiskOverride: undefined,
    entryCountOverride: undefined,
    centralSizeOverride: undefined,
    centralOffsetOverride: undefined,
    comment: bytes.slice(endOffset + 22),
    recordBeforeEnd: new Uint8Array(),
  };
}

function encodeArchive(archive) {
  const localLengths = archive.members.map((member) => (
    30 + member.localName.byteLength + member.localExtra.byteLength + member.data.byteLength
  ));
  const centralLengths = archive.members.map((member) => (
    46 + member.centralName.byteLength + member.centralExtra.byteLength + member.comment.byteLength
  ));
  const localBytes = localLengths.reduce((sum, length) => sum + length, 0);
  const centralBytes = centralLengths.reduce((sum, length) => sum + length, 0);
  const total = localBytes + centralBytes + archive.recordBeforeEnd.byteLength + 22 + archive.comment.byteLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const offsets = [];
  let cursor = 0;
  for (const member of archive.members) {
    offsets.push(cursor);
    view.setUint32(cursor, LOCAL_SIGNATURE, true);
    view.setUint16(cursor + 4, member.localVersionNeeded, true);
    view.setUint16(cursor + 6, member.localFlags, true);
    view.setUint16(cursor + 8, member.localMethod, true);
    view.setUint16(cursor + 10, member.localTime, true);
    view.setUint16(cursor + 12, member.localDate, true);
    view.setUint32(cursor + 14, member.localCrc, true);
    view.setUint32(cursor + 18, member.localCompressedSize, true);
    view.setUint32(cursor + 22, member.localExpandedSize, true);
    view.setUint16(cursor + 26, member.localName.byteLength, true);
    view.setUint16(cursor + 28, member.localExtra.byteLength, true);
    cursor += 30;
    bytes.set(member.localName, cursor);
    cursor += member.localName.byteLength;
    bytes.set(member.localExtra, cursor);
    cursor += member.localExtra.byteLength;
    bytes.set(member.data, cursor);
    cursor += member.data.byteLength;
  }
  const centralOffset = cursor;
  for (const [index, member] of archive.members.entries()) {
    view.setUint32(cursor, CENTRAL_SIGNATURE, true);
    view.setUint16(cursor + 4, member.versionMadeBy, true);
    view.setUint16(cursor + 6, member.centralVersionNeeded, true);
    view.setUint16(cursor + 8, member.centralFlags, true);
    view.setUint16(cursor + 10, member.centralMethod, true);
    view.setUint16(cursor + 12, member.centralTime, true);
    view.setUint16(cursor + 14, member.centralDate, true);
    view.setUint32(cursor + 16, member.centralCrc, true);
    view.setUint32(cursor + 20, member.centralCompressedSize, true);
    view.setUint32(cursor + 24, member.centralExpandedSize, true);
    view.setUint16(cursor + 28, member.centralName.byteLength, true);
    view.setUint16(cursor + 30, member.centralExtra.byteLength, true);
    view.setUint16(cursor + 32, member.comment.byteLength, true);
    view.setUint16(cursor + 34, member.diskStart, true);
    view.setUint16(cursor + 36, member.internalAttributes, true);
    view.setUint32(cursor + 38, member.externalAttributes, true);
    view.setUint32(cursor + 42, member.localOffsetOverride ?? offsets[index], true);
    cursor += 46;
    bytes.set(member.centralName, cursor);
    cursor += member.centralName.byteLength;
    bytes.set(member.centralExtra, cursor);
    cursor += member.centralExtra.byteLength;
    bytes.set(member.comment, cursor);
    cursor += member.comment.byteLength;
  }
  bytes.set(archive.recordBeforeEnd, cursor);
  cursor += archive.recordBeforeEnd.byteLength;
  view.setUint32(cursor, END_SIGNATURE, true);
  view.setUint16(cursor + 4, archive.disk, true);
  view.setUint16(cursor + 6, archive.centralDisk, true);
  view.setUint16(cursor + 8, archive.entriesOnDiskOverride ?? archive.members.length, true);
  view.setUint16(cursor + 10, archive.entryCountOverride ?? archive.members.length, true);
  view.setUint32(cursor + 12, archive.centralSizeOverride ?? centralBytes, true);
  view.setUint32(cursor + 16, archive.centralOffsetOverride ?? centralOffset, true);
  view.setUint16(cursor + 20, archive.comment.byteLength, true);
  cursor += 22;
  bytes.set(archive.comment, cursor);
  return bytes;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb8_8320;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffff_ffff) >>> 0;
}
