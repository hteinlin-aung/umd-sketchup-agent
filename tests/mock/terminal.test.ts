import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { terminal, type TerminalInput } from "../../src/cli/terminal";

// MOCK: the terminal questions. Windows, 2026-11-12: a command line pasted twice left text in the
// input buffer. It answered "which one do you like?" with a component nobody picked, and went on to
// the run/stop gate. Anything typed BEFORE a question appeared must not count as its answer.

const stream = (isTTY: boolean) => Object.assign(new PassThrough(), { isTTY }) as unknown as TerminalInput & PassThrough;

describe("terminal(): questions at a real keyboard", () => {
  it("throws away text typed before the question was asked", async () => {
    const input = stream(true);
    const rl = terminal(input);
    input.write("2\ny\n"); // the stray half of a pasted command line
    await new Promise((r) => setImmediate(r));
    const answer = rl.ask("Run these 4 actions? ");
    input.write("\n"); // the designer actually presses Enter
    expect(await answer).toBe("");
    rl.close();
  });

  it("still takes an answer typed after the question", async () => {
    const input = stream(true);
    const rl = terminal(input);
    const answer = rl.ask("Pick 1-3: ");
    input.write("3\n");
    expect(await answer).toBe("3");
    rl.close();
  });

  it("echoes what is typed, so the designer can see the answer they are giving", async () => {
    const input = stream(true);
    const seen: string[] = [];
    const out = new PassThrough();
    out.on("data", (c) => seen.push(String(c)));
    const rl = terminal(input, out);
    const answer = rl.ask("Pick 1-3 (Enter = 1): ");
    input.write("2\n");
    expect(await answer).toBe("2");
    // the question, and the "2" readline echoed back
    expect(seen.join("")).toContain("Pick 1-3");
    expect(seen.join("")).toContain("2");
    rl.close();
  });

  it("keeps queueing piped answers, so `echo y | npm run agent` still works", async () => {
    const input = stream(false);
    const rl = terminal(input);
    input.write("2\ny\n");
    await new Promise((r) => setImmediate(r));
    expect(await rl.ask("Pick 1-3: ")).toBe("2");
    expect(await rl.ask("Run these 4 actions? ")).toBe("y");
    rl.close();
  });
});
