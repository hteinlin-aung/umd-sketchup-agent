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
  const endpoint = `${url.replace(/\/$/, "")}/api/chat`;
  // Remembered once per run: some models have no thinking to switch off and reject the field.
  let sendThink = true;

  const ask = async (messages: ChatMessage[], schema: Record<string, unknown>, think: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      format: schema, // Ollama only lets the model produce JSON of this shape
      options: { temperature: 0, num_ctx: 8192 },
    };
    // A thinking model (qwen3:8b and friends) reasons for minutes before the JSON appears,
    // which ran past the timeout. We only want the plan, so turn thinking off where it exists.
    if (think) body.think = false;
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      // A timeout means Ollama IS running and just slow: say so instead of "could not reach".
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new LlmError(
          `${model} did not answer within ${Math.round(timeoutMs / 1000)} s. Ollama is running, it is just slow. ` +
            "Check it is on the GPU (run: ollama ps, PROCESSOR should say 100% GPU), or try a smaller model.",
        );
      }
      throw new LlmError(`could not reach Ollama at ${url} (${err.message}). Is it running? Try: ollama list`);
    }
  };

  const fail = async (res: Response): Promise<never> => {
    const body = await res.text().catch(() => "");
    throw new LlmError(
      `Ollama answered ${res.status}: ${body.slice(0, 300)}${res.status === 404 ? `\nIs the model pulled? Try: ollama pull ${model}` : ""}`,
    );
  };

  return async (messages, schema) => {
    let res = await ask(messages, schema, sendThink);
    if (!res.ok && sendThink && res.status >= 400 && res.status < 500) {
      const body = await res.clone().text().catch(() => "");
      if (/think/i.test(body)) {
        sendThink = false; // this model has no thinking to turn off
        res = await ask(messages, schema, false);
      }
    }
    if (!res.ok) await fail(res);
    const data = (await res.json()) as { message?: { content?: string } };
    const text = data.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new LlmError("Ollama returned an empty answer");
    return text;
  };
}
