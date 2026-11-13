import { runsWhichWay, type RoomSummary } from "../summary/roomSummary";
import type { Brief, BriefChange } from "./brief";
import { renderCatalog, type Catalog } from "./catalog";
import { ChangeAnswer, changeAnswerJsonSchema, type ChangeStep, type Draft, type DraftStep } from "./draft";
import type { ChatMessage, Llm } from "./llm";
import { resolveDraft, type Plan, type ResolveOptions } from "./resolve";

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
  floor). Say which in "reason". No steps.

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
- {"op":"place","id":"S2","component":"<file name from COMPONENTS>","name":"...","placement":{"kind":"beside","anchor":"R1","side":"east","gap":0.5,"shift":0},"rotation":0,"base":0,"tag":"..."}
    a REAL 3D Warehouse component from the COMPONENTS list (furniture, plants). Use it whenever the change
    asks for a component, a real piece, a plant, a tree or named furniture; never draw those as "build" blocks.
    Its size comes from the list (the program already corrects files drawn at the wrong scale), so give no
    eastWest/northSouth. Only if the brief gives THIS piece's size, add "size":{"height":H} or {"across":A}.
    rotation: 0, 90, 180 or 270 (90 and 270 swap its east-west and north-south sizes).
    Ids share the S1, S2 ... numbering with build steps. You will be asked to pick ONE file; the designer
    sees similar ones and makes the final choice, so pick the one whose name fits the brief best.
- {"op":"hideTag","tag":"..."}   {"op":"showTag","tag":"..."}
- {"op":"screenshot"}   (the program frames the view)
- {"op":"scene","name":"...","from":"south","toward":"R3","eyeHeight":1.6}
    a saved camera view (a SketchUp scene, for D5). Only when the change asks for a scene or a camera view.
    from: where the camera stands: a side or corner of the room ("north", "southeast" ...), an item ref
      ("R6" = just inside that item, e.g. the entrance), or "above" (the whole room from above).
    toward: optional, the item ref the view looks at; leave it out to look at the middle of the room.
    eyeHeight: metres above the floor (1.6 standing, 1.1 seated). The program works out the camera.
- {"op":"save","fileName":"..."}

Rules:
- Only use refs (R1, R2 ...) from the ROOM SUMMARY; pick the item whose name matches the brief's words.
- Use the brief's sizes exactly, in metres. Use the tag and material the brief's rules give.
- Only build what the change asks to ADD. Taking something out is only a "replace": never build a new block for it,
  and never place a new block beside something that is being taken out.
- Only steps THIS change asks for: no extra screenshots, saves, tag steps or replaces.
  But include EVERY step it does ask for: "hide the tag, take a screenshot, show it again, then save" is four steps.
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

Example 5, a COMPONENT. Change: "6. Place the potted fig component 0.4 m south of the window wall (R4), shifted 1.0 m east."
The COMPONENTS list has "3DW_Fig tree potted.skp". New build ids: S8. Answer:
{"type":"steps","steps":[{"op":"place","id":"S8","component":"3DW_Fig tree potted.skp","name":"Fig tree","placement":{"kind":"beside","anchor":"R4","side":"south","gap":0.4,"shift":1.0},"rotation":0,"base":0,"tag":"Furniture (AGENT)"}],"reason":""}

Example 6. Change: "1. Take out the old sofa (R2)." Answer:
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

/** Words that mean "a real component, not a block". */
const COMPONENT_WORDS = /\bcomponent\b|3D ?Warehouse|\b3DW_/i;

/** A step that makes something new (a block or a placed component), with its id and name. */
function isNew(s: DraftStep): s is Extract<DraftStep, { op: "build" | "place" }> {
  return s.op === "build" || s.op === "place";
}

const VAGUE_REASON = /coordinat|position|exact|align|camera|view|orientation|finali[sz]|not specified|unknown location/i;

