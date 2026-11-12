import { createInterface } from "node:readline";

/**
 * Questions in the terminal that also work when the answers are piped in ("y" | npm run agent ...).
 * Node's readline drops lines that arrive before a question is asked, so every line is queued here and
 * handed to the next question. When the input ends with questions left, they get "" (Enter), which is
 * the safe answer: keep the agent's pick, and NOT run (only "y" runs).
 */
export type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean };

export function terminal(input: TerminalInput = process.stdin, out: NodeJS.WritableStream = process.stdout): { ask: (question: string) => Promise<string>; close: () => void } {
  const atKeyboard = Boolean(input.isTTY);
  // `output` is where readline echoes what is typed. Without it, `terminal: true` puts the keyboard in
  // raw mode and readline echoes to nowhere, so the designer types the answer and sees NOTHING back.
  // (Windows 2026-11-12: Htain pressed "2", saw no "2", pressed more keys, and the answer became "211".)
  const rl = createInterface({ input, output: atKeyboard ? out : undefined, terminal: atKeyboard });
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
  const nextLine = (): Promise<string> => {
    const line = queued.shift();
    if (line !== undefined || ended) {
      if (!atKeyboard) out.write(`${line ?? ""}\n`); // piped answers are not echoed, so log them
      return Promise.resolve(line ?? "");
    }
    return new Promise<string>((resolve) =>
      waiting.push((l) => {
        if (!atKeyboard) out.write(`${l}\n`);
        resolve(l);
      }),
    );
  };

  const ask = async (question: string): Promise<string> => {
    out.write(question);
    // At a real keyboard, anything typed BEFORE the question appeared is not an answer to it.
    if (atKeyboard) queued.length = 0;
    return nextLine();
  };
  return { ask, close: () => rl.close() };
}
