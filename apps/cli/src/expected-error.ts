import type { PdrFailure, PdrFailureResponsibility } from "@protodriver/contracts";

/** Construct an expected CLI failure without treating arbitrary Error.code values as typed. */
export function expectedCliError(
  code: string,
  message: string,
  responsibility: PdrFailureResponsibility,
  cause?: unknown,
): Error & { readonly error: PdrFailure } {
  const error: PdrFailure = { code, message, responsibility, retryability: "no" };
  const thrown = cause instanceof Error
    ? cause
    : new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
  if (cause instanceof Error) Object.defineProperty(thrown, "message", { value: `${code}: ${message}`, configurable: true });
  return Object.assign(thrown, { error });
}

export async function cliFileSystem<T>(subject: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const code = cause instanceof Error && "code" in cause ? (cause as NodeJS.ErrnoException).code : undefined;
    const invocation = code === "ENOENT" || code === "ENOTDIR";
    throw expectedCliError(invocation ? "cli.path.not-found" : "cli.filesystem.failed",
      invocation ? `${subject} does not exist` : `host filesystem access failed for ${subject}`,
      invocation ? "invocation" : "host", cause);
  }
}