/** What resolve.ts says when a step repeats one from an earlier change. */
const DUPLICATE_OF_EARLIER = /the same (?:build|replace|save) step appears more than once \(first at line \d+\)/;
/** The complaint that follows from a repeat: the copy stands exactly where the original does. */
const OVERLAPS_A_NEW_BLOCK = /overlaps S\d+, another new block/;

/**
 * Which face of an item at the edge of the room points INTO the room. An item that runs
 * north-south is entered from its east or west face, and the inside one is whichever is
 * nearer the middle of the room. Returns null when the item isn't clearly long one way.
 */
function insideFace(anchor: RoomSummary["items"][number], summary: RoomSummary): "east" | "west" | "north" | "south" | null {
  const runs = runsWhichWay(anchor.size);
  const middle = (b: readonly number[], c: readonly number[], i: number) => (b[i]! + c[i]!) / 2;
  const room = summary.room.bounds;
  if (runs === "north-south") return middle(room.min, room.max, 0) < middle(anchor.bounds.min, anchor.bounds.max, 0) ? "west" : "east";
  if (runs === "east-west") return middle(room.min, room.max, 1) < middle(anchor.bounds.min, anchor.bounds.max, 1) ? "south" : "north";
  return null;
}

/**
 * How far each of a pair slides from the middle to leave `clear` metres between them.
 * A block placed on the east or west side of an item slides north-south, so its width
 * across the gap is northSouth; on the north or south side it is eastWest.
 */
function shiftHint(answer: ChangeAnswer, clear: number): string {
  const widths: number[] = [];
  for (const st of answer.steps) {
    if (st.op !== "build" || st.placement.kind !== "beside") continue;
    const p = st.placement;
    widths.push(p.side === "east" || p.side === "west" ? p.northSouth : p.eastWest);
  }
  if (widths.length !== 2) return "shift one of them + and the other -, each by (the clear gap + its own width) / 2";
  const shift = Math.round(((clear + (widths[0]! + widths[1]!) / 2) / 2) * 1000) / 1000;
  return `set shift to ${shift} on one and -${shift} on the other, and change nothing else`;
}

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
      { role: "user", content: changeQuestion(brief, change, summaryText, steps, firstId, opts.catalog) },
    ];
    let accepted: ChangeAnswer | null = null;
    let problems: string[] = [];
    let tries = 0;
    for (tries = 1; tries <= 2; tries++) {
      const text = await llm(messages, schema);
      answers.push({ line: change.line, text });
      const checked = checkAnswer(text, change, steps, firstId, summary, opts, brief);
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
    // A change whose only problem is that its steps are already in the plan has not failed: the model
    // answered it while answering an earlier change. (Windows 2026-11-12: qwen3:8b built the counter
    // top during change 2, so change 3 repeated it and was reported NOT DONE while being scored right.)
    // The repeated block also sits exactly on the original, so an overlap complaint comes with it.
    const alreadyPlanned =
      !accepted &&
      problems.some((pr) => DUPLICATE_OF_EARLIER.test(pr)) &&
      problems.every((pr) => DUPLICATE_OF_EARLIER.test(pr) || OVERLAPS_A_NEW_BLOCK.test(pr));
    if (alreadyPlanned) {
      outcome = { line: change.line, type: "steps", steps: 0, tries: tries - 1, problems: [], seconds };
    } else if (!accepted) {
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

function changeQuestion(brief: Brief, change: BriefChange, summaryText: string, done: DraftStep[], firstId: number, catalog?: Catalog): string {
  const builds = done.filter(isNew).map((s) => `${s.id} = "${s.name}" (change ${s.line})`);
  return [
    `ROOM SUMMARY:\n${summaryText}`,
    ...(catalog ? [renderCatalog(catalog)] : []),
    `BRIEF (all of it, for context and rules):\n${brief.text.trim()}`,
    builds.length ? `Already planned blocks: ${builds.join("; ")}` : "Nothing built yet.",
    EXAMPLE,
    `Now plan ONLY change ${change.line}: "${change.text}"`,
    `New build ids for this change: S${firstId}, S${firstId + 1}, ... in order.`,
  ].join("\n\n");
}

/**
 * Two shapes the model gets right in spirit and wrong on the page, tidied before the schema sees them:
 * - a compass word written the way the BRIEF writes it ("north-west corner" -> "north-west");
 * - an empty `toward` for a view that has nothing to look at, instead of leaving the field out.
 * Widening the schema is not the answer: it is also the JSON Schema Ollama decodes against, so a looser
 * one lets the model wander. (Windows 2026-11-13: brief 3 lost changes 2 and 3 to exactly these, twice
 * each, though every other field was right.)
 */
export function tidyScenes(json: unknown): unknown {
  const obj = json as { steps?: unknown } | null;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.steps)) return json;
  const ref = (t: string) => /^r\d{1,3}$/i.test(t);
  const steps = obj.steps.map((raw) => {
    if (!raw || typeof raw !== "object" || (raw as { op?: unknown }).op !== "scene") return raw;
    const st = { ...(raw as Record<string, unknown>) };
    if (typeof st.from === "string") {
      const t = st.from.trim();
      st.from = ref(t) ? t.toUpperCase() : t.toLowerCase().replace(/[\s_-]+/g, "");
    }
    if (typeof st.toward === "string") {
      const t = st.toward.trim();
      if (t === "") delete st.toward;
      else if (ref(t)) st.toward = t.toUpperCase();
    }
    return st;
  });
  return { ...obj, steps };
}

