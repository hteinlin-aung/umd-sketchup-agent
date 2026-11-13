import { z } from "zod";

/**
 * Step 2c: what the language model is allowed to answer.
 *
 * The model never writes coordinates or tool calls. It only says WHAT to do and WHERE in
 * words the code understands: "a box 3.0 long, 0.7 deep, 1.05 high, 1.2 m east of R1".
 * resolve.ts turns that into exact coordinates and real tool calls, and checks them.
 * Small models are bad at arithmetic; code is not.
 */

// No example ref in the message: told 'like "R1"', qwen3:8b wrote "R1" - the floor finish - instead of the wall the
// brief named (Windows, 2026-11-14, brief 7).
export const Ref = z.string().regex(/^R\d{1,3}$/, "the ref of an item in the room summary (the R-number written before its name), not its name");
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

/** Where a component goes: like "beside", but its size comes from the catalog, not from the model. */
export const PlacePlacement = z.strictObject({
  kind: z.literal("beside"),
  anchor: Ref,
  side: Side,
  gap: Metres(0, 20),
  shift: Metres(-30, 30).default(0),
});
const Place = z.strictObject({
  op: z.literal("place"),
  id: StepId,
  component: z.string().trim().min(5).max(124), // a file name from the COMPONENTS list
  name: Label,
  placement: PlacePlacement,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  base: Metres(0, 4).default(0),
  tag: Label,
  // Only when the brief gives THIS piece's size; otherwise the code picks a sensible size (catalog.ts).
  size: z.strictObject({ height: Metres(0.05, 6).optional(), across: Metres(0.05, 12).optional() }).optional(),
});
const HideTag = z.strictObject({ op: z.literal("hideTag"), tag: Label });
const ShowTag = z.strictObject({ op: z.literal("showTag"), tag: Label });
const Screenshot = z.strictObject({ op: z.literal("screenshot") });
const Save = z.strictObject({ op: z.literal("save"), fileName: z.string().trim().min(1).max(80) });

/**
 * A saved camera view (a SketchUp scene, which D5 picks up). The model never gives coordinates:
 * - from "south" (or any compass side/corner): standing just inside that side of the room, at eye height;
 * - from "R6": standing just inside that item (the entrance, a window), on the room's side of it;
 * - from "above": the whole room from the south-east, above (like the screenshot).
 * It looks at the middle of the room, or at `toward` when the brief says what the view is of.
 */
export const SCENE_FROM = ["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest", "above"] as const;
const Scene = z.strictObject({
  op: z.literal("scene"),
  name: Label,
  from: z.string().trim().regex(new RegExp(`^(R\\d{1,3}|${SCENE_FROM.join("|")})$`), 'a side of the room ("south", "northeast" ...), "above", or an item ref like "R6"'),
  toward: Ref.optional(),
  eyeHeight: Metres(0.3, 3).default(1.6),
});

/** One step as the model writes it for ONE brief change (the code adds the line number). */
export const ChangeStep = z.discriminatedUnion("op", [Replace, Build, Place, HideTag, ShowTag, Screenshot, Scene, Save]);
export type ChangeStep = z.infer<typeof ChangeStep>;

/** A step in the whole draft: the same, plus the brief line it comes from. */
export const DraftStep = z.discriminatedUnion("op", [
  Replace.extend({ line: Line }),
  Build.extend({ line: Line }),
  Place.extend({ line: Line }),
  HideTag.extend({ line: Line }),
  ShowTag.extend({ line: Line }),
  Screenshot.extend({ line: Line }),
  Scene.extend({ line: Line }),
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
