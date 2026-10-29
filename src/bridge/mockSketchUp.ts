import { dirname } from "node:path/posix";
import { z } from "zod";
import { PROTOCOL_VERSION, type Command, type ErrorCode, type Result } from "../protocol/envelope";
import { TOOLS, isToolName, type ArgsOut, type Bounds, type Target, type ToolName, type Vec3 } from "../protocol/tools";
import type { Transport } from "./transport";

/**
 * MOCK SKETCHUP: an in-memory fake used for tests on the Mac.
 *
 * It follows the same RULES as the real Ruby bridge (model guard, master protection,
 * not-found, shared definitions, no overwrite), so the TypeScript side can be developed
 * and tested without Windows. It does NOT prove anything about real SketchUp geometry:
 * passing mock tests != the real bridge works. Real proof = `npm run smoke` on Windows.
 */

type MockFace = { normal: Vec3; material: string | null; backMaterial: string | null };

type MockEntity = {
  entityId: number;
  persistentId: number;
  type: "Group" | "ComponentInstance";
  name: string;
  definitionName: string;
  tag: string;
  hidden: boolean;
  parentId: number | null;
  bounds: Bounds;
  faces: MockFace[];
};

export type MockOptions = {
  modelPath?: string;
  targetPattern?: string | null; // regex source, like target.txt; null = no target.txt
  delayMs?: number;
};

class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const BOX_NORMALS: Vec3[] = [
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];

export class MockSketchUp implements Transport {
  readonly kind = "mock" as const;
  readonly bridgeVersion = "mock-0.1.0";

  modelPath: string;
  targetPattern: string | null;
  private delayMs: number;
  private nextId = 1000;
  private entities = new Map<number, MockEntity>();
  readonly tags = new Map<string, boolean>([["Layer0", true]]);
  readonly materials = new Set<string>();
  readonly scenes: string[] = ["1F Reception", "1F Garden"];
  readonly savedFiles = new Set<string>();
  readonly images = new Set<string>();
  private injected: { tool: string; code: ErrorCode; message: string } | null = null;
  readonly received: Command[] = [];

  constructor(opts: MockOptions = {}) {
    this.modelPath = opts.modelPath ?? "E:/Cowork_Field/Thesis_SketchUp/dev/UMD_DEV_1F.skp";
    this.targetPattern = opts.targetPattern === undefined ? "UMD_DEV_" : opts.targetPattern;
    this.delayMs = opts.delayMs ?? 0;
    this.seed();
  }

  /** The next call to `tool` fails with `code` (to test error handling). */
  injectFailure(tool: string, code: ErrorCode, message = "injected failure"): void {
    this.injected = { tool, code, message };
  }

  entity(id: number): MockEntity | undefined {
    return this.entities.get(id);
  }

  /** For tests: every entity, including nested ones that getModelInfo does not list. */
  allEntities(): MockEntity[] {
    return [...this.entities.values()];
  }

  // ----- a tiny 1F, enough to test against -----
  private seed(): void {
    for (const t of ["1F Shell", "Columns", "1F Reception - Furniture (T128)"]) this.tags.set(t, true);
    for (const m of ["UMD Terrazzo Warm", "UMD Light Oak"]) this.materials.add(m);
    const floor = this.add({
      type: "Group",
      name: "UMD 1F",
      tag: "1F Shell",
      parentId: null,
      bounds: { min: [-73, -14, 0.289], max: [38, 27, 5.0] },
    });
    this.add({
      type: "Group",
      name: "1F RECEPTION (T128)",
      tag: "1F Shell",
      parentId: floor.entityId,
      bounds: { min: [10, 5, 0.289], max: [20, 15, 3.5] },
    });
    // Two copies of one component: painting the definition would change both.
    for (const x of [0, 5]) {
      this.add({
        type: "ComponentInstance",
        name: "",
        definitionName: "UMD Column D500 1F",
        tag: "Columns",
        parentId: floor.entityId,
        bounds: { min: [x, 0, 0.289], max: [x + 0.5, 0.5, 4.0] },
      });
    }
  }

  private add(e: Omit<MockEntity, "entityId" | "persistentId" | "definitionName" | "hidden" | "faces"> & Partial<MockEntity>): MockEntity {
    const id = this.nextId++;
    const entity: MockEntity = {
      entityId: id,
      persistentId: id * 7,
      definitionName: e.definitionName ?? `Group#${id}`,
      hidden: false,
      faces: BOX_NORMALS.map((n) => ({ normal: n, material: null, backMaterial: null })),
      ...e,
    } as MockEntity;
    this.entities.set(id, entity);
    return entity;
  }