/** Checks one answer. Returns the problems in plain words (empty = accepted). */
export function checkAnswer(
  text: string,
  change: BriefChange,
  done: DraftStep[],
  firstId: number,
  summary: RoomSummary,
  opts: ResolveOptions,
  brief?: Brief, // the whole brief, so checks can follow a block that moved to another change
): { answer: ChangeAnswer | null; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { answer: null, problems: ["the answer is not valid JSON"] };
  }
  const parsed = ChangeAnswer.safeParse(tidyScenes(json));
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
  if (answer.type === "rule" && /\b(add|build|hide|replace|take out|save|screenshot|scene)\b/i.test(change.text) && !/\b(put|use|tag|material)\b.{0,40}\b(everything|all|new)\b/i.test(change.text)) {
    problems.push(`change ${change.line} asks for something to be done, so it is not only a rule; give its steps`);
  }

  problems.push(...stepsFitTheChange(answer, change, done, summary, brief));

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
        // The plan's rule is that the model says WHAT and the code works out HOW FAR, so hand it the
        // number rather than a formula. (Windows 2026-11-12: given "shift each one by (clear gap +
        // block width) / 2", qwen3:8b failed twice and change 5 produced no planters at all.)
        problems.push(`the change wants ${want} m clear between the two blocks, they have ${got.toFixed(2)} m: ${shiftHint(answer, want)}`);
      }
    }
    // Outside the room is almost always a wrong side (Windows: one entrance planter went 1 m EAST of the glass wall,
    // i.e. outside the building). Overlaps with existing items stay warnings: those are your design decision.
    for (const a of plan.actions) {
      if (a.line !== change.line || !a.builds) continue;
      if (a.warnings.some((w) => w.includes("outside the room"))) {
        // The code knows which face points into the room, so give the answer rather than a hint.
        // (Windows 2026-11-12: told to "check side and shift", qwen3:8b kept side "east" for the
        // EAST GLASS WALL - it reads the item's NAME - and both kerbs landed outside the building.)
        const step = answer.steps.find((st) => (st.op === "build" || st.op === "place") && st.id === a.builds);
        const anchor = (step?.op === "build" || step?.op === "place") && step.placement.kind === "beside"
          ? summary.items.find((it) => it.ref === (step.placement as { anchor: string }).anchor)
          : undefined;
        const inside = anchor ? insideFace(anchor, summary) : null;
        problems.push(
          inside
            ? `${a.builds} ends up outside the room: the inside of ${anchor!.ref} faces ${inside}, so use side "${inside}"`
            : `${a.builds} ends up outside the room: check "side" (the inside of a wall faces into the room) and "shift"`,
        );
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
type DirectionPhrase = { text: string; value: number; field: "eastWest" | "northSouth" };

function directionPhrases(text: string): DirectionPhrase[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*m long\b[^.;]{0,25}?\b(east-west|north-south|west|east|north|south)\b/gi)].map((m) => ({
    text: m[0],
    value: Number(m[1]),
    field: /east|west/i.test(m[2]!) && !/north-south/i.test(m[2]!) ? "eastWest" : "northSouth",
  }));
}

