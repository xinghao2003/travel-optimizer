import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const money = (amount: number | null | undefined) =>
  amount == null ? "—" : `RM ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const shortMoney = (amount: number | null | undefined) =>
  amount == null ? "—" : `RM ${Math.round(amount).toLocaleString("en-MY")}`;

export const dateLabel = (value: string | null | undefined) => {
  if (!value) return "Date unavailable";
  const date = new Date(value + "T00:00:00");
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
};
