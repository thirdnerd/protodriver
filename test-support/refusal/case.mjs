// Shared by fast controls and the on-demand qualifier; also browser-safe.
// No runner, source scan, mutation, or extra population runs on import.
export function refusalCase(spec) {
  if (!spec.id || !Number.isSafeInteger(spec.grant) || spec.grant <= 0)
    throw new Error("refusal case requires an identity and its real grant");
  if (!["body", "conservation"].includes(spec.kind)) throw new Error("unknown qualification kind");
  if (spec.kind === "conservation" && (!spec.reason || spec.reason.length < 80))
    throw new Error("conservation needs an explicit reason a dominant body cannot qualify this boundary");
  if (spec.kind === "conservation" && (!Number.isSafeInteger(spec.conservation?.units)
    || spec.conservation.units <= 0 || typeof spec.conservation.observations !== "function"
    || typeof spec.conservation.rule !== "string" || spec.conservation.rule.length < 30))
    throw new Error("conservation requires a protocol rule and before/after authority observations");
  for (const field of ["prefix", "position", "complete"])
    if (typeof spec[field] !== "function") throw new Error("missing refusal predicate: " + field);
  return Object.freeze({ ...spec,
    begin() { globalThis[Symbol.for("refusal-meter")]?.begin(spec); },
    check(observation) {
      const meter = globalThis[Symbol.for("refusal-meter")];
      const reference = meter?.phase === "reference";
      // A mutant reaching completion is informative; a different diagnostic is
      // NOT. Prefix and diagnostic eligibility precede the targeted assertion.
      const diagnostic = observation.code ?? null;
      const transfers = spec.kind==="conservation" ? spec.conservation.observations(observation) : null;
      const conserved = transfers===null || (transfers.length>0
        && transfers.every(r=>Number.isSafeInteger(r.before)&&r.before>=0
          && Number.isSafeInteger(r.after)&&r.after-r.before===spec.conservation.units
          && typeof r.owner==="string"&&r.owner.length>0)
        && new Set(transfers.map(r=>r.owner)).size===1);
      let failure = !spec.prefix(observation) ? "prefix"
        : diagnostic !== null && diagnostic !== "retained.work-exhausted" ? "diagnostic"
        : reference ? (!spec.complete(observation) || diagnostic !== null ? "reference-result" : null)
        : !spec.position(observation) || !conserved ? "body-position"
        : diagnostic !== "retained.work-exhausted" ? "diagnostic" : null;
      const report = { id: spec.id, kind: spec.kind, grant: spec.grant, failure,
        phase: meter?.phase ?? "normal", mutation: meter?.mutation ?? null,
        work: meter?.work ?? null, observation };
      meter?.report(report);
      if (failure) throw Object.assign(new Error(spec.id + ": " + failure), { code: "refusal." + failure, report });
      return report;
    },
  });
}
