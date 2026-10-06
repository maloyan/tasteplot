// The fixture world: a small, deterministic, SYNTHETIC taste graph for 4 metros.
//
// It exists so Tasteplot runs end to end with no Qloo key and no network.
// Nothing in here is Qloo data. Every affinity is generated from taste vectors
// plus seeded noise.
//
// Names:
// - Seed entities (Blue Bottle Coffee, Rapha, Stüssy, Sally Rooney, ...) carry
//   real names so a user can type them. Their taste vectors are invented.
// - A handful of well-known real places (REAL_PLACES) sit at approximate real
//   coordinates, so the "Without Qloo" check has something real to find. Their
//   scores are invented.
// - Every other place and every partner brand is fictional on purpose.
//
// The UI shows a "FIXTURE DATA" badge whenever this world answers.
import { METROS, type Metro, type Neighborhood } from "../../shared/metros";
import { clamp01, haversineKm, noise, rng, round, slug } from "./util";

export const AXES = [
  "coffee", "cycling", "outdoor", "vinyl", "indie", "design", "books", "literary", "art",
  "streetwear", "sneakers", "hiphop", "skate", "fashion", "food", "wine", "fitness", "family", "nightlife", "luxury",
] as const;
export type Axis = (typeof AXES)[number];
export type TasteVec = Partial<Record<Axis, number>>;

export type EntityType =
  | "urn:entity:brand" | "urn:entity:artist" | "urn:entity:person" | "urn:entity:book"
  | "urn:entity:place" | "urn:entity:locality" | "urn:entity:movie";

export interface WorldTag {
  id: string;
  name: string;
  type: string;
  /** The taste axis this tag stands for. */
  axis: Axis;
}

export interface WorldEntity {
  id: string;
  name: string;
  type: EntityType;
  taste: TasteVec;
  popularity: number;
  tagIds: string[];
  disambiguation?: string;
  neighborhoodId?: string;
  lat?: number;
  lon?: number;
  address?: string;
}

// ---- Tags ----------------------------------------------------------------------
// Fixture tag IDs follow the documented urn:tag:<type>:<source>:<value> pattern. The values are invented.
const T = (axis: Axis, name: string, type = "urn:tag:keyword:qloo"): WorldTag => ({ id: `${type}:${slug(name).replace(/-/g, "_")}`, name, type, axis });

export const TAGS: WorldTag[] = [
  T("coffee", "Specialty Coffee"), T("coffee", "Coffee Shop", "urn:tag:category:place"),
  T("cycling", "Cycling"), T("cycling", "Bicycle Shop", "urn:tag:category:place"),
  T("outdoor", "Outdoors"), T("outdoor", "Hiking"),
  T("vinyl", "Vinyl Records"), T("vinyl", "Record Stores"), T("vinyl", "Record Store", "urn:tag:category:place"),
  T("indie", "Indie Music"), T("design", "Minimalist Design"), T("design", "Interior Design"),
  T("books", "Independent Bookstores"), T("books", "Bookstores"), T("books", "Book Store", "urn:tag:category:place"),
  T("literary", "Literary Fiction"), T("literary", "Poetry"),
  T("art", "Art Galleries"), T("art", "Art Gallery", "urn:tag:category:place"),
  T("streetwear", "Streetwear"), T("streetwear", "Clothing Store", "urn:tag:category:place"),
  T("sneakers", "Sneakers"), T("sneakers", "Sneaker Store", "urn:tag:category:place"),
  T("hiphop", "Hip Hop", "urn:tag:genre:qloo"), T("skate", "Skateboarding"), T("skate", "Skate Shop", "urn:tag:category:place"),
  T("fashion", "Fashion"), T("food", "Brunch"), T("food", "Restaurant", "urn:tag:category:place"),
  T("wine", "Natural Wine"), T("wine", "Wine Bar", "urn:tag:category:place"),
  T("fitness", "Fitness"), T("fitness", "Gym", "urn:tag:category:place"),
  T("family", "Family Friendly"), T("nightlife", "Nightlife"), T("nightlife", "Bar", "urn:tag:category:place"),
  T("luxury", "Luxury"),
];
export const TAG_BY_ID = new Map(TAGS.map((t) => [t.id, t]));
const placeTag = (name: string) => TAGS.find((t) => t.type === "urn:tag:category:place" && t.name === name)!.id;

