import { describe, expect, it } from "vitest";
import { parseBaseline, runBaseline, scoreBaseline, verifyBaseline } from "../src/agent/baseline";
import { QlooClient } from "../src/qloo/client";
import { fixtureTransport } from "../src/qloo/fixtures/transport";
import { ScriptedProvider } from "../src/llm/scripted";
import { EXAMPLES } from "../src/server/app";
import type { LLMProvider } from "../src/llm/types";
import type { SiteRequest } from "../src/shared/types";

const q = () => new QlooClient({ transport: fixtureTransport(), paramMode: "strict" });
const [COFFEE, STREET, BOOKS] = [EXAMPLES[0]!, EXAMPLES[1]!, EXAMPLES[2]!] as [SiteRequest, SiteRequest, SiteRequest];

describe("baseline parsing", () => {
  it("reads JSON inside a code fence with prose around it", () => {
    const s = parseBaseline('Sure!\n```json\n{"sites":[{"neighborhood":"Wicker Park","anchors":["A","B"]}]}\n```\nGood luck.');
    expect(s).toEqual([{ neighborhood: "Wicker Park", anchors: ["A", "B"], reason: undefined }]);
  });
  it("reads bare JSON", () => {
    expect(parseBaseline('{"sites":[{"neighborhood":"Soho","anchors":[]}]}')).toHaveLength(1);
  });
  it("fails loudly on non-JSON", () => {
    expect(() => parseBaseline("Open in Wicker Park.")).toThrow(/not valid JSON/);
  });
});

describe("baseline verification against Qloo", () => {
  it("separates real places in the right area, real places elsewhere and invented places", async () => {
    const sites = await verifyBaseline(
      [
        { neighborhood: "Wicker Park", anchors: ["Reckless Records", "Copperline Coffee Bar"] },
        { neighborhood: "Logan Square", anchors: ["Myopic Books"] },
        { neighborhood: "Atlantis Heights", anchors: [] },
      ],
      COFFEE,
      q(),
    );
    expect(sites[0]!.checkedAnchors.map((a) => a.verdict)).toEqual(["verified", "not_found"]);
    expect(sites[1]!.checkedAnchors[0]!.verdict).toBe("wrong_area");
    expect(sites[0]!.areaVerdict).toBe("hot");
    expect(sites[2]!.areaVerdict).toBe("unknown");
    expect(scoreBaseline(sites)).toMatchObject({ areas: 3, anchors: 3, anchorsVerified: 1, anchorsWrongArea: 1, anchorsNotFound: 1 });
  });

  it.each([COFFEE, STREET, BOOKS])("dry-run uses the labelled illustrative fixture for $brand", async (req) => {
    const r = await runBaseline(req, { llm: new ScriptedProvider(), qloo: q() });
    expect(r.source).toBe("illustrative-fixture");
    expect(r.sites).toHaveLength(3);
    expect(r.score.anchorsVerified).toBeLessThan(r.score.anchors);
    expect(r.score.areasHot).toBeLessThan(r.score.areas);
  });

  it("dry-run without a fixture says so", async () => {
    const qc = q();
    const r = await runBaseline({ ...COFFEE, brand: "Unknown Brand" }, { llm: new ScriptedProvider(), qloo: qc });
    expect(r).toMatchObject({ source: "unavailable", sites: [], score: { areas: 0, anchors: 0 } });
    expect(r.note).toMatch(/no LLM/);
    expect(qc.calls).toHaveLength(0);
  });

  it("live mode sends the brief to the model with no tools", async () => {
    let prompt = "";
    const llm: LLMProvider = {
      id: "fake", dryRun: false,
      startSession: () => { throw new Error("no"); },
      complete: async (o) => { prompt = o.prompt; return '{"sites":[{"neighborhood":"Fairfax","anchors":["Supreme Los Angeles"]}]}'; },
    };
    const r = await runBaseline({ ...STREET, sites: 1 }, { llm, qloo: q() });
    expect(prompt).toMatch(/pop-up in Los Angeles/);
    expect(prompt).toMatch(/1 best neighbourhoods/);
    expect(r.source).toBe("live");
    expect(r.sites[0]!.checkedAnchors[0]!.verdict).toBe("verified");
  });
});
