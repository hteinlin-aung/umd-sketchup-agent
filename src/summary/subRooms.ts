import type { Bounds } from "../protocol/tools";

/**
 * Sub-rooms from names (Mac decision 2026-11-14, built on Windows against the real 3F copy).
 *
 * Some room groups are organised by TRADE, not by room: in "3F THERAPY + PSYCHIATRIST INTERIOR (T124)" every item
 * (DOORS, FLOOR finishes, FURNITURE ...) holds the parts of all six rooms, so "Therapy 1" exists only as words at
 * the start of part names ("Therapy 1 door 900", "Therapy 1 - M09 acoustic carpet greige"). The planner could not
 * say "in Therapy 1": there was nothing to measure from.
 *
 * Here those words become sub-rooms:
 *  - a room label is the text before " - " in a part name that starts parts in at least TWO different items
 *    (a longer label that starts with a shorter one, like "Therapy 1 feature wall (north)", folds into it);
 *  - its box is its floor-finish part (the real footprint), else the box around all its parts;
 *  - its parts are listed as items to measure from. Parts with the same name, or of the same named wall, are joined
 *    ("12× Group therapy - circle seat", "Therapy 1 feature wall (north)": oak boards + plinth + acoustic panel).
 * Sub-rooms and their parts can be measured from, never taken out or moved: they are not one SketchUp entity.
 */

export type Part = { name: string; definitionName: string; bounds: Bounds; persistentId: number; hidden: boolean };
export type TradeItem = { ref: string; name: string; parts: Part[] };

export type SubRoomPart = {
  ref: string;
  name: string; // full name, label included ("Therapy 1 door 900")
  count: number; // how many SketchUp parts it joins
  bounds: Bounds;
  size: [number, number, number];
  from: string[]; // refs of the trade items it comes from
};

export type SubRoom = {
  ref: string; // V1, V2 ...
  name: string; // the label: "Therapy 1"
  bounds: Bounds;
  size: [number, number, number];
  boxFrom: string; // "floor finish ..." or "around its parts"
  boxRefs: string[]; // the trade items its box comes from (the floor finishes)
  parts: SubRoomPart[];
};

/** Parts whose bottom is this high above the floor are left out of the list (ceilings, blind cassettes). */
export const HIGH_PART = 1.5;
/** A floor finish is a thin layer. */
const FINISH_THICK = 0.05;

