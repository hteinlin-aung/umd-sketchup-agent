# UMD SketchUp Agent

You write a short design brief. A local AI turns it into a plan. You approve the plan.
SketchUp builds it with a fixed set of tested tools, the result is checked, and a **new copy**
of the model is saved with a report. The AI never writes SketchUp code, and the MASTER model is never changed.

Built for the *Urban Mind Detox* thesis model (SketchUp 2025).

- Full plan, decisions and change log: [`PLAN.md`](PLAN.md)
- How the parts talk to each other: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md)

**Status (2026-11-14):** Weeks 1–3 done. Brief → AI plan → approval → built, checked and saved works in two
rooms (reception, meditation suite). Week 4: real briefs on 2F and 3F. Deadline 2026-11-26.

---

## 1. A normal run (Windows)

Do these in order. Each step says what you should see.

1. **Get the latest code.**
   ```powershell
   cd E:\Cowork_Field\umd-sketchup-agent
   git pull
   ```
2. **Reload the bridge** (the Ruby part inside SketchUp): Extensions ▸ UMD Bridge ▸ Reload.
3. **Open a dev copy**, never the MASTER, for example `E:\Cowork_Field\Thesis_SketchUp\dev\UMD_DEV_1F_meditation.skp`.
   For collision tests use a copy that has the building in it (walls, columns).
   `UMD_DEV_1F_reception.skp` has no building, so the check has nothing to hit there.
4. **Check SketchUp is listening.**
   ```powershell
   npm run ping
   ```
   You should see the SketchUp version, the open model and the list of tools.
5. **Make sure Ollama is running** (the program that runs the local AI model, `qwen3:8b`).
6. **Plan only, nothing changes:**
   ```powershell
   npm run agent -- instructions/1F_meditation_build.md "1F MEDITATION" --dry
   ```
   The two parts after `agent --` are the brief file and a piece of the room group's name.
   You see one line per action, with real positions and sizes, and any warnings.
7. **Run it for real:** the same command without `--dry`. Read the plan, then type **y** to build or **n** to stop.
   If the brief places components, you are asked "which one do you like?" first (press Enter to keep the agent's pick).
8. **Read the result.** The outcome is at the top of `runs/agent_<time>/report.md`.
   The saved copy is next to the dev model, for example `UMD_DEV_1F_meditation_build_20261113_231558.skp`.
9. **Close the dev model without saving**, so the next run starts clean.

> Start full AI runs yourself in PowerShell. The Windows Claude chat cannot reach Ollama from its shell,
> and its commands stop after 45 s. It can run `--draft` runs (no AI) that finish quickly.

### The outcome

Every run ends with exactly one of these:

| Outcome | Meaning | What to do |
|---|---|---|
| `SUCCESS` | Everything ran, the read-back was clean, the copy is saved | Open the copy and look |
| `BLOCKED` | Nothing was saved: the plan had a problem the code can't fix, an action failed, or you typed n | Read the reasons in the report; fix the brief |
| `MAX_ATTEMPTS_REACHED` | The automatic repair tried 3 times and a block still cuts into the model | The rest is saved; the report lists what gave up |

### What a run leaves in `runs/agent_<time>/`

| File | What it is |
|---|---|
| `report.md` | **Read this.** Outcome, brief, plan, each action and its result, checks, the saved file |
| `summary.md` | What the AI was told about the room (each item with a ref like `R1`, its box and real contents) |
| `draft.json` | The plan the AI wrote, after checking. You can re-run it with `--draft` (no AI) |
| `draft.repaired.json` | Only if the repair moved a block |
| `plan.json` | The exact tool calls, with coordinates |
| `model_answers.json`, `outcomes.json` | The AI's raw answers, one per change |
| `choices.json` | Only if you picked components |

---

## 2. Writing a brief

A brief is a Markdown file in `instructions/`. Copy `instructions/1F_meditation_build.md` and change it.

**Before you write: run the room summary.** Never guess the space. (Brief 5 was first written from a guess,
and the "corridor" turned out to be an open courtyard.)
```powershell
npm run summary -- "1F MEDITATION"
```
It prints every item in the room with a ref (`R1`, `R2`, …), its box and what is really inside it.
**You can only measure from items in this list.** Names can be wrong ("Sofa set 4" holds a palm), so check the contents.

### The shape of a brief

```markdown
# 1F Reception - design changes

Model: `dev/UMD_DEV_1F_reception.skp` (never the MASTER)
Floor: 1F finish floor, z = 1.489 m.
Room group: `1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)`

Intent: one or two sentences about the feeling you want.

## Changes for now

1. **Forest bench.** A built-in light oak bench along the east face of `Terrarium E`,
   6.0 m long, 0.5 m deep, 0.45 m high, touching the terrarium base, centred on its length.

2. **Tags.** Put everything new on the tag `1F Reception - Furniture (AGENT)`.

3. **Materials.** Light oak = RGB 196, 164, 120, material name `UMD Light Oak`.

4. **Check it.** Take a screenshot, then save a copy as `UMD_DEV_1F_reception_brief1.skp`.

## Later (do not try now)

- (later) Ideas the agent can't do yet. They are not planned; the report lists them as not done.
```

