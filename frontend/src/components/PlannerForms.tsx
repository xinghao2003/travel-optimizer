import { ChevronDown } from "lucide-react";
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "./ui/button";
import { InfoTip } from "./InfoTip";
import { sameFare, type PriceValue } from "../lib/drafts";
import { api, type Place, type PricingRule } from "../lib/planner";
import { blankRuleForm, modeLabel, priceInputErrors, ruleForm, ruleFromForm, ruleModes, ruleText, type RuleErrors, type RuleForm } from "../lib/present";

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

/** Moves focus to the next (or, with `back`, the previous) visible price input of the same section (C11 Enter / Shift+Enter). */
export function focusNextPrice(from: HTMLElement, back = false) {
  const inputs = [...(from.closest("section") ?? document.body).querySelectorAll<HTMLElement>("[data-price-input]")].filter(input => input.getClientRects().length > 0);
  const index = inputs.indexOf(from);
  if (index >= 0) inputs[index + (back ? -1 : 1)]?.focus();
}

/** A staged value (C11): "Not applied · Undo" in --chart, with a dot. `what` says what the draft does ("Removed"); `label` names the row for screen readers. */
export function Staged({ label, what, onUndo }: { label: string; what?: string; onUndo: () => void }) {
  return <p className="p-staged"><span className="p-staged-dot" aria-hidden="true" />{what && `${what} · `}Not applied · <button type="button" className="p-link-button" onClick={onUndo}>Undo<span className="sr-only">: {label}</span></button></p>;
}

/**
 * A Missing info section (F2): an h3 with its tip and a right-aligned status (`warn` in the warning colour), then the body.
 * A `collapsed` section is a closed <details> whose summary holds the heading and the status; its tip sits beside the summary.
 */
export function MissingSection({ id, title, status, warn = false, tip, collapsed = false, children }: {
  id: string; title: string; status?: string; warn?: boolean; tip: ReactNode; collapsed?: boolean; children: ReactNode;
}) {
  const statusText = status && <span className="p-mi-status" data-tone={warn ? "warn" : undefined}>{status}</span>;
  if (collapsed) return <section className="p-mi-section p-mi-collapsible" aria-labelledby={id}>
    <details>
      <summary><ChevronDown size={16} className="p-chevron" aria-hidden="true" /><h3 id={id}>{title}</h3>{statusText}</summary>
      <div className="p-mi-body">{children}</div>
    </details>
    <InfoTip topic={title} align="end">{tip}</InfoTip>
  </section>;
  return <section className="p-mi-section" aria-labelledby={id}>
    <div className="p-mi-head">
      <h3 id={id} tabIndex={-1}>{title}</h3>
      <InfoTip topic={title}>{tip}</InfoTip>
      {statusText}
    </div>
    {children}
  </section>;
}

type PriceText = { low: string; range: boolean; high: string; currency: string };
const priceTextOf = (value: PriceValue | null, currency: string): PriceText => {
  const range = !!value && value.high !== value.low;
  return { low: value ? String(value.low) : "", range, high: range && value.high !== null ? String(value.high) : "", currency: value?.currency ?? currency };
};

/**
 * Inline staged price for one row (C11 PriceFields): "Price for {n} adults", "Range" → "to" (blank: open-ended) and
 * "Currency". `value` is the last staged or saved price; `currency` the default without one. It commits when focus
 * leaves the fields or on Enter, and only a changed value: `onCommit` stages it. A blank price removes the draft
 * (`onUndo`). Enter / Shift+Enter move to the next / previous price input of the section, Esc restores `value`,
 * Ctrl/Cmd+Enter commits and applies. `id` is the id of the price input.
 */
