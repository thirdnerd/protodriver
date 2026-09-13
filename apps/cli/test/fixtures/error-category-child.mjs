import { generatedCliFailure } from "../../src/errors.ts";

const requested = process.argv[2];
const causes = {
  unexpected: new Error("unrecognised throw"),
  definition: {
    diagnostic: {
      code: "pdpkg.archive.invalid",
      message: "package archive is invalid",
    },
  },
  operation: {
    error: {
      code: "transfer.settlement.timeout",
      message: "device transfer settlement timed out",
      retryability: "after-recovery",
    },
  },
  host: {
    error: {
      code: "resource.read-failed",
      message: "host resource read failed",
      retryability: "no",
    },
  },
  uncategorized: {
    diagnostic: {
      code: "future-domain.failure",
      message: "registered diagnostic has no category decision",
    },
  },
  cancelled: new DOMException("operator cancelled", "AbortError"),
};

if (!Object.hasOwn(causes, requested)) throw new Error(`unknown error category fixture ${JSON.stringify(requested)}`);

try {
  throw causes[requested];
} catch (cause) {
  const failure = generatedCliFailure(cause);
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = failure.exitCode;
}
