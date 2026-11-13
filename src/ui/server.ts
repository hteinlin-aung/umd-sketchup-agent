// The local page for the agent: `npm run ui`, then open http://127.0.0.1:4477 (or the panel inside SketchUp).
//
// It does NOT plan or build anything itself. It starts the same command you type in PowerShell
// (`npm run agent -- <brief> "<room>" ...`) as a child process, shows every line it prints as it happens,
// and turns its two questions ("Pick 1-3", "Type y to run") into buttons. So the page can never do
// more than the command line can, and every safety rule stays where it is.
//
// Only Node's built-in modules are used here: no new packages.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";

export type RunMode = "dry" | "run";

/** Everything the page is told about a run, in order. A page that opens late gets all of them again. */
export type UiEvent =
  | { type: "start"; brief: string; room: string; mode: RunMode; mock: boolean; draft: string | null; at: string }
  | { type: "line"; text: string }
  | { type: "question"; kind: "approve" | "pick"; text: string; max: number }
  | { type: "answer"; text: string }
  | { type: "end"; code: number | null; outcome: string | null; runDir: string | null };

export type UiOptions = {
  /** The repo folder (where instructions/ and runs/ are). */
  root: string;
  /** Folders a picture may be shown from (the queue's folder, runs/). Anything else is refused. */
  imageRoots?: string[];
  /** Shown at the top of the page. */
  info?: { transport: string; model: string };
  /** How the agent is started. Tests replace this with a small fake program. */
  agentCommand?: (args: string[]) => { cmd: string; args: string[] };
  pagePath?: string;
};

