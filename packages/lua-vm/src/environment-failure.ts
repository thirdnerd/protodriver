export function environmentFailure(code: number): Error {
  const names = new Map<number, string>([
    [-1, "malformed"], [-2, "capacity"], [-3, "non-finite"],
    [-4, "negative-zero"], [-5, "forbidden-crossing"], [-6, "source"],
    [-7, "program"], [-8, "invalid-text"], [-10, "missing-value"],
    [-11, "array-shape"], [-12, "record-key"], [-13, "cycle"],
    [-14, "boundary-object"], [-15, "require-missing"],
    [-16, "require-initialization-cycle"], [-19, "admission-exports"],
    [-20, "invocation-export"], [-21, "pointer-rendering"],
    [-22, "integer-decimal"], [-23, "integer-range"],
    [-24, "variant-tag"], [-25, "variant-value"],
  ]);
  const name = `lua-vm.environment.${names.get(code) ?? `failure-${code}`}`;
  const error = new Error(`${name}: closed Lua execution failed`);
  Object.defineProperty(error, "code", { value: name, enumerable: true });
  return error;
}
