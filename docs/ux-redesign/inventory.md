# Wayfinder Routes: inventory of user-facing capabilities in the live frontend (contract for the redesign)

> Capability inventory of the live frontend as of 31 October 2026. It is the must-not-lose list for the redesign; spec section H maps every id.

**Scope.** The live app is `main.tsx` → `ThemeProvider` → `Planner.tsx`, plus every file it imports:
- `components/PlannerForms.tsx` (Field, NumberField, PlacePicker, PlaceChips, FareEditor, RulesEditor, AdvancedSettings)
- `components/PositioningSettings.tsx`, `AirportTransferTable.tsx`, `MissingFaresTable.tsx`
- `components/ParetoExplorer.tsx` and `PlannerMap.tsx` (both lazy-loaded)
- `components/theme-provider.tsx`, `components/ui/button.tsx`
- `lib/planner.ts`, `lib/missingFares.ts`, `lib/chartView.ts`, `lib/sharedResults.ts`

`lib/utils.ts` is used only for `cn()` in Button. The legacy files (`App.tsx`, `RouteMap.tsx`, `lib/types.ts`) are ignored.

**Method.** I read the code only. I did not use a browser, run a build or run tests. I checked the frontend against the fixed backend files `backend/app/planner_api.py`, `planner_models.py`, `planner_discovery.py`, `planner_optimizer.py`, `planner_results.py`, `planner_store.py` and `main.py`.

---

## 0. Conventions used in this document

**Tier**
- `core`: a first-time user needs it to plan a trip and pick an itinerary.
- `refine`: it makes results more accurate (fares, connections, transfers).
- `power`: fine-tuning and expert control.

**API paths** are relative to `/api/v2` unless written as `/api/...`. The `api()` wrapper in `lib/planner.ts`:
- adds `?compact=true` to every `GET /trips/{id}`;
- adds `"compact": true` to every `POST /trips/{id}/optimize` body;
- turns FastAPI `detail` into an `Error`. A string is used as is. A list has its `msg` values joined with " · ". If there is no detail, the message is "Request failed ({status})".
- expands `_shared_route_data` v1 results, both at the top level and in `.result`.

**[saveSpec]** is the `saveSpec()` chain:
1. Wait for any save that is in flight.
2. Validate. The messages are "Choose a home/base and at least one required destination." and "Select at least one mode."
3. If the trip is saved and nothing is dirty, send nothing.
4. Otherwise send `POST /trips` (first save, which creates the trip) or `PUT /trips/{id} {spec, expected_revision}`.
5. If no edit happened during the request, send `POST /trips/{id}/optimize`.
6. Send `GET /trips` to refresh the list.

**[saveSpec]+** means the action runs [saveSpec] first and then its own request. Such an action can therefore create a new trip.

**[reload]** means `GET /trips/{id}`, then `accept(record)`, then `acceptResult()` with the `Result` that the action's own request returned.

**spec / autosave.** The field is part of `TripDraft`. `edit()` marks the draft dirty and sets the status to "Unsaved changes". Autosave runs [saveSpec] 650 ms after the last edit, but only when the trip is already saved and has a home city and at least one required city. A new trip is saved only by an action that calls saveSpec.

**DK** means the field is part of the server discovery key (`TripSpec.discovery_key()`). The key covers: home, departures, arrivals, required-city places, start and end dates, adults, modes, departure window, rail fallback (when enabled), home time limits and positioning policies. When a DK field changes:
- the result gets `discovery_required` and the stale notice appears;
- a running job becomes `superseded`;
- continuing the old job returns 409, so the user must click **Discover transport** again.

Spec fields that are not DK only need recalculation, and autosave does that.

**Global error** is the banner at the top of the page. **Inline error** is red text next to the control.

---

## 1. Global chrome and trip management

