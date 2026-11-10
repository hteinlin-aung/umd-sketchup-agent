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
    along: Metres(0.05, 30), // length running ALONG that side
    across: Metres(0.05, 30), // depth going AWAY from the anchor
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

export const DraftStep = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), line: Line, target: Ref }),
  z.strictObject({
    op: z.literal("build"),
    line: Line,
    id: StepId,
    name: Label,
    placement: Placement,
    height: Metres(0.005, 4), // for "onTop": the thickness
    base: Metres(0, 4).default(0), // bottom above the floor level (ignored for "onTop")
    tag: Label,
    material: Material.optional(),
  }),
  z.strictObject({ op: z.literal("hideTag"), line: Line, tag: Label }),
  z.strictObject({ op: z.literal("showTag"), line: Line, tag: Label }),
  z.strictObject({ op: z.literal("screenshot"), line: Line }),
  z.strictObject({ op: z.literal("save"), line: Line, fileName: z.string().trim().min(1).max(80) }),
]);
export type DraftStep = z.infer<typeof DraftStep>;

export const Draft = z.strictObject({
  steps: z.array(DraftStep).min(1).max(40),
  // changes the model could not turn into steps (e.g. marked "(later)"), with a short reason
  notDone: z.array(z.strictObject({ what: z.string().max(200), reason: z.string().max(200) })).default([]),
});
export type Draft = z.infer<typeof Draft>;

/** JSON Schema handed to Ollama, so the model can only produce this shape. */
export function draftJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Draft, { io: "input" }) as Record<string, unknown>;
}