const nameOf = (p: Part) => (p.name || p.definitionName).trim();
const startsWithLabel = (name: string, label: string) => {
  const n = name.toLowerCase();
  const l = label.toLowerCase();
  return n.startsWith(l) && (n.length === l.length || /[\s\-–(,:]/.test(n[l.length]!));
};

/** The room labels in a group, or [] when it is not organised by trade. */
export function roomLabels(items: TradeItem[]): string[] {
  const candidates = new Set<string>();
  for (const it of items) {
    for (const p of it.parts) {
      const head = nameOf(p).split(" - ")[0]!.trim();
      if (head.length >= 3 && head.length <= 40 && /[a-z]/i.test(head) && head !== nameOf(p)) candidates.add(head);
    }
  }
  const inItems = (label: string) => items.filter((it) => it.parts.some((p) => startsWithLabel(nameOf(p), label))).length;
  const qualified = [...candidates].filter((c) => inItems(c) >= 2);
  const labels = qualified.filter((c) => !qualified.some((o) => o !== c && o.length < c.length && startsWithLabel(c, o)));
  if (labels.length < 2) return [];
  // Organised by trade: at least half of the items hold labelled parts.
  const labelled = items.filter((it) => it.parts.some((p) => labels.some((l) => startsWithLabel(nameOf(p), l)))).length;
  return labelled * 2 >= items.length ? labels.sort(naturally) : [];
}

/** The longest label a part name starts with. */
function labelFor(name: string, labels: string[]): string | null {
  let best: string | null = null;
  for (const l of labels) if (startsWithLabel(name, l) && (!best || l.length > best.length)) best = l;
  return best;
}

/** "oak board 3/10 (300 ...)" and "board 7/10" are the same kind of part; "#2" copies too. */
const plainName = (s: string) => s.replace(/\s+\d+\/\d+\b/g, "").replace(/#\d+\s*$/, "").replace(/\s+/g, " ").trim();

/**
 * What a part is listed under: the named wall/part before " - " when that is more than the label
 * ("Therapy 1 feature wall (north) - M02 oak board 3/10" -> "Therapy 1 feature wall (north)"), else its plain name.
 */
function listKey(name: string, label: string): string {
  const head = name.split(" - ")[0]!.trim();
  return head.length > label.length ? head : plainName(name);
}

export function findSubRooms(
  items: TradeItem[],
  room: { floorZ: number; top: number },
  firstPartRef: number,
): SubRoom[] {
  const labels = roomLabels(items);
  if (!labels.length) return [];
  let next = firstPartRef;
  const rooms: SubRoom[] = [];
  for (const [i, label] of labels.entries()) {
    const mine = items.flatMap((it) => it.parts.filter((p) => labelFor(nameOf(p), labels) === label).map((p) => ({ it, p })));
    const finish = mine.filter(({ it, p }) => /floor/i.test(it.name) && p.bounds.max[2] - p.bounds.min[2] < FINISH_THICK);
    const base = finish.length ? finish : mine;
    const foot = union(base.map(({ p }) => p.bounds));
    const bounds: Bounds = { min: [foot.min[0], foot.min[1], room.floorZ], max: [foot.max[0], foot.max[1], room.top] };

    const groups = new Map<string, { parts: Part[]; from: Set<string> }>();
    for (const { it, p } of mine) {
      if (finish.some((f) => f.p === p)) continue; // it IS the sub-room's box
      if (p.bounds.min[2] - room.floorZ >= HIGH_PART) continue; // ceilings, blind cassettes
      const key = listKey(nameOf(p), label);
      const g = groups.get(key) ?? { parts: [], from: new Set() };
      g.parts.push(p);
      g.from.add(it.ref);
      groups.set(key, g);
    }
    const parts: SubRoomPart[] = [...groups].map(([key, g]) => {
      const b = union(g.parts.map((p) => p.bounds));
      return { ref: "", name: key, count: g.parts.length, bounds: b, size: sizeOf(b), from: [...g.from] };
    });
    // In plan order: south to north, then west to east, so neighbours sit together.
    parts.sort((a, b) => a.bounds.min[1] - b.bounds.min[1] || a.bounds.min[0] - b.bounds.min[0]);
    for (const p of parts) p.ref = `R${next++}`;
    rooms.push({
      ref: `V${i + 1}`,
      name: label,
      bounds: roundBounds(bounds),
      size: sizeOf(bounds),
      boxRefs: [...new Set(base.map(({ it }) => it.ref))],
      boxFrom: finish.length ? `floor finish "${short(nameOf(finish[0]!.p))}"` : "the box around its parts (no floor finish found)",
      parts: parts.map((p) => ({ ...p, bounds: roundBounds(p.bounds) })),
    });
  }
  return rooms;
}

function union(bs: Bounds[]): Bounds {
  return {
    min: [0, 1, 2].map((i) => Math.min(...bs.map((b) => b.min[i]!))) as Bounds["min"],
    max: [0, 1, 2].map((i) => Math.max(...bs.map((b) => b.max[i]!))) as Bounds["max"],
  };
}

/** "Therapy 2" before "Therapy 10". */
function naturally(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const roundBounds = (b: Bounds): Bounds => ({ min: b.min.map(round) as Bounds["min"], max: b.max.map(round) as Bounds["max"] });
const sizeOf = (b: Bounds): [number, number, number] => [0, 1, 2].map((i) => round(b.max[i]! - b.min[i]!)) as [number, number, number];
const short = (s: string) => (s.length > 50 ? `${s.slice(0, 47)}...` : s);
