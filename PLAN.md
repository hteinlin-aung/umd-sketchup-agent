# UMD SketchUp Agent — PLAN

*Created 2026-10-29 · Deadline 2026-11-26 (4 weeks) · Status: **Week 1 DONE 2026-10-29** · **Week 2 DONE 2026-11-12** (brief → qwen3:8b plan → approval → built and saved, 15/15) · Week 3 next*

## Summary

A local, AI-assisted system that reads my **existing SketchUp 2025 model**, takes my **written design
instructions**, turns them into **validated operations**, carries them out in the **real SketchUp
application** through a fixed set of pre-written tools, **checks** the result, **fixes** confirmed
problems, and **saves a new version** of the model. The AI never writes SketchUp code. It only chooses
tools and fills in their parameters, and every parameter is checked before anything runs.

The test case is my thesis, *Urban Mind Detox*. By the end of week 4 I should be testing real
thesis design changes through this system instead of by hand.

---

## 1. Goal and scope

**In scope (first version)**
- Read the architecture from the existing model: floors, walls, slabs, rooms, tags, groups, scenes.
- Turn written instructions (a `.md` file per task) into a validated list of operations.
- Carry out a limited set of real modelling operations reliably: materials, tags, groups and boxes/prisms
  (built-ins, partitions, panels), component placement, openings, scenes and screenshots, saving copies.
- Check the result with deterministic geometry checks, plus screenshots for a human (and optionally a
  vision model) to look at.
- Fix confirmed problems with predefined operations and a retry limit.
- Always save a **new** file. Never overwrite the master.

**Postponed (not cut, see §9)**
- Building a full building shell from a DWG/DXF. My current DXF is not clean enough (see §2, D1).
- LangGraph, multiple agents, a web UI, hosted AI providers, 3D Warehouse automation, D5 automation.

---

## 2. Key decisions

| # | Decision | Why | Trade-off |
|---|---|---|---|
| D1 | **Geometry comes from the existing .skp**, not the DXF | The model already has accurate walls, slabs, columns and stairs on all three floors. `umd_export_rooms.rb` already reads wall tops and floor plates in metres. In the 1F DXF only the west wing's walls are on `wall 1`; most walls are on `cafe`, mixed with furniture, drawn as single lines, with no door/window layers. The LibreDWG conversion also lost 30 dynamic blocks. | Can't yet go "DWG → building from nothing". Optional later step: clean the DXF layers (WALL / DOOR / WINDOW) and add a "build shell from clean DXF" mode (§9). |
| D2 | **File-based JSON command queue** between TypeScript and SketchUp | Proven on this PC (the `umd_runner.rb` pattern built the whole thesis). No timeout on long jobs with a 600 MB model, survives SketchUp restarts, leaves an audit trail, easy to fake on the Mac. | 0.5 s polling delay. A socket can be added later for quick read-only queries. |
| D3 | **Fixed list of Ruby tools; no `eval`** | Safety rule: the AI chooses tools, it never writes code. Unknown tools or bad parameters are rejected. | Each new ability needs a new tool to be written and tested. That's intended. |
| D4 | **TypeScript + Zod + Vitest; Ruby only inside SketchUp** | My chosen stack. Zod checks everything the AI returns. | Two languages. Ruby stays small and dumb; the logic lives in TypeScript. |
| D5 | **Local model via Ollama, `qwen3:4b-instruct` first** | Already works for me (Stage 4). Measured on the RTX 4060: about 2.5 GB VRAM. | Small model, so its job stays narrow: instructions → structured operations. A larger model gets tested in week 3. |
| D6 | **Plain loop + y/n approvals, no LangGraph yet** | My Stage 4b loop already does this. LangGraph only earns its place once there's real branching and pause/resume. | We may move to LangGraph after week 4. |
| D7 | **Command line first, no web UI** | Fastest way to a working system. Screenshots open as normal image files. | Less pretty. A UI can be added later without touching the tools. |
| D8 | **Work on copies only** | The bridge refuses to change the master file. Development uses a light copy `dev/UMD_DEV_1F.skp`. | One extra step: "save as copy" before a real run. |

---

## 3. How it fits together

```
 instructions/1F_reception.md          (my written design instructions)
            │
            ▼
 ┌──────────────── TypeScript app (Windows; mocks on Mac) ─────────────────┐
 │ 1. read model info      ──► getModelInfo (groups, tags, materials, ...) │
 │ 2. interpret            ──► Ollama → JSON operation list → Zod check    │
 │ 3. resolve targets      ──► "reception floor" → a real group/face id    │
 │ 4. show plan, ask y/n   ──► consequential changes need my approval      │
 │ 5. execute              ──► one command at a time through the queue     │
 │ 6. check                ──► deterministic geometry checks + screenshots │
 │ 7. fix (bounded)        ──► predefined repair tools, max N attempts     │
 │ 8. save copy + report   ──► new .skp + run report (Markdown + JSONL)    │
 └──────────────────────────────┬──────────────────────────────────────────┘
                                │ writes  queue/in/<id>.json
                                ▼
 ┌────────── SketchUp 2025 Pro + extension "UMD Bridge" (Ruby) ────────────┐
 │ timer every 0.5 s → read command → model guard → whitelist lookup →     │
 │ start_operation → run tool → commit (or abort on error) → write result  │
 └──────────────────────────────┬──────────────────────────────────────────┘
                                │ writes  queue/out/<id>.json  (+ PNGs, log)
                                ▼
                      TypeScript reads result, verifies, continues
```

Only one sender may use the queue at a time: either this app or Claude, never both at once.

