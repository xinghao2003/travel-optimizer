import type { AppliedSharedFareGroup } from "../components/MissingFaresTable";
import type { MissingFareGroup } from "./missingFares";
import type { AirportChangeRow } from "./present";
import { journeyGroupTitle, modeLabel } from "./present";
import { journeyScopeLabel } from "./journeyPricing";
import type { JourneyPriceScope, Offer, SavedTrip } from "./planner";
import { airportChangeProblems, blankTransferRow, deletionKey, removeComponent, sameAirportChange, sameFare, sameTransferRows, savedAirportChange, savedTransferRows, stageFare,
  transferKey, transferModes, transferProblems, type DraftState, type MissingInfoDeletion, type PriceValue, type SharedFare } from "./drafts";

export const csvColumns = ["trip_id", "revision", "adults", "row_id", "type", "from", "to", "description", "scope", "mode", "price", "max_price", "currency", "minutes", "myr_per_unit", "action"] as const;
type Column = typeof csvColumns[number];
type Values = Record<Column, string>;
type Binding =
  | { kind: "fare"; key: string; component_ids: string[]; label: string; scope?: JourneyPriceScope; saved: PriceValue | null }
  | { kind: "transfer"; from: string; to: string; mode: typeof transferModes[number] }
  | { kind: "change"; key: string }
  | { kind: "rate"; currency: string };
export type CsvTarget = { values: Values; binding: Binding; deletions: MissingInfoDeletion[] };
export type CsvContext = {
  trip: SavedTrip; groups: MissingFareGroup[]; appliedGroups: AppliedSharedFareGroup[]; airportChanges: AirportChangeRow[];
  drafts: DraftState; canonical: (id: string) => string; offerFor: (id: string) => Offer | undefined; placeName: (id: string) => string;
};
export type CsvChange = { line: number; target: CsvTarget; values: Values; operation?: "update" | "delete" };
export type CsvPreview = { changes: CsvChange[]; errors: string[]; warnings: string[]; unchanged: number };
const maxRows = 5000;
const editable: Record<Binding["kind"], Column[]> = {
  fare: ["price", "max_price", "currency"], transfer: ["price", "max_price", "currency", "minutes"],
  change: ["mode", "price", "currency", "minutes"], rate: ["currency", "myr_per_unit"],
};
export const missingInfoCsvRules = `Wayfinder Routes — Missing info CSV rules/schema

CSV header:
${csvColumns.join(",")}

Row types and editable columns:
journey_price: ${editable.fare.join(", ")}
airport_transfer: ${editable.transfer.join(", ")}
airport_change: ${editable.change.join(", ")}
exchange_rate: myr_per_unit; currency only in the rate:new row

Keep trip_id, revision, adults, row_id, type, from, to, description and scope unchanged. Keep mode unchanged except for airport_change rows. Match by the supplied row IDs, not names. Keep the header. Do not invent journey or group IDs.

price: whole-party amount per journey, not per person or a total across the group. Use decimal numbers without currency symbols or thousands separators. Explicit 0 means free. Unknown values should stay blank.
max_price: leave blank for a new fixed price; enter a number at least as large as price for a range. Only journey_price accepts open for no upper limit. To replace an existing range or open price with a fixed price, set max_price equal to price.
currency: 3-letter currency code, such as MYR, TWD or USD.
minutes: positive travel duration in minutes. Required for non-taxi airport transfers and all airport changes. A taxi can use the current road/default duration. An airport-change price is optional.
mode: ${transferModes.join(", ")}. Airport transfers already have one row per mode; fill the modes you want. Airport changes need a mode and duration.
myr_per_unit: positive MYR per 1 unit of the named currency. MYR is always 1. Use rate:new to add a currency; copy that row for more currencies. Do not change the currency of an existing rate row. Foreign prices without a rate leave totals incomplete.

action: leave blank (or use update) to import filled values as usual. Use delete to remove this row's user-entered value. Missing rows are unchanged. Deletions are previewed and staged until Apply. Provider data and retrieved journeys cannot be deleted; removing a manual price allows provider prices or rules to apply again. Deleting an exchange rate leaves prices in that currency without a conversion rate; deleting an airport change can make affected journeys unusable.

Blank value cells leave saved values and existing drafts unchanged. Preserve direction, party size and matching scope. Individual journey overrides take precedence over group estimates; provider fares retain their normal precedence over reusable estimates.

Return CSV with its header, or tab-separated spreadsheet cells. Quote cells containing commas, quotes or newlines; double embedded quotes. Do not wrap the data in Markdown code fences or add explanations inside the CSV. Context fields escaped for spreadsheet formulas should be kept as supplied.

Identical duplicate rows are ignored. Conflicting duplicates, unknown IDs, changed grouping, another trip/party size, an outdated revision, invalid values or malformed CSV block importing. If the trip changed, use Reset to current values and fill the regenerated rows.

Limits: ${maxRows} rows and 8 MB of text. New scheduled connections, combined-ticket quotes, trip setup and global pricing rules are outside this schema.

Workflow: Preview changes → Import as drafts → Apply. Importing only stages drafts in this browser; Apply saves the batch and updates options once.`;
const text = (value: number | null | undefined) => value == null ? "" : String(value);
const priceCells = (price: PriceValue | null) => ({ price: text(price?.low), max_price: price && price.high === null ? "open" : price?.high === price?.low ? "" : text(price?.high), currency: price?.currency ?? "MYR" });
const rowId = (type: string, key: string) => `${type}:${encodeURIComponent(key)}`;

