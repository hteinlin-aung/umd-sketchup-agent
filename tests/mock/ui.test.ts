import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, type UiEvent } from "../../src/ui/server";

// A small stand-in for `npm run agent`: it prints the same kinds of lines and asks the same two questions.
const FAKE_AGENT = `
import { createInterface } from "node:readline";
const lines = []; const waiting = [];
createInterface({ input: process.stdin }).on("line", (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
// Like src/cli/terminal.ts: an answer that is piped in is written back, which also ends the question's line.
const ask = (q) => { process.stdout.write(q); return new Promise((r) => { const got = (l) => { process.stdout.write(l + "\\n"); r(l); }; const l = lines.shift(); if (l !== undefined) got(l); else waiting.push(got); }); };
console.log("args: " + JSON.stringify(process.argv.slice(2)));
console.log("model open: UMD_DEV_TEST.skp");
if (process.argv.includes("--dry")) { console.log("\\nOUTCOME: NOT RUN\\n  - plan only"); console.log("Plan only (--dry). Everything is in runs/agent_20260101_000000/"); process.exit(0); }
const pick = await ask("Pick 1-2 (Enter = 1): ");
console.log("picked " + JSON.stringify(pick));
const yes = await ask("Run these 2 actions on UMD_DEV_TEST.skp? Type y to run, anything else to stop: ");
if (yes !== "y") { console.log("\\nOUTCOME: BLOCKED\\n  - you stopped it before anything ran"); process.exit(0); }
console.log("  ok  [1] built (3 ms)");
console.error("a line on stderr");
console.log("\\nOUTCOME: SUCCESS\\n  - saved");
process.exit(0);
`;

let root: string;
let ui: ReturnType<typeof createUiServer>;
let base: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "umd-ui-"));
  mkdirSync(join(root, "instructions"));
  mkdirSync(join(root, "runs", "agent_20260101_000000"), { recursive: true });
  mkdirSync(join(root, "secret"));
  writeFileSync(join(root, "instructions", "1F_test.md"), "# 1F Test - a brief\n\nModel: `dev/UMD_DEV_TEST.skp`\nRoom group: `1F TEST ROOM (T1)`\n\n## Changes for now\n\n1. **A.** x\n\n2. **B.** y\n");
  writeFileSync(join(root, "instructions", "1F_test.draft.json"), "{}");
  writeFileSync(join(root, "instructions", "other.draft.json"), "{}");
  writeFileSync(join(root, "runs", "agent_20260101_000000", "report.md"), "# Agent run\n\n## Outcome: **SUCCESS**\n");
  writeFileSync(join(root, "runs", "agent_20260101_000000", "shot.png"), "png");
  writeFileSync(join(root, "secret", "x.png"), "png");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "page.html"), "<p>page</p>");
  writeFileSync(join(root, "fake.mjs"), FAKE_AGENT);
  ui = createUiServer({ root, pagePath: join(root, "page.html"), agentCommand: (args) => ({ cmd: process.execPath, args: [join(root, "fake.mjs"), ...args] }) });
  base = `http://127.0.0.1:${await ui.listen(0)}`;
});
afterEach(() => ui.close());

const get = (path: string) => fetch(base + path);
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Follows the live events until `until` says stop (or the run ends). */
async function follow(until: (e: UiEvent) => boolean = (e) => e.type === "end"): Promise<UiEvent[]> {
  const res = await get("/api/events");
  const reader = res.body!.getReader();
  const seen: UiEvent[] = [];
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return seen;
    text += new TextDecoder().decode(value);
    const parts = text.split("\n\n");
    text = parts.pop() ?? "";
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      const e = JSON.parse(p.slice(6)) as UiEvent;
      seen.push(e);
      if (until(e)) {
        await reader.cancel();
        return seen;
      }
    }
  }
}
const lines = (events: UiEvent[]) => events.flatMap((e) => (e.type === "line" ? [e.text] : []));

