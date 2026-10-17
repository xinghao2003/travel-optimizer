import { cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { api, localInputToISO, money, type Offer, type Place, type PricingRule, type TripDraft, type TripSpec } from "../lib/planner";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const generated = useId();
  const id = isValidElement<{ id?: string }>(children) ? children.props.id ?? generated : generated;
  return <div className="p-field"><label htmlFor={id}>{label}</label>{isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}{hint && <small>{hint}</small>}</div>;
}

export function NumberField({ label, value, onChange, min = 0, max, step = "any", optional = false }: { label: string; value: number | null; onChange: (n: number | null) => void; min?: number; max?: number; step?: string | number; optional?: boolean }) {
  return <Field label={label}><input type="number" min={min} max={max} step={step} value={value ?? ""} placeholder={optional ? "Unknown / not set" : undefined} onChange={e => onChange(e.target.value === "" && optional ? null : Number(e.target.value))} /></Field>;
}

export function PlacePicker({ label, onSelect, disabledIds = [] }: { label: string; onSelect: (p: Place) => void; disabledIds?: string[] }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [custom, setCustom] = useState({ name: "", latitude: "", longitude: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, airports: "" });
  const excluded = disabledIds.join("|");
  useEffect(() => {
    let current = true;
    if (query.trim().length < 2) { setItems([]); setLoading(false); return; }
    const timer = setTimeout(() => {
      setLoading(true);
      api<{ places: Place[] }>(`/places?search=${encodeURIComponent(query)}`)
        .then(data => { if (current) { setItems(data.places.filter(p => !excluded.split("|").includes(p.id))); setActive(0); setError(""); } })
        .catch(err => { if (current) setError(String(err.message)); })
        .finally(() => { if (current) setLoading(false); });
    }, 220);
    return () => { current = false; clearTimeout(timer); };
  }, [query, excluded]);
  function choose(place: Place) { onSelect(place); setQuery(""); setItems([]); }
  function addCustom() {
    try {
      new Intl.DateTimeFormat("en", { timeZone: custom.timezone });
      const lat = Number(custom.latitude), lon = Number(custom.longitude);
      if (!custom.name || custom.latitude === "" || custom.longitude === "" || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("Enter a name, valid coordinates, and an IANA timezone.");
      const codes = custom.airports.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      if (codes.some(c => !/^[A-Z]{3}$/.test(c))) throw new Error("Airport codes must contain three letters.");
      choose({ id: `custom:${crypto.randomUUID()}`, name: custom.name, latitude: lat, longitude: lon, timezone: custom.timezone, country_code: "", airport_codes: codes, flight_code: codes[0] ?? null });
      setManual(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Invalid place."); }
  }
  return <div className="p-place-picker">
    <Field label={label}><input role="combobox" aria-autocomplete="list" aria-expanded={items.length > 0} aria-controls={`${id}-list`} aria-activedescendant={items.length ? `${id}-${active}` : undefined} placeholder="City name or airport code" value={query}
      onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(0, i - 1)); } if (e.key === "Enter" && items[active]) { e.preventDefault(); choose(items[active]); } if (e.key === "Escape") setItems([]); }} /></Field>
    {items.length > 0 && <div className="p-suggestions" role="listbox" id={`${id}-list`}>{items.map((p, i) => <button key={p.id} type="button" role="option" id={`${id}-${i}`} aria-selected={i === active} onClick={() => choose(p)}><strong>{p.name}</strong><small>{p.country_code} · {p.airport_codes.length ? p.airport_codes.join(", ") : "No airport required"}</small></button>)}</div>}
    {loading && <small role="status">Searching the local city catalog…</small>}
    <button type="button" className="p-text-button" onClick={() => setManual(!manual)}>{manual ? "Close custom place" : "Add a place by coordinates"}</button>
    {manual && <div className="p-custom-place p-grid">
      {(["name", "latitude", "longitude", "timezone", "airports"] as const).map(key => <Field key={key} label={`Custom place ${key}`}><input value={custom[key]} onChange={e => setCustom(c => ({ ...c, [key]: e.target.value }))} /></Field>)}
      <Button type="button" size="sm" variant="secondary" onClick={addCustom}>Use this place</Button>
    </div>}
    {error && <p className="p-error" role="alert">{error}</p>}
  </div>;
}

export function PlaceChips({ places, remove }: { places: Place[]; remove: (id: string) => void }) {
  return <div className="p-chips">{places.map(p => <span key={p.id}>{p.name}<button type="button" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}>×</button></span>)}</div>;
}