export function PriceFields({ name, adults, value, currency = "MYR", staged, placeholder = "Not priced", id, onCommit, onUndo, onApply }: {
  name: string; adults: number; value: PriceValue | null; currency?: string; staged: boolean; placeholder?: string; id?: string;
  onCommit: (value: PriceValue) => void; onUndo: () => void; onApply: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const price = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => priceTextOf(value, currency));
  const [errors, setErrors] = useState<Partial<Record<"low" | "high" | "currency", string>>>({});
  // After Undo, focus stays in the fields, but they show the restored value.
  const restore = useRef(false);
  const signature = JSON.stringify([value, currency]);
  // A new staged or saved value shows unless the user is typing here.
  useEffect(() => {
    if (!restore.current && root.current?.contains(document.activeElement)) return;
    restore.current = false;
    setText(priceTextOf(value, currency)); setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const set = (change: Partial<PriceText>) => setText(current => ({ ...current, ...change }));
  function clearDraft() { restore.current = true; onUndo(); }
  function undo() { clearDraft(); price.current?.focus(); }
  function commit() {
    if (!text.low.trim() && !(text.range && text.high.trim())) {
      setErrors({});
      // A saved price stays: Remove my price deletes it.
      if (staged) clearDraft(); else setText(priceTextOf(value, currency));
      return true;
    }
    const found = priceInputErrors(text.low, text.range ? text.high : "", text.currency);
    setErrors(found);
    if (Object.keys(found).length) return false;
    const low = Number(text.low);
    const next = { low, high: !text.range ? low : text.high.trim() === "" ? null : Number(text.high), currency: text.currency.trim().toUpperCase() };
    if (!value || !sameFare(next, value)) onCommit(next);
    return true;
  }
  const adultsText = `${adults} adult${adults === 1 ? "" : "s"}`;
  return <div ref={root} className="p-price-fields" role="group" aria-label={name}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (commit()) onApply(); return; }
      if (!(target instanceof HTMLInputElement) || target.type === "checkbox") return;
      if (event.key === "Escape") { event.preventDefault(); setText(priceTextOf(value, currency)); setErrors({}); }
      else if (event.key === "Enter") { event.preventDefault(); if (commit()) focusNextPrice(target, event.shiftKey); }
    }}>
    <Field label={`Price for ${adultsText}`} error={errors.low}>
      <input ref={price} id={id} type="text" inputMode="decimal" data-price-input placeholder={placeholder} value={text.low} onChange={event => set({ low: event.target.value })} />
    </Field>
    <label className="p-check"><input type="checkbox" checked={text.range} onChange={event => set({ range: event.target.checked })} />Range</label>
    {text.range && <Field label="to" error={errors.high} hint={text.high.trim() === "" ? "No upper limit: the total stays incomplete." : undefined}>
      <input type="text" inputMode="decimal" data-price-input placeholder="No limit" value={text.high} onChange={event => set({ high: event.target.value })} />
    </Field>}
    <Field label="Currency" error={errors.currency} className="p-price-currency">
      <input maxLength={3} value={text.currency} onChange={event => set({ currency: event.target.value.toUpperCase() })} />
    </Field>
    {staged && <Staged label={name} onUndo={undo} />}
  </div>;
}

export type FixedPrice = { low: string; high: string; currency: string };
/**
 * A fixed price or a range (C11 FixedPriceFields): `label` ("Price"), "Highest price (optional)" and "Currency". A blank
 * highest price means a fixed price. The fields are siblings, so the parent lays them out with its other fields.
 */
export function FixedPriceFields({ label = "Price", value, errors = {}, onChange }: {
  label?: string; value: FixedPrice; errors?: Partial<Record<keyof FixedPrice, string>>; onChange: (value: FixedPrice) => void;
}) {
  const set = (change: Partial<FixedPrice>) => onChange({ ...value, ...change });
  return <>
    <Field label={label} error={errors.low}><input type="text" inputMode="decimal" value={value.low} onChange={event => set({ low: event.target.value })} /></Field>
    <Field label="Highest price (optional)" error={errors.high}><input type="text" inputMode="decimal" value={value.high} onChange={event => set({ high: event.target.value })} /></Field>
    <Field label="Currency" error={errors.currency} className="p-price-currency"><input maxLength={3} value={value.currency} onChange={event => set({ currency: event.target.value.toUpperCase() })} /></Field>
  </>;
}

/**
 * Missing info › Price rules · all trips (F2 row 7): the saved rules with Edit and Delete, then the rule form. Save rule and
 * Delete are immediate (F6); `onSave` and `onDelete` throw on failure and the error shows here (C2). `places` are the trip's
 * places; airports of those places are "{CODE} airport".
 */
