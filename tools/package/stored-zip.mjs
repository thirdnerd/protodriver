import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { constants as zlibConstants, createDeflateRaw } from "node:zlib";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const FIXED_DOS_TIME = 0;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

// Stored product packages and deflated delivery envelopes share sorted
// traversal, fixed DOS timestamps, fixed modes, and fixed headers. Deflate uses
// an explicit level; the pinned release Node version fixes the zlib boundary.

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
  }
  return value >>> 0;
});

export async function createDeterministicStoredZip({
  outputPath,
  rootDirectory,
  rootName,
} = {}) {
  return createDeterministicZip({
    compressionMethod: STORE_METHOD,
    outputPath,
    rootDirectory,
    rootName,
  });
}

export async function createDeterministicDeflatedZip({
  outputPath,
  rootDirectory,
  rootName,
} = {}) {
  return createDeterministicZip({
    compressionMethod: DEFLATE_METHOD,
    outputPath,
    rootDirectory,
    rootName,
  });
}

async function createDeterministicZip({
  compressionMethod,
  outputPath,
  rootDirectory,
  rootName,
}) {
  if (outputPath === undefined) throw new TypeError("outputPath is required");
  if (rootDirectory === undefined) throw new TypeError("rootDirectory is required");
  if (rootName === undefined) throw new TypeError("rootName is required");
  const entries = await collectEntries(rootDirectory, rootName);
  if (entries.length > MAX_U16) {
    throw new Error(`stored-zip.too-many-entries: ${entries.length}`);
  }
  const handle = await open(outputPath, "wx", 0o644);
  const centralRecords = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const localOffset = offset;
      const method = entry.directory ? STORE_METHOD : compressionMethod;
      const flags = UTF8_FLAG | (method === DEFLATE_METHOD ? DATA_DESCRIPTOR_FLAG : 0);
      const localEntry = { ...entry, flags, method };
      const local = localHeader(localEntry, name);
      await handle.writeFile(local);
      await handle.writeFile(name);
      offset += local.byteLength + name.byteLength;
      if (!entry.directory) {
        const bytes = method === DEFLATE_METHOD
          ? createReadStream(entry.path).pipe(createDeflateRaw({
            level: zlibConstants.Z_BEST_COMPRESSION,
          }))
          : createReadStream(entry.path);
        let compressedSize = 0;
        for await (const chunk of bytes) {
          await handle.writeFile(chunk);
          offset += chunk.byteLength;
          compressedSize += chunk.byteLength;
        }
        localEntry.compressedSize = compressedSize;
        if (compressedSize > MAX_U32) {
          throw new Error(`stored-zip.member-too-large: ${entry.name}`);
        }
        if (method === DEFLATE_METHOD) {
          const descriptor = dataDescriptor(localEntry);
          await handle.writeFile(descriptor);
          offset += descriptor.byteLength;
        }
      } else {
        localEntry.compressedSize = 0;
      }
      if (offset > MAX_U32) throw new Error(`stored-zip.too-large: ${offset} bytes`);
      centralRecords.push(centralHeader(localEntry, name, localOffset));
    }
    const centralOffset = offset;
    for (const record of centralRecords) {
      await handle.writeFile(record);
      offset += record.byteLength;
    }
    const centralSize = offset - centralOffset;
    if (centralOffset > MAX_U32 || centralSize > MAX_U32) {
      throw new Error("stored-zip.zip64-required");
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await handle.writeFile(end);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function inspectStoredZip(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + MAX_U16);
    const tailOffset = size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error("stored-zip.end-record-missing");
    const end = tail.subarray(endOffset);
    const commentLength = end.readUInt16LE(20);
    if (endOffset + 22 + commentLength !== tail.length) {
      throw new Error("stored-zip.end-record-trailing-data");
    }
    if (end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0) {
      throw new Error("stored-zip.spanned-not-supported");
    }
    const entryCount = end.readUInt16LE(10);
    if (end.readUInt16LE(8) !== entryCount) {
      throw new Error("stored-zip.entry-count-mismatch");
    }
    const centralSize = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    if (centralOffset + centralSize !== tailOffset + endOffset) {
      throw new Error("stored-zip.central-directory-invalid");
    }
    const central = await readExactly(handle, centralSize, centralOffset);
    const entries = [];
    let cursor = 0;
    while (cursor < central.length) {
      if (cursor + 46 > central.length
          || central.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error("stored-zip.central-entry-invalid");
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const entryCommentLength = central.readUInt16LE(cursor + 32);
      const recordLength = 46 + nameLength + extraLength + entryCommentLength;
      if (cursor + recordLength > central.length) {
        throw new Error("stored-zip.central-entry-truncated");
      }
      if ((flags & 1) !== 0 || method !== 0) {
        throw new Error("stored-zip.entry-not-stored");
      }
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      entries.push(Object.freeze({
        compressedSize: central.readUInt32LE(cursor + 20),
        crc32: central.readUInt32LE(cursor + 16),
        dosDate: central.readUInt16LE(cursor + 14),
        dosTime: central.readUInt16LE(cursor + 12),
        flags,
        localOffset: central.readUInt32LE(cursor + 42),
        name,
        size: central.readUInt32LE(cursor + 24),
      }));
      cursor += recordLength;
    }
    if (entries.length !== entryCount) throw new Error("stored-zip.entry-count-mismatch");
    return Object.freeze({ entries: Object.freeze(entries) });
  } finally {
    await handle.close();
  }
}

