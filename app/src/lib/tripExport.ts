import type { Route, SavedTrip, TripSpec } from "./planner";
import { assumptionNotes, dayByDay, formatDuration, hoursText, journeySource, mainService, modeLabel, moneyShort, priceText, sortRoutes, stepLabel, ticketJourney, ticketRows, unpricedSummary } from "./present";

export type ExportScope = "selected" | "current" | "all";
export type ExportOption = { label: string; route: Route; category: string };
export type ExportTrip = { spec: TripSpec; options: ExportOption[]; notes: string[] };

/** Use calculated data only for the saved trip revision; never relabel an old itinerary with new settings. */
export function exportTrip(record: SavedTrip, options?: ExportOption[]): ExportTrip {
  const result = record.result;
  const current = result?.trip_revision === record.revision;
  const notes: string[] = [];
  if (!result) notes.push("No calculated options saved yet.");
  else if (!current) notes.push("Saved options are out of date for these trip settings. Recalculate before sharing itineraries.");
  else {
    if (result.snapshot_revision !== record.snapshot?.revision) notes.push("These are the last calculated options. Newer collected schedules have not been included.");
    if (!result.optimization_complete) notes.push("Not all combinations were checked.");
    if (result.discovery_required || result.coverage.discovery_complete === false || (result.coverage.pending ?? 0) > 0) notes.push("Transport search is incomplete. More options may become available.");
    if (result.optimality_scope) notes.push(result.optimality_scope);
  }
  const group = (routes: Route[] | undefined, category: string, prefix: string) => sortRoutes(routes ?? [], "cheapest").map((route, i) => ({ route, category, label: `${prefix} ${i + 1}` }));
  return { spec: record.spec, notes, options: !current ? [] : options ?? [
    ...group(result.routes, "Best", "Option"),
    ...group(result.dominated_routes, "Weaker", "Weaker option"),
    ...group(result.refinement_routes, "Over budget", "Over-budget option"),
  ] };
}

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const paragraph = (text: string, className = "") => `<p class="${className}">${escape(text)}</p>`;
const list = (items: string[]) => items.length ? `<ul>${items.map(item => `<li>${escape(item)}</li>`).join("")}</ul>` : "";
const link = (url: string | null | undefined, text: string) => url && /^https?:\/\//i.test(url) ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">${escape(text)}</a>` : "";
const clocks = new Map<string, Intl.DateTimeFormat>();
function localTime(value: string | null, zone: string) {
  if (!value) return "Time not set";
  if (!clocks.has(zone)) clocks.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", hourCycle: "h23" }));
  return `${clocks.get(zone)!.format(new Date(value))} (${zone})`;
}

