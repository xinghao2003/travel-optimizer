import type { TripDraft } from "./planner";

export type Workspace = "setup" | "compare" | "pricing";
export function workspaceFromHash(value: string): Workspace {
  const hash = value.replace(/^#/, "");
  return ["pricing", "missing-fares-title", "airport-connections-title", "transport-details-title"].includes(hash) ? "pricing" : ["compare", "frontier-title", "details-title"].includes(hash) ? "compare" : "setup";
}

export function tripSetupIssues(draft: TripDraft): string[] {
  const issues: string[] = [];
  if (!draft.home) issues.push("Choose your home city");
  if (!draft.visits.length) issues.push("Add a city to visit");
  if (!draft.name.trim()) issues.push("Enter a trip name");
  if (!draft.modes.length) issues.push("Select a transport mode");
  const days = (Date.parse(draft.end_date) - Date.parse(draft.start_date)) / 86400000;
  if (!Number.isFinite(days) || days < 0 || days > 365) issues.push("Choose travel dates within a 365-day range");
  if (!Number.isInteger(draft.adults) || draft.adults < 1 || draft.adults > 9) issues.push("Choose 1 to 9 adult travelers");
  if (draft.budget_myr !== null && (!Number.isFinite(draft.budget_myr) || draft.budget_myr < 0)) issues.push("Enter a budget of zero or more, or leave it blank");
  if (draft.visits.some(visit => !Number.isFinite(visit.min_stay_hours) || visit.min_stay_hours < 0)) issues.push("Minimum stays must be zero hours or more");
  if (!draft.departure_start || !draft.departure_end || draft.departure_end <= draft.departure_start) issues.push("End the local departure window after it starts in Search preferences");
  return issues;
}
