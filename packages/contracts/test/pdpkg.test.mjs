import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPdpkg, PdpkgReadError, readPdpkg } from "../src/pdpkg.ts";
import { verifyLuaSourceSet } from "../src/lua-source-set.ts";
import {
  copyMember,
  inspectAnchor,
  mutateAnchor,
  renameMember,
  replaceStoredContent,
  textBytes,
  validExtraField,
} from "./pdpkg-mutations.mjs";

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pdpkg");
const utf8 = new TextDecoder();
const READER_SOURCE = fileURLToPath(new URL("../src/pdpkg.ts", import.meta.url));
const STORED_ANCHOR = "python-zipfile-stored.zip";

async function fixture(name) {
  return new Uint8Array(await readFile(path.join(FIXTURE_ROOT, name)));
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("the package builder derives identity, orders members, and round-trips", async () => {
  const members = Object.freeze([
    Object.freeze({ logicalName: "helper.lua", sourceBytes: textBytes("return 1\n") }),
    Object.freeze({ logicalName: "device.lua", sourceBytes: textBytes("return {}\n") }),
  ]);
  const [built, reordered, callerClaim] = await Promise.all([
    buildPdpkg(members),
    buildPdpkg([...members].reverse()),
    buildPdpkg(members, "00".repeat(32)),
  ]);
  assert.deepEqual(reordered.archive, built.archive);
  assert.deepEqual(callerClaim.archive, built.archive);

  const read = await readPdpkg(built.archive);
  assert.deepEqual(read.claimLevels, { integrity: "reached" });
  assert.deepEqual(read.members.map((member) => member.logicalName), ["device.lua", "helper.lua"]);
  assert.deepEqual((await verifyLuaSourceSet(read)).identity, built.sourceSetIdentity);
});

test("real ZIP producers yield the bootstrap verdicts and source population", async (t) => {
  const provenance = JSON.parse(await readFile(path.join(FIXTURE_ROOT, "provenance.json"), "utf8"));
  for (const anchor of provenance.anchors) {
    await t.test(anchor.file, async () => {
      const bytes = await fixture(anchor.file);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), anchor.sha256);
      const sourceSet = await readPdpkg(bytes);
      assert.deepEqual(sourceSet.bootstrap, {
        packageFormat: "supported",
        generatorContract: "unsupported",
      });
      assert.deepEqual(sourceSet.claimLevels, { integrity: "not-evaluated" });
      assert.deepEqual(Object.keys(sourceSet).sort(), ["bootstrap", "claimLevels", "members"]);
      assert.equal("identity" in sourceSet, false);
      const expectedSources = Object.entries(anchor.memberSha256)
        .filter(([name]) => name !== "pdpkg.json");
      assert.deepEqual(sourceSet.members.map((member) => member.logicalName), expectedSources.map(([name]) => name));
      for (const [index, [, expectedDigest]] of expectedSources.entries()) {
        assert.equal(
          createHash("sha256").update(sourceSet.members[index].sourceBytes).digest("hex"),
          expectedDigest,
        );
      }
      assert.equal(sourceSet.members.some((member) => member.logicalName === "pdpkg.json"), false);
      await assert.rejects(verifyLuaSourceSet(sourceSet), /generator-contract-unsupported/u);
    });
  }
});

test("a declared source-set identity reaches integrity and a mismatched claim rejects", async () => {
  const anchor = await fixture(STORED_ANCHOR);
  const legacy = await readPdpkg(anchor);
  const identity = (await verifyLuaSourceSet({ ...legacy,
    bootstrap: { ...legacy.bootstrap, generatorContract: "supported" } })).identity.hex;
  const claimed = mutateAnchor(anchor, (archive) => {
    replaceStoredContent(
      namedMember(archive, "pdpkg.json"),
      textBytes(`${JSON.stringify({
        packageFormat: 1,
        generatorContract: 2,
        sourceSetSha256: identity,
      })}\n`),
    );
  });
  assert.deepEqual((await readPdpkg(claimed)).claimLevels, { integrity: "reached" });

  const mismatched = mutateAnchor(claimed, (archive) => {
    replaceStoredContent(
      namedMember(archive, "pdpkg.json"),
      textBytes(`${JSON.stringify({
        packageFormat: 1,
        generatorContract: 2,
        sourceSetSha256: "00".repeat(32),
      })}\n`),
    );
  });
  assert.equal(
    await rejectionCode(() => readPdpkg(mismatched)),
    "pdpkg.integrity.source-set-mismatch",
  );
});