// ---- Neighbourhood scenes: how strong each taste is (default 0.3) ------------------
const SCENES: Record<string, TasteVec> = {
  "chi:wicker-park": { coffee: 0.9, vinyl: 0.85, indie: 0.85, books: 0.7, design: 0.6, cycling: 0.6, nightlife: 0.7, streetwear: 0.5 },
  "chi:logan-square": { coffee: 0.85, cycling: 0.85, indie: 0.8, vinyl: 0.7, wine: 0.7, food: 0.75, art: 0.5 },
  "chi:bucktown": { design: 0.75, coffee: 0.7, fitness: 0.6, family: 0.6, food: 0.6, fashion: 0.5 },
  "chi:pilsen": { art: 0.9, food: 0.75, indie: 0.6, coffee: 0.6, skate: 0.5 },
  "chi:west-loop": { food: 0.95, luxury: 0.75, fashion: 0.6, wine: 0.7, fitness: 0.6, design: 0.6 },
  "chi:lincoln-park": { family: 0.75, fitness: 0.8, outdoor: 0.6, food: 0.55, coffee: 0.5 },
  "chi:lakeview": { nightlife: 0.75, fitness: 0.65, food: 0.5, vinyl: 0.45 },
  "chi:andersonville": { books: 0.75, design: 0.6, coffee: 0.65, food: 0.6, family: 0.5 },
  "chi:river-north": { luxury: 0.8, art: 0.65, nightlife: 0.7, fashion: 0.6 },
  "chi:hyde-park": { books: 0.85, literary: 0.8, coffee: 0.5, art: 0.45 },

  "nyc:williamsburg": { coffee: 0.9, vinyl: 0.85, indie: 0.9, design: 0.8, streetwear: 0.7, wine: 0.75, nightlife: 0.8, cycling: 0.7 },
  "nyc:greenpoint": { coffee: 0.85, books: 0.7, wine: 0.75, design: 0.7, cycling: 0.6 },
  "nyc:bushwick": { art: 0.85, indie: 0.8, nightlife: 0.8, vinyl: 0.7, skate: 0.6 },
  "nyc:lower-east-side": { streetwear: 0.9, sneakers: 0.85, skate: 0.8, hiphop: 0.7, nightlife: 0.8, art: 0.6 },
  "nyc:west-village": { coffee: 0.75, books: 0.75, literary: 0.7, wine: 0.7, food: 0.8, luxury: 0.6 },
  "nyc:soho": { fashion: 0.95, streetwear: 0.85, sneakers: 0.8, luxury: 0.85, design: 0.75, art: 0.6 },
  "nyc:chelsea": { art: 0.95, luxury: 0.7, fitness: 0.6, food: 0.6 },
  "nyc:park-slope": { family: 0.9, books: 0.75, coffee: 0.7, cycling: 0.65, outdoor: 0.6 },
  "nyc:harlem": { hiphop: 0.8, food: 0.7, art: 0.55, books: 0.5 },
  "nyc:astoria": { food: 0.75, family: 0.6, coffee: 0.5, nightlife: 0.55 },

  "la:silver-lake": { coffee: 0.9, indie: 0.85, vinyl: 0.8, design: 0.75, wine: 0.7, books: 0.6, cycling: 0.6 },
  "la:echo-park": { indie: 0.8, coffee: 0.75, vinyl: 0.7, skate: 0.55, nightlife: 0.65 },
  "la:arts-district": { art: 0.85, coffee: 0.8, design: 0.7, streetwear: 0.65, food: 0.7, skate: 0.55 },
  "la:downtown": { books: 0.65, nightlife: 0.7, food: 0.65, streetwear: 0.55, art: 0.55 },
  "la:highland-park": { vinyl: 0.75, coffee: 0.7, indie: 0.75, wine: 0.6, art: 0.5 },
  "la:fairfax": { streetwear: 0.95, sneakers: 0.95, skate: 0.85, hiphop: 0.8, fashion: 0.7 },
  "la:koreatown": { food: 0.9, nightlife: 0.85, hiphop: 0.6, fashion: 0.5 },
  "la:hollywood": { nightlife: 0.8, vinyl: 0.7, hiphop: 0.6, fashion: 0.55 },
  "la:venice": { skate: 0.85, outdoor: 0.75, fitness: 0.75, streetwear: 0.6, art: 0.6, coffee: 0.6 },
  "la:santa-monica": { fitness: 0.8, outdoor: 0.7, family: 0.7, luxury: 0.65, cycling: 0.55 },
  "la:culver-city": { food: 0.7, design: 0.6, family: 0.6, art: 0.5 },

  "lon:shoreditch": { streetwear: 0.8, vinyl: 0.8, coffee: 0.8, art: 0.75, design: 0.75, nightlife: 0.85, sneakers: 0.7 },
  "lon:hackney": { coffee: 0.85, wine: 0.8, cycling: 0.75, indie: 0.75, books: 0.65, food: 0.7 },
  "lon:dalston": { vinyl: 0.85, indie: 0.8, nightlife: 0.8, wine: 0.65, art: 0.6 },
  "lon:peckham": { art: 0.85, indie: 0.75, food: 0.7, nightlife: 0.7, wine: 0.6 },
  "lon:brixton": { hiphop: 0.75, food: 0.8, nightlife: 0.75, vinyl: 0.6 },
  "lon:camden": { vinyl: 0.75, nightlife: 0.8, streetwear: 0.55, indie: 0.6 },
  "lon:marylebone": { books: 0.9, literary: 0.85, luxury: 0.7, design: 0.65, coffee: 0.6, food: 0.6 },
  "lon:soho": { books: 0.7, nightlife: 0.85, fashion: 0.75, vinyl: 0.6, food: 0.75 },
  "lon:covent-garden": { books: 0.65, coffee: 0.7, fashion: 0.7, luxury: 0.6, family: 0.5 },
  "lon:islington": { books: 0.8, literary: 0.8, wine: 0.6, family: 0.6, coffee: 0.6 },
  "lon:notting-hill": { books: 0.65, luxury: 0.75, fashion: 0.65, family: 0.55, design: 0.6 },
  "lon:borough": { food: 0.9, coffee: 0.75, wine: 0.65, books: 0.45 },
};