| ID | Tier | What the user sees / does (exact labels) | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `hdr-brand` | core | "Wayfinder **Routes**", caption "Trip planning workspace", Compass icon | Always, after loading | — | — | — |
| `hdr-theme` | power (preference) | Button group "Appearance" with 3 icon buttons. Title/aria: "Light theme", "Dark theme", "System theme" (Sun/Moon/Monitor icons), with `aria-pressed` | Always | — | — | `localStorage` `wayfinder:theme` = `light`/`dark`/`system`. A pre-paint script in `index.html` sets `.dark` before React starts. System mode follows OS changes. Updates `meta[name=theme-color]` to #fafafa or #09090b |
| `hdr-trip-select` | core | `<select>` with sr-only label "Saved trip". Placeholder option "Saved trips". Options read "{name} · {start_date}" | Always | Choosing the placeholder does nothing | `openTrip` (see §17) | `localStorage` `wayfinder:last-trip` is written on every accepted record |
| `hdr-duplicate` | power | Button "New from existing" (Copy icon), title "Copy the selected trip settings into a new trip" | Always. Disabled while busy or when no trip is saved | If the draft is dirty it must have home + ≥1 city ("Finish the current trip setup before copying it."). A saved trip is required ("Choose a saved trip to copy."). Errors go to the global error | Waits for the pending save; [saveSpec] if dirty; `POST /trips/{id}/duplicate`; `GET /trips` | Server copies the spec (name + " (copy)", max 120 chars), airport connections and airport-transfer estimates. It does not copy fares, schedules or results. Status: "Copied trip settings · ready to edit" |
| `hdr-new` | core | Button "New" (Plus icon) | Always. Disabled while busy | — | Waits for the pending save; [saveSpec] if dirty and valid; then a local reset with no request | Resets to `blankTrip()`: "My trip", today+30 to today+38, fixed dates, 1 adult, flight/rail/bus/coach, overnight on, 09:00–17:00, default timing and cars, FX `{MYR:1}`. Clears saved trip, result and job. Removes `wayfinder:last-trip`. Status: "New trip" |
| `nav-skip` | core (a11y) | Link "Skip to trip setup" → `#setup-title`, visible on focus | Always. It is placed after the header controls | — | — | — |
| `nav-workspace` | core | Nav "Workspace sections": "Trip setup" (#setup-title), "Pricing rules" (#pricing), then "Alternatives" (#frontier-title) and "Itinerary" (#details-title) | The last two only when a result exists | — | — | — |
| `intro` | core (orientation only) | h1 "Trip planner"; text "Compare transport costs and time in each city. Build a trip that fits your budget."; label "Multi-city · Round trip" (hidden below 850 px) | Always | — | — | — |
| `error-alert` | core | Banner (`role="alert"`) with the message and a "×" button ("Dismiss error") | When `error` is set | Cleared by every `edit()`, by the start of every `act()`, and by dismiss | — | Memory |
| `save-status` | core | Pill in the setup heading (`aria-live="polite"`). The values are listed in §19 | Always | — | — | Memory |
| `loading-app` | core | The whole page is replaced by "Loading your saved trip…" (`role="status"`, `aria-busy`) | During the first load and during `openTrip` / `duplicateTrip` | — | — | — |
| `loading-lazy` | core | "Loading the frontier chart…" and "Loading the itinerary map…" | While the lazy chunks load | — | — | — |

---

## 2. Trip setup basics (panel "01 Your trip")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `setup-name` | core | "Trip name" (text) | Always | maxLength 120. Server: 1–120 | Autosave | spec |
| `setup-start` | core | "Start date" (date) | Always | Server: end ≥ start, span ≤ 365 days ("Choose an increasing date range of at most 365 days.") | Autosave | spec, DK |
| `setup-end` | core | "End date" (date, `min` = start date) | Always | `min` is only an HTML hint. Same server rule as above | Autosave | spec, DK |
| `setup-date-mode` | core (has a default) | "Date mode": "Fixed outward and return dates" (default) or "Optimize within this date window". The hint below changes: fixed → "Leave home on the start date and arrive back on the end date, including positioning journeys."; flexible → "The optimizer can choose outward and return days anywhere inside this window." | Always | — | Autosave | spec (not DK) |

---

## 3. Places and the place picker

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `place-home` | core | PlacePicker "Home / base city" and one chip with "×" ("Remove {name}") | Always | Choosing a home replaces the old one and removes that place from the required cities. Removing the chip sets home to null, which disables Save and Discover | Search: `GET /places` | spec, DK |
| `place-departures` | power | PlacePicker "Possible departure cities ({n}/3)", chips with "×", small text "Leave empty to use home." | Always | Max 3; a 4th choice is ignored without a message. Already-chosen places are excluded. Server: unique, max 3 | `GET /places` | spec, DK |
| `place-arrivals` | power | "Possible arrival cities ({n}/3)", chips, "Leave empty to return directly to home." | Always | Same as departures | `GET /places` | spec, DK |
| `place-search` | core | Combobox with placeholder "City name or airport code". Needs ≥2 characters; 220 ms debounce. Each option shows "{name}" and "{country_code} · {airport codes or 'No airport required'}". Keys: ↑/↓, Enter selects, Esc closes. Status "Searching the local city catalog…". Inline error | In each of the 4 pickers (home, departures, arrivals, required cities) | Excluded IDs are filtered out. Server: 2–80 characters, ≤16 results | `GET /places?search={q}` | Memory. The query is cleared after a choice |
| `place-custom` | power | Text button "Add a place by coordinates" / "Close custom place". Fields "Custom place name", "Custom place latitude", "Custom place longitude", "Custom place timezone" (default = browser timezone), "Custom place airports" (comma-separated). Button "Use this place" | Inside each picker, when toggled open | Name is required; latitude −90..90; longitude −180..180; timezone must be a valid IANA zone (checked with `Intl`). Messages: "Enter a name, valid coordinates, and an IANA timezone." and "Airport codes must contain three letters." (inline) | None (the place is stored inside the spec) | The id is `custom:{uuid}`, `country_code` is "", `flight_code` is the first airport code |

---

## 4. Required cities and minimum stays

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `visit-add` | core | PlacePicker "Required cities ({n}/4) · visit order is flexible" | Always | Max 4; a 5th choice is ignored without a message. Home and existing required cities are excluded | `GET /places` | spec, DK (the places only) |
| `visit-card` | core | Card: city name, timezone in small text, number field "Minimum stay in {city} · hours", "×" ("Remove required city {city}") | One per required city | min 0; a blank field becomes 0. Server: ≤ 8760 | Autosave | spec (minimum stay is not DK). Removing a city also removes its commitments |
| `visit-apply-first` | power | Text button "Apply the first city's minimum to all cities" | ≥2 required cities | Uses the city that was added first | Autosave | spec |

---

## 5. Travellers, budget, transfers and departure window

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `setup-adults` | core | "Adult travelers" | Always | HTML 1–9, step 1. A blank field becomes 0, which the server rejects (see §21). Server: 1–9 | Autosave | spec, DK |
| `setup-budget` | core | "Total party budget · MYR", placeholder "Unknown / not set" | Always | ≥0. Blank means no budget | Autosave | spec (not DK). It sets each route's `budget_status` and decides which routes become refinement-only |
| `setup-max-transfers` | power | "Maximum transfers per intercity journey", placeholder "Unknown / not set" | Always | 0–10, step 1. Blank means unlimited | Autosave | spec (not DK) |
| `setup-window` | power (default with large effect: 09:00–17:00) | "Local departure window starts" and "Local departure window ends" (time inputs) | Always | Server: end must be after start ("The local departure window must end after it starts.") | Autosave | spec, DK |

---

## 6. Modes, overnight travel, rail fallback, unpriced flights, transit notice

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `setup-modes` | core (has a default) | Fieldset "Allowed intercity transportation" with checkboxes flight, rail, bus, coach, subway, tram, car, taxi. The text is lowercase; CSS capitalizes it only in this fieldset. Default: flight, rail, bus, coach | Always | ≥1 mode is required at save | Autosave | spec, DK |
| `setup-overnight` | power | Checkbox "Allow overnight travel" (inside the modes fieldset), default on | Always | — | Autosave | spec |
| `setup-rail-fallback` | power | Checkbox "Allow estimated rail timetables when actual-date searches find no journey" | Always | Turning it on sets the defaults: `reference_date` null, 180 days, 25 km | Autosave | spec, DK when enabled |
| `setup-rail-ref` | power | "Reference week starting · blank uses today" (date) | Fallback is on | Blank → null | Autosave | spec, DK |
| `setup-rail-shift` | power | "Maximum timetable shift · days" | Fallback is on | HTML and server: 7–365. A blank field becomes 0 and the server rejects it | Autosave | spec, DK |
| `setup-rail-radius` | power | "Station search radius · km" | Fallback is on | HTML and server: 1–50. A blank field becomes 0 and the server rejects it | Autosave | spec, DK |
| `setup-exclude-unpriced` | power | Checkbox "Ignore flights with unknown fares" | Always | — | Autosave | spec (not DK) |
| `setup-transit-off` | core (abnormal state) | Notice "Scheduled transit is currently disabled. Configure the Transitous contact URL and coordinate routing use to enable it." | `GET /api/data` returned `transit_routing_configured: false` **and** rail, bus, coach, subway or tram is enabled | — | `GET /api/data` (only at startup) | — |

Fixed text in this area:
- Rail fallback hint, shown when the fallback is on: "Search nearby stations, then sample up to three matching weekdays for trips more than two weeks away. Copied timetables are estimates; holidays, fares and seat availability need verification. Station access uses walking times. Start a new discovery after changing these settings."
- Unpriced-flights hint, always shown: "Excludes itineraries with unpriced flights after applying ticket bundles, manual fares, and pricing rules. Saved flight schedules are retained; other transport and transfer fares may still be unknown."

---

## 7. Positioning (collapsible section "Home time limits and positioning services · optional")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `pos-home-earliest` | power | "Earliest departure from home · {start_date}" (time). Hint: the home timezone, or "Choose home first" | Section open | Blank → null | Autosave | spec, DK |
| `pos-home-latest` | power | "Latest arrival home · {end_date}" (time). Same hint | Section open | Server: if start date = end date and both are set, the latest arrival must follow the earliest departure | Autosave | spec, DK |
| `pos-gateway` | power | One nested collapsible per non-home gateway and direction: "Outbound: {home} → {departure city}" and "Return: {arrival city} → {home}" | Home is set and the gateway is not home. Otherwise the text "Choose home and candidate gateways to configure positioning." | — | — | — |
| `pos-policy` | power | For each of the 8 modes, a select "{mode} options" with "Search + supplied services" (default), "Supplied services only", "Unavailable". Hint "Also disabled by the trip's allowed modes." when the mode is off for the trip | In each gateway section | Server: ≤48 policies, unique per direction + gateway + mode | Autosave | spec `positioning_policies`, DK |
| `pos-supplied-empty` | power | Notice "A mode set to supplied services only has no entered services yet. It contributes no options until you add one." | A mode set to "Supplied services only" that is allowed for the trip has no services | — | — | — |
| `pos-service-list` | power | Row: "**{label}** · {mode}", then "{departure in origin tz} → {arrival in destination tz} · {fare or 'Unknown'} for the party", plus " · disabled" when the mode is off or unavailable, and "×" ("Remove {label}") | One per supplied service | To change a service, remove it and add it again | Autosave | spec `positioning_services` (not DK) |
| `pos-service-add` | power | "Service mode" (default rail), "Service name (optional)" (max 160), "Departs · {origin tz}" and "Arrives · {destination tz}" (datetime-local, read in those city timezones), "Total party fare (optional)" (placeholder "Unknown"), "Fare currency" (default MYR, uppercased). Button "Add supplied service" | In each gateway section | Messages (global error): "Enter both departure and arrival dates and times." · "Arrival must follow departure." · "Enter a non-negative party fare or leave it blank." · "Enter a three-letter currency code." · "Enable this mode under Allowed intercity transportation first." · "This mode is unavailable for this direction. Change its setting before adding a service." · DST: "This local time does not exist because of a timezone clock change." Server: ≤120 services. A successful add clears the global error | Autosave | spec. The default label is "{mode} {origin} → {destination}" |
| `pos-auto-prune` | (behaviour) | `edit()` removes policies and services whose gateway is no longer in that direction's list, or is home. Changing home removes **all** supplied services | — | — | — | — |

Fixed text in this area:
- "Blank uses the full boundary day. These limits also apply with flexible dates. Supplied schedules and fares are saved with this trip. Search settings are independent for each gateway, direction, and mode; existing provider options are excluded when a mode is unavailable or supplied only."
- "Enter city-to-city times, including station access if needed. Onward airport access and flight readiness buffers remain separate. Supplied services use their entered times even outside the automatic search departure window. Remove and re-add a service to change it."

---

## 8. Advanced settings (collapsible section "Timing, commitments, driving, and currencies")

Intro text: "Buffers and airport transfer assumptions are included in the trip timeline. The fallback is used only when airport road routing is unavailable; it does not create intercity roads. Overnight travel means crossing midnight in the departure timezone."

| ID | Tier | What the user sees / does (default) | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `adv-connection` | power | "Minimum connection · minutes" (30) | Section open | min 0; blank → 0. Server 0–360 | Autosave | spec |
| `adv-flight-before` | power | "Before flight · minutes" (90) | Section open | Server 0–360 | Autosave | spec |
| `adv-flight-after` | power | "After flight · minutes" (30) | Section open | Server 0–360 | Autosave | spec |
| `adv-transit-before` | power | "Before train/bus · minutes" (15) | Section open | Server 0–120 | Autosave | spec |
| `adv-transit-after` | power | "After train/bus · minutes" (10) | Section open | Server 0–120 | Autosave | spec |
| `adv-airport-fallback` | refine | "Fallback airport transfer per side · minutes" (45). Optional, placeholder "Unknown / not set". Blank = null: when road routing is unavailable, airport access stays unresolved and those journeys cannot be used | Section open | Server 0–600 | Autosave | spec |
| `adv-commitments` | power | h3 "Fixed commitments · city local time". List rows "{city} · {start} – {end}" (en-MY format, city timezone) with "×" ("Remove commitment"). Add form: "Commitment city" (placeholder "Choose a required city"; options "{city} · {tz}"), "Commitment starts", "Commitment ends" (datetime-local, read in the city timezone), button "Add commitment" | Section open | "Choose a required city and both commitment times." · "Commitment end must follow its start." · DST message (global error). Server: the city must be a required city | Autosave | spec |
| `adv-own-car` | power | h3 "Car availability and rental assumptions". Checkbox "Own car starts and finishes at home"; "Own car seats" (4, 1–9); "Own car MYR/km · estimate" (0.27) | Section open (the fields show even when the checkbox is off) | A blank seats field becomes 0, which the server rejects (≥1) | Autosave | spec |
| `adv-rental` | power | Checkbox "Allow declared rental availability"; "Rental seats per car" (4); "Rental MYR/day" (optional); "Rental pickup MYR/car" (0); "Rental one-way drop-off MYR/car" (optional); "Rental driving MYR/km/car" (optional) | Section open | Values ≥0 | Autosave | spec |
| `adv-rental-locations` | power | Fieldsets "Assumed pickup locations" and "Allowed drop-off locations", with one checkbox per trip place | Rental is enabled | — | Autosave | spec |
| `adv-fx` | refine | h3 "Saved exchange rates · MYR per currency unit". Tags "{CUR}: {rate}" with "×" ("Remove {CUR} exchange rate"); MYR cannot be removed. Add: "Foreign currency" (3 characters, uppercased), "MYR per currency unit" (min 0.000001), button "Save exchange rate" | Section open | Needs 3 characters and a rate > 0; otherwise nothing happens and no message is shown. Server: 3 letters, positive; MYR is forced to 1 | Autosave | spec (per trip). Missing-fare groups with reason `exchange_rate` refer the user here |

Not shown in the UI: `cars.taxi_capacity` keeps its default of 4 or its saved value.

---

## 9. Primary action bar (bottom of panel 01)

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `act-batch-budget` | power | Number field "Provider requests per batch" (default 100). In code the state is named `budget`, which is easy to confuse with the money budget | Always | HTML 1–500, step 1; blank → 100. Server 1–500 (422 if outside) | Sent as `{budget}` when discovery starts or continues | Memory only. Resets on reload; shared across trips |
| `act-save-recalc` | power | Button "Save & recalculate" (Save icon) | Always. Disabled while busy, with no home, or with no required city | saveSpec validation | [saveSpec] (creates the trip if it is new). If nothing was dirty, it also sends `POST /trips/{id}/optimize` | — |
| `act-discover` | core | Button "Discover transport" (Play icon; shows a spinner during **any** busy action) | Always. Disabled while busy, while a job is active, with no home, or with no required city | saveSpec validation. Server 409: "This trip already has an active discovery job." or "An in-flight request is finishing. Continue after it stops." | [saveSpec]+ `POST /trips/{id}/searches {budget}`, then polling starts | Always starts a **new** job with a new queue; the provider caches are reused |

---

## 10. Airport ↔ city transfers table (panel without a step number)

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `xfer-panel` | refine | h2 "Airport ↔ city transfers", tag "{rows} directions · {adults} travelers", paragraph (see below) | The trip is saved and `airport_transfer_rows` is not empty. The server builds the rows from every configured airport (city airport codes plus metro airports) in **both directions**, plus airports seen in retrieved access/egress charges. So the table appears **before discovery** (14 rows in the demo trip) | — | — | — |
| `xfer-row` | refine | Columns "Transfer" (for example "Kuala Lumpur → KUL airport" / "KUL airport → Kuala Lumpur"), "Method" (select: rail, bus, coach, subway, tram, car, taxi), "Time · min" (placeholder "Existing timing" for taxi, otherwise "Required"), "Party fare" (placeholder "Unknown"), "Maximum (optional)", "Currency" (default MYR), "×" ("Remove {row} {mode}") | Each direction starts with one blank taxi row, or with its saved estimates | — | — | Draft rows are kept in component memory until saved (reset when another trip opens) |
| `xfer-add-method` | refine | Button "Add method" in the first row of each direction; it adds the next unused non-flight mode. If all rows of a direction are removed, a row with only "Add method" remains | — | Max 7 methods per direction (the button is disabled at 7) | — | Memory |
| `xfer-save` | refine | Button "Save transfer options" / "Saving…" | Always in the panel | Global errors: "Use each transfer method once per direction." · "Enter a nonnegative fare and a maximum at least as large as its minimum." (a maximum without a minimum also fails) · "Enter a positive travel time for each alternative transfer method." (non-taxi methods need a time). A completely blank taxi row is left out, which means "no estimate". The currency is not checked in the browser; the server requires 3 letters. Server: ≤240 estimates | [saveSpec]+ `PUT /trips/{id}/airport-transfer-estimates {estimates, expected_revision}`. The server recalculates if a snapshot exists and returns the trip in GET shape with its result | Server, at trip level, keyed by direction + party size + mode. Estimates for other party sizes are kept. Copied by "New from existing". Status: "Airport transfer estimates saved". A fare entered here becomes a priority pricing rule, so it resolves unknown "Airport access"/"Airport egress" charges. A time entered here replaces the routed time |

Fixed text:
- "Add transfer methods with travel times and whole-party fares. The optimizer compares these options for current and future journeys in this trip. Each direction is separate; individual fare overrides take priority."
- "Blank fares remain unknown. Options persist with this trip and party size. The existing taxi option remains available unless replaced by a taxi row. Times are estimates, without service timetables."

---

## 11. Discovery job panel ("02 Transport discovery")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `job-panel` | core | Step "02", h2 "Transport discovery", and the raw status text: `queued`, `running`, `paused`, `cancelled`, `complete`, `interrupted`, `failed` or `superseded`. A spinner shows while queued or running. `aria-live="polite"` | A job is known: one just started, or the trip's `latest_job_id` when it was opened | — | `GET /searches/{id}` when a trip opens | The job id is stored on the trip on the server |
| `job-counters` | power | "{processed} queries processed · {requests} provider requests · {cache_hits} cache hits · {manual_quote_queries} manual quotes (no request) · {pending} pending". The manual-quote part shows only when it is above 0 | Same as the panel | — | Polled | — |
| `job-cancel` | core | Button "Cancel discovery" (Square icon) | Status is queued or running | — | `POST /searches/{id}/cancel` | Collected data is kept |
| `job-continue` | core | One button (RefreshCw icon) with one of three labels: "Continue searching" (pending > 0), "Retry failed searches" (failed_queries > 0), or "Continue optimizing" (`result.optimization_complete === false`) | The job is not active, the status is not `superseded`, and one of the three conditions is true. Disabled while busy | Server 409 "Start a new search after changing discovery inputs." if DK fields changed | [saveSpec]+ `POST /searches/{id}/continue {budget}`. The server also raises the optimizer label limit and, when the queue is used up, puts failed queries back in the queue | — |
| `job-hint` | — | "Collected data and fare edits are retained." | With the action buttons | — | — | — |
| `job-messages` | power | Collapsible "Provider status and coverage" with one paragraph per job message | `job.messages` is not empty | — | — | — |

---

## 12. Pricing panel (`#pricing`): always rendered, has no heading

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `conn-saved-list` | refine | h3 "Saved assumed connections". Rows "{from} → {to} · {mode} · {duration_minutes} min · {departure in origin tz, or 'Flexible departure'}" with button "Remove" | The trip is saved and `saved.assumed_connections` is not empty. This field comes only with GET-shaped trip records (see §21) | Disabled while busy | `act()`: `DELETE /trips/{id}/movements/{movementId}?expected_revision={rev}`, then [reload]. Status: "Assumed connection removed · frontier recalculated" | Server (snapshot movement) |
| `rules-editor` | refine (expert UI) | Collapsible "Reusable pricing rules" with "{n} saved" | Always (even for a trip that is not saved yet) | — | Rules are loaded at startup with `GET /pricing-rules` | Server, **global for all trips** |
| `rules-list` | refine | One row per rule: the name as a text button (loads the rule into the form for editing), "{mode} · {money(low, currency)}{'/km' for per-km} · {unit}", and "×" ("Delete rule {name}"), which deletes at once without confirmation | ≥1 rule | — | `DELETE /pricing-rules/{id}` → `GET /pricing-rules` → [reload] + `POST /trips/{id}/optimize` | Global |
| `rules-form` | refine | "Rule name"; "Rule mode" (*, flight, rail, bus, coach, subway, tram, car, taxi, rental); "Pricing method" ("Fixed / range", "Per kilometer"); "Rule minimum / fixed price"; "Rule maximum (blank = fixed)"; "Charging unit" ("Per person", "Whole party", "Per vehicle"); "Rule currency" (3 characters); "Rule priority"; "Seats per vehicle"; "Rule origin" and "Rule destination" (each has "Any place", the trip places, and terminals named "{CODE} airport"); "Service / operator (optional)"; "Origin country code (optional)" (2 characters, uppercased). Buttons "Save pricing rule" and "New rule" (ghost style) | Section open | The save button is disabled when there is no name. Minimum ≥0 (blank → 0). Priority min −1000. Seats 1–9 (blank → 0, which the server rejects). Server: name 1–120, maximum ≥ minimum, 3-letter currency. Errors go to the global error | `PUT /pricing-rules/{id}` → `GET /pricing-rules` → [reload] + `POST /trips/{id}/optimize`. The server raises the revision of every trip | Global |
| `conn-gaps` | refine | Live region: h3 "Missing city connections", a paragraph, and one button per gap "Add {A} → {B}". A button fills in from/to, opens the form below and scrolls to it | The trip is saved, a snapshot exists, and some pair of required cities has no movement in either direction (`city_connection_gaps`, also GET-shaped records only) | — | — | — |
| `conn-add` | refine | Collapsible "Add a connection missing from the providers" with a paragraph. Fields: "Assumed connection from" and "Assumed connection to" ("Choose place" plus the trip places), "Assumed mode" (8 modes, default bus), "Assumed duration · hours" (min 0.01), "Assumed distance · km (optional)", "Optional departure · browser local", "Optional arrival · browser local". Button "Add assumed connection" | The trip is saved | "Choose different endpoints and a positive duration." (global). Server: give both timestamps or neither, arrival after departure, both endpoints in the trip | [saveSpec]+ `POST /trips/{id}/movements` (id `assumed:{uuid}`; car → `vehicle_kind: rental`), then [reload] | Server: snapshot movement, also stored in the shared graph. No success message is shown and the form is not cleared |

Fixed text:
- Rules: "Rules estimate missing prices. Specific route/service matches win at equal priority. Values are in the chosen currency; vehicle prices use the stated seating capacity."
- Gaps: "No direct connection was collected in either direction for these cities. If your route needs one, enter a verified schedule or an assumed duration below. Connecting routes or enabled road transport may still provide alternatives."
- Add form: "This explicitly assumes that the connection exists. Flexible connections use the duration; scheduled connections need both timestamps (shown in your browser timezone)."

---

## 13. Result notices and refinement panels (all need a result)

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `res-stale` | core | Notice. If dirty: "Trip changes are being saved; displayed results belong to the previous revision." Otherwise: "Transport discovery is needed for these trip inputs. Saved fare edits remain available." | A result exists and (the draft is dirty or `result.discovery_required` is true) | — | — | — |
| `aconn-panel` | refine | Step "↔", h2 "Airport connections", tag "{pairs} unique pairs · {journeys} journeys", paragraph (see below) | A result exists, the trip is saved, and there is ≥1 required or saved pair. A pair is required when a retrieved flight journey changes airport between flights. The data comes from `saved.airport_connections_required`, or else `coverage.airport_connections_required` | — | — | — |
| `aconn-row` | refine | Columns "Airport change" ("{FROM} → {TO}" plus "{from name} → {to name}", with " · saved" for saved pairs that are not required), "Journeys" ("{n}" and "{m} unresolved", warning colour when above 0; "—" for saved-only rows), "Mode" ("Choose mode" plus the 7 non-flight modes), "Transfer time · min" (min 1), "Party fare" ("Unknown"), "Currency", and "×". On a required row "×" means "Clear {A} to {B}" (clears the row); on a saved-only row it means "Remove saved {A} to {B}" (deletes the row) | One row per pair | — | — | Memory until saved |
| `aconn-save` | refine | Button "Save connections" / "Saving…" | Always in the panel | Global errors: "Complete the mode and positive transfer time, or clear that row before saving." · "Enter a nonnegative party fare or leave it blank." · "Use a three-letter currency code for each fare." Server: ≤120 pairs, each directed pair once, two different airports | `PUT /trips/{id}/airport-connections {connections}`. There is **no** saveSpec before it and **no** `expected_revision`. Then [reload]. Status: "Airport connections saved · frontier recalculated" | Server (`airport_connections` on the trip; copied by "New from existing") |
| `unresolved-access` | refine | Collapsible panel "{n} retrieved journeys need airport access timing", with rows "{from} → {to}: {assumptions joined by ' · '}" | `coverage.unresolved_movements` still has assumptions after the "Airport change …" and "Airport connection …" assumptions are removed. A typical cause: the fallback minutes are blank and road routing is unavailable | There is no action in this panel. The fixes are `adv-airport-fallback` or a time in `xfer-row` | — | — |

Fixed text:
- Airport connections: "Enter a connection you have checked for each airport change. Its duration should include your transfer buffer and must fit the scheduled layover. One directed pair applies to every matching journey in this trip; the reverse direction is a separate row."
- Airport connections hint: "Rows without both a mode and positive duration remain unresolved. Blank fare keeps transfer cost unknown."

---

## 14. Missing fares table ("03")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `fares-panel` | refine | Step "03", h2 "Refine important missing fares" (or "Applied shared estimates" when no group is missing), tag "{g} missing groups · {c} components · {a} applied groups", paragraph shown when groups exist | A result exists and there are missing groups or applied shared groups | — | — | — |
| `fares-grouping` | refine (behaviour) | One row per group. The group key is `[from, to, label, mode, currency, reason]`. Charges use their own endpoints (for example city → airport), not the flight endpoints. Groups are sorted by the number of affected itineraries, highest first; that number counts distinct routes across frontier, dominated and refinement routes. Fares whose label starts with "Airport transfer " are excluded (the Airport connections panel handles them) | — | — | — | — |
| `fares-row` | refine | Columns: "Transfer / journey" ("{from} → {to}" and the toggle "Show/Hide {n} component(s)"); "Type" (the label, such as flight, Airport access, Airport egress or Rental…, with the mode in small text); "Alternatives" (the count); "Party fare / range" (input with placeholder "Unknown", or "Minimum" when Range is on; "–" and a maximum input with placeholder "Unbounded" when Range is on; checkbox "Range"; for reason `exchange_rate` the note "Add a {CUR} exchange rate, or enter a converted fare."); "Currency" (filled with the fare currency); "Save" (button "Save estimate", with "Saved for apply" or "Changes not saved") | 25 groups per page | Inline errors: "Enter a non-negative fare." · "Maximum must be at least the minimum." · "Enter a three-letter currency code." | **None**: this only stages a draft in the browser | `localStorage` `wayfinder:pending-estimates:{tripId}`. The draft label is "Shared estimate: {from} → {to} · {type}" (max 200 characters) |
| `fares-components` | refine | Expanded row: hint, then per component "Component {i} · Journey departs {date, time} (UTC) · {service} · {n} alternatives" and a FareEditor labelled "{from} → {to} · {type}" | The row is expanded | FareEditor rules (§16) | "Save fare" stages the draft `component:{id}` and sends no request. "Reset" on a staged draft removes it from staging. "Reset" on a fare that was already saved on the server sends `DELETE /trips/{id}/fares/{offerId}` at once, then [reload] | `localStorage` |
| `fares-apply` | refine | Button "Apply saved estimates ({n})" / "Applying estimates…". `n` counts staged **entries**, not components | Always in the panel. Disabled while busy or when nothing is staged | Only staged drafts whose components are still listed are sent | [saveSpec]+ `POST /trips/{id}/fares/estimates {estimates, expected_revision}`, then [reload]. Status: "Shared estimates saved · frontier recalculated". Errors are inline (for example 409 "This trip changed. Reload it before saving.") | On success the `localStorage` key and the drafts are removed. The tables are `inert` while the request runs |
| `fares-discard` | refine | Ghost button "Discard saved estimates" | ≥1 staged draft | — | — | `localStorage` is set to `{}` |
| `fares-applied` | refine | h3 "Applied shared estimates" with a hint. Columns: "Transfer / journey" (the label without "Shared estimate: ", plus "{n} components in this group", plus "Current values differ; applying will set one value for all." when values differ); "Type" ("Applied shared estimate"); "Party fare / range" (placeholder "Mixed" when amounts differ); "Currency" ("Mixed"); "Save" ("Save estimate" and "Saved for apply") | User offers labelled "Shared estimate:…" with one component, a known component id and a minimum | Same as `fares-row` | Stages only | `localStorage` |
| `fares-pagination` | refine | "Previous groups" · "Page {x} / {y}" · "Next groups" | More than 25 missing groups | — | — | Memory |

Fixed text:
- "Enter a party fare per transfer or journey and save each row. Saved estimates stay in this browser until you apply them together; saving a row does not rerun optimization."
- "Applies each amount per component and recalculates once."
- "Repeated journeys with the same endpoints, fare type, mode, currency, and missing-fare reason share one row, even across dates. Expand a row to inspect its components; estimates apply separately to every listed component. Future searches may add new unpriced components."
- "Individual fare saves are staged too. Use Apply saved estimates above to recalculate."
- "Each shared estimate appears once. If its components currently have different values, enter a fare and apply it to set the whole group to one value."
- Screen-reader captions: "Missing fares grouped by matching transfer; each amount is a party fare per component." and "Applied shared fares; each amount applies to every component in its group."

---

## 15. Frontier ("04 Your cost–time frontier")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `front-header` | core | Step "04", h2 "Your cost–time frontier", tag "{n} frontier alternatives" plus " + {m} dominated" | A result exists | — | — | — |
| `front-status` | power | "{Discovery queue exhausted / Preliminary discovery} · {Optimization complete for this snapshot / Optimization incomplete} · snapshot {rev}" | A result exists | — | — | — |
| `front-dominated` | power | Checkbox "Show dominated alternatives"; "Calculating…" while busy | A result exists. Disabled while busy | — | The first time it is turned on and no dominated data exists: [saveSpec]+ `POST /trips/{id}/optimize {include_dominated: true}`, then [reload]. It turns itself off again if that fails. Later toggles are local | Memory. It turns off by itself when a newer result arrives without dominated routes (for example after a fare save) |
| `chart` | core | ECharts scatter (lazy-loaded). X axis "Total party cost · MYR", Y axis "City-stay hours" (each adds " (log)" in log mode). Series: a dashed frontier line through routes with an exact price; points as circles (no estimates) or diamonds (includes estimates); bounded ranges as a horizontal band from low to high with a hollow circle at the midpoint; dominated routes as grey dots; the selected route in orange and larger. **Routes with an unknown upper cost are not plotted.** Tooltip: "{cost or range}<br>{h} city hours · {cost per city h}" plus "Includes estimates". Clicking a point selects that route. aria-label "Pareto frontier with {n} plotted alternatives: {linear/logarithmic} cost versus {linear/logarithmic} city-stay hours". Colours come from theme tokens and update when the theme changes | A result exists | — | — | — |
| `chart-empty-notice` | core | Notice "No complete fare totals or bounded fare ranges to plot. Resolve missing fares to show these alternatives here." | Nothing can be plotted (the usual state just after a search) | — | — | — |
| `chart-log-cost` | power | Checkbox "Log cost" (in the group "Chart scales") | Disabled unless every plotted cost is above 0 | — | — | Memory; resets when the results area unmounts |
| `chart-log-hours` | power | Checkbox "Log city hours" | Disabled unless every stay is above 0 hours | — | — | Memory |
| `chart-fit` | power | Checkbox "Fit axes to data" (on by default; off makes the cost axis start at 0) | Always with the chart | — | — | Memory |
| `chart-zoom` | power | Zoom on the X axis with mouse wheel or pinch, a slider under the chart, and the text button "Reset zoom" | Always with the chart | — | — | The view is kept when only the selection changes |
| `front-continue-opt` | core (abnormal state) | Button "Continue optimizing" | `optimization_complete` is false, there is **no job at all**, and the trip is saved | — | `POST /trips/{id}/optimize {expand: true}` | — |
| `front-order` | core | Select "Order frontier alternatives" (label becomes "Order displayed alternatives" when dominated routes show). Options: "Lowest known total" (default: exact totals first, then lowest minimum cost, then most hours), "Most city-stay hours", "Balanced · equal cost/time weights" (normalised cost + hours; unknown totals last). Small text "Ordering does not change frontier membership." | A result exists | — | — | Memory; kept when another trip opens |
| `front-empty` | core | "No feasible itinerary has been found in the collected data. " followed by "Continue discovery or add a missing connection." (when `job.pending > 0`) or "Check coverage, dates, minimum stays, and transport assumptions." | No routes are displayed | — | — | — |
| `front-refinement` | refine | Collapsible "Review an over-budget candidate to add a ticket quote", text "These are up to ten fare-refinement examples, outside your current budget. They are not plotted as feasible frontier options.", and buttons "{cost} · {h} city hours" that select that route | **Only** when no routes are displayed and refinement routes exist | — | — | — |
| `card` | core | Card button with `aria-pressed`. Shows: a number "01…" (position in the list across pages); the cost ("RM x", "RM x – RM y" or "RM x + unknown"); "{h} city hours · {h} h travel · {cost per city h}" (tooltip "Total party fare divided by city-stay hours"; the value is "RM x/city h", "RM a–RM b/city h", "Cost/city h unknown" or "Cost/city h unavailable"); "{departure gateway} outward · {arrival gateway} return"; the mode chain, for example "flight → rail → flight"; the warning "Estimated rail timetable" when it applies; one tag, chosen in this order: "Dominated", "Provisional" (warning style), "Includes estimates", "Priced"; and the warning "Budget compliance uncertain" when it applies | One per displayed route | — | — | The selection is kept in memory. With no selection, the first displayed route is used. Opening or copying a trip resets it |
| `card-pagination` | core | "Previous alternatives" · "Page {x} / {y}" · "Next alternatives" | More than 40 routes | The page is clamped when the list gets shorter | — | Memory |
| `compare` | core | Select "Compare selected itinerary with" (placeholder "Choose another alternative"; options "{cost} · {h} city hours"). Text: "Selected itinerary: **{Δh} additional city hours** for **{Δcost} additional cost** · {RM} per additional hour · resolve fare ranges to compare an exact additional cost." The cost part appears only when both totals are exact; the per-hour part only when Δh > 0; the last clause when either route is provisional | A route is selected and more than 1 route is displayed | — | — | Memory; reset when a trip opens or is copied |

Fixed text:
- "Circles: priced offers. Diamonds: estimates. Horizontal bands: fare ranges; their selection marker is the midpoint, not an expected price. Unknown totals stay in the list below. Optimality covers retrieved options and stated assumptions."
- "{feasible_count} completed histories evaluated. The frontier keeps cost/city-time tradeoffs under your fare and budget settings. Other histories are hidden by default; source schedules and fares remain saved."
- "Grey points are other completed alternatives from this search, usually below/right of the frontier. First loading them recalculates saved data without provider requests. Earlier pruning may have removed other histories."
- "Fitted axes highlight small differences and may not start at zero. Log scales compare proportional changes and require positive values."

---

## 16. Itinerary details ("05 Itinerary details")

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `det-header` | core | Step "05", h2 "Itinerary details", tag "Outside budget · fare refinement only" (when `budget_status` is `over`), and the cost (same format as the card) | A route is selected (by default the first one) | — | — | — |
| `det-map` | core | MapLibre map (lazy-loaded; OpenFreeMap "bright" style, loaded over the network). All trip places show as labelled dots. Each leg whose two endpoints are trip places shows as a straight dashed line, coloured by mode (flight / car or taxi / other). Zoom and rotate control, compact attribution, automatic fit to the places, dark mode through a CSS filter. Hint "City reference points and schematic connections; lines do not show road or track geometry." | A route is selected | — | External map tiles | — |
| `det-stays` | core | h3 "Time in each required city". For each stay: the city, "{h} h", "{arrival} → {departure}" in city time, and a progress bar (its share of total stay hours). Hint "City-stay hours include nights, exclude all transportation and terminal overhead, and do not count time at home or other positioning cities." | A route is selected | — | — | — |
| `leg` | core | One collapsible per movement (the first is open). Summary: "{i}", "{from} → {to}", tag "{mode} · {own/rental}", "{h} h". Body: "{departure} → {arrival}" (origin and destination time zones; "Flexible departure" when there is no schedule) and "{source} · {n} transfers · {km} km" | One per movement | — | — | — |
| `leg-assumptions` | core | One notice per assumption text, for example the fallback airport time or "Airport change … add a verified connection" | The movement has assumptions | — | — | — |
| `leg-estimated-timetable` | core | Notice "Estimated rail timetable · based on {date}" (or "· provider extended calendar") + ". Verify the actual travel date before booking." | `schedule_estimated` is true | — | — | — |
| `leg-segments` | power | List "{mode}: {from} → {to}" with "{dep} ({tz}) → {arr} ({tz}) · {service} {operator} · {source} · assumed · {n} min". The list includes the raw `transfer` and `wait` chronology rows | The movement has segments | — | — | — |
| `leg-fare` | refine | FareEditor "Standalone {mode} fare" | Each leg | FareEditor rules | [saveSpec]+ `PUT /trips/{id}/fares/user:{componentId}`, then [reload]. "Reset" sends `DELETE` to the same path, then [reload] | Server user offer. Status after save: "Fare saved · frontier recalculated" |
| `leg-charge-fare` | refine | One FareEditor per charge, labelled with its kind ("Airport access" or "Airport egress"). "Airport transfer …" charges are excluded (they are edited in Airport connections) | The leg has such charges | FareEditor rules | Same as `leg-fare` | Same |
| `leg-search-link` | core | Link "Open flight search ↗" (opens a new tab) | The movement has `search_url` | — | External Google Flights | — |
| `det-extra-fares` | refine | One FareEditor per route extra charge, for example "Rental: {n} day(s), pickup and drop-off". These editors have no heading | The route has extra charges | FareEditor rules | Same as `leg-fare` | Same |
| `det-purchases` | core | h3 "Ticket purchases and cost breakdown". Rows: "{label or kind}", "{kind} · {n} component(s) · {source}[ estimate]", the amount ("RM x", "x – y" in the offer currency, or "Unknown"), and for user fares "×" ("Remove fare {label}") | A route is selected | — | "×" runs `act()`: `DELETE /trips/{id}/fares/{offerId}`, then [reload] | — |
| `det-cost-note` | core | "Each ticket is charged once. Combined flight tickets do not include separately listed airport transfers. Average fare per stay hour: {RM}. Prices are quotes or assumptions, not booking guarantees." | A route is selected | — | — | — |
| `bundle-entry` | refine | Collapsible "Enter a combined flight ticket price" with a paragraph. One checkbox per flight "{from} → {to} · {YYYY-MM-DD}" (all checked by default; reset when the route changes). "Ticket type" ("Multi-city / open-jaw" by default, or "Round trip"), "Combined party fare", "Maximum (blank = fixed)", "Bundle currency" (MYR). Button "Save bundle" | The selected route has at least 2 flights | "Choose at least two flights and a valid combined fare." (global). Server: the flights must be retrieved flights; a round trip must be exactly two opposite journeys; the currency must be 3 letters | [saveSpec]+ `PUT /trips/{id}/fares/bundle:{uuid}`, then [reload] | Server offer labelled "Manually entered whole-ticket party fare". The amount fields are cleared on success. Status: "Fare saved · frontier recalculated" |

Paragraph in the bundle form: "Choose the exact journeys covered by your quote. Enter the total for the whole party; airport transfers remain separate. The optimizer compares this purchase with separate tickets."

### Shared FareEditor behaviour (used by `leg-fare`, `leg-charge-fare`, `det-extra-fares` and `fares-components`)

- **Fields:** "{label} · fare" (or "{label} · minimum" when Range is on), placeholder "Unknown"; checkbox "Range"; "{label} · maximum" with placeholder "Unbounded" (Range only); "{label} · currency" (3 characters, uppercased).
- **Buttons:** "Save fare" / "Saving…", and "Reset" (ghost style, only when the current offer is a user offer).
- **Errors** are inline: "Enter a nonnegative fare." · "Maximum must be at least the minimum." · server errors · fallback "Fare could not be saved."
- **Ranges:** Range on with a blank maximum means an open-ended fare, so the route total stays unbounded.
- **Saved offer:** id `user:{componentId}`, `kind: one-way`, `source: user`, `estimated: true`. A route that uses a user fare therefore shows "Includes estimates" and a diamond marker. There is one user fare per component; the later write wins, whether it comes from a FareEditor or from shared estimates.
- **Pre-filled value:** the newest single-component offer, looked up in snapshot (provider) offers and then trip (user) offers. User fares win.

---

## 17. Quote links and footer

| ID | Tier | What the user sees / does | Appears when | Validation / limits | API | Persistence |
|---|---|---|---|---|---|---|
| `quote-links` | refine | Panel with the collapsible "Round-trip and multi-city quote searches" and the text "An automatic quote is usable only when all journeys and the combined fare are verified. Otherwise open the search and enter a complete ticket price above." Links read "{kind}: {A → B (date)} · … ↗", followed by " · {status}" with the raw value, for example `requires_manual_quote` | A result exists and the job or coverage has bundle links (job links are preferred) | — | External Google Flights | — |
| `footer` | core (attribution, required) | "Wayfinder Routes · Flights via fast-flights · Scheduled transit via [Transitous sources](https://transitous.org/sources/) · Road estimates via OSRM · Cities © GeoNames · Airports © airportsdata · Map © OpenStreetMap contributors" | Always | — | — | — |

---

## 18. Behaviours that span the whole app (the redesign must keep these)

1. **`edit(value)`** (Planner.tsx lines 197–205)
   - Removes positioning items that are no longer valid (§7).
   - Updates `draftRef`, the draft state and the `version` counter.
   - Sets `dirtyRef` and `dirty`, sets the status to "Unsaved changes" and clears the global error.

2. **Autosave effect** (lines 291–297)
   - Runs when the draft, `dirty` or the saved trip id changes, and only when `dirty && saved && home && visits.length`.
   - Waits 650 ms, then calls `saveSpec()`.
   - On failure it sets the global error and the status "Changes not saved".
   - New trips are not autosaved.

3. **`saveSpec()`** (lines 267–290)
   - Saves run one at a time through `pendingSave`.
   - It records the version as `stamp` and the session as `token` before the request.
   - If the token changed during the request, it returns the record and does nothing else.
   - Only if `stamp === version` does it clear dirty, set "Saved locally" and run `POST /optimize`.
   - It always calls `accept(record)` and `GET /trips` (list refresh).

4. **`accept(record, replaceDraft)`** (lines 206–213)
   - For the same trip it ignores records that are older: a lower `revision`, or the same revision with a lower `snapshot.revision`. `replaceDraft` skips this check.
   - It writes `localStorage` `wayfinder:last-trip`.
   - With `replaceDraft` it replaces the draft with `record.spec`, filling in default `timing`/`cars` values from `blankTrip()`, and clears dirty.
   - It forwards `record.result` to `acceptResult`.

5. **`acceptResult(result, tripId)`** (lines 214–217). It rejects a result when:
   - the draft is dirty;
   - it is for another trip;
   - `trip_revision` is not equal to the saved revision;
   - `snapshot_revision` is lower than the saved snapshot revision.

   Because of this, old results stay on screen with the stale notice until a matching result arrives.

6. **Session tokens and version stamps.**
   - `session.current` increases on open, copy and New. Every async continuation compares its token, so responses from a trip the user has left are dropped.
   - `version.current` increases on every edit, open and copy.

7. **First load and restore** (lines 254–265)
   - Sends `GET /trips`, `GET /pricing-rules` and `GET /api/data` at the same time. If any of them fails, the global error is shown.
   - Then calls `openTrip(localStorage wayfinder:last-trip)` if that id is in the list.

8. **`openTrip(id)`** (lines 219–233)
   - Waits for the pending save; runs [saveSpec] if the draft is dirty and valid.
   - Starts a new session and shows the whole-page loader.
   - Clears error, result, job, selection and comparison.
   - `GET /trips/{id}` → `accept(record, true)` → status "Saved locally".
   - If `latest_job_id` exists, `GET /searches/{jobId}`.
   - If a snapshot exists and the stored result is missing or does not match the trip or snapshot revision, `POST /optimize`.

9. **`duplicateTrip()`** (lines 234–253) and **New** (line 434): as described in §1.

10. **Discovery polling** (lines 299–321)
    - The effect depends on `[job.id, job.status]` and runs only while the status is `queued` or `running`.
    - It polls immediately and then every 1000 ms, and skips a poll while the previous one is still in flight.
    - Each poll sends `GET /searches/{id}` and updates the job.
    - When `graph_revision > saved.snapshot.revision`, or when the job has stopped, it sends `GET /trips/{trip_id}` and calls `accept()`. It does this only for the same session, with no pending save, and when `revision >= current`.
    - The server writes partial results about every 4 queries, so the frontier updates while discovery runs.
    - Errors set the global error ("Search status unavailable." as fallback).

11. **`act(fn)`** controls the single global `busy` flag. It clears the error at start and sends a thrown error to the global error. `busy` disables most action buttons.

12. **Missing-fare drafts** (MissingFaresTable)
    - Stored in `localStorage` `wayfinder:pending-estimates:{tripId}`: read when the table mounts, written on every change, both inside try/catch. The table component is keyed by trip id.
    - `stage(key, fare)` removes those component ids from every other staged entry, drops entries that become empty, then sets the entry. The key is the group key, the label (applied groups), or `component:{id}` (single component).
    - Only drafts whose components are still listed are counted and sent.
    - On apply the drafts are cleared in state and the key is removed.

13. **Derived values to keep**
    - `places`: unique places in the order home, departures, arrivals, required cities.
    - `placeName()`: `airport:XYZ` becomes "XYZ airport"; otherwise the name, or the raw id.
    - `offerFor()`: user fare overrides a provider fare (§16).
    - Selection fallback: selected id → displayed routes → refinement routes → first displayed route.
    - Route page clamp; dominated toggle turns off by itself.
    - `unresolvedAccess` filter (§13); missing-fare grouping (`lib/missingFares.ts`).

14. **Drafts kept only in component memory** (lost on reload; some reset when data refreshes): airport-transfer rows, airport-connection rows, rule form, positioning service form, commitment form, FX form, assumed-connection form, bundle form, FareEditor inputs, chart scale toggles, ordering, page, comparison, dominated toggle, batch size.

15. **Theme.** `ThemeProvider` plus the pre-paint script in `index.html`, the `localStorage` key `wayfinder:theme`, and a listener for OS theme changes. The chart and the map re-read the theme.

16. **Accessibility already present.** Skip link; `aria-live` on the save status, job panel and gap buttons; `role="alert"` on errors; full combobox ARIA on PlacePicker; `aria-pressed` on cards and theme buttons; every input labelled through `Field` (a generated id with `htmlFor`); `aria-label` on every table input; screen-reader table captions; `inert` while applying; `focus-visible` outlines; `prefers-reduced-motion`.

17. **Responsive layout.** Breakpoints at 850, 600 and 540 px. The tables scroll sideways (fares table min-width 920 px, airport tables 780 px). The route grid scrolls (max-height 550 px). The fares table scrolls with a sticky header (max-height 560 px). The chart is 380 px high (310 px on mobile); the map is 330 px.

---

## 19. Status texts and other feedback

**Values of `save-status`:** "Choose your trip" (first view), "Unsaved changes", "Saving…", "Saved locally", "Changes not saved", "New trip", "Copied trip settings · ready to edit", "Fare saved · frontier recalculated" (also after a bundle save), "Shared estimates saved · frontier recalculated", "Assumed connection removed · frontier recalculated", "Airport transfer estimates saved", "Airport connections saved · frontier recalculated".

These actions **do not** change the status: rule changes, adding an assumed connection, resetting or removing a fare, loading dominated routes, and both "Continue optimizing" buttons.

**Fallback messages:** "The operation failed.", "Search status unavailable.", "Airport connections could not be saved.", "Bundle could not be saved.", "Connection could not be saved.", "Rule could not be saved.", "Invalid commitment.", "Invalid positioning service.", "Invalid place.", "Fare could not be saved.", "Shared fare could not be saved.", "Estimates could not be applied.".

**Server conflict** (409) on a save or apply: "This trip changed. Reload it before saving." The UI has no reload button for this; the user must open the trip again from the select.

---

## 20. Every API call the live frontend makes

| Method and path | Triggered by |
|---|---|
| `GET /api/data` (plain `fetch`, not `/api/v2`) | First load; only `transit_routing_configured` is used |
| `GET /trips` | First load; after every save and after copy |
| `GET /pricing-rules` | First load; after a rule is saved or deleted |
| `GET /places?search=` | Each PlacePicker |
| `POST /trips` | First [saveSpec] of a new trip |
| `PUT /trips/{id}` `{spec, expected_revision}` | [saveSpec] (autosave, Save & recalculate, and every [saveSpec]+ action) |
| `GET /trips/{id}?compact=true` | Open trip, [reload], polling |
| `POST /trips/{id}/duplicate` | New from existing |
| `POST /trips/{id}/optimize` `{compact, expand?, include_dominated?}` | After a save, on trip open, Save & recalculate, dominated toggle, frontier "Continue optimizing", rule changes |
| `POST /trips/{id}/searches {budget}` | Discover transport |
| `GET /searches/{id}` | Trip open, polling |
| `POST /searches/{id}/continue {budget}` | Continue searching / Retry failed searches / job-panel Continue optimizing |
| `POST /searches/{id}/cancel` | Cancel discovery |
| `PUT /trips/{id}/fares/{offerId}` | FareEditor save in itinerary details; Save bundle |
| `DELETE /trips/{id}/fares/{offerId}` | FareEditor Reset; purchase "×"; Reset in missing fares on an already-saved fare |
| `POST /trips/{id}/fares/estimates` | Apply saved estimates |
| `PUT /trips/{id}/airport-connections` | Save connections |
| `PUT /trips/{id}/airport-transfer-estimates` | Save transfer options |
| `POST /trips/{id}/movements` | Add assumed connection |
| `DELETE /trips/{id}/movements/{mid}?expected_revision=` | Remove a saved assumed connection |
| `PUT /pricing-rules/{id}` | Save pricing rule |
| `DELETE /pricing-rules/{id}` | Rule "×" |

`localStorage` keys: `wayfinder:theme`, `wayfinder:last-trip`, `wayfinder:pending-estimates:{tripId}`.

**Returned by the server but not shown** (these could help the redesign):
- `missing_fares[].break_even_myr`: the fare level at which a component changes the frontier. It could rank which fares matter most.
- `result.optimality_scope`, `expanded_labels`, `pruned_labels`.
- `coverage.source_gaps`, `coverage.outcomes`, `coverage.messages` (only the job messages are shown).
- `job.outcomes`.
- `SavedSummary.end_date` and `revision`.
- `Offer.search_url` in the purchases list.
- `cars.taxi_capacity`.
- `/api/data` fields other than the transit flag.

**Endpoints with no UI:** `DELETE /trips/{id}` (there is no way to delete a trip), `POST /trips/{id}/fares/batch`, `GET /trips/{id}?include_graph=true`, `/api/health` (flight-search status).

---

## 21. Inconsistencies found by reading the code (not checked in a browser)

1. **A cleared number field becomes 0.** In `NumberField` (PlannerForms.tsx line 12), a field that is not optional turns "" into `0`, and `?? fallback` does not catch 0. So "Adult travelers", "Own car seats", "Rental seats per car" and "Seats per vehicle" become 0 and the server rejects them; on autosave the status becomes "Changes not saved". Minimum stays and timing fields silently become 0. The rail fallback fields (Planner.tsx line 451) use `Number()` and the server rejects 0 there too.
2. **Some invalid input gets no feedback.** "Save exchange rate" does nothing on bad input. A 4th departure or arrival city, or a 5th required city, is ignored.
3. **Fields from the trip read go missing after an autosave.** The `PUT /trips/{id}` response does not include `assumed_connections`, `city_connection_gaps`, `fare_component_ids` or `airport_connections_required`. After any autosave, "Saved assumed connections" and the "Add {A} → {B}" gap buttons disappear until the next trip read (planner_api.py lines 131–149 vs 97–128; Planner.tsx line 470).
4. **Unsaved edits in Airport connections are lost.** The rows reset whenever `saved` or `result` is replaced, because the effect depends on the array objects themselves (Planner.tsx line 74). This happens during discovery polling and after autosave.
5. **Two different "Continue optimizing" actions.** The job panel's button continues the job (`/searches/{id}/continue`). The frontier's button sends `/optimize {expand: true}` and shows only when there is no job at all.
6. **Raw values are shown to the user:** the job status, the bundle-link status (`requires_manual_quote`), lowercase mode and vehicle names outside the modes fieldset, and offer kind/source ("one-way · 1 component(s) · unknown").
7. **The same words mean different things.** "Save estimate", "Save fare", "Saved for apply" and "Changes not saved" in the missing-fares table mean staged in the browser only. The same words elsewhere mean saved on the server. Also, "Save fare" stages, but "Reset" on a fare that is already saved on the server deletes it at once.
8. **Over-budget candidates are hard to reach.** They are available only when no feasible route exists (Planner.tsx line 497).
9. **The chart is often empty.** Routes with an unbounded cost are not plotted, so the chart is empty in the common state just after a search. "Lowest known total" lists every provisional route after every exactly priced route, whatever the amounts.
10. **The comparison can show negative "additional" hours or cost.**
11. **Loading replaces the page.** Opening or copying a trip replaces the whole page with the loader.
12. **Navigation issues.** The skip link comes after the header controls. The "Itinerary" nav link appears whenever a result exists, even when the target section does not.
13. **Time zones differ between forms.** Assumed-connection times use the browser's local time; commitments and positioning services use the city's time. Giving only one timestamp fails on the server. Adding a connection gives no success message and does not clear the form.
14. **Empty gateway lists come back as home.** The server replaces an empty departure or arrival list with `[home]` (planner_models.py lines 158–159). A trip opened again therefore shows home as a departure/arrival chip ("1/3").
15. **Missing client checks and confirmations.**
    - The Discover transport spinner turns on during any busy action.
    - Currency is not checked in the browser in the transfer table, the bundle form or the FareEditor (the server returns 422).
    - Deleting a pricing rule asks for no confirmation, even though rules are global and every trip's revision changes.
    - Saving airport connections skips saveSpec and `expected_revision`.
16. **Small display issues.**
    - `localTime(null)` shows "Flexible departure" even for arrival and stay times.
    - The heading "Applied shared estimates" appears twice when no missing groups remain.
    - The `theme-color` meta in `index.html` (#f5f7f8) differs from the runtime colours.
17. **Long text everywhere.** Each area has paragraph hints (listed above). AGENTS.md asks to move these to progressive disclosure, but the information in them must be kept.

---

## 22. Current page order (baseline)

| # | Section | Shown when |
|---|---|---|
| 1 | Header | Always |
| 2 | Skip link | Always |
| 3 | Navigation | Always |
| 4 | Intro | Always |
| 5 | Error | When there is an error |
| 6 | **01 Your trip**, including the positioning and advanced sections and the action bar | Always |
| 7 | **Airport ↔ city transfers** | The trip is saved |
| 8 | **02 Transport discovery** | A job exists |
| 9 | `#pricing`: saved assumed connections, pricing rules, missing city connections and add form | Always |
| 10 | Stale notice | A result exists |
| 11 | **↔ Airport connections** | A result exists |
| 12 | **03 Missing fares** | A result exists |
| 13 | Unresolved airport access | A result exists |
| 14 | **04 Frontier**: chart, dominated toggle, continue optimizing, ordering, empty state, refinement, cards, pagination, comparison | A result exists |
| 15 | **05 Itinerary details** | A result exists and a route is selected |
| 16 | Quote links | A result exists |
| 17 | Footer | Always |

**Tier summary**

- **Core:** `hdr-trip-select`, `hdr-new`, `place-home`, `place-search`, `visit-add`, `visit-card`, `setup-name`, `setup-start`, `setup-end`, `setup-date-mode`, `setup-adults`, `setup-budget`, `setup-modes`, `act-discover`, `job-panel`, `job-cancel`, `job-continue`, `res-stale`, `setup-transit-off`, `chart` + `chart-empty-notice`, `front-continue-opt`, `front-order`, `front-empty`, `card` + `card-pagination`, `compare`, `det-*` (header, map, stays, cost note), `leg`, `leg-assumptions`, `leg-estimated-timetable`, `leg-search-link`, `det-purchases`, plus chrome (status, error, loading, navigation, skip link, footer).
- **Refine:** `xfer-*`, `aconn-*`, `fares-*`, `unresolved-access`, `rules-*`, `conn-*`, `leg-fare`, `leg-charge-fare`, `det-extra-fares`, purchase removal, `bundle-entry`, `quote-links`, `front-refinement`, `adv-fx`, `adv-airport-fallback`.
- **Power:** `hdr-theme`, `hdr-duplicate`, `place-departures`, `place-arrivals`, `place-custom`, `visit-apply-first`, `setup-max-transfers`, `setup-window`, `setup-overnight`, `setup-rail-*`, `setup-exclude-unpriced`, `pos-*`, `adv-*` timing/commitments/cars, `act-batch-budget`, `act-save-recalc`, `job-counters`, `job-messages`, `front-status`, `front-dominated`, `chart-log-*`, `chart-fit`, `chart-zoom`, `leg-segments`.

The main source file is `frontend/src/Planner.tsx`; the components it uses are in `frontend/src/components\` and `frontend/src/lib\`. The backend contracts I checked are in `backend/app\` (mainly `planner_api.py` and `planner_models.py`).