import { z } from "zod";

/**
 * Every tool: what it accepts (args) and returns (result data).
 * Week 1: ping, getModelInfo, createBox, applyMaterial, captureView, saveCopy.
 * Week 2: findEntities, inspectEntity, measure (read-only).
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

// ---------- findEntities (Week 2) ----------

export const FindEntitiesArgs = z
  .strictObject({
    within: Target.optional(), // search inside this group/component; default: the whole model
    name: z.string().trim().min(1).max(120).optional(), // part of the name or definition name, any case
    tag: Name.optional(), // exact tag name, any case
    type: z.enum(["any", "Group", "ComponentInstance"]).default("any"),
    touches: z.strictObject({ min: Vec3, max: Vec3 }).optional(), // only things whose world box overlaps this box (metres)
    maxDepth: z.number().int().min(1).max(8).default(3), // 1 = direct children only
    limit: z.number().int().min(1).max(500).default(100),
  })
  .refine((a) => !a.touches || a.touches.min.every((v, i) => v <= a.touches!.max[i]!), {
    message: "touches.min must not be greater than touches.max",
    path: ["touches"],
  });

const Found = EntityRef.extend({
  type: z.enum(["Group", "ComponentInstance"]),
  name: z.string(),
  definitionName: z.string(),
  tag: z.string(),
  hidden: z.boolean(),
  path: z.array(z.string()), // names from the top, ending with this one
  depth: z.number().int(),
  bounds: Bounds, // world, metres
  instanceCount: z.number().int(), // >1 = a component used in several places
  childCount: z.number().int(),
  insideSharedComponent: z.boolean(), // true = can't be changed on its own (lives inside a shared component)
});
export const FindEntitiesData = z.object({
  matches: z.array(Found),
  truncated: z.boolean(), // more matches exist than `limit`
  scanned: z.number().int(),
  scanLimitHit: z.boolean(), // the model was too big to search completely; narrow the search
});

// ---------- inspectEntity (Week 2) ----------

export const InspectEntityArgs = z.strictObject({
  target: Target,
  maxChildren: z.number().int().min(0).max(200).default(50),
});
export const InspectEntityData = EntityRef.extend({
  type: z.enum(["Group", "ComponentInstance"]),
  name: z.string(),
  definitionName: z.string(),
  tag: z.string(),
  hidden: z.boolean(),
  path: z.array(z.string()).nullable(), // null when it sits inside a shared component
  worldBounds: Bounds,
  size: Vec3, // world box width (x), depth (y), height (z) in metres
  scaled: z.boolean(), // the instance is stretched; face areas below are unscaled
  instanceCount: z.number().int(),
  instanceMaterial: z.string().nullable(), // material painted on the group/component itself
  faces: z.object({
    count: z.number().int(),
    top: z.number().int(),
    bottom: z.number().int(),
    sides: z.number().int(),
    other: z.number().int(),
    areaM2: z.number(),
  }),
  materials: z.array(z.object({ name: z.string(), faces: z.number().int() })), // "(default)" = unpainted
  childCount: z.number().int(),
  children: z.array(EntityRef.extend({ type: z.enum(["Group", "ComponentInstance"]), name: z.string(), definitionName: z.string(), tag: z.string() })),
  childrenTruncated: z.boolean(),
});

// ---------- measure (Week 2) ----------

/** SketchUp convention: +X = east (red axis), +Y = north (green axis), +Z = up (blue axis). */
export const Direction = z.enum(["down", "up", "north", "south", "east", "west"]);
export const DIRECTION_VECTORS: Record<z.infer<typeof Direction>, Vec3> = {
  down: [0, 0, -1],
  up: [0, 0, 1],
  north: [0, 1, 0],
  south: [0, -1, 0],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

export const MeasureArgs = z.strictObject({
  from: Vec3,
  direction: Direction.default("down"),
  maxDistance: z.number().finite().min(0.01).max(500).default(50),
  allHits: z.boolean().default(false), // false = first surface only; true = keep going through everything
  maxHits: z.number().int().min(1).max(50).default(20),
});
export const MeasureData = z.object({
  from: Vec3,
  direction: Direction,
  hits: z.array(
    z.object({
      point: Vec3,
      distance: z.number(), // metres from `from`
      path: z.array(z.string()), // groups/components the hit surface sits in, from the top
      entityIds: z.array(z.number().int()),
      tag: z.string(), // tag of the innermost group/component (or of the face itself)
      material: z.string().nullable(), // front material of the face that was hit
    }),
  ),
  stoppedBecause: z.enum(["noMoreHits", "maxHits", "maxDistance"]),
});

// ---------- the registry ----------

/**
 * kind decides which models a tool may run on (same rules as main.rb):
 *   always = any time · read = any open model, even the MASTER
 *   file / view = target.txt must match · write = target.txt must match AND never the MASTER
 */
export type ToolKind = "always" | "read" | "file" | "view" | "write";

export const TOOLS = {
  ping: { args: PingArgs, data: PingData, kind: "always", changesModel: false },
  getModelInfo: { args: GetModelInfoArgs, data: GetModelInfoData, kind: "read", changesModel: false },
  createBox: { args: CreateBoxArgs, data: CreateBoxData, kind: "write", changesModel: true },
  applyMaterial: { args: ApplyMaterialArgs, data: ApplyMaterialData, kind: "write", changesModel: true },
  captureView: { args: CaptureViewArgs, data: CaptureViewData, kind: "view", changesModel: false },
  saveCopy: { args: SaveCopyArgs, data: SaveCopyData, kind: "file", changesModel: false },
  findEntities: { args: FindEntitiesArgs, data: FindEntitiesData, kind: "read", changesModel: false },
  inspectEntity: { args: InspectEntityArgs, data: InspectEntityData, kind: "read", changesModel: false },
  measure: { args: MeasureArgs, data: MeasureData, kind: "read", changesModel: false },
} as const satisfies Record<string, { args: z.ZodType; data: z.ZodType; kind: ToolKind; changesModel: boolean }>;

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