function stepsFitTheChange(answer: ChangeAnswer, change: BriefChange, done: DraftStep[], summary: RoomSummary, brief?: Brief): string[] {
  // "save a scene" is a scene, not a save of the file.
  const t = change.text.replace(/\bsave\b(?=[^.;]{0,25}\b(?:scenes?|camera views?)\b)/gi, "add");
  const problems: string[] = [];
  const has = (op: ChangeStep["op"]) => answer.steps.some((st) => st.op === op);

  const wantsComponent = COMPONENT_WORDS.test(t);
  // (A scene's eye height, "seated eye height (1.1 m)", is a size too, but not of anything new.)
  if (/\d(\.\d+)?\s*m\b/.test(t) && answer.type === "steps" && !has("build") && !has("place") && !has("scene") && !/\bplace\b/i.test(t)) {
    problems.push(`change ${change.line} gives sizes in metres for something new, so it needs a "build" step`);
  }
  if (wantsComponent && answer.type === "steps" && !has("place")) {
    problems.push(`change ${change.line} asks for a real component: use a "place" step with a file from the COMPONENTS list, not a block`);
  }
  if (has("place") && !wantsComponent && !/\bplace\b/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask for a component; don't place one`);
  }
  const sizes = /\d(\.\d+)?\s*m\b/.test(t);
  if ((has("build") || has("place")) && !sizes && !/\b(add|new|build|top|place)\b/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to add anything new, so it must not build or place anything`);
  }
  const replaced = new Set([...done, ...answer.steps].filter((st) => st.op === "replace").map((st) => (st as { target: string }).target));
  for (const st of answer.steps) {
    if (st.op === "place" && replaced.has(st.placement.anchor)) {
      problems.push(`${st.id} is placed beside ${st.placement.anchor}, which this plan takes out; choose the item the change names`);
    }
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
  const own = directionPhrases(t);
  for (const ph of own) {
    for (const st of answer.steps) {
      if (st.op === "build" && st.placement.kind === "beside" && Math.abs(st.placement[ph.field] - ph.value) > 0.001) {
        problems.push(`the brief says "${ph.text}", so ${st.id} needs ${ph.field} ${ph.value} (it has ${st.placement[ph.field]})`);
      }
    }
  }
  // The check follows the BLOCK, not only the change text: when work moves to a later change (the counter,
  // asked for in change 2, built while answering change 3), that change's text has no direction phrase.
  // Then any phrase in the brief applies to a block that has its value in the OTHER direction, i.e. is
  // turned 90° (Windows, 2026-11-12: runs 2 and 3 built the counter eastWest 3 / northSouth 0.7).
  if (own.length === 0 && brief) {
    const others = brief.changes.filter((c) => c.line !== change.line).flatMap((c) => directionPhrases(c.text));
    for (const st of answer.steps) {
      if (st.op !== "build" || st.placement.kind !== "beside") continue;
      const p = st.placement;
      for (const ph of others) {
        const otherField = ph.field === "eastWest" ? "northSouth" : "eastWest";
        if (Math.abs(p[otherField] - ph.value) < 0.001 && Math.abs(p[ph.field] - ph.value) > 0.001) {
          problems.push(`${st.id} looks turned 90°: the brief says "${ph.text}", so set ${ph.field} ${ph.value} and ${otherField} ${p[ph.field]}`);
        }
      }
    }
  }
  if (has("screenshot") && !/screenshot|image|picture|photo|capture/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask for a screenshot; remove it (the plan already shows what replaced items contain)`);
  }
  if (has("save") && !/\bsave\b/i.test(t)) problems.push(`change ${change.line} doesn't ask to save; remove the save step`);
  if (has("scene") && !/\bscenes?\b|\bcamera views?\b/i.test(t)) problems.push(`change ${change.line} doesn't ask for a scene; remove the scene step`);
  if (has("replace") && !/take out|remov|replac|get rid of/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to take anything out; remove the replace step`);
  }
  if ((has("hideTag") || has("showTag")) && !/\b(hide|show|hidden|visible)\b/i.test(t)) {
    problems.push(`change ${change.line} doesn't ask to hide or show a tag; remove those steps`);
  }

  // The checks above catch steps the change did NOT ask for. These catch the opposite: steps it
  // plainly DID ask for and the answer left out. (Windows 2026-11-12: qwen3:8b answered change 8,
  // "hide the tag, take an iso screenshot, show the lighting tag again, then save a copy", with the
  // hideTag alone. Nothing complained, and the plan lost its save, so it could not be run.)
  if (answer.type === "steps") {
    const asked: [boolean, ChangeStep["op"], string][] = [
      [/\bscreenshot\b|\bphoto\b|\bpicture\b/i.test(t), "screenshot", "a screenshot"],
      [/\bsave\b/i.test(t), "save", "a save"],
      [/\bscenes?\b|\bcamera views?\b/i.test(t), "scene", "a scene"],
      [/\bhide\b/i.test(t), "hideTag", "a tag hidden"],
      [/\bshow\b[^.;]{0,30}\btag\b|\bshow\b[^.;]{0,20}\bagain\b/i.test(t), "showTag", "a tag shown again"],
      [/\btake out\b|\bremove\b|\bget rid of\b/i.test(t), "replace", "something taken out"],
    ];
    for (const [wanted, op, what] of asked) {
      if (wanted && !has(op)) problems.push(`change ${change.line} asks for ${what}, but your answer has no "${op}" step`);
    }
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
  for (const st of answer.steps) if ((st.op === "build" || st.op === "place") && !map.has(st.id)) map.set(st.id, `S${next++}`);
  const steps = answer.steps.map((st): ChangeStep => {
    if (st.op === "place") return { ...st, id: map.get(st.id)! };
    if (st.op !== "build") return st;
    const placement = st.placement.kind === "onTop" && map.has(st.placement.of) && st.placement.of !== st.id
      ? { ...st.placement, of: map.get(st.placement.of)! }
      : st.placement;
    return { ...st, id: map.get(st.id)!, placement };
  });
  return { ...answer, steps };
}

/**
 * The brief's measurable rules, checked on a whole plan (used again after an automatic repair moved blocks):
 * "X m clear between them" for a change that builds two blocks.
 */
export function briefRules(brief: Brief): (plan: Plan) => string[] {
  return (plan) => {
    const problems: string[] = [];
    for (const change of brief.changes) {
      const clear = change.text.match(/(\d+(?:\.\d+)?)\s*m clear between/i);
      const mine = plan.actions.filter((a) => a.line === change.line && a.builds);
      if (!clear || mine.length !== 2) continue;
      const got = clearGap(mine[0]!.args.points as number[][], mine[1]!.args.points as number[][]);
      if (Math.abs(got - Number(clear[1])) > 0.01) {
        problems.push(`change ${change.line} wants ${clear[1]} m clear between ${mine[0]!.builds} and ${mine[1]!.builds}, they would have ${got.toFixed(2)} m`);
      }
    }
    return problems;
  };
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
  return steps.filter(isNew).length + 1;
}

const short = (t: string) => (t.length > 90 ? `${t.slice(0, 90)}…` : t).replace(/\*\*/g, "");
