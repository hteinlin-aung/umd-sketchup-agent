import { describe, expect, it } from "vitest";
import type { DraftStep } from "../../src/agent/draft";
import { executePlan } from "../../src/agent/execute";
import { checkAnswer } from "../../src/agent/planner";
import { resolveDraft, sceneCamera, segmentHitsBox } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { summarizeRoom } from "../../src/summary/roomSummary";

// MOCK: saved camera views (scenes, for D5) on the fake reception room (real positions from Windows).

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";
const OPTS = { runId: "test", briefName: "1F_reception" };
const SAVE: DraftStep = { op: "save", line: 9, fileName: "out.skp" };

const setup = async () => {
  const sketchup = new MockSketchUp({ scene: "reception" });
  const client = new BridgeClient(sketchup);
  const summary = await summarizeRoom(client, { path: [ROOM] });
  const refs = new Map(summary.items.map((it) => [it.ref, it]));
  return { sketchup, client, summary, refs };
};
const scene = (from: string, extra: Partial<Extract<DraftStep, { op: "scene" }>> = {}): DraftStep => ({
  op: "scene",
  line: 8,
  name: "Reception view",
  from,
  eyeHeight: 1.6,
  ...extra,
});

describe("sceneCamera: the code places the camera", () => {
  it("from the south side: just inside the south edge, at eye height, looking level at the middle", async () => {
    const { summary, refs } = await setup();
    const room = summary.room.bounds;
    const cam = sceneCamera({ line: 8, name: "v", from: "south", eyeHeight: 1.6 }, summary, refs, [])!;
    const midX = (room.min[0] + room.max[0]) / 2;
    expect(cam.eye[0]).toBeCloseTo(midX, 2);
    expect(cam.eye[1]).toBeCloseTo(room.min[1] + 0.6, 2);
    expect(cam.eye[2]).toBeCloseTo(summary.floor.z + 1.6, 3);
    expect(cam.target[2]).toBe(cam.eye[2]); // level: walls stay vertical
    expect(cam.fov).toBe(55);
  });

  it("from a corner", async () => {
    const { summary, refs } = await setup();
    const room = summary.room.bounds;
    const cam = sceneCamera({ line: 8, name: "v", from: "northwest", eyeHeight: 1.1 }, summary, refs, [])!;
    expect(cam.eye[0]).toBeCloseTo(room.min[0] + 0.6, 2);
    expect(cam.eye[1]).toBeCloseTo(room.max[1] - 0.6, 2);
    expect(cam.what).toMatch(/northwest corner/);
  });

  it("from the entrance (R12, the glass wall on the east): steps into the room, west of the glass", async () => {
    const { summary, refs } = await setup();
    const glass = refs.get("R12")!.bounds;
    const cam = sceneCamera({ line: 8, name: "v", from: "R12", eyeHeight: 1.6 }, summary, refs, [])!;
    expect(cam.eye[0]).toBeLessThan(glass.min[0]);
    expect(cam.eye[0]).toBeGreaterThan(summary.room.bounds.min[0]);
    expect(cam.what).toMatch(/just inside R12/);
  });

  it("toward an item: looks at that item's middle", async () => {
    const { summary, refs } = await setup();
    const t = refs.get("R1")!.bounds;
    const cam = sceneCamera({ line: 8, name: "v", from: "east", toward: "R1", eyeHeight: 1.6 }, summary, refs, [])!;
    expect(cam.target[0]).toBeCloseTo((t.min[0] + t.max[0]) / 2, 2);
    expect(cam.target[1]).toBeCloseTo((t.min[1] + t.max[1]) / 2, 2);
  });

  it("from above: the whole room from the south-east, looking down at its middle", async () => {
    const { summary, refs } = await setup();
    const room = summary.room.bounds;
    const cam = sceneCamera({ line: 8, name: "v", from: "above", eyeHeight: 1.6 }, summary, refs, [])!;
    expect(cam.eye[0]).toBeGreaterThan(room.max[0]);
    expect(cam.eye[1]).toBeLessThan(room.min[1]);
    expect(cam.eye[2]).toBeGreaterThan(room.max[2]);
    expect(cam.fov).toBe(35);
  });

  it("an unknown ref is an error, not a guess", async () => {
    const { summary, refs } = await setup();
    const errors: string[] = [];
    expect(sceneCamera({ line: 8, name: "v", from: "R99", eyeHeight: 1.6 }, summary, refs, errors)).toBeNull();
    expect(errors.join()).toMatch(/R99, which is not in the room summary/);
  });
});

