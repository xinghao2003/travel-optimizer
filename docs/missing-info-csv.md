# Edit prices as CSV

Open **Prices to add → Edit as CSV**. The text box starts with the current
values. **Copy CSV** copies that text; edit it elsewhere and paste the result
back into the same box, including its header. You can also edit directly in
the box or paste tab-separated cells copied from a spreadsheet. No file
download or upload is needed. If automatic copy is blocked, the editor selects
the text and explains how to copy it with the keyboard.

**Copy rules/schema** copies the CSV header, editable columns by row type,
allowed values, pricing and matching rules, limits, and workflow as plain text.
You can paste it alongside the CSV when asking someone to fill in values.
If automatic copy is blocked, a separate read-only text box shows and selects
the rules. Your CSV text is preserved.

Select **Preview changes** to inspect matches and errors. **Import as drafts**
stages all valid changes together. Any error blocks the whole import. The
imported drafts then save on their own with the other pending edits and update
options once. Until they save they persist in this browser and can be undone in
the normal forms.

## Rows and values

| Type | Editable columns | Scope |
| --- | --- | --- |
| `journey_price` | `price`, `max_price`, `currency` | One journey or the displayed matching group |
| `airport_transfer` | `price`, `max_price`, `currency`, `minutes` | One city–airport direction and mode |
| `airport_change` | `mode`, `price`, `currency`, `minutes` | One directed airport pair |
| `exchange_rate` | `myr_per_unit`; also `currency` in the new-currency row | Current trip |

Prices are whole-party amounts per journey, in the specified currency. They
are not per-person amounts or a bundled total across the listed journeys.
Use decimal numbers without currency symbols or thousands separators.
Explicit `0` is a zero price. Blank cells leave current values unchanged;
they do not erase a saved value or an existing draft.

The `action` column accepts blank or `update` for normal edits. Set it to
`delete` to remove the row's user-entered price, rate, transfer method or
airport change. Removing a row from the CSV leaves its value unchanged.
Older CSV text without the `action` column still works for updates.

Deletions appear in Preview and are staged until **Apply**. Pending deletions
have an **Undo** button. Only user-entered values can be deleted; retrieved
journeys, provider quotes and the MYR rate are preserved. Removing a manual
price lets other prices or rules apply again. Removing a conversion rate
leaves totals in that currency incomplete, and removing an airport change
can make affected journeys unusable.

For a new fixed price, fill `price` and leave `max_price` blank. For a range,
fill both. Journey prices also accept `open` in `max_price` for no upper limit.
To replace an existing range or open price with a fixed price, set
`max_price` equal to `price`.

Airport transfers include a separate row for each supported mode: taxi, rail,
bus, coach, subway, tram and car. Fill the modes you want. Non-taxi methods
need a positive duration. A taxi can use the existing road/default duration.
Existing methods that you do not edit are preserved. Airport changes need
both a mode and a positive duration; their price is optional.

Exchange rates mean **MYR per one unit of the named currency**. They must be
positive. MYR is always 1 and is not editable here. To add a currency not yet
listed, fill the new-currency row. Copy that row for additional currencies.
Foreign prices without a rate are allowed, with a preview warning; totals
using them remain incomplete. Rates added through Missing info are drafts
until Apply, just like prices and transfer times.

## Matching and precedence

Keep `trip_id`, `revision`, `adults`, `row_id`, `type`, endpoints and `scope`
unchanged. A row ID matches an existing input; the app does not guess matches
from names. Group IDs preserve their grouping scope, and individual journey
IDs use the canonical journey identity across transfer-price variants.

Group estimates and individual overrides can be imported together. Individual
journey overrides retain their normal precedence, regardless of CSV row order.
Existing provider fares retain their normal precedence over reusable estimates.

An unrelated trip, changed party size, outdated trip revision, unknown row,
changed grouping, conflicting duplicate, invalid number or malformed CSV
produces a row error. Identical duplicates are ignored. If the trip or scopes
changed, **Reset to current values** regenerates the CSV; it replaces the text
currently in the editor. Canceling the dialog keeps its text for reopening
within this page. Switching trips or reloading the page closes the editor;
only imported drafts are persisted.

The editor supports quoted commas, quotes, multiline cells, Unicode, UTF-8
BOMs, and spreadsheet TSV. Context fields that could be interpreted as
spreadsheet formulas are escaped. Preview renders 40 changed rows at a time.
CSV generation and parsing are limited to 5,000 rows and 8 MB of text.

New scheduled connections, combined-ticket quotes, trip setup, and global
pricing rules continue to use their existing forms. This CSV workflow edits
the four Missing info row types above.
