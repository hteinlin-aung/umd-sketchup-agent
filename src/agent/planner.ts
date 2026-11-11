import { runsWhichWay, type RoomSummary } from "../summary/roomSummary";
import type { Brief, BriefChange } from "./brief";
import { ChangeAnswer, changeAnswerJsonSchema, type ChangeStep, type Draft, type DraftStep } from "./draft";
import type { ChatMessage, Llm } from "./llm";
import { resolveDraft, type ResolveOptions } from "./resolve";

/**
 * Step 2c: asks the language model for a plan, ONE brief change at a time.
 *
 * The first version asked for the whole brief in one answer. On Windows (2026-11-11)
 * qwen3:4b then built nothing, said it "needed coordinates", and repeated
 * hide/screenshot/show until the step limit. A small model does much better with a
 * small question: "plan change 2 only; here is the room; earlier changes made S1".
 *
 * Every answer is checked (shape, repeats, refs, arithmetic via the resolver). Problems
 * go back to the model with the exact reasons for one more try. A change that still fails
 * is reported as NOT DONE with those reasons; the rest of the plan carries on, and you
 * decide at the y/n.
 */

export const SYSTEM_PROMPT = `You help an interior designer change a SketchUp model. You get the ROOM SUMMARY, the
whole BRIEF, and ONE change from the brief to plan. Answer with JSON only.

You never need coordinates, camera angles or alignment: the program calculates all of that from your
placement words. So never say a change is impossible because of positions, coordinates or the camera.

Answer: {"type": "steps" | "rule" | "notPossible", "steps": [...], "reason": "..."}
- "steps": the change is done with the operations below (usually 1 to 4 steps).
- "rule": the change only says which tag, material or name OTHER changes must use. No steps.
- "notPossible": it needs something not in the list below (doors, 3D Warehouse components, lowering a
  floor, a camera scene). Say which in "reason". No steps.

Operations:
- {"op":"replace","target":"R5"}  hide an existing item (moved to a hidden "replaced" tag, never deleted)
- {"op":"build","id":"S1","name":"...","placement":{...},"height":H,"base":0,"tag":"...","material":{"name":"...","rgb":[r,g,b]}}
    a NEW solid block. height in metres. base = how high its bottom is above the floor (0 = on the floor).
    placement "beside" = standing next to an existing item:
      {"kind":"beside","anchor":"R1","side":"east","gap":1.2,"eastWest":0.7,"northSouth":3.0,"shift":0}
      side: which side of that item it stands on (east, west, north, south).
      gap: clear distance from that side of the item.
      eastWest: the block's size from west to east. northSouth: its size from south to north.
        "4 m long running west" or "running east" -> eastWest 4. "3 m long (north-south)" -> northSouth 3.
      shift: slide it along that side, measured from the item's centre (+ = north/east, - = south/west). 0 = centred.
    placement "onTop" = sitting ON an earlier new block ("on the counter", "a top on ..."):
      {"kind":"onTop","of":"S1","overhang":0.05}   height is then the thickness.
- {"op":"hideTag","tag":"..."}   {"op":"showTag","tag":"..."}
- {"op":"screenshot"}   (the program frames the view)
- {"op":"save","fileName":"..."}

Rules:
- Only use refs (R1, R2 ...) from the ROOM SUMMARY; pick the item whose name matches the brief's words.
- Use the brief's sizes exactly, in metres. Use the tag and material the brief's rules give.
- Only build what the change asks to ADD. Taking something out is only a "replace": never build a new block for it,
  and never place a new block beside something that is being taken out.
- Only steps THIS change asks for: no extra screenshots, saves, tag steps or replaces.
- "inside" a wall or the entrance means the side facing into the room.
- "along" an item = the block's length runs the same way as that item (see "runs north-south / east-west").
- "X m clear between them" is the empty space between the two blocks, not centre to centre.
- New blocks must not overlap each other. Write in English only. Never repeat a step.`;

