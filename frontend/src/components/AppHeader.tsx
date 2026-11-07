import { Select, SelectItem } from "./ui/select";
import { CircleAlert, CircleCheck, Compass, Copy, Download, Ellipsis, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { ThemeChoice } from "./theme-provider";
import { dateRange } from "../lib/present";
import { closeDetails, useDismiss } from "../lib/useDismiss";
import type { SavedSummary } from "../lib/planner";

const statusIcons = { ok: CircleCheck, busy: LoaderCircle, warn: CircleAlert };

/** The sticky app header (C1): brand, Trip select, New trip, save status and the ⋯ menu. */
export function AppHeader({ trips, currentId, unsaved, status, statusTone, disabled, menuBusy, onOpen, onNew, onCopy, onRecalculate, onExport, canCopy, canRecalculate, canExport }: {
  trips: SavedSummary[]; currentId: string | null; unsaved: boolean; status: string; statusTone: keyof typeof statusIcons;
  disabled: boolean; onOpen: (id: string) => void; onNew: () => void; onCopy: () => void; onRecalculate: () => void; canCopy: boolean; canRecalculate: boolean;
  /** A menu action runs: the menu button shows the spinner. */
  menuBusy: boolean;
  onExport: () => void; canExport: boolean;
}) {
  const menu = useDismiss();
  const StatusIcon = statusIcons[statusTone];
  // A menu item closes the menu, with focus back on its summary, then runs.
  const choose = (action: () => void) => () => {
    if (menu.ref.current) closeDetails(menu.ref.current);
    action();
  };
  return <header className="p-header">
    <div className="p-container p-header-row">
      {/* The sr-only h1 names the app at every width, so the visible brand is hidden from screen readers. */}
      <div className="p-brand" aria-hidden="true"><span className="p-brand-mark"><Compass size={18} /></span><span className="p-brand-name">Wayfinder Routes</span></div>
      <h1 className="sr-only">Wayfinder Routes</h1>
      <div className="p-trip-picker">
        <label className="p-narrow-sr" htmlFor="trip-select">Trip</label>
        <Select id="trip-select" value={currentId ?? ""} disabled={disabled} onValueChange={value => { if (value) onOpen(value); }}>
          {unsaved && <SelectItem value="">New trip (not saved)</SelectItem>}
          {trips.map(trip => <SelectItem key={trip.id} value={trip.id}>{trip.name} · {dateRange(trip.start_date, trip.end_date)}</SelectItem>)}
        </Select>
      </div>
      <Button type="button" variant="secondary" size="sm" className="p-header-button" disabled={disabled} onClick={onNew}><Plus size={15} aria-hidden="true" /><span className="p-narrow-sr">New trip</span></Button>
      <p className="p-save-status" data-tone={statusTone} aria-live="polite"><StatusIcon size={15} aria-hidden="true" className={statusTone === "busy" ? "p-spin" : undefined} /><span className="p-narrow-sr">{status}</span></p>
      <details className="p-menu" {...menu}>
        <summary aria-label="More actions">{menuBusy ? <LoaderCircle size={18} className="p-spin" aria-hidden="true" /> : <Ellipsis size={18} aria-hidden="true" />}</summary>
        <div className="p-menu-panel">
          <button type="button" className="p-menu-item" disabled={!canExport} onClick={choose(onExport)}><Download size={15} aria-hidden="true" /><span>Export trips<small>Share an itinerary or compare trips as PDF or HTML.</small></span></button>
          <button type="button" className="p-menu-item" disabled={!canCopy} onClick={choose(onCopy)}><Copy size={15} aria-hidden="true" /><span>Copy trip<small>{unsaved ? "Save the trip first." : "Copies settings, airport transfers and airport changes. Prices and search results are not copied."}</small></span></button>
          <button type="button" className="p-menu-item" disabled={!canRecalculate} onClick={choose(onRecalculate)}><RefreshCw size={15} aria-hidden="true" /><span>Recalculate options<small>{unsaved ? "Save the trip first." : "Uses saved data. No new search."}</small></span></button>
          <ThemeChoice />
        </div>
      </details>
    </div>
  </header>;
}
