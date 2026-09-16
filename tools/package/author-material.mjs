import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const BLANK_SOURCE = "examples/start/device.lua";
const DEMO_THERMOSTAT_SOURCE = "examples/demo-thermostat";
const CE_GUIDE_SOURCE = "examples/ti84-plus-ce/README.md";
const CE_TRANSCRIPT_SOURCE = "examples/ti84-plus-ce/transcript.txt";

export const WORKED_SOURCE_FILES = Object.freeze([
  "corpus/device-1/channel-layout.lua",
  "corpus/device-1/channel-wire.lua",
  "corpus/device-1/device.lua",
  "corpus/device-2/device.lua",
  "corpus/device-3/device.lua",
  "corpus/ti-84-evo/cbor.lua",
  "corpus/ti-84-evo/device.lua",
  "corpus/ti-84-evo/evo.lua",
  "corpus/ti-84-evo/screen.lua",
  "corpus/ti-nspire-handheld/device.lua",
  "corpus/ti84-plus-ce/bmp.lua",
  "corpus/ti84-plus-ce/device.lua",
  "corpus/ti84-plus-ce/directlink.lua",
]);

function examplePath(sourcePath) {
  if (!sourcePath.startsWith("corpus/")) {
    throw new TypeError(`worked source must be under corpus/: ${sourcePath}`);
  }
  return `examples/${sourcePath.slice("corpus/".length)}`;
}

export async function stagePackageAuthorMaterial({
  packageRoot,
  sourceDirectory,
  target,
} = {}) {
  if (packageRoot === undefined) throw new TypeError("packageRoot is required");
  if (sourceDirectory === undefined) throw new TypeError("sourceDirectory is required");
  if (target === undefined) throw new TypeError("target is required");
  const root = resolve(packageRoot);
  const sourceRoot = resolve(sourceDirectory);
  const guidePath = `docs/${target.id}-package.md`;

  await Promise.all([
    mkdir(join(root, "docs"), { recursive: true }),
    mkdir(join(root, "examples", "start"), { recursive: true }),
    ...WORKED_SOURCE_FILES.map((path) => (
      mkdir(dirname(join(root, examplePath(path))), { recursive: true })
    )),
  ]);
  for (const path of WORKED_SOURCE_FILES) {
    await cp(join(sourceRoot, path), join(root, examplePath(path)));
  }
  await cp(join(sourceRoot, BLANK_SOURCE), join(root, "examples/start/device.lua"));
  await cp(
    join(sourceRoot, DEMO_THERMOSTAT_SOURCE),
    join(root, "examples/demo-thermostat"),
    { recursive: true },
  );

  const [tutorial, reference, thermostat, ceGuide, linuxUsb] = await Promise.all([
    readFile(join(sourceRoot, "docs/author-tutorial.md"), "utf8"),
    readFile(join(sourceRoot, "docs/declaration-reference.md"), "utf8"),
    readFile(join(sourceRoot, DEMO_THERMOSTAT_SOURCE, "README.md"), "utf8"),
    readFile(join(sourceRoot, CE_GUIDE_SOURCE), "utf8"),
    readFile(join(sourceRoot, "docs/linux-usb-permissions.md"), "utf8"),
  ]);
  await Promise.all([
    writeFile(join(root, "README.md"), renderReadme(target, guidePath)),
    writeFile(join(root, "docs/author-tutorial.md"), transformTutorial(tutorial, target)),
    writeFile(join(root, "docs/declaration-reference.md"), transformReference(reference)),
    writeFile(join(root, guidePath), renderTargetGuide(target, linuxUsb)),
    writeFile(join(root, "examples/README.md"), renderExamplesReadme()),
    writeFile(join(root, "examples/device-1/README.md"), renderDevice1Example()),
    writeFile(join(root, "examples/device-3/README.md"), renderDevice3Example()),
    writeFile(
      join(root, "examples/demo-thermostat/README.md"),
      transformThermostatGuide(thermostat, target),
    ),
    writeFile(join(root, "examples/ti84-plus-ce/README.md"), transformCeGuide(ceGuide)),
    cp(
      join(sourceRoot, CE_TRANSCRIPT_SOURCE),
      join(root, "examples/ti84-plus-ce/transcript.txt"),
    ),
  ]);

  return checkPackagedMarkdownLinks(root);
}

function launcher(target) {
  return target.os === "win32" ? ".\\bin\\pdr.cmd" : "./bin/pdr";
}

function transformTutorial(source, target) {
  const command = launcher(target);
  return source
    .replaceAll("Linux x64", target.id)
    .replaceAll("./bin/pdr", command)
    .replaceAll("corpus/", "examples/");
}

function transformReference(source) {
  return source.replaceAll("corpus/", "examples/");
}

