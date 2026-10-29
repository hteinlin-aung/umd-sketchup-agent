import { existsSync } from "node:fs";
import { z } from "zod";

// Environment variables are always strings, so numbers and booleans are
// converted here, in one place, instead of all over the code.
const ConfigSchema = z.object({
  UMD_TRANSPORT: z.enum(["file", "mock"]).default("mock"),
  UMD_QUEUE_DIR: z.string().min(1).optional(),
  UMD_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  UMD_POLL_MS: z.coerce.number().int().min(50).max(5_000).default(250),
  OLLAMA_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:4b-instruct"),
  UMD_ALLOW_PAID: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export type Config = {
  transport: "file" | "mock";
  queueDir: string | undefined;
  commandTimeoutMs: number;
  pollMs: number;
  ollamaUrl: string;
  ollamaModel: string;
  allowPaid: boolean;
};

export class ConfigError extends Error {}

/** Turns raw environment values into a checked Config, or throws a readable ConfigError. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      `Your .env has a problem:\n${z.prettifyError(result.error)}\n` +
        "Compare it with .env.example and fix the value(s) above.",
    );
  }
  const c = result.data;
  if (c.UMD_TRANSPORT === "file" && !c.UMD_QUEUE_DIR) {
    throw new ConfigError(
      "UMD_TRANSPORT=file needs UMD_QUEUE_DIR (the folder the SketchUp extension watches). " +
        "Set it in .env, e.g. UMD_QUEUE_DIR=E:/Cowork_Field/Thesis_SketchUp/agent_queue",
    );
  }
  return {
    transport: c.UMD_TRANSPORT,
    queueDir: c.UMD_QUEUE_DIR,
    commandTimeoutMs: c.UMD_COMMAND_TIMEOUT_MS,
    pollMs: c.UMD_POLL_MS,
    ollamaUrl: c.OLLAMA_URL,
    ollamaModel: c.OLLAMA_MODEL,
    allowPaid: c.UMD_ALLOW_PAID,
  };
}

/** Reads .env (if it exists) into process.env, then parses it. */
export function loadConfig(envFile = ".env"): Config {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseConfig(process.env);
}