const EXAMPLE = `Example 1 (another room). Change: "2. Add a shelf 2.0 m long (east-west), 0.4 m deep, 0.9 m high, 0.5 m
south of the window wall (R4), centred, in oak." The brief's rules say tag "Furniture (AGENT)" and oak = RGB 180,140,90.
New build ids: S3. Answer:
{"type":"steps","steps":[{"op":"build","id":"S3","name":"Shelf - oak","placement":{"kind":"beside","anchor":"R4","side":"south","gap":0.5,"eastWest":2.0,"northSouth":0.4,"shift":0},"height":0.9,"base":0,"tag":"Furniture (AGENT)","material":{"name":"Oak","rgb":[180,140,90]}}],"reason":""}

Example 2, a PAIR. Change: "3. Two planters inside the door wall (R6, runs north-south), each 3.0 m long running west from
2.0 m inside the wall, 0.5 m wide, 0.4 m high, one each side of a path; keep 1.2 m clear between them."
Both stand on the SAME side of R6 (west = inside). Running west -> eastWest 3.0, northSouth 0.5.
Clear gap 1.2 between two 0.5-wide blocks: each centre is 1.2/2 + 0.5/2 = 0.85 from the middle, so shift +0.85 and -0.85.
New build ids: S4, S5. Answer:
{"type":"steps","steps":[{"op":"build","id":"S4","name":"Planter north","placement":{"kind":"beside","anchor":"R6","side":"west","gap":2.0,"eastWest":3.0,"northSouth":0.5,"shift":0.85},"height":0.4,"base":0,"tag":"Furniture (AGENT)"},{"op":"build","id":"S5","name":"Planter south","placement":{"kind":"beside","anchor":"R6","side":"west","gap":2.0,"eastWest":3.0,"northSouth":0.5,"shift":-0.85},"height":0.4,"base":0,"tag":"Furniture (AGENT)"}],"reason":""}

Example 3. Change: "4. A glass top on the shelf, 0.02 m thick, 0.03 m overhang." The shelf is S3. Answer:
{"type":"steps","steps":[{"op":"build","id":"S6","name":"Shelf top - glass","placement":{"kind":"onTop","of":"S3","overhang":0.03},"height":0.02,"base":0,"tag":"Furniture (AGENT)"}],"reason":""}

Example 4, ALONG an item. Change: "5. A bench along the west face of the wardrobe (R7), 4.0 m long, 0.45 m deep, 0.45 m high."
The summary says R7 "runs north-south", so the bench's length (4.0) is northSouth and its depth (0.45) is eastWest:
{"type":"steps","steps":[{"op":"build","id":"S7","name":"Bench","placement":{"kind":"beside","anchor":"R7","side":"west","gap":0,"eastWest":0.45,"northSouth":4.0,"shift":0},"height":0.45,"base":0,"tag":"Furniture (AGENT)"}],"reason":""}

Example 5. Change: "1. Take out the old sofa (R2)." Answer:
{"type":"steps","steps":[{"op":"replace","target":"R2"}],"reason":""}`;

export type ChangeOutcome = {
  line: number;
  type: ChangeAnswer["type"] | "failed";
  steps: number;
  tries: number;
  problems: string[]; // left after the last try (only for "failed")
  seconds: number;
};

export type PlanResult = { draft: Draft; answers: { line: number; text: string }[]; outcomes: ChangeOutcome[] };

/** "on the counter", "on top of", "a top" (but not "on the floor" / "on the east side"). */
const ON_SOMETHING = /\bon top of\b|\bon the (?!floor\b|ground\b|east\b|west\b|north\b|south\b|left\b|right\b|side\b|tag\b)\w+|\btop\b/i;

const VAGUE_REASON = /coordinat|position|exact|align|camera|view|orientation|finali[sz]|not specified|unknown location/i;

