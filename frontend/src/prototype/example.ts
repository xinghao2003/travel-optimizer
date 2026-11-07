import { blankTrip, type Movement, type Offer, type Place, type TripSpec } from "../lib/planner";

export const places: Place[] = [
  { id: "berlin", name: "Berlin", country_code: "DE", latitude: 52.5251, longitude: 13.3694, timezone: "Europe/Berlin", airport_codes: ["BER"], flight_code: "BER" },
  { id: "hamburg", name: "Hamburg", country_code: "DE", latitude: 53.5527, longitude: 10.0067, timezone: "Europe/Berlin", airport_codes: ["HAM"], flight_code: "HAM" },
  { id: "prague", name: "Prague", country_code: "CZ", latitude: 50.0832, longitude: 14.4353, timezone: "Europe/Prague", airport_codes: ["PRG"], flight_code: "PRG" },
  { id: "munich", name: "Munich", country_code: "DE", latitude: 48.1402, longitude: 11.5586, timezone: "Europe/Berlin", airport_codes: ["MUC"], flight_code: "MUC" },
  { id: "kul", name: "Kuala Lumpur", country_code: "MY", latitude: 3.139, longitude: 101.6869, timezone: "Asia/Kuala_Lumpur", airport_codes: ["KUL", "SZB"], flight_code: "KUL" },
  { id: "pen", name: "Penang", country_code: "MY", latitude: 5.4141, longitude: 100.3288, timezone: "Asia/Kuala_Lumpur", airport_codes: ["PEN"], flight_code: "PEN" },
  { id: "seoul", name: "Seoul", country_code: "KR", latitude: 37.5665, longitude: 126.978, timezone: "Asia/Seoul", airport_codes: ["ICN", "GMP"], flight_code: "SEL" },
  { id: "busan", name: "Busan", country_code: "KR", latitude: 35.1796, longitude: 129.0756, timezone: "Asia/Seoul", airport_codes: ["PUS"], flight_code: "PUS" },
];

export function initialSpec(): TripSpec {
  const draft = blankTrip();
  const end = new Date(`${draft.start_date}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 3);
  return { ...draft, name: "Browser trip", home: places[0], departures: [places[0]], arrivals: [places[0]],
    visits: [{ place: places[2], min_stay_hours: 12 }], end_date: end.toISOString().slice(0, 10),
    departure_start: "00:00", departure_end: "23:59", modes: ["rail"] };
}

export function example() {
  const spec = initialSpec();
  const movement = (id: string, from: Place, to: Place, day: string, hour: number, duration: number): Movement => ({
    id, from_id: from.id, to_id: to.id, mode: "rail", departure: `${day}T${String(hour).padStart(2, "0")}:00:00Z`,
    arrival: `${day}T${String(hour + duration).padStart(2, "0")}:00:00Z`, duration_minutes: duration * 60,
    distance_km: null, transfers: 0, vehicle_kind: null, segments: [], charges: [], source: "Prototype example", search_url: null, assumptions: ["Example schedule and fare; not a live service."] });
  const movements = [movement("early", places[0], places[2], spec.start_date, 6, 4),
    movement("late", places[0], places[2], spec.start_date, 14, 4),
    movement("back-early", places[2], places[0], spec.end_date, 9, 4),
    movement("back-late", places[2], places[0], spec.end_date, 17, 4)];
  const offers: Offer[] = movements.map((item, index) => ({ id: `fare:${item.id}`, movement_ids: [item.id], kind: "one-way",
    low: [150, 70, 70, 150][index], high: [150, 70, 70, 150][index], currency: "MYR", source: "user",
    estimated: true, validated: true, label: "Example whole-party fare" }));
  return { spec, graph: { revision: 1, movements, offers }, rules: [], example: true };
}