function transformThermostatGuide(source, target) {
  const marker = "To write alongside the example";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error("package-author.rewrite-premise-invalid: thermostat intro");
  let transformed = `# Build a driver: DemoBench thermostat

This is a fictional serial thermostat, so no hardware or serial-port permission
is needed to study it. Start in the extracted ${target.id} release root. The
included [checked transcript](transcript.txt) was generated in the project by a
host-injected simulator that imports no constants from the module. That runner
is repository test infrastructure, not a release dependency: every authored
checkpoint, protocol fact, command, and observed result needed for this
walkthrough is included here.

${source.slice(markerIndex)}`;
  const command = launcher(target);
  const setupBefore = `\`\`\`bash
mkdir -p demo-work
cp examples/demo-thermostat/step-1/device.lua demo-work/device.lua
node apps/cli/src/pdr.ts pack demo-work demo-work.pdpkg
\`\`\``;
  const setupAfter = target.os === "win32"
    ? `\`\`\`powershell
New-Item -ItemType Directory -Force demo-work | Out-Null
Copy-Item examples/demo-thermostat/step-1/device.lua demo-work/device.lua
${command} pack demo-work demo-work.pdpkg
\`\`\``
    : `\`\`\`bash
mkdir -p demo-work
cp examples/demo-thermostat/step-1/device.lua demo-work/device.lua
${command} pack demo-work demo-work.pdpkg
\`\`\``;
  transformed = replaceExactly(transformed, setupBefore, setupAfter, "thermostat setup")
    .replaceAll("node apps/cli/src/pdr.ts", command)
    .replaceAll("corpus/", "examples/");
  return target.os === "win32" ? transformed.replaceAll("```bash", "```powershell") : transformed;
}

