import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type Map as MapLibreMap, type Popup } from "maplibre-gl";
import type { City, PlannerData, RouteResult } from "../lib/types";
import { money } from "../lib/utils";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";

type Props = {
  data: PlannerData;
  route: RouteResult | null;
  onChooseCity: (code: string, kind: "arrival" | "departure") => void;
};

function featureCollection(features: object[]) {
  return { type: "FeatureCollection" as const, features };
}

function cityColor(city: City, selected: boolean) {
  if (selected) return "#e2664e";
  const fares = [city.outbound?.price_myr, city.return_flight?.price_myr].filter((value): value is number => value != null);
  if (!fares.length) return "#9aa7af";
  const best = Math.min(...fares);
  if (best < 700) return "#167e78";
  if (best < 900) return "#47977c";
  if (best < 1100) return "#d08b43";
  return "#b65d50";
}

function popupContent(city: City, onChooseCity: Props["onChooseCity"]) {
  const root = document.createElement("div");
  root.className = "map-popup-content";
  const title = document.createElement("strong");
  title.textContent = city.name;
  root.append(title);

  const code = document.createElement("div");
  code.className = "map-popup-code";
  code.textContent = `${city.country_code ? `${city.country_code} · ` : ""}Skyscanner code ${city.code.toUpperCase()}`;
  root.append(code);

  const addFlight = (label: string, listing: City["outbound"]) => {
    const row = document.createElement("div");
    row.className = "map-popup-flight";
    const text = document.createElement("span");
    text.textContent = `${label}: ${money(listing?.price_myr)}`;
    row.append(text);
    if (listing) {
      const link = document.createElement("a");
      link.href = listing.booking_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Search ↗";
      row.append(link);
    }
    root.append(row);
  };
  addFlight("Outbound", city.outbound);
  addFlight("Return", city.return_flight);

  const actions = document.createElement("div");
  actions.className = "map-popup-actions";
  for (const [kind, label] of [["arrival", "Set arrival"], ["departure", "Set departure"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => onChooseCity(city.code, kind));
    actions.append(button);
  }
  root.append(actions);
  return root;
}

export function RouteMap({ data, route, onChooseCity }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  const popupRef = useRef<Popup | null>(null);
  const lastRouteIdRef = useRef<string | null>(null);
  const routeRef = useRef<RouteResult | null>(route);
  const chooseCityRef = useRef(onChooseCity);
  const dataRef = useRef(data);
  const pointDataRef = useRef<object>(null as never);
  const lineDataRef = useRef<object>(null as never);
  routeRef.current = route;
  chooseCityRef.current = onChooseCity;
  dataRef.current = data;

  const pointData = useMemo(() => {
    const selectedCodes = new Set([route?.arrival_city.code, route?.departure_city.code]);
    const features = data.cities.filter((city) => city.code !== data.origin?.code).map((city) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [city.longitude, city.latitude] },
      properties: {
        code: city.code,
        name: city.name,
        isOrigin: false,
        color: cityColor(city, selectedCodes.has(city.code)),
        hasOutbound: Boolean(city.outbound?.price_myr != null),
        hasReturn: Boolean(city.return_flight?.price_myr != null),
      },
    }));
    if (data.origin) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [data.origin.longitude, data.origin.latitude] },
        properties: { code: data.origin.code, name: data.origin.name, isOrigin: true, color: "#23333e", hasOutbound: false, hasReturn: false },
      } as (typeof features)[number]);
    }
    return featureCollection(features);
  }, [data, route]);

  const lineData = useMemo(() => {
    const features: object[] = [];
    if (route) {
      const arrival = data.cities.find((city) => city.code === route.arrival_city.code);
      const departure = data.cities.find((city) => city.code === route.departure_city.code);
      if (arrival && data.origin) {
        const from = [data.origin.longitude, data.origin.latitude];
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [from, [arrival.longitude, arrival.latitude]] },
          properties: { color: "#64748b", kind: "flight" },
        });
      }
      if (departure && data.origin) {
        const from = [data.origin.longitude, data.origin.latitude];
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[departure.longitude, departure.latitude], from] },
          properties: { color: "#64748b", kind: "flight" },
        });
      }
      if (arrival && departure && !route.is_same_city) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[arrival.longitude, arrival.latitude], [departure.longitude, departure.latitude]] },
          properties: { color: "#e68a43", kind: "transport" },
        });
      }
    }
    return featureCollection(features);
  }, [data, route]);
  pointDataRef.current = pointData;
  lineDataRef.current = lineData;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [111, 25],
      zoom: 3.2,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      loadedRef.current = true;
      map.addSource("cities", { type: "geojson", data: pointDataRef.current as never });
      map.addSource("selected-route", { type: "geojson", data: lineDataRef.current as never });
      map.addLayer({
        id: "flight-lines",
        type: "line",
        source: "selected-route",
        filter: ["==", ["get", "kind"], "flight"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2.2,
          "line-dasharray": [2, 1.7],
          "line-opacity": 0.84,
        },
      });
      map.addLayer({
        id: "transport-lines",
        type: "line",
        source: "selected-route",
        filter: ["==", ["get", "kind"], "transport"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3.5,
          "line-dasharray": [1, 1.3],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "city-circles",
        type: "circle",
        source: "cities",
        paint: {
          "circle-radius": ["case", ["get", "isOrigin"], 8, 6],
          "circle-color": ["get", "color"],
          "circle-stroke-color": [
            "case",
            ["all", ["get", "hasOutbound"], ["get", "hasReturn"]], "#ffffff",
            ["get", "hasOutbound"], "#3a73a5",
            ["get", "hasReturn"], "#d0813e",
            "#ffffff",
          ],
          "circle-stroke-width": 2.5,
          "circle-opacity": 0.95,
        },
      });
      map.addLayer({
        id: "city-labels",
        type: "symbol",
        source: "cities",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Regular"],
          "text-size": 10,
          "text-offset": [0, 1.25],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#23333e",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
      map.on("mouseenter", "city-circles", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "city-circles", () => (map.getCanvas().style.cursor = ""));
      map.on("click", "city-circles", (event) => {
        const feature = event.features?.[0];
        const code = String(feature?.properties?.code ?? "");
        const city = dataRef.current.cities.find((entry) => entry.code === code);
        if (!city || !feature) return;
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ offset: 12, closeButton: true, maxWidth: "300px" })
          .setLngLat(event.lngLat)
          .setDOMContent(popupContent(city, (selectedCode, kind) => chooseCityRef.current(selectedCode, kind)))
          .addTo(map);
      });
      const currentData = dataRef.current;
      const activeRoute = routeRef.current;
      const coords: [number, number][] = currentData.origin
        ? [[currentData.origin.longitude, currentData.origin.latitude]]
        : [];
      if (activeRoute) {
        for (const code of [activeRoute.arrival_city.code, activeRoute.departure_city.code]) {
          const selectedCity = currentData.cities.find((city) => city.code === code);
          if (selectedCity) coords.push([selectedCity.longitude, selectedCity.latitude]);
        }
        lastRouteIdRef.current = activeRoute.id;
      } else {
        coords.push(...currentData.cities.map((city) => [city.longitude, city.latitude] as [number, number]));
      }
      if (!coords.length) coords.push([111, 25]);
      const longitudes = coords.map(([longitude]) => longitude);
      const latitudes = coords.map(([, latitude]) => latitude);
      map.fitBounds(
        [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
        { padding: activeRoute ? 85 : { top: 44, right: 52, bottom: 52, left: 52 }, maxZoom: activeRoute ? 5.5 : 3.9, duration: 0 },
      );
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // The map is created once; data changes are applied by the following effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!loadedRef.current || !map) return;
    (map.getSource("cities") as maplibregl.GeoJSONSource | undefined)?.setData(pointData as never);
    (map.getSource("selected-route") as maplibregl.GeoJSONSource | undefined)?.setData(lineData as never);
    if (!route) lastRouteIdRef.current = null;
    if (route && lastRouteIdRef.current !== route.id) {
      lastRouteIdRef.current = route.id;
      const arrival = data.cities.find((city) => city.code === route.arrival_city.code);
      const departure = data.cities.find((city) => city.code === route.departure_city.code);
      const coordinates = [
        ...(data.origin ? [[data.origin.longitude, data.origin.latitude] as [number, number]] : []),
        ...(arrival ? [[arrival.longitude, arrival.latitude] as [number, number]] : []),
        ...(departure ? [[departure.longitude, departure.latitude] as [number, number]] : []),
      ];
      const longitudes = coordinates.map(([longitude]) => longitude);
      const latitudes = coordinates.map(([, latitude]) => latitude);
      map.fitBounds(
        [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
        { padding: 85, maxZoom: 5.5, duration: 600 },
      );
    }
  }, [data, lineData, pointData, route]);

  return <div ref={containerRef} className="route-map" aria-label="Map of the selected flight origin and imported destinations" />;
}