test("sourceSetSha256 is either absent or exactly lowercase SHA-256 hex", async (t) => {
  const anchor = await fixture(STORED_ANCHOR);
  for (const invalid of ["00", "AA".repeat(32), 7]) {
    await t.test(JSON.stringify(invalid), async () => {
      const bytes = mutateAnchor(anchor, (archive) => {
        replaceStoredContent(
          namedMember(archive, "pdpkg.json"),
          textBytes(`${JSON.stringify({
            packageFormat: 1,
            generatorContract: 1,
            sourceSetSha256: invalid,
          })}\n`),
        );
      });
      assert.equal(
        await rejectionCode(() => readPdpkg(bytes)),
        "pdpkg.bootstrap.source-set-sha256-invalid",
      );
    });
  }
});

test("the public package root exposes the archive reader and builder", async () => {
  const runtime = await import("@protodriver/contracts");
  assert.equal(runtime.buildPdpkg, buildPdpkg);
  assert.equal(runtime.readPdpkg, readPdpkg);
  assert.equal(runtime.PdpkgReadError, PdpkgReadError);
});

test("Windows Compress-Archive admission has no filename or extension channel", async () => {
  assert.equal(readPdpkg.length, 1);
  const bytesOnly = await fixture("windows-powershell-5.1.zip");
  const sourceSet = await readPdpkg(bytesOnly);
  assert.deepEqual(sourceSet.members.map((member) => member.logicalName), ["device.lua", "graph.lua"]);
});

function namedMember(archive, name) {
  const member = archive.members.find((candidate) => utf8.decode(candidate.centralName) === name);
  assert.notEqual(member, undefined, `positive anchor must contain ${name}`);
  return member;
}

function setUtf8Flag(member) {
  member.centralFlags |= 1 << 11;
  member.localFlags |= 1 << 11;
}

