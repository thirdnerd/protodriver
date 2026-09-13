/** Branded primitives, so an opaque identifier is visibly deliberate. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