describe("resolveDraft: scene steps", () => {
  it("become one addScene call that passes its own checks", async () => {
    const { summary } = await setup();
    const plan = resolveDraft({ steps: [scene("R12"), SAVE], notDone: [] }, summary, OPTS);
    expect(plan.errors).toEqual([]);
    const a = plan.actions.find((x) => x.tool === "addScene")!;
    expect(a.args.name).toBe("Reception view");
    expect(a.title).toMatch(/^SCENE "Reception view"/);
  });

  it("say which tags the scene keeps hidden", async () => {
    const { summary } = await setup();
    const steps: DraftStep[] = [{ op: "hideTag", line: 8, tag: "1F Reception - Lighting (T128)" }, scene("south"), SAVE];
    const a = resolveDraft({ steps, notDone: [] }, summary, OPTS).actions.find((x) => x.tool === "addScene")!;
    expect(a.details.join()).toMatch(/keeps these tags hidden: .*Lighting/);
  });

  it("warns when the item it looks at is hidden behind another, and names the sides with a clear view (Windows, 2026-11-13)", async () => {
    const { summary } = await setup();
    const steps = [scene("northwest", { toward: "R1", eyeHeight: 1.1 }), SAVE];
    const a = resolveDraft({ steps, notDone: [] }, summary, OPTS).actions.find((x) => x.tool === "addScene")!;
    const w = a.warnings.join("\n");
    expect(w).toMatch(/the view of R1 is blocked by R8 "Terrarium E/);
    expect(w).toMatch(/a clear view of it: from .*\bnorth\b/);
  });

  // Windows, 2026-11-13: the "seated" warning offered east, where the camera stands 0.6 m inside R7 "Corner lounge D"
  // (its planted rock wall). sightBlockers ignores a box the camera stands in, so that side looked clear.
  it("does not offer a side where the camera would stand inside something", async () => {
    const { summary, refs } = await setup();
    const steps = [scene("northwest", { toward: "R1", eyeHeight: 1.1 }), SAVE];
    const a = resolveDraft({ steps, notDone: [] }, summary, OPTS).actions.find((x) => x.tool === "addScene")!;
    const offered = /a clear view of it: from (.*)$/m.exec(a.warnings.join("\n"))?.[1] ?? "";
    expect(offered).toContain("north");
    expect(offered).not.toMatch(/\beast\b/);
    const east = sceneCamera({ line: 8, name: "v", from: "east", toward: "R1", eyeHeight: 1.1 }, summary, refs, [])!;
    const r7 = refs.get("R7")!.bounds;
    expect(east.eye[0]).toBeGreaterThan(r7.min[0]); // the camera it would have offered really is in the lounge
    expect(east.eye[1]).toBeLessThan(r7.max[1]);
  });

  it("no blocked warning when nothing stands in between, but it says the camera is in a box", async () => {
    const { summary } = await setup();
    const a = resolveDraft({ steps: [scene("east", { toward: "R1" }), SAVE], notDone: [] }, summary, OPTS).actions.find((x) => x.tool === "addScene")!;
    expect(a.warnings.join()).not.toMatch(/blocked/);
    expect(a.warnings.join()).toMatch(/stands inside the box of R7/);
  });

  it("must come before the save, or the copy wouldn't have it", async () => {
    const { summary } = await setup();
    const plan = resolveDraft({ steps: [SAVE, scene("south")], notDone: [] }, summary, OPTS);
    expect(plan.errors.join()).toMatch(/"scene" comes after the save/);
  });

  it("two scenes with the same name are a repeat", async () => {
    const { summary } = await setup();
    const plan = resolveDraft({ steps: [scene("south"), scene("north", { name: "reception VIEW" }), SAVE], notDone: [] }, summary, OPTS);
    expect(plan.errors.join()).toMatch(/same scene step appears more than once/);
  });
});

describe("checkAnswer: scenes only when asked", () => {
  const change = { line: 8, text: "Save a scene called `Reception - from the entrance`, standing just inside the main entrance." };
  const answer = (steps: unknown[]) => JSON.stringify({ type: "steps", steps, reason: "" });

  it('accepts a scene for "save a scene" without asking for a save of the file', async () => {
    const { summary } = await setup();
    const out = checkAnswer(answer([{ op: "scene", name: "Reception - from the entrance", from: "R12" }]), change, [], 1, summary, OPTS);
    expect(out.problems).toEqual([]);
  });

  it("a seated eye height in metres is not a size of something to build", async () => {
    const { summary } = await setup();
    const seated = { line: 2, text: "Save a scene called `Seated`, from the north-west corner, at seated eye height (1.1 m)." };
    const out = checkAnswer(answer([{ op: "scene", name: "Seated", from: "northwest", eyeHeight: 1.1 }]), seated, [], 1, summary, OPTS);
    expect(out.problems).toEqual([]);
  });

  it("asks for the scene step when it is missing", async () => {
    const { summary } = await setup();
    const out = checkAnswer(answer([{ op: "screenshot" }]), change, [], 1, summary, OPTS);
    expect(out.problems.join()).toMatch(/asks for a scene, but your answer has no "scene" step/);
  });

  it("refuses a scene the change didn't ask for", async () => {
    const { summary } = await setup();
    const out = checkAnswer(answer([{ op: "replace", target: "R5" }, { op: "scene", name: "x", from: "south" }]), { line: 1, text: "Take out Sofa set 4." }, [], 1, summary, OPTS);
    expect(out.problems.join()).toMatch(/doesn't ask for a scene/);
  });

  it('refuses a "from" that is neither a side, "above" nor a ref', async () => {
    const { summary } = await setup();
    const out = checkAnswer(answer([{ op: "scene", name: "x", from: "the door" }]), change, [], 1, summary, OPTS);
    expect(out.problems.join()).toMatch(/from/);
  });
});

describe("running a scene step (mock bridge)", () => {
  it("adds the scene, and a taken name gets (2) instead of changing your scene", async () => {
    const { sketchup, client, summary } = await setup();
    const plan = resolveDraft({ steps: [scene("south", { name: "1F Reception" }), SAVE], notDone: [] }, summary, OPTS);
    const run = await executePlan(client, plan);
    expect(run.stoppedAt).toBeNull();
    expect(sketchup.scenes).toContain("1F Reception (2)");
    expect(run.results[0]!.message).toMatch(/scene "1F Reception \(2\)" \(the name was taken\)/);
  });
});

describe("segmentHitsBox", () => {
  const box = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  it.each([
    ["straight through", [-1, 0.5], [2, 0.5], true],
    ["diagonal through a corner", [-1, -1], [2, 2], true],
    ["passing beside", [-1, 2], [2, 2], false],
    ["stopping short", [-2, 0.5], [-0.1, 0.5], false],
    ["vertical line beside", [1.5, -1], [1.5, 2], false],
  ] as const)("%s", (_n, p, q, hit) => {
    expect(segmentHitsBox([p[0], p[1]], [q[0], q[1]], box)).toBe(hit);
  });
});
