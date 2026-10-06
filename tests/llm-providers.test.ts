import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/llm/anthropic";
import { OpenAICompatibleProvider } from "../src/llm/openai-compatible";
import { createProvider } from "../src/llm";

function fakeFetch(responses: unknown[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) });
    const body = responses[calls.length - 1];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  return { f: f as typeof fetch, calls };
}

const msg = (content: unknown[], stop_reason: string) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("AnthropicProvider", () => {
  it("builds the request and keeps assistant content in history unchanged", async () => {
    const thinking = { type: "thinking", thinking: "Resolve first.", signature: "sig-abc" };
    const { f, calls } = fakeFetch([
      msg([thinking, { type: "tool_use", id: "tu_1", name: "resolve_audience", input: { seeds: ["Rapha"], keywords: ["cycling"] } }], "tool_use"),
      msg([{ type: "text", text: "Done." }], "end_turn"),
    ]);
    const p = new AnthropicProvider({ apiKey: "test-key", fetch: f });
    const s = p.startSession({ system: "SYS", tools: [{ name: "resolve_audience", description: "d", input_schema: { type: "object", properties: {} } }] });
    const t1 = await s.next({ userText: "go" });
    expect(t1).toMatchObject({ stop: "tool_use", toolCalls: [{ id: "tu_1", name: "resolve_audience", input: { seeds: ["Rapha"], keywords: ["cycling"] } }] });
    expect(t1.text).toContain("Resolve first.");
    await s.next({ toolResults: [{ id: "tu_1", content: '{"status":"ok"}' }] });

    const b1 = calls[0]!.body;
    expect(b1.model).toBe("claude-opus-5-5");
    expect(b1.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(b1.output_config).toEqual({ effort: "medium" });
    expect(b1.fallbacks).toBe("default");
    expect(b1.tool_choice).toEqual({ type: "auto" });
    expect(b1.betas).toBeUndefined(); // betas go in the header, not the body
    expect(calls[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(calls[0]!.headers.get("x-api-key")).toBe("test-key");

    const b2 = calls[1]!.body;
    expect(b2.messages).toHaveLength(3);
    expect(b2.messages[1]).toEqual({ role: "assistant", content: [thinking, { type: "tool_use", id: "tu_1", name: "resolve_audience", input: { seeds: ["Rapha"], keywords: ["cycling"] } }] });
    expect(b2.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"status":"ok"}' }] });
  });

  it("maps a refusal", async () => {
    const { f } = fakeFetch([msg([], "refusal")]);
    const s = new AnthropicProvider({ apiKey: "k", fetch: f }).startSession({ system: "", tools: [] });
    expect((await s.next({ userText: "x" })).stop).toBe("refusal");
  });
});

describe("OpenAICompatibleProvider", () => {
  it("maps tool calls and tool results", async () => {
    const { f, calls } = fakeFetch([
      { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "map_taste_heat", arguments: '{"metro_id":"chi"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    ]);
    const p = new OpenAICompatibleProvider({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m", fetch: f });
    const s = p.startSession({ system: "SYS", tools: [{ name: "map_taste_heat", description: "d", input_schema: { type: "object" } }] });
    const t = await s.next({ userText: "go" });
    expect(t.toolCalls).toEqual([{ id: "c1", name: "map_taste_heat", input: { metro_id: "chi" } }]);
    await s.next({ toolResults: [{ id: "c1", content: "{}" }] });
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[1]!.body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "{}" });
  });
});

describe("createProvider", () => {
  it("defaults to the $0 scripted provider, even when a key is present", () => {
    expect(createProvider({}).dryRun).toBe(true);
    expect(createProvider({ ANTHROPIC_API_KEY: "k" }).dryRun).toBe(true);
  });
  it("needs both LLM_PROVIDER and the key for live spend", () => {
    expect(() => createProvider({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(createProvider({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).id).toBe("anthropic:claude-opus-5-5");
  });
});
