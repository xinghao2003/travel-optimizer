export type TemporalType = "date" | "datetime-local" | "time";

/** Parse a calendar date without UTC conversion or JavaScript's rollover of impossible days. */
export function parseCalendarDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

export function calendarDateValue(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Accept partial typing, but never a fifth year digit, including on paste. */
export function acceptsTemporalText(text: string, type: TemporalType): boolean {
  if (type === "time") return /^\d{0,2}(:\d{0,2})?$/.test(text);
  const pattern = type === "date" ? /^\d{0,4}(-\d{0,2})?(-\d{0,2})?$/ : /^\d{0,4}(-\d{0,2})?(-\d{0,2})?([ T]\d{0,2}(:\d{0,2})?)?$/;
  return pattern.test(text);
}

const masks: Record<TemporalType, { sizes: number[]; separators: string[] }> = {
  date: { sizes: [4, 2, 2], separators: ["-", "-"] },
  "datetime-local": { sizes: [4, 2, 2, 2, 2], separators: ["-", "-", " ", ":"] },
  time: { sizes: [2, 2], separators: [":"] },
};

/**
 * Insert separators while the user types digits, e.g. "20260501" -> "2026-05-01".
 * A typed separator ends a short 2-digit group with a leading zero ("9:" -> "09:").
 */
export function formatTemporalText(raw: string, type: TemporalType): string {
  const { sizes, separators } = masks[type];
  const groups = [""];
  for (const char of raw) {
    const index = groups.length - 1, group = groups[index];
    if (/\d/.test(char)) {
      groups[index] = group + char;
      if (groups[index].length === sizes[index]) {
        if (index === sizes.length - 1) break;
        groups.push("");
      }
    } else if (group && sizes[index] === 2) {
      groups[index] = group.padStart(2, "0");
      if (index === sizes.length - 1) break;
      groups.push("");
    }
  }
  return groups.reduce((text, group, index) => index === 0 ? group : text + separators[index - 1] + group, "");
}

export function temporalError(text: string, type: TemporalType, min?: string): string {
  if (!text) return "";
  const value = text.replace(" ", "T");
  const [date, time] = type === "time" ? ["", value] : value.split("T");
  if (type !== "time" && !parseCalendarDate(date)) return "Enter a valid date as YYYY-MM-DD (4-digit year).";
  if (type !== "date" && (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return "Enter a time as HH:mm (00:00–23:59).";
  if (min && value < min) return `Enter ${min.replace("T", " ")} or later.`;
  return "";
}