### What the planner understands

Each numbered change becomes one kind of step:

| You write | Step | Notes |
|---|---|---|
| "A light oak bench … 6.0 m long, 0.5 m deep, 0.45 m high, on the east side of `X`, 1.2 m gap, centred" | **build** a block | Position = an item, a side (north/south/east/west), a gap, and an optional shift ("shifted 3.0 m north of its centre") |
| "A thin top on the counter, 0.05 m overhang" | **build** on top of another block | |
| "Place the potted money tree component 0.3 m east of `X`" | **place** a component | Size comes from the component file, fitted to a sensible size |
| "Take out `Sofa set 4`" | **replace** | Moved to a hidden `zz_REPLACED` tag, never deleted |
| "Hide / show the tag `…`" | **hideTag / showTag** | |
| "Take a screenshot" | **screenshot** | Eye-level, from inside the room, aimed at the new pieces |
| "Save a scene called `…`, from the north-west corner, seated, toward `X`" | **scene** | For D5. From = a side, a corner, an item ref, or "above" |
| "Save a copy as `….skp`" | **save** | Always a new file; a time is added to the name |

**Tips that save a failed run:**
- Give every size with its direction: "2.0 m long (east-west), 0.35 m deep (north-south)".
- One thing per numbered change.
- Directions follow SketchUp: east = +X (red), north = +Y (green), up = +Z (blue).
- Things stand on the floor level (1F 1.489, 2F 5.479, 3F 10.979 m). **Raised floors (like the tatami
  platforms) are not known yet**, so don't build on them.
- The planner can only put a piece *beside* or *on top of* an item, not "inside a room, against its wall".
  Measure from an item near the wall instead.
- Put ideas the tools can't do yet under "Later".

---

## 3. Components (real furniture and plants)

- Put `.skp` files in the `components` folder next to `agent_queue`. The agent never downloads by itself;
  you download from 3D Warehouse.
- `npm run components` measures new files and lists them in three groups:
  - **fine:** placed at their real size
  - **RESIZED WHEN PLACED:** a mis-scaled file is brought to a normal size with one even scale (nothing squashed)
  - **CAN'T BE PLACED:** wrong proportions, or probably a whole scene, with the reason
- A file whose real size is right but looks wrong to the rules (the 24 m banyan): add its file name to
  `instructions/components_as_drawn.txt`. Then only the ceiling limit applies.
- A size in the brief always wins: "a fittonia 0.45 m high".

---

## 4. Safety rules (enforced in code)

- The AI only chooses from a fixed list of tools and fills in their values. No `eval`, no AI-written code.
- Every value is checked twice: in TypeScript (Zod) and again in Ruby.
- Changing tools only work on a model whose path matches `agent_queue/target.txt` (`UMD_DEV_`). The MASTER is always refused.
- Every change is one undo step and is rolled back if it fails. Files are never overwritten.
- Before anything runs, the geometry check looks at the **whole model** near each new block (bridge 0.7.0).
  Big shell groups are checked face by face. A block that cuts into something is slid clear (max 3 tries) or the run is BLOCKED.
- After the build, everything is read back and compared with the plan before saving.

---

## 5. All commands

**Windows (real SketchUp)**

| Command | What it does |
|---|---|
| `npm run ping` | Is SketchUp listening? |
| `npm run summary -- "<room>"` | Room summary for the AI → `runs/summary_<time>.md` |
| `npm run agent -- <brief> "<room>" --dry` | Plan only |
| `npm run agent -- <brief> "<room>"` | Plan, ask y/n, build, check, save, report |
| `npm run agent -- <brief> "<room>" --draft <draft.json>` | Skip the AI, use a draft you already reviewed |
| add `--warm` | Keep the AI model loaded (default: start cold, which scored better) |
| `npm run components` | Your components with real sizes |
| `npm run bench -- <brief> "<room>" --runs 3 --models qwen3:8b` | Compare AI models on a brief (plans only) |
| `npm run levels` | Floor levels, measured straight down |
| `npm run smoke` / `npm run smoke:w2` | Acceptance tests for the basic tools |
| `npm run tool -- <tool> @args.json` | Run one tool by hand |

**Mac (no SketchUp: everything uses a fake SketchUp, the "mock")**