export async function planBrief(
  llm: Llm,
  brief: Brief,
  summary: RoomSummary,
  summaryText: string,
  opts: ResolveOptions,
  onChange: (o: ChangeOutcome) => void = () => {},
): Promise<PlanResult> {
  const schema = changeAnswerJsonSchema();
  const steps: DraftStep[] = [];
  const notDone: Draft["notDone"] = [];
  const answers: PlanResult["answers"] = [];
  const outcomes: ChangeOutcome[] = [];

  for (const change of brief.changes) {
    const started = Date.now();
    const firstId = nextBuildNumber(steps);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: changeQuestion(brief, change, summaryText, steps, firstId) },
    ];
    let accepted: ChangeAnswer | null = null;
    let problems: string[] = [];
    let tries = 0;
    for (tries = 1; tries <= 2; tries++) {
      const text = await llm(messages, schema);
      answers.push({ line: change.line, text });
      const checked = checkAnswer(text, change, steps, firstId, summary, opts);
      problems = checked.problems;
      if (problems.length === 0) {
        accepted = checked.answer;
        break;
      }
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: `That answer has problems:\n- ${problems.join("\n- ")}\nAnswer again for change ${change.line} only, with corrected JSON.` },
      );
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    let outcome: ChangeOutcome;
    if (!accepted) {
      notDone.push({ line: change.line, what: short(change.text), reason: `the model could not plan it: ${problems.join("; ")}`.slice(0, 300) });
      outcome = { line: change.line, type: "failed", steps: 0, tries: tries - 1, problems, seconds };
    } else {
      if (accepted.type === "notPossible") notDone.push({ line: change.line, what: short(change.text), reason: accepted.reason || "not possible with the current tools" });
      for (const st of accepted.steps) steps.push({ ...st, line: change.line } as DraftStep);
      outcome = { line: change.line, type: accepted.type, steps: accepted.steps.length, tries, problems: [], seconds };
    }
    outcomes.push(outcome);
    onChange(outcome);
  }

  for (const item of brief.later) notDone.push({ what: short(item), reason: 'marked "(later)" in the brief' });
  if (steps.length === 0) throw new Error("the model produced no steps at all; see the answers in the run folder");
  return { draft: { steps, notDone }, answers, outcomes };
}

function changeQuestion(brief: Brief, change: BriefChange, summaryText: string, done: DraftStep[], firstId: number): string {
  const builds = done.filter((s) => s.op === "build").map((s) => `${(s as { id: string }).id} = "${(s as { name: string }).name}" (change ${s.line})`);
  return [
    `ROOM SUMMARY:\n${summaryText}`,
    `BRIEF (all of it, for context and rules):\n${brief.text.trim()}`,
    builds.length ? `Already planned blocks: ${builds.join("; ")}` : "Nothing built yet.",
    EXAMPLE,
    `Now plan ONLY change ${change.line}: "${change.text}"`,
    `New build ids for this change: S${firstId}, S${firstId + 1}, ... in order.`,
  ].join("\n\n");
}