export function FareEditor({ componentId, label, offer, onSave, onRemove }: { componentId: string; label: string; offer?: Offer; onSave: (offer: Offer) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [low, setLow] = useState(offer?.low?.toString() ?? "");
  const [high, setHigh] = useState(offer?.high?.toString() ?? "");
  const [range, setRange] = useState(offer?.low !== offer?.high);
  const [currency, setCurrency] = useState(offer?.currency ?? "MYR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setLow(offer?.low?.toString() ?? ""); setHigh(offer?.high?.toString() ?? ""); setRange(offer ? offer.low !== offer.high : false); setCurrency(offer?.currency ?? "MYR"); }, [offer?.id, offer?.low, offer?.high, offer?.currency]);
  async function save() {
    setBusy(true); setError("");
    try {
      if (low === "" || !Number.isFinite(Number(low)) || Number(low) < 0) throw new Error("Enter a nonnegative fare.");
      const upper = range ? high === "" ? null : Number(high) : Number(low);
      if (upper !== null && (upper < Number(low) || !Number.isFinite(upper))) throw new Error("Maximum must be at least the minimum.");
      await onSave({ id: `user:${componentId}`, movement_ids: [componentId], kind: "one-way", low: Number(low), high: upper, currency: currency.toUpperCase(), source: "user", estimated: true, validated: true, label });
    } catch (err) { setError(err instanceof Error ? err.message : "Fare could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className="p-fare-editor">
    <Field label={`${label} · ${range ? "minimum" : "fare"}`}><input type="number" min="0" step="0.01" value={low} placeholder="Unknown" onChange={e => setLow(e.target.value)} /></Field>
    <label className="p-check"><input type="checkbox" checked={range} onChange={e => setRange(e.target.checked)} />Range</label>
    {range && <Field label={`${label} · maximum`}><input type="number" min={low || 0} step="0.01" value={high} placeholder="Unbounded" onChange={e => setHigh(e.target.value)} /></Field>}
    <Field label={`${label} · currency`}><input className="p-currency" maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field>
    <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save fare"}</Button>
    {offer?.source === "user" && <Button type="button" size="sm" variant="ghost" onClick={() => { void onRemove(offer.id).catch(err => setError(err.message)); }}>Reset</Button>}
    {error && <span className="p-error" role="alert">{error}</span>}
  </div>;
}

export function RulesEditor({ rules, places, changed, report }: { rules: PricingRule[]; places: Place[]; changed: () => Promise<void>; report: (s: string) => void }) {
  const terminals = [...new Map(places.flatMap(p => p.airport_codes.map(code => [`airport:${code}`, { id: `airport:${code}`, name: `${code} airport` }] as const))).values()];
  const blank = (): PricingRule => ({ id: crypto.randomUUID(), name: "", mode: "*", from_id: null, to_id: null, service: null, country_code: null, kind: "fixed", low: 0, high: null, unit: "person", capacity: 4, currency: "MYR", priority: 0 });
  const [rule, setRule] = useState<PricingRule>(blank);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PricingRule>(key: K, value: PricingRule[K]) => setRule(r => ({ ...r, [key]: value }));
  async function save() {
    setBusy(true);
    try { await api(`/pricing-rules/${encodeURIComponent(rule.id)}`, "PUT", rule); await changed(); setRule(blank()); }
    catch (err) { report(err instanceof Error ? err.message : "Rule could not be saved."); }
    finally { setBusy(false); }
  }
  return <details className="p-details"><summary>Reusable pricing rules <span>{rules.length} saved</span></summary>
    <p>Rules estimate missing prices. Specific route/service matches win at equal priority. Values are in the chosen currency; vehicle prices use the stated seating capacity.</p>
    <div className="p-rule-list">{rules.map(r => <div key={r.id}><button type="button" className="p-text-button" onClick={() => setRule(r)}>{r.name}</button><small>{r.mode} · {money(r.low, r.currency)}{r.kind === "per-km" ? "/km" : ""} · {r.unit}</small><button type="button" aria-label={`Delete rule ${r.name}`} onClick={() => { void api(`/pricing-rules/${encodeURIComponent(r.id)}`, "DELETE").then(changed).catch(err => report(err.message)); }}>×</button></div>)}</div>
    <div className="p-grid">
      <Field label="Rule name"><input value={rule.name} onChange={e => set("name", e.target.value)} /></Field>
      <Field label="Rule mode"><select value={rule.mode} onChange={e => set("mode", e.target.value)}>{["*", "flight", "rail", "bus", "coach", "subway", "tram", "car", "taxi", "rental"].map(m => <option key={m}>{m}</option>)}</select></Field>
      <Field label="Pricing method"><select value={rule.kind} onChange={e => set("kind", e.target.value as PricingRule["kind"])}><option value="fixed">Fixed / range</option><option value="per-km">Per kilometer</option></select></Field>
      <NumberField label="Rule minimum / fixed price" value={rule.low} onChange={n => set("low", n ?? 0)} />
      <NumberField label="Rule maximum (blank = fixed)" value={rule.high} optional onChange={n => set("high", n)} />
      <Field label="Charging unit"><select value={rule.unit} onChange={e => set("unit", e.target.value as PricingRule["unit"])}><option value="person">Per person</option><option value="party">Whole party</option><option value="vehicle">Per vehicle</option></select></Field>
      <Field label="Rule currency"><input maxLength={3} value={rule.currency} onChange={e => set("currency", e.target.value.toUpperCase())} /></Field>
      <NumberField label="Rule priority" value={rule.priority} min={-1000} onChange={n => set("priority", n ?? 0)} />
      <NumberField label="Seats per vehicle" value={rule.capacity} min={1} max={9} onChange={n => set("capacity", n ?? 4)} />
      {(["from_id", "to_id"] as const).map(key => <Field key={key} label={`Rule ${key === "from_id" ? "origin" : "destination"}`}><select value={rule[key] ?? ""} onChange={e => set(key, e.target.value || null)}><option value="">Any place</option>{[...places, ...terminals].map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>)}
      <Field label="Service / operator (optional)"><input value={rule.service ?? ""} onChange={e => set("service", e.target.value || null)} /></Field>
      <Field label="Origin country code (optional)"><input maxLength={2} value={rule.country_code ?? ""} onChange={e => set("country_code", e.target.value.toUpperCase() || null)} /></Field>
    </div>
    <div className="p-actions"><Button type="button" size="sm" disabled={busy || !rule.name} onClick={() => void save()}>Save pricing rule</Button><Button type="button" size="sm" variant="ghost" onClick={() => setRule(blank())}>New rule</Button></div>
  </details>;
}

export function AdvancedSettings({ draft, edit, places, report }: { draft: TripDraft; edit: (d: TripDraft) => void; places: Place[]; report: (s: string) => void }) {
  const [commitment, setCommitment] = useState({ place_id: "", start: "", end: "" });
  const [fx, setFX] = useState({ currency: "", rate: "" });
  const car = draft.cars;
  const setCar = <K extends keyof TripSpec["cars"]>(key: K, value: TripSpec["cars"][K]) => edit({ ...draft, cars: { ...car, [key]: value } });
  const timingLabels: Record<keyof TripSpec["timing"], string> = { connection_minutes: "Minimum connection · minutes", flight_before_minutes: "Before flight · minutes", flight_after_minutes: "After flight · minutes", transit_before_minutes: "Before train/bus · minutes", transit_after_minutes: "After train/bus · minutes", airport_transfer_fallback_minutes: "Fallback airport transfer per side · minutes" };
  function addCommitment() {
    try {
      const place = places.find(p => p.id === commitment.place_id);
      if (!place || !commitment.start || !commitment.end) throw new Error("Choose a required city and both commitment times.");
      const start = localInputToISO(commitment.start, place.timezone), end = localInputToISO(commitment.end, place.timezone);
      if (start >= end) throw new Error("Commitment end must follow its start.");
      edit({ ...draft, commitments: [...draft.commitments, { place_id: place.id, start, end }] });
      setCommitment({ place_id: "", start: "", end: "" });
    } catch (err) { report(err instanceof Error ? err.message : "Invalid commitment."); }
  }
  return <details className="p-details"><summary>Timing, commitments, driving, and currencies</summary>
    <p>Buffers and airport transfer assumptions are included in the trip timeline. The fallback is used only when airport road routing is unavailable; it does not create intercity roads. Overnight travel means crossing midnight in the departure timezone.</p>
    <div className="p-grid">{(Object.keys(draft.timing) as (keyof TripSpec["timing"])[]).map(key => <NumberField key={key} label={timingLabels[key]} value={draft.timing[key]} optional={key === "airport_transfer_fallback_minutes"} onChange={n => edit({ ...draft, timing: { ...draft.timing, [key]: n } })} />)}</div>
    <h3>Fixed commitments · city local time</h3>
    {draft.commitments.map((c, i) => <div className="p-inline" key={`${c.place_id}:${c.start}`}><span>{places.find(p => p.id === c.place_id)?.name} · {new Date(c.start).toLocaleString("en-MY", { timeZone: places.find(p => p.id === c.place_id)?.timezone })} – {new Date(c.end).toLocaleString("en-MY", { timeZone: places.find(p => p.id === c.place_id)?.timezone })}</span><button type="button" aria-label="Remove commitment" onClick={() => edit({ ...draft, commitments: draft.commitments.filter((_, j) => j !== i) })}>×</button></div>)}
    <div className="p-grid"><Field label="Commitment city"><select value={commitment.place_id} onChange={e => setCommitment(c => ({ ...c, place_id: e.target.value }))}><option value="">Choose a required city</option>{draft.visits.map(v => <option value={v.place.id} key={v.place.id}>{v.place.name} · {v.place.timezone}</option>)}</select></Field><Field label="Commitment starts"><input type="datetime-local" value={commitment.start} onChange={e => setCommitment(c => ({ ...c, start: e.target.value }))} /></Field><Field label="Commitment ends"><input type="datetime-local" value={commitment.end} onChange={e => setCommitment(c => ({ ...c, end: e.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" onClick={addCommitment}>Add commitment</Button></div>
    <h3>Car availability and rental assumptions</h3>
    <div className="p-inline"><label className="p-check"><input type="checkbox" checked={car.own_enabled} onChange={e => setCar("own_enabled", e.target.checked)} />Own car starts and finishes at home</label><label className="p-check"><input type="checkbox" checked={car.rental_enabled} onChange={e => setCar("rental_enabled", e.target.checked)} />Allow declared rental availability</label></div>
    <div className="p-grid">
      <NumberField label="Own car seats" value={car.own_capacity} min={1} max={9} onChange={n => setCar("own_capacity", n ?? 4)} />
      <NumberField label="Own car MYR/km · estimate" value={car.own_cost_per_km} onChange={n => setCar("own_cost_per_km", n ?? 0)} />
      <NumberField label="Rental seats per car" value={car.rental_capacity} min={1} max={9} onChange={n => setCar("rental_capacity", n ?? 4)} />
      <NumberField label="Rental MYR/day" value={car.rental_daily_myr} optional onChange={n => setCar("rental_daily_myr", n)} />
      <NumberField label="Rental pickup MYR/car" value={car.rental_pickup_myr} onChange={n => setCar("rental_pickup_myr", n ?? 0)} />
      <NumberField label="Rental one-way drop-off MYR/car" value={car.rental_one_way_myr} optional onChange={n => setCar("rental_one_way_myr", n)} />
      <NumberField label="Rental driving MYR/km/car" value={car.rental_cost_per_km} optional onChange={n => setCar("rental_cost_per_km", n)} />
    </div>
    {car.rental_enabled && <div className="p-grid">{(["rental_pickups", "rental_dropoffs"] as const).map(key => <fieldset key={key}><legend>{key === "rental_pickups" ? "Assumed pickup locations" : "Allowed drop-off locations"}</legend>{places.map(p => <label key={p.id} className="p-check"><input type="checkbox" checked={car[key].includes(p.id)} onChange={e => setCar(key, e.target.checked ? [...car[key], p.id] : car[key].filter(id => id !== p.id))} />{p.name}</label>)}</fieldset>)}</div>}
    <h3>Saved exchange rates · MYR per currency unit</h3>
    <div className="p-inline">{Object.entries(draft.exchange_rates).map(([currency, rate]) => <span className="p-tag" key={currency}>{currency}: {rate}{currency !== "MYR" && <button type="button" aria-label={`Remove ${currency} exchange rate`} onClick={() => edit({ ...draft, exchange_rates: Object.fromEntries(Object.entries(draft.exchange_rates).filter(([c]) => c !== currency)) })}>×</button>}</span>)}</div>
    <div className="p-inline"><Field label="Foreign currency"><input maxLength={3} value={fx.currency} onChange={e => setFX(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></Field><Field label="MYR per currency unit"><input type="number" min="0.000001" step="any" value={fx.rate} onChange={e => setFX(f => ({ ...f, rate: e.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" onClick={() => { if (fx.currency.length === 3 && Number(fx.rate) > 0) { edit({ ...draft, exchange_rates: { ...draft.exchange_rates, [fx.currency]: Number(fx.rate) } }); setFX({ currency: "", rate: "" }); } }}>Save exchange rate</Button></div>
  </details>;
}