/** Export only existing Missing info scopes. IDs retain direction, grouping and canonical journey identity. */
export function missingInfoCsvTargets(context: CsvContext): CsvTarget[] {
  const { trip, drafts, groups, appliedGroups, airportChanges, canonical, offerFor, placeName } = context;
  const targets = new Map<string, CsvTarget>();
  const add = (id: string, binding: Binding, cells: Partial<Values>) => {
    const values = Object.fromEntries(csvColumns.map(column => [column, ""])) as Values;
    Object.assign(values, { trip_id: trip.id, revision: String(trip.revision), adults: String(trip.spec.adults), row_id: id }, cells);
    const deletions: MissingInfoDeletion[] = [];
    const mark = (kind: MissingInfoDeletion["kind"], id: string) => deletions.push({ kind, id, label: values.description || `${values.from} → ${values.to}` });
    if (binding.kind === "fare") {
      const group = appliedGroups.find(group => group.key === binding.key);
      if (group?.ruleId) mark("journey_rule", group.ruleId);
      else if (!binding.scope) {
        for (const offer of trip.offers) {
          if (offer.source === "user" && (offer.adults == null || offer.adults === trip.spec.adults)
            && offer.movement_ids.length === 1 && binding.component_ids.includes(canonical(offer.movement_ids[0]))
            && (binding.key.startsWith("component:") || offer.label === binding.label)) mark("offer", offer.id);
        }
      }
    } else if (binding.kind === "transfer") {
      if (trip.airport_transfer_estimates?.some(e => e.from_id === binding.from && e.to_id === binding.to && e.adults === trip.spec.adults && e.mode === binding.mode))
        mark("airport_transfer", JSON.stringify([binding.from, binding.to, trip.spec.adults, binding.mode]));
    } else if (binding.kind === "change") {
      if (trip.airport_connections?.some(c => `${c.from_airport}>${c.to_airport}` === binding.key)) mark("airport_change", binding.key);
    } else if (binding.currency && binding.currency !== "MYR" && trip.spec.exchange_rates[binding.currency] !== undefined) mark("exchange_rate", binding.currency);
    targets.set(id, { values, binding, deletions });
  };
  const currencies = new Set([...Object.keys(trip.spec.exchange_rates), ...Object.keys(drafts.exchangeRates ?? {})]);
  const addFare = (key: string, ids: string[], label: string, scope: JourneyPriceScope | undefined, saved: PriceValue | null,
    from: string, to: string, description: string, scopeText: string, mode = "") => {
    const binding: Binding = { kind: "fare", key, component_ids: [...new Set(ids.map(canonical))], label, scope, saved };
    const price = drafts.fares[key] ?? saved;
    currencies.add(price?.currency ?? "MYR");
    add(rowId("fare", key), binding, { type: "journey_price", from, to, description, scope: scopeText, mode, ...priceCells(price) });
  };
  for (const group of groups) {
    currencies.add(group.currency);
    const from = placeName(group.from_id), to = placeName(group.to_id);
    const scope = group.scope ? journeyScopeLabel(group.scope, group.components[0]?.journey) : "Only the listed journeys";
    addFare(group.key, group.components.map(c => c.component_id), `Shared estimate: ${from} → ${to} · ${group.scope ? scope : group.label}`.slice(0, 200),
      group.scope, null, from, to, journeyGroupTitle(group, placeName), scope, group.mode);
    for (const component of group.components) {
      const id = canonical(component.component_id), offer = offerFor(component.component_id);
      const saved: PriceValue | null = offer?.low != null ? { low: offer.low, high: offer.high, currency: offer.currency } : null;
      addFare(`component:${id}`, [id], `${from} → ${to}`.slice(0, 200), undefined, saved, from, to,
        [component.departure, component.service].filter(Boolean).join(" · ") || group.label, "Only this journey", group.mode);
    }
  }
  for (const group of appliedGroups) {
    const scope = group.scope;
    const saved = group.low !== null && !group.mixed_currency ? { low: group.low, high: group.high, currency: group.currency } : null;
    addFare(group.key, group.component_ids, group.label, scope, saved, scope ? placeName(scope.from_id) : "", scope ? placeName(scope.to_id) : "",
      group.label, scope ? journeyScopeLabel(scope) : "Only the listed journeys");
  }
  for (const direction of trip.airport_transfer_rows ?? []) {
    const key = transferKey(direction.from_id, direction.to_id, trip.spec.adults);
    const ways = drafts.transfers[key] ?? savedTransferRows(trip.airport_transfer_estimates ?? [], direction.from_id, direction.to_id, trip.spec.adults);
    for (const mode of transferModes) {
      const way = ways.find(item => item.mode === mode) ?? blankTransferRow(mode);
      currencies.add(way.currency);
      add(rowId("transfer", JSON.stringify([direction.from_id, direction.to_id, mode])), { kind: "transfer", from: direction.from_id, to: direction.to_id, mode },
        { type: "airport_transfer", from: placeName(direction.from_id), to: placeName(direction.to_id), description: `${direction.label} · ${modeLabel(mode)}`,
          scope: "All matching transfers in this direction", mode, price: way.low, max_price: way.high, currency: way.currency, minutes: way.duration });
    }
  }
  for (const row of airportChanges) {
    const key = `${row.from_airport}>${row.to_airport}`;
    const saved = savedAirportChange(trip.airport_connections?.find(c => `${c.from_airport}>${c.to_airport}` === key));
    const value = key in drafts.airportChanges ? drafts.airportChanges[key] : saved;
    currencies.add(value?.currency ?? "MYR");
    add(rowId("change", key), { kind: "change", key }, { type: "airport_change", from: row.from_airport, to: row.to_airport,
      description: `${row.from_name} → ${row.to_name}`, scope: "All journeys with this directed airport change", mode: value?.mode ?? "",
      price: value?.fare ?? "", currency: value?.currency ?? "MYR", minutes: value?.duration ?? "" });
  }
  for (const currency of [...currencies].filter(c => c !== "MYR").sort()) {
    add(`rate:${currency}`, { kind: "rate", currency }, { type: "exchange_rate", currency, description: `1 ${currency} in MYR`,
      scope: "This trip", myr_per_unit: text(drafts.exchangeRates?.[currency] ?? trip.spec.exchange_rates[currency]) });
  }
  add("rate:new", { kind: "rate", currency: "" }, { type: "exchange_rate", description: "New currency (copy this row for more)", scope: "This trip" });
  if (targets.size > maxRows) throw new Error(`This export has more than ${maxRows} rows. Narrow the journey grouping before exporting.`);
  return [...targets.values()];
}

