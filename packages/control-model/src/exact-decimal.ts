export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly decimalPlaces: number;
}

export function parseExactDecimal(source: string): ExactDecimal | null {
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(source);
  if (match === null) return null;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return null;
  const fraction = match[3] ?? "";
  let coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`);
  let decimalPlaces = fraction.length - exponent;
  if (decimalPlaces < 0) {
    coefficient *= 10n ** BigInt(-decimalPlaces);
    decimalPlaces = 0;
  }
  return { coefficient, decimalPlaces };
}

export function divideExactDecimal(value: ExactDecimal, divisor: bigint): string {
  let numerator = value.coefficient;
  let denominator = (10n ** BigInt(value.decimalPlaces)) * divisor;
  const common = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
  numerator /= common;
  denominator /= common;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) {
    throw new Error("exact human-unit scaling requires a terminating decimal denominator containing only factors 2 and 5");
  }
  const places = Math.max(twos, fives);
  numerator *= (2n ** BigInt(places - twos)) * (5n ** BigInt(places - fives));
  return formatExactDecimal({ coefficient: numerator, decimalPlaces: places });
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left === 0n ? 1n : left;
}

function formatExactDecimal(value: ExactDecimal): string {
  const negative = value.coefficient < 0n;
  const magnitude = (negative ? -value.coefficient : value.coefficient).toString(10);
  if (value.decimalPlaces === 0) return `${negative ? "-" : ""}${magnitude}`;
  const padded = magnitude.padStart(value.decimalPlaces + 1, "0");
  const split = padded.length - value.decimalPlaces;
  const fraction = padded.slice(split).replace(/0+$/u, "");
  const number = fraction.length === 0 ? padded.slice(0, split) : `${padded.slice(0, split)}.${fraction}`;
  return `${negative && number !== "0" ? "-" : ""}${number}`;
}