---

## 4. The command protocol

**Folders** (path set in `.env`, e.g. `E:/Cowork_Field/Thesis_SketchUp/agent_queue/`)
```
agent_queue/
  in/        <id>.json       commands waiting
  working/   <id>.json       command being run (moved here first)
  out/       <id>.json       results
  images/    <id>_*.png      screenshots
  bridge_log.jsonl           one line per command (start, end, error)
  target.txt                 regex of the model path that is allowed to be changed
```

**Command** (TypeScript → Ruby)
```json
{ "id": "20261103-0012", "tool": "applyMaterial", "version": 1,
  "args": { "target": { "groupPath": ["UMD 1F", "1F RECEPTION (T128)"] },
            "material": "UMD Terrazzo Warm", "faces": "top" },
  "createdAt": "2026-11-03T10:21:04+07:00" }
```

**Result** (Ruby → TypeScript)
```json
{ "id": "20261103-0012", "ok": true, "modified": true, "durationMs": 840,
  "data": { "facesPainted": 14, "entityIds": [48211] },
  "warnings": [], "error": null }
```

**Rules the Ruby side always enforces**
- Writes a file to `*.tmp` first, then renames it, so the other side never reads a half-written file.
- If `out/<id>.json` already exists, it does not run the command again (safe retries).
- If the open model's path doesn't match `target.txt`, it returns `ok:false, error:"WRONG_MODEL"`.
- It refuses to change the master file (`*MASTER*.skp`) under any circumstances.
- Every changing tool runs inside `start_operation … commit_operation`, which is one undo step.
  On an exception it runs `abort_operation`, so no half-built geometry is left behind.
- Unknown tool → `UNKNOWN_TOOL`. Bad parameters → `INVALID_ARGS` (Zod also checks on the TypeScript side).
- `ok:true` is only returned after the tool has **checked its own result** (e.g. read the size back).

**Conventions carried over from the thesis scripts**
- TypeScript works in **metres**. Converting to SketchUp's internal **inches** happens only inside Ruby (`m / 0.0254`).
- New work goes in a **named group on its own tag**, named `<Floor> <Zone> - <Element>`.
- Replaced work moves to a hidden `zz_REPLACED …` tag. It is **never deleted**.
- Axes: SketchUp world axes, Z up. Floor levels: **to be measured in week 1.** The README says
  1F 1.49 / 2F 5.48 / 3F 10.98 m, but `umd_export_rooms.rb` uses 0.289 / 4.761 / 8.761 m. These are
  probably different quantities (finish vs. world height). The app needs exactly one confirmed value per floor.

---

## 5. Tools

Taken from what the 210 thesis scripts actually did, ranked by how often each operation was used.
The same helpers (`box`, `prism`, `mat`, `tag`, `paint`, `place`, `scene`, `shots`, model guard) were
rewritten about 5 times in different script libraries. This set replaces all of them with one tested version.

| Week | Tool | What it does | Changes model? |
|---|---|---|---|
| 1 | `ping` | SketchUp version, model path, list of available tools | no |
| 1 | `getModelInfo` | top-level groups (name, tag, bounds in m), tags, materials, scenes | no |
| 1 | `createBox` | box from x0..x1, y0..y1, z0..z1 (m) inside a named job group, on a tag, with a material | yes |
| 1 | `applyMaterial` | paints a group/component (all faces, or top/side faces) | yes |
| 1 | `captureView` | screenshot from a scene or a camera → PNG | no |
| 1 | `saveCopy` | saves a new versioned file; never overwrites | file only |
| 2 | `findEntities` | search by name / tag / floor / bounding box → ids and paths | no |
| 2 | `inspectEntity` | bounds, face areas, material per face, tag, parent path | no |
| 2 | `measure` | raytest distance (e.g. floor to ceiling, wall to wall) | no |
| 2 | `createPrism` | extrudes a polygon (m) to a height: partitions, built-ins, panels, platforms | yes |
| 2 | `setTag` / `setTagVisibility` | moves entities to a tag / shows or hides a tag | yes |
| 2 | `moveToReplaced` | moves an entity to `zz_REPLACED…` (hidden) instead of deleting it | yes |
| 3 | `placeComponent` | loads a local .skp component and places it (position, rotation, scale) | yes |
| 3 | `cutOpening` | cuts a rectangular opening in a wall group (door/window) | yes |
| 3 | `addScene` | saves a camera + tag visibility as a scene | yes |
| 3 | `createMaterial` | colour and/or texture image with a real-world size | yes |

Every tool has: a Zod schema (TypeScript), a matching Ruby handler, a documented side effect, mock
tests on the Mac and one real test on Windows.

---

## 6. Folder structure

```
umd-sketchup-agent/
  PLAN.md  README.md  package.json  tsconfig.json  .gitignore  .env.example
  src/
    config.ts                 load + validate .env (Zod)
    protocol/schemas.ts       Command / Result / tool argument schemas
    bridge/
      transport.ts            interface: send(command) → result
      fileQueue.ts            real transport (folders above)
      mockSketchUp.ts         fake SketchUp for Mac tests (clearly labelled)
    tools/                    one file per tool group: typed wrappers + checks
    geometry/units.ts         mm/cm/m/in/ft → m, tolerances
    geometry/checks.ts        deterministic checks (sizes, inside room, overlaps, clearances)
    ai/ollama.ts              fetch to Ollama, structured output, timeouts
    ai/interpret.ts           instructions + model info → operation list (Zod-checked)
    agent/run.ts              loop: plan → approve → execute → check → fix → save → report
    cli/                      smoke.ts, run.ts, info.ts
  sketchup/
    umd_bridge.rb             loader that goes in the SketchUp Plugins folder
    umd_bridge/main.rb        timer, queue, model guard, whitelist, undo wrapping
    umd_bridge/tools/*.rb     one file per tool group
  instructions/               example instruction files (1F_reception.md, ...)
  tests/unit/  tests/mock/    Vitest
  runs/                       run reports + logs (git-ignored)
```