  // ----- Transport -----
  async send(command: Command): Promise<Result> {
    this.received.push(command);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const started = Date.now();
    const base = { id: command.id, tool: command.tool, bridgeVersion: this.bridgeVersion, modelPath: this.modelPath };
    try {
      if (command.version !== PROTOCOL_VERSION) {
        throw new ToolError("VERSION_MISMATCH", `protocol ${command.version}, bridge speaks ${PROTOCOL_VERSION}`);
      }
      if (!isToolName(command.tool)) throw new ToolError("UNKNOWN_TOOL", `no tool called "${command.tool}"`);
      if (this.injected && this.injected.tool === command.tool) {
        const inj = this.injected;
        this.injected = null;
        throw new ToolError(inj.code, inj.message);
      }
      // The real bridge re-checks arguments too; never trust the sender.
      const parsed = TOOLS[command.tool].args.safeParse(command.args);
      if (!parsed.success) throw new ToolError("INVALID_ARGS", z.prettifyError(parsed.error));
      this.guard(command.tool);
      const { data, modified, warnings } = this.run(command.tool, parsed.data);
      return { ...base, ok: true, modified, durationMs: Date.now() - started, data, warnings, error: null };
    } catch (e) {
      const err =
        e instanceof ToolError
          ? { code: e.code, message: e.message, details: e.details }
          : { code: "TOOL_ERROR" as const, message: String(e) };
      return { ...base, ok: false, modified: false, durationMs: Date.now() - started, data: null, warnings: [], error: err };
    }
  }

  /** Same rules as main.rb: which tools may run on which model. */
  private guard(tool: ToolName): void {
    if (tool === "ping" || tool === "getModelInfo") return;
    if (!this.modelPath) throw new ToolError("WRONG_MODEL", "the open model has never been saved");
    if (this.targetPattern === null) throw new ToolError("WRONG_MODEL", "no target.txt in the queue folder");
    if (!new RegExp(this.targetPattern, "i").test(this.modelPath)) {
      throw new ToolError("WRONG_MODEL", `open model ${this.modelPath} does not match target.txt /${this.targetPattern}/`);
    }
    if (TOOLS[tool].changesModel || tool === "captureView") {
      if (/master/i.test(this.modelPath)) throw new ToolError("MASTER_PROTECTED", "refusing to change the MASTER model");
    }
  }

  private run(tool: ToolName, args: unknown): { data: unknown; modified: boolean; warnings: string[] } {
    switch (tool) {
      case "ping":
        return { data: this.ping(), modified: false, warnings: [] };
      case "getModelInfo":
        return { data: this.getModelInfo(args as ArgsOut<"getModelInfo">), modified: false, warnings: [] };
      case "createBox":
        return { data: this.createBox(args as ArgsOut<"createBox">), modified: true, warnings: [] };
      case "applyMaterial":
        return { data: this.applyMaterial(args as ArgsOut<"applyMaterial">), modified: true, warnings: [] };
      case "captureView":
        return { data: this.captureView(args as ArgsOut<"captureView">), modified: false, warnings: [] };
      case "saveCopy":
        return { data: this.saveCopy(args as ArgsOut<"saveCopy">), modified: false, warnings: [] };
    }
  }

  // ----- tools -----
  private ping() {
    return {
      bridgeVersion: this.bridgeVersion,
      protocol: PROTOCOL_VERSION,
      sketchupVersion: "MOCK",
      rubyVersion: "MOCK",
      isPro: true,
      modelPath: this.modelPath,
      modelTitle: this.modelPath.split("/").pop()?.replace(/\.skp$/i, "") ?? "",
      targetPattern: this.targetPattern,
      tools: Object.keys(TOOLS),
    };
  }

  private getModelInfo(a: ArgsOut<"getModelInfo">) {
    const top = [...this.entities.values()].filter((e) => e.parentId === null);
    const all = [...this.entities.values()];
    return {
      modelPath: this.modelPath,
      modelBounds: all.length ? unionBounds(all.map((e) => e.bounds)) : null,
      counts: {
        definitions: new Set(all.map((e) => e.definitionName)).size,
        materials: this.materials.size,
        tags: this.tags.size,
        scenes: this.scenes.length,
      },
      tags: [...this.tags].map(([name, visible]) => ({ name, visible })),
      scenes: [...this.scenes],
      materials: [...this.materials].slice(0, a.maxItems),
      topLevel: top.slice(0, a.maxItems).map((e) => ({
        entityId: e.entityId,
        persistentId: e.persistentId,
        type: e.type,
        name: e.name,
        definitionName: e.definitionName,
        tag: e.tag,
        hidden: e.hidden,
        bounds: e.bounds,
        childCount: all.filter((c) => c.parentId === e.entityId).length,
      })),
      truncated: top.length > a.maxItems || this.materials.size > a.maxItems,
    };
  }

