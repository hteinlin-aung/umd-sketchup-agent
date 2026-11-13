import { z } from "zod";

/**
 * Every tool: what it accepts (args) and returns (result data).
 * Week 1: ping, getModelInfo, createBox, applyMaterial, captureView, saveCopy.
 * Week 2: findEntities, inspectEntity, measure (read-only);
 *         createPrism, setTag, setTagVisibility, moveToReplaced (change the model).
 * Week 3: listComponents (read the components folder), componentInfo (measure one), placeComponent.
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

const Coord = z.number().finite().min(-MAX_COORD_M).max(MAX_COORD_M);
export const Vec2 = z.tuple([Coord, Coord]);
export type Vec2 = z.infer<typeof Vec2>;

/** Shoelace formula: area of a polygon given its corners in order (metres -> m²). */
export function polygonArea(points: Vec2[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * True if any two edges of the polygon cross or touch (other than neighbours sharing a corner).
 * A footprint like that ("bow tie") can't become a proper solid in SketchUp.
 */
export function edgesCross(points: Vec2[]): boolean {
  const n = points.length;
  const orient = (a: Vec2, b: Vec2, c: Vec2) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
  };
  const onSegment = (a: Vec2, b: Vec2, p: Vec2) =>
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
  const intersects = (p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2) => {
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    if (o1 !== o2 && o3 !== o4) return true;
    return (
      (o1 === 0 && onSegment(p1, p2, q1)) ||
      (o2 === 0 && onSegment(p1, p2, q2)) ||
      (o3 === 0 && onSegment(q1, q2, p1)) ||
      (o4 === 0 && onSegment(q1, q2, p2))
    );
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last edge share point 0
      if (intersects(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

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

// ---------- facesInBox (Week 3) ----------

export const FacesInBoxArgs = z
  .strictObject({
    target: Target, // the group whose own faces are wanted
    box: z.strictObject({ min: Vec3, max: Vec3 }), // only faces whose world box overlaps this (metres)
    limit: z.number().int().min(1).max(2_000).default(400),
  })
  .refine((a) => a.box.min.every((v, i) => v <= a.box.max[i]!), { message: "box.min must not be greater than box.max", path: ["box"] });
export const FacesInBoxData = z.object({
  faces: z.array(z.object({ bounds: Bounds, tag: z.string(), material: z.string().nullable() })),
  truncated: z.boolean(), // more faces overlap than `limit`
  scanned: z.number().int(),
  entityCount: z.number().int(), // everything inside the group; too many and nothing is scanned at all
  scanLimitHit: z.boolean(), // too big, or took too long: NOT checked (never read this as "clear")
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

// ---------- createPrism (Week 2) ----------

export const CreatePrismArgs = z
  .strictObject({
    jobGroup: Name,
    name: Name,
    tag: Name,
    points: z.array(Vec2).min(3).max(200), // the footprint: world x,y corners (metres), in order around the shape
    z0: Coord, // bottom height (e.g. the 1F finish floor, 1.489)
    z1: Coord, // top height
    material: Name.optional(), // must already exist
  })
  .refine((a) => a.z1 - a.z0 >= 0.001, { message: "z1 must be at least 1 mm above z0", path: ["z1"] })
  .refine(
    (a) =>
      a.points.every((p, i) => {
        const q = a.points[(i + 1) % a.points.length]!;
        return Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.001;
      }),
    { message: "two neighbouring points are less than 1 mm apart (repeated point?)", path: ["points"] },
  )
  .refine((a) => polygonArea(a.points) >= 0.0001, { message: "the footprint has (almost) no area", path: ["points"] })
  .refine((a) => !edgesCross(a.points), { message: "the footprint's edges cross each other (a 'bow tie' shape)", path: ["points"] });
export const CreatePrismData = EntityRef.extend({
  jobGroupId: z.number().int(),
  worldBounds: Bounds, // measured after creation
  footprintAreaM2: z.number(),
  volumeM3: z.number(), // measured: SketchUp's own solid volume
  faceCount: z.number().int(),
});

// ---------- setTag / setTagVisibility / moveToReplaced (Week 2) ----------

export const SetTagArgs = z.strictObject({ target: Target, tag: Name });
export const SetTagData = EntityRef.extend({ previousTag: z.string(), tag: z.string(), created: z.boolean() });

export const SetTagVisibilityArgs = z.strictObject({ tag: Name, visible: z.boolean() });
export const SetTagVisibilityData = z.object({ tag: z.string(), previous: z.boolean(), visible: z.boolean() });

/** Your thesis habit: replaced work is HIDDEN on a "zz_REPLACED by …" tag, never deleted. */
export const MoveToReplacedArgs = z.strictObject({
  target: Target,
  replacedBy: z.string().trim().min(1).max(60), // short label, e.g. "T201 oak bench"
});
export const MoveToReplacedData = EntityRef.extend({ previousTag: z.string(), tag: z.string(), tagHidden: z.boolean() });

export function replacedTagName(replacedBy: string): string {
  return `zz_REPLACED by ${replacedBy.trim()} (hidden)`;
}

// ---------- components (Week 3) ----------
// Real 3D Warehouse pieces from ONE folder on the Windows PC: <the queue folder's parent>/components
// (E:/Cowork_Field/Thesis_SketchUp/components). Only a plain file name is ever sent, never a path.

/** A component file in that folder. 3D Warehouse names use a few more characters than our own files. */
export const ComponentFile = z
  .string()
  .regex(/^[A-Za-z0-9 _.()&,'+-]{1,120}\.skp$/i, "must be a plain .skp file name from the components folder (no folders)")
  .refine((s) => !s.includes(".."), "must not contain '..'");

export const ListComponentsArgs = z.strictObject({});
export const ListComponentsData = z.object({
  folder: z.string(),
  files: z.array(z.object({ file: z.string(), bytes: z.number().int() })),
});

/** Loads the file just long enough to measure it, then removes it again: the model ends up unchanged. */
export const ComponentInfoArgs = z.strictObject({ file: ComponentFile });
export const ComponentInfoData = z.object({
  file: z.string(),
  bytes: z.number().int(),
  definitionName: z.string(),
  size: Vec3, // metres, x / y / z of the component as it comes (rotation 0)
});

export const Rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const PlaceComponentArgs = z.strictObject({
  jobGroup: Name, // same group as the agent's other new blocks
  file: ComponentFile,
  name: Name,
  tag: Name,
  at: Vec3, // where the component's box MIN corner (south-west, bottom) goes, after rotating
  rotation: Rotation.default(0), // degrees, anticlockwise seen from above
  scale: z.number().min(0.01).max(100).default(1), // uniform (all three directions alike), for files drawn at the wrong scale
});
export const PlaceComponentData = EntityRef.extend({
  jobGroupId: z.number().int(),
  definitionName: z.string(),
  worldBounds: Bounds, // measured after placing
});

/** A picture of a component file, made by SketchUp from the file itself (the model is not touched). */
export const ComponentPreviewArgs = z.strictObject({ file: ComponentFile });
export const ComponentPreviewData = z.object({ file: z.string(), path: z.string(), bytes: z.number().int() });

// ---------- addScene (Week 3) ----------

/**
 * A saved camera view (a SketchUp scene, a tab at the top of the window). D5 Render and SketchUp's own
 * Scenes panel both use these. The scene remembers the camera AND which tags are visible right now.
 * Up is always straight up (z), so walls stay vertical. If the name is taken, the bridge adds " (2)", " (3)" ...
 * and never changes a scene you already have.
 */
export const AddSceneArgs = z
  .strictObject({
    name: Name,
    eye: Vec3, // where the camera stands (metres)
    target: Vec3, // the point it looks at (metres)
    fov: z.number().min(10).max(120).default(55), // field of view in degrees (SketchUp measures it top to bottom)
  })
  .refine((a) => Math.hypot(a.eye[0] - a.target[0], a.eye[1] - a.target[1], a.eye[2] - a.target[2]) >= 0.1, {
    message: "eye and target must be at least 0.1 m apart",
  })
  .refine((a) => Math.hypot(a.eye[0] - a.target[0], a.eye[1] - a.target[1]) >= 0.01, {
    message: "the camera can't look straight up or down (up is always z)",
  });
export const AddSceneData = z.object({
  name: z.string(), // the name it got (with " (2)" if the asked name was taken)
  renamed: z.boolean(),
  sceneCount: z.number().int(),
  eye: Vec3,
  target: Vec3,
  fov: z.number(),
  hiddenTags: z.array(z.string()), // the tags this scene keeps hidden
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
  facesInBox: { args: FacesInBoxArgs, data: FacesInBoxData, kind: "read", changesModel: false },
  measure: { args: MeasureArgs, data: MeasureData, kind: "read", changesModel: false },
  createPrism: { args: CreatePrismArgs, data: CreatePrismData, kind: "write", changesModel: true },
  setTag: { args: SetTagArgs, data: SetTagData, kind: "write", changesModel: true },
  setTagVisibility: { args: SetTagVisibilityArgs, data: SetTagVisibilityData, kind: "write", changesModel: true },
  moveToReplaced: { args: MoveToReplacedArgs, data: MoveToReplacedData, kind: "write", changesModel: true },
  listComponents: { args: ListComponentsArgs, data: ListComponentsData, kind: "read", changesModel: false },
  componentInfo: { args: ComponentInfoArgs, data: ComponentInfoData, kind: "write", changesModel: false },
  placeComponent: { args: PlaceComponentArgs, data: PlaceComponentData, kind: "write", changesModel: true },
  componentPreview: { args: ComponentPreviewArgs, data: ComponentPreviewData, kind: "read", changesModel: false },
  addScene: { args: AddSceneArgs, data: AddSceneData, kind: "write", changesModel: true },
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
