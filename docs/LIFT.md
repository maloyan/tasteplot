# Popularity bias: ranking by lift

**Measured on 2026-10-06** with the live hackathon API and the scripted planner ($0 LLM).

## The problem

The Qloo heatmap's `query.affinity` follows general activity. Inside one heatmap it
correlates 0.92 to 0.97 with `query.popularity`. Busy central areas got the highest raw
heat for every audience. River North won in Chicago for coffee people and for outdoor
people alike, and Downtown LA won for streetwear.

## The fix

The main metro gets a second heatmap call: the **baseline**. It uses the same metro and a
generic audience, the fans of restaurants (`signal.interests.tags=urn:tag:genre:place:restaurant`).
That heat is the metro's general going-out activity. Code then does this:

1. Keep the heatmap cells that both responses share (a geohash join). In the sample runs,
   all audience cells had a baseline match.
2. Re-rank both heatmaps 0..1 on those shared cells.
3. Per neighbourhood: `lift = (mean audience rank + 0.05) / (mean baseline rank + 0.05)`.
   1.0 = the same as the general going-out crowd.
4. Rank neighbourhoods by lift. A neighbourhood needs raw heat >= 0.5 to rank by lift,
   because lift on a cold area is noise.
5. Site score = 0.6 x taste fit + 0.4 x mean affinity of the top 3 anchors. Taste fit =
   lift / 2, capped at 1, so 1.0x = 0.5 and 2x = 1.

The site cards show both values: **Taste heat (raw)** and **Lift vs baseline** (with the
baseline heat in the tooltip). The card header shows the lift rank and the raw heat rank.
The baseline call is cached for 7 days per metro, so it costs about 1 Qloo call per metro
per week. If it fails, the ranking falls back to raw heat and the run logs a warning.

## Choice of baseline

We tried three baselines on the same recorded audience heatmaps:

| Baseline | Result | Verdict |
|---|---|---|
| `query.popularity` inside the audience's own heatmap (0 extra calls) | Lift 0.93 to 1.07 everywhere. Popularity and affinity move together, so lift is noise. | Rejected |
| All ages (`signal.demographics.age` = all six buckets) | LA and London change, but River North still has the top lift for both Chicago audiences. This heat follows where people live, not where they go out. | Rejected |
| Fans of restaurants (`urn:tag:genre:place:restaurant`) | Downtown areas drop in every metro, and the two Chicago audiences get different neighbourhoods. | **Used** |

A heatmap with no signal returns HTTP 400 ("at least one valid signal ... is required").

## Before and after (live, 2026-10-06)

"Before" is commit `e6175ad` (rank by raw heat). "After" is this version. Same requests,
same day.

| Sample | Top 5 by raw heat (before) | Top 5 by lift (after) | Sites before | Sites after |
|---|---|---|---|---|
| Quietcup Coffee Roasters, Chicago (specialty coffee, cycling, record stores) | River North, Wicker Park, Logan Square, West Loop, Lincoln Park | Wicker Park 1.27x, Logan Square 1.26x, Bucktown 1.23x, Lincoln Park 1.11x, Andersonville 1.11x | River North, Wicker Park, Logan Square | **Wicker Park, Logan Square, Bucktown** |
| Switchback Outfitters, Chicago (Patagonia brand, Rapha, outdoors, cycling) | River North, West Loop, Wicker Park, Lakeview, Lincoln Park | Bucktown 1.14x, Lincoln Park 1.10x, Lakeview 1.09x, Andersonville 1.06x, Wicker Park 1.04x | River North, West Loop | **Bucktown, Lincoln Park** |
| Lowtide Supply Co., Los Angeles (streetwear, sneakers, skateboarding) | Downtown, Fairfax, Arts District, Venice, Hollywood | Silver Lake 1.15x, Culver City 1.14x, Koreatown 1.10x, Arts District 1.07x, Fairfax 1.06x | Downtown, Fairfax, Arts District | **Silver Lake, Culver City, Koreatown** |
| Folio & Fern Books, London (literary fiction, bookstores, natural wine) | Dalston, Marylebone, Islington, Hackney, Notting Hill | Dalston 1.95x, Hackney 1.70x, Islington 1.59x, Notting Hill 1.44x, Marylebone 1.41x | Marylebone, Dalston, Islington | **Dalston, Hackney, Islington** |

What changed:

- **Downtowns no longer win by default.** River North (Chicago), Downtown (LA) and
  Marylebone (London) left the site lists. Their raw heat stays high, but their lift is
  close to 1: everybody goes there.
- **Rankings now differ by audience in the same metro.** In Chicago, coffee and record-store
  people lead in Wicker Park and Logan Square. Outdoor and cycling people lead in Bucktown,
  Lincoln Park and Lakeview. Before, both lists started with River North.
- **The picks make sense for the brief.** East London (Dalston, Hackney) for literary
  fiction and natural wine. Silver Lake and Culver City for a streetwear pop-up.

Limits:

- LA lifts are small (1.06x to 1.15x). Fairfax, the best-known streetwear street, is 5th by
  lift (1.06x) because it is also busy for everyone. A brand that wants foot traffic more
  than a taste match can read the raw heat chip on each card.
- Lift compares ranks, not absolute affinity, because Qloo's `query.affinity` is itself a
  rank inside each response.
- Only the main metro gets a baseline. The metro comparison (Compare tab) still uses raw
  heat, since both sides are measured the same way.

Reproduce: `npx tsx --env-file=.env scripts/live-demo.ts` prints both orders for each
sample (about 76 Qloo calls, $0 LLM).
