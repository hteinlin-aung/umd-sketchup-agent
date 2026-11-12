import { createInterface } from "node:readline";

/**
 * Questions in the terminal that also work when the answers are piped in ("y" | npm run agent ...).
 * Node's readline drops lines that arrive before a question is asked, so every line is queued here and
 * handed to the next question. When the input ends with questions left, they get "" (Enter), which is
 * the safe answer: keep the agent's pick, and NOT run (only "y" runs).
 */
export function terminal(): { ask: (question: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length) waiting.shift()!("");
  });
  const ask = (question: string) => {
    process.stdout.write(question);
    const line = queued.shift();
    if (line !== undefined || ended) {
      if (!process.stdin.isTTY) process.stdout.write(`${line ?? ""}\n`); // show the piped answer in the log
      return Promise.resolve(line ?? "");
    }
    return new Promise<string>((resolve) =>
      waiting.push((l) => {
        if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
        resolve(l);
      }),
    );
  };
  return { ask, close: () => rl.close() };
}
