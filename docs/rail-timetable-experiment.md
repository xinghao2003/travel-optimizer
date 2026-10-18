# Rail timetable fallback experiment

Run on 19 October 2026 against the configured public Transitous service. All planner writes used a temporary database; the saved user trip was unchanged. Results are observations from this run, not fixed timetable guarantees.

## Findings

- The processed China Railway GTFS feed advertised service from 2 October 2026 to 6 January 2027. Its service calendar used `calendar_dates.txt`, not `calendar.txt`.
- Ordinary Chengdu/Chongqing city-coordinate searches returned no journeys even for 21 October. The routing diagnostics reported no origin/destination station offsets. Station-radius searches found services; the issue was both station access and future timetable coverage.
- A 25 km city station-radius query for 21 October, 09:00–21:00 local time, returned 43 itineraries. Its walking access and egress had nonzero scheduled times, which must remain part of journey duration.
- The same city station-radius query for 10 March 2027 returned no journeys.
- As a cross-country control, Berlin–Hamburg station-radius queries returned three itineraries for 10 March 2027 and seven for 4 November 2026 (09:00–12:00 window). No returned legs had `loopedCalendarSince` in those responses. Future dates therefore cannot be assumed uncovered everywhere.

## Implementation pipeline experiment

An isolated rail-only trip used Chengdu as home, Chongqing as its visit, 10–11 March 2027, a 09:00–17:00 local departure window, a 25 km radius, and reference period starting 19 October 2026. Each direction ran the normal date query, then the actual-date station-radius query, then the first matching-weekday sample. No manual city connection or fare was supplied.

| Direction / target date | Actual date | Actual date with station radius | First reference sample | Usable projected movements |
| --- | --- | --- | --- | --- |
| Chengdu → Chongqing / 10 March | Empty | Empty | 4 November 2026: 22 raw itineraries | 13 |
| Chongqing → Chengdu / 11 March | Empty | Empty | 5 November 2026: 24 raw itineraries | 22 |

The optimizer received 35 movements and produced 286 feasible itineraries, all explicitly marked as estimated timetables, with optimization complete. Fares remained unknown. These counts describe the isolated rail-only experiment, not the saved international trip. Walking access/egress and configured transit buffers were included; the first forward example took 283 minutes in total and the first reverse example took 301 minutes.

The implementation keeps sampling bounded and opt-in because the public MOTIS API does not document a per-route timetable validity endpoint. An empty response alone cannot distinguish missing coverage from missing access or no service. Reference periods can be changed by the user; automatic sampling chooses three matching weekdays in the current reference period, closest to the target first. It does not claim to find the globally nearest covered date, identify public holidays, or verify seasonal service.

## Verification

Regression coverage includes opt-in and shift limits, same-weekday selection, overnight arrivals, daylight-saving changes, scheduled versus realtime timestamps, rejected zero-time station access, provider extended calendars, shared reference caches, request budgets and restart/resume/cancellation, pagination, replacement by actual-date rail data, disabling fallback, and estimate labels after entering exact fares. The frontend production build validates the settings and estimate display types.

## Sources

- [Transitous API and linked OpenAPI specification](https://transitous.org/api/)
- [Transitous feed sources](https://transitous.org/sources/)
- [Transitous source options, including extend-calendar](https://github.com/public-transport/transitous/blob/main/docs/docs/index.md)
- [China Railway feed generator and explicit service dates](https://github.com/wensimehrp/chinese-railway-gtfs/blob/main/gen_gtfs.py)
