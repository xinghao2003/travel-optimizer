import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { api, type Place } from "../lib/planner";

type NearPlace = Place & { distance_km: number };

/** Pick on map (C11): a click shows the nearest catalog places; choosing one calls `onSelect`. `disabledIds` are not offered. */
export function PlaceMapPicker({ onSelect, disabledIds }: { onSelect: (place: Place) => void; disabledIds: string[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [items, setItems] = useState<NearPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const excluded = disabledIds.join("|");
  useEffect(() => {
    if (!container.current) return;
    const instance = new maplibregl.Map({ container: container.current, style: "https://tiles.openfreemap.org/styles/bright", center: [108, 15], zoom: 2, attributionControl: { compact: true } });
    instance.addControl(new maplibregl.NavigationControl(), "top-right");
    instance.getCanvas().style.cursor = "crosshair";
    const marker = new maplibregl.Marker({ color: "#167e78" });
    instance.on("click", event => {
      marker.setLngLat(event.lngLat).addTo(instance);
      // A click on a copy of the world east or west of the first one gives a longitude outside ±180.
      setPoint({ latitude: event.lngLat.lat, longitude: event.lngLat.wrap().lng });
    });
    // Tile or style requests that fail, for example offline (C12).
    instance.on("error", () => setFailed(true));
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); instance.remove(); };
  }, []);
  useEffect(() => {
    if (!point) return;
    let current = true;
    setLoading(true);
    // Ask for more places than shown, so places already in the trip can be left out.
    api<{ places: NearPlace[] }>(`/places/nearest?latitude=${point.latitude}&longitude=${point.longitude}&limit=10`)
      .then(data => { if (current) { setItems(data.places.filter(place => !excluded.split("|").includes(place.id)).slice(0, 5)); setError(""); } })
      .catch(err => { if (current) setError(String(err.message)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [point, excluded]);
  return <div className="p-map-picker">
    <div className="p-map">
      <div ref={container} className="planner-map" aria-label="Map to pick a place" />
      {failed && <p className="p-map-error" role="status">Map unavailable. Check your connection, or search by name.</p>}
    </div>
    <div aria-live="polite">{loading ? <small>Finding nearby places…</small> : !point ? <small>Click the map to see the nearest places.</small> : !items.length && !error && <small>No places near this point.</small>}</div>
    {items.length > 0 && <ul className="p-map-picks">{items.map(({ distance_km, ...place }) => <li key={place.id}><button type="button" onClick={() => onSelect(place)}>
      <strong>{place.name}</strong><small>{[place.country_code, place.airport_codes.length ? place.airport_codes.join(", ") : "No airport", `${Math.round(distance_km)} km away`].filter(Boolean).join(" · ")}</small>
    </button></li>)}</ul>}
    {error && <p className="p-field-error" role="alert">{error}</p>}
  </div>;
}