const hostileCases = Object.freeze([
  {
    code: "pdpkg.archive.encrypted",
    mutate(archive) {
      const member = namedMember(archive, "helper.lua");
      member.centralFlags |= 1;
      member.localFlags |= 1;
    },
  },
  {
    code: "pdpkg.archive.data-descriptor",
    mutate(archive) {
      const member = namedMember(archive, "helper.lua");
      member.centralFlags |= 1 << 3;
      member.localFlags |= 1 << 3;
    },
  },
  {
    code: "pdpkg.archive.zip64-record",
    mutate(archive) {
      archive.recordBeforeEnd = new Uint8Array(20);
      new DataView(archive.recordBeforeEnd.buffer).setUint32(0, 0x0706_4b50, true);
    },
  },
  {
    code: "pdpkg.archive.zip64-sentinel",
    proofKind: "diagnostic-refiner",
    variants: [
      "central-directory-size",
      "central-directory-offset",
      "member-compressed-size",
      "member-expanded-size",
      "member-local-offset",
    ],
    renamedCode: {
      "central-directory-size": "pdpkg.archive.invalid",
      "central-directory-offset": "pdpkg.archive.invalid",
      "member-compressed-size": "pdpkg.archive.invalid",
      "member-expanded-size": "pdpkg.member.expanded-limit",
      "member-local-offset": "pdpkg.archive.invalid",
    },
    mutate(archive, variant) {
      if (variant === "central-directory-size") {
        archive.centralSizeOverride = 0xffff_ffff;
        return;
      }
      if (variant === "central-directory-offset") {
        archive.centralOffsetOverride = 0xffff_ffff;
        return;
      }
      const member = namedMember(archive, "helper.lua");
      if (variant === "member-compressed-size") {
        member.centralCompressedSize = 0xffff_ffff;
        member.localCompressedSize = 0xffff_ffff;
      } else if (variant === "member-expanded-size") {
        member.centralExpandedSize = 0xffff_ffff;
        member.localExpandedSize = 0xffff_ffff;
      } else {
        member.localOffsetOverride = 0xffff_ffff;
      }
    },
  },
  {
    code: "pdpkg.archive.spanned",
    variants: ["end-record", "member-disk"],
    mutate(archive, variant) {
      if (variant === "end-record") {
        archive.disk = 1;
        archive.centralDisk = 1;
      } else {
        namedMember(archive, "helper.lua").diskStart = 1;
      }
    },
  },
  {
    code: "pdpkg.member.compression-method",
    mutate(archive) {
      const member = namedMember(archive, "helper.lua");
      member.centralMethod = 12;
      member.localMethod = 12;
    },
  },
  {
    code: "pdpkg.member.name-empty",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), ""); },
  },
  {
    code: "pdpkg.member.name-absolute",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "/evil.lua"); },
  },
  {
    code: "pdpkg.member.name-backslash",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "evil\\x.lua"); },
  },
  {
    code: "pdpkg.member.name-nul",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "evil\0.lua"); },
  },
  {
    code: "pdpkg.member.name-control",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "evil\u0001.lua"); },
  },
  {
    code: "pdpkg.member.name-directory",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "helper.lu/"); },
  },
  {
    code: "pdpkg.member.name-dot-segment",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "./file.lua"); },
  },
  {
    code: "pdpkg.member.name-dotdot-segment",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "../dev.lua"); },
  },
  {
    code: "pdpkg.member.name-duplicate",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), "device.lua"); },
  },
  {
    code: "pdpkg.member.name-case-collision",
    mutate(archive) {
      const device = namedMember(archive, "device.lua");
      const helper = namedMember(archive, "helper.lua");
      renameMember(device, "Σ.lua");
      renameMember(helper, "ς.lua");
      setUtf8Flag(device);
      setUtf8Flag(helper);
    },
  },
  {
    code: "pdpkg.archive.comment-limit",
    mutate(archive) { archive.comment = new Uint8Array(1025); },
  },
  {
    code: "pdpkg.member.comment-limit",
    mutate(archive) { namedMember(archive, "helper.lua").comment = new Uint8Array(1025); },
  },
  {
    code: "pdpkg.member.extra-field-limit",
    variants: ["central", "local"],
    mutate(archive, variant) {
      const member = namedMember(archive, "helper.lua");
      member[variant === "central" ? "centralExtra" : "localExtra"] = validExtraField(4097);
    },
  },
  {
    code: "pdpkg.member.local-name-mismatch",
    mutate(archive) { namedMember(archive, "helper.lua").localName = textBytes("changed.lua"); },
  },
  {
    code: "pdpkg.member.local-method-mismatch",
    mutate(archive) { namedMember(archive, "helper.lua").localMethod = 8; },
  },
  {
    code: "pdpkg.member.local-crc-mismatch",
    mutate(archive) { namedMember(archive, "helper.lua").localCrc ^= 1; },
  },
  {
    code: "pdpkg.member.local-compressed-size-mismatch",
    mutate(archive) { namedMember(archive, "helper.lua").localCompressedSize += 1; },
  },
  {
    code: "pdpkg.member.local-expanded-size-mismatch",
    mutate(archive) { namedMember(archive, "helper.lua").localExpandedSize += 1; },
  },
  {
    code: "pdpkg.archive.member-count-limit",
    mutate(archive) {
      const source = namedMember(archive, "helper.lua");
      for (let index = archive.members.length; index < 65; index += 1) {
        const member = copyMember(source);
        renameMember(member, `s${index.toString().padStart(3, "0")}.lua`);
        archive.members.push(member);
      }
    },
  },
  {
    code: "pdpkg.member.name-length-limit",
    mutate(archive) {
      renameMember(namedMember(archive, "helper.lua"), [
        "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64),
      ].join("/"));
    },
  },
  {
    code: "pdpkg.member.segment-length-limit",
    mutate(archive) { renameMember(namedMember(archive, "helper.lua"), `${"a".repeat(65)}/x.lua`); },
  },
  {
    code: "pdpkg.member.expanded-limit",
    mutate(archive) {
      replaceStoredContent(namedMember(archive, "helper.lua"), new Uint8Array(1024 * 1024 + 1));
    },
  },
  {
    code: "pdpkg.archive.expanded-limit",
    mutate(archive) {
      const device = namedMember(archive, "device.lua");
      const helper = namedMember(archive, "helper.lua");
      replaceStoredContent(device, new Uint8Array(1024 * 1024));
      replaceStoredContent(helper, new Uint8Array(1024 * 1024));
      for (const name of ["third.lua", "fourth.lua"]) {
        const member = copyMember(helper);
        renameMember(member, name);
        archive.members.push(member);
      }
    },
  },
  {
    code: "pdpkg.member.crc-mismatch",
    mutate(archive) {
      const member = namedMember(archive, "helper.lua");
      member.centralCrc ^= 1;
      member.localCrc = member.centralCrc;
    },
  },
]);