function transformCeGuide(source) {
  return source
    .replaceAll("[`corpus/ti84-plus-ce/`](../../corpus/ti84-plus-ce/)", "the source files beside this README")
    .replaceAll("[`device.lua`](../../corpus/ti84-plus-ce/device.lua)", "[`device.lua`](device.lua)")
    .replaceAll("[`directlink.lua`](../../corpus/ti84-plus-ce/directlink.lua)", "[`directlink.lua`](directlink.lua)")
    .replaceAll("[`bmp.lua`](../../corpus/ti84-plus-ce/bmp.lua)", "[`bmp.lua`](bmp.lua)")
    .replace(
      /The permanent control at\n\[[\s\S]*?The harness checks/u,
      "The permanent project control regenerates every transcript line. Its harness\nchecks",
    );
}

function renderReadme(target, guidePath) {
  const command = launcher(target);
  return `# Protodriver — ${target.id}

This is the complete ${target.id} Protodriver release: the CLI and browser
runtime, author documentation, a blank starting module, and worked modules are
all in this one extracted directory. It needs no separate Node, npm, compiler,
repository checkout, or product download.

Start with the blank module; these commands acquire no hardware:

\`\`\`${target.os === "win32" ? "powershell" : "bash"}
${command} pack examples/start blank-device.pdpkg
${command} run blank-device.pdpkg --help
${command} inspect blank-device.pdpkg
\`\`\`

Read [Write a device module](docs/author-tutorial.md), the [contract-2
reference](docs/declaration-reference.md), and this release's [target setup
guide](${guidePath}). [The examples index](examples/README.md) distinguishes the
blank source, the progressive thermostat walkthrough, and finished modules.

Generated help and inspect do not enumerate acquisition candidates. An actual
operation begins acquisition and may run entry protocol writes after selection.
Use generated operation help to check risk and repeatability before a live run.

The launchers resolve runtime files relative to this directory, so the whole
directory may be moved after extraction.
`;
}

function renderExamplesReadme() {
  return `# Module examples

- [\`start/device.lua\`](start/device.lua) is the blank source to copy first. It
  contains no measured acquisition or protocol facts and its operation fails as
  not implemented.
- [\`demo-thermostat/\`](demo-thermostat/README.md) builds a fictional serial
  module in three checkpoints from a written protocol and a checked independent
  simulator transcript.
- [\`ti84-plus-ce/\`](ti84-plus-ce/README.md) explains a complete measured
  screenshot module beside its three Lua members and checked project transcript.
- \`device-1/\`, \`device-2/\`, \`device-3/\`, \`ti-84-evo/\`, and
  \`ti-nspire-handheld/\` are complete worked source sets. Their identities,
  framing, requests, limits, and completion rules are facts about the named
  examples, not defaults for a new device.

Every source set has one \`device.lua\`; helper \`.lua\` files in the same
directory are exact package members resolved by their logical filename.
`;
}

function renderDevice1Example() {
  return `# Split Device 1 worked source

This example separates one source set by responsibility. \`device.lua\`
declares the public device surface and composes its bindings;
\`channel-wire.lua\` owns framing and protocol exchange; and
\`channel-layout.lua\` owns the stored record schema and its encoding and
decoding, deliberately without transport behavior.

This module keeps a transfer session alive rather than replacing it, and its
timing constants are measured properties of a real device rather than sample
values. The mode it establishes is dropped after 300 ms of silence, so
\`maximumInterTransactionGapMs\` declares that bound and the maintenance poll
transmits every 200 ms to stay inside it. Reaching that mode ends the session in
a device reset, so the profile declares a 3,000 ms post-termination silence and a
300 ms opening drain before the next one. Those numbers are this design's answer
for this device. A device whose session is consumed by a single operation wants
the opposite design -- close and reacquire inside the operation -- which the
declaration reference describes under session lifetime.

The two \`require\` calls use each logical member name exactly as it appears in
the package. They are lookups in the verified source set, not filesystem paths.
Packaging admits all three Lua members together, and source-set identity covers
every member's logical name and bytes.
`;
}

function renderDevice3Example() {
  return `# Complete Device 3 worked source

\`device.lua\` is a complete contract-2 source: it declares serial and USB
acquisition, entry and handler ownership, three public operations, and all Lua
bindings. The lowest-risk live operation is \`get_device_info\`, which generated
help labels read-only and safe-to-repeat. Do not use \`write_image\` as an
on-ramp check: it is destructive and not repeatable.

Its acquisition identifiers, framing, transactions, deadlines, and result
types are measured Device 3 facts, not defaults for a new device.
`;
}

function renderTargetGuide(target, linuxUsbSource) {
  const command = launcher(target);
  const commands = `\`\`\`${target.os === "win32" ? "powershell" : "bash"}
${command} pack examples/start blank-device.pdpkg
${command} run blank-device.pdpkg --help
${command} inspect blank-device.pdpkg
\`\`\``;
  if (target.os === "linux") {
    const usb = linuxUsbSource
      .replace(/^# Linux USB access for module authors\n+/u, "")
      .replaceAll("./protodriver-linux-x64/bin/pdr", "./bin/pdr")
      .replaceAll("Use `protodriver-linux-arm64` for the arm64 package. ", "");
    return `# ${target.id} setup

This release carries its own Node runtime, CLI source, native serial/USB/ioctl
addons and pinned Lua VM. The runtime floor is glibc 2.28. USB needs
\`libudev.so.1\`, and serial-port enumeration uses \`udevadm\`.

${commands}

The launchers resolve every product file relative to this extracted directory.

## USB access

${usb}`;
  }
  if (target.os === "darwin") {
    return `# ${target.id} setup

This release carries its own Node runtime, CLI source, native serial/USB/ioctl
addons and pinned Lua VM. macOS 13.5 is the runtime floor. Device access still
depends on macOS permissions and whether IOKit or a kernel driver permits the
interface claim. An x64 release running on Apple Silicon also requires Rosetta.

${commands}

The launchers resolve every product file relative to this extracted directory.
`;
  }
  return `# ${target.id} setup

This release carries its own Node runtime, emitted CLI JavaScript, native serial
and USB addons, and the pinned Lua VM. Device access still depends on Windows
driver state and permissions.

${commands}

The launchers resolve every product file relative to this extracted directory.
`;
}

export async function checkPackagedMarkdownLinks(packageRoot) {
  const root = resolve(packageRoot);
  const markdownFiles = [join(root, "README.md")];
  for (const directory of [join(root, "docs"), join(root, "examples")]) {
    markdownFiles.push(...await findMarkdownFiles(directory));
  }
  const missing = [];
  let checked = 0;
  for (const markdownPath of markdownFiles.sort()) {
    const source = await readFile(markdownPath, "utf8");
    for (const link of markdownLinks(source)) {
      if (isExternalLink(link.destination)) continue;
      checked += 1;
      const withoutFragment = link.destination.split("#", 1)[0].split("?", 1)[0];
      const decoded = decodeURIComponent(withoutFragment.replace(/^<|>$/gu, ""));
      const destination = decoded === "" ? markdownPath : resolve(dirname(markdownPath), decoded);
      const relativeDestination = relative(root, destination);
      if (relativeDestination === ".." || relativeDestination.startsWith(`..${sep}`)) {
        missing.push(`${relative(root, markdownPath)}:${link.line} escapes release: ${link.destination}`);
        continue;
      }
      const info = await lstat(destination).catch(() => undefined);
      if (info === undefined) {
        missing.push(`${relative(root, markdownPath)}:${link.line} missing: ${link.destination}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`package-author.link-missing:\n${missing.join("\n")}`);
  }
  return Object.freeze({ checked, markdownFiles: markdownFiles.length });
}

async function findMarkdownFiles(root) {
  const found = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findMarkdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

function markdownLinks(source) {
  const links = [];
  const expression = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\)/gu;
  for (const match of source.matchAll(expression)) {
    links.push({
      destination: match[1],
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return links;
}

function isExternalLink(destination) {
  const normalized = destination.replace(/^<|>$/gu, "");
  return /^[a-z][a-z0-9+.-]*:/iu.test(normalized) || normalized.startsWith("//");
}

function replaceExactly(source, before, after, subject) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`package-author.rewrite-premise-invalid: expected one match in ${subject}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}
