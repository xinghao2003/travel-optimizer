import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "./ui/button";
import { api, money, type Offer, type Place, type PricingRule } from "../lib/planner";

/**
 * A labelled control (C11). The id of the child links the label; without one, Field makes one. `info` is an
 * InfoTip after the label (never inside it), `aside` is right-aligned text on the label row, `unit` follows the
 * control ("h"). `error` marks the control as invalid; the control's aria-describedby names the hint and the error.
 */
export function Field({ label, children, hint, info, aside, unit, error, className }: {
  label: ReactNode; children: ReactNode; hint?: string; info?: ReactNode; aside?: ReactNode; unit?: string; error?: string; className?: string;
}) {
  const generated = useId();
  const element = isValidElement<{ id?: string }>(children) ? children : null;
  const id = element?.props.id ?? generated;
  const hintId = `${id}-hint`, errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
  const control = element ? cloneElement(element as ReactElement<Record<string, unknown>>, { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy }) : children;
  return <div className={className ? `p-field ${className}` : "p-field"}>
    <div className="p-field-label"><label htmlFor={id}>{label}</label>{info}{aside && <span className="p-field-aside">{aside}</span>}</div>
    {unit ? <div className="p-field-unit">{control}<span aria-hidden="true">{unit}</span></div> : control}
    {hint && <small id={hintId}>{hint}</small>}
    {error && <span id={errorId} className="p-field-error">{error}</span>}
  </div>;
}

const formatLimit = (value: number) => value.toLocaleString("en-MY");
/**
 * A number input that commits only valid values (C11). It keeps the typed text; a blank, out-of-range or (with
 * `integer`) decimal value shows an error and is not committed. Leaving the field with an error restores the last
 * committed value. `message` replaces the blank and out-of-range errors ("Enter 1 to 9 adults."); `error` is an
 * error from outside, shown while the typed text has none.
 */
export function NumberField({ label, value, onChange, min = 0, max, integer = false, optional = false, placeholder, info, id, hint, unit, message, error: outside, className }: {
  label: ReactNode; value: number | null; onChange: (n: number | null) => void; min?: number; max?: number; integer?: boolean; optional?: boolean;
  placeholder?: string; info?: ReactNode; id?: string; hint?: string; unit?: string; message?: string; error?: string; className?: string;
}) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  const [error, setError] = useState("");
  const focused = useRef(false);
  // A change from outside (another trip, "Use for all cities") shows unless the user is typing here.
  useEffect(() => { if (!focused.current) { setText(shown); setError(""); } }, [shown]);
  function change(raw: string) {
    setText(raw);
    const n = Number(raw);
    const problem = raw.trim() === "" ? (optional ? "" : message ?? "Required.")
      : !Number.isFinite(n) || n < min || (max !== undefined && n > max) ? message ?? (max === undefined ? `Enter ${formatLimit(min)} or more.` : `Enter ${formatLimit(min)} to ${formatLimit(max)}.`)
      : integer && !Number.isInteger(n) ? "Enter a whole number." : "";
    setError(problem);
    if (problem) return;
    const next = raw.trim() === "" ? null : n;
    if (next !== value) onChange(next);
  }
  return <Field label={label} info={info} hint={hint} unit={unit} error={error || outside} className={className}>
    <input id={id} type="text" inputMode={min < 0 ? undefined : integer ? "numeric" : "decimal"} placeholder={placeholder} value={text}
      onFocus={() => { focused.current = true; }} onChange={event => change(event.target.value)}
      onBlur={() => { focused.current = false; if (error) { setText(shown); setError(""); } }} />
  </Field>;
}

/**
 * A place search box (combobox) with "Add a place by coordinates" (C11). `limitText` is right-aligned on the
 * label row ("2 of 4"); `hint` explains a disabled picker.
 */
export function PlacePicker({ label, onSelect, disabledIds = [], inputId, disabled = false, limitText, placeholder = "City name or airport code", info, hint }: {
  label: string; onSelect: (p: Place) => void; disabledIds?: string[]; inputId?: string;
  disabled?: boolean; limitText?: string; placeholder?: string; info?: ReactNode; hint?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Place[]>([]);
  const [noMatch, setNoMatch] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [custom, setCustom] = useState({ name: "", latitude: "", longitude: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, airports: "" });
  const excluded = disabledIds.join("|");
  useEffect(() => {
    let current = true;
    setNoMatch(false);
    if (query.trim().length < 2) { setItems([]); setLoading(false); return; }
    const timer = setTimeout(() => {
      setLoading(true);
      api<{ places: Place[] }>(`/places?search=${encodeURIComponent(query)}`)
        .then(data => {
          if (!current) return;
          const found = data.places.filter(p => !excluded.split("|").includes(p.id));
          setItems(found); setNoMatch(!found.length); setActive(0); setError("");
        })
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
      setManual(false); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "Invalid place."); }
  }
  return <div className="p-place-picker">
    <Field label={label} info={info} aside={limitText} hint={hint}><input id={inputId} role="combobox" aria-autocomplete="list" aria-expanded={items.length > 0} aria-controls={`${id}-list`} aria-activedescendant={items.length ? `${id}-${active}` : undefined} placeholder={placeholder} value={query} disabled={disabled}
      onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(0, i - 1)); } if (e.key === "Enter" && items[active]) { e.preventDefault(); choose(items[active]); } if (e.key === "Escape") setItems([]); }} /></Field>
    {items.length > 0 && <div className="p-suggestions" role="listbox" id={`${id}-list`}>{items.map((p, i) => <button key={p.id} type="button" role="option" id={`${id}-${i}`} aria-selected={i === active} onClick={() => choose(p)}><strong>{p.name}</strong><small>{[p.country_code, p.airport_codes.length ? p.airport_codes.join(", ") : "No airport"].filter(Boolean).join(" · ")}</small></button>)}</div>}
    <div aria-live="polite">{loading ? <small>Searching…</small> : noMatch && <small>No matching places. Check the spelling, or add the place by coordinates.</small>}</div>
    <button type="button" className="p-text-button" disabled={disabled} aria-expanded={manual} onClick={() => setManual(!manual)}>{manual ? "Close" : "Add a place by coordinates"}</button>
    {manual && <div className="p-custom-place p-grid">
      {(Object.keys(customLabels) as (keyof typeof customLabels)[]).map(key => <Field key={key} label={customLabels[key]}><input value={custom[key]} onChange={e => setCustom(c => ({ ...c, [key]: e.target.value }))} /></Field>)}
      <Button type="button" size="sm" variant="secondary" onClick={addCustom}>Use this place</Button>
    </div>}
    {error && <p className="p-field-error" role="alert">{error}</p>}
  </div>;
}
const customLabels = { name: "Name", latitude: "Latitude", longitude: "Longitude", timezone: "Time zone (for example Asia/Seoul)", airports: "Airport codes (optional, comma-separated)" };

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