/** Checks one answer. Returns the problems in plain words (empty = accepted). */
export function checkAnswer(
  text: string,
  change: BriefChange,
  done: DraftStep[],
  firstId: number,
  summary: RoomSummary,
  opts: ResolveOptions,
): { answer: ChangeAnswer | null; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { answer: null, problems: ["the answer is not valid JSON"] };
  }
  const parsed = ChangeAnswer.safeParse(json);
  if (!parsed.success) {
    return { answer: null, problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`) };
  }
  const answer = renumber(parsed.data, firstId);
  const problems: string[] = [];

  if (answer.type === "steps" && answer.steps.length === 0) problems.push('type is "steps" but there are no steps');
  if (answer.type !== "steps" && answer.steps.length > 0) problems.push(`type is "${answer.type}" but steps were given; use "steps"`);
  if (answer.type === "notPossible" && VAGUE_REASON.test(answer.reason)) {
    problems.push("positions, coordinates, alignment and the camera are calculated by the program, so they never make a change impossible; use build/screenshot steps");
  }
  if (answer.type === "rule" && /\b(add|build|hide|replace|take out|save|screenshot)\b/i.test(change.text) && !/\b(put|use|tag|material)\b.{0,40}\b(everything|all|new)\b/i.test(change.text)) {
    problems.push(`change ${change.line} asks for something to be done, so it is not only a rule; give its steps`);
  }

  problems.push(...stepsFitTheChange(answer, change, done, summary));

  const keys = answer.steps.map((s) => JSON.stringify(s));
  if (new Set(keys).size < keys.length) problems.push("the same step appears more than once");


  // Run the resolver on everything so far + this answer: catches unknown refs, bad sizes, onTop of nothing ...
  if (problems.length === 0 && answer.steps.length > 0) {
    const trial: DraftStep[] = [...done, ...answer.steps.map((s) => ({ ...s, line: change.line }) as DraftStep)];
    const hasSave = trial.some((s) => s.op === "save");
    const plan = resolveDraft({ steps: hasSave ? trial : [...trial, { op: "save", line: change.line, fileName: "check" }], notDone: [] }, summary, opts);
    for (const e of plan.errors) if (e.startsWith(`line ${change.line}:`) || e.startsWith("action ")) problems.push(e.replace(/^line \d+: /, ""));
    // "keep 1.8 m clear between them": measure the real clear gap between this change's two blocks.
    const clear = change.text.match(/(\d+(?:\.\d+)?)\s*m clear between/i);
    const mine = plan.actions.filter((a) => a.line === change.line && a.builds);
    if (clear && mine.length === 2) {
      const want = Number(clear[1]);
      const got = clearGap(mine[0]!.args.points as number[][], mine[1]!.args.points as number[][]);
      if (Math.abs(got - want) > 0.01) {
        problems.push(`the change wants ${want} m clear between the two blocks, they have ${got.toFixed(2)} m: shift each one by (clear gap + block width) / 2 from the middle`);
      }
    }
    // Outside the room is almost always a wrong side (Windows: one entrance planter went 1 m EAST of the glass wall,
    // i.e. outside the building). Overlaps with existing items stay warnings: those are your design decision.
    for (const a of plan.actions) {
      if (a.line !== change.line || !a.builds) continue;
      if (a.warnings.some((w) => w.includes("outside the room"))) {
        problems.push(`${a.builds} ends up outside the room: check "side" (the inside of a wall faces into the room) and "shift"`);
      }
      for (const w of a.warnings) {
        const m = w.match(/it overlaps (S\d+) "/);
        if (m) problems.push(`${a.builds} overlaps ${m[1]}, another new block: check eastWest/northSouth and shift`);
      }
    }
  }
  return { answer, problems };
}

/**
 * Does each step belong to THIS change? Small models drift: on Windows qwen3:4b answered "add a counter"
 * with a showTag and was counted as planned; qwen3:8b added a screenshot and a showTag to "take out Sofa set 4".
 * Simple word checks on the change's own text catch most of it, and the model is told why.
 */
function stepsFitTheChange(answer: ChangeAnswer, change: BriefChange, done: DraftStep[], summary: RoomSummary): string[] {
  const t = change.text;
  const problems: string[] = [];
  const has = (op: ChangeStep["op"]) => answer.steps.some((st) => st.op === op);

  if (/\d(\.\d+)?\s*m\b/.test(t) && answer.type === "steps" && !has("build")) {
    problems.push(`change ${change.line} gives sizes in metres for something new, so it needs a "build" step`);
  }
  const sizes = /\d(\.\d+)?\s*m\b/.test(t);
  if (has("build") && !sizes && !/\b(add|new|build|top)\b/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to add anything new, so it must not build a block`);
  }
  const replaced = new Set([...done, ...answer.steps].filter((st) => st.op === "replace").map((st) => (st as { target: string }).target));
  for (const st of answer.steps) {
    if (st.op !== "build") continue;
    if (st.placement.kind === "beside" && replaced.has(st.placement.anchor)) {
      problems.push(`${st.id} is placed beside ${st.placement.anchor}, which this plan takes out; choose the item the change names`);
    }
    if (st.placement.kind === "beside" && ON_SOMETHING.test(t) && done.some((d) => d.op === "build")) {
      problems.push(`change ${change.line} puts it ON an earlier block: use "onTop" with that block's id, not "beside"`);
    }
  }
  // "along the east face of R8": the block's long side must run the same way as R8.
  if (/\balong\b/i.test(t)) {
    for (const st of answer.steps) {
      if (st.op !== "build" || st.placement.kind !== "beside") continue;
      const anchor = summary.items.find((it) => it.ref === (st.placement as { anchor: string }).anchor);
      const anchorRuns = anchor ? runsWhichWay(anchor.size) : null;
      const p = st.placement;
      const blockRuns = runsWhichWay([p.eastWest, p.northSouth, 0]);
      if (anchorRuns && blockRuns && anchorRuns !== blockRuns) {
        const long = anchorRuns === "north-south" ? "northSouth" : "eastWest";
        problems.push(`${st.id} is "along" ${p.anchor}, which runs ${anchorRuns}, so its length goes in ${long} (it runs ${blockRuns} now)`);
      }
    }
  }

  // "4.0 m long running west" / "3.0 m long (north-south)": check the size went to the right direction.
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*m long\b[^.;]{0,25}?\b(east-west|north-south|west|east|north|south)\b/gi)) {
    const value = Number(m[1]);
    const field = /east|west/i.test(m[2]!) && !/north-south/i.test(m[2]!) ? "eastWest" : "northSouth";
    for (const st of answer.steps) {
      if (st.op === "build" && st.placement.kind === "beside" && Math.abs(st.placement[field] - value) > 0.001) {
        problems.push(`the brief says "${m[0]}", so ${st.id} needs ${field} ${value} (it has ${st.placement[field]})`);
      }
    }
  }
  if (has("screenshot") && !/screenshot|image|picture|photo|capture/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask for a screenshot; remove it (the plan already shows what replaced items contain)`);
  }
  if (has("save") && !/\bsave\b/i.test(t)) problems.push(`change ${change.line} doesn't ask to save; remove the save step`);
  if (has("replace") && !/take out|remov|replac|get rid of/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to take anything out; remove the replace step`);
  }
  if ((has("hideTag") || has("showTag")) && !/\b(hide|show|hidden|visible)\b/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to hide or show a tag; remove those steps`);
  }

  // showTag only makes sense for a tag that is hidden (in the model, or earlier in this plan).
  const hidden = new Set(summary.tags.filter((tg) => !tg.visible).map((tg) => tg.name));
  for (const st of [...done, ...answer.steps]) {
    if (st.op === "hideTag") hidden.add(st.tag);
    else if (st.op === "showTag") {
      if (!hidden.has(st.tag) && answer.steps.includes(st as ChangeStep)) problems.push(`"${st.tag}" is not hidden, so showing it does nothing; remove that step`);
      hidden.delete(st.tag);
    }
  }

  if (/[\u3000-\u9fff]/.test(JSON.stringify(answer))) problems.push("write every name and reason in English only");
  return problems;
}

