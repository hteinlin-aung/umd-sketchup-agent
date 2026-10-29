import { z } from "zod";

/**
 * The "envelope" is the outside of every message between TypeScript and SketchUp.
 * The tool-specific part lives inside `args` (command) and `data` (result).
 * See PLAN.md §4. The Ruby side (sketchup/umd_bridge/main.rb) must match this.
 */
export const PROTOCOL_VERSION = 1;

export const ErrorCode = z.enum([
  "BAD_COMMAND", // the command file could not be read as JSON / wrong shape
  "VERSION_MISMATCH", // TypeScript and Ruby speak different protocol versions
  "UNKNOWN_TOOL", // tool is not on the whitelist
  "INVALID_ARGS", // tool exists, but the arguments are wrong
  "WRONG_MODEL", // the open model does not match target.txt (or is unsaved)
  "MASTER_PROTECTED", // refused: would change the master model
  "NOT_FOUND", // target entity / material / scene does not exist
  "SHARED_DEFINITION", // change would affect other copies of a component
  "FILE_EXISTS", // refused to overwrite a file
  "VERIFY_FAILED", // tool ran, but reading the result back did not match
  "TOOL_ERROR", // unexpected Ruby exception inside a tool
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// Command ids double as file names, so keep them to safe characters.
export const CommandId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "id: 6-64 chars, letters/digits/_/- only");

export const CommandSchema = z.strictObject({
  id: CommandId,
  version: z.literal(PROTOCOL_VERSION),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Command = z.infer<typeof CommandSchema>;

export const ResultSchema = z.object({
  id: CommandId,
  tool: z.string(),
  ok: z.boolean(),
  modified: z.boolean(),
  durationMs: z.number().nonnegative(),
  data: z.unknown().nullable(),
  warnings: z.array(z.string()),
  error: z
    .object({
      code: ErrorCode,
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
  bridgeVersion: z.string(),
  modelPath: z.string(),
});
export type Result = z.infer<typeof ResultSchema>;
