import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";

const defaultSourceRoot = dirname(fileURLToPath(import.meta.url));

export async function buildWebDistribution({
  sourceDirectory = defaultSourceRoot,
  outputDirectory = join(sourceDirectory, "dist"),
  catalogHref,
} = {}) {
  const sourceRoot = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  // The package entry point installs workspaces before invoking this builder.
  // A static esbuild import would stop that installer from loading at all.
  const { build } = await import("esbuild");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: {
      app: "src/main.ts",
      sessionWorker: "src/session-worker.ts",
    },
    outdir: output,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120"],
    loader: { ".wasm": "binary" },
    metafile: true,
  });
  const pageOutput = Object.values(result.metafile.outputs).find(
    ({ entryPoint }) => entryPoint === "src/main.ts",
  );
  if (pageOutput === undefined) throw new Error("browser build emitted no app entry point");
  const forbiddenPageInputs = Object.keys(pageOutput.inputs).filter((input) =>
    input.includes("corpus/device-1/")
    || input.includes("packages/transport-browser-serial/")
    || input.endsWith("packages/core/src/capture.ts"));
  if (forbiddenPageInputs.length > 0) {
    throw new Error(
      `the page bundle crossed the worker ownership boundary: ${forbiddenPageInputs.join(", ")}`,
    );
  }
  const sourceIndex = join(sourceRoot, "src", "index.html");
  await Promise.all([
    catalogHref === undefined
      ? cp(sourceIndex, join(output, "index.html"))
      : writeFile(
        join(output, "index.html"),
        declarePackageCatalog(await readFile(sourceIndex, "utf8"), catalogHref),
      ),
    cp(join(sourceRoot, "src", "styles.css"), join(output, "styles.css")),
  ]);
  return Object.freeze({ outputDirectory: output, metafile: result.metafile });
}

function declarePackageCatalog(page, catalogHref) {
  if (typeof catalogHref !== "string") throw new TypeError("catalogHref must be a string");
  const headEnd = "  </head>";
  if (!page.includes(headEnd)) throw new Error("browser source page has no closing head element");
  const declaration = `    <meta name="protodriver-package-catalog" content="${escapeAttribute(catalogHref)}">\n`;
  return page.replace(headEnd, `${declaration}${headEnd}`);
}

function escapeAttribute(value) {
  return value.replace(/[&"<>]/gu, character => ({
    "&": "&amp;",
    '"': "&quot;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]);
}

function parseArguments(argv) {
  let catalogHref;
  let outputDirectory;
  let sourceDirectory;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(usage());
    if (name === "--catalog") catalogHref = value;
    else if (name === "--output") outputDirectory = value;
    else if (name === "--source") sourceDirectory = value;
    else throw new Error(usage());
  }
  return { catalogHref, outputDirectory, sourceDirectory };
}

function usage() {
  return "usage: node apps/web/build.mjs [--catalog HREF] [--output DIRECTORY] [--source DIRECTORY]";
}

if (await isMainModule(import.meta.url)) {
  await buildWebDistribution(parseArguments(process.argv.slice(2)));
}