export function sceneOf(neighborhoodId: string): Record<Axis, number> {
  const s = SCENES[neighborhoodId] ?? {};
  const out = {} as Record<Axis, number>;
  for (const a of AXES) out[a] = s[a] ?? 0.3;
  return out;
}

// ---- Seed entities: real names, invented taste vectors ---------------------------
interface Seed { name: string; type: EntityType; taste: TasteVec; popularity: number; disambiguation: string; idSuffix?: string; place?: { hood: string; lat: number; lon: number } }

const SEEDS: Seed[] = [
  { name: "Blue Bottle Coffee", type: "urn:entity:brand", taste: { coffee: 1, design: 0.6, food: 0.3 }, popularity: 0.82, disambiguation: "Coffee roaster and cafe brand" },
  { name: "Intelligentsia Coffee", type: "urn:entity:brand", taste: { coffee: 1, indie: 0.35, design: 0.3 }, popularity: 0.7, disambiguation: "Coffee roaster" },
  { name: "Rapha", type: "urn:entity:brand", taste: { cycling: 1, design: 0.5, fashion: 0.4, coffee: 0.3 }, popularity: 0.6, disambiguation: "Cycling apparel brand" },
  { name: "Kinfolk", type: "urn:entity:brand", taste: { design: 0.9, books: 0.5, coffee: 0.5, food: 0.4, literary: 0.3 }, popularity: 0.55, disambiguation: "Lifestyle magazine" },
  { name: "Starbucks", type: "urn:entity:brand", taste: { coffee: 0.7, family: 0.6, fitness: 0.3 }, popularity: 0.98, disambiguation: "Coffeehouse chain" },
  { name: "Patagonia", type: "urn:entity:brand", taste: { outdoor: 1, cycling: 0.35, design: 0.2 }, popularity: 0.88, disambiguation: "Outdoor clothing brand", idSuffix: "brand" },
  { name: "Patagonia", type: "urn:entity:locality", taste: { outdoor: 0.9, luxury: 0.3 }, popularity: 0.74, disambiguation: "Region in South America", idSuffix: "region" },
  { name: "Stüssy", type: "urn:entity:brand", taste: { streetwear: 1, skate: 0.6, hiphop: 0.45, fashion: 0.4 }, popularity: 0.8, disambiguation: "Streetwear brand" },
  { name: "Supreme", type: "urn:entity:brand", taste: { streetwear: 1, skate: 0.7, sneakers: 0.5, fashion: 0.4 }, popularity: 0.9, disambiguation: "Streetwear and skate brand" },
  { name: "Nike", type: "urn:entity:brand", taste: { sneakers: 0.9, fitness: 0.8, streetwear: 0.4, family: 0.3 }, popularity: 0.99, disambiguation: "Sportswear brand" },
  { name: "Tyler, the Creator", type: "urn:entity:artist", taste: { hiphop: 0.9, streetwear: 0.7, fashion: 0.6, skate: 0.4 }, popularity: 0.92, disambiguation: "Rapper and producer" },
  { name: "Sally Rooney", type: "urn:entity:person", taste: { literary: 1, books: 0.8, design: 0.2 }, popularity: 0.78, disambiguation: "Irish novelist" },
  { name: "Normal People", type: "urn:entity:book", taste: { literary: 0.9, books: 0.85 }, popularity: 0.8, disambiguation: "Novel by Sally Rooney" },
  { name: "Haruki Murakami", type: "urn:entity:person", taste: { literary: 0.9, books: 0.8, vinyl: 0.4, coffee: 0.2 }, popularity: 0.88, disambiguation: "Japanese novelist" },
  { name: "The Paris Review", type: "urn:entity:brand", taste: { literary: 1, books: 0.8, art: 0.3 }, popularity: 0.5, disambiguation: "Literary magazine" },
  { name: "Waterstones", type: "urn:entity:brand", taste: { books: 0.9, family: 0.5, literary: 0.4 }, popularity: 0.86, disambiguation: "Bookshop chain" },
];

