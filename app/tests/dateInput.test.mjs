import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { acceptsTemporalText, calendarDateValue, parseCalendarDate, temporalError } = await loadTs("../src/lib/dateInput.ts");

test("typing and pasted dates cannot introduce a fifth year digit", () => {
  for (const type of ["date", "datetime-local"]) {
    for (const text of ["2", "2026", "2026-", "2026-11-07"]) assert.equal(acceptsTemporalText(text, type), true);
    for (const text of ["20261", "20261-11-07", "12026-11-07 14:30"]) assert.equal(acceptsTemporalText(text, type), false);
  }
  assert.equal(acceptsTemporalText("2026-11-07 14:30", "datetime-local"), true);
});

test("calendar validation rejects rollover dates and preserves four-digit local years", () => {
  for (const text of ["2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "20261-01-01", "2026-1-01"]) {
    assert.equal(parseCalendarDate(text), undefined);
    assert.ok(temporalError(text, "date"));
  }
  for (const text of ["2028-02-29", "0001-01-01", "0099-12-31", "9999-12-31"]) {
    assert.equal(calendarDateValue(parseCalendarDate(text)), text);
    assert.equal(temporalError(text, "date"), "");
  }
});

test("date, time and local datetime limits use the existing ISO values", () => {
  assert.equal(temporalError("", "date"), "");
  assert.equal(temporalError("2026-11-07", "date", "2026-11-07"), "");
  assert.ok(temporalError("2026-11-06", "date", "2026-11-07"));
  assert.equal(temporalError("2026-11-07T14:30", "datetime-local", "2026-11-07T14:30"), "");
  assert.ok(temporalError("2026-11-07T14:29", "datetime-local", "2026-11-07T14:30"));
  for (const value of ["24:00", "12:60", "9:30"]) assert.ok(temporalError(value, "time"));
  for (const value of ["00:00", "23:59"]) assert.equal(temporalError(value, "time"), "");
});