**Dependencies (kept minimal):** `typescript`, `tsx`, `zod`, `vitest`, `@types/node`. Ollama is called
with plain `fetch`, no SDK. No LangGraph yet.

**Install rule:** `node_modules` is never committed or copied between machines (`tsx`/`esbuild`
contain platform-specific binaries). Run `npm install` separately on the Mac and on Windows.

**Ruby install:** the loader in the Plugins folder points at `sketchup/` inside the repo, so
`git pull` updates the extension. Restart SketchUp (or use the menu "UMD Bridge ▸ Reload") afterwards.

---

## 7. Week-by-week milestones

### Week 1 (Oct 29 – Nov 4): TypeScript drives real SketchUp — ✅ DONE 2026-10-29
- Set up the repo on the Mac. Private GitHub repo `umd-sketchup-agent`. Clone on Windows.
- Ruby `UMD Bridge`: queue, model guard, whitelist, undo wrapping, log.
- Tools: `ping`, `getModelInfo`, `createBox`, `applyMaterial`, `captureView`, `saveCopy`.
- TypeScript: config, schemas, file-queue transport, mock SketchUp, `npm run smoke`.
- Measure and fix the floor levels (§4).

**Done when** (measured on Windows with `dev/UMD_DEV_1F.skp`, not assumed):
1. `ping` returns SketchUp 25.0.x, the model path and the tool list.
2. `getModelInfo` returns the 1F groups with correct sizes in metres.
3. `createBox` makes a 4 × 3 × 3.2 m box in a job group; reading it back matches within 1 mm.
4. `applyMaterial` paints it; reading a face back confirms the material.
5. `captureView` writes a PNG; `saveCopy` writes `UMD_DEV_1F_v001.skp`, which reopens.
6. Bad parameters → `INVALID_ARGS`; unknown tool → `UNKNOWN_TOOL`; master open → refused.
7. SketchUp closed → the app reports "no response after N s" instead of crashing.
8. The same flow passes against the mock on the Mac (labelled as mock).

### Week 2 (Nov 5 – Nov 11): read the architecture + turn instructions into operations — ✅ DONE 2026-11-12
- Tools: `findEntities`, `inspectEntity`, `measure`, `createPrism`, `setTag`, `setTagVisibility`, `moveToReplaced`.
- Model summary for the AI: a compact JSON of the floor (rooms/zones, groups, tags, sizes),
  small enough for a 4B model's context.
- `ai/interpret.ts`: instruction file → operation list (Ollama structured output + Zod).
  Unclear targets ("the wall", with three matches) → ask me, never guess.
- `npm run run -- --model dev/UMD_DEV_1F.skp --task instructions/1F_reception.md`:
  show the operation list → y/n → execute → save a copy.

**Done when:** a real 1F instruction file (≥ 5 changes: materials, a built-in, a partition, tag changes)
produces the right changes in the copy, each one confirmed by reading it back. No change happens outside
the approved targets.

### Week 3 (Nov 12 – Nov 18): checks, fixes, more tools
- `geometry/checks.ts`: inside the room, no overlaps with existing walls/columns, minimum clearances,
  heights, the material actually applied, nothing changed outside the job group.
- Repair loop: issue → predefined fix → re-check → keep or roll back. Max 3 attempts per issue, then report.
- Tools: `placeComponent`, `cutOpening`, `addScene`, `createMaterial`.
- Screenshots after each milestone. Optional vision-model notes (flags only, never proof of correctness).
- ~~Compare `qwen3:4b-instruct` with one larger model~~ done early (`npm run bench`, 2026-11-11/12): qwen3:8b chosen.
- From the Week 2 finish: the size-direction check must follow the BLOCK, not only the change text it came from
  (runs 2–3 built the counter rotated 90° after it migrated to change 3).
- Brief 2 on a different room, to see the planner work beyond the room it was tuned on.

**Done when:** a run with a deliberately wrong instruction (e.g. a built-in overlapping a column) is
caught by a check, fixed by a predefined tool or reported honestly, and the run ends with a clear outcome.

### Week 4 (Nov 19 – Nov 26): thesis testing + stabilising
- Real tasks on all three floors, run against copies of the master.
- Fix the integration bugs that show up. Add the edge cases found to the tests.
- Furniture from a hand-picked local component folder, if the core is solid.
- `README.md`: how to run it, and how to add a new tool (step-by-step).

**Done when:** I can write an instruction file for a thesis room, run it, approve the plan, and get a
saved, checked `.skp` with screenshots and a run report, without writing Ruby myself.

---

## 8. Run outcomes and reporting

Every run ends with exactly one outcome:
- `SUCCESS`: every required operation was done and checked, and the copy was saved.
- `NEEDS_APPROVAL`: waiting for my y/n; the state is saved so the run can continue.
- `BLOCKED`: missing information, wrong model open, a tool failed, or SketchUp isn't responding.
- `MAX_ATTEMPTS_REACHED`: a fix didn't work within the limit; the remaining issues are listed.

`runs/<run-id>/report.md` lists: the instructions, the operation list, approvals, each command and its
result, check results, fixes tried, screenshots, the saved file, and what's still unresolved.