export async function readStoredZipMember(path, name, inspection) {
  const index = inspection ?? await inspectStoredZip(path);
  const entry = index.entries.find((candidate) => candidate.name === name);
  if (entry === undefined || entry.name.endsWith("/")) {
    throw new Error(`stored-zip.member-missing: ${name}`);
  }
  if (entry.size !== entry.compressedSize) throw new Error(`stored-zip.entry-not-stored: ${name}`);
  const handle = await open(path, "r");
  try {
    const header = await readExactly(handle, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE
        || header.readUInt16LE(6) !== entry.flags
        || header.readUInt16LE(8) !== 0
        || header.readUInt32LE(14) !== entry.crc32
        || header.readUInt32LE(18) !== entry.size
        || header.readUInt32LE(22) !== entry.size) {
      throw new Error(`stored-zip.local-header-invalid: ${name}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const localName = (await readExactly(handle, nameLength, entry.localOffset + 30)).toString("utf8");
    if (localName !== name) throw new Error(`stored-zip.local-name-mismatch: ${name}`);
    const bytes = await readExactly(handle, entry.size, entry.localOffset + 30 + nameLength + extraLength);
    if (crc32(bytes) !== entry.crc32) throw new Error(`stored-zip.crc-mismatch: ${name}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function collectEntries(rootDirectory, rootName) {
  const entries = [];
  async function append(path, name, directory) {
    if (directory) {
      if (Buffer.byteLength(`${name}/`) > MAX_U16) throw new Error(`stored-zip.name-too-long: ${name}/`);
      entries.push(Object.freeze({ crc32: 0, directory: true, name: `${name}/`, path, size: 0 }));
      const children = await readdir(path, { withFileTypes: true });
      children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const child of children) {
        const childPath = join(path, child.name);
        if (!child.isFile() && !child.isDirectory()) {
          throw new Error(`stored-zip.entry-type-invalid: ${name}/${child.name}`);
        }
        await append(childPath, `${name}/${child.name}`, child.isDirectory());
      }
      return;
    }
    if (Buffer.byteLength(name) > MAX_U16) throw new Error(`stored-zip.name-too-long: ${name}`);
    const info = await lstat(path);
    if (info.size > MAX_U32) throw new Error(`stored-zip.member-too-large: ${name}`);
    entries.push(Object.freeze({
      crc32: await crc32File(path),
      directory: false,
      name,
      path,
      size: info.size,
    }));
  }
  await append(rootDirectory, rootName, true);
  return entries;
}

function localHeader(entry, name) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  if ((entry.flags & DATA_DESCRIPTOR_FLAG) === 0) {
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(entry.size, 18);
    header.writeUInt32LE(entry.size, 22);
  }
  header.writeUInt16LE(name.byteLength, 26);
  return header;
}

function dataDescriptor(entry) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(entry.crc32, 4);
  descriptor.writeUInt32LE(entry.compressedSize, 8);
  descriptor.writeUInt32LE(entry.size, 12);
  return descriptor;
}

function centralHeader(entry, name, localOffset) {
  const header = Buffer.alloc(46 + name.byteLength);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(0x0314, 4); // Unix creator, ZIP 2.0
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(name.byteLength, 28);
  const unixMode = entry.directory ? 0o040755 : 0o100644;
  header.writeUInt32LE(((unixMode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  name.copy(header, 46);
  return header;
}

async function crc32File(path) {
  let value = 0xffffffff;
  for await (const chunk of createReadStream(path)) value = crc32Update(value, chunk);
  return (value ^ 0xffffffff) >>> 0;
}

function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function crc32Update(initial, bytes) {
  let value = initial;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function readExactly(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("stored-zip.unexpected-eof");
    offset += bytesRead;
  }
  return bytes;
}
