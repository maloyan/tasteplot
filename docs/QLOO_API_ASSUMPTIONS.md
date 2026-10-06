# Qloo API: what Tasteplot relies on

**Verified on 2026-10-06** against the live hackathon API (`https://hackathon.api.qloo.com`)
with a hackathon key. About 50 probe calls plus one full live run of each sample brief.

Tasteplot was built before the key arrived, on a fixture world in the documented shapes. Every
response goes through one adapter in `src/qloo/types.ts`. This page lists each item the app
relies on and what the live API showed.

Status tags:

- **CONFIRMED**: the live API behaves as the docs and the first adapter assumed.
- **DIFFERENT**: the live API differs. The fix is named.
- **UNSUPPORTED**: the live API rejects it or ignores it. Tasteplot does not use it.

Evidence:

- Curated live responses, a few KB each: `fixtures/qloo/recorded/<brief>/` (committed).
  `tests/recorded.test.ts` runs every adapter on them.
- Full raw responses: `fixtures/qloo/recorded/raw/` (gitignored, local only).
- Re-record: `npx tsx --env-file=.env scripts/live-demo.ts --record` (about 75 Qloo calls, $0 LLM).

## Transport

| Item | Live result | Status |
|---|---|---|
| Base URL `https://hackathon.api.qloo.com` | Works. | CONFIRMED |
| Auth header `X-Api-Key` | Works. The key is only a header, so it never reaches a recorded file. | CONFIRMED |
| GET with query-string parameters, comma lists | Works. | CONFIRMED |
| Rate limit | Headers: `x-second-ratelimit-limit: 5`, `x-month-ratelimit-limit: 10000`, and `x-month-ratelimit-remaining` on every reply. The transport starts at most 4 requests per second and still retries 429 and 5xx. | DIFFERENT (now known). Fix: `maxPerSecond` in `src/qloo/transport.ts`. The server reads `x-month-ratelimit-remaining` for its quota guard (`src/server/quota.ts`). |
| Invalid parameters ignored with 200 OK | Seen: `filter.location` on brands and `take` on heatmaps are ignored. | CONFIRMED |

## Items checked