// ---- Real places at approximate real coordinates. Scores are invented. --------------
interface RealPlace { name: string; hood: string; lat: number; lon: number; cat: string; taste: TasteVec }
const REAL_PLACES: RealPlace[] = [
  { name: "Reckless Records", hood: "chi:wicker-park", lat: 41.9093, lon: -87.6774, cat: "Record Store", taste: { vinyl: 1, indie: 0.8 } },
  { name: "Myopic Books", hood: "chi:wicker-park", lat: 41.91, lon: -87.6779, cat: "Book Store", taste: { books: 1, literary: 0.6, indie: 0.4 } },
  { name: "Amoeba Music", hood: "la:hollywood", lat: 34.1017, lon: -118.3254, cat: "Record Store", taste: { vinyl: 1, indie: 0.6, hiphop: 0.4 } },
  { name: "The Last Bookstore", hood: "la:downtown", lat: 34.0478, lon: -118.2496, cat: "Book Store", taste: { books: 1, vinyl: 0.4, art: 0.4 } },
  { name: "Supreme Los Angeles", hood: "la:fairfax", lat: 34.0786, lon: -118.3615, cat: "Clothing Store", taste: { streetwear: 1, skate: 0.8, sneakers: 0.5 } },
  { name: "Rough Trade East", hood: "lon:shoreditch", lat: 51.5212, lon: -0.0721, cat: "Record Store", taste: { vinyl: 1, indie: 0.9 } },
  { name: "Foyles", hood: "lon:soho", lat: 51.5145, lon: -0.1302, cat: "Book Store", taste: { books: 1, literary: 0.6, family: 0.3 } },
  { name: "Monmouth Coffee", hood: "lon:covent-garden", lat: 51.5143, lon: -0.1265, cat: "Coffee Shop", taste: { coffee: 1, food: 0.3 } },
  { name: "Daunt Books Marylebone", hood: "lon:marylebone", lat: 51.5208, lon: -0.1518, cat: "Book Store", taste: { books: 1, literary: 0.9, design: 0.5 } },
];

