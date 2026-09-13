/** Closed set of fixed semantic unit identifiers admitted by authored descriptions. */
export const SEMANTIC_UNIT_IDENTIFIERS = Object.freeze([
  "byte",
  "centidegree-celsius",
  "hertz",
  "microsecond",
  "millisecond",
  "millivolt",
  "tenth-hertz",
] as const);

export type SemanticUnitIdentifier = typeof SEMANTIC_UNIT_IDENTIFIERS[number];

/** A numeric value whose magnitude is already expressed in the named unit. */
export interface FixedSemanticUnitContract {
  readonly kind: "fixed";
  readonly id: SemanticUnitIdentifier;
}