```bash
npm install          # you run this yourself
npm run typecheck    # find type mistakes without running anything
npm test             # all TypeScript tests
npm run test:ruby    # Ruby tests with a fake SketchUp
npm run agent -- instructions/1F_reception.md "1F RECEPTION" --mock --draft instructions/1F_reception.draft.json
```

### The tools (bridge 0.7.0)

| Tool | Changes the model? | What it does |
|---|---|---|
| `ping` | no | Version, open model, tool list |
| `getModelInfo` | no | Groups, tags, materials |
| `findEntities` | no | Groups/components by name, tag or area, with their path |
| `inspectEntity` | no | Size, faces, materials, children of one thing |
| `facesInBox` | no | Faces inside a box (for the face-by-face collision check) |
| `measure` | no | Every surface a ray passes, with heights |
| `listComponents` | no | The components folder |
| `componentPreview` | no | A PNG picture of a component file |
| `captureView` | no | A screenshot |
| `componentInfo` | for a moment | Loads a file to measure it, then removes it (dev models only) |
| `createBox`, `createPrism` | yes | Blocks: benches, counters, partitions, panels |
| `applyMaterial` | yes | Paints a block |
| `setTag`, `setTagVisibility` | yes | Tags |
| `moveToReplaced` | yes | Hides an item instead of deleting it |
| `placeComponent` | yes | Places a component file, with rotation and scale |
| `addScene` | yes | A saved camera view; never changes an existing scene |
| `saveCopy` | saves | Saves a new copy next to the model |

---

## 6. If something goes wrong

| Message | Meaning |
|---|---|
| `No heartbeat` | SketchUp is closed, or the bridge isn't running → Extensions ▸ UMD Bridge ▸ Start |
| `WRONG_MODEL` | The open model doesn't match `target.txt`, or it was never saved |
| `MASTER_PROTECTED` | Working as intended: the MASTER can't be changed |
| `NOT_PICKED_UP` | SketchUp was busy or frozen; the command was cancelled and will not run later |
| `STILL_RUNNING` | SketchUp took the command but hasn't finished. Don't resend; watch `agent_queue/out/` |
| `LlmError` / connection refused | Ollama isn't running, or the model name in `.env` is wrong |
| Plan line "the view of R1 is blocked by R8" | A warning only: pick another side for the scene |

Every command is logged in `agent_queue/bridge_log.jsonl`. Long tools are normal on the big model
(`saveCopy` up to about 26 s); the heartbeat says `busy` meanwhile, so the client waits.

---

## 7. One-time setup (Windows)

1. Clone and install:
   ```powershell
   cd E:\Cowork_Field
   git clone https://github.com/hteinlin-aung/umd-sketchup-agent.git
   cd umd-sketchup-agent
   npm install
   copy .env.example .env
   ```
2. Edit `.env`: `UMD_TRANSPORT=file`, check `UMD_QUEUE_DIR` (default `E:/Cowork_Field/Thesis_SketchUp/agent_queue`)
   and `OLLAMA_MODEL=qwen3:8b`. Keep `UMD_ALLOW_PAID=false`.
3. Install the loader: copy `sketchup\umd_bridge_loader.example.rb` to
   `C:\Users\user\AppData\Roaming\SketchUp\SketchUp 2025\SketchUp\Plugins\umd_bridge.rb`
   and check the two paths at the top of the copy.
4. Create `E:\Cowork_Field\Thesis_SketchUp\agent_queue\target.txt` with one line: `UMD_DEV_`
5. Install Ollama and run `ollama pull qwen3:8b`.
6. Restart SketchUp. Extensions ▸ UMD Bridge ▸ Status should say RUNNING.
7. Set your git name once: `git config user.name "…"` and `git config user.email "…"`.

---

## 8. Adding a tool

1. `src/protocol/tools.ts`: add the `XArgs` and `XData` schemas and an entry in `TOOLS`.
2. `sketchup/umd_bridge/args.rb`: add `Validate.x` with the same rules.
3. `tests/fixtures/args_cases.json`: add good and bad cases. **Both** test suites check them.
4. `sketchup/umd_bridge/tools/*.rb`: write `Tools.x(args, ctx)`. Measure what you built and raise
   `VERIFY_FAILED` if it is wrong.
5. `sketchup/umd_bridge/main.rb`: add it to `self.tools` with its kind (`:read`, `:write`, `:view` or `:file`).
6. `src/bridge/mockSketchUp.ts`: teach the fake SketchUp the same behaviour.
7. If the AI should use it: a new step in `src/agent/draft.ts`, its rules in `src/agent/planner.ts`,
   and positions in `src/agent/resolve.ts`.
8. Test it in real SketchUp on a dev copy. Only call it done after a real run.
