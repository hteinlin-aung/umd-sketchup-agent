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
    ...[...catalog.values()].map((c) => `- ${c.file}: ${c.size.map(fmt).join(" x ")}`),
  ].join("\n");
}

/** Size after turning it: 90 and 270 swap east-west and north-south. */
export function turnedSize(size: Vec3, rotation: number): Vec3 {
  return rotation === 90 || rotation === 270 ? [size[1], size[0], size[2]] : size;
}