---

## 8b. Local models and hardware (agreed 2026-11-11, to apply in later steps)

Windows PC: i9-12900K, **128 GB DDR5** (4 × DIMM, 4000 MT/s), RTX 4060 **8 GB** (shared with SketchUp),
ROG Strix Z790-E Gaming WiFi II (main slot can split x8/x8). Power supply wattage: unknown yet.

- **No hardware purchase now. Measure first:** a benchmark command runs each model several times on brief 1 and
  scores it against `instructions/1F_reception.draft.json` (changes right out of 8, errors, seconds).
- **Candidates** (all free, Ollama): `qwen3:4b` (now), `qwen3:8b` (thinking off), `qwen2.5:7b-instruct`,
  `qwen3:30b-a3b` instruct (MoE: part on the GPU, the rest in the 128 GB RAM), `gpt-oss:20b`;
  `gpt-oss:120b` as a slow "careful mode". Check exact tags on ollama.com/library before pulling.
- **Model ladder:** fast local model plans each change → a change that fails twice is retried with a bigger local
  model → only then a paid cloud model, and only with `UMD_ALLOW_PAID=true` and a per-change y/n showing the cost.
  Every report records which model planned which change. (`llm.ts` already hides the model behind one interface.)
- **Upgrade only if the benchmark shows speed is the problem:** a 16 GB card (RTX 5060 Ti 16 GB, ~US$430–500 in
  Nov 2026), replacing the 4060 or added beside it (8 + 16 = 24 GB). Used RTX 3090 not worth it at ~US$1,500+.
  VRAM can't be upgraded on its own.
- **Inputs later:** one folder per project (`brief.md`, `plans/` for DXF/DWG, `runs/`); a chat panel inside
  SketchUp on top of the same files; DWG imported by SketchUp itself into a locked reference group, then
  summarised for the model (the model never reads raw drawings).

## 9. Postponed (kept in mind, not built now)

| Feature | Why later | What it would need |
|---|---|---|
| DXF → building shell | DXF layers not clean (D1) | Wall lines moved to `WALL`, doors to `DOOR`, windows to `WINDOW` in AutoCAD; an AutoCAD `SAVEAS` DXF (not LibreDWG); a layer-mapping file; a comparison with the existing model as ground truth |
| LangGraph | A plain loop is enough for v1 | Real need for branching / pause-resume |
| Socket for fast queries | The queue is enough for v1 | Same protocol, different transport |
| Hosted models (Gemini etc.) | Local first, no cost | Provider interface already separate (`ai/`) |
| Web UI | The command line is enough | The agent code stays the same |
| 3D Warehouse search / download | No official API confirmed | A hand-picked local folder for now |
| D5 automation, lighting analysis | Out of scope | — |

---

## 10. Who does what

- **Claude:** the Ruby bridge and tools, the file-queue transport, the mock, `interpret.ts`, the agent
  loop, and the tests around them. Explains each part as it lands.
- **Me (Htain):** `geometry/units.ts`, `protocol/schemas.ts` (tool argument schemas) and
  `geometry/checks.ts`. These are pure functions, tested on the Mac. I also run every `npm install`,
  run the Windows tests, approve operations, and write the instruction files.
- Code style: plain, readable TypeScript; comments only where they help.
- 2026-11-12: Htain asked Claude to write `geometry/checks.ts` (Week 3), given the deadline.
- **Two code editors (since 2026-11-11):** the Windows chat may now edit, test and push too. Rules:
  always `git pull` before editing; each open item has ONE owner (said in the report that hands it over);
  the Mac chat checks the Mac folder is clean and at origin before writing files; small commits, pushed promptly.

---

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A 600 MB model makes tools slow | Tests take minutes; the UI freezes | Develop on `UMD_DEV_1F.skp`; tools only walk the part of the model they need |
| A 4B model picks wrong targets or tools | Wrong changes | Structured output + Zod; target resolution in code; ask when unclear; approval before changes |
| VRAM shared with D5 / browsers | Slow or failed model runs | Close D5 while testing; one model loaded at a time |
| Old `umd_runner.rb` and the new bridge both active | Two senders, conflicting edits | Separate queue folders; the agent never uses the old runner; disable it once the bridge works |
| Floor-level mismatch | Objects at the wrong height | Measure in week 1, then one confirmed value per floor |
| Windows-only testing slows the loop | Many copy-paste round trips | Link the Windows PC to the Claude chat (optional) |

---

## 12. Next actions

- [ ] **Me:** make `E:\Cowork_Field\Thesis_SketchUp\dev\UMD_DEV_1F.skp` (copy → New → Paste In Place).
- [ ] **Me:** create an empty **private** GitHub repo `umd-sketchup-agent` (no README).
- [ ] **Me (optional):** link the Windows PC to the Claude chat; share `E:\Cowork_Field\Thesis_SketchUp`.
- [x] **Claude:** scaffold the repo on the Mac + Week 1 Ruby bridge and tools (2026-10-29).
- [ ] **Me:** first commit + push from the Mac; then the Windows chat clones, installs and runs `npm run smoke`.
- [x] Node 26.13.0 / npm 11.20.0, Git 2.56, Ollama + `qwen3:4b-instruct` installed on Windows (about 2.5 GB VRAM, runs on the GPU).

---

## Change log

- 2026-10-29: Plan written. Decided: existing .skp as the geometry source (DXF postponed), file queue,
  fixed tool list, local `qwen3:4b-instruct`, no LangGraph in v1.
