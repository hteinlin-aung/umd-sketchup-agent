import type { BridgeClient } from "../bridge/client";
import type { Bounds, DataOf, Target } from "../protocol/tools";
import { UMD_LEVELS, type UmdFloor } from "../project/umdLevels";

/**
 * Step 2b: a short description of one room that a small local model can read.
 *
 * Built only from what SketchUp reports: every direct child of the room with its box,
 * tag and what it really CONTAINS. Names are not trusted ("Sofa set 4" held only a palm),
 * so the contents are listed and obvious name/content mismatches are flagged.
 *
 * Each item gets a short ref (R1, R2, ...). The planner refers to things by ref, and the
 * ref maps back to a persistentId, which survives save and reopen.
 */

type Found = DataOf<"findEntities">["matches"][number];

export type SummaryItem = {
  ref: string;
  name: string;
  type: "Group" | "ComponentInstance";
  tag: string;
  visible: boolean; // false if hidden itself or its tag is hidden
  entityId: number;
  persistentId: number;
  path: string[];
  bounds: Bounds;
  size: [number, number, number];
  contents: string[]; // direct children, grouped: "3× steel post 40"
  childCount: number;
  categories: string[]; // what the contents look like: furniture, plant, glass, light
  warnings: string[];
  canChange: boolean; // false = inside a component used more than once
};

export type RoomSummary = {
  room: { name: string; entityId: number; persistentId: number; path: string[]; bounds: Bounds; size: [number, number, number] };
  floor: { z: number; source: string };
  modelPath: string;
  items: SummaryItem[];
  tags: { name: string; visible: boolean }[];
  materials: { design: string[]; otherCount: number }; // design = "UMD ..." materials; the rest are mostly 3D Warehouse imports
  notes: string[];
};

const CATEGORIES: Record<string, RegExp> = {
  furniture: /\b(sofa|chair|armchair|table|desk|counter|bench|stool|bed|cabinet|shelf|rug|seat)s?\b/i,
  plant: /\b(plant|planting|palm|fern|tree|moss|areca|chamaedorea|monstera|ficus|grass|shrub|forest)s?\b/i,
  glass: /\b(glass|glazing|window)\b/i,
  light: /\b(light|lights|downlight|lamp|led|chandelier)\b/i,
};

export function categoriesOf(text: string): string[] {
  return Object.entries(CATEGORIES)
    .filter(([, re]) => re.test(text))
    .map(([c]) => c);
}

/** Materials the design uses on purpose are named "UMD ..."; everything else came in with 3D Warehouse models. */
const DESIGN_MATERIAL = /^UMD\b/i;

const GENERIC_NAME = /^(group|component)#\d+$/i;

function labelOf(e: { name: string; definitionName: string }): string {
  if (e.name.trim()) return e.name.trim();
  return GENERIC_NAME.test(e.definitionName) ? "" : e.definitionName;
}

