import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config";
import { CommandSchema } from "../../src/protocol/envelope";
import { CaptureViewArgs, CreateBoxArgs, SaveCopyArgs, Target } from "../../src/protocol/tools";

describe("tool argument schemas", () => {
  const box = { jobGroup: "j", name: "b", tag: "t", min: [0, 0, 0], max: [4, 3, 3.2] };

  it("accepts a normal box", () => {
    expect(CreateBoxArgs.safeParse(box).success).toBe(true);
  });
  it("rejects a flat or inside-out box", () => {
    expect(CreateBoxArgs.safeParse({ ...box, max: [4, 3, 0] }).success).toBe(false);
    expect(CreateBoxArgs.safeParse({ ...box, max: [-4, 3, 3] }).success).toBe(false);
  });
  it("rejects unknown keys (nothing sneaks through)", () => {
    expect(CreateBoxArgs.safeParse({ ...box, ruby: "puts 1" }).success).toBe(false);
  });
  it("rejects NaN and Infinity", () => {
    expect(CreateBoxArgs.safeParse({ ...box, min: [NaN, 0, 0] }).success).toBe(false);
    expect(CreateBoxArgs.safeParse({ ...box, max: [Infinity, 3, 3] }).success).toBe(false);
  });
  it("only allows plain file names, never folders", () => {
    expect(SaveCopyArgs.safeParse({ fileName: "UMD_DEV_1F_v001.skp" }).success).toBe(true);
    expect(SaveCopyArgs.safeParse({ fileName: "../UMD.skp" }).success).toBe(false);
    expect(SaveCopyArgs.safeParse({ fileName: "C:/x.skp" }).success).toBe(false);
    expect(SaveCopyArgs.safeParse({ fileName: "copy.png" }).success).toBe(false);
    expect(CaptureViewArgs.safeParse({ fileName: "a\\b.png" }).success).toBe(false);
  });
  it("never lets a copy be called MASTER", () => {
    expect(SaveCopyArgs.safeParse({ fileName: "Urban_Mind_Detox_MASTER_v02.skp" }).success).toBe(false);
  });
  it("needs exactly one way to identify a target", () => {
    expect(Target.safeParse({ entityId: 5 }).success).toBe(true);
    expect(Target.safeParse({ path: ["UMD 1F"] }).success).toBe(true);
    expect(Target.safeParse({ entityId: 5, path: ["UMD 1F"] }).success).toBe(false);
    expect(Target.safeParse({}).success).toBe(false);
  });
});

describe("command envelope", () => {
  it("only allows file-safe ids", () => {
    const ok = { id: "20261103-102104-a1b2c3", version: 1, tool: "ping", args: {}, createdAt: new Date().toISOString() };
    expect(CommandSchema.safeParse(ok).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, id: "../../evil" }).success).toBe(false);
  });
});

describe("config", () => {
  it("defaults to the mock, so a fresh clone works without SketchUp", () => {
    const c = parseConfig({});
    expect(c.transport).toBe("mock");
    expect(c.allowPaid).toBe(false);
  });
  it("demands a queue folder for the real transport", () => {
    expect(() => parseConfig({ UMD_TRANSPORT: "file" })).toThrow(/UMD_QUEUE_DIR/);
  });
  it("converts numbers and booleans from text", () => {
    const c = parseConfig({ UMD_TRANSPORT: "file", UMD_QUEUE_DIR: "E:/q", UMD_COMMAND_TIMEOUT_MS: "5000", UMD_ALLOW_PAID: "true" });
    expect(c.commandTimeoutMs).toBe(5000);
    expect(c.allowPaid).toBe(true);
  });
  it("explains a bad value instead of crashing later", () => {
    expect(() => parseConfig({ UMD_TRANSPORT: "socket" })).toThrow(/\.env has a problem/);
  });
});
