// Metro and neighbourhood gazetteer.
//
// Why it exists: the Qloo heatmap returns geohash cells with coordinates and no
// neighbourhood name. The agent snaps each cell to the nearest neighbourhood
// centre in this table, so a judge reads "Wicker Park", not "dp3wq".
// Coordinates are rounded neighbourhood centres. `radiusKm` is the search
// radius the agent uses for anchor places around that centre.
import type { GeoPoint } from "./types";
import { haversineKm } from "../qloo/fixtures/util";

export interface Neighborhood extends GeoPoint {
  id: string;
  metroId: string;
  name: string;
  radiusKm: number;
}

export interface Metro extends GeoPoint {
  id: string;
  name: string;
  country: string;
  /** Text for Qloo `filter.location.query`. */
  query: string;
  neighborhoods: Neighborhood[];
}

type Raw = [id: string, name: string, lat: number, lon: number, radiusKm?: number];

function metro(id: string, name: string, country: string, lat: number, lon: number, raw: Raw[]): Metro {
  return {
    id, name, country, lat, lon, query: name,
    neighborhoods: raw.map(([nid, nname, nlat, nlon, r]) => ({ id: `${id}:${nid}`, metroId: id, name: nname, lat: nlat, lon: nlon, radiusKm: r ?? 1.2 })),
  };
}

export const METROS: Metro[] = [
  metro("chi", "Chicago", "US", 41.881, -87.653, [
    ["wicker-park", "Wicker Park", 41.9088, -87.6776],
    ["logan-square", "Logan Square", 41.9231, -87.7093],
    ["bucktown", "Bucktown", 41.9217, -87.6796, 0.9],
    ["pilsen", "Pilsen", 41.8556, -87.6566],
    ["west-loop", "West Loop", 41.8826, -87.6496],
    ["lincoln-park", "Lincoln Park", 41.9214, -87.6513],
    ["lakeview", "Lakeview", 41.9434, -87.6553],
    ["andersonville", "Andersonville", 41.98, -87.6685],
    ["river-north", "River North", 41.8924, -87.6341],
    ["hyde-park", "Hyde Park", 41.7943, -87.5907, 1.5],
  ]),
  metro("nyc", "New York", "US", 40.73, -73.96, [
    ["williamsburg", "Williamsburg", 40.7081, -73.9571],
    ["greenpoint", "Greenpoint", 40.73, -73.954, 0.9],
    ["bushwick", "Bushwick", 40.6944, -73.9213],
    ["lower-east-side", "Lower East Side", 40.715, -73.9843, 0.9],
    ["west-village", "West Village", 40.7358, -74.0036, 0.9],
    ["soho", "SoHo", 40.7233, -74.003, 0.8],
    ["chelsea", "Chelsea", 40.7465, -74.0014, 0.9],
    ["park-slope", "Park Slope", 40.671, -73.9814],
    ["harlem", "Harlem", 40.8116, -73.9465, 1.4],
    ["astoria", "Astoria", 40.7644, -73.9235, 1.3],
  ]),
  metro("la", "Los Angeles", "US", 34.06, -118.3, [
    ["silver-lake", "Silver Lake", 34.0869, -118.2702],
    ["echo-park", "Echo Park", 34.0782, -118.2606, 1.0],
    ["arts-district", "Arts District", 34.0403, -118.2353, 1.0],
    ["downtown", "Downtown", 34.0441, -118.2509, 1.0],
    ["highland-park", "Highland Park", 34.1115, -118.1923],
    ["fairfax", "Fairfax", 34.0762, -118.3617],
    ["koreatown", "Koreatown", 34.0618, -118.3004],
    ["hollywood", "Hollywood", 34.0928, -118.3287, 1.4],
    ["venice", "Venice", 33.985, -118.4695],
    ["santa-monica", "Santa Monica", 34.0195, -118.4912, 1.5],
    ["culver-city", "Culver City", 34.0211, -118.3965, 1.4],
  ]),
  metro("lon", "London", "GB", 51.515, -0.1, [
    ["shoreditch", "Shoreditch", 51.5265, -0.078, 0.9],
    ["hackney", "Hackney", 51.545, -0.0553],
    ["dalston", "Dalston", 51.5463, -0.0752, 0.8],
    ["peckham", "Peckham", 51.474, -0.069],
    ["brixton", "Brixton", 51.4613, -0.1156],
    ["camden", "Camden", 51.539, -0.1426],
    ["marylebone", "Marylebone", 51.5205, -0.1527, 0.9],
    ["soho", "Soho", 51.5136, -0.1365, 0.6],
    ["covent-garden", "Covent Garden", 51.5117, -0.124, 0.6],
    ["islington", "Islington", 51.5362, -0.1033],
    ["notting-hill", "Notting Hill", 51.5094, -0.196],
    ["borough", "Borough", 51.5016, -0.092, 0.8],
  ]),
];

export function findMetro(nameOrId: string | undefined): Metro | undefined {
  if (!nameOrId) return undefined;
  const q = nameOrId.trim().toLowerCase().replace(/,.*$/, "");
  return METROS.find((m) => m.id === q || m.name.toLowerCase() === q);
}

export function findNeighborhood(id: string): Neighborhood | undefined {
  const metroId = id.split(":")[0];
  return METROS.find((m) => m.id === metroId)?.neighborhoods.find((n) => n.id === id);
}

/** Neighbourhood whose centre is nearest to p, within maxKm. */
export function nearestNeighborhood(p: GeoPoint, metro: Metro, maxKm = 2.5): Neighborhood | undefined {
  let best: Neighborhood | undefined;
  let bestD = Infinity;
  for (const n of metro.neighborhoods) {
    const d = haversineKm(p, n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD <= maxKm ? best : undefined;
}

/** Name match for neighbourhoods named in free text (the LLM-only baseline). */
export function findNeighborhoodByName(metro: Metro, name: string): Neighborhood | undefined {
  const q = name.trim().toLowerCase().replace(/^the\s+/, "");
  return metro.neighborhoods.find((n) => n.name.toLowerCase() === q || q.startsWith(n.name.toLowerCase()) || n.name.toLowerCase().startsWith(q));
}