| # | Item | Live result | Status | Change |
|---|---|---|---|---|
| 1 | **Place coordinates** | Places carry `location: { lat, lon, geohash }` (in `/search` and in insights). Insights places with `filter.location` also carry `query.distance` in metres. | CONFIRMED (the adapter already read `location.lat/lon`) | None. The map pins real coordinates now. |
| 2 | **`feature.explainability` keys** | `query.explainability = { "signal.interests.entities": [{ entity_id, score }] }`. Only entity signals get an entry; tag signals get none. Works on places and brands. | CONFIRMED (list shape) | Comments only. Scores are 0.27 to 0.51 in the sample runs. |
| 3 | **`/v2/analysis/compare` response** | `results.tags` = tags both sides share, each with `query.score`. `results.a` and `results.b` = each side's tags, each with `query.count` (a string). Also `results.matchEntities: []`. No per-side affinity. | DIFFERENT | `adaptCompare` returns `{ shared, a, b }`. `compare_audiences`: a tag leans to a side when only that side has it; overlap = shared tags / all tags. The empty-result warning now counts all three lists. |
| 4 | **`urn:demographics` on the hackathon host** | Supported. It returns **one item per signal** (each entity and each tag), not one item for the audience. | CONFIRMED (supported); DIFFERENT (one item per signal) | `adaptDemographics` averages the items per age and gender bucket. Before, it read only the first signal. |
| 5a | **Heatmap default size** | 1,700 to 3,600 cells per metro. `take` is ignored (`take=50` still gave 1,762 cells). | DIFFERENT | The client sends no `take`. All cells rank the neighbourhoods; only the hottest 700 go to the map, to keep the plan small. |
| 5b | **Heatmap cell size and values** | Geohash cells of 7 characters in Chicago and 6 in Los Angeles and London. `query.affinity` is a 0..1 rank inside the metro, and the cells come sorted by it. It correlates 0.92 to 0.97 with `query.popularity`, so busy central areas run hot. | DIFFERENT (cell size varies) | Gazetteer snapping already worked with any cell size. See "Limits" in the README. |
| 5d | **Heatmap baseline for lift** | A heatmap with no signal returns 400 ("at least one valid signal and filter.location or filter.location.query is required"). `signal.demographics.age` alone (all six buckets) works, and so does one broad tag: `signal.interests.tags=urn:tag:genre:place:restaurant`. Both return all cells for the metro (Chicago: 8,078 and 9,508 cells), with the same geohash size as the audience heatmap, so the cells join on geohash. | CONFIRMED | `baselineHeatmap` uses the restaurant tag. The all-ages baseline kept downtown River North on top for every Chicago audience. See [LIFT.md](LIFT.md). |
| 5c | **`output.heatmap.boundary`** | Only `"urn:geohash"` or `"urn:entity:locality"` are accepted (`neighborhood` and `city` give 400). `urn:entity:locality` gave HTTP 500 for Chicago. | UNSUPPORTED (for named areas) | Not sent. Tasteplot keeps its own neighbourhood gazetteer. |
| 6a | **`filter.location` WKT + radius on places** | `POINT(lon lat)` works; `POINT(lat lon)` returns 0 results. Radius is in metres: with 300 every result was within 250 m, with 1,200 within 800 m. | CONFIRMED | None. |
| 6b | **`filter.location` on brands** | Ignored: the same brands with and without it. `signal.location` (WKT point) does change the brand ranking. | UNSUPPORTED (`filter.location`); `signal.location` CONFIRMED | `find_partner_brands` now sends `signal.location` = the neighbourhood centre, with `signal.location.radius`. The param check allows these two on brands. The separate effect of the radius is not measured. |
| 7 | **Tags search `/v2/tags`** | Shape `{ results: { tags: [{ id, name, type, popularity, parents[] }] } }`. It matches on any word, so "independent bookstores" returns the music genre "Independent" first, and "vinyl records" returns "Vinyl sign shop". | CONFIRMED (shape); DIFFERENT (matching) | New `pickTag`: a tag counts only if its name has every word of the keyword. The samples now use "record stores" and "bookstores", which match Qloo tags exactly. |
| 8 | **`/search` for seeds** | Without `types`, "Starbucks", "Nike", "Supreme" and "Waterstones" return mostly single stores, and "Blue Bottle Coffee" returns only stores. One name often matches one thing in several types (Murakami: author, artist, person). `types` takes a comma list; the allowed values include `urn:entity:author`, `urn:entity:locality` and `urn:entity:videogame` (not `video_game`). | DIFFERENT | Seeds are looked up with `SEED_TYPES` (no `urn:entity:place`), then `pickEntity` keeps the best entity per type and prefers brand > artist > author > person. It asks only when a locality and a taste entity match with similar popularity ("Patagonia": region and brand). A name with no match gets a second lookup that includes places. |
| 9 | **Insights entity `type`** | `type` is `"urn:entity"`; the real type is in `subtype` (`urn:entity:place`, `urn:entity:brand`). `/search` uses `types: [...]`. | DIFFERENT | The adapter reads `subtype` first. |

## Calls per plan (live, scripted planner)

| Brief | Qloo calls |
|---|---|
| Quietcup Coffee Roasters (Chicago, compare New York, second audience) | 22 |
| Lowtide Supply Co. (Los Angeles, second audience) | 21 |
| Folio & Fern Books (London, second audience) | 21 |
| Switchback Outfitters (after the Patagonia pick) | 15 |

Each count includes the baseline heatmap (1 call, cached 7 days per metro). At 10,000 calls a
month, the key covers about 450 fresh plans. Sample plans, cached plans and cached Qloo
responses cost nothing. The public demo caps fresh calls at 250 a day (README, "Quota protection").

## What breaks if Qloo changes a shape

| Change | Visible effect | Where to fix |
|---|---|---|
| Field name in a response | `tests/recorded.test.ts` fails on re-record; live: the trace shows `0 results` and the run warns `empty result` | `src/qloo/types.ts` |
| Parameter name | 200 OK with empty or unfiltered results | `src/qloo/client.ts`, `src/qloo/params.ts` |
| Endpoint path | `QlooHttpError 404` in the trace step | `PATHS` in `src/qloo/client.ts` |
| Metro name not geocoded | 400 from the heatmap step; the trace shows the error | `query` in `src/shared/metros.ts` |
| Cells far from any gazetteer neighbourhood | Shown on the map, not ranked | `src/shared/metros.ts` |
