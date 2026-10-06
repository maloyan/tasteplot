import { useEffect, useRef } from "react";
import { LngLatBounds, Map as MLMap, Marker, NavigationControl, setWorkerUrl, type ErrorEvent, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
// MapLibre v6 ships an ES-module web worker. Vite bundles it with its shared chunk.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import type { HeatCell, NeighborhoodHeat, SitePlan } from "../../shared/types";

setWorkerUrl(maplibreWorkerUrl);

// Free vector tiles, no key: OpenFreeMap (https://openfreemap.org). Override with VITE_MAP_STYLE.
const STYLE_URL = (import.meta.env.VITE_MAP_STYLE as string | undefined) ?? "https://tiles.openfreemap.org/styles/dark";

// Used when the tile style cannot load (offline dev): the data layers still render.
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0e1118" } }],
};

interface Props {
  heat: HeatCell[];
  neighborhoods: NeighborhoodHeat[];
  /** Metro centre, so the map flies there before the heatmap arrives. */
  center?: [number, number];
  plan?: SitePlan;
  selected?: number;
  onSelect?: (rank: number) => void;
}

const empty = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Bounds of a geohash cell as [west, south, east, north]. */
function geohashBounds(gh: string): [number, number, number, number] {
  let even = true;
  let lat: [number, number] = [-90, 90];
  let lon: [number, number] = [-180, 180];
  for (const ch of gh) {
    const v = B32.indexOf(ch);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (v >> bit) & 1;
      const r = even ? lon : lat;
      const mid = (r[0] + r[1]) / 2;
      if (on) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return [lon[0], lat[0], lon[1], lat[1]];
}

/** A cell polygon: the geohash rectangle, or a ~500 m square when the cell has no geohash. */
function cellRing(c: HeatCell): [number, number][] {
  const [w, s, e, n] = c.geohash ? geohashBounds(c.geohash) : [c.lon - 0.003, c.lat - 0.002, c.lon + 0.003, c.lat + 0.002];
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function addLayers(map: MLMap) {
  if (map.getSource("heat")) return;
  map.addSource("heat", { type: "geojson", data: empty() });
  map.addSource("anchors", { type: "geojson", data: empty() });
  // Each Qloo heatmap cell is a geohash. Draw it as its own rectangle, coloured by affinity:
  // honest about the grid, and readable at city zoom.
  map.addLayer({
    id: "heat",
    type: "fill",
    source: "heat",
    paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "a"], 0, "#2a1650", 0.3, "#5b2ca0", 0.5, "#d63384", 0.7, "#ff7850", 0.9, "#ffd678"],
      "fill-opacity": ["interpolate", ["linear"], ["get", "a"], 0, 0.15, 0.5, 0.45, 1, 0.7],
      "fill-outline-color": "rgba(11,13,18,0.6)",
    },
  });
  map.addLayer({
    id: "anchors",
    type: "circle",
    source: "anchors",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 14, 7],
      "circle-color": "#7dd3fc",
      "circle-stroke-color": "#0b0d12",
      "circle-stroke-width": 1.5,
      "circle-opacity": ["case", ["get", "on"], 1, 0.55],
    },
  });
}

export function MapView({ heat, neighborhoods, center, plan, selected, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const ready = useRef(false);
  const pending = useRef<() => void>(() => {});
  const lastFit = useRef<{ heat?: HeatCell[]; plan?: SitePlan; center?: string }>({});

  useEffect(() => {
    if (!el.current) return;
    const map = new MLMap({ container: el.current, style: STYLE_URL, center: [-40, 42], zoom: 1.6, attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    let fellBack = false;
    map.on("error", (e: ErrorEvent) => {
      if (!ready.current && !fellBack && /style|fetch|Failed/i.test(String(e.error?.message ?? ""))) {
        fellBack = true;
        map.setStyle(OFFLINE_STYLE);
      }
    });
    map.on("style.load", () => {
      addLayers(map);
      ready.current = true;
      pending.current();
    });
    return () => { map.remove(); mapRef.current = null; ready.current = false; };
  }, []);

  useEffect(() => {
    const apply = () => {
      const map = mapRef.current;
      if (!map || !ready.current) return;
      (map.getSource("heat") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: heat.map((c) => ({ type: "Feature", properties: { a: c.affinity }, geometry: { type: "Polygon", coordinates: [cellRing(c)] } })),
      });
      const sites = plan?.sites ?? [];
      (map.getSource("anchors") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: sites.flatMap((s) => s.anchors.map((a) => ({
          type: "Feature" as const,
          properties: { on: selected === undefined || selected === s.rank, name: a.name },
          geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
        }))),
      });

      markers.current.forEach((m) => m.remove());
      markers.current = [];
      if (sites.length) {
        for (const s of sites) {
          const d = document.createElement("button");
          d.className = `pin${selected === s.rank ? " pin-on" : ""}`;
          d.textContent = String(s.rank);
          d.title = `${s.rank}. ${s.neighborhood.name}: site score ${Math.round(s.score * 100)}`;
          d.setAttribute("aria-label", d.title);
          d.onclick = () => onSelect?.(s.rank);
          markers.current.push(new Marker({ element: d }).setLngLat([s.neighborhood.lon, s.neighborhood.lat]).addTo(map));
        }
      } else {
        for (const h of neighborhoods.filter((n) => n.cells > 0).slice(0, 8)) {
          const d = document.createElement("div");
          d.className = "hot";
          d.innerHTML = `<span>${h.name.replace(/</g, "&lt;")}</span><b>${h.lift !== undefined ? `${h.lift.toFixed(2)}×` : Math.round(h.heat * 100)}</b>`;
          markers.current.push(new Marker({ element: d, anchor: "left", offset: [6, 0] }).setLngLat([h.lon, h.lat]).addTo(map));
        }
      }
      const pts: [number, number][] = sites.length
        ? sites.flatMap((s) => [[s.neighborhood.lon, s.neighborhood.lat] as [number, number], ...s.anchors.map((a) => [a.lon, a.lat] as [number, number])])
        : heat.map((c) => [c.lon, c.lat] as [number, number]);
      const centerKey = center?.join(",");
      const changed = lastFit.current.heat !== heat || lastFit.current.plan !== plan || lastFit.current.center !== centerKey;
      if (changed) {
        lastFit.current = { heat, plan, center: centerKey };
        if (pts.length) {
          const b = new LngLatBounds(pts[0], pts[0]);
          for (const p of pts) b.extend(p);
          map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 13.5, duration: 900 });
        } else if (center) {
          map.flyTo({ center, zoom: 10.5, duration: 900 });
        }
      }
    };
    pending.current = apply;
    apply();
  }, [heat, neighborhoods, center, plan, selected, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    const s = plan?.sites.find((x) => x.rank === selected);
    if (map && s) map.flyTo({ center: [s.neighborhood.lon, s.neighborhood.lat], zoom: Math.max(map.getZoom(), 13), duration: 700 });
  }, [selected, plan]);

  return <div ref={el} className="map" role="region" aria-label="Neighbourhood map" />;
}