const safeCell = (value: string) => /^[=+@-]/.test(value) ? `'${value}` : value;
export function exportMissingInfoCsv(targets: CsvTarget[]): string {
  const cell = (value: string) => `"${safeCell(value).replaceAll('"', '""')}"`;
  const csv = [csvColumns.join(","), ...targets.map(t => csvColumns.map(c => cell(t.values[c])).join(","))].join("\r\n");
  if (csv.length > 8_000_000) throw new Error("This CSV exceeds 8 MB. Narrow the journey grouping and try again.");
  return csv;
}

/** CSV and spreadsheet clipboard TSV, including quoted delimiters, quotes and multiline cells. */
export function parseDelimited(text: string): string[][] {
  if (text.length > 8_000_000) throw new Error("Paste up to 8 MB at a time.");
  text = text.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; };
  const endRow = () => { endCell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > maxRows + 1) throw new Error(`Paste up to ${maxRows} rows at a time.`); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === delimiter) endCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed && char.trim()) throw new Error("Unexpected text after a closing quote.");
    else if (char === '"') throw new Error("Quote a whole cell and escape quotes by doubling them.");
    else if (!closed) cell += char;
  }
  if (quoted) throw new Error("A quoted cell has no closing quote.");
  endRow(); return rows;
}

export function previewMissingInfoCsv(source: string, context: CsvContext): CsvPreview {
  const preview: CsvPreview = { changes: [], errors: [], warnings: [], unchanged: 0 };
  try {
    const [header, ...rows] = parseDelimited(source);
    if (!header || !rows.length) throw new Error("Paste the header and at least one CSV row.");
    const columns = header.map(c => c.trim().toLowerCase());
    if (new Set(columns).size !== columns.length) throw new Error("Column names must be unique.");
    for (const required of ["trip_id", "revision", "adults", "row_id", "type"]) if (!columns.includes(required)) throw new Error(`Missing column: ${required}. Keep the generated header.`);
    for (const c of columns) if (!csvColumns.includes(c as Column)) throw new Error(`Unknown column: ${c}.`);
    const targets = new Map(missingInfoCsvTargets(context).map(t => [t.values.row_id, t]));
    const duplicates = new Map<string, string>();
    rows.forEach((cells, index) => {
      const line = index + 2;
      try {
        if (cells.length !== columns.length) throw new Error("The number of cells does not match the header.");
        const input = Object.fromEntries(columns.map((c, i) => [c, cells[i].trim()])) as Partial<Values>;
        const trip = context.trip;
        if (input.trip_id !== trip.id) throw new Error("This row belongs to another trip.");
        if (input.revision !== String(trip.revision)) throw new Error("This trip changed since the CSV was generated. Reset to current values before editing again.");
        if (input.adults !== String(trip.spec.adults)) throw new Error("This row has a different party size.");
        const target = targets.get(input.row_id!);
        if (!target || input.type !== target.values.type) throw new Error("Unknown row or changed grouping. Reset to current values before editing again.");
        const { binding } = target;
        const action = (input.action || "update").toLowerCase();
        if (action !== "update" && action !== "delete") throw new Error("Use a blank action, update, or delete.");
        const values = { ...target.values };
        let changed = false;
        for (const column of columns as Column[]) {
          const value = input[column]!;
          if (!value) continue; // Blank cells never clear saved values or pending drafts.
          if (editable[binding.kind].includes(column)) {
            const normalized = column === "currency" ? value.toUpperCase() : value;
            if (normalized !== values[column]) changed = true;
            values[column] = normalized;
          } else if (["from", "to", "scope", "mode", "max_price", "price", "minutes", "myr_per_unit"].includes(column)
            && value !== target.values[column] && value !== safeCell(target.values[column])) throw new Error(`Do not change ${column} for this row type.`);
        }
        const key = binding.kind === "rate" ? `rate:${values.currency}` : values.row_id;
        const signature = JSON.stringify([action, ...(action === "delete" ? [] : editable[binding.kind].map(c => values[c]))]);
        if (duplicates.has(key)) {
          if (duplicates.get(key) !== signature) throw new Error("Conflicting duplicate values for the same row.");
          preview.unchanged++; return;
        }
        duplicates.set(key, signature);
        if (action === "delete") {
          if (binding.kind === "rate" && values.currency !== binding.currency) throw new Error("Keep the existing currency when deleting its rate.");
          const pending = binding.kind === "fare" ? !!context.drafts.fares[binding.key]
            : binding.kind === "transfer" ? !!context.drafts.transfers[transferKey(binding.from, binding.to, trip.spec.adults)]?.some(r => r.mode === binding.mode)
            : binding.kind === "change" ? binding.key in context.drafts.airportChanges : !!context.drafts.exchangeRates?.[binding.currency];
          if (!target.deletions.length && !pending) throw new Error("This row has no user-entered value to delete. Provider data cannot be deleted.");
          preview.changes.push({ line, target, values, operation: "delete" });
          return;
        }
        if (!changed) { preview.unchanged++; return; }
        if (binding.kind === "rate") {
          if (!/^[A-Z]{3}$/.test(values.currency) || values.currency === "MYR") throw new Error("Enter a 3-letter currency other than MYR.");
          if (binding.currency && values.currency !== binding.currency) throw new Error("Use the new-currency row to add a different currency.");
          if (!values.myr_per_unit || !Number.isFinite(Number(values.myr_per_unit)) || Number(values.myr_per_unit) <= 0) throw new Error("Enter positive MYR per unit of currency.");
        } else {
          if (!/^[A-Z]{3}$/.test(values.currency)) throw new Error("Enter a 3-letter currency code.");
          if (values.price && (!Number.isFinite(Number(values.price)) || Number(values.price) < 0)) throw new Error("Enter a price of 0 or more.");
          if (binding.kind === "fare") {
            if (!values.price) throw new Error("Enter a price for this journey or group.");
            if (values.max_price !== "open" && values.max_price && (!Number.isFinite(Number(values.max_price)) || Number(values.max_price) < Number(values.price))) throw new Error("The maximum price must be at least the price, or use open.");
          } else if (binding.kind === "transfer") {
            const problem = transferProblems([{ mode: binding.mode, low: values.price, high: values.max_price, duration: values.minutes, currency: values.currency }])[0];
            if (problem) throw new Error(problem.message);
          } else {
            if (!transferModes.includes(values.mode as typeof transferModes[number])) throw new Error("Choose a valid transfer mode.");
            const problem = airportChangeProblems({ mode: values.mode as typeof transferModes[number], duration: values.minutes, fare: values.price, currency: values.currency })[0];
            if (problem) throw new Error(problem.message);
          }
        }
        preview.changes.push({ line, target, values, operation: "update" });
      } catch (error) { preview.errors.push(`Row ${line}: ${(error as Error).message}`); }
    });
    const available = { ...context.trip.spec.exchange_rates, ...context.drafts.exchangeRates };
    const deleted = new Set(preview.changes.filter(c => c.operation === "delete").flatMap(c => c.target.deletions.map(deletionKey)));
    for (const change of preview.changes) {
      if (change.operation !== "delete" && change.target.deletions.some(d => deleted.has(deletionKey(d)))) preview.errors.push(`Row ${change.line}: the same saved entry is both updated and deleted in this import.`);
      if (change.target.binding.kind === "rate") {
        if (change.operation === "delete") { delete available[change.values.currency]; preview.warnings.push(`Deleting ${change.values.currency} removes its conversion rate. Prices in that currency will remain incomplete.`); }
        else available[change.values.currency] = Number(change.values.myr_per_unit);
      }
    }
    const missing = new Set(preview.changes.filter(c => c.operation !== "delete" && c.target.binding.kind !== "rate" && c.values.price && !available[c.values.currency]).map(c => c.values.currency));
    for (const currency of missing) preview.warnings.push(`No ${currency} exchange rate is entered. Totals using it will remain incomplete.`);
  } catch (error) { preview.errors.push((error as Error).message); }
  return preview;
}