- 2026-10-29: Week 1 code written. TypeScript: config, protocol (envelope + 6 tools), BridgeClient, FileQueueTransport (heartbeat, cancel-if-not-picked-up, STILL_RUNNING), MockSketchUp, smoke test. Ruby: UMD Bridge (0.5 s timer, one command per tick, target.txt guard, MASTER protection, one undo step + abort, measured verification, JSONL log). Verified in a cloud workspace: typecheck clean, 73 Vitest tests, 56 Ruby tests (shared argument cases + bridge loop with a fake SketchUp), smoke:mock 10/10. **Not yet run in real SketchUp.**
- 2026-10-29 (evening): First real Windows run (commit 6b06bda, UMD_DEV_1F.skp 336 MB). ping ✅, steps 1–6 ✅ (box 4.000×3.000×3.200 m, 0 mm error; 6/6 faces painted; PNG ✅; copy saved 335.8 MB in 26.4 s). Stopped before 6b/7 because of **heartbeat starvation**: SketchUp can't write a heartbeat while a tool runs, so after the 26 s saveCopy the next command saw a 26 s-old heartbeat (limit 10 s) and failed with NO_HEARTBEAT. Fix (bridge 0.1.1): heartbeat written just before each tool (`busy: {id, since}`) and just after each result; the client treats a recent "busy" heartbeat as alive and waits up to 8 s for a stale one to recover; runSmoke now keeps earlier PASS lines and records a bridge failure as one FAIL step. Measured timings on the big model: captureView ~8.5 s, saveCopy ~26 s.
- 2026-10-29 (night): Windows retest with bridge 0.1.1 → **smoke 10/10**, copy reopens with the box (Week 1 items 1–5 and 8 done). Fixed in 0.1.2: `Sketchup.active_model` is nil while no model is open → `model_path` crashed the timer (tick_error); now ping still answers, other tools return WRONG_MODEL. Still to test for Week 1: MASTER refusal (with a tiny `dev/UMD_DEV_MASTER_test.skp`) and "SketchUp closed" behaviour. Noted for Week 2: getModelInfo truncates lists at maxItems (the model summary must page or filter); 336 MB dev model makes saveCopy ~25 s / captureView ~7 s → add a small dev model for fast tool testing.
- 2026-10-29 (late): **Week 1 DONE** with bridge 0.1.2 (commit b1fe3c0). MASTER refusal ✅ (empty `dev/UMD_DEV_MASTER_test.skp`: createBox + applyMaterial → MASTER_PROTECTED, nothing drawn). SketchUp closed ✅ (bridge stopped → "No heartbeat"; SketchUp quit → "heartbeat is 22 s old"; nothing left in in/). No tick_error under 0.1.2. New fast dev model `dev/UMD_DEV_1F_reception.skp` (76 MB; smoke 10/10; captureView 1.9 s, saveCopy 5.6 s vs 6.7 s / 24.8 s on the 336 MB model). Note: that model still contains the template figure "ThomThom" (z 0.011–1.867 m); delete it so model bounds start at the reception floor (~1.489 m).

