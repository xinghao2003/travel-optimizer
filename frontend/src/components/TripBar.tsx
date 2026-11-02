import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { tripSummary } from "../lib/present";
import type { SavedTrip, TripDraft } from "../lib/planner";

/** The trip name, the trip summary while settings are closed, the Edit trip toggle and the status strip (C3). */
export function TripBar({ draft, edit, saved, settingsOpen, onToggleSettings, children }: {
  draft: TripDraft; edit: (value: TripDraft) => void; saved: SavedTrip | null;
  settingsOpen: boolean; onToggleSettings: () => void; children?: ReactNode;
}) {
  // A blank name stays here and is never saved; leaving the field shows the trip's name again.
  const [blank, setBlank] = useState<string | null>(null);
  const errorId = useId();
  const summary = settingsOpen ? null : tripSummary(draft);
  // DOM order of B1: name, summary, Edit trip, strip. From 600 px the CSS puts Edit trip on the name row.
  return <div className="p-tripbar">
    <div className="p-trip-name">
      <input aria-label="Trip name" maxLength={120} value={blank ?? draft.name} aria-invalid={blank !== null} aria-describedby={blank !== null ? errorId : undefined}
        onChange={event => { const name = event.target.value; if (name.trim()) { setBlank(null); edit({ ...draft, name }); } else setBlank(name); }}
        onBlur={() => setBlank(null)} />
      <span id={errorId} className="p-field-error" aria-live="polite">{blank !== null && "Enter a trip name."}</span>
    </div>
    {!saved && <p className="p-intro-text">Plan a trip to up to 4 cities. Wayfinder finds door-to-door options and compares the total price with the time you get in each city.</p>}
    {summary && <div className="p-summary"><p>{summary.route}</p><p>{summary.details}</p></div>}
    {saved && <Button type="button" variant="secondary" size="sm" className="p-tripbar-toggle" aria-expanded={settingsOpen} aria-controls="trip-settings" onClick={onToggleSettings}>{settingsOpen ? "Done editing" : "Edit trip"}<ChevronDown size={15} className="p-chevron" aria-hidden="true" /></Button>}
    {children}
  </div>;
}
