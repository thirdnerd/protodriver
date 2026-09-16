#!/usr/bin/env node

import type { Writable } from "node:stream";

import { isMainModule } from "@protodriver/generated-cli/node-entry-point";

import { runInspectCli } from "./inspect.ts";
import { runPackCli } from "./pack.ts";
import { generatedCliFailure } from "./errors.ts";
import type { WorkerNodeAuthoredRunOptions } from "./authored-worker-client.ts";
import { runAuthoredCli, type NodeAuthoredAcquisition } from "./authored-run.ts";
import { pdrVersion } from "./version.ts";
import { expectedCliError } from "./expected-error.ts";

export interface PdrIo {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly output: Writable;
  readonly error: Writable;
}

export interface PdrRunOptions {
  readonly worker?: WorkerNodeAuthoredRunOptions;
  /** Interim host-owned acquisition; never loaded from the authored package. */
  readonly authoredAcquisition?: NodeAuthoredAcquisition;
}

export async function runPdr(
  rawArgv: readonly string[],
  io: PdrIo,
  options: PdrRunOptions = {},
): Promise<void> {
  const worker = rawArgv[0] === "--worker";
  const argv = worker ? rawArgv.slice(1) : rawArgv;
  if (argv.length === 1 && argv[0] === "--version") {
    io.output.write(await pdrVersion());
    return;
  }
  if (argv[0] === "run") {
    await runAuthoredCli(argv.slice(1), io,
      options.authoredAcquisition, worker ? (options.worker ?? {}) : undefined);
    return;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.output.write(`Usage:
  pdr run <device-directory-or-package> [--mode id] <operation> [flags]
  pdr inspect <device-directory-or-package>
  pdr pack <device-source-directory> <output-package>
  pdr --version

Use pdr run <device-directory-or-package> for authored operations and their flags.
Prefix a command with --worker to use the serializing session adapter.
Use --help or -h to print this usage without loading a device.
`);
    return;
  }
  if (argv[0] === "inspect") await runInspectCli(argv.slice(1), io);
  else if (argv[0] === "pack") await runPackCli(argv.slice(1), io);
  else {
    throw expectedCliError(
      "cli.command.unknown",
      `unknown command ${JSON.stringify(argv[0] ?? "")}; expected run, inspect, or pack`,
      "invocation",
    );
  }
}

if (await isMainModule(import.meta.url)) {
  try {
    await runPdr(process.argv.slice(2), {
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
    });
  } catch (cause) {
    const failure = generatedCliFailure(cause);
    process.stderr.write(`${JSON.stringify({
      category: failure.category,
      error: failure.error,
    })}\n`);
    process.exitCode = failure.exitCode;
  }
}
