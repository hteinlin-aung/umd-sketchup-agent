import { describe, expect, it } from "vitest";
import { BridgeClient, newCommandId } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { runSmoke } from "../../src/smoke/runSmoke";

// MOCK: these test the TypeScript side against a fake SketchUp that follows the
// same rules as the Ruby bridge. Real proof is `npm run smoke` on Windows.

const setup = (opts?: ConstructorParameters<typeof MockSketchUp>[0]) => {
  const sketchup = new MockSketchUp(opts);
  return { sketchup, client: new BridgeClient(sketchup) };
};

describe("smoke test against the mock", () => {
  it("passes every step", async () => {
    const { client } = setup();
    const steps = await runSmoke(client, "test");
    expect(steps.filter((s) => !s.pass)).toEqual([]);
    expect(steps.length).toBeGreaterThanOrEqual(10);
  });
});

describe("BridgeClient", () => {
  it("rejects bad arguments BEFORE sending anything", async () => {
    const { sketchup, client } = setup();
    const res = await client.call("createBox", { jobGroup: "j", name: "b", tag: "t", min: [0, 0, 0], max: [1, 1, 0] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ARGS");
      expect(res.source).toBe("client");
    }
    expect(sketchup.received).toHaveLength(0);
  });

  it("rejects a length typed in mm instead of m", async () => {
    const { client } = setup();
    const res = await client.call("createBox", { jobGroup: "j", name: "b", tag: "t", min: [0, 0, 0], max: [4000, 3000, 3200] });
    expect(res.ok).toBe(false);
  });

  it("reports SketchUp-side errors with their code", async () => {
    const { client } = setup();
    const res = await client.call("applyMaterial", { target: { entityId: 999_999 }, material: "UMD Light Oak" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.source).toBe("sketchup");
    }
  });

  it("passes injected failures through unchanged", async () => {
    const { sketchup, client } = setup();
    sketchup.injectFailure("saveCopy", "TOOL_ERROR", "disk full");
    const res = await client.call("saveCopy", { fileName: "a.skp" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ code: "TOOL_ERROR", message: "disk full" });
  });

  it("makes unique, file-safe command ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCommandId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
  });
});

describe("safety rules (mock follows the Ruby rules)", () => {
  const box = { jobGroup: "j", name: "b", tag: "t", min: [0, 0, 0], max: [1, 1, 1] } as const;

  it("refuses to change the MASTER model", async () => {
    const { client } = setup({ modelPath: "E:/x/Urban_Mind_Detox_MASTER_v01.skp", targetPattern: "Urban_Mind" });
    const res = await client.call("createBox", { ...box, min: [...box.min], max: [...box.max] });
    expect(!res.ok && res.error.code).toBe("MASTER_PROTECTED");
  });

  it("refuses when the open model does not match target.txt", async () => {
    const { client } = setup({ modelPath: "E:/x/SomeOtherProject.skp" });
    const res = await client.call("createBox", { ...box, min: [...box.min], max: [...box.max] });
    expect(!res.ok && res.error.code).toBe("WRONG_MODEL");
  });

  it("refuses when there is no target.txt at all", async () => {
    const { client } = setup({ targetPattern: null });
    const res = await client.call("applyMaterial", { target: { path: ["UMD 1F"] }, material: "UMD Light Oak" });
    expect(!res.ok && res.error.code).toBe("WRONG_MODEL");
  });

  it("still allows read-only tools on any model", async () => {
    const { client } = setup({ modelPath: "E:/x/Urban_Mind_Detox_MASTER_v01.skp", targetPattern: null });
    expect((await client.call("ping", {})).ok).toBe(true);
    expect((await client.call("getModelInfo", {})).ok).toBe(true);
  });

  it("refuses a path that matches more than one thing, and lists the candidates", async () => {
    const { client } = setup();
    const res = await client.call("applyMaterial", { target: { path: ["UMD 1F", "UMD Column D500 1F"] }, material: "UMD Light Oak" });
    expect(!res.ok && res.error.code).toBe("INVALID_ARGS");
    expect(!res.ok && res.error.details).toMatchObject({ entityIds: expect.any(Array) });
  });

  it("refuses to paint a component used more than once (it would change every copy)", async () => {
    const { sketchup, client } = setup();
    const column = sketchup.allEntities().find((e) => e.definitionName === "UMD Column D500 1F")!;
    const res = await client.call("applyMaterial", { target: { entityId: column.entityId }, material: "UMD Light Oak" });
    expect(!res.ok && res.error.code).toBe("SHARED_DEFINITION");
  });

  it("finds a group by its path of names", async () => {
    const { client } = setup();
    const res = await client.call("applyMaterial", {
      target: { path: ["UMD 1F", "1F RECEPTION (T128)"] },
      material: "UMD Terrazzo Warm",
      faces: "top",
    });
    expect(res.ok && res.data.facesPainted).toBe(1);
  });

  it("will not create a material without a colour", async () => {
    const { client } = setup();
    const res = await client.call("applyMaterial", { target: { path: ["UMD 1F"] }, material: "Brand New Stone" });
    expect(!res.ok && res.error.code).toBe("NOT_FOUND");
  });
});
