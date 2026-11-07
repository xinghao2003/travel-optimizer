# Journey grouping and reusable estimates

Missing info > Journey prices has a **Group by** button. Its checkboxes select
boarding/alighting stations, transport category, connection pattern, service or
route, operator, travel date, and departure time. The default selects stations,
category, and connections. Direction, transport mode, vehicle kind, and party
size always remain separate. The grouping preference stays in this browser.

Expand **Show journeys** to inspect each journey's total duration, transfer
count, riding services, stations, local departure/arrival times, and operator.
High-speed rail, ordinary rail, bus, tram, subway, and other returned riding
modes use the same representation. Flight ticket matching excludes separately
priced airport-access segments.

A group price creates a reusable estimate for the whole journey and the
current party, within this trip. Its saved matching scope applies to existing
and subsequently discovered journeys. A different service date or departure
time does not prevent reuse unless that field was selected. Station IDs are
provider-qualified identifiers. If a selected identifier is missing, its value
stays specific to that journey rather than matching other unidentified services.
Seat class and seat availability are not inferred.

Changing the display grouping does not change saved estimates or staged scopes.
Individual journey prices and provider fares take precedence over reusable
estimates. Among matching trip estimates, more selected matching fields win;
equally specific estimates use the latest saved priority. Existing global price
rules remain fallbacks when no trip estimate matches. A multi-service journey
is priced as one whole journey; estimates are not multiplied by train count.

**Group prices you set** shows saved reusable scopes and supports changing or
removing them. Counts there describe journeys in the current options. An
estimate can be edited even when none of its journeys is currently displayed.
Existing prices saved before this feature remain exact journey overrides until
you select **Reuse for matching journeys** in that group. This keeps the saved
amount and party size, splits its journeys by the current grouping fields,
and replaces that group's dated overrides with reusable estimates. No amount
needs to be entered again. Conversion is explicit; display regrouping alone
does not convert older prices.

The existing Apply transaction accepts an optional `scope` on each shared fare.
The server validates it against the supplied journeys and stores it as a
trip-local `journey_pricing_rules` entry. Recalculation passes these rules into
the existing fallback-pricing path. No SQLite schema migration is needed.
Removing an estimate uses the same pause/edit/resume coordination as Apply.
Paused timed rounds still need continuation to update their options; saved
estimates are not presented as fresh missing-price inputs while waiting.
