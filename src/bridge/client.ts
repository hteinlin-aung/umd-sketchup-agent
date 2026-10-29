import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PROTOCOL_VERSION, type Command, type ErrorCode, type Result } from "../protocol/envelope";
import { TOOLS, type ArgsIn, type DataOf, type ToolName } from "../protocol/tools";
import type { Transport } from "./transport";


//This is the main interface where TypeScript code uses to call tools.
//The client handles sending the request and receiving the response.


export type ToolSuccess<T extends ToolName> = {
  ok: true;
  data: DataOf<T>;
  modified: boolean;
  warnings: string[];
  durationMs: number;
  raw: Result;
};

export type ToolFailure = {
  ok: false;
  error: { code: ErrorCode; message: string; details?: unknown };
  /** "client" = rejected here before sending; "sketchup" = SketchUp answered with an error */
  source: "client" | "sketchup";
  warnings: string[];
  raw: Result | null;
};

export type ToolResult<T extends ToolName> = ToolSuccess<T> | ToolFailure;

/** Unique, sortable, safe as a file name: 20261103-102104-a1b2c3 */
export function newCommandId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(3).toString("hex")}`;
}

/**
 * The only way the rest of the app talks to SketchUp.
 * 1. checks the arguments with the tool's Zod schema (nothing invalid leaves this machine)
 * 2. sends the command through the transport
 * 3. checks the answer's data with the tool's result schema
 */
export class BridgeClient {
  constructor(private readonly transport: Transport) {}

  get transportKind(): "file" | "mock" {
    return this.transport.kind;
  }

  async call<T extends ToolName>(tool: T, args: ArgsIn<T>): Promise<ToolResult<T>> {
    const spec = TOOLS[tool];
    const parsedArgs = spec.args.safeParse(args);
    if (!parsedArgs.success) {
      return {
        ok: false,
        source: "client",
        error: { code: "INVALID_ARGS", message: z.prettifyError(parsedArgs.error) },
        warnings: [],
        raw: null,
      };
    }

    const result = await this.sendRaw(tool, parsedArgs.data as Record<string, unknown>);

    if (!result.ok) {
      return {
        ok: false,
        source: "sketchup",
        error: result.error ?? { code: "TOOL_ERROR", message: "ok=false but no error given" },
        warnings: result.warnings,
        raw: result,
      };
    }

    const parsedData = spec.data.safeParse(result.data);
    if (!parsedData.success) {
      return {
        ok: false,
        source: "sketchup",
        error: {
          code: "VERIFY_FAILED",
          message: `SketchUp's answer for ${tool} has an unexpected shape:\n${z.prettifyError(parsedData.error)}`,
        },
        warnings: result.warnings,
        raw: result,
      };
    }

    return {
      ok: true,
      data: parsedData.data as DataOf<T>,
      modified: result.modified,
      warnings: result.warnings,
      durationMs: result.durationMs,
      raw: result,
    };
  }

  /** Sends without checking anything. Only for tests that prove SketchUp rejects bad input too. */
  async sendRaw(tool: string, args: Record<string, unknown>): Promise<Result> {
    const command: Command = {
      id: newCommandId(),
      version: PROTOCOL_VERSION,
      tool,
      args,
      createdAt: new Date().toISOString(),
    };
    return this.transport.send(command);
  }
}