async function rejectionCode(action) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(typeof error.diagnostic?.code, "string");
    return error.diagnostic.code;
  }
  return undefined;
}

async function readerWithoutCheck(code) {
  const source = await readFile(READER_SOURCE, "utf8");
  const escaped = code.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  const pattern = new RegExp(`("${escaped}",\\s*\\(\\) => )\\(`, "gu");
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `${code} must have exactly one removable enforcement point`);
  const mutant = source.replace(pattern, "$1(false) && (");
  const mutantPath = path.join(
    path.dirname(READER_SOURCE),
    `.pdpkg-mutant-${process.pid}-${code.replaceAll(".", "-")}.ts`,
  );
  await writeFile(mutantPath, mutant);
  try {
    return await import(`${pathToFileURL(mutantPath).href}?mutation=${encodeURIComponent(code)}`);
  } finally {
    await unlink(mutantPath);
  }
}

test("each named hostile mutation reaches its specific archive rejection", async (t) => {
  const anchor = await fixture(STORED_ANCHOR);
  for (const hostile of hostileCases) {
    for (const variant of hostile.variants ?? [undefined]) {
      await t.test(`${hostile.code}${variant === undefined ? "" : ` (${variant})`}`, async () => {
        const bytes = mutateAnchor(anchor, (archive) => hostile.mutate(archive, variant));
        assert.equal(await rejectionCode(() => readPdpkg(bytes)), hostile.code);
      });
    }
  }
});

test("ASCII needs no language flag; admitted non-ASCII does", async () => {
  const anchor = await fixture(STORED_ANCHOR);
  assert.equal((await readPdpkg(anchor)).members.length, 2);
  const admitted = mutateAnchor(anchor, (archive) => {
    const member = namedMember(archive, "helper.lua");
    renameMember(member, "café.lua");
    setUtf8Flag(member);
  });
  assert.deepEqual((await readPdpkg(admitted)).members.map((member) => member.logicalName), [
    "device.lua",
    "café.lua",
  ]);
  const missingFlag = mutateAnchor(anchor, (archive) => {
    renameMember(namedMember(archive, "helper.lua"), "café.lua");
  });
  assert.equal(
    await rejectionCode(() => readPdpkg(missingFlag)),
    "pdpkg.member.name-utf8-flag-required",
  );
  const invalidUtf8 = mutateAnchor(anchor, (archive) => {
    const member = namedMember(archive, "helper.lua");
    renameMember(member, Uint8Array.of(0xff, 0x2e, 0x6c, 0x75, 0x61));
    setUtf8Flag(member);
  });
  assert.equal(await rejectionCode(() => readPdpkg(invalidUtf8)), "pdpkg.member.name-invalid-utf8");
});

