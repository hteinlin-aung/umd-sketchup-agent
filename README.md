# UMD SketchUp Agent

AI-assisted modelling for **SketchUp 2025**: written design instructions become validated
operations, which run through a **fixed set of tested Ruby tools** inside SketchUp. The result
is checked, and a **new copy** of the model is saved. The AI never writes SketchUp code.

Built for the *Urban Mind Detox* thesis model. Full plan and decisions: [`PLAN.md`](PLAN.md).
**New here? Read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) first:** folders, workflow, and how the code talks to SketchUp.

**Status:** Week 1 done (2026-10-29). Week 2: read-only tools verified on Windows (2026-11-02,
levels confirmed). Step 2a: changing tools `createPrism`, `setTag`, `setTagVisibility`,
`moveToReplaced` (bridge 0.3.0) verified on Windows (2026-11-11). Step 2b: `npm run summary`, a room
description for the AI that lists what each group really contains (verified on Windows, dev model and MASTER).
Step 2c: `npm run agent`: your brief → local AI draft → checked plan → **you type y** → SketchUp → saved copy +
report (mock-tested, waiting for Windows).

---

## How it works (Week 1)

```
TypeScript (src/)                         SketchUp 2025 + UMD Bridge (sketchup/)
─────────────────                         ──────────────────────────────────────
BridgeClient.call("createBox", {...})
  1. Zod checks the arguments
  2. writes agent_queue/in/<id>.json  ──►  timer (every 0.5 s) claims the file
                                           model guard: target.txt? not MASTER?
                                           checks the arguments again (args.rb)
                                           runs the tool as ONE undo step
                                           measures the result (e.g. box size)
  3. reads agent_queue/out/<id>.json  ◄──  writes the result, logs it
  4. Zod checks the result data
```

| Folder | What's in it |
|---|---|
| `src/protocol/` | The contract: message envelope + each tool's arguments and results (Zod) |
| `src/bridge/` | `client.ts` (use this), `fileQueue.ts` (real), `mockSketchUp.ts` (fake, for the Mac) |
| `src/smoke/` | The Week 1 acceptance test, the same steps for mock and real |
| `src/geometry/units.ts` | **Htain's module**: see "Your first task" below |
| `sketchup/umd_bridge/` | Ruby: `main.rb` (loop, guard, undo), `args.rb` (checks), `geo.rb` (units/targets), `tools/` |
| `tests/` | Vitest (TypeScript) + plain-Ruby tests; `fixtures/args_cases.json` is shared by both |

**Safety rules, enforced in code:** no `eval`, only listed tools · unknown arguments rejected ·
changing tools need `target.txt` to match the open model · the **MASTER** model can never be
changed · every change is one undo step, rolled back on error · files are never overwritten.

---

## Mac: development

Needs Node 22.12+ and npm 11+ (`node -v`, `npm -v`).

```bash
cd ~/Desktop/Claude_Cowork/umd-sketchup-agent
npm install            # run this yourself, in your own Terminal
npm run typecheck      # TypeScript finds type mistakes, without running anything
npm test               # all TypeScript tests (mock SketchUp)
npm run test:ruby      # Ruby tests (argument checks + bridge loop with a fake SketchUp)
npm run smoke:mock     # the Week 1 acceptance test against the mock
npm run summary -- "1F RECEPTION" --mock   # step 2b room summary, on a fake copy of the T128 reception
npm run agent -- instructions/1F_reception.md "1F RECEPTION" --mock --draft instructions/1F_reception.draft.json
                       # step 2c end to end on the fake room, with the hand-written reference draft (no AI)
```

No `.env` is needed on the Mac: without one, everything uses the mock.

## Windows: real SketchUp

**One-time setup**

1. Clone and install:
   ```powershell
   cd E:\Cowork_Field
   git clone https://github.com/hteinlin-aung/umd-sketchup-agent.git
   cd umd-sketchup-agent
   npm install
   copy .env.example .env
   ```
2. Edit `.env`: set `UMD_TRANSPORT=file` and check `UMD_QUEUE_DIR`
   (default `E:/Cowork_Field/Thesis_SketchUp/agent_queue`).
3. Install the SketchUp loader: copy `sketchup\umd_bridge_loader.example.rb` to
   `C:\Users\user\AppData\Roaming\SketchUp\SketchUp 2025\SketchUp\Plugins\umd_bridge.rb`
   and check the two paths at the top of that copy.
4. Create the allow-list file `E:\Cowork_Field\Thesis_SketchUp\agent_queue\target.txt`
   containing one line: `UMD_DEV_`
   (only models whose path contains that text can be changed).
5. Restart SketchUp. **Extensions ▸ UMD Bridge ▸ Status** should say RUNNING.
   The Ruby Console (Extensions ▸ Developer ▸ Ruby Console) shows `[UMD Bridge 0.1.2] watching …`.

**Each test**

```powershell
git pull                 # get the latest code
# in SketchUp: Extensions > UMD Bridge > Reload (after git pull)
# open E:\Cowork_Field\Thesis_SketchUp\dev\UMD_DEV_1F.skp
npm run ping             # quick: is SketchUp listening?
npm run smoke            # Week 1 acceptance test
npm run smoke:w2         # Week 2 changing tools: L-bench prism, bow-tie refused, tag hide/show, moveToReplaced
npm run levels           # floor levels: every surface straight down through each UMD nF group
npm run summary -- "1F RECEPTION"   # read-only room summary for the AI -> runs/summary_<time>.md + .json
npm run agent -- instructions/1F_reception.md "1F RECEPTION" --dry   # ask Ollama for a plan, show it, run nothing
npm run agent -- instructions/1F_reception.md "1F RECEPTION"         # plan, then ask y/n, run, save a copy
npm run agent -- <brief> "<room>" --draft runs/agent_<time>/draft.json  # run a draft you already reviewed
npm run bench -- instructions/1F_reception.md "1F RECEPTION" --runs 3 --models qwen3:8b,gpt-oss:20b  # compare models (plans only)
npm run components                   # your components folder with real sizes (measures new files; dev model)
npm run tool -- findEntities @find.json   # run any one tool by hand (arguments from a JSON file)
```