// ---- Fictional places per neighbourhood ------------------------------------------
const CATS: { cat: string; axis: Axis; words: string[]; extra: TasteVec }[] = [
  { cat: "Coffee Shop", axis: "coffee", words: ["Coffee", "Espresso Bar", "Roasters"], extra: { design: 0.3 } },
  { cat: "Record Store", axis: "vinyl", words: ["Records", "Vinyl", "Sound Shop"], extra: { indie: 0.5 } },
  { cat: "Book Store", axis: "books", words: ["Books", "Bookshop", "Reading Room"], extra: { literary: 0.6 } },
  { cat: "Bicycle Shop", axis: "cycling", words: ["Cycles", "Bike Works", "Wheelhouse"], extra: { outdoor: 0.3, coffee: 0.2 } },
  { cat: "Art Gallery", axis: "art", words: ["Gallery", "Projects", "Studio"], extra: { design: 0.4 } },
  { cat: "Clothing Store", axis: "streetwear", words: ["Supply", "Goods", "Outfitters"], extra: { fashion: 0.5 } },
  { cat: "Sneaker Store", axis: "sneakers", words: ["Kicks", "Sole Shop", "Laces"], extra: { streetwear: 0.5 } },
  { cat: "Skate Shop", axis: "skate", words: ["Skate", "Board Shop"], extra: { streetwear: 0.4 } },
  { cat: "Wine Bar", axis: "wine", words: ["Wine Bar", "Cellar", "Natural Wines"], extra: { food: 0.4 } },
  { cat: "Restaurant", axis: "food", words: ["Kitchen", "Canteen", "Table"], extra: { wine: 0.3 } },
  { cat: "Bar", axis: "nightlife", words: ["Tavern", "Lounge", "Social Club"], extra: { indie: 0.3 } },
  { cat: "Gym", axis: "fitness", words: ["Athletic Club", "Strength Lab"], extra: { outdoor: 0.2 } },
];
const ADJ = ["Copper", "Juniper", "Northside", "Lantern", "Paper", "Quiet", "Amber", "Harbor", "Ivy", "Marble", "Sparrow", "Cinder", "Gold Leaf", "Field", "Orchard", "Kettle", "Slow", "Low Tide", "Fern", "Signal", "Tandem", "Wren", "Oak & Ash", "Moth", "Second Story", "Velvet", "Common", "Saltbox", "Meridian", "Hollow"];

function vecAdd(...vs: TasteVec[]): TasteVec {
  const out: TasteVec = {};
  for (const v of vs) for (const a of AXES) if (v[a] !== undefined) out[a] = clamp01((out[a] ?? 0) + v[a]!);
  return out;
}

function jitter(seed: string, n: Neighborhood, km: number) {
  const r = rng(seed);
  const dLat = ((r() - 0.5) * 2 * km) / 111;
  const dLon = ((r() - 0.5) * 2 * km) / (111 * Math.cos((n.lat * Math.PI) / 180));
  return { lat: round(n.lat + dLat, 5), lon: round(n.lon + dLon, 5) };
}

function build(): WorldEntity[] {
  const out: WorldEntity[] = [];
  for (const s of SEEDS) {
    out.push({
      id: `fx:${s.type.split(":")[2]}:${slug(s.name)}${s.idSuffix ? `-${s.idSuffix}` : ""}`,
      name: s.name, type: s.type, taste: s.taste, popularity: s.popularity, disambiguation: s.disambiguation,
      tagIds: topAxes(s.taste).map((a) => TAGS.find((t) => t.axis === a && t.type !== "urn:tag:category:place")!.id),
    });
  }
  for (const p of REAL_PLACES) {
    const n = hood(p.hood);
    out.push({
      id: `fx:place:${slug(p.name)}`, name: p.name, type: "urn:entity:place", taste: p.taste, popularity: round(0.6 + noise(p.name) * 0.3),
      tagIds: [placeTag(p.cat)], neighborhoodId: n.id, lat: p.lat, lon: p.lon, address: `${n.name}, ${metroOf(n).name} (fixture address)`,
    });
  }
  const used = new Set<string>();
  for (const m of METROS) {
    for (const n of m.neighborhoods) {
      const scene = sceneOf(n.id);
      // The 7 categories that fit this scene best get one fictional place each.
      const cats = [...CATS].sort((a, b) => scene[b.axis] - scene[a.axis] || a.cat.localeCompare(b.cat)).slice(0, 7);
      const r = rng(`places:${n.id}`);
      for (const c of cats) {
        let name = "";
        do name = `${ADJ[Math.floor(r() * ADJ.length)]} ${c.words[Math.floor(r() * c.words.length)]}`; while (used.has(`${m.id}:${name}`));
        used.add(`${m.id}:${name}`);
        const taste = vecAdd({ [c.axis]: 0.75 + r() * 0.25 }, c.extra, Object.fromEntries(AXES.map((a) => [a, scene[a] * 0.25])) as TasteVec);
        const p = jitter(`place:${n.id}:${name}`, n, n.radiusKm * 0.8);
        out.push({
          id: `fx:place:${m.id}-${slug(n.name)}-${slug(name)}`, name, type: "urn:entity:place", taste,
          popularity: round(0.15 + r() * 0.55), tagIds: [placeTag(c.cat)], neighborhoodId: n.id, ...p,
          address: `${n.name}, ${m.name} (fixture address)`,
        });
      }
    }
  }
  for (const [name, taste] of PARTNER_BRANDS) {
    out.push({ id: `fx:brand:${slug(name)}`, name, type: "urn:entity:brand", taste, popularity: round(0.2 + noise(name) * 0.5), tagIds: topAxes(taste).map((a) => TAGS.find((t) => t.axis === a && t.type !== "urn:tag:category:place")!.id), disambiguation: "Fictional fixture brand" });
  }
  return out;
}