const RUN_FILES = ["report.md", "summary.md", "plan.json", "draft.json", "draft.repaired.json", "choices.json", "model_answers.json", "outcomes.json"];
const MAX_EVENTS = 20_000;
// The agent's two questions end without a newline, so they are found in the unfinished last line.
const APPROVE = /Type y to run, anything else to stop: $/;
const PICK = /Pick 1-(\d+) \(Enter = 1\): $/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createUiServer(opts: UiOptions): { server: Server; listen: (port: number) => Promise<number>; close: () => Promise<void> } {
  const root = resolve(opts.root);
  const instructions = join(root, "instructions");
  const runsDir = join(root, "runs");
  const imageRoots = (opts.imageRoots ?? [runsDir]).map((r) => resolve(r));
  const pagePath = opts.pagePath ?? join(root, "src", "ui", "page.html");
  const agentCommand =
    opts.agentCommand ?? ((args: string[]) => ({ cmd: process.execPath, args: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/cli/agent.ts", ...args] }));

  let child: ChildProcess | null = null;
  let events: UiEvent[] = [];
  let question: Extract<UiEvent, { type: "question" }> | null = null;
  const listeners = new Set<ServerResponse>();

  const emit = (e: UiEvent): void => {
    if (events.length < MAX_EVENTS) events.push(e);
    const text = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of listeners) res.write(text);
  };

  // ---- reading the folders -------------------------------------------------------------------------------

  /** A plain file name inside instructions/, never a path. */
  const instructionFile = (name: unknown, ext: RegExp): string => {
    if (typeof name !== "string" || !/^[\w][\w .()-]*$/.test(name) || !ext.test(name)) throw new HttpError(400, "not a file name in instructions/");
    if (!existsSync(join(instructions, name))) throw new HttpError(404, `instructions/${name} does not exist`);
    return name;
  };

  const listBriefs = () => {
    if (!existsSync(instructions)) return [];
    const files = readdirSync(instructions).sort();
    const drafts = files.filter((f) => /\.draft\.json$/i.test(f));
    return files
      .filter((f) => /\.md$/i.test(f))
      .map((file) => {
        const text = readFileSync(join(instructions, file), "utf8");
        const stem = file.replace(/\.md$/i, "");
        return {
          file,
          title: (/^#\s+(.+)$/m.exec(text)?.[1] ?? file).trim(),
          room: (/^Room group:\s*`([^`]+)`/m.exec(text)?.[1] ?? "").trim(),
          model: (/^Model:\s*`([^`]+)`/m.exec(text)?.[1] ?? "").trim(),
          changes: (text.match(/^\d+\.\s/gm) ?? []).length,
          drafts: drafts.filter((d) => d.startsWith(`${stem}.`)),
        };
      });
  };

  const listRuns = () => {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .filter((d) => /^agent_\w+$/.test(d) && statSync(join(runsDir, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 30)
      .map((run) => {
        const report = join(runsDir, run, "report.md");
        const head = existsSync(report) ? readFileSync(report, "utf8").slice(0, 600) : "";
        return {
          run,
          outcome: /Outcome:\s*\*\*([A-Z_ ]+)\*\*/.exec(head)?.[1] ?? (head ? "?" : "no report"),
          files: RUN_FILES.filter((f) => existsSync(join(runsDir, run, f))),
        };
      });
  };

  const inside = (file: string, folder: string): boolean => {
    const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
    return fold(file).startsWith(fold(folder) + sep);
  };

  // ---- one run at a time -----------------------------------------------------------------------------------

  const startRun = (body: Record<string, unknown>) => {
    if (child) throw new HttpError(409, "a run is already going; only one sender may use the queue at a time");
    const brief = instructionFile(body.brief, /\.md$/i);
    const draft = body.draft ? instructionFile(body.draft, /\.draft\.json$/i) : null;
    const room = typeof body.room === "string" ? body.room.trim() : "";
    if (!room || room.length > 200 || /[\r\n]/.test(room)) throw new HttpError(400, "give the room: a piece of the room group's name");
    const mode: RunMode = body.mode === "run" ? "run" : "dry";
    const mock = body.mock === true;
    const args = [`instructions/${brief}`, room];
    if (mode === "dry") args.push("--dry");
    if (draft) args.push("--draft", `instructions/${draft}`);
    if (mock) args.push("--mock");

    events = [];
    question = null;
    emit({ type: "start", brief, room, mode, mock, draft, at: new Date().toISOString() });
    const { cmd, args: full } = agentCommand(args);
    const proc = spawn(cmd, full, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    let outcome: string | null = null;
    let runDir: string | null = null;

    const line = (raw: string) => {
      const text = raw.replace(/\r$/, "");
      outcome = /^OUTCOME: (.+)$/.exec(text)?.[1]?.trim() ?? outcome;
      runDir = /runs[\\/](agent_\w+)/.exec(text)?.[1] ?? runDir;
      emit({ type: "line", text });
    };
    const reader = (canAsk: boolean) => {
      let rest = "";
      return {
        data(chunk: Buffer) {
          const parts = (rest + chunk.toString("utf8")).split("\n");
          rest = parts.pop() ?? "";
          for (const p of parts) line(p);
          if (!canAsk || question) return;
          const pick = PICK.exec(rest);
          if (pick) question = { type: "question", kind: "pick", text: rest.trim(), max: Number(pick[1]) };
          else if (APPROVE.test(rest)) question = { type: "question", kind: "approve", text: rest.trim(), max: 0 };
          if (question) emit(question);
        },
        end() {
          if (rest) line(rest);
          rest = "";
        },
      };
    };
    const out = reader(true);
    const err = reader(false);
    proc.stdout!.on("data", out.data);
    proc.stderr!.on("data", err.data);
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      out.end();
      err.end();
      child = null;
      question = null;
      emit({ type: "end", code, outcome, runDir });
    };
    proc.on("error", (e) => {
      line(`could not start the agent: ${e.message}`);
      finish(null);
    });
    proc.on("close", (code) => finish(code));
  };

  const answer = (body: Record<string, unknown>) => {
    if (!child || !question) throw new HttpError(409, "the agent is not waiting for an answer");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (question.kind === "approve" && text !== "y" && text !== "n") throw new HttpError(400, 'answer "y" or "n"');
    if (question.kind === "pick" && text !== "" && !(Number.isInteger(Number(text)) && Number(text) >= 1 && Number(text) <= question.max)) {
      throw new HttpError(400, `pick a number from 1 to ${question.max}`);
    }
    question = null;
    emit({ type: "answer", text });
    child.stdin!.write(`${text}\n`);
  };

  // ---- http ----------------------------------------------------------------------------------------------------

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((done, fail) => {
      let text = "";
      req.on("data", (c: Buffer) => {
        text += c.toString("utf8");
        if (text.length > 20_000) fail(new HttpError(413, "too long"));
      });
      req.on("end", () => {
        try {
          const v: unknown = JSON.parse(text || "{}");
          if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
          done(v as Record<string, unknown>);
        } catch {
          fail(new HttpError(400, "the request is not JSON"));
        }
      });
      req.on("error", fail);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only this computer may talk to the page, and only through its own address (a web site you
    // visit must not be able to press "run" for you).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") throw new HttpError(403, "only from this computer");
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new HttpError(403, "only from this page");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "POST") {
      if (!/^application\/json/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON");
      const body = await readBody(req);
      if (path === "/api/run") startRun(body);
      else if (path === "/api/answer") answer(body);
      else throw new HttpError(404, "no such action");
      return json(res, 200, { ok: true });
    }
    if (req.method !== "GET") throw new HttpError(405, "GET or POST only");

    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(pagePath));
    } else if (path === "/api/info") {
      json(res, 200, { ...(opts.info ?? { transport: "?", model: "?" }), running: child !== null });
    } else if (path === "/api/briefs") {
      json(res, 200, listBriefs());
    } else if (path === "/api/brief") {
      const file = instructionFile(url.searchParams.get("file"), /\.md$/i);
      json(res, 200, { file, text: readFileSync(join(instructions, file), "utf8") });
    } else if (path === "/api/runs") {
      json(res, 200, listRuns());
    } else if (path === "/api/run-file") {
      const run = url.searchParams.get("run") ?? "";
      const file = url.searchParams.get("file") ?? "";
      if (!/^agent_\w+$/.test(run) || !RUN_FILES.includes(file)) throw new HttpError(400, "not a run file");
      const full = join(runsDir, run, file);
      if (!existsSync(full)) throw new HttpError(404, "that run has no such file");
      json(res, 200, { run, file, text: readFileSync(full, "utf8") });
    } else if (path === "/api/image") {
      const asked = url.searchParams.get("path") ?? "";
      const full = resolve(root, asked);
      if (!/\.png$/i.test(full) || !imageRoots.some((r) => inside(full, r))) throw new HttpError(403, "not a picture from the agent's folders");
      if (!existsSync(full)) throw new HttpError(404, "no such picture");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(readFileSync(full));
    } else if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
    } else {
      throw new HttpError(404, "not found");
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (res.headersSent) res.end();
      else json(res, status, { ok: false, error: message });
    });
  });
  const keepAlive = setInterval(() => {
    for (const res of listeners) res.write(": still here\n\n");
  }, 20_000);
  keepAlive.unref();

  return {
    server,
    // 127.0.0.1 only: the page is never reachable from another computer.
    listen: (port) => new Promise((done, fail) => server.once("error", fail).listen(port, "127.0.0.1", () => done((server.address() as AddressInfo).port))),
    close: () =>
      new Promise((done) => {
        clearInterval(keepAlive);
        for (const res of listeners) res.end();
        listeners.clear();
        child?.kill();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
