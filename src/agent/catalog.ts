import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BridgeClient } from "../bridge/client";
import type { Vec3 } from "../protocol/tools";

/**
 * The components you can place: every .skp in the components folder with its real size.
 *
 * Measuring a component means SketchUp loading the file (up to 28 MB, a few seconds each), so sizes are
 * cached in runs/components.json and only measured again when a file is new or its size in bytes changed.
 * Measuring needs a dev model (it loads the file for a moment); on the MASTER only the cache is used.
 */

export type CatalogEntry = { file: string; bytes: number; size: Vec3; definitionName: string };
export type Catalog = Map<string, CatalogEntry>;

export const CATALOG_CACHE = "runs/components.json";
/** --mock runs use their own cache, so fake sizes can never mix with the real ones. */
export const catalogCache = (mock: boolean) => (mock ? "runs/components.mock.json" : CATALOG_CACHE);

export async function loadCatalog(
  client: BridgeClient,
  opts: { cachePath?: string; canMeasure?: boolean; onMeasure?: (file: string, i: number, n: number) => void } = {},
): Promise<{ catalog: Catalog; problems: string[] }> {
  const cachePath = opts.cachePath ?? CATALOG_CACHE;
  const cached = new Map<string, CatalogEntry>();
  if (existsSync(cachePath)) {
    for (const e of JSON.parse(readFileSync(cachePath, "utf8")) as CatalogEntry[]) cached.set(e.file, e);
  }

  const list = await client.call("listComponents", {});
  if (!list.ok) throw new Error(`listComponents failed: ${list.error.code}: ${list.error.message}`);

  const catalog: Catalog = new Map();
  const problems: string[] = [];
  const todo = list.data.files.filter((f) => cached.get(f.file)?.bytes !== f.bytes);
  for (const f of list.data.files) {
    const hit = cached.get(f.file);
    if (hit && hit.bytes === f.bytes) catalog.set(f.file, hit);
  }
  for (const [i, f] of todo.entries()) {
    if (opts.canMeasure === false) {
      problems.push(`${f.file}: not measured yet (open a dev model and run: npm run components)`);
      continue;
    }
    opts.onMeasure?.(f.file, i + 1, todo.length);
    const info = await client.call("componentInfo", { file: f.file });
    if (!info.ok) {
      problems.push(`${f.file}: ${info.error.code}: ${info.error.message}`);
      continue;
    }
    catalog.set(f.file, { file: f.file, bytes: info.data.bytes, size: info.data.size, definitionName: info.data.definitionName });
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify([...catalog.values()], null, 2));
  return { catalog, problems };
}

/** For the language model: one line per component, with its size as it comes (rotation 0). */
export function renderCatalog(catalog: Catalog): string {
  if (catalog.size === 0) return "COMPONENTS: (none in the components folder)";
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  return [
    "COMPONENTS you can place (file: east-west x north-south x height in metres, at the size it will be placed):",
    ...[...catalog.values()].map((c) => {
      const fit = fitComponent(c.file, c.size);
      if (!fit) return `- ${c.file}: ${c.size.map(fmt).join(" x ")}  (DO NOT USE unless the brief gives its size: unknown kind, too big)`;
      return `- ${c.file}: ${fit.size.map(fmt).join(" x ")}${fit.scale !== 1 ? `  (file drawn at the wrong scale; placed at this size)` : ""}`;
    }),
  ].join("\n");
}

/** Size after turning it: 90 and 270 swap east-west and north-south. */
export function turnedSize(size: Vec3, rotation: number): Vec3 {
  return rotation === 90 || rotation === 270 ? [size[1], size[0], size[2]] : size;
}

/**
 * What size should a component be? 3D Warehouse models are often drawn at the wrong scale: on Windows
 * (2026-11-12) "3DW_coffee_table_marble_round" measured 3.96 x 3.92 x 2.64 m, an easel 2.9 x 3.6 m, a zen
 * garden 55 m long. Like "Sofa set 4" holding only a palm: the name and the contents disagree.
 *
 * Instead of refusing such files, the agent scales the placed copy (uniformly, so nothing gets squashed;
 * your file is never changed), the way a designer would: each kind of piece has a usual range for one
 * measurement, and a size outside it is brought to a typical value. Sizes the brief gives always win.
 */