// Fictional partner brands. "(fixture)" stays in the name so no one mistakes them for real affinity data.
const PARTNER_BRANDS: [string, TasteVec][] = [
  ["Tandem Bicycle Co. (fixture)", { cycling: 0.9, design: 0.5, outdoor: 0.4 }],
  ["Slow Pour Ceramics (fixture)", { coffee: 0.7, design: 0.8 }],
  ["Groove Hi-Fi (fixture)", { vinyl: 0.9, indie: 0.6, design: 0.4 }],
  ["Northline Outerwear (fixture)", { outdoor: 0.9, cycling: 0.4, fashion: 0.3 }],
  ["Kerb Skate Supply (fixture)", { skate: 0.9, streetwear: 0.7 }],
  ["Laceless Sneaker Lab (fixture)", { sneakers: 0.9, streetwear: 0.6, hiphop: 0.4 }],
  ["Marginalia Press (fixture)", { books: 0.8, literary: 0.9 }],
  ["Inkwell Stationery (fixture)", { books: 0.6, design: 0.7, literary: 0.4 }],
  ["Orchard Natural Wine (fixture)", { wine: 0.9, food: 0.6 }],
  ["Field Day Granola (fixture)", { food: 0.7, fitness: 0.5, coffee: 0.4, family: 0.4 }],
  ["Static Radio (fixture)", { indie: 0.8, vinyl: 0.6, nightlife: 0.4 }],
  ["Studio Common Furniture (fixture)", { design: 0.9, luxury: 0.4 }],
  ["Halfpipe Energy (fixture)", { skate: 0.6, fitness: 0.6, hiphop: 0.3 }],
  ["Atelier Nine (fixture)", { fashion: 0.9, luxury: 0.7, streetwear: 0.3 }],
];

function topAxes(v: TasteVec, n = 3, min = 0.35): Axis[] {
  return AXES.filter((a) => (v[a] ?? 0) >= min).sort((a, b) => (v[b] ?? 0) - (v[a] ?? 0)).slice(0, n);
}

function hood(id: string): Neighborhood {
  for (const m of METROS) for (const n of m.neighborhoods) if (n.id === id) return n;
  throw new Error(`fixture world: unknown neighbourhood ${id}`);
}

export function metroOf(n: Neighborhood): Metro {
  return METROS.find((m) => m.id === n.metroId)!;
}

export const WORLD: WorldEntity[] = build();
export const BY_ID = new Map(WORLD.map((e) => [e.id, e]));
/** Names a user can type in fixture mode (shown under the form). */
export const SEED_NAMES = [...new Set(SEEDS.map((s) => s.name))];

// ---------------------------------------------------------------------------

export function cosine(a: TasteVec, b: TasteVec): number {
  let dot = 0, na = 0, nb = 0;
  for (const k of AXES) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The audience vector for a set of signal entities and signal tags: the mean of their vectors. */
export function audienceVec(entityIds: string[], tagIds: string[]): TasteVec {
  const vs: TasteVec[] = [];
  for (const id of entityIds) { const e = BY_ID.get(id); if (e) vs.push(e.taste); }
  for (const id of tagIds) { const t = TAG_BY_ID.get(id); if (t) vs.push({ [t.axis]: 1 }); }
  const out: TasteVec = {};
  if (!vs.length) return out;
  for (const a of AXES) out[a] = vs.reduce((s, v) => s + (v[a] ?? 0), 0) / vs.length;
  return out;
}

/** Affinity of an audience for an entity, 0..1, deterministic. */
export function affinity(audience: TasteVec, target: WorldEntity, salt: string): number {
  return round(clamp01(0.12 + cosine(audience, target.taste) * 0.78 + (noise(`${salt}|${target.id}`) - 0.5) * 0.12));
}

/** Neighbourhood-level heat for an audience, 0..1. */
export function neighborhoodHeat(audience: TasteVec, n: Neighborhood, salt: string): number {
  const fit = clamp01((cosine(audience, sceneOf(n.id)) - 0.4) / 0.4);
  return round(clamp01(0.16 + 0.84 * fit + (noise(`${salt}|${n.id}`) - 0.5) * 0.1));
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineKm(a, b);
}
