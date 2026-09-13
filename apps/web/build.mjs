import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";

const defaultSourceRoot = dirname(fileURLToPath(import.meta.url));

export async function buildWebDistribution({
  sourceDirectory = defaultSourceRoot,
  outputDirectory = join(sourceDirectory, "dist"),
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
  await Promise.all([
    cp(join(sourceRoot, "src", "index.html"), join(output, "index.html")),
    cp(join(sourceRoot, "src", "styles.css"), join(output, "styles.css")),
  ]);
  return Object.freeze({ outputDirectory: output, metafile: result.metafile });
}

if (await isMainModule(import.meta.url)) {
  await buildWebDistribution();
}