test("case collision uses Unicode simple folding rather than full folding", async () => {
  const anchor = await fixture(STORED_ANCHOR);
  const bytes = mutateAnchor(anchor, (archive) => {
    const device = namedMember(archive, "device.lua");
    const helper = namedMember(archive, "helper.lua");
    renameMember(device, "ß.lua");
    renameMember(helper, "ss.lua");
    setUtf8Flag(device);
  });
  assert.deepEqual((await readPdpkg(bytes)).members.map((member) => member.logicalName), [
    "ß.lua",
    "ss.lua",
  ]);
});

test("package format 2 fails independently at bootstrap before source validation", async () => {
  const anchor = await fixture(STORED_ANCHOR);
  const bytes = mutateAnchor(anchor, (archive) => {
    replaceStoredContent(
      namedMember(archive, "pdpkg.json"),
      textBytes('{"packageFormat":2,"generatorContract":2}\n'),
    );
    replaceStoredContent(namedMember(archive, "device.lua"), Uint8Array.of(0xff));
  });
  const candidate = await readPdpkg(bytes);
  assert.deepEqual(candidate.bootstrap, {
    packageFormat: "unsupported",
    generatorContract: "supported",
  });
  await assert.rejects(
    () => verifyLuaSourceSet(candidate),
    (error) => error.diagnostic?.code === "lua-source-set.bootstrap.package-format-unsupported"
      && error.diagnostic.path === "$bootstrap.packageFormat",
  );
});

test("missing or malformed bootstrap metadata is rejected before the source-set boundary", async () => {
  const anchor = await fixture(STORED_ANCHOR);
  const missing = mutateAnchor(anchor, (archive) => {
    renameMember(namedMember(archive, "pdpkg.json"), "package.jsn");
  });
  assert.equal(await rejectionCode(() => readPdpkg(missing)), "pdpkg.bootstrap.missing");
  const invalidJson = mutateAnchor(anchor, (archive) => {
    replaceStoredContent(namedMember(archive, "pdpkg.json"), textBytes("{"));
  });
  assert.equal(await rejectionCode(() => readPdpkg(invalidJson)), "pdpkg.bootstrap.invalid-json");
  const invalidShape = mutateAnchor(anchor, (archive) => {
    replaceStoredContent(namedMember(archive, "pdpkg.json"), textBytes("[]"));
  });
  assert.equal(await rejectionCode(() => readPdpkg(invalidShape)), "pdpkg.bootstrap.invalid-shape");
});

