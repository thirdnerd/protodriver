import type { AuthoredOperation } from "@protodriver/contracts";

/** Keep the operator's risk decision outside DOM construction so it is
 * testable without a browser and cannot silently disappear from the panel. */
export function authoredRiskPresentation(operation: Pick<AuthoredOperation, "risk" | "repeatability">) {
  return {
    articleClass: `operation risk-${operation.risk}`,
    badge: operation.risk === "read-only" ? null : `Risk: ${operation.risk.replace(/-/gu, " ")}`,
    repeatability: operation.repeatability === "safe-to-repeat" ? "Safe to repeat" : "Not repeatable",
  } as const;
}
