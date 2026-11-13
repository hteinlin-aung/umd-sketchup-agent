import { describe, expect, it } from "vitest";
import { resolveDraft } from "../../src/agent/resolve";
import { groupPieces, viewOptions } from "../../src/agent/views";
import type { BridgeClient } from "../../src/bridge/client";
import { checkViews, floorUnderRoom, viewProblem } from "../../src/geometry/views";
import type { Bounds } from "../../src/protocol/tools";
import { t133 } from "../helpers/t133";

// MOCK: the eye-level pictures that replaced the iso screenshot (Windows, 2026-11-13).

const box = (x0: number, y0: number, x1: number, y1: number, z0 = 1.489, z1 = 1.939): Bounds => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
// Brief 5's two genkan benches, as built on Windows (run 231558).
const S1 = box(29, 79.475, 31, 79.825);
const S2 = box(48.08, 79.955, 50.08, 80.305);

describe("groupPieces", () => {
  it("pieces close together share a picture; brief 5's benches, 17 m apart, get one each", () => {
    expect(groupPieces([{ id: "S1", box: S1 }, { id: "S2", box: S2 }]).map((g) => g.ids)).toEqual([["S1"], ["S2"]]);
    const top = box(29, 79.475, 31, 79.825, 1.939, 1.98);
    expect(groupPieces([{ id: "S1", box: S1 }, { id: "S2", box: top }]).map((g) => g.ids)).toEqual([["S1", "S2"]]);
  });

  it("a piece that bridges two groups joins them", () => {
    const a = box(0, 0, 1, 1);
    const b = box(8, 0, 9, 1);
    const middle = box(4, 0, 5, 1);
    expect(groupPieces([{ id: "A", box: a }, { id: "B", box: b }, { id: "M", box: middle }]).map((g) => g.ids)).toEqual([["A", "B", "M"]]);
  });
});

describe("viewOptions: standpoints, best first", () => {
  it("in front of the long face first, the side toward the room's middle first, at eye level, at least 3 m out", () => {
    const { summary } = t133();
    const o = viewOptions(S1, summary);
    expect(o.map((x) => x.side)).toEqual(["south", "north", "east", "west"]); // runs east-west; the room's middle is south-east of it
    for (const x of o) {
      expect(x.eye[2]).toBeCloseTo(1.489 + 1.6, 3);
      expect(x.target[2]).toBe(x.eye[2]);
      expect(x.near).toBeGreaterThanOrEqual(3);
    }
    const north = o.find((x) => x.side === "north")!;
    expect(north.eye[0]).toBeCloseTo(30, 3); // straight in front of it, so a ray can check the view
    expect(north.eye[1]).toBeCloseTo(79.825 + north.near, 3);
    expect(north.look).toBe("south");
    expect(north.rayZ).toBeCloseTo(1.489 + 0.225, 3); // through the bench, not over it
  });
});

