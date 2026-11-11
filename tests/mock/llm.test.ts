import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LlmError, ollamaLlm, ollamaUnload } from "../../src/agent/llm";

// MOCK: a tiny fake Ollama on localhost, to check what we send and how we read the answers.

type Seen = { path: string; body: Record<string, unknown> };
let server: Server;
afterEach(() => server?.close());

async function fakeOllama(reply: (req: Seen, n: number) => { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { path: req.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      seen.push(s);
      const r = reply(s, seen.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const answer = (content: string) => ({ status: 200, body: { message: { content } } });

describe("ollamaLlm", () => {
  it("asks for JSON in the given shape, temperature 0, with thinking turned off", async () => {
    const { url, seen } = await fakeOllama(() => answer('{"ok":true}'));
    const text = await ollamaLlm(url, "qwen3:8b")([{ role: "user", content: "hi" }], { type: "object" });
    expect(text).toBe('{"ok":true}');
    expect(seen[0]).toMatchObject({ path: "/api/chat", body: { model: "qwen3:8b", stream: false, think: false, format: { type: "object" }, options: { temperature: 0 } } });
  });

  it("retries without 'think' for a model that has no thinking to turn off (Windows fix 74d3483)", async () => {
    const { url, seen } = await fakeOllama((req) =>
      "think" in req.body ? { status: 400, body: { error: '"qwen3:4b-instruct" does not support thinking' } } : answer("{}"),
    );
    const llm = ollamaLlm(url, "qwen3:4b-instruct");
    expect(await llm([{ role: "user", content: "a" }], {})).toBe("{}");
    expect(await llm([{ role: "user", content: "b" }], {})).toBe("{}");
    expect(seen.map((s) => "think" in s.body)).toEqual([true, false, false]); // remembered after the first refusal
  });

  it("says so clearly when the answer is empty (what gpt-oss:20b did)", async () => {
    const { url } = await fakeOllama(() => answer(""));
    await expect(ollamaLlm(url, "gpt-oss:20b")([{ role: "user", content: "a" }], {})).rejects.toThrow(LlmError);
  });

  it("points at 'ollama pull' when the model isn't there", async () => {
    const { url } = await fakeOllama(() => ({ status: 404, body: { error: "model not found" } }));
    await expect(ollamaLlm(url, "nope:1b")([{ role: "user", content: "a" }], {})).rejects.toThrow(/ollama pull nope:1b/);
  });
});

describe("ollamaUnload", () => {
  it("asks Ollama to unload the model now, so the next plan starts cold", async () => {
    const { url, seen } = await fakeOllama(() => ({ status: 200, body: { done: true } }));
    await ollamaUnload(url, "qwen3:8b");
    expect(seen).toEqual([{ path: "/api/generate", body: { model: "qwen3:8b", keep_alive: 0 } }]);
  });

  it("never fails the run when Ollama can't be reached", async () => {
    await expect(ollamaUnload("http://127.0.0.1:9", "qwen3:8b")).resolves.toBeUndefined();
  });
});
