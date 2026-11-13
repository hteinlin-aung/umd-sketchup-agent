import type { BridgeClient } from "../bridge/client";
import type { Bounds, DataOf, Target } from "../protocol/tools";
import { UMD_LEVELS, type UmdFloor } from "../project/umdLevels";
import { findSubRooms, type SubRoom, type TradeItem } from "./subRooms";

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
  measureOnly?: string; // a sub-room or one of its parts, found from names: what it is, for error messages
};

export type RoomSummary = {
  room: { name: string; entityId: number; persistentId: number; path: string[]; bounds: Bounds; size: [number, number, number] };
  floor: { z: number; source: string };
  modelPath: string;
  items: SummaryItem[];
  tags: { name: string; visible: boolean }[];
  materials: { design: string[]; otherCount: number }; // design = "UMD ..." materials; the rest are mostly 3D Warehouse imports
  notes: string[];
  subRooms?: SubRoom[]; // rooms found from part names when the group is organised by trade (subRooms.ts)
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

/**
 * The floor new pieces stand on. Windows, 2026-11-14 (2F copy): "NEW_2F_Pool_Area..." didn't match "\b2F\b" (an
 * underscore is a word character), so the floor became the room's lowest point - the BOTTOM OF THE POOL BASIN, 1.2 m
 * down - and "LOBBY_WAITING (T138)" has no floor in its name at all.
 *  1. a floor in the name: "1F ...", "NEW_2F_Pool", "(3F)" - an underscore counts as a gap;
 *  2. else the confirmed finish floor that lies within the room's height (the lowest, if several);
 *  3. else the room's lowest point, and the summary says so.
 */
export function floorFor(room: { name: string; path: string[] }, roomBounds: Bounds): RoomSummary["floor"] {
  const text = [...room.path, room.name].join(" ");
  const m = text.match(/(?:^|[^a-z0-9])([123])F(?![a-z0-9])/i);
  if (m) {
    const floor = `${m[1]}F` as UmdFloor;
    const z = UMD_LEVELS[floor].finishFloor;
    return { z, source: `${floor} finish floor (confirmed levels)` };
  }
  const within = (["1F", "2F", "3F"] as const).filter((f) => {
    const z = UMD_LEVELS[f].finishFloor;
    return z >= roomBounds.min[2] - 0.05 && z <= roomBounds.max[2];
  });
  if (within.length) {
    const floor = within[0]!;
    return { z: UMD_LEVELS[floor].finishFloor, source: `${floor} finish floor (confirmed levels; the room's height takes in that floor)` };
  }
  return { z: round(roomBounds.min[2]), source: "lowest point of the room (no floor level known for this name)" };
}

/** Finds the one room whose name contains `query` (the shallowest match). Throws a readable error otherwise. */
export async function findRoom(client: BridgeClient, query: string): Promise<{ persistentId: number; path: string[] }> {
  const found = await client.call("findEntities", { name: query, maxDepth: 3, limit: 20 });
  if (!found.ok) throw new Error(`${found.error.code}: ${found.error.message}`);
  if (found.data.matches.length === 0) throw new Error(`nothing in this model is called "${query}"`);
  const best = Math.min(...found.data.matches.map((m) => m.depth));
  const rooms = found.data.matches.filter((m) => m.depth === best);
  if (rooms.length > 1) {
    throw new Error(`"${query}" matches ${rooms.length} things, be more specific:\n${rooms.map((r) => `  ${r.path.join(" > ")}`).join("\n")}`);
  }
  return { persistentId: rooms[0]!.persistentId, path: rooms[0]!.path };
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
  const trade: TradeItem[] = [];
  for (const [i, e] of direct.data.matches.entries()) {
    // Direct parts only. The search limit counts EVERYTHING found, so going deeper let parts-of-parts
    // use up the limit: 115 downlights with 4 parts each were cut at 500 = 100 downlights (Windows, 2026-11-11).
    const inside = await client.call("findEntities", { within: { persistentId: e.persistentId }, maxDepth: 1, limit: 500 });
    const all: Found[] = inside.ok ? inside.data.matches : [];
    const childLabels = all.map(labelOf);
    const allLabels = all.map(labelOf).filter(Boolean);
    const name = labelOf(e) || "(unnamed)";
    const warnings: string[] = [];
    const mismatch = mismatchWarning(name, allLabels);
    if (mismatch) warnings.push(mismatch);
    if (e.insideSharedComponent) warnings.push("inside a shared component: cannot be changed on its own");
    if (!inside.ok) warnings.push(`contents unknown (${inside.error.code})`);
    if (inside.ok && childLabels.length < e.childCount) {
      warnings.push(`contents list incomplete: read ${childLabels.length} of ${e.childCount} parts`);
    }
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
    trade.push({ ref: `R${i + 1}`, name, parts: all });
  }

  const roomName = labelOf(room.data) || "(unnamed room)";
  const roomPath = room.data.path ?? [roomName];
  const floor = floorFor({ name: roomName, path: roomPath }, room.data.worldBounds);
  if (Math.abs(room.data.worldBounds.min[2] - floor.z) > 0.05) {
    notes.push(`the room's lowest point (${round(room.data.worldBounds.min[2])}) is not the floor level (${floor.z}); build on the floor level`);
  }

  const subRooms = findSubRooms(trade, { floorZ: floor.z, top: round(room.data.worldBounds.max[2]) }, items.length + 1);
  if (subRooms.length) {
    notes.push(`this group is organised by trade: ${subRooms.length} rooms were found from the part names (SUB-ROOMS); to put something in one, use "inside" with its V-ref`);
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
    ...(subRooms.length ? { subRooms } : {}),
  };
}

/** Compact text for the language model (and for you to read). Metres, +x east, +y north, +z up. */
export function renderSummary(s: RoomSummary, opts: { focus?: string } = {}): string {
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
  const subs = s.subRooms ?? [];
  // With sub-rooms the trade items' contents are listed again, room by room, below: keep them short (the model has 8k tokens).
  const shown = subs.length ? 3 : 8;
  for (const it of s.items) {
    const flags = [it.visible ? "" : "HIDDEN", it.canChange ? "" : "LOCKED"].filter(Boolean).join(", ");
    lines.push(`${it.ref}  ${it.name}${flags ? `  [${flags}]` : ""}`);
    const runs = runsWhichWay(it.size);
    lines.push(`    tag: ${it.tag} | ${boxText(it.bounds)} | size ${it.size.map(fmt).join(" x ")}${runs ? ` | runs ${runs}` : ""}`);
    const more = it.contents.length - shown;
    if (it.contents.length) lines.push(`    contains: ${it.contents.slice(0, shown).join("; ")}${more > 0 ? `; ... (+${more} more)` : ""}`);
    for (const w of it.warnings) lines.push(`    WARNING: ${w}`);
  }
  if (subs.length) lines.push("", ...renderSubRooms(subs, opts.focus));
  const tagText = (t: { name: string; visible: boolean }) => (t.visible || /\(hidden\)\s*$/i.test(t.name) ? t.name : `${t.name} (hidden)`);
  lines.push("", `TAGS: ${s.tags.map(tagText).join(" | ")}`);
  const m = s.materials;
  lines.push(
    `DESIGN MATERIALS: ${m.design.join(" | ") || "(none yet; new ones are created with a colour)"}` +
      (m.otherCount > 0 ? `   (+${m.otherCount} other materials from 3D Warehouse models, not listed)` : ""),
  );
  for (const n of s.notes) lines.push(`NOTE: ${n}`);
  return lines.join("\n");
}

/**
 * The SUB-ROOMS block. With a focus (the brief's text), only the rooms it names list their parts; the others get one
 * line each, so 92 parts on 3F don't crowd the brief out of the model's 8k-token window. No room named = all listed.
 */
export function renderSubRooms(subs: SubRoom[], focus?: string): string[] {
  const named = focus ? subs.filter((r) => mentions(focus, r.name)) : subs;
  const full = new Set((named.length ? named : subs).map((r) => r.ref));
  const lines = ["SUB-ROOMS (found from part names; measure from them, never take them out or move them):"];
  for (const r of subs) {
    lines.push(`${r.ref}  ${r.name}  [SUB-ROOM]`);
    lines.push(`    ${boxText(r.bounds)} | size ${r.size.map(fmt).join(" x ")} | box = ${r.boxFrom}`);
    if (!full.has(r.ref)) {
      lines.push(`    ${r.parts.length} parts, not listed here (the brief does not name this room)`);
      continue;
    }
    for (const p of r.parts) {
      const runs = runsWhichWay(p.size);
      const label = p.name.toLowerCase().startsWith(r.name.toLowerCase()) ? p.name.slice(r.name.length).replace(/^\s*-\s*/, "").trim() : p.name;
      lines.push(`    ${p.ref}  ${p.count > 1 ? `${p.count}x ` : ""}${label} | ${boxText(p.bounds)}${runs ? ` | runs ${runs}` : ""}`);
    }
  }
  return lines;
}

/** Does the text name this room ("Therapy 1" but not "Therapy 10")? */
export function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`, "i").test(text);
}

/**
 * Sub-rooms and their parts as items, for measuring from (refs, names). Never in summary.items: the check after the
 * build compares summary.items before and after, and these are not single SketchUp entities.
 */
export function measureOnlyItems(s: RoomSummary): SummaryItem[] {
  const out: SummaryItem[] = [];
  const make = (ref: string, name: string, bounds: Bounds, size: [number, number, number], what: string): SummaryItem => ({
    ref, name, type: "Group", tag: "", visible: true, entityId: 0, persistentId: 0, path: [], bounds, size,
    contents: [], childCount: 0, categories: categoriesOf(name), warnings: [], canChange: false, measureOnly: what,
  });
  for (const r of s.subRooms ?? []) {
    out.push(make(r.ref, r.name, r.bounds, r.size, `${r.ref} is a sub-room found from names`));
    for (const p of r.parts) out.push(make(p.ref, p.name, p.bounds, p.size, `${p.ref} is a part of sub-room ${r.ref} "${r.name}"${p.count > 1 ? ` (${p.count} pieces together)` : ""}`));
  }
  return out;
}

/**
 * "north-south" when the item is clearly longer in y than in x, "east-west" the other way round, else null.
 * Small models don't work this out from the box (Windows, 2026-11-11: both models put a bench "along" a
 * north-south terrarium running east-west), so the summary says it in words.
 */
export function runsWhichWay(size: [number, number, number]): "north-south" | "east-west" | null {
  const [x, y] = size;
  if (y >= 1.5 * x) return "north-south";
  if (x >= 1.5 * y) return "east-west";
  return null;
}

function boxText(b: Bounds): string {
  return `x ${fmt(b.min[0])}..${fmt(b.max[0])}  y ${fmt(b.min[1])}..${fmt(b.max[1])}  z ${fmt(b.min[2])}..${fmt(b.max[2])}`;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => round(v).toFixed(3).replace(/\.?0+$/, "");
const roundBounds = (b: Bounds): Bounds => ({ min: b.min.map(round) as Bounds["min"], max: b.max.map(round) as Bounds["max"] });
