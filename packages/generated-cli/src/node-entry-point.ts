import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether a module is the program entry point, independent of filesystem
 * aliases in the path used to invoke it.
 */
export async function isMainModule(
  moduleUrl: string,
  argv: readonly string[] = process.argv,
): Promise<boolean> {
  const invokedPath = argv[1];
  if (invokedPath === undefined) return false;
  return await realpath(resolve(invokedPath)) === await realpath(fileURLToPath(moduleUrl));
}
