import { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
import type { Place, Route } from "../lib/planner";

export function PlannerMap({ places, route }: { places: Place[]; route: Route | null }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map>(null);
  const ready = useRef(false);
  const data = useMemo<FeatureCollection>(() => ({ type: "FeatureCollection", features: [
    ...places.map(p => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [p.longitude, p.latitude] }, properties: { name: p.name } })),
    ...(route?.movements ?? []).flatMap(m => { const a = places.find(p => p.id === m.from_id), b = places.find(p => p.id === m.to_id); return a && b ? [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]] }, properties: { mode: m.mode } }] : []; }),
  ] }), [places, route]);
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    if (!container.current) return;
    const instance = new maplibregl.Map({ container: container.current, style: "https://tiles.openfreemap.org/styles/bright", center: [108, 15], zoom: 2, attributionControl: { compact: true } });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl(), "top-right");
    instance.on("load", () => {
      ready.current = true;
      const labelLayer = instance.getStyle().layers.find(layer => layer.type === "symbol" && layer.layout?.["text-font"]);
      const font = labelLayer?.type === "symbol" ? labelLayer.layout?.["text-font"] : ["Noto Sans Regular"];
      instance.addSource("trip", { type: "geojson", data: latest.current });
      instance.addLayer({ id: "connections", type: "line", source: "trip", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": ["match", ["get", "mode"], "flight", "#5f799d", "car", "#987149", "taxi", "#987149", "#167e78"], "line-width": 3, "line-dasharray": [2, 1] } });
      instance.addLayer({ id: "cities", type: "circle", source: "trip", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#167e78", "circle-stroke-color": "white", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "names", type: "symbol", source: "trip", filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-color": "#21353d", "text-halo-color": "white", "text-halo-width": 2 } });
      fit();
    });
    function fit() {
      const points = latest.current.features.filter(f => f.geometry.type === "Point").map(f => (f.geometry as GeoJSON.Point).coordinates);
      if (points.length) instance.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: 50, maxZoom: 7 });
    }
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); ready.current = false; instance.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!map.current || !ready.current) return;
    (map.current.getSource("trip") as maplibregl.GeoJSONSource).setData(data);
    if (places.length) map.current.fitBounds([[Math.min(...places.map(p => p.longitude)), Math.min(...places.map(p => p.latitude))], [Math.max(...places.map(p => p.longitude)), Math.max(...places.map(p => p.latitude))]], { padding: 50, maxZoom: 7 });
  }, [data, places]);
  return <div ref={container} className="planner-map" aria-label="Selected itinerary map" />;
}