/** Merge a validated preview in one batch; exact journey overrides follow reusable group estimates. */
export function stageMissingInfoCsv(changes: CsvChange[], current: DraftState, trip: SavedTrip): DraftState {
  const next: DraftState = { ...current, fares: { ...current.fares }, transfers: { ...current.transfers }, airportChanges: { ...current.airportChanges }, exchangeRates: { ...current.exchangeRates }, deletions: { ...current.deletions } };
  for (const { target, values: v, operation } of [...changes].sort((a, b) => Number(a.target.values.scope === "Only this journey") - Number(b.target.values.scope === "Only this journey"))) {
    const b = target.binding;
    if (operation === "delete") {
      for (const deletion of target.deletions) next.deletions![deletionKey(deletion)] = deletion;
      if (b.kind === "fare") {
        delete next.fares[b.key];
        if (b.key.startsWith("component:")) for (const id of b.component_ids) next.fares = removeComponent(next.fares, id);
      } else if (b.kind === "transfer") {
        const key = transferKey(b.from, b.to, trip.spec.adults);
        if (next.transfers[key]) {
          const rows = next.transfers[key].filter(r => r.mode !== b.mode);
          const saved = savedTransferRows(trip.airport_transfer_estimates ?? [], b.from, b.to, trip.spec.adults);
          if (sameTransferRows(rows, saved)) delete next.transfers[key]; else next.transfers[key] = rows;
        }
      } else if (b.kind === "change") delete next.airportChanges[b.key];
      else delete next.exchangeRates![b.currency];
      continue;
    }
    for (const deletion of target.deletions) delete next.deletions![deletionKey(deletion)];
    if (b.kind === "fare") {
      const fare: SharedFare = { component_ids: b.component_ids, label: b.label, low: Number(v.price), high: v.max_price === "open" ? null : Number(v.max_price || v.price), currency: v.currency, ...(b.scope ? { scope: b.scope } : {}) };
      next.fares = stageFare(next.fares, b.key, fare);
      if (sameFare(fare, b.saved)) delete next.fares[b.key];
    } else if (b.kind === "transfer") {
      const key = transferKey(b.from, b.to, trip.spec.adults);
      const saved = savedTransferRows(trip.airport_transfer_estimates ?? [], b.from, b.to, trip.spec.adults);
      const ways = [...next.transfers[key] ?? saved];
      const way = { mode: b.mode, low: v.price, high: v.max_price, currency: v.currency, duration: v.minutes };
      const index = ways.findIndex(w => w.mode === b.mode);
      if (index < 0) {
        // A fully blank placeholder taxi is not an explicitly selected extra way.
        if (ways.length === 1 && ways[0].mode === "taxi" && !ways[0].low && !ways[0].duration && !ways[0].high) ways.length = 0;
        ways.push(way);
      } else ways[index] = way;
      if (sameTransferRows(ways, saved)) delete next.transfers[key]; else next.transfers[key] = ways;
    } else if (b.kind === "change") {
      const draft = { mode: v.mode as typeof transferModes[number], duration: v.minutes, fare: v.price, currency: v.currency };
      const saved = savedAirportChange(trip.airport_connections?.find(c => `${c.from_airport}>${c.to_airport}` === b.key));
      if (sameAirportChange(draft, saved)) delete next.airportChanges[b.key]; else next.airportChanges[b.key] = draft;
    } else {
      const rate = Number(v.myr_per_unit);
      if (trip.spec.exchange_rates[v.currency] === rate) delete next.exchangeRates![v.currency]; else next.exchangeRates![v.currency] = rate;
    }
  }
  return next;
}
