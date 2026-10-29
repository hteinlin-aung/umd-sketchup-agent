import { z } from "zod";

/**
 * Week 1 tools: what each one accepts (args) and returns (result data).
 * All lengths are in METRES, in SketchUp world coordinates (Z up).
 * The Ruby side converts to inches; nothing else in TypeScript should.
 *
 * Adding a tool = add an entry to TOOLS below + a Ruby handler with the same
 * name + tests. Week 2 tools are yours to write here (see PLAN.md §10).
 */

// ---------- shared pieces ----------

const MAX_COORD_M = 2_000; // anything bigger is a typo (e.g. mm typed as m)

export const Vec3 = z.tuple([
  z.number().finite().min(-MAX_COORD_M).max(MAX_COORD_M),
  z.number().finite().min(-MAX_COORD_M).max(MAX_COORD_M),
  z.number().finite().min(-MAX_COORD_M).max(MAX_COORD_M),
]);
export type Vec3 = z.infer<typeof Vec3>;

export const Bounds = z.object({ min: Vec3, max: Vec3 });
export type Bounds = z.infer<typeof Bounds>;

// A short, human name: used for groups, tags and materials.
const Name = z.string().trim().min(1).max(120);

/** How a tool finds an existing group/component. Exactly one way per call. */
export const Target = z.union([
  z.strictObject({ entityId: z.number().int().positive() }), // valid for this SketchUp session only
  z.strictObject({ persistentId: z.number().int().positive() }), // survives save and reopen
  z.strictObject({ path: z.array(Name).min(1).max(12) }), // names from the top: ["UMD 1F", "1F RECEPTION (T128)"]
]);
export type Target = z.infer<typeof Target>;

const Rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

// File names only, never folders: the Ruby side decides where files go.
const SafeFileName = (ext: string) =>
  z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9 _.-]{1,100}\\.${ext}$`), `must be a plain file name ending in .${ext} (no folders)`)
    .refine((s) => !s.includes(".."), "must not contain '..'");

const EntityRef = z.object({ entityId: z.number().int(), persistentId: z.number().int() });

// ---------- ping ----------

export const PingArgs = z.strictObject({});
export const PingData = z.object({
  bridgeVersion: z.string(),
  protocol: z.number(),
  sketchupVersion: z.string(),
  rubyVersion: z.string(),
  isPro: z.boolean(),
  modelPath: z.string(),
  modelTitle: z.string(),
  targetPattern: z.string().nullable(),
  tools: z.array(z.string()),
});

// ---------- getModelInfo ----------

export const GetModelInfoArgs = z.strictObject({
  maxItems: z.number().int().min(1).max(1_000).default(200),
});
export const GetModelInfoData = z.object({
  modelPath: z.string(),
  modelBounds: Bounds.nullable(),
  counts: z.object({ definitions: z.number(), materials: z.number(), tags: z.number(), scenes: z.number() }),
  tags: z.array(z.object({ name: z.string(), visible: z.boolean() })),
  scenes: z.array(z.string()),
  materials: z.array(z.string()),
  topLevel: z.array(
    EntityRef.extend({
      type: z.enum(["Group", "ComponentInstance"]),
      name: z.string(),
      definitionName: z.string(),
      tag: z.string(),
      hidden: z.boolean(),
      bounds: Bounds,
      childCount: z.number(),
    }),
  ),
  truncated: z.boolean(),
});

// ---------- createBox ----------

export const CreateBoxArgs = z
  .strictObject({
    jobGroup: Name, // top-level group that holds all agent work for this job (created if missing)
    name: Name, // name of the new box group
    tag: Name,
    min: Vec3,
    max: Vec3,
    material: Name.optional(), // must already exist (use applyMaterial with `color` to create one)
  })
  .refine((a) => a.max[0] > a.min[0] && a.max[1] > a.min[1] && a.max[2] > a.min[2], {
    message: "max must be greater than min on x, y and z",
    path: ["max"],
  })
  .refine((a) => a.max.every((v, i) => v - a.min[i]! >= 0.001), {
    message: "every side must be at least 1 mm",
    path: ["max"],
  });
export const CreateBoxData = EntityRef.extend({
  jobGroupId: z.number().int(),
  worldBounds: Bounds, // measured AFTER creation, not copied from the request
  faceCount: z.number().int(),
});

// ---------- applyMaterial ----------

export const ApplyMaterialArgs = z.strictObject({
  target: Target,
  material: Name,
  color: Rgb.optional(), // only used to CREATE the material if it does not exist yet
  faces: z.enum(["all", "top", "sides"]).default("all"),
  paintBack: z.boolean().default(false), // also paint the back of each face
});
export const ApplyMaterialData = z.object({
  materialName: z.string(),
  created: z.boolean(),
  facesPainted: z.number().int(),
  facesChecked: z.number().int(), // faces read back that really have the material
});

// ---------- captureView ----------

export const CaptureViewArgs = z.strictObject({
  fileName: SafeFileName("png"),
  width: z.number().int().min(320).max(4_096).default(1_600),
  height: z.number().int().min(240).max(4_096).default(900),
  scene: Name.optional(), // use this scene's camera
  zoomTo: Target.optional(), // or zoom to fit this entity
});
export const CaptureViewData = z.object({
  path: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});

// ---------- saveCopy ----------

export const SaveCopyArgs = z.strictObject({
  fileName: SafeFileName("skp").refine((s) => !/master/i.test(s), "a copy must not be called MASTER"),
});
export const SaveCopyData = z.object({ path: z.string(), bytes: z.number().int() });

// ---------- the registry ----------

export const TOOLS = {
  ping: { args: PingArgs, data: PingData, changesModel: false },
  getModelInfo: { args: GetModelInfoArgs, data: GetModelInfoData, changesModel: false },
  createBox: { args: CreateBoxArgs, data: CreateBoxData, changesModel: true },
  applyMaterial: { args: ApplyMaterialArgs, data: ApplyMaterialData, changesModel: true },
  captureView: { args: CaptureViewArgs, data: CaptureViewData, changesModel: false },
  saveCopy: { args: SaveCopyArgs, data: SaveCopyData, changesModel: false },
} as const;

export type ToolName = keyof typeof TOOLS;
/** What you pass in (defaults may be left out). */
export type ArgsIn<T extends ToolName> = z.input<(typeof TOOLS)[T]["args"]>;
/** What the tool gets after defaults are filled in. */
export type ArgsOut<T extends ToolName> = z.output<(typeof TOOLS)[T]["args"]>;
export type DataOf<T extends ToolName> = z.output<(typeof TOOLS)[T]["data"]>;

export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}
