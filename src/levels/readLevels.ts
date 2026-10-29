import type { BridgeClient } from "../bridge/client";
import type { DataOf } from "../protocol/tools";

/**
 * Reads floor levels by shooting rays straight down through the model and listing
 * every surface they pass (roof, ceilings, floor finishes, slabs ...).
 * It does not GUESS which one is "the" floor level: it reports what is there and
 * marks hits whose group name sounds like a floor, so a person can confirm.
 */
export type Probe = { label: string; x: number; y: number };

export type LevelHit = {
  z: number;
  distance: number;
  tag: string;
  path: string[];
  material: string | null;
  looksLikeFloor: boolean;
};

export type ProbeResult = Probe & { hits: LevelHit[]; stoppedBecause: string };

const FLOOR_WORDS = /floor plate|finish surface|floor finish|slab/i;
const FLOOR_GROUP = /^UMD [1-9]F$/i;

/** Default probes: the centre of each "UMD 1F/2F/3F" group, or of every top-level group. */
export function defaultProbes(info: DataOf<"getModelInfo">): Probe[] {
  const floors = info.topLevel.filter((e) => FLOOR_GROUP.test(e.name));
  const pick = floors.length > 0 ? floors : info.topLevel;
  return pick.map((e) => ({
    label: e.name || e.definitionName,
    x: round((e.bounds.min[0] + e.bounds.max[0]) / 2),
    y: round((e.bounds.min[1] + e.bounds.max[1]) / 2),
  }));
}

export async function readLevels(client: BridgeClient, probes?: Probe[]): Promise<ProbeResult[]> {
  const info = await client.call("getModelInfo", { maxItems: 200 });
  if (!info.ok) throw new Error(`getModelInfo failed: ${info.error.code}: ${info.error.message}`);
  const mb = info.data.modelBounds;
  if (!mb) return [];
  const topZ = round(mb.max[2] + 1);
  const span = Math.min(500, round(mb.max[2] - mb.min[2] + 2));

  const results: ProbeResult[] = [];
  for (const p of probes ?? defaultProbes(info.data)) {
    const res = await client.call("measure", { from: [p.x, p.y, topZ], direction: "down", allHits: true, maxHits: 50, maxDistance: span });
    if (!res.ok) throw new Error(`measure at ${p.label} failed: ${res.error.code}: ${res.error.message}`);
    results.push({
      ...p,
      stoppedBecause: res.data.stoppedBecause,
      hits: res.data.hits.map((h) => ({
        z: h.point[2],
        distance: h.distance,
        tag: h.tag,
        path: h.path,
        material: h.material,
        looksLikeFloor: FLOOR_WORDS.test(h.path.join(" ")),
      })),
    });
  }
  return results;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
