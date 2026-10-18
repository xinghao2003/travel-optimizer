import { useState } from "react";
import { Button } from "./ui/button";
import { modes, type AirportTransferEstimate, type AirportTransferMode, type SavedTrip } from "../lib/planner";

type Draft = { mode: AirportTransferMode; low: string; high: string; duration: string; currency: string };
export function AirportTransferTable({ trip, save, report }: { trip: SavedTrip; save: (estimates: AirportTransferEstimate[]) => Promise<void>; report: (message: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, Draft[]>>({});
  const [busy, setBusy] = useState(false);
  const rows = trip.airport_transfer_rows ?? [];
  const adults = trip.spec.adults;
  const keyFor = (from: string, to: string) => JSON.stringify([from, to, adults]);
  const blank = (mode: AirportTransferMode = "taxi"): Draft => ({ mode, low: "", high: "", duration: "", currency: "MYR" });
  const values = (from: string, to: string): Draft[] => {
    const saved = trip.airport_transfer_estimates?.filter(e => e.from_id === from && e.to_id === to && e.adults === adults) ?? [];
    return drafts[keyFor(from, to)] ?? (saved.length ? saved.map(e => ({ mode: e.mode, low: e.low == null ? "" : String(e.low), high: e.high == null ? "" : String(e.high), duration: e.duration_minutes == null ? "" : String(e.duration_minutes), currency: e.currency })) : [blank()]);
  };
  if (!rows.length) return null;
  async function submit() {
    setBusy(true);
    try {
      const estimates = (trip.airport_transfer_estimates ?? []).filter(e => e.adults !== adults && rows.some(r => r.from_id === e.from_id && r.to_id === e.to_id));
      for (const row of rows) {
        const seen = new Set<string>();
        for (const value of values(row.from_id, row.to_id)) {
          if (seen.has(value.mode)) throw new Error("Use each transfer method once per direction.");
          seen.add(value.mode);
          if (!value.low.trim() && !value.high.trim() && !value.duration.trim() && value.mode === "taxi") continue;
          const low = value.low.trim() ? Number(value.low) : null;
          const high = value.high.trim() ? Number(value.high) : null;
          const duration = value.duration.trim() ? Number(value.duration) : null;
          if ((low !== null && (!Number.isFinite(low) || low < 0)) || (high !== null && (low === null || !Number.isFinite(high) || high < low))) throw new Error("Enter a nonnegative fare and a maximum at least as large as its minimum.");
          if ((duration !== null && (!Number.isFinite(duration) || duration <= 0)) || (value.mode !== "taxi" && duration === null)) throw new Error("Enter a positive travel time for each alternative transfer method.");
          estimates.push({ from_id: row.from_id, to_id: row.to_id, adults, mode: value.mode, duration_minutes: duration, low, high, currency: value.currency.toUpperCase() });
        }
      }
      await save(estimates);
      setDrafts({});
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="p-panel"><div className="p-panel-heading"><h2>Airport ↔ city transfers</h2><span className="p-tag">{rows.length} directions · {adults} travelers</span></div>
    <p>Add transfer methods with travel times and whole-party fares. The optimizer compares these options for current and future journeys in this trip. Each direction is separate; individual fare overrides take priority.</p>
    <div className="p-airport-table-wrap"><table className="p-airport-table"><thead><tr><th>Transfer</th><th>Method</th><th>Time · min</th><th>Party fare</th><th>Maximum (optional)</th><th>Currency</th><th /></tr></thead><tbody>{rows.flatMap(row => {
      const key = keyFor(row.from_id, row.to_id), entries = values(row.from_id, row.to_id);
      return entries.map((value, index) => {
        const change = (field: keyof Draft, text: string) => setDrafts(previous => ({ ...previous, [key]: entries.map((entry, i) => i === index ? { ...entry, [field]: text } : entry) }));
        return <tr key={`${key}:${index}`}><td>{row.label}{index === 0 && <div><button type="button" disabled={entries.length >= modes.length - 1} onClick={() => { const mode = modes.find(m => m !== "flight" && !entries.some(e => e.mode === m)) as AirportTransferMode | undefined; if (mode) setDrafts(previous => ({ ...previous, [key]: [...entries, blank(mode)] })); }}>Add method</button></div>}</td>
          <td><select aria-label={`${row.label} method ${index + 1}`} value={value.mode} onChange={e => change("mode", e.target.value)}>{modes.filter(m => m !== "flight").map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></td>
          <td><input aria-label={`${row.label} ${value.mode} minutes`} type="number" min="0.1" step="any" placeholder={value.mode === "taxi" ? "Existing timing" : "Required"} value={value.duration} onChange={e => change("duration", e.target.value)} /></td>
          <td><input aria-label={`${row.label} ${value.mode} party fare`} type="number" min="0" step="any" placeholder="Unknown" value={value.low} onChange={e => change("low", e.target.value)} /></td>
          <td><input aria-label={`${row.label} ${value.mode} maximum fare`} type="number" min="0" step="any" value={value.high} onChange={e => change("high", e.target.value)} /></td>
          <td><input aria-label={`${row.label} ${value.mode} currency`} maxLength={3} size={4} value={value.currency} onChange={e => change("currency", e.target.value)} /></td>
          <td><button type="button" aria-label={`Remove ${row.label} ${value.mode}`} onClick={() => setDrafts(previous => ({ ...previous, [key]: entries.filter((_, i) => i !== index) }))}>×</button></td></tr>;
      }).concat(entries.length ? [] : [<tr key={key}><td>{row.label}</td><td colSpan={6}><button type="button" onClick={() => setDrafts(previous => ({ ...previous, [key]: [blank()] }))}>Add method</button></td></tr>]);
    })}</tbody></table></div>
    <Button type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save transfer options"}</Button><p className="p-hint">Blank fares remain unknown. Options persist with this trip and party size. The existing taxi option remains available unless replaced by a taxi row. Times are estimates, without service timetables.</p>
  </section>;
}
