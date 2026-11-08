import { Temporal } from "@js-temporal/polyfill";
import Decimal from "decimal.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const SECOND = 1_000_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
Decimal.set({ precision: 80 });
export const micros = (value: string) => Number(Temporal.Instant.from(value).epochNanoseconds / 1000n);
/** Pydantic datetime JSON preserves a segment's offset and uses Z for UTC. */
export function modelTimestamp(value: string): string {
  const offset = value.match(/(Z|[+-]\d{2}:?\d{2})$/i)?.[0];
  if (!offset) return Temporal.PlainDateTime.from(value).toString({ fractionalSecondDigits: 6 }).replace(/\.000000$/, "");
  const zone = offset.toUpperCase() === "Z" ? "+00:00" : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const local = Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainDateTime().toString({ fractionalSecondDigits: 6 }).replace(/\.000000$/, "");
  return local + (zone === "+00:00" || zone === "-00:00" ? "Z" : zone);
}
export const duration = (value: number) => new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
export const cents = (value: number) => new Decimal(String(value)).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

// Python round(float, n) rounds the actual IEEE-754 value, not its display string.
export function round(value: number, places = 2): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  const exact = new Decimal(mantissa.toString()).mul(new Decimal(2).pow(shift)).mul(value < 0 ? -1 : 1);
  return exact.toDecimalPlaces(places, Decimal.ROUND_HALF_EVEN).toNumber();
}
function instant(value: number) { return Temporal.Instant.fromEpochNanoseconds(BigInt(Math.round(value)) * 1000n); }
export function iso(value: number, model = false) {
  let text = instant(value).toString({ fractionalSecondDigits: 6 });
  if (text.endsWith(".000000Z")) text = text.replace(".000000Z", "Z");
  return model ? text : text.replace(/Z$/, "+00:00");
}
export const datetimeString = (value: number) => iso(value).replace("T", " ");
export const localDate = (value: number, zone: string) => instant(value).toZonedDateTimeISO(zone).toPlainDate().toString();
export const localTime = (value: number, zone: string) => instant(value).toZonedDateTimeISO(zone).toPlainTime().toString({ fractionalSecondDigits: 6 });
export const timeKey = (value: string) => Temporal.PlainTime.from(value).toString({ fractionalSecondDigits: 6 });
export const addDate = (day: string, days: number) => Temporal.PlainDate.from(day).add({ days }).toString();
export const daysBetween = (from: string, to: string) => Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
export const weekday = (day: string) => Temporal.PlainDate.from(day).dayOfWeek - 1;
export function shiftWallDate(value: number, day: string, zone: string): number {
  const local = Temporal.PlainDate.from(day).toPlainDateTime(instant(value).toZonedDateTimeISO(zone).toPlainTime());
  // Rail projections reject both ambiguous and nonexistent local times.
  return Number(local.toZonedDateTime(zone, { disambiguation: "reject" }).epochNanoseconds / 1000n);
}
export function at(day: string, time: string, zone: string) {
  const local = Temporal.PlainDate.from(day).toPlainDateTime(Temporal.PlainTime.from(time));
  // Match zoneinfo's default fold=0, including its pre-transition offset in gaps.
  return Number(local.toZonedDateTime(zone, { disambiguation: "compatible" }).epochNanoseconds / 1000n);
}
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${pythonJson(key)}: ${pythonJson((value as Record<string, unknown>)[key])}`).join(", ")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export const stableId = (...parts: unknown[]) => bytesToHex(sha256(utf8ToBytes(pythonJson(parts)))).slice(0, 24);
export const fingerprint = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
export function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.min(a.length, b.length); index++) { const result = compare(a[index], b[index]); if (result) return result; }
    return a.length - b.length;
  }
  return (a as number | string) < (b as number | string) ? -1 : 1;
}
export function bisect(values: number[], value: number, right = false) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < value || right && values[middle] === value) low = middle + 1; else high = middle; }
  return low;
}