  private createBox(a: ArgsOut<"createBox">) {
    if (a.material && !this.materials.has(a.material)) throw new ToolError("NOT_FOUND", `material "${a.material}" does not exist`);
    let job = [...this.entities.values()].find((e) => e.parentId === null && e.type === "Group" && e.name === a.jobGroup);
    if (!job) job = this.add({ type: "Group", name: a.jobGroup, tag: "Layer0", parentId: null, bounds: { min: a.min, max: a.max } });
    if (!this.tags.has(a.tag)) this.tags.set(a.tag, true);
    const box = this.add({ type: "Group", name: a.name, tag: a.tag, parentId: job.entityId, bounds: { min: a.min, max: a.max } });
    if (a.material) box.faces.forEach((f) => (f.material = a.material!));
    job.bounds = unionBounds(this.children(job.entityId).map((c) => c.bounds));
    return {
      entityId: box.entityId,
      persistentId: box.persistentId,
      jobGroupId: job.entityId,
      worldBounds: box.bounds,
      faceCount: box.faces.length,
    };
  }

  private applyMaterial(a: ArgsOut<"applyMaterial">) {
    const e = this.resolve(a.target);
    if (e.type === "ComponentInstance") {
      const copies = [...this.entities.values()].filter((x) => x.definitionName === e.definitionName).length;
      if (copies > 1) {
        throw new ToolError("SHARED_DEFINITION", `"${e.definitionName}" is used ${copies} times; painting it would change all copies`);
      }
    }
    let created = false;
    if (!this.materials.has(a.material)) {
      if (!a.color) throw new ToolError("NOT_FOUND", `material "${a.material}" does not exist (give "color" to create it)`);
      this.materials.add(a.material);
      created = true;
    }
    const faces = e.faces.filter((f) => matchesFaces(f.normal, a.faces));
    for (const f of faces) {
      f.material = a.material;
      if (a.paintBack) f.backMaterial = a.material;
    }
    return {
      materialName: a.material,
      created,
      facesPainted: faces.length,
      facesChecked: faces.filter((f) => f.material === a.material).length,
    };
  }

  private captureView(a: ArgsOut<"captureView">) {
    if (a.scene && !this.scenes.includes(a.scene)) throw new ToolError("NOT_FOUND", `scene "${a.scene}" does not exist`);
    if (a.zoomTo) this.resolve(a.zoomTo);
    const path = `MOCK/images/${a.fileName}`;
    this.images.add(path);
    return { path, bytes: 12_345, width: a.width, height: a.height };
  }

  private saveCopy(a: ArgsOut<"saveCopy">) {
    const path = `${dirname(this.modelPath)}/${a.fileName}`;
    if (path.toLowerCase() === this.modelPath.toLowerCase() || this.savedFiles.has(path)) {
      throw new ToolError("FILE_EXISTS", `${path} already exists; choose a new name`);
    }
    this.savedFiles.add(path);
    return { path, bytes: 1_000_000 };
  }

  // ----- helpers -----
  private children(id: number): MockEntity[] {
    return [...this.entities.values()].filter((e) => e.parentId === id);
  }

  private resolve(t: Target): MockEntity {
    if ("entityId" in t) {
      const e = this.entities.get(t.entityId);
      if (!e) throw new ToolError("NOT_FOUND", `no group/component with entityId ${t.entityId}`);
      return e;
    }
    if ("persistentId" in t) {
      const e = [...this.entities.values()].find((x) => x.persistentId === t.persistentId);
      if (!e) throw new ToolError("NOT_FOUND", `no group/component with persistentId ${t.persistentId}`);
      return e;
    }
    let parent: number | null = null;
    let found: MockEntity | undefined;
    for (const name of t.path) {
      const matches = [...this.entities.values()].filter((e) => e.parentId === parent && (e.name === name || e.definitionName === name));
      if (matches.length === 0) throw new ToolError("NOT_FOUND", `path ${JSON.stringify(t.path)}: nothing called "${name}"`);
      if (matches.length > 1) {
        throw new ToolError("INVALID_ARGS", `path ${JSON.stringify(t.path)}: "${name}" matches ${matches.length} things; use entityId`, {
          entityIds: matches.map((m) => m.entityId),
        });
      }
      found = matches[0]!;
      parent = found.entityId;
    }
    return found!;
  }
}

function matchesFaces(n: Vec3, which: "all" | "top" | "sides"): boolean {
  if (which === "all") return true;
  if (which === "top") return n[2] > 0.99;
  return Math.abs(n[2]) < 0.01;
}

function unionBounds(list: Bounds[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}
