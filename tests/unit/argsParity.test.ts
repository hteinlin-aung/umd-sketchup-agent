import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS, isToolName } from "../../src/protocol/tools";

// The SAME cases are checked by tests/ruby/args_test.rb against the Ruby validators.
// If TypeScript and Ruby ever disagree about what is valid, one of the two tests fails.
type Case = { tool: string; valid: boolean; args: Record<string, unknown> };
const cases = JSON.parse(readFileSync(new URL("../fixtures/args_cases.json", import.meta.url), "utf8")) as Case[];

describe("argument cases shared with Ruby", () => {
  it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    expect(isToolName(c.tool)).toBe(true);
    if (!isToolName(c.tool)) return;
    const ok = TOOLS[c.tool].args.safeParse(c.args).success;
    expect({ tool: c.tool, args: c.args, valid: ok }).toEqual({ tool: c.tool, args: c.args, valid: c.valid });
  });

  it("covers every tool", () => {
    const covered = new Set(cases.map((c) => c.tool));
    for (const t of Object.keys(TOOLS)) expect(covered.has(t)).toBe(true);
  });
});
