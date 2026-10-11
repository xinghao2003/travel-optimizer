import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import type { TripCity, TripRoute } from "../lib/types";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";

type Props = {
  origin: TripCity | null;
  destinations: TripCity[];
  route: TripRoute | null;
};

function collection(features: object[]) {
  return { type: "FeatureCollection" as const, features };
}

function fitRoute(map: MapLibreMap, origin: TripCity | null, route: TripRoute | null, destinations: TripCity[]) {
  const points = route?.stops ?? (origin ? [origin, ...destinations] : destinations);
  if (!points.length) {
    map.setCenter([111, 25]);
    map.setZoom(2.5);
    return;
  }
  const coordinates = points.map((city) => [city.longitude, city.latitude] as [number, number]);
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  map.fitBounds(
    [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
    { padding: 72, maxZoom: 5.5, duration: 450 },
  );
}

export function RouteMap({ origin, destinations, route }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);

  const points = useMemo(() => {
    const byCode = new Map<string, TripCity>();
    if (origin) byCode.set(origin.code, origin);
    for (const city of destinations) byCode.set(city.code, city);
    return collection([...byCode.values()].map((city) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [city.longitude, city.latitude] },
      properties: {
        code: city.code,
        name: city.name,
        isOrigin: city.code === origin?.code,
        isRouteStop: Boolean(route?.stops.some((stop) => stop.code === city.code)),
      },
    })));
  }, [destinations, origin, route]);

  const lines = useMemo(() => collection((route?.legs ?? []).map((leg) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [leg.from_city.longitude, leg.from_city.latitude],
        [leg.to_city.longitude, leg.to_city.latitude],
      ],
    },
    properties: { mode: leg.mode },
  }))), [route]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [111, 25],
      zoom: 2.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("load", () => {
      loadedRef.current = true;
      map.addSource("trip-cities", { type: "geojson", data: points as never });
      map.addSource("trip-legs", { type: "geojson", data: lines as never });
      map.addLayer({
        id: "flight-legs",
        type: "line",
        source: "trip-legs",
        filter: ["==", ["get", "mode"], "flight"],
        paint: { "line-color": "#627b91", "line-width": 2.5, "line-dasharray": [2, 1.5], "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "rail-legs",
        type: "line",
        source: "trip-legs",
        filter: ["==", ["get", "mode"], "rail"],
        paint: { "line-color": "#df8741", "line-width": 3.5, "line-dasharray": [1, 1.1], "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "ground-legs",
        type: "line",
        source: "trip-legs",
        filter: ["==", ["get", "mode"], "ground"],
        paint: { "line-color": "#a68b72", "line-width": 2.5, "line-dasharray": [1, 1.1], "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "trip-city-circles",
        type: "circle",
        source: "trip-cities",
        paint: {
          "circle-radius": ["case", ["get", "isOrigin"], 8, ["get", "isRouteStop"], 7, 5],
          "circle-color": ["case", ["get", "isOrigin"], "#203943", ["get", "isRouteStop"], "#167e78", "#aab6bb"],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "trip-city-labels",
        type: "symbol",
        source: "trip-cities",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Regular"],
          "text-size": 10,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: { "text-color": "#203943", "text-halo-color": "#fff", "text-halo-width": 1.5 },
      });
      fitRoute(map, origin, route, destinations);
    });
    return () => {
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // The map is created once; the next effect applies changing route data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource("trip-cities") as maplibregl.GeoJSONSource | undefined)?.setData(points as never);
    (map.getSource("trip-legs") as maplibregl.GeoJSONSource | undefined)?.setData(lines as never);
    fitRoute(map, origin, route, destinations);
  }, [destinations, lines, origin, points, route]);

  return <div ref={containerRef} className="route-map" aria-label="Map showing the selected flight and scheduled rail connections between cities" />;
}
