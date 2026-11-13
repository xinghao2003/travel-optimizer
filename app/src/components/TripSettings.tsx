import { TemporalInput } from "./ui/temporal-input";
import { Select, SelectItem } from "./ui/select";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GripVertical, LoaderCircle, Play } from "lucide-react";
import { Button } from "./ui/button";
import { InfoTip } from "./InfoTip";
import { Field, NumberField, PlacePicker } from "./PlannerForms";
import { StartCities } from "./PositioningSettings";
import { anyDeparture, autoStayHours, availabilityText, departsAnyTime, groupState, isAutoStay, setGroup, stayText, transportGroups, withAutoStays } from "../lib/plan";
import { dateModeText, formatLocal, modeLabel, settingsSummaries, staySumWarning, transitSearchModes, type FooterState, type SettingsSummary } from "../lib/present";
import { localInputToISO, type OneWay, type Place, type TripDraft, type TripSpec } from "../lib/planner";

const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * Trip settings (C4): the core fields, More settings (G) and the sticky footer with the search actions.
 * `errors` is validateDraft(draft). The forms in More settings show their own errors inline (C2).
 */
export function TripSettings({ draft, edit: setDraft, places, errors, transitConfigured, searchActive, partyNotice, isNew, footer, busyAction, onSearch, onSaveOnly, batchSize, onBatchSize, roundMinutes, onRoundMinutes }: {
  draft: TripDraft; edit: (value: TripDraft) => void; places: Place[]; errors: Record<string, string>;
  transitConfigured: boolean; searchActive: boolean; partyNotice: string | null; isNew: boolean;
  footer: FooterState; busyAction: string | null; onSearch: () => void; onSaveOnly: () => void;
  /** Requests per search batch: kept in memory, not in the trip. */
  batchSize: number; onBatchSize: (value: number) => void;
  roundMinutes: number | null; onRoundMinutes: (value: number | null) => void;
}) {
  // Automatic minimum stays follow the free time and the number of cities.
  const edit = (next: TripDraft) => setDraft(withAutoStays(draft, next));
  const reasonId = useId(), modesErrorId = useId(), windowErrorId = useId(), fromId = useId(), untilId = useId();
  const changeHome = useRef<HTMLButtonElement>(null);
  const [changingHome, setChangingHome] = useState(false);
  // Polite status lines for what a change removed as well.
  const [homeStatus, setHomeStatus] = useState("");
  const [visitStatus, setVisitStatus] = useState("");
  // Change opens the home picker and moves focus into it; choosing a place or Cancel returns focus to Change.
  const homeFocus = useRef<"picker" | "change" | null>(null);
  useEffect(() => {
    const target = homeFocus.current === "picker" ? document.getElementById("home-city") : homeFocus.current === "change" ? changeHome.current : null;
    homeFocus.current = null;
    target?.focus();
  }, [changingHome, draft.home?.id]);

  function chooseHome(place: Place) {
    const journeys = draft.positioning_services?.length ?? 0;
    if (draft.home && draft.home.id !== place.id && journeys && !window.confirm(`Changing home removes your ${count(journeys, "journey")} to start and end cities.`)) return;
    // Home can't be a city to visit, and appointments belong to cities to visit.
    const visit = draft.visits.some(item => item.place.id === place.id);
    const appointments = draft.commitments.filter(item => item.place_id === place.id).length;
    // Home stays a start and end option: the new home takes the old home's place in those lists.
    const swap = (list: Place[]) => [...new Map(list.map(item => item.id === draft.home?.id ? place : item).map(item => [item.id, item])).values()];
    edit({ ...draft, home: place, departures: swap(draft.departures), arrivals: swap(draft.arrivals),
      visits: draft.visits.filter(item => item.place.id !== place.id), commitments: draft.commitments.filter(item => item.place_id !== place.id) });
    setHomeStatus(visit ? `${place.name} removed from cities to visit.${appointments ? ` Also removed ${count(appointments, "appointment")} in ${place.name}.` : ""}` : "");
    homeFocus.current = "change"; setChangingHome(false);
  }
  // A one-way trip has no cities, journeys or home time on the side without home: choosing it removes them.
  function setOneWay(oneWay: OneWay | null) {
    if (!oneWay) return edit({ ...draft, one_way: null });
    const unused = oneWay === "from_home" ? "return" : "outbound";
    const journeys = draft.positioning_services?.filter(item => item.direction === unused).length ?? 0;
    if (journeys && !window.confirm(`One way removes your ${count(journeys, "journey")} ${unused === "return" ? "from end" : "to start"} cities.`)) return;
    edit({ ...draft, one_way: oneWay,
      ...(unused === "return" ? { arrivals: [], home_arrival_latest: null } : { departures: [], home_departure_earliest: null }),
      positioning_policies: draft.positioning_policies?.filter(item => item.direction !== unused),
      positioning_services: draft.positioning_services?.filter(item => item.direction !== unused) });
  }
  function removeVisit(place: Place) {
    const appointments = draft.commitments.filter(item => item.place_id === place.id).length;
    edit({ ...draft, visits: draft.visits.filter(item => item.place.id !== place.id), commitments: draft.commitments.filter(item => item.place_id !== place.id) });
    setVisitStatus(appointments ? `Also removed ${count(appointments, "appointment")} in ${place.name}.` : "");
  }
  // Ordered visits: drag a row, or use the arrow keys on its handle. Focus stays on the moved row's handle.
  const dragged = useRef<number | null>(null);
  function moveVisit(from: number, to: number) {
    if (to < 0 || to >= draft.visits.length || to === from) return;
    const next = [...draft.visits];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    edit({ ...draft, visits: next });
    setVisitStatus(`${item.place.name} moved to position ${to + 1} of ${next.length}.`);
    requestAnimationFrame(() => document.getElementById(`visit-handle-${item.place.id}`)?.focus());
  }

  const visits = draft.visits;
  const full = visits.length >= 4;
  const ordered = !!draft.ordered_visits && visits.length > 1;
  const staySum = staySumWarning(draft);
  const summaries = settingsSummaries(draft, batchSize, roundMinutes);
  const transitTypes = transportGroups[1].modes.filter(mode => draft.modes.includes(mode));
  const transitSummary: SettingsSummary = { summary: transitTypes.length ? transitTypes.map(modeLabel).join(", ") : "Off",
    changes: groupState(draft.modes, transportGroups[1]) === "some" ? ["Some trains & buses"] : [] };
  const changed = [...Object.entries(summaries).filter(([key]) => key !== "places").flatMap(([, group]) => group.changes), ...transitSummary.changes];
  const auto = autoStayHours(draft);
  const availability = availabilityText(draft);
  const anyTime = departsAnyTime(draft);
  const rail = draft.rail_fallback;
  const home = draft.home;
  const homeTip = `The trip ${draft.one_way === "from_home" ? "starts" : draft.one_way === "to_home" ? "ends" : "starts and ends"} here. Time at home does not count as time in cities.`;
  // Home and cities to visit are missing on every new trip: the footer says so, the fields stay unmarked.
  const placeErrors = !isNew;

  return <section id="trip-settings" className="p-panel p-settings p-plan" aria-labelledby="settings-title">
    <h2 id="settings-title" tabIndex={-1}>{isNew ? "Plan a trip" : "Trip settings"}</h2>
    {searchActive && <p className="p-notice">A search is running. Changing places, the visit order, round trip or one way, dates, adults, transport, departure times, start and end cities or estimated train timetables stops it.</p>}

    <div className="p-plan-rows">
      <div className="p-plan-row">
        <h3 className="p-plan-question">Where's home?</h3>
        <div className="p-plan-body">
          <div className="p-plan-line">
            {home && !changingHome ? <div className="p-home-chip">
              <span>{[home.name, home.country_code, home.airport_codes.join(", ")].filter(Boolean).join(" · ")}</span>
              <button ref={changeHome} type="button" className="p-text-button" aria-label="Change home city" onClick={() => { homeFocus.current = "picker"; setChangingHome(true); }}>Change</button>
            </div> : <div className="p-plan-grow">
              <PlacePicker inputId="home-city" label="Home city" disabledIds={home ? [home.id] : []} onSelect={chooseHome} />
              {home && <button type="button" className="p-text-button" onClick={() => { homeFocus.current = "change"; setChangingHome(false); }}>Cancel</button>}
            </div>}
            <Field label="Trip type" className="p-trip-type" info={<InfoTip topic="trip type" align="end">One way from home ends in the last city you visit. One way to home starts in the first city you visit. {homeTip}</InfoTip>}>
              <Select value={draft.one_way ?? "round"} onValueChange={value => setOneWay(value === "round" ? null : value as OneWay)}>
                <SelectItem value="round">Round trip</SelectItem>
                <SelectItem value="from_home">One way from home</SelectItem>
                <SelectItem value="to_home">One way to home</SelectItem>
              </Select>
            </Field>
          </div>
          <p className="p-field-status" aria-live="polite">{homeStatus}</p>
          {home && <StartCities key={`${home.id}:${draft.one_way ?? "round"}`} draft={draft} edit={edit} />}
          {errors.patterns && <p className="p-field-error" role="alert">{errors.patterns}</p>}
        </div>
      </div>

      <div className="p-plan-row">
        <h3 className="p-plan-question">Where to?</h3>
        <div className="p-plan-body">
          <PlacePicker label={ordered ? "Cities to visit (in this order)" : "Cities to visit (any order)"} placeholder="Add a city: name or airport code" limitText={`${visits.length} of 4`} disabled={full}
            hint={full ? "Up to 4 cities. Remove one to add another." : undefined} disabledIds={[home?.id ?? "", ...visits.map(visit => visit.place.id)]}
            error={placeErrors ? errors.visits : undefined}
            info={<InfoTip topic="cities to visit" align="end">The search picks the best order, unless you choose Visit in this order. Each city gets at least its minimum stay. The automatic minimum divides your free time evenly after 1 day for each journey.</InfoTip>}
            onSelect={place => { if (!full) { edit({ ...draft, visits: [...visits, { place, min_stay_hours: 0 }] }); setVisitStatus(""); } }} />
          {visits.length > 0 && <ul className="p-visit-rows">{visits.map((visit, i) => <li key={visit.place.id}
            onDragStart={event => { dragged.current = i; event.dataTransfer.effectAllowed = "move"; }}
            onDragOver={event => { if (dragged.current !== null) event.preventDefault(); }}
            onDrop={event => { event.preventDefault(); if (dragged.current !== null) moveVisit(dragged.current, i); dragged.current = null; }}
            onDragEnd={event => { dragged.current = null; event.currentTarget.draggable = false; }}>
            {ordered && <button type="button" id={`visit-handle-${visit.place.id}`} className="p-icon-button p-drag-handle"
              aria-label={`${visit.place.name}, position ${i + 1} of ${visits.length}. Drag, or press the up and down arrow keys, to move it.`}
              // Only the handle starts a drag, so text in the row's fields stays selectable.
              onPointerDown={event => { const row = event.currentTarget.closest("li"); if (row) row.draggable = true; }}
              onPointerUp={event => { const row = event.currentTarget.closest("li"); if (row) row.draggable = false; }}
              onKeyDown={event => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveVisit(i, i + (event.key === "ArrowUp" ? -1 : 1)); }
              }}><GripVertical size={16} aria-hidden="true" /></button>}
            <span className="p-visit-name">{ordered && `${i + 1}. `}{[visit.place.name, visit.place.country_code].filter(Boolean).join(" · ")}</span>
            <NumberField className="p-stay-field" label={<><span className="sr-only">Minimum stay in {visit.place.name}: </span>At least</>} unit="days"
              hint={visit.min_stay_hours > 0 ? isAutoStay(draft, visit.min_stay_hours) ? "Automatic" : visit.min_stay_hours < 24 ? stayText(visit.min_stay_hours) : undefined : undefined}
              value={visit.min_stay_hours ? Math.round(visit.min_stay_hours / 2.4) / 10 : null} min={0} max={365} optional placeholder="Required"
              error={visit.min_stay_hours > 0 ? undefined : "Enter a minimum stay greater than 0 days."}
              message="Enter a minimum stay greater than 0 and up to 365 days."
              onChange={n => edit({ ...draft, visits: visits.map((item, j) => j === i ? { ...item, min_stay_hours: n === null ? 0 : Math.round(n * 2400) / 100 } : item) })} />
            <button type="button" className="p-icon-button" aria-label={`Remove ${visit.place.name}`} onClick={() => removeVisit(visit.place)}>×</button>
          </li>)}</ul>}
          {visits.length > 1 && <label className="p-check"><input type="checkbox" checked={!!draft.ordered_visits} onChange={e => edit({ ...draft, ordered_visits: e.target.checked })} />Visit in this order</label>}
          {auto !== null && visits.some(visit => visit.min_stay_hours !== auto) && <button type="button" className="p-text-button"
            onClick={() => edit({ ...draft, visits: visits.map(visit => ({ ...visit, min_stay_hours: auto })) })}>Use the automatic minimum ({stayText(auto)}) for all cities</button>}
          <p className="p-field-status" aria-live="polite">{visitStatus}</p>
          {staySum && <p className="p-notice">{staySum}</p>}
        </div>
      </div>

      <fieldset className="p-plan-row">
        <legend className="p-plan-question">When are you free?</legend>
        <div className="p-plan-body">
          <div className="p-when">
            <span className="p-when-label" id={fromId}>From</span>
            <TemporalInput type="date" aria-labelledby={fromId} value={draft.start_date} onValueChange={value => edit({ ...draft, start_date: value })} />
            {draft.one_way !== "to_home" ? <TemporalInput type="time" aria-label="From time (optional)" value={draft.home_departure_earliest ?? ""} onValueChange={value => edit({ ...draft, home_departure_earliest: value || null })} /> : <span />}
            <span className="p-when-label" id={untilId}>Until</span>
            <TemporalInput type="date" aria-labelledby={untilId} min={draft.start_date} aria-invalid={errors.dates ? true : undefined} value={draft.end_date} onValueChange={value => edit({ ...draft, end_date: value })} />
            {draft.one_way !== "from_home" ? <TemporalInput type="time" aria-label="Until time (optional)" aria-invalid={errors.homeTimes ? true : undefined} value={draft.home_arrival_latest ?? ""} onValueChange={value => edit({ ...draft, home_arrival_latest: value || null })} /> : <span />}
          </div>
          {(errors.dates || errors.homeTimes) && <p className="p-field-error" role="alert">{errors.dates ?? errors.homeTimes}</p>}
          <small className="p-when-text">{availability ?? "Times are optional. Blank means the whole day."}{draft.date_mode === "fixed" && " · Exact dates: leave on the first day and return on the last day."}</small>
        </div>
      </fieldset>

      <div className="p-plan-row">
        <h3 className="p-plan-question">Who's going?</h3>
        <div className="p-plan-body">
          <div className="p-plan-line">
            <NumberField label="Adults" value={draft.adults} min={1} max={9} integer message="Enter 1 to 9 adults." error={errors.adults}
              onChange={n => { if (n !== null) edit({ ...draft, adults: n }); }} />
            <NumberField label={`Budget for ${count(draft.adults, "adult")} (MYR)`} value={draft.budget_myr} optional placeholder="No limit" message="Enter 0 or more, or leave it blank." error={errors.budget}
              info={<InfoTip topic="budget" align="end">Total for all adults. Options that cost more than this, even at their lowest price, move to Over budget.</InfoTip>}
              onChange={n => edit({ ...draft, budget_myr: n })} />
          </div>
          <div aria-live="polite">{partyNotice && <p className="p-notice">{partyNotice}</p>}</div>
        </div>
      </div>

      <fieldset className="p-plan-row" aria-describedby={errors.modes ? modesErrorId : undefined}>
        <legend className="p-plan-question">Transport</legend>
        <div className="p-plan-body">
          <div className="p-plan-line">
            <div className="p-mode-chips">{transportGroups.map(group => {
              const state = groupState(draft.modes, group);
              return <label className="p-check" key={group.id}>
                <input type="checkbox" checked={state !== "off"} onChange={e => edit({ ...draft, modes: setGroup(draft.modes, group, e.target.checked) })} />
                {group.label}{state === "some" && <span className="p-mode-some"> (some)</span>}
              </label>;
            })}</div>
            <InfoTip topic="transport" align="end">Flights are searched for you. Trains & buses are anything with a timetable and a ticket per person, including private express coaches. Car & taxi leave any time and are priced per vehicle; your own or a rental car also needs Advanced › Cars.</InfoTip>
          </div>
          {errors.modes && <p id={modesErrorId} className="p-field-error">{errors.modes}</p>}
          {!transitConfigured && draft.modes.some(mode => transitSearchModes.includes(mode)) && <p className="p-notice">Trains and buses are not searched: transit search is turned off in this build.</p>}
        </div>
      </fieldset>
    </div>

    <details className="p-more">
      <summary><span>Advanced</span><span className="p-more-summary">{changed.length ? changed.join(" · ") : "All default"}</span><ChevronDown size={16} className="p-chevron" aria-hidden="true" /></summary>
      <div className="p-more-body">
        <SettingsGroup title="Dates and departures" summary={summaries.departures}>
          <div className="p-check-row">
            <label className="p-check"><input type="checkbox" checked={draft.date_mode === "fixed"} onChange={e => edit({ ...draft, date_mode: e.target.checked ? "fixed" : "flexible" })} />Leave on the first day and return on the last day</label>
            <InfoTip topic="exact dates">Off: the whole journey can be on any days between From and Until. {dateModeText(draft)}</InfoTip>
          </div>
          <div className="p-check-row">
            <label className="p-check"><input type="checkbox" checked={!anyTime} onChange={e => edit({ ...draft, ...(e.target.checked ? { departure_start: "09:00", departure_end: "21:00" } : anyDeparture) })} />Only depart between</label>
            <InfoTip topic="departure times">Local time at each departure city. Applies to the scheduled departure of flights, trains and buses. Your own journeys can be outside these times.</InfoTip>
          </div>
          {!anyTime && <fieldset className="p-time-range">
            <legend className="sr-only">Departure times</legend>
            <div className="p-time-inputs">
              <TemporalInput id="setting-departure-start" type="time" aria-label="Earliest departure" value={draft.departure_start} onValueChange={value => edit({ ...draft, departure_start: value })} />
              <span aria-hidden="true">and</span>
              <TemporalInput type="time" aria-label="Latest departure" aria-invalid={errors.departureWindow ? true : undefined} aria-describedby={errors.departureWindow ? windowErrorId : undefined}
                value={draft.departure_end} onValueChange={value => edit({ ...draft, departure_end: value })} />
            </div>
            {errors.departureWindow && <p id={windowErrorId} className="p-field-error">{errors.departureWindow}</p>}
          </fieldset>}
          <div className="p-group-fields">
            <NumberField label="Max changes per journey" value={draft.max_transfers} optional integer max={10} placeholder="Any" onChange={n => edit({ ...draft, max_transfers: n })} />
          </div>
          <div className="p-check-row">
            <label className="p-check"><input type="checkbox" checked={draft.allow_overnight} onChange={e => edit({ ...draft, allow_overnight: e.target.checked })} />Allow overnight journeys</label>
            <InfoTip topic="overnight journeys">A journey is overnight when it crosses midnight in the departure city's time.</InfoTip>
          </div>
        </SettingsGroup>

        <SettingsGroup title="Trains & buses" summary={transitSummary}>
          <p className="p-hint">Types of scheduled transport to search.</p>
          <div className="p-mode-chips">{transportGroups[1].modes.map(mode => <label className="p-check" key={mode}>
            <input type="checkbox" checked={draft.modes.includes(mode)} onChange={e => edit({ ...draft, modes: e.target.checked ? [...draft.modes, mode] : draft.modes.filter(m => m !== mode) })} />{modeLabel(mode)}
          </label>)}</div>
        </SettingsGroup>

        <SettingsGroup title="Time buffers" summary={summaries.buffers}>
          <p className="p-hint">These times are part of each journey and reduce time in cities.</p>
          <div className="p-group-fields">
            {bufferFields.map(([key, label, max]) => <NumberField key={key} label={label} value={draft.timing[key]} integer max={max}
              onChange={n => { if (n !== null) edit({ ...draft, timing: { ...draft.timing, [key]: n } }); }} />)}
            <NumberField id="setting-airport-fallback" label="Default airport transfer time (min)" value={draft.timing.airport_transfer_fallback_minutes} optional integer max={600} placeholder="None"
              info={<InfoTip topic="default airport transfer time" align="end">Used when no road time is available. Blank: those flights can't be used until you enter a transfer time.</InfoTip>}
              onChange={n => edit({ ...draft, timing: { ...draft.timing, airport_transfer_fallback_minutes: n } })} />
          </div>
        </SettingsGroup>

        <SettingsGroup title="Fixed appointments" summary={summaries.appointments}>
          <Appointments draft={draft} edit={edit} />
        </SettingsGroup>

        <SettingsGroup title="Cars" summary={summaries.cars}>
          <Cars draft={draft} edit={edit} places={places} />
        </SettingsGroup>

        <SettingsGroup title="Prices and currencies" summary={summaries.prices}>
          <div className="p-check-row">
            <label className="p-check"><input type="checkbox" checked={draft.exclude_unpriced_flights ?? false} onChange={e => edit({ ...draft, exclude_unpriced_flights: e.target.checked })} />Skip flights without a price</label>
            <InfoTip topic="skipping flights without a price">Removes options that need a flight without a price after your prices, combined tickets and rules apply. Saved schedules are kept. Other prices can still be not priced.</InfoTip>
          </div>
          <ExchangeRates draft={draft} edit={edit} />
        </SettingsGroup>

        <SettingsGroup title="Estimated train timetables" summary={summaries.timetables}>
          <div className="p-check-row">
            <label className="p-check"><input type="checkbox" checked={rail?.enabled ?? false}
              onChange={e => edit({ ...draft, rail_fallback: { reference_date: null, max_shift_days: 180, station_radius_km: 25, ...rail, enabled: e.target.checked } })} />Use estimated train timetables when no train is found for the date</label>
            <InfoTip topic="estimated train timetables" align="end">When the search finds no train for the date, it tries stations within the radius. For trips more than 2 weeks away it copies up to 3 matching weekdays from the reference period. Station access uses walking times.</InfoTip>
          </div>
          {rail?.enabled && <>
            <div className="p-group-fields">
              <Field label="Copy from the week starting" hint="Blank: today"><TemporalInput type="date" value={rail.reference_date ?? ""} onValueChange={value => edit({ ...draft, rail_fallback: { ...rail, reference_date: value || null } })} /></Field>
              <NumberField label="Maximum date shift (days)" value={rail.max_shift_days} integer min={7} max={365} onChange={n => { if (n !== null) edit({ ...draft, rail_fallback: { ...rail, max_shift_days: n } }); }} />
              <NumberField label="Station search radius (km)" value={rail.station_radius_km} min={1} max={50} onChange={n => { if (n !== null) edit({ ...draft, rail_fallback: { ...rail, station_radius_km: n } }); }} />
            </div>
            <p className="p-notice">Estimated timetables are not confirmed. Check holidays, prices and seats before you book. Start a new search after you change these settings.</p>
          </>}
        </SettingsGroup>

        <SettingsGroup title="Search size" summary={summaries.searchSize}>
          <div className="p-group-fields">
            <Field label="Limit each round by" hint={searchActive ? "Changes apply to the next round." : undefined}><Select value={roundMinutes === null ? "requests" : "minutes"}
              onValueChange={value => onRoundMinutes(value === "minutes" ? 10 : null)}>
              <SelectItem value="requests">Requests</SelectItem><SelectItem value="minutes">Minutes</SelectItem>
            </Select></Field>
            {roundMinutes === null ? <NumberField label="Requests per search batch" value={batchSize} min={1} max={500} integer
              info={<InfoTip topic="requests per search batch">A batch is this many new requests to data providers. Find trips runs up to 10 batches on its own; then Search more runs the next batch. Saved results are reused.</InfoTip>}
              onChange={n => { if (n !== null) onBatchSize(n); }} /> :
              <NumberField label="Minutes per round" value={roundMinutes} min={1} max={1440} integer
                hint="Includes provider waiting, optimization and saving. Pausing can take a little longer while the current operation finishes."
                onChange={n => { if (n !== null) onRoundMinutes(n); }} />}
          </div>
        </SettingsGroup>
      </div>
    </details>

    <div className="p-settings-footer">
      {footer.text && <p id={reasonId} className="p-footer-reason">{footer.text}</p>}
      <div className="p-footer-buttons">{footer.buttons.map(button => <span className="p-footer-button" key={button.label}>
        <Button type="button" variant={button.variant} disabled={footer.disabled || busyAction !== null} aria-describedby={footer.text ? reasonId : undefined}
          onClick={button.run === "save" ? onSaveOnly : onSearch}>
          {button.run === "search" && (busyAction === "search" ? <LoaderCircle size={15} className="p-spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />)}{button.label}
        </Button>
        {button.tip && <InfoTip topic={button.label} align="end">{button.tip}</InfoTip>}
      </span>)}</div>
    </div>
  </section>;
}

/** A More settings group (G): a title, a dot when it differs from the defaults, and its summary line. */
function SettingsGroup({ title, summary, children }: { title: string; summary: SettingsSummary; children: ReactNode }) {
  return <details className="p-group">
    <summary>
      <span className="p-group-title">{title}{summary.changes.length > 0 && <><span className="p-dot" aria-hidden="true" /><span className="sr-only"> (changed)</span></>}</span>
      <span className="p-group-summary">{summary.summary}</span>
      <ChevronDown size={16} className="p-chevron" aria-hidden="true" />
    </summary>
    <div className="p-group-body">{children}</div>
  </details>;
}

const bufferFields: [Exclude<keyof TripSpec["timing"], "airport_transfer_fallback_minutes">, string, number][] = [
  ["connection_minutes", "Minimum change time (min)", 360],
  ["flight_before_minutes", "At the airport before a flight (min)", 360],
  ["flight_after_minutes", "After landing (min)", 360],
  ["transit_before_minutes", "At the station before a train or bus (min)", 120],
  ["transit_after_minutes", "After a train or bus (min)", 120],
];

/** More settings › Fixed appointments: times in the city's own time zone. */
function Appointments({ draft, edit }: { draft: TripDraft; edit: (value: TripDraft) => void }) {
  const [form, setForm] = useState({ place_id: "", start: "", end: "" });
  const [error, setError] = useState("");
  const cities = draft.visits.map(visit => visit.place);
  const city = cities.find(place => place.id === form.place_id);
  function add() {
    try {
      if (!city || !form.start || !form.end) throw new Error("Choose a city and both times.");
      const start = localInputToISO(form.start, city.timezone), end = localInputToISO(form.end, city.timezone);
      if (start >= end) throw new Error("The end must be after the start.");
      edit({ ...draft, commitments: [...draft.commitments, { place_id: city.id, start, end }] });
      setForm({ place_id: "", start: "", end: "" }); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "This appointment can't be added."); }
  }
  return <>
    {draft.commitments.length > 0 && <ul className="p-item-rows">{draft.commitments.map((item, i) => {
      const place = cities.find(p => p.id === item.place_id);
      const zone = place?.timezone ?? "UTC", name = place?.name ?? item.place_id;
      const sameDay = formatLocal(item.start, zone, "date") === formatLocal(item.end, zone, "date");
      const text = `${name} · ${formatLocal(item.start, zone)} – ${formatLocal(item.end, zone, sameDay ? "time" : "datetime")} (${name} time)`;
      return <li key={`${item.place_id}:${item.start}`}><span>{text}</span>
        <button type="button" className="p-text-button" aria-label={`Remove appointment: ${text}`} onClick={() => edit({ ...draft, commitments: draft.commitments.filter((_, j) => j !== i) })}>Remove</button>
      </li>;
    })}</ul>}
    <div className="p-group-fields">
      <Field label="City"><Select value={form.place_id} onValueChange={value => setForm(f => ({ ...f, place_id: value }))}>
        <SelectItem value="">Choose a city</SelectItem>{cities.map(place => <SelectItem value={place.id} key={place.id}>{place.name}</SelectItem>)}
      </Select></Field>
      <Field label={`Starts (${city?.name ?? "city"} time)`}><TemporalInput type="datetime-local" value={form.start} onValueChange={value => setForm(f => ({ ...f, start: value }))} /></Field>
      <Field label="Ends"><TemporalInput type="datetime-local" value={form.end} min={form.start || undefined} onValueChange={value => setForm(f => ({ ...f, end: value }))} /></Field>
    </div>
    <div className="p-form-actions">
      <Button type="button" size="sm" variant="secondary" disabled={!cities.length} onClick={add}>Add appointment</Button>
      {!cities.length ? <p className="p-hint">Add a city to visit first.</p> : error && <p className="p-field-error" role="alert">{error}</p>}
    </div>
  </>;
}

/** More settings › Cars. The fields of a toggle show only while it is on; their values are kept. */
function Cars({ draft, edit, places }: { draft: TripDraft; edit: (value: TripDraft) => void; places: Place[] }) {
  const car = draft.cars;
  const set = <K extends keyof TripSpec["cars"]>(key: K, value: TripSpec["cars"][K]) => edit({ ...draft, cars: { ...car, [key]: value } });
  return <>
    <label className="p-check"><input type="checkbox" checked={car.own_enabled} onChange={e => set("own_enabled", e.target.checked)} />Use my car (it starts and ends at home)</label>
    {car.own_enabled && <div className="p-group-fields">
      <NumberField label="Seats" value={car.own_capacity} min={1} max={9} integer onChange={n => { if (n !== null) set("own_capacity", n); }} />
      <NumberField label="Cost per km (MYR)" value={car.own_cost_per_km} onChange={n => { if (n !== null) set("own_cost_per_km", n); }} />
    </div>}
    <label className="p-check"><input type="checkbox" checked={car.rental_enabled} onChange={e => set("rental_enabled", e.target.checked)} />Allow rental cars</label>
    {car.rental_enabled && <>
      <div className="p-group-fields">
        <NumberField label="Seats per car" value={car.rental_capacity} min={1} max={9} integer onChange={n => { if (n !== null) set("rental_capacity", n); }} />
        <NumberField label="Price per day (MYR, optional)" value={car.rental_daily_myr} optional onChange={n => set("rental_daily_myr", n)} />
        <NumberField label="Pickup fee per car (MYR)" value={car.rental_pickup_myr} onChange={n => { if (n !== null) set("rental_pickup_myr", n); }} />
        <NumberField label="One-way fee per car (MYR, optional)" value={car.rental_one_way_myr} optional onChange={n => set("rental_one_way_myr", n)} />
        <NumberField label="Driving cost per km per car (MYR, optional)" value={car.rental_cost_per_km} optional onChange={n => set("rental_cost_per_km", n)} />
      </div>
      <div className="p-group-columns">{(["rental_pickups", "rental_dropoffs"] as const).map(key => <fieldset key={key} className="p-place-checks">
        <legend>{key === "rental_pickups" ? "Pick up at" : "Drop off at"}</legend>
        {places.map(place => <label key={place.id} className="p-check"><input type="checkbox" checked={car[key].includes(place.id)}
          onChange={e => set(key, e.target.checked ? [...car[key], place.id] : car[key].filter(id => id !== place.id))} />{place.name}</label>)}
      </fieldset>)}</div>
    </>}
    {(car.own_enabled || car.rental_enabled) && !draft.modes.includes("car") && <p className="p-notice">Turn on Car in Transport to use cars.</p>}
  </>;
}

/** More settings › Prices and currencies › Exchange rates. MYR is always 1 and can't be removed. */
function ExchangeRates({ draft, edit }: { draft: TripDraft; edit: (value: TripDraft) => void }) {
  const [form, setForm] = useState({ currency: "", rate: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const rates = draft.exchange_rates;
  function add() {
    const rate = Number(form.rate);
    const problem = !/^[A-Z]{3}$/.test(form.currency) ? "Enter a 3-letter currency code."
      : form.currency === "MYR" ? "MYR is always 1."
      : form.rate.trim() === "" || !Number.isFinite(rate) || rate <= 0 ? "Enter a rate above 0." : "";
    setError(problem); setStatus("");
    if (problem) return;
    edit({ ...draft, exchange_rates: { ...rates, [form.currency]: rate } });
    setStatus(rates[form.currency] !== undefined ? "Rate updated." : "");
    setForm({ currency: "", rate: "" });
  }
  return <>
    <h3 className="p-group-heading">Exchange rates (MYR for 1 unit)</h3>
    <div className="p-chips">{Object.entries(rates).map(([currency, rate]) => <span className="p-tag" key={currency}>{currency} {rate}
      {currency !== "MYR" && <button type="button" aria-label={`Remove ${currency} exchange rate`} onClick={() => edit({ ...draft, exchange_rates: Object.fromEntries(Object.entries(rates).filter(([code]) => code !== currency)) })}>×</button>}
    </span>)}</div>
    <div className="p-group-fields">
      <Field label="Currency"><input maxLength={3} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></Field>
      <Field label="MYR for 1 unit"><input inputMode="decimal" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} /></Field>
    </div>
    <div className="p-form-actions">
      <Button type="button" size="sm" variant="secondary" onClick={add}>Add rate</Button>
      {error && <p className="p-field-error" role="alert">{error}</p>}
      <p className="p-field-status" aria-live="polite">{status}</p>
    </div>
  </>;
}