describe("resolveDraft: the screenshot step", () => {
  it("brief 5: two pictures, one per bench, at eye level, no iso view", () => {
    const { summary } = t133();
    const bench = (id: string, anchor: string, shift: number, line: number) => ({
      op: "build" as const, line, id, name: "bench",
      placement: { kind: "beside" as const, anchor, side: "north" as const, gap: 0.14, eastWest: 2, northSouth: 0.35, shift },
      height: 0.45, base: 0, tag: "T",
    });
    const plan = resolveDraft({ steps: [bench("S1", "R2", 5.2, 1), bench("S2", "R1", -5.4, 2), { op: "screenshot", line: 5 }, { op: "save", line: 5, fileName: "x.skp" }], notDone: [] }, summary, { runId: "t", briefName: "b5" });
    expect(plan.errors).toEqual([]);
    const shots = plan.actions.filter((a) => a.tool === "captureView");
    expect(shots.map((a) => a.viewOf)).toEqual([["S1"], ["S2"]]);
    expect(shots.map((a) => a.args.fileName)).toEqual(["b5_t_1.png", "b5_t_2.png"]);
    expect(shots.every((a) => !a.args.zoomTo && a.viewOptions!.length === 4)).toBe(true);
  });

  it("nothing built: one eye-level view of the room from just inside one of its sides", () => {
    const { summary } = t133();
    const plan = resolveDraft({ steps: [{ op: "screenshot", line: 1 }, { op: "save", line: 1, fileName: "x.skp" }], notDone: [] }, summary, { runId: "t", briefName: "b" });
    const shots = plan.actions.filter((a) => a.tool === "captureView");
    expect(shots).toHaveLength(1);
    expect(shots[0]!.title).toMatch(/SCREENSHOT of the room \(eye level/);
  });
});

/** A fake bridge that answers `measure` from a table: [direction, x, y] -> first hit. */
const rays = (answer: (dir: string, from: number[]) => { z?: number; distance?: number; path?: string[] } | null): BridgeClient =>
  ({
    call: async (tool: string, args: { from: number[]; direction: string }) => {
      if (tool !== "measure") throw new Error(`unexpected ${tool}`);
      const h = answer(args.direction, args.from);
      const hits = h ? [{ point: [args.from[0], args.from[1], h.z ?? 0], distance: h.distance ?? 0, path: h.path ?? ["thing"], entityIds: [1], tag: "Layer0", material: null }] : [];
      return { ok: true, data: { from: args.from, direction: args.direction, hits, stoppedBecause: "noMoreHits" } };
    },
  }) as unknown as BridgeClient;

const plan5 = () => {
  const { summary } = t133();
  const bench = { op: "build" as const, line: 1, id: "S1", name: "bench", placement: { kind: "beside" as const, anchor: "R2", side: "north" as const, gap: 0.14, eastWest: 2, northSouth: 0.35, shift: 5.2 }, height: 0.45, base: 0, tag: "T" };
  return resolveDraft({ steps: [bench, { op: "screenshot", line: 5 }, { op: "save", line: 5, fileName: "x.skp" }], notDone: [] }, summary, { runId: "t", briefName: "b5" });
};
describe("checkViews: the real model picks the standpoint", () => {


  // Windows, 2026-11-13: south of the bench is INSIDE the raised breathing room (floor 2.02), behind its north wall.
  it("the summary already moves a standpoint inside another room to the back", () => {
    const shot = plan5().actions.find((a) => a.tool === "captureView")!;
    expect(shot.viewOptions!.map((o) => o.side)).toEqual(["north", "east", "west", "south"]);
  });

  it("the floor ray refuses a standpoint on a raised floor", async () => {
    const south = plan5().actions.find((a) => a.tool === "captureView")!.viewOptions!.find((o) => o.side === "south")!;
    const why = await viewProblem(rays(() => ({ z: 2.02, path: ["UMD 1F", "BREATHING ROOM (T133)", "Group#12"] })), south);
    expect(why).toBe('it would stand on "BREATHING ROOM (T133)" at z 2.02, not on the floor');
  });

  it("the sight ray refuses a standpoint with something in between, and the next clear one is used", async () => {
    const plan = plan5();
    const client = rays((dir) => {
      if (dir === "down") return { z: 1.489, path: ["1F floor plate (finish surface)"] };
      if (dir === "south") return { distance: 0.5, path: ["UMD 1F", "G2 Genkan shoe shelf"] }; // from the north
      return null; // from the east (looking west): nothing before the bench
    });
    const lines = await checkViews(client, plan);
    const shot = plan.actions.find((a) => a.tool === "captureView")!;
    expect(shot.title).toMatch(/east of S1, looking west/);
    expect((shot.args.camera as { eye: number[] }).eye[0]).toBeGreaterThan(31);
    expect(lines[0]).toMatch(/VIEW S1: from the east, 3 m away \(not from the north: "G2 Genkan shoe shelf" is in between, 0\.5 m out\)/);
  });

  it("when no side is clear, it says so (a warning), and never pretends", async () => {
    const plan = plan5();
    const lines = await checkViews(rays(() => ({ z: 1.489, distance: 0.4, path: ["a wall"] })), plan);
    const shot = plan.actions.find((a) => a.tool === "captureView")!;
    expect(shot.warnings.join()).toMatch(/no side gives a clear eye-level view of S1/);
    expect(lines[0]).toMatch(/VIEW S1: no clear side/);
  });
});

// Windows, 2026-11-13: UMD_DEV_1F_reception.skp holds the room group only - no floor, walls or columns. The checks
// must say they could not look, not quietly pass.
describe("a model with no building around the room", () => {
  it("floorUnderRoom: true when a probe finds the floor level, false when nothing is there", async () => {
    const { summary } = t133();
    expect(await floorUnderRoom(rays(() => ({ z: 1.489 })), summary)).toBe(true);
    expect(await floorUnderRoom(rays(() => null), summary)).toBe(false);
    expect(await floorUnderRoom(rays(() => ({ z: 2.02 })), summary)).toBe(false); // only the raised room floors
  });

  it("with no floor, standpoints are checked only for things in between, and the report says so", async () => {
    const plan = plan5();
    const lines = await checkViews(rays((dir) => (dir === "down" ? null : null)), plan, false);
    expect(lines[0]).toMatch(/no floor under the room, so standpoints are checked only for things in between/);
    expect(lines[1]).toMatch(/VIEW S1: from the north/);
    expect(await viewProblem(rays(() => null), plan.actions.find((a) => a.tool === "captureView")!.viewOptions![0]!, false)).toBeNull();
  });
});
