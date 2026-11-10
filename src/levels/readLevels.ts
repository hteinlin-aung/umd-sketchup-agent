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

/**
 * Default probes: a 3 x 3 grid inside each "UMD 1F/2F/3F" group (or each top-level group).
 * One centre point is not enough: on 2026-11-02 the centre of UMD 1F landed on the lake,
 * because that group also contains the site.
 */
export function defaultProbes(info: DataOf<"getModelInfo">): Probe[] {
  const floors = info.topLevel.filter((e) => FLOOR_GROUP.test(e.name));
  const pick = floors.length > 0 ? floors : info.topLevel;
  const probes: Probe[] = [];
  for (const e of pick) {
    const name = e.name || e.definitionName;
    for (const fy of [0.25, 0.5, 0.75]) {
      for (const fx of [0.25, 0.5, 0.75]) {
        probes.push({
          label: `${name} @${fx * 100}%,${fy * 100}%`,
          x: round(e.bounds.min[0] + (e.bounds.max[0] - e.bounds.min[0]) * fx),
          y: round(e.bounds.min[1] + (e.bounds.max[1] - e.bounds.min[1]) * fy),
        });
      }
    }
  }
  return probes;
}

export type FloorCandidate = { z: number; probes: number; example: string };

/** Every floor-like height found by ANY probe, highest first, with how many probes saw it. */
export function summarizeFloors(results: ProbeResult[]): FloorCandidate[] {
  const byZ = new Map<number, FloorCandidate>();
  for (const r of results) {
    const seen = new Set<number>();
    for (const h of r.hits) {
      if (!h.looksLikeFloor) continue;
      const z = round(h.z);
      if (seen.has(z)) continue;
      seen.add(z);
      const c = byZ.get(z) ?? { z, probes: 0, example: h.path.join(" > ") };
      c.probes++;
      byZ.set(z, c);
    }
  }
  return [...byZ.values()].sort((a, b) => b.z - a.z);
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