`npm run smoke` adds a 4 × 3 × 3.2 m orange test box 5 m outside the model and saves
`smoke_<date>.skp` next to the dev model. Close the dev model **without saving** afterwards
if you don't want the test box in it.

**If something goes wrong**

| Message | Meaning |
|---|---|
| `No heartbeat` | SketchUp is closed, or the bridge isn't running → Extensions ▸ UMD Bridge ▸ Start |
| `WRONG_MODEL` | The open model doesn't match `target.txt` (or it was never saved) |
| `MASTER_PROTECTED` | Working as intended: the master can't be changed |
| `NOT_PICKED_UP` | SketchUp was busy or frozen; the command was cancelled and will not run later |
| `STILL_RUNNING` | SketchUp took the command but hasn't finished. Don't resend; watch `out/` |

Long tools are normal on the big model (2026-10-29, 336 MB dev copy): `captureView` about 8 s, `saveCopy` about 26 s.
The heartbeat says `busy` while a tool runs, so the client waits instead of giving up.

Every command is logged in `agent_queue/bridge_log.jsonl`. The original command files are kept in `done/`.

---

## Running one tool by hand: `npm run tool`

```bash
npm run tool -- findEntities '{"name":"bench"}'        # Mac/bash: inline JSON is fine
npm run tool -- inspectEntity --target-id 12345        # shortcut for {"target":{"entityId":12345}}
npm run tool -- measure @probe.json                    # Windows: put the JSON in a file
```

The arguments are checked with the same Zod schemas the agent uses, so a typo is reported
before anything reaches SketchUp. Add `--mock` to try it without SketchUp.

| Tool (Week 2) | What it does | Typical arguments |
|---|---|---|
| `findEntities` | Groups/components matching a name, tag, type or area, with their full path | `{"name":"bench"}`, `{"tag":"Ceilings","maxDepth":5}`, `{"within":{"path":["UMD 1F"]}}` |
| `inspectEntity` | Size, faces (top/sides/bottom), materials, children of one thing | `{"target":{"entityId":123}}` |
| `measure` | Every surface a ray passes, with heights and which group each belongs to | `{"from":[12,7,30],"direction":"down","allHits":true}` |

| `createPrism` | **Changes the model.** A footprint polygon (x,y in metres) extruded from `z0` to `z1`: benches, partitions, panels, platforms. Checks the edges don't cross; verifies volume | `{"jobGroup":"T201","name":"oak bench","tag":"…","points":[[0,0],[2,0],[2,0.5],[0,0.5]],"z0":1.489,"z1":1.939}` |
| `setTag` | **Changes the model.** Puts an object on a tag (creates the tag if needed) | `{"target":{"entityId":123},"tag":"1F Reception - Furniture (AGENT)"}` |
| `setTagVisibility` | **Changes the model.** Shows or hides a tag (never Untagged) | `{"tag":"PROPOSED - TBC (Phase 2)","visible":false}` |
| `moveToReplaced` | **Changes the model.** Hides an object on `zz_REPLACED by … (hidden)` instead of deleting it | `{"target":{"entityId":123},"replacedBy":"T201 oak bench"}` |

The first three are **read-only**, so they also work on the MASTER. The last four change the model, so
they need `target.txt` to match and are always refused on the MASTER.

**Confirmed levels** (measured 2026-11-02, in `src/project/umdLevels.ts`): finish floor 1F **1.489 m**,
2F **5.479 m**, 3F **10.979 m**, roof 15.979 m. Build on these, not on bounding boxes. Directions follow SketchUp's axes:
east = +X (red), north = +Y (green), up = +Z (blue). Hidden geometry is ignored, as on screen.

## Your first task (Htain): `src/geometry/units.ts`

1. Open `tests/unit/units.test.ts` and change `describe.skip(` to `describe(`.
2. Run `npm test`: 9 tests fail. That's the spec.
3. Write `toMeters`, `parseLength` and `nearlyEqual` until they pass.

Hints: a lookup table (unit → metres per unit) makes `toMeters` one line. For `parseLength`,
a regex with two groups (number, unit). `nearlyEqual` is one line with `Math.abs`.

## Adding a tool (the pattern)

1. `src/protocol/tools.ts`: add `XArgs` + `XData` schemas and an entry in `TOOLS`.
2. `sketchup/umd_bridge/args.rb`: add `Validate.x` with the same rules.
3. `tests/fixtures/args_cases.json`: add valid and invalid cases; **both** test suites check them.
4. `sketchup/umd_bridge/tools/*.rb`: write `Tools.x(args, ctx)`. Measure what you built and
   raise `VERIFY_FAILED` if it's wrong.
5. `sketchup/umd_bridge/main.rb`: add it to `self.tools` with its kind (`:read`, `:write`, …).
6. `src/bridge/mockSketchUp.ts`: teach the mock the same behaviour.
7. Add it to the smoke test or its own Windows check. Only call it done after a real run.