/** A self-contained, escaped document: no app server, external styles, fonts or images required. */
export function tripReportHtml(trips: ExportTrip[], generatedAt = new Date()): string {
  const title = trips.length === 1 ? trips[0].spec.name : "Trip comparison";
  const content = trips.map((trip, tripIndex) => {
    const { spec, options } = trip;
    const places = new Map([spec.home, ...spec.departures, ...spec.arrivals, ...spec.visits.map(visit => visit.place)].map(place => [place.id, place]));
    const name = (id: string) => places.get(id)?.name ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);
    const zone = (id: string) => places.get(id)?.timezone ?? "UTC";
    const minimums = Object.fromEntries(spec.visits.map(visit => [visit.place.id, visit.min_stay_hours]));
    const chain = (route: Route) => route.movements.length ? [name(route.movements[0].from_id), ...route.movements.map(movement => name(movement.to_id))].join(" → ") : "";
    const summary = options.length > 1 ? `<div class="table-wrap"><table class="comparison"><thead><tr><th>Option</th><th>Route</th><th>Group transport price</th><th>Time in cities</th><th>Travel time</th><th>Status</th></tr></thead><tbody>${options.map((option, i) => `<tr><td><a href="#trip-${tripIndex}-option-${i}">${escape(option.label)}</a></td><td>${escape(chain(option.route))}</td><td>${escape(priceText(option.route))}</td><td>${escape(hoursText(option.route.stay_hours))} h</td><td>${escape(hoursText(option.route.travel_hours))} h</td><td>${escape([option.category, unpricedSummary(option.route, spec.exchange_rates).chip, option.route.estimated ? "Estimates" : "", option.route.provisional ? "Provisional" : ""].filter(Boolean).join(" · "))}</td></tr>`).join("")}</tbody></table></div>` : options.length ? "" : paragraph("No current itinerary options to share.");
    const itineraries = options.map(({ label, route, category }, i) => {
      const unpriced = unpricedSummary(route, spec.exchange_rates).text;
      const timetable = dayByDay(route, minimums).map(entry => {
        if (entry.kind === "stay") return `<li class="stay"><strong>${escape(name(entry.stay.place_id))} · ${escape(hoursText(entry.stay.hours))} h in city</strong>${paragraph(`${localTime(entry.stay.arrival, zone(entry.stay.place_id))} → ${localTime(entry.stay.departure, zone(entry.stay.place_id))}`)}</li>`;
        if (entry.kind === "gap") return `<li>${escape(formatDuration(entry.minutes))} at ${escape(name(entry.placeId))} (outside required city stays)</li>`;
        const movement = entry.movement;
        return `<li><strong>${escape(`${name(movement.from_id)} → ${name(movement.to_id)} · ${modeLabel(movement.mode)}${mainService(movement) ? ` · ${mainService(movement)}` : ""}`)}</strong>${paragraph(`${localTime(movement.departure, zone(movement.from_id))} → ${localTime(movement.arrival, zone(movement.to_id))}`)}${paragraph(`${formatDuration(movement.duration_minutes)} · ${journeySource(movement)}`, "muted")}${movement.schedule_estimated ? paragraph(`Estimated timetable${movement.schedule_reference_date ? ` copied from ${movement.schedule_reference_date}` : ""}. Check the real timetable before booking.`, "warning") : ""}${movement.segments.length ? `<ul class="steps">${movement.segments.map(segment => `<li>${escape(`${segment.departure ? `${localTime(segment.departure, segment.from_timezone ?? zone(movement.from_id))} · ` : ""}${stepLabel(segment, movement).text}`)}</li>`).join("")}</ul>` : ""}${link(movement.search_url, "Search fare")}</li>`;
      }).join("");
      const tickets = ticketRows(route, spec.exchange_rates, name, zone).map(row => `<tr><td>${escape(row.label)}${row.flights.length ? paragraph(row.flights.map(flight => ticketJourney(flight, name, zone)).join("; "), "muted") : ""}</td><td>${escape(row.amount)}</td><td>${escape(row.source ?? "Not priced")}${row.offer.search_url ? ` ${link(row.offer.search_url, "Check fare")}` : ""}</td></tr>`).join("");
      const notes = assumptionNotes(route, name).map(note => note.text);
      return `<article class="itinerary" id="trip-${tripIndex}-option-${i}"><h3>${trips.length > 1 ? `${escape(spec.name)} · ` : ""}${escape(label)}</h3>${paragraph(`${category} · ${priceText(route)} for ${spec.adults} adult${spec.adults === 1 ? "" : "s"} · ${hoursText(route.stay_hours)} h in cities · ${hoursText(route.travel_hours)} h travel`)}${unpriced ? paragraph(`${unpriced}. The total is incomplete.`, "warning") : ""}<h4>Day by day</h4><ol class="timeline">${timetable}</ol><h4>Tickets and prices</h4><table><thead><tr><th>Item</th><th>Group price</th><th>Source</th></tr></thead><tbody>${tickets}</tbody></table>${notes.length ? `<h4>Check before booking</h4>${list(notes)}` : ""}</article>`;
    }).join("");
    return `<section class="trip${options.length === 1 ? " single-option" : ""}">${trips.length > 1 ? `<h2>${escape(spec.name)}</h2>` : ""}${paragraph(`${spec.start_date} to ${spec.end_date} · ${spec.date_mode === "fixed" ? "Fixed dates" : "Flexible dates"} · ${spec.adults} adult${spec.adults === 1 ? "" : "s"} · Home: ${spec.home.name}${spec.one_way === "from_home" ? " · One way from home" : spec.one_way === "to_home" ? " · One way to home" : ""}`)}${paragraph(`Visit: ${spec.visits.map(visit => `${visit.place.name} (at least ${hoursText(visit.min_stay_hours)} h)`).join(", ")}`)}${paragraph(`Transport: ${spec.modes.map(modeLabel).join(", ")} · Group budget: ${spec.budget_myr === null ? "Not set" : moneyShort(spec.budget_myr)}`)}${list(trip.notes)}${summary}${itineraries}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} - Wayfinder</title><style>
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; } body { max-width: 1050px; margin: 32px auto; padding: 0 24px; color: #172d36; background: white; font: 14px/1.55 Arial, sans-serif; overflow-wrap: anywhere; }
h1 { font-size: 28px; } h2 { font-size: 23px; border-bottom: 2px solid #0f766e; padding-bottom: 8px; } h3 { font-size: 20px; } h4 { font-size: 15px; margin-bottom: 8px; } h1,h2,h3,h4 { line-height: 1.3; break-after: avoid; } p { margin: 6px 0; } a { color: #0f766e; } .muted,footer { color: #52616b; font-size: 12px; } .warning { color: #874500; font-weight: bold; } .notice { border-left: 3px solid #0f766e; padding: 6px 14px; margin: 18px 0; background: #f2f8f7; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 16px 0; } th,td { padding: 9px 8px; border-bottom: 1px solid #d7e0e3; text-align: left; vertical-align: top; } th { background: #edf4f3; } thead { display: table-header-group; } .comparison th { overflow-wrap: normal; } .comparison td:first-child { white-space: nowrap; } tr { break-inside: avoid; } .itinerary { margin-top: 32px; padding-top: 8px; border-top: 1px solid #d7e0e3; } .timeline { padding-left: 22px; } .timeline > li { padding: 8px 0; } .steps { font-size: 12px; margin: 6px 0; padding-left: 18px; } .steps li { break-inside: avoid; } .stay { color: #0f655f; } footer { margin-top: 32px; border-top: 1px solid #d7e0e3; padding-top: 12px; } .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 0; } button { border: 0; border-radius: 6px; background: #0f766e; color: white; padding: 10px 16px; cursor: pointer; font: inherit; }
@media (max-width: 600px) { body { margin: 16px auto; padding: 0 14px; } .table-wrap { overflow-x: auto; } .table-wrap table { min-width: 650px; } }
@media print { body { margin: 0; padding: 0; max-width: none; font-size: 10pt; line-height: 1.4; } .toolbar { display: none; } .table-wrap { overflow: visible; } .table-wrap table { min-width: 0; } .trip + .trip,.itinerary { break-before: page; } .single-option .itinerary { break-before: auto; margin-top: 16px; padding-top: 0; } .timeline > li { padding: 4px 0; } p { margin: 4px 0; } h4 { margin: 12px 0 6px; } .notice { font-size: 9pt; } footer { margin-top: 16px; font-size: 8pt; } a { color: inherit; } table { font-size: 9pt; } }
</style></head><body><div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button><span>Choose “Save as PDF” in the print dialog.</span></div><header><h1>${escape(title)}</h1>${paragraph(`Shared from Wayfinder · Generated ${generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`, "muted")}</header><div class="notice">For group discussion. Prices are transportation totals for the whole group in MYR unless a ticket shows another currency. Accommodation, meals and activities are excluded. “From” means some prices are missing or open-ended. Times use each place's local timezone. Check fares, availability and estimated schedules before booking.</div>${content}<footer>This is a snapshot of saved trip settings and calculated options. Unapplied edits are excluded. Best options apply to the retrieved schedules and stated assumptions. Weaker options are included only if already loaded; this is not an exhaustive list of all possible journeys.</footer></body></html>`;
}

export function exportFilename(name: string): string {
  return `${name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 100) || "trips"}.html`;
}
