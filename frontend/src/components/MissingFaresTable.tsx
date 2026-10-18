import { Fragment, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { FareEditor } from "./PlannerForms";
import type { Offer } from "../lib/planner";
import type { MissingFareGroup } from "../lib/missingFares";

export type SharedFare = { component_ids: string[]; low: number; high: number | null; currency: string; label: string };
type Props = {
  storageKey: string; groups: MissingFareGroup[]; placeName: (id: string) => string;
  offerFor: (id: string) => Offer | undefined;
  onApply: (fares: SharedFare[]) => Promise<void>;
  onSave: (offer: Offer) => Promise<void>; onRemove: (id: string) => Promise<void>;
};

function FareRow({ group, staged, placeName, offerFor, onStage, onSave, onRemove }: Omit<Props, "groups" | "onApply" | "storageKey"> & { group: MissingFareGroup; staged?: SharedFare; onStage: (fare: SharedFare) => void }) {
  const first = staged ?? offerFor(group.components[0].component_id);
  const [low, setLow] = useState(first?.low?.toString() ?? "");
  const [high, setHigh] = useState(first?.high?.toString() ?? "");
  const [range, setRange] = useState(first ? first.low !== first.high : false);
  const [currency, setCurrency] = useState(first?.currency ?? group.currency);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const name = `${placeName(group.from_id)} → ${placeName(group.to_id)}`;
  const stagedMatches = staged && staged.low === Number(low) && staged.high === (range ? high.trim() === "" ? null : Number(high) : Number(low)) && staged.currency === currency;
  function save() {
    setError("");
    try {
      if (low.trim() === "" || !Number.isFinite(Number(low)) || Number(low) < 0) throw new Error("Enter a non-negative fare.");
      const upper = range ? high.trim() === "" ? null : Number(high) : Number(low);
      if (upper !== null && (!Number.isFinite(upper) || upper < Number(low))) throw new Error("Maximum must be at least the minimum.");
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Enter a three-letter currency code.");
      onStage({ component_ids: group.components.map(c => c.component_id), low: Number(low), high: upper,
        currency, label: `Shared estimate: ${name} · ${group.label}`.slice(0, 200) });
    } catch (err) { setError(err instanceof Error ? err.message : "Shared fare could not be saved."); }
  }
  return <Fragment>
    <tr>
      <th scope="row"><strong>{name}</strong><button type="button" className="p-text-button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? "Hide" : "Show"} {group.components.length} component{group.components.length === 1 ? "" : "s"}</button></th>
      <td>{group.label}<small>{group.mode}</small></td>
      <td className="p-fare-count">{group.affected_itineraries}</td>
      <td><div className="p-shared-amounts">
        <input aria-label={`${name} · ${group.label} · ${range ? "minimum" : "fare"}`} type="number" min="0" step="0.01" placeholder={range ? "Minimum" : "Unknown"} value={low} onChange={e => setLow(e.target.value)} />
        {range && <><span>–</span><input aria-label={`${name} · ${group.label} · maximum`} type="number" min={low || 0} step="0.01" placeholder="Unbounded" value={high} onChange={e => setHigh(e.target.value)} /></>}
        <label className="p-check"><input type="checkbox" checked={range} onChange={e => setRange(e.target.checked)} />Range</label>
      </div>{group.reason === "exchange_rate" && <small>Add a {group.currency} exchange rate, or enter a converted fare.</small>}
      {error && <span className="p-error" role="alert">{error}</span>}</td>
      <td><input aria-label={`${name} · ${group.label} · currency`} className="p-currency" maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></td>
      <td><Button type="button" size="sm" onClick={save}>Save estimate</Button>{staged && <small>{stagedMatches ? "Saved for apply" : "Changes not saved"}</small>}</td>
    </tr>
    {expanded && <tr className="p-fare-components"><td colSpan={6}>
      <p className="p-hint">Individual fare saves are staged too. Use Apply saved estimates above to recalculate.</p>
      {group.components.map((component, index) => <div key={component.component_id}>
        <small>Component {index+1}{component.departure ? ` · Journey departs ${new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(component.departure))} (UTC)` : ""} · {component.affected_itineraries} alternatives</small>
        <FareEditor componentId={component.component_id} label={`${name} · ${group.label}`} offer={offerFor(component.component_id)} onSave={onSave} onRemove={onRemove} />
      </div>)}
    </td></tr>}
  </Fragment>;
}

export function MissingFaresTable(props: Props) {
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<Record<string, SharedFare>>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(props.storageKey) ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try { localStorage.setItem(props.storageKey, JSON.stringify(pending)); } catch { /* Keep drafts in memory if storage is unavailable. */ }
  }, [pending, props.storageKey]);
  const missingIds = new Set(props.groups.flatMap(group => group.components.map(c => c.component_id)));
  const active = Object.values(pending).flatMap(staged => {
    const component_ids = staged.component_ids.filter(id => missingIds.has(id));
    return component_ids.length ? [{ ...staged, component_ids }] : [];
  });
  function stage(key: string, fare: SharedFare) {
    setPending(values => {
      const overwritten = new Set(fare.component_ids);
      const remaining = Object.fromEntries(Object.entries(values).flatMap(([id, value]) => {
        const component_ids = value.component_ids.filter(id => !overwritten.has(id));
        return component_ids.length ? [[id, { ...value, component_ids }]] : [];
      }));
      return { ...remaining, [key]: fare };
    });
  }
  const stagedOffer = (id: string): Offer | undefined => {
    const draft = active.find(value => value.component_ids.includes(id));
    return draft ? { id: `draft:${id}`, movement_ids: [id], kind: "charge", source: "user",
      estimated: true, validated: true, low: draft.low, high: draft.high, currency: draft.currency, label: draft.label } : props.offerFor(id);
  };
  async function stageIndividual(offer: Offer) {
    stage(`component:${offer.movement_ids[0]}`, { component_ids: offer.movement_ids,
      low: offer.low!, high: offer.high, currency: offer.currency, label: offer.label });
  }
  async function removeIndividual(id: string) {
    if (!id.startsWith("draft:")) { await props.onRemove(id); return; }
    const componentId = id.slice(6);
    setPending(values => Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
      const component_ids = value.component_ids.filter(id => id !== componentId);
      return component_ids.length ? [[key, { ...value, component_ids }]] : [];
    })));
  }
  async function apply() {
    setBusy(true); setError("");
    try {
      await props.onApply(active);
      // Applying the last missing group can unmount this table before an
      // effect runs, so clear persisted drafts here as well.
      try { localStorage.removeItem(props.storageKey); } catch { /* Memory state still clears. */ }
      setPending({});
    }
    catch (err) { setError(err instanceof Error ? err.message : "Estimates could not be applied."); }
    finally { setBusy(false); }
  }
  const currentPage = Math.min(page, Math.max(0, Math.ceil(props.groups.length / 25)-1));
  const componentCount = props.groups.reduce((sum, group) => sum+group.components.length, 0);
  return <section className="p-panel" aria-labelledby="missing-fares-title">
    <div className="p-panel-heading"><div><span className="p-step">03</span><h2 id="missing-fares-title">Refine important missing fares</h2></div><span className="p-tag">{props.groups.length} groups · {componentCount} components</span></div>
    <p>Enter a party fare per transfer or journey and save each row. Saved estimates stay in this browser until you apply them together; saving a row does not rerun optimization.</p>
    <div className="p-actions"><Button type="button" disabled={busy || !active.length} onClick={() => void apply()}>{busy ? "Applying estimates…" : `Apply saved estimates (${active.length})`}</Button>{active.length > 0 && <Button type="button" variant="ghost" disabled={busy} onClick={() => setPending({})}>Discard saved estimates</Button>}<span className="p-hint">Applies each amount per component and recalculates once.</span></div>
    {error && <p className="p-error" role="alert">{error}</p>}
    <p className="p-hint">Departures from the same flexible connection share one row. Estimates apply to each listed component in this snapshot. Expand a row for individual fares. Priced components remain editable in itinerary details; future searches may add new unpriced components.</p>
    <div className="p-fares-table-wrap" inert={busy}><table className="p-fares-table"><caption className="sr-only">Missing fares grouped by matching transfer; each amount is a party fare per component.</caption>
      <thead><tr><th scope="col">Transfer / journey</th><th scope="col">Type</th><th scope="col">Alternatives</th><th scope="col">Party fare / range</th><th scope="col">Currency</th><th scope="col">Save</th></tr></thead>
      <tbody>{props.groups.slice(currentPage*25, (currentPage+1)*25).map(group => <FareRow key={group.key} {...props} group={group} staged={pending[group.key]} onStage={fare => stage(group.key, fare)} offerFor={stagedOffer} onSave={stageIndividual} onRemove={removeIndividual} />)}</tbody>
    </table></div>
    {props.groups.length > 25 && <div className="p-actions"><Button type="button" size="sm" variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage-1)}>Previous groups</Button><span>Page {currentPage+1} / {Math.ceil(props.groups.length/25)}</span><Button type="button" size="sm" variant="secondary" disabled={(currentPage+1)*25 >= props.groups.length} onClick={() => setPage(currentPage+1)}>Next groups</Button></div>}
  </section>;
}
