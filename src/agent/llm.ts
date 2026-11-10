/**
 * The language model, behind one small function type so tests can use a fake one.
 * Default: Ollama on this machine (local, free). A paid API would be another `Llm`
 * and is only allowed when UMD_ALLOW_PAID=true (not built yet).
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Sends the conversation, gets back the model's text (JSON when `schema` is given). */
export type Llm = (messages: ChatMessage[], schema: Record<string, unknown>) => Promise<string>;

export class LlmError extends Error {}

export function ollamaLlm(url: string, model: string, timeoutMs = 300_000): Llm {
  return async (messages, schema) => {
    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          format: schema, // Ollama only lets the model produce JSON of this shape
          options: { temperature: 0, num_ctx: 8192 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new LlmError(`could not reach Ollama at ${url} (${(e as Error).message}). Is it running? Try: ollama list`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError(`Ollama answered ${res.status}: ${body.slice(0, 300)}${res.status === 404 ? `\nIs the model pulled? Try: ollama pull ${model}` : ""}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const text = data.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new LlmError("Ollama returned an empty answer");
    return text;
  };
}