export function RulesEditor({ rules, places, placeName, busy, onSave, onDelete }: {
  rules: PricingRule[]; places: Place[]; placeName: (id: string) => string; busy: boolean;
  onSave: (rule: PricingRule) => Promise<void>; onDelete: (rule: PricingRule) => Promise<void>;
}) {
  const [form, setForm] = useState<RuleForm>(() => blankRuleForm(crypto.randomUUID()));
  const [errors, setErrors] = useState<RuleErrors & { save?: string }>({});
  const [saving, setSaving] = useState(false);
  const set = (change: Partial<RuleForm>) => setForm(current => ({ ...current, ...change }));
  const newRule = () => { setForm(blankRuleForm(crypto.randomUUID())); setErrors({}); };
  const airports = [...new Map(places.flatMap(place => place.airport_codes.map(code => [`airport:${code}`, `${code} airport`] as const))).entries()];
  // A rule can name a place that is not in this trip; it stays selectable.
  const placeOptions = (current: string): [string, string][] => {
    const options: [string, string][] = [...places.map((place): [string, string] => [place.id, place.name]), ...airports];
    return current && !options.some(([id]) => id === current) ? [...options, [current, placeName(current)]] : options;
  };
  async function save() {
    const found = ruleFromForm(form);
    if (found.errors) { setErrors(found.errors); return; }
    setErrors({}); setSaving(true);
    try { await onSave(found.rule); newRule(); }
    catch (err) { setErrors({ save: err instanceof Error ? err.message : "The rule could not be saved." }); }
    finally { setSaving(false); }
  }
  async function remove(rule: PricingRule) {
    if (!window.confirm(`Delete the rule "${rule.name}"? It applies to all trips.`)) return;
    try { await onDelete(rule); if (form.id === rule.id) newRule(); }
    catch (err) { setErrors({ save: err instanceof Error ? err.message : "The rule could not be deleted." }); }
  }
  function edit(rule: PricingRule) {
    setForm(ruleForm(rule)); setErrors({});
    document.getElementById("rule-name")?.focus();
  }
  return <MissingSection id="price-rules-title" title="Price rules · all trips" status={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}`} collapsed
    tip="Rules give prices to items that have no price, in all your trips. At equal priority the most specific rule wins. Per-vehicle prices use the seats per vehicle.">
    {rules.length > 0 && <ul className="p-item-rows p-mi-rules">{rules.map(rule => <li key={rule.id}>
      <span className="p-item-text"><strong>{rule.name}</strong><span>{ruleText(rule, placeName)}</span></span>
      <span className="p-item-actions">
        <button type="button" className="p-text-button" aria-label={`Edit rule ${rule.name}`} onClick={() => edit(rule)}>Edit</button>
        <button type="button" className="p-text-button" aria-label={`Delete rule ${rule.name}`} disabled={busy} onClick={() => void remove(rule)}>Delete</button>
      </span>
    </li>)}</ul>}
    <div className="p-group-fields">
      <Field label="Rule name" error={errors.name}><input id="rule-name" maxLength={120} value={form.name} onChange={event => set({ name: event.target.value })} /></Field>
      <Field label="Transport"><select value={form.mode} onChange={event => set({ mode: event.target.value })}>
        {ruleModes.map(mode => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}
      </select></Field>
      {(["from_id", "to_id"] as const).map(key => <Field key={key} label={key === "from_id" ? "From" : "To"}>
        <select value={form[key]} onChange={event => set({ [key]: event.target.value })}>
          <option value="">Any place</option>
          {placeOptions(form[key]).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>)}
      <Field label="Service or operator (optional)" info={<InfoTip topic="service or operator">Matches an operator or service name. Use &lsquo;Airport access&rsquo; or &lsquo;Airport egress&rsquo; for airport transfers.</InfoTip>}>
        <input value={form.service} onChange={event => set({ service: event.target.value })} />
      </Field>
      <Field label="Country of departure (optional, 2 letters)" error={errors.country_code}>
        <input maxLength={2} value={form.country_code} onChange={event => set({ country_code: event.target.value.toUpperCase() })} />
      </Field>
      <Field label="Pricing"><select value={form.kind} onChange={event => set({ kind: event.target.value as RuleForm["kind"] })}>
        <option value="fixed">Fixed or range</option><option value="per-km">Per km</option>
      </select></Field>
      <FixedPriceFields value={{ low: form.low, high: form.high, currency: form.currency }} errors={errors} onChange={set} />
      <Field label="Charged"><select value={form.unit} onChange={event => set({ unit: event.target.value as RuleForm["unit"] })}>
        <option value="person">Per person</option><option value="party">Per group</option><option value="vehicle">Per vehicle</option>
      </select></Field>
      {form.unit === "vehicle" && <Field label="Seats per vehicle" error={errors.capacity}>
        <input type="text" inputMode="numeric" value={form.capacity} onChange={event => set({ capacity: event.target.value })} />
      </Field>}
      <Field label="Priority" error={errors.priority} info={<InfoTip topic="priority" align="end">A higher priority wins. Default 0.</InfoTip>}>
        <input type="text" value={form.priority} onChange={event => set({ priority: event.target.value })} />
      </Field>
    </div>
    <div className="p-form-actions">
      <Button type="button" size="sm" disabled={busy || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save rule"}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={newRule}>New rule</Button>
      {errors.save && <p className="p-field-error" role="alert">{errors.save}</p>}
    </div>
  </MissingSection>;
}