/**
 * The model is told which build ids to use, but small models miscount. Ids are only labels, so the code
 * renames this change's builds to S<firstId>, S<firstId+1>, ... and fixes "onTop" links between them.
 * Links to blocks from EARLIER changes are left alone (the resolver checks they exist).
 */
function renumber(answer: ChangeAnswer, firstId: number): ChangeAnswer {
  const map = new Map<string, string>();
  let next = firstId;
  for (const st of answer.steps) if (st.op === "build" && !map.has(st.id)) map.set(st.id, `S${next++}`);
  const steps = answer.steps.map((st): ChangeStep => {
    if (st.op !== "build") return st;
    const placement = st.placement.kind === "onTop" && map.has(st.placement.of) && st.placement.of !== st.id
      ? { ...st.placement, of: map.get(st.placement.of)! }
      : st.placement;
    return { ...st, id: map.get(st.id)!, placement };
  });
  return { ...answer, steps };
}

/** Clear distance between two rectangles (corner points), along whichever axis separates them; negative = overlap. */
function clearGap(a: number[][], b: number[][]): number {
  const box = (p: number[][]) => ({ x0: Math.min(...p.map((q) => q[0]!)), x1: Math.max(...p.map((q) => q[0]!)), y0: Math.min(...p.map((q) => q[1]!)), y1: Math.max(...p.map((q) => q[1]!)) });
  const A = box(a);
  const B = box(b);
  const gx = Math.max(B.x0 - A.x1, A.x0 - B.x1);
  const gy = Math.max(B.y0 - A.y1, A.y0 - B.y1);
  return Math.max(gx, gy);
}

function nextBuildNumber(steps: DraftStep[]): number {
  return steps.filter((s) => s.op === "build").length + 1;
}

const short = (t: string) => (t.length > 90 ? `${t.slice(0, 90)}…` : t).replace(/\*\*/g, "");