- 2026-10-29 (night): **Week 2 step 1 written (bridge 0.2.0, not yet run on Windows).** Read-only tools `findEntities` (name/tag/type/area search with full paths; flags things inside shared components; stops at 30,000 groups so the MASTER can't freeze SketchUp), `inspectEntity` (size, face orientation counts, materials, children), `measure` (raytest from a point, optionally through every surface, hidden geometry ignored). New commands: `npm run levels` (rays straight down through each UMD nF group, marks floor-like group names) and `npm run tool -- <tool> <json|@file>` (run one tool by hand with full validation). Verified here: typecheck, 113 Vitest, 93 Ruby tests (args parity now 62 shared cases; new fake-SketchUp tests for the search walk and the ray stepping). Week 2 inputs from Htain: `instructions/1F_reception.md`, `units.ts` (worked answer given at his request).
- 2026-11-02: **Week 2 step 1 verified on Windows** (commit 5c731fe, bridge 0.2.0). findEntities 1 ms, inspectEntity 52 ms, measure 0–13 ms even on the 600 MB MASTER; MASTER unchanged. **Floor levels confirmed** by rays through UMD 2F/3F on the MASTER: finish floor 1F 1.489 · 2F 5.479 · 3F 10.979 · roof 15.979 m (structural slab tops 5.204 / 10.729 / 15.729; sample ceilings 4.689 / 8.979 / 13.779; water 0.189, lake bed −1.011). The README values were right; umd_export_rooms.rb's 0.289/4.761/8.761 were not floor levels. Stored in `src/project/umdLevels.ts`. **Finding: group names can be wrong** ("Sofa set 4" contains only a palm) → the AI step must inspect each target and show its contents before approval. Finding: the centre of `UMD 1F` hits the lake (site is inside the group) → `npm run levels` now probes a 3×3 grid per floor group and prints a summary of floor-like heights.
- 2026-11-02: **Week 2 step 2a written (bridge 0.3.0, not yet run on Windows).** Changing tools: `createPrism` (footprint polygon × height; rejects repeated points, zero area and **crossing edges** in both Zod and Ruby; verifies bounds and SketchUp's solid volume), `setTag`, `setTagVisibility` (never Untagged), `moveToReplaced` (hidden `zz_REPLACED by …` tag, never deletes). `npm run smoke:w2` checks them on a real model, including that hiding a tag really hides the object from `measure`. The bow-tie gap was found by the new check script itself before delivery. Verified here: 148 Vitest, 123 Ruby tests (83 shared argument cases), smoke 10/10, smoke:w2 9/9 on the mock.
- 2026-11-03: Created the project vault `Claude_Cowork/SketchUp Agent/` (Obsidian, separate from the main vault): a note per code/test/config file with real import links, 13 tool notes, concepts, test commands, plan and progress. **Rule: update it after every finished step.**
- 2026-11-11: **Week 2 step 2a verified on Windows** (commit 58f0eee, bridge 0.3.0). `smoke:w2` 9/9, `smoke` 10/10 on `UMD_DEV_1F_reception.skp` (file itself not saved). createPrism 7 ms, setTag 56 ms, setTagVisibility 1–2 ms, moveToReplaced 57 ms; Untagged hide refused by the bridge. Gaps: the bow-tie was stopped by Zod, so the Ruby crossing-edge check has not run in real SketchUp (add a raw-send step); `levels` gives an empty table with no hint when there are no `UMD nF` groups. Open, not blocking: `levels` on the MASTER, Ruby Console check. Next: 2b model summary + 2c instructions → operations (needs `instructions/1F_reception.md`).
- 2026-11-11: **Week 2 step 2b written (mock-tested, no Ruby change, bridge stays 0.3.0).** `npm run summary -- "<room>"` describes one room for the AI: each direct child gets a ref (R1, R2 …) mapped to its persistentId, its box in metres, its tag, visibility, and what it **really contains** (child names, repeats counted). A name that claims furniture while the contents are only plants/glass/lights is flagged (the real "Sofa set 4" case). Floor level comes from the confirmed levels. Read-only, so it runs on any model. Also: `smoke:w2` step 4b sends the bow-tie straight to the bridge (skipping Zod) so the Ruby check runs in real SketchUp; `levels` explains an empty result. New mock scene `reception` (a simplified copy of the T128 room). Verified here: typecheck, 169 Vitest, 123 Ruby, smoke 10/10, smoke:w2 10/10 on the mock. Brief 1 written: `instructions/1F_reception.md`.
- 2026-11-11: **2b run on Windows** (commit a8c1a36): `summary` on the real dev reception: 12 items, floor 1.489, the Sofa set 4 warning fired; 1 getModelInfo + 1 inspectEntity + 16 findEntities, all read-only, ~10.5 s. `smoke:w2` 10/10 and **4b confirmed in the bridge log** (Ruby refused the bow-tie). Fixed from the report: materials were cut twice without saying so and were mostly 3D Warehouse noise → now only `UMD …` design materials are listed and the rest counted; contents capped at 8 (+N more); walk two levels deep instead of three; prints time and size. 170 Vitest. Open: summary on the MASTER room (size/speed), `levels` on the real MASTER (twice hit `UMD_DEV_MASTER_test.skp` by mistake; 2 Nov levels still stand).
- 2026-11-11: **2b checked on the MASTER** (commit e9858aa): summary in 15.1 s, 6,197 characters (~1,550 tokens), bounds identical to the dev copy; only `UMD …` design materials listed (10). `levels` finally ran on the real MASTER (27 probes): confirms 1F 1.489 · 2F 5.479 · 3F 10.979 · roof 15.979, plus finish overlays 1.491–1.492 / 10.982–10.983 and a 2F roof slab at 10.704. Two bugs fixed: the contents limit under-counted repeats (115 downlights printed as 100 → limit 500 + a warning when a list is incomplete), and tags already named "(hidden)" printed it twice. The mock reception scene now has the 12 real items with their real boxes.
- 2026-11-11: **Week 2 step 2c written (mock-tested).** `npm run agent -- <brief> "<room>"`: summary (2b) → Ollama `qwen3:4b-instruct` answers with a **draft** in a fixed JSON shape (Ollama is given the JSON schema) → the code **resolves** it: refs → persistentIds, placements ("1.2 m east of R1, 3.0 along, 0.7 across", "on top of S1 with 0.05 overhang") → exact footprints, every call checked by the tool's own Zod schema, boxes compared with every visible item (overlap warnings), a save is required, nothing may come after it, saved names get the run id → **plan shown with each target's real contents** → you type `y` → actions run one by one, stop at the first failure → `runs/agent_<time>/` holds summary, the model's answers, draft, plan and report. Bad answers go back to the model with the exact problems (one retry). `--dry` plans only; `--draft file.json` runs a reviewed draft without the model; on the MASTER it plans only. The model never writes coordinates or tool calls. Reference answer for brief 1: `instructions/1F_reception.draft.json`. On the real positions it flags two things to check: the forest bench's box overlaps the lounge bay's box (R10), and the north entrance kerb overlaps the NE lounge (R11). Verified here: typecheck, 195 Vitest (23 new in agent.test.ts), 123 Ruby.
- 2026-11-11: **Windows run of 2c** (Windows now edits too: fix **543957a** by the Windows chat). (1) Ollama rejected the draft schema: zod 4 writes tuples as `prefixItems` + `items:false`, Ollama needs `items` as an object → `ollamaSafe()` in draft.ts rewrites them. (2) **`--draft` real run 15/15**: every size exact (counter 0.700×3.000×1.050, top 0.800×3.100×0.040, bench 0.500×6.000×0.450, kerbs 4.000×0.600×0.350), both materials created, Sofa set 4 hidden on the replaced tag, copy saved (74.4 MB, 4.9 s), checked independently with findEntities. (3) **`--dry` with qwen3:4b failed**: 70 s, 2 tries, zero build steps, every build put in notDone "needs coordinates", then a hide/screenshot/show loop to the 40-step cap, `line` used as a counter; the checker only reported "never saves a copy". (4) The 100× vs 115 downlights bug was real: the depth-2 walk let parts-of-parts use up the 500 limit (115 × 5 > 500).
- 2026-11-11: **Planner rework (Mac chat).** The model is now asked about **one numbered change at a time** (`brief.ts` reads the changes and the "(later)" items; `planner.ts` `planBrief`). Each answer is `{type: steps | rule | notPossible, steps, reason}`; the code adds the line number and renumbers build ids (keeping onTop links). Each answer is checked: not JSON / wrong shape, "steps" with no steps, a real change called a rule, **notPossible because of coordinates/camera** (rejected: the program computes those), repeated steps, and everything the resolver finds (unknown refs, onTop of nothing, bad sizes). All problems go back to the model; after 2 tries the change becomes NOT DONE with the reasons and the rest is still planned. Prompt rewritten ("you never need coordinates …"), one worked example. Resolver now also refuses repeated identical steps and hide/show loops. Screenshot frames the new shapes (job group) instead of the whole room. Summary counts direct parts only (exact up to 500), with a regression test that reproduces "100× downlight". Verified here: typecheck, 205 Vitest, smoke:mock 10/10, agent --draft on the mock 15/15. Open: Windows runs `agent --dry` with qwen3:4b; owner of the bigger-model trial: Windows.
- 2026-11-11 (evening): **Windows model comparison** (commit 2e5d229 + Windows fix **74d3483**: `think: false` in llm.ts, with a retry without it for models that can't think; qwen3:8b went from >300 s timeout to 31 s for 8 changes). qwen3:4b-instruct: 2 of 8 changes, 0 builds, wrong ops (replace on step ids), duplicate screenshots, Chinese mid-sentence, and a false pass (showTag accepted for "add a counter") → **not viable**. qwen3:8b: 7 of 8, all 5 builds with the right sizes; blocked only by our duplicate rule (a stray screenshot in change 1 made the correct one in change 8 "a duplicate", so the save was lost). One real model error: an entrance planter placed east of the east glass wall (outside).
- 2026-11-11 (evening): **Fixes (Mac):** duplicates now only for build/replace/save (screenshots and tag steps may repeat; runaway counts still refused). New per-change fit checks fed back to the model: sizes in metres but no build; screenshot/save/replace/tag steps the change didn't ask for; showing a tag that isn't hidden; non-English text; a new block outside the room (was only a warning). Prompt: a worked example of a PAIR placed with shift ±, "inside means facing into the room", "only steps this change asks for". **Default model is now qwen3:8b** (config.ts, .env.example). 212 Vitest.
- 2026-11-11 (night): **Windows `--dry` on qwen3:8b** (024c51c): all 8 changes planned in 31 s, no errors, but 3 of 6 builds wrong: (1) change 1 "take out Sofa set 4" also BUILT a box named after it, beside it; (2) the counter top was placed beside R5 on the floor instead of onTop S1 (a regression vs the 18:25 run); (3) the entrance planters had `along`/`across` swapped and shift ±0.9, so they overlapped. Real run not done.
- 2026-11-11 (night): **Fixes (Mac).** Placement sizes renamed to compass directions **`eastWest` / `northSouth`** (the brief speaks in directions; "along/across the side" was the main confusion; the resolver got simpler too). New checks fed back to the model: a build in a change that asks for nothing new; a block placed beside an item this plan takes out; "on the counter / a top" must use onTop; "X m long running west / (north-south)" must match the right size; two new blocks overlapping (was a warning). Prompt rewritten with 4 examples (single block, pair with shift, onTop, take-out only). **Benchmark:** `npm run bench -- <brief> "<room>" --runs 3 --models a,b` plans the brief N times per model (read-only) and scores each change against the reference draft (same operations, boxes to 1 cm) → `runs/bench_<time>/results.md`. 223 Vitest.
- 2026-11-11 (late): **First benchmark on Windows** (f6a38cd, 3 runs each, plans only). qwen3:8b 4.0/8, 3/3 runnable, 31 s; qwen2.5:7b-instruct 3.0/8, 0/3 runnable (counter 3 m deep, one planter, no save), 25 s; gpt-oss:20b failed (empty answer after 410 s: probably its thinking channel, and 14 GB on an 8 GB card) → dropped. Runs at temperature 0 were identical. **qwen3:8b stays.** Its remaining errors: change 3 (correct top, but emitted under change 2: a scoring artifact), the bench "along" the north-south Terrarium E built east-west (both models), planter shift ±0.9 ("1.8 m clear" read as centre to centre).
- 2026-11-12: **Fixes (Mac).** Benchmark scores by **content** (a change is right when all its operations appear anywhere in the plan; leftovers listed as "extra"), default 1 run. The summary now says **"runs north-south / east-west"** for long items; a build "along" an item must run the same way (checked + prompt example); "X m clear between them" is checked by measuring the real gap between the two blocks (+ prompt rule). 228 Vitest.
- 2026-11-12: **WEEK 2 DONE** (Windows, 5bec1d3). Windows planner fixes: checks for steps the model LEFT OUT (change 8 had passed with only the hideTag); the code now states the exact shift ("set shift to 1.2 on one and -1.2 on the other") and the inside face ("the inside of R12 faces west, so use side west", from the anchor's position against the room centre) instead of hints; a change already planned by the previous one is no longer NOT DONE. 235 Vitest. **Benchmark qwen3:8b, 3 runs: 8/8, 6/8, 6/8 (avg 6.7), 3/3 runnable, 39 s** (was 4.0/8, 0/3 runnable). Run 1's draft is step-for-step the reference; **built for real: 15/15**, saved `dev/UMD_DEV_1F_reception_brief1_20261112_054135.skp`, verified read-only with findEntities (every size exact, right tag, Sofa set 4 on the hidden replaced tag, dev model unsaved). Principle: **when the code can work the answer out, give the model the answer, not a hint.** Left for Week 3: runs 2–3 rotate the counter 90° when it migrates from change 2 to 3, because the "3.0 m long (north-south)" check reads the change text, not the block.
- 2026-11-12: **Week 3 part 1 written (Mac, mock-tested).** (a) The "X m long (north-south)" check now follows the BLOCK: when a change has no direction phrase, a block whose size matches a phrase elsewhere in the brief but in the other direction is reported as "turned 90°" with the exact fix (the counter built under change 3 in bench runs 2–3). (b) **`src/geometry/checks.ts`** (written by Claude at Htain's request): before running, each new block is checked against the **real parts** of the model (`findEntities` with `touches`, keeping only parts with no smaller parts inside; hidden parts, hidden tags and items the plan takes out are ignored; touching is fine). One predefined fix: slide the block along its wall until clear + 5 cm, max 3 tries, max 2 m; a top moves with its base. Unfixable → plan error, nothing runs. The old "outer boxes overlap" warnings are dropped when the real parts are clear. After running and **before saving**, a read-back: every block within 1 mm of its plan, taken-out items on their zz_REPLACED tag, nothing else in the room changed or appeared; if anything is off, the copy is NOT saved. Report gets a "Geometry checks" section. `instructions/test_collision.draft.json` puts a block on Sofa set 4's palm on purpose (mock: caught and moved 0.81 m west). 246 Vitest.
- 2026-11-12: **Windows test of the checks** (8871551). (A) Deliberate collision caught on the real model, named by real part ("parlor palm", "round rug"), moved 0.807 m west; ~16 s (two deep searches ~3.5 s each on the 74 MB model). (B) Brief 1 for real: 15/15, read-back clean (S1–S5 within 0.0 mm, R5 replaced not deleted, 11 items unchanged), saved; 79 s. **But the repair moved the north kerb alone 0.547 m south (olive armchairs), leaving 1.25 m instead of the brief's 1.8 m clear, and nothing flagged it.** Also bare numeric part names ("1069") in messages. (C) Bench 1 run: 8/8, 64 s (single run: the counter fix is unconfirmed). Components folder ready: `E:\Cowork_Field\Thesis_SketchUp\components`, 31 `3DW_*.skp` (80 KB–28 MB, no chandelier yet).
- 2026-11-12: **Fix (Mac):** blocks from the same brief change now slide **together** (keeps a pair's spacing); after any automatic move the brief's own rules are re-checked (`briefRules`, e.g. "X m clear between them") and a broken rule stops the plan with a reason; the y/n question says how many automatic moves changed the design; bare-number parts are named after their group ("olive armchair (3DW Pietra) part"). 249 Vitest.
- 2026-11-12: **Windows: pair move verified** (20c6a70): S4+S5 slid 0.547 m south together, clear gap exactly 1.800 m; built 15/15, read-back clean. Design note for Htain: the path now sits 0.547 m south of the entrance centre; whether shorter kerbs that stay centred would be better is a human call (the y/n warning surfaces it). **Benchmark artifact found by Windows:** in 3 separate benches, run 1 (cold, slowest) always scored 8/8 and runs 2–3 (warm, identical, faster) 5–6/8. Likely Ollama's prompt (KV) cache changing the floating-point path even at temperature 0, so "8b averages 6/8" may be wrong.
- 2026-11-12: **Fix (Mac):** `ollamaUnload()` (llm.ts, `keep_alive: 0`); `npm run bench` unloads the model before every run (`--warm` to keep it), and `npm run agent` starts cold too, so the agent plans under the same condition the benchmark measures. New `tests/mock/llm.test.ts` with a tiny fake Ollama (JSON format, temperature 0, think:false, the think retry from 74d3483, empty answer, 404 hint, unload). 255 Vitest.
- 2026-11-12: **Cold runs confirmed** (Windows, 1d9eb46): cold 8/8, 8/8, 8/8 (3/3 runnable, 56 s); warm 5/8 ×3 (0/3 runnable, 37 s), even the warm bench's run 1. qwen3:8b is a reliable 8/8 on brief 1; some of the 2026-11-11 prompt tuning chased the artifact. The earlier model comparison was measured warm. `results.md` now records cold/warm.
- 2026-11-12: **Week 3 part 2: real components (bridge 0.4.0, mock-tested).** Ruby `component_tools.rb`: `listComponents` (read: the folder `<queue's parent>/components`, no loader change), `componentInfo` (loads a file for a moment, measures it, removes it again), `placeComponent` (min corner at `at`, rotation 0/90/180/270, inside the job group, measured to 1 mm). One folder only, plain names, 50 MB limit (refused before loading). TS: schemas + 15 shared argument cases, mock folder, `catalog.ts` (sizes cached in `runs/components.json`, only new/changed files measured, MASTER uses the cache only, `--mock` has its own cache), `npm run components`. Planner: a `place` step (anchor/side/gap/shift/rotation; size from the catalog, never from the model), COMPONENTS list in each question, checks (a change asking for a component must place one, not draw a box; none where not asked). Resolver, collision checks, repairs, read-back and the benchmark treat placed components like blocks. Test brief 2: `instructions/1F_reception_plants.md` (money tree, marble coffee table, tag, screenshot, save). 285 Vitest, Ruby 146 (4 suites), smoke 10/10, smoke:w2 10/10, brief 1 still 15/15 on the mock.
