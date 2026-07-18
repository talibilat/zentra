import { z } from "zod";

export const MAX_COST_USD = 10_000;
export const MAX_COST_USD_NANO = 10_000_000_000_000;
export const CostUsdNanoSchema = z.number().int().nonnegative().max(MAX_COST_USD_NANO);

export function usdNumberToNano(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_COST_USD) throw new Error("USD value is outside the supported bound");
  const encoded = value.toString();
  const scaled = /e/i.test(encoded) ? scientificToScaledInteger(encoded, 9) : decimalToScaledInteger(encoded, 9);
  const result = Number(scaled);
  if (!Number.isSafeInteger(result) || result > MAX_COST_USD_NANO) throw new Error("USD nanodollar value is outside the supported bound");
  return result;
}

export function nanoToUsdDisplay(value: number): number {
  return CostUsdNanoSchema.parse(value) / 1_000_000_000;
}

export function costFieldsAgree(costUsd: number, costUsdNano: number): boolean {
  try {
    return usdNumberToNano(costUsd) === CostUsdNanoSchema.parse(costUsdNano);
  } catch {
    return false;
  }
}

function decimalToScaledInteger(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new Error("USD value is not a canonical decimal");
  const fraction = match[2] ?? "";
  return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt(`${fraction}${"0".repeat(scale)}`.slice(0, scale) || "0");
}

function scientificToScaledInteger(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(value);
  if (match === null) throw new Error("USD value is not a canonical scientific decimal");
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  const decimalIndex = whole.length + Number(match[3]);
  const digits = `${whole}${fraction}`;
  const shifted = decimalIndex <= 0 ? `${"0".repeat(-decimalIndex)}${digits}` :
    decimalIndex >= digits.length ? `${digits}${"0".repeat(decimalIndex - digits.length)}` : digits;
  const integerDigits = decimalIndex <= 0 ? "0" : shifted.slice(0, decimalIndex);
  const fractionalDigits = decimalIndex <= 0 ? shifted : shifted.slice(decimalIndex);
  return BigInt(integerDigits || "0") * 10n ** BigInt(scale) + BigInt(`${fractionalDigits}${"0".repeat(scale)}`.slice(0, scale) || "0");
}
