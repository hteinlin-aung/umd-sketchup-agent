import { z } from "zod";

/**
 * Step 2c: what the language model is allowed to answer.
 *
 * The model never writes coordinates or tool calls. It only says WHAT to do and WHERE in
 * words the code understands: "a box 3.0 long, 0.7 deep, 1.05 high, 1.2 m east of R1".
 * resolve.ts turns that into exact coordinates and real tool calls, and checks them.
 * Small models are bad at arithmetic; code is not.
 */

export const Ref = z.string().regex(/^R\d{1,3}$/, 'an item ref from the summary, like "R1"');
export const StepId = z.string().regex(/^S\d{1,3}$/, 'a step id like "S1"');
const Metres = (min: number, max: number) => z.number().min(min).max(max);
const Label = z.string().trim().min(1).max(80);

export const Side = z.enum(["east", "west", "north", "south"]);
export type Side = z.infer<typeof Side>;

/** Where a new shape goes, always relative to something that exists. */
export const Placement = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("beside"),
    anchor: Ref, // the existing item to measure from
    side: Side, // which side of the anchor's box
    gap: Metres(0, 20), // clear distance from that side of the anchor's box
    // Size in compass directions, like the brief says it ("4.0 m long running west" = eastWest 4.0).
    // (Was "along"/"across" the side: qwen3:8b swapped those for the entrance planters, 2026-11-11.)
    eastWest: Metres(0.05, 30), // size from west to east (x)
    northSouth: Metres(0.05, 30), // size from south to north (y)
    shift: Metres(-30, 30).default(0), // slide along the side from the anchor's centre (+ = north or east)
  }),
  z.strictObject({
    kind: z.literal("onTop"),
    of: StepId, // a shape built earlier in this plan
    overhang: Metres(0, 1).default(0), // bigger than that shape by this much on every side
  }),
]);
export type Placement = z.infer<typeof Placement>;

export const Material = z.strictObject({
  name: Label,
  rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]),
});

const Line = z.number().int().min(1).max(99); // the numbered change in the brief this step comes from

const Build = z.strictObject({
  op: z.literal("build"),
  id: StepId,
  name: Label,
  placement: Placement,
  height: Metres(0.005, 4), // for "onTop": the thickness
  base: Metres(0, 4).default(0), // bottom above the floor level (ignored for "onTop")
  tag: Label,
  material: Material.optional(),
});
const Replace = z.strictObject({ op: z.literal("replace"), target: Ref });
const HideTag = z.strictObject({ op: z.literal("hideTag"), tag: Label });
const ShowTag = z.strictObject({ op: z.literal("showTag"), tag: Label });
const Screenshot = z.strictObject({ op: z.literal("screenshot") });
const Save = z.strictObject({ op: z.literal("save"), fileName: z.string().trim().min(1).max(80) });

/** One step as the model writes it for ONE brief change (the code adds the line number). */
export const ChangeStep = z.discriminatedUnion("op", [Replace, Build, HideTag, ShowTag, Screenshot, Save]);
export type ChangeStep = z.infer<typeof ChangeStep>;

/** A step in the whole draft: the same, plus the brief line it comes from. */
export const DraftStep = z.discriminatedUnion("op", [
  Replace.extend({ line: Line }),
  Build.extend({ line: Line }),
  HideTag.extend({ line: Line }),
  ShowTag.extend({ line: Line }),
  Screenshot.extend({ line: Line }),
  Save.extend({ line: Line }),
]);
export type DraftStep = z.infer<typeof DraftStep>;

export const NotDone = z.strictObject({ line: Line.optional(), what: z.string().max(200), reason: z.string().max(300) });

export const Draft = z.strictObject({
  steps: z.array(DraftStep).min(1).max(40),
  // changes that were not turned into steps (marked "(later)", or the model couldn't), with the reason
  notDone: z.array(NotDone).default([]),
});
export type Draft = z.infer<typeof Draft>;

/**
 * The model's answer for ONE brief change:
 * - "steps": the steps for this change;
 * - "rule": the change is a rule for other changes (a tag or material to use), so no steps of its own;
 * - "notPossible": none of the operations can do it (reason says which operation is missing).
 */
export const ChangeAnswer = z.strictObject({
  type: z.enum(["steps", "rule", "notPossible"]),
  steps: z.array(ChangeStep).max(8),
  reason: z.string().max(300),
});
export type ChangeAnswer = z.infer<typeof ChangeAnswer>;

export function changeAnswerJsonSchema(): Record<string, unknown> {
  return ollamaSafe(z.toJSONSchema(ChangeAnswer, { io: "input" })) as Record<string, unknown>;
}

/** JSON Schema handed to Ollama, so the model can only produce this shape. */
export function draftJsonSchema(): Record<string, unknown> {
  return ollamaSafe(z.toJSONSchema(Draft, { io: "input" })) as Record<string, unknown>;
}

/**
 * Ollama builds a parser from the schema and only understands the older array form:
 * a single `items` object. zod 4 writes a tuple the JSON Schema 2020-12 way
 * (`prefixItems: [...]` plus `items: false`), and Ollama rejects that with
 * "schema must be an object". This rewrites every tuple into the form it accepts.
 * Note: the tuples here (rgb) repeat one kind of value, so the first entry describes
 * them all. A tuple of MIXED types would lose that detail; zod still checks the answer.
 */
function ollamaSafe(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(ollamaSafe);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) out[key] = ollamaSafe(value);
  const prefix = out.prefixItems;
  if (Array.isArray(prefix) && prefix.length > 0) {
    delete out.prefixItems;
    out.items = prefix[0];
    out.minItems ??= prefix.length;
    out.maxItems ??= prefix.length;
  } else if (out.items === false) {
    delete out.items;
  }
  return out;
}