type Rule = { words: RegExp; what: string; dim: "height" | "across"; min: number; max: number; target: number };
export const TYPICAL: Rule[] = [
  { words: /coffee.?table|side.?table/i, what: "a coffee table", dim: "height", min: 0.3, max: 0.55, target: 0.42 },
  { words: /\btable\b|desk/i, what: "a table", dim: "height", min: 0.6, max: 1.15, target: 0.75 },
  { words: /stool|chair/i, what: "a chair", dim: "height", min: 0.65, max: 1.25, target: 0.85 },
  { words: /sofa|couch/i, what: "a sofa", dim: "height", min: 0.55, max: 1.1, target: 0.8 },
  { words: /bench/i, what: "a bench", dim: "height", min: 0.35, max: 1.0, target: 0.45 },
  { words: /easel/i, what: "an easel", dim: "height", min: 1.4, max: 2.3, target: 1.8 },
  { words: /yoga|\bmat\b/i, what: "a mat", dim: "across", min: 1.5, max: 2.3, target: 1.83 },
  { words: /basin|sink/i, what: "a basin", dim: "across", min: 0.35, max: 1.2, target: 0.6 },
  { words: /chandelier|lamp|pendant/i, what: "a lamp", dim: "across", min: 0.25, max: 2.0, target: 0.9 },
  { words: /fittonia|maranta|potted|\bpot\b|money.?tree|fern/i, what: "a pot plant", dim: "height", min: 0.15, max: 2.5, target: 1.2 },
  { words: /zen.?garden|rock/i, what: "a zen garden or rocks", dim: "across", min: 0.4, max: 8, target: 3.0 },
  { words: /tree|palm/i, what: "an indoor tree", dim: "height", min: 1.0, max: 4.0, target: 2.8 },
];
const ANY_MAX_PLAN = 12; // nothing in an interior is 12 m across
const CEILING_GAP = 0.2; // a placed piece stays at least this far below the room's top

export type Fit = { scale: number; size: Vec3; reason: string | null };
export type Wanted = { height?: number; across?: number };

/**
 * The uniform scale for one component. null when there is no way to tell (an unknown kind of piece more than
 * 12 m across, and the brief gives no size): then the plan refuses it and says why.
 */
export function fitComponent(file: string, size: Vec3, opts: { roomHeight?: number; wanted?: Wanted } = {}): Fit | null {
  const [x, y, z] = size;
  const across = Math.max(x, y);
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  let scale = 1;
  let reason: string | null = null;

  if (opts.wanted?.height || opts.wanted?.across) {
    scale = opts.wanted.height ? opts.wanted.height / z : opts.wanted.across! / across;
    reason = `to the brief's size (${opts.wanted.height ? `${f(opts.wanted.height)} m high` : `${f(opts.wanted.across!)} m across`})`;
  } else {
    const rule = TYPICAL.find((t) => t.words.test(file));
    if (rule) {
      const v = rule.dim === "height" ? z : across;
      if (v < rule.min || v > rule.max) {
        scale = rule.target / v;
        reason = `${rule.what} ${f(v)} m ${rule.dim === "height" ? "high" : "across"} is outside the usual ${f(rule.min)}-${f(rule.max)} m, so it is scaled to ${f(rule.target)} m`;
      }
    } else if (across > ANY_MAX_PLAN) {
      return null;
    }
  }
  if (opts.roomHeight && z * scale > opts.roomHeight - CEILING_GAP) {
    scale = (opts.roomHeight - CEILING_GAP) / z;
    reason = `${reason ? `${reason}, then ` : ""}made ${f(opts.roomHeight - CEILING_GAP)} m high to fit under the ceiling`;
  }
  scale = Math.round(scale * 10000) / 10000;
  return { scale, size: [x * scale, y * scale, z * scale], reason };
}

/** Plain words for `npm run components` and the model's list: null when the file's size is fine as it is. */
export function plausibility(file: string, size: Vec3): string | null {
  const fit = fitComponent(file, size);
  if (!fit) return `${(Math.round(Math.max(size[0], size[1]) * 100) / 100).toString()} m across and not a kind of piece the agent knows: give its size in the brief`;
  return fit.reason;
}
