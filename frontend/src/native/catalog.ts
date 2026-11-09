import type { AirportCatalog } from "./preparation";

let loading: Promise<AirportCatalog> | undefined;
export function loadAirportCatalog(): Promise<AirportCatalog> {
  return loading ??= fetch("/browser-data/airports.json").then(async response => {
    if (!response.ok) throw new Error("Airport metadata is missing. Run tools/prepare_catalogs.py.");
    const data = await response.json();
    if (data.schema_version !== 1) throw new Error("Unsupported airport metadata version.");
    return data as AirportCatalog;
  });
}
