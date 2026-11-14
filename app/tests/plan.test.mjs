import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { autoStayHours, isAutoStay, withAutoStays } = await loadTs("../src/lib/plan.ts");
const { blankTrip } = await loadTs("../src/lib/planner.ts");

const place = id => ({ id, name: id, latitude: 0, longitude: 0, timezone: "UTC", country_code: "", airport_codes: [], flight_code: null });
const visit = (id, min_stay_hours) => ({ place: place(id), min_stay_hours });
// 14 free days and 2 cities: 3 journeys of 1 day, then 5 whole days for each city.
const trip = (visits, extra = {}) => ({ ...blankTrip(), home: place("home"), start_date: "2026-12-01", end_date: "2026-12-14", visits, ...extra });
const stays = draft => draft.visits.map(item => item.min_stay_hours);

test("a minimum stay that you type replaces the automatic one, and the other cities stay automatic", () => {
  const auto = trip([visit("a", 120), visit("b", 120)]);
  assert.equal(autoStayHours(auto), 120);
  // Typing 4.2 days in the first city.
  const typed = withAutoStays(auto, trip([visit("a", 100.8), visit("b", 120)]));
  assert.deepEqual(stays(typed), [100.8, 120]);
  assert.deepEqual(typed.visits.map(item => isAutoStay(typed, item.min_stay_hours)), [false, true]);
  // Shorter dates: the automatic city follows them, the typed one does not.
  const shorter = withAutoStays(typed, { ...typed, end_date: "2026-12-10" });
  assert.deepEqual(stays(shorter), [100.8, 72]);
  // The typed stay stays as typed on the next keystroke too.
  assert.deepEqual(stays(withAutoStays(typed, trip([visit("a", 103.2), visit("b", 120)]))), [103.2, 120]);
});

test("automatic minimum stays follow the cities and the dates", () => {
  const auto = trip([visit("a", 120), visit("b", 120)]);
  // A new city starts automatic, and the others get the new automatic value.
  assert.deepEqual(stays(withAutoStays(auto, trip([visit("a", 120), visit("b", 120), visit("c", 0)]))), [72, 72, 72]);
  // A cleared automatic stay is automatic again; a cleared typed stay stays empty until you type or reset it.
  assert.deepEqual(stays(withAutoStays(auto, trip([visit("a", 0), visit("b", 120)]))), [120, 120]);
  const typed = trip([visit("a", 48), visit("b", 120)]);
  assert.deepEqual(stays(withAutoStays(typed, trip([visit("a", 0), visit("b", 120)]))), [0, 120]);
  // Nothing to change: the same draft comes back.
  const next = trip([visit("a", 120), visit("b", 120)], { adults: 2 });
  assert.equal(withAutoStays(auto, next), next);
});
