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
    "COMPONENTS you can place (file: east-west x north-south x height in metres, as it comes):",
    ...[...catalog.values()].map((c) => {
      const wrong = plausibility(c.file, c.size);
      return `- ${c.file}: ${c.size.map(fmt).join(" x ")}${wrong ? `  (DO NOT USE: looks wrong, ${wrong})` : ""}`;
    }),
  ].join("\n");
}

/** Size after turning it: 90 and 270 swap east-west and north-south. */
export function turnedSize(size: Vec3, rotation: number): Vec3 {
  return rotation === 90 || rotation === 270 ? [size[1], size[0], size[2]] : size;
}

/**
 * Does the file's size make sense for what its name says it is? 3D Warehouse models are often drawn at the
 * wrong scale: on Windows (2026-11-12) "3DW_coffee_table_marble_round" measured 3.96 x 3.92 x 2.64 m, an easel
 * 2.9 x 3.6 m, a zen garden 55 m long. The name and the size disagree, like "Sofa set 4" holding only a palm.
 * Returns a plain-words reason when it looks wrong, else null. Ranges are generous: only clear mistakes.
 */
const TYPICAL: { words: RegExp; what: string; maxHeight: number; maxPlan: number }[] = [
  { words: /coffee.?table|side.?table/i, what: "a coffee table", maxHeight: 0.7, maxPlan: 2.0 },
  { words: /\btable\b|desk/i, what: "a table", maxHeight: 1.2, maxPlan: 4.0 },
  { words: /stool|chair|armchair/i, what: "a chair", maxHeight: 1.4, maxPlan: 1.5 },
  { words: /sofa|couch|bench/i, what: "a sofa or bench", maxHeight: 1.3, maxPlan: 4.5 },
  { words: /easel/i, what: "an easel", maxHeight: 2.4, maxPlan: 1.5 },
  { words: /yoga|mat\b/i, what: "a mat", maxHeight: 0.15, maxPlan: 2.5 },
  { words: /basin|sink/i, what: "a basin", maxHeight: 1.3, maxPlan: 2.0 },
  { words: /chandelier|lamp|pendant/i, what: "a lamp", maxHeight: 3.0, maxPlan: 3.0 },
  { words: /fittonia|maranta|potted|pot\b|money.?tree|fern/i, what: "a pot plant", maxHeight: 3.0, maxPlan: 2.5 },
  { words: /zen.?garden|rock/i, what: "a zen garden or rocks", maxHeight: 2.5, maxPlan: 10 },
];
const ANY_MAX_PLAN = 12; // nothing in an interior is 12 m across

export function plausibility(file: string, size: Vec3): string | null {
  const [x, y, z] = size;
  const plan = Math.max(x, y);
  const f = (v: number) => v.toFixed(2);
  for (const t of TYPICAL) {
    if (!t.words.test(file)) continue;
    if (z > t.maxHeight) return `${t.what} ${f(z)} m tall (expected under ${t.maxHeight} m): the file is probably drawn at the wrong scale`;
    if (plan > t.maxPlan) return `${t.what} ${f(plan)} m across (expected under ${t.maxPlan} m): the file is probably drawn at the wrong scale`;
    return null;
  }
  if (plan > ANY_MAX_PLAN) return `${f(plan)} m across: too big for an interior; the file is probably drawn at the wrong scale`;
  return null;
}