/** "steel post 40" x3 -> "3× steel post 40"; unnamed parts are counted together. */
export function groupNames(labels: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l || "(unnamed part)", (counts.get(l || "(unnamed part)") ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${n}× ${l}` : l));
}

const sizeOf = (b: Bounds): [number, number, number] => [0, 1, 2].map((i) => round(b.max[i]! - b.min[i]!)) as [number, number, number];

/**
 * The name says one thing (a sofa) but nothing inside looks like it, while something
 * else clearly does (a palm). Only flags when the contents have recognisable names,
 * so a sofa made of unnamed parts is not flagged.
 */
export function mismatchWarning(name: string, contentLabels: string[]): string | null {
  const said = categoriesOf(name).filter((c) => c === "furniture");
  if (said.length === 0) return null;
  const seen = new Set(contentLabels.flatMap(categoriesOf));
  if (seen.size === 0 || seen.has("furniture")) return null;
  const word = name.match(CATEGORIES.furniture!)?.[0] ?? "furniture";
  return `name says "${word.toLowerCase()}" but the contents look like ${[...seen].join(" + ")} only`;
}

function floorFor(room: { name: string; path: string[] }, roomBounds: Bounds): RoomSummary["floor"] {
  const text = [...room.path, room.name].join(" ");
  const m = text.match(/\b([123])F\b/i);
  if (m) {
    const floor = `${m[1]}F` as UmdFloor;
    const z = UMD_LEVELS[floor].finishFloor;
    return { z, source: `${floor} finish floor (confirmed levels)` };
  }
  return { z: round(roomBounds.min[2]), source: "lowest point of the room (no floor level known for this name)" };
}

export async function summarizeRoom(client: BridgeClient, roomTarget: Target, maxItems = 40): Promise<RoomSummary> {
  const room = await client.call("inspectEntity", { target: roomTarget, maxChildren: 0 });
  if (!room.ok) throw new Error(`room not found: ${room.error.code}: ${room.error.message}`);
  const info = await client.call("getModelInfo", { maxItems: 1000 });
  if (!info.ok) throw new Error(`getModelInfo failed: ${info.error.code}: ${info.error.message}`);
  const tagVisible = new Map(info.data.tags.map((t) => [t.name, t.visible]));

  const within: Target = { persistentId: room.data.persistentId };
  const direct = await client.call("findEntities", { within, maxDepth: 1, limit: maxItems });
  if (!direct.ok) throw new Error(`findEntities failed: ${direct.error.code}: ${direct.error.message}`);

  const notes: string[] = [];
  if (direct.data.truncated) notes.push(`only the first ${maxItems} items are listed; the room has more`);

  const items: SummaryItem[] = [];
  for (const [i, e] of direct.data.matches.entries()) {
    // Two levels deep is enough to see what something really is, and keeps big models fast.
    const inside = await client.call("findEntities", { within: { persistentId: e.persistentId }, maxDepth: 2, limit: 100 });
    const all: Found[] = inside.ok ? inside.data.matches : [];
    const childLabels = all.filter((c) => c.depth === 1).map(labelOf);
    const allLabels = all.map(labelOf).filter(Boolean);
    const name = labelOf(e) || "(unnamed)";
    const warnings: string[] = [];
    const mismatch = mismatchWarning(name, allLabels);
    if (mismatch) warnings.push(mismatch);
    if (e.insideSharedComponent) warnings.push("inside a shared component: cannot be changed on its own");
    if (!inside.ok) warnings.push(`contents unknown (${inside.error.code})`);
    items.push({
      ref: `R${i + 1}`,
      name,
      type: e.type,
      tag: e.tag,
      visible: !e.hidden && tagVisible.get(e.tag) !== false,
      entityId: e.entityId,
      persistentId: e.persistentId,
      path: e.path,
      bounds: roundBounds(e.bounds),
      size: sizeOf(e.bounds),
      contents: groupNames(childLabels),
      childCount: e.childCount,
      categories: [...new Set(allLabels.flatMap(categoriesOf))],
      warnings,
      canChange: !e.insideSharedComponent,
    });
  }

  const roomName = labelOf(room.data) || "(unnamed room)";
  const roomPath = room.data.path ?? [roomName];
  const floor = floorFor({ name: roomName, path: roomPath }, room.data.worldBounds);
  if (Math.abs(room.data.worldBounds.min[2] - floor.z) > 0.05) {
    notes.push(`the room's lowest point (${round(room.data.worldBounds.min[2])}) is not the floor level (${floor.z}); build on the floor level`);
  }

  const roomTags = new Set(items.map((it) => it.tag));
  const design = info.data.materials.filter((m) => DESIGN_MATERIAL.test(m));
  if (info.data.truncated) notes.push("the model has more tags/materials than getModelInfo returned; some may be missing");
  return {
    room: {
      name: roomName,
      entityId: room.data.entityId,
      persistentId: room.data.persistentId,
      path: roomPath,
      bounds: roundBounds(room.data.worldBounds),
      size: sizeOf(room.data.worldBounds),
    },
    floor,
    modelPath: info.data.modelPath,
    items,
    tags: info.data.tags.filter((t) => roomTags.has(t.name) || /reception|agent|replaced/i.test(t.name)),
    materials: { design, otherCount: info.data.counts.materials - design.length },
    notes,
  };
}

/** Compact text for the language model (and for you to read). Metres, +x east, +y north, +z up. */
export function renderSummary(s: RoomSummary): string {
  const r = s.room;
  const lines = [
    `ROOM: ${r.name}`,
    `model: ${s.modelPath}`,
    `units: metres. axes: +x = east, +y = north, +z = up.`,
    `floor level: z ${fmt(s.floor.z)} (${s.floor.source})`,
    `room box: ${boxText(r.bounds)}   size ${r.size.map(fmt).join(" x ")}`,
    "",
    "ITEMS (refer to them by ref):",
  ];
  for (const it of s.items) {
    const flags = [it.visible ? "" : "HIDDEN", it.canChange ? "" : "LOCKED"].filter(Boolean).join(", ");
    lines.push(`${it.ref}  ${it.name}${flags ? `  [${flags}]` : ""}`);
    lines.push(`    tag: ${it.tag} | ${boxText(it.bounds)} | size ${it.size.map(fmt).join(" x ")}`);
    const more = it.contents.length - 8;
    if (it.contents.length) lines.push(`    contains: ${it.contents.slice(0, 8).join("; ")}${more > 0 ? `; ... (+${more} more)` : ""}`);
    for (const w of it.warnings) lines.push(`    WARNING: ${w}`);
  }
  lines.push("", `TAGS: ${s.tags.map((t) => `${t.name}${t.visible ? "" : " (hidden)"}`).join(" | ")}`);
  const m = s.materials;
  lines.push(
    `DESIGN MATERIALS: ${m.design.join(" | ") || "(none yet; new ones are created with a colour)"}` +
      (m.otherCount > 0 ? `   (+${m.otherCount} other materials from 3D Warehouse models, not listed)` : ""),
  );
  for (const n of s.notes) lines.push(`NOTE: ${n}`);
  return lines.join("\n");
}

function boxText(b: Bounds): string {
  return `x ${fmt(b.min[0])}..${fmt(b.max[0])}  y ${fmt(b.min[1])}..${fmt(b.max[1])}  z ${fmt(b.min[2])}..${fmt(b.max[2])}`;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => round(v).toFixed(3).replace(/\.?0+$/, "");
const roundBounds = (b: Bounds): Bounds => ({ min: b.min.map(round) as Bounds["min"], max: b.max.map(round) as Bounds["max"] });
