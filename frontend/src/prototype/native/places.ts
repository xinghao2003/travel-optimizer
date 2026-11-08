import type { Place } from "../../lib/planner";
import { PlannerError } from "./edits";
import { round } from "./time";

type CatalogRow = { place: Place; search: string; population: number; payload: string };
export type PlaceCatalogData = { schema_version: number; rows: CatalogRow[]; casefold: Record<string, string>; combining: number[] };
const binaryCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const radians = (degrees: number) => degrees * Math.PI / 180;
const distance = (a: number, b: number, p: Place) => 12742 * Math.asin(Math.sqrt(Math.sin(radians(p.latitude - a) / 2) ** 2
  + Math.cos(radians(a)) * Math.cos(radians(p.latitude)) * Math.sin(radians(p.longitude - b) / 2) ** 2));

export class PlaceCatalog {
  private combining: Set<number>;
  constructor(private data: PlaceCatalogData) {
    if (data.schema_version !== 1) throw new Error("Unsupported place catalog version.");
    this.combining = new Set(data.combining);
  }
  normalize(value: string) {
    return [...[...value].map(c => this.data.casefold[c] ?? c).join("").normalize("NFKD")].filter(c => !this.combining.has(c.codePointAt(0)!)).join("");
  }
  search(query: string, limit = 16): Place[] {
    if ([...query].length < 2 || [...query].length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new PlannerError("Enter 2 to 80 characters and a limit from 1 to 30.");
    const needle = this.normalize(query.trim()), exact = (row: CatalogRow) => Number(row.place.name.replace(/[A-Z]/g, c => c.toLowerCase()) === needle);
    const word = (row: CatalogRow) => Number((" " + row.search + " ").includes(" " + needle + " "));
    return this.data.rows.filter(row => row.search.includes(needle)).sort((a, b) => exact(b) - exact(a) || word(b) - word(a)
      || b.population - a.population || binaryCompare(a.place.name, b.place.name)).slice(0, limit).map(row => structuredClone(row.place));
  }
  nearest(latitude: number, longitude: number, limit = 5): (Place & { distance_km: number })[] {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new PlannerError("Choose valid coordinates and a limit from 1 to 10.");
    for (const degrees of [.5, 2, 8, 30, 180]) {
      const span = Math.min(180, degrees / Math.max(Math.cos(radians(Math.min(Math.abs(latitude) + degrees, 89.9))), .01)), west = longitude - span, east = longitude + span;
      const found = this.data.rows.filter(({ place: p }) => Math.abs(p.latitude - latitude) <= degrees && (span >= 180
        || (west < -180 ? p.longitude >= west + 360 || p.longitude <= east : east > 180 ? p.longitude <= east - 360 || p.longitude >= west : p.longitude >= west && p.longitude <= east)))
        .map(row => ({ row, km: distance(latitude, longitude, row.place) })).sort((a, b) => a.km - b.km || binaryCompare(a.row.payload, b.row.payload)).slice(0, limit);
      if (found.length === limit && found[found.length - 1].km <= degrees * 111 || degrees === 180) return found.map(({ row, km }) => ({ ...structuredClone(row.place), distance_km: round(km, 1) }));
    }
    return [];
  }
}
let loading: Promise<PlaceCatalog> | undefined;
export function loadPlaces(): Promise<PlaceCatalog> {
  return loading ??= fetch("/browser-data/places.json").then(async response => {
    if (!response.ok) throw new Error("Place catalog is missing. Run tools/prepare_static_planner.py.");
    return new PlaceCatalog(await response.json());
  });
}