describe("the agent page (server)", () => {
  it("lists the briefs with their room, changes and drafts", async () => {
    const briefs = (await (await get("/api/briefs")).json()) as unknown[];
    expect(briefs).toEqual([{ file: "1F_test.md", title: "1F Test - a brief", room: "1F TEST ROOM (T1)", model: "dev/UMD_DEV_TEST.skp", changes: 2, drafts: ["1F_test.draft.json"] }]);
  });

  it("a plan-only run passes --dry and ends with the outcome and the run folder", async () => {
    expect((await post("/api/run", { brief: "1F_test.md", room: "1F TEST", mode: "dry", mock: true })).status).toBe(200);
    const events = await follow();
    expect(lines(events)[0]).toBe('args: ["instructions/1F_test.md","1F TEST","--dry","--mock"]');
    expect(events.at(-1)).toEqual({ type: "end", code: 0, outcome: "NOT RUN", runDir: "agent_20260101_000000" });
  });

  it("turns the two questions into events and sends the answers to the agent", async () => {
    await post("/api/run", { brief: "1F_test.md", room: "1F TEST", mode: "run", draft: "1F_test.draft.json" });
    const first = await follow((e) => e.type === "question");
    expect(first.at(-1)).toEqual({ type: "question", kind: "pick", text: "Pick 1-2 (Enter = 1):", max: 2 });
    expect((await post("/api/answer", { text: "3" })).status).toBe(400); // only 1 or 2
    expect((await post("/api/answer", { text: "2" })).status).toBe(200);
    const second = await follow((e) => e.type === "question" && e.kind === "approve");
    expect(lines(second)).toContain('picked "2"');
    expect((await post("/api/answer", { text: "yes please" })).status).toBe(400); // only y or n
    await post("/api/answer", { text: "y" });
    const all = await follow();
    expect(lines(all)).toContain("  ok  [1] built (3 ms)");
    expect(lines(all)).toContain("a line on stderr");
    expect(lines(all)[0]).toBe('args: ["instructions/1F_test.md","1F TEST","--draft","instructions/1F_test.draft.json"]');
    expect(all.at(-1)).toMatchObject({ type: "end", outcome: "SUCCESS" });
    expect((await post("/api/answer", { text: "y" })).status).toBe(409); // nothing is waiting any more
  });

  it('"n" stops the run before anything is built', async () => {
    await post("/api/run", { brief: "1F_test.md", room: "1F TEST", mode: "run" });
    await follow((e) => e.type === "question");
    await post("/api/answer", { text: "" }); // Enter keeps the agent's pick
    await follow((e) => e.type === "question" && e.kind === "approve");
    await post("/api/answer", { text: "n" });
    const all = await follow();
    expect(all.at(-1)).toMatchObject({ type: "end", outcome: "BLOCKED" });
    expect(lines(all).some((l) => l.includes("built"))).toBe(false);
  });

  it("only one run at a time", async () => {
    await post("/api/run", { brief: "1F_test.md", room: "1F TEST", mode: "run" });
    expect((await post("/api/run", { brief: "1F_test.md", room: "1F TEST", mode: "dry" })).status).toBe(409);
  });

  it("refuses anything that is not a brief in instructions/", async () => {
    for (const brief of ["../.env", "..\\.env", "/etc/passwd", "nope.md", "1F_test.draft.json", 5]) {
      expect((await post("/api/run", { brief, room: "x", mode: "dry" })).status, String(brief)).toBeGreaterThanOrEqual(400);
    }
    expect((await post("/api/run", { brief: "1F_test.md", room: "", mode: "dry" })).status).toBe(400);
    expect((await post("/api/run", { brief: "1F_test.md", room: "x", mode: "dry", draft: "../.env" })).status).toBe(400);
    expect((await get("/api/brief?file=../.env")).status).toBe(400);
  });

  it("shows run files and pictures only from the agent's own folders", async () => {
    const runs = (await (await get("/api/runs")).json()) as { run: string; outcome: string }[];
    expect(runs[0]).toMatchObject({ run: "agent_20260101_000000", outcome: "SUCCESS" });
    expect((await get("/api/run-file?run=agent_20260101_000000&file=report.md")).status).toBe(200);
    expect((await get("/api/run-file?run=agent_20260101_000000&file=shot.png")).status).toBe(400);
    expect((await get("/api/run-file?run=..&file=report.md")).status).toBe(400);
    expect((await get("/api/image?path=runs/agent_20260101_000000/shot.png")).status).toBe(200);
    expect((await get("/api/image?path=secret/x.png")).status).toBe(403);
    expect((await get("/api/image?path=runs/../secret/x.png")).status).toBe(403);
    expect((await get("/api/image?path=.env")).status).toBe(403);
  });

  it("answers only requests made from this computer's own page", async () => {
    const other = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: "{}" });
    expect(other.status).toBe(403);
    const form = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
  });
});
