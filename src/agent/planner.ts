import { Draft, draftJsonSchema } from "./draft";
import type { ChatMessage, Llm } from "./llm";

/**
 * Step 2c: asks the language model for a draft plan.
 *
 * The model gets the room summary (2b) and your brief, and must answer with JSON in the
 * Draft shape. If the answer doesn't parse, or `check` finds problems (for example a ref
 * that doesn't exist), the model is told exactly what was wrong and gets one more try.
 */

export const SYSTEM_PROMPT = `You turn an interior designer's brief into a plan for a SketchUp model.
You never draw and you never calculate coordinates: the program does that. Answer with JSON only.

Operations (one object per step, in the order of the brief):
- {"op":"replace","line":N,"target":"R5"}  hides an existing item (moved to a hidden "replaced" tag, never deleted)
- {"op":"build","line":N,"id":"S1","name":"...","placement":{...},"height":H,"base":0,"tag":"...","material":{"name":"...","rgb":[r,g,b]}}
    a new solid block. height in metres. base = height of its bottom above the floor (0 = standing on the floor).
    placement "beside": {"kind":"beside","anchor":"R1","side":"east","gap":G,"along":L,"across":D,"shift":0}
      next to an existing item. side = which side of that item (east, west, north, south).
      gap = clear distance from that side. along = length running ALONG that side. across = depth going AWAY from it.
      shift = slide along the side from the item's centre (+ = north or east, - = south or west), 0 = centred.
    placement "onTop": {"kind":"onTop","of":"S1","overhang":O}
      on top of an earlier build step; overhang = how much bigger on every side. height is then the thickness.
- {"op":"hideTag","line":N,"tag":"..."} and {"op":"showTag","line":N,"tag":"..."}
- {"op":"screenshot","line":N}
- {"op":"save","line":N,"fileName":"..."}

Rules:
- Only use refs (R1, R2, ...) that are in the ROOM SUMMARY. Pick the item whose name matches the brief's words.
- line = the number of the brief change the step comes from.
- Every build step has a new id: S1, S2, S3 ...
- Use the brief's sizes exactly, in metres. Apply the brief's tag and material rules to every build step.
- If a change can't be done with these operations (marked "(later)", doors, components, lowering a floor ...),
  don't invent steps: put it in "notDone" with a short reason.

Example (a different room): "1. Hide the old table. 2. Add a 2.0 m long, 0.4 m deep, 0.9 m high shelf 0.5 m
south of the window wall, centred. 3. Save as test.skp" with a summary where R2 = old table, R4 = window wall:
{"steps":[{"op":"replace","line":1,"target":"R2"},
{"op":"build","line":2,"id":"S1","name":"shelf","placement":{"kind":"beside","anchor":"R4","side":"south","gap":0.5,"along":2.0,"across":0.4,"shift":0},"height":0.9,"base":0,"tag":"Furniture (AGENT)"},
{"op":"save","line":3,"fileName":"test.skp"}],"notDone":[]}`;

export function firstMessages(brief: string, summaryText: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `ROOM SUMMARY:\n${summaryText}\n\nBRIEF:\n${brief}\n\nAnswer with the JSON plan.` },
  ];
}

export type DraftResult = { draft: Draft; answers: string[]; tries: number };

export class PlanningError extends Error {
  constructor(
    message: string,
    readonly answers: string[],
  ) {
    super(message);
  }
}

export async function draftPlan(
  llm: Llm,
  brief: string,
  summaryText: string,
  check: (d: Draft) => string[] = () => [],
  maxTries = 2,
): Promise<DraftResult> {
  const messages = firstMessages(brief, summaryText);
  const schema = draftJsonSchema();
  const answers: string[] = [];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const answer = await llm(messages, schema);
    answers.push(answer);
    problems = problemsWith(answer, check);
    if (problems.length === 0) return { draft: Draft.parse(JSON.parse(answer)), answers, tries: attempt };
    messages.push(
      { role: "assistant", content: answer },
      { role: "user", content: `That plan has problems:\n- ${problems.join("\n- ")}\nAnswer again with the corrected JSON plan only.` },
    );
  }
  throw new PlanningError(`the model's plan still has problems after ${maxTries} tries:\n- ${problems.join("\n- ")}`, answers);
}

function problemsWith(answer: string, check: (d: Draft) => string[]): string[] {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch {
    return ["the answer is not valid JSON"];
  }
  const parsed = Draft.safeParse(json);
  if (!parsed.success) return parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`);
  return check(parsed.data);
}