test("every inclusive archive bound admits its exact boundary", async (t) => {
  const anchor = await fixture(STORED_ANCHOR);
  await t.test("comments and both extra fields", async () => {
    const bytes = mutateAnchor(anchor, (archive) => {
      archive.comment = new Uint8Array(1024);
      const member = namedMember(archive, "helper.lua");
      member.comment = new Uint8Array(1024);
      member.centralExtra = validExtraField(4096);
      member.localExtra = validExtraField(4096);
    });
    assert.equal((await readPdpkg(bytes)).members.length, 2);
  });
  await t.test("bounded extra fields are skipped without interpretation", async () => {
    const bytes = mutateAnchor(anchor, (archive) => {
      const member = namedMember(archive, "helper.lua");
      member.centralExtra = Uint8Array.of(0x01);
      member.localExtra = Uint8Array.of(0xff, 0x00, 0x01);
    });
    assert.equal((await readPdpkg(bytes)).members.length, 2);
  });
  await t.test("64 members", async () => {
    const bytes = mutateAnchor(anchor, (archive) => {
      const source = namedMember(archive, "helper.lua");
      for (let index = archive.members.length; index < 64; index += 1) {
        const member = copyMember(source);
        renameMember(member, `s${index.toString().padStart(3, "0")}.lua`);
        archive.members.push(member);
      }
    });
    assert.equal((await readPdpkg(bytes)).members.length, 63);
  });
  await t.test("255-byte name with 64-byte segments", async () => {
    const name = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(60)].join("/");
    assert.equal(textBytes(name).byteLength, 255);
    const bytes = mutateAnchor(anchor, (archive) => {
      renameMember(namedMember(archive, "helper.lua"), name);
    });
    assert.equal((await readPdpkg(bytes)).members[1].logicalName, name);
  });
  await t.test("one 1 MiB member", async () => {
    const bytes = mutateAnchor(anchor, (archive) => {
      replaceStoredContent(namedMember(archive, "helper.lua"), new Uint8Array(1024 * 1024));
    });
    assert.equal((await readPdpkg(bytes)).members[1].sourceBytes.byteLength, 1024 * 1024);
  });
  await t.test("4 MiB expanded in total", async () => {
    const bootstrapBytes = textBytes('{"packageFormat":1,"generatorContract":1}\n').byteLength;
    const bytes = mutateAnchor(anchor, (archive) => {
      const device = namedMember(archive, "device.lua");
      const helper = namedMember(archive, "helper.lua");
      replaceStoredContent(device, new Uint8Array(1024 * 1024));
      replaceStoredContent(helper, new Uint8Array(1024 * 1024));
      const third = copyMember(helper);
      renameMember(third, "third.lua");
      archive.members.push(third);
      const fourth = copyMember(helper);
      renameMember(fourth, "fourth.lua");
      replaceStoredContent(fourth, new Uint8Array(1024 * 1024 - bootstrapBytes));
      archive.members.push(fourth);
    });
    const result = await readPdpkg(bytes);
    assert.equal(
      result.members.reduce((sum, member) => sum + member.sourceBytes.byteLength, 0) + bootstrapBytes,
      4 * 1024 * 1024,
    );
  });
});

test("expansion limits do not trust declared sizes", async (t) => {
  const anchor = await fixture(STORED_ANCHOR);
  const expanded = new Uint8Array(1024 * 1024 + 1);
  const compressed = await deflateRaw(expanded);
  await t.test("one deflated member crosses 1 MiB while streaming", async () => {
    const bytes = mutateAnchor(anchor, (archive) => {
      const member = namedMember(archive, "helper.lua");
      replaceStoredContent(member, expanded);
      member.data = compressed;
      member.centralMethod = 8;
      member.localMethod = 8;
      member.centralCompressedSize = compressed.byteLength;
      member.localCompressedSize = compressed.byteLength;
      member.centralExpandedSize = 1;
      member.localExpandedSize = 1;
    });
    assert.equal(await rejectionCode(() => readPdpkg(bytes)), "pdpkg.member.expanded-limit");
  });
  await t.test("the fifth member crosses 4 MiB before its size mismatch", async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    const oneMiBCompressed = await deflateRaw(oneMiB);
    const bytes = mutateAnchor(anchor, (archive) => {
      const bootstrap = namedMember(archive, "pdpkg.json");
      const sources = [
        namedMember(archive, "device.lua"),
        namedMember(archive, "helper.lua"),
      ];
      for (const name of ["third.lua", "fourth.lua"]) {
        const member = copyMember(sources[1]);
        renameMember(member, name);
        archive.members.push(member);
        sources.push(member);
      }
      for (const member of sources) {
        replaceStoredContent(member, oneMiB);
        member.data = oneMiBCompressed;
        member.centralMethod = 8;
        member.localMethod = 8;
        member.centralCompressedSize = oneMiBCompressed.byteLength;
        member.localCompressedSize = oneMiBCompressed.byteLength;
      }
      const last = sources.at(-1);
      last.centralExpandedSize -= bootstrap.centralExpandedSize;
      last.localExpandedSize = last.centralExpandedSize;
    });
    assert.equal(await rejectionCode(() => readPdpkg(bytes)), "pdpkg.archive.expanded-limit");
  });
});
