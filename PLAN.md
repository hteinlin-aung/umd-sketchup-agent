# UMD SketchUp Agent — PLAN

*Created 2026-10-29 · Deadline 2026-11-26 (4 weeks) · Status: **Week 1 DONE 2026-10-29** · **Week 2 DONE 2026-11-12** (brief → qwen3:8b plan → approval → built and saved, 15/15) · **Week 3 DONE 2026-11-14** (whole-model checks, components, scenes, clear outcomes) · Week 4 next*

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

### Week 3 (Nov 12 – Nov 18): checks, fixes, more tools — ✅ DONE 2026-11-14
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
- **Split from 2026-11-13 (agreed with Htain):** work that needs the real model (geometry checks, tools, briefs,
  anything that must be tested in SketchUp) is owned by the **Windows chat**: it writes, tests and reports. The
  **Mac chat** reviews reports, decides design questions, keeps PLAN/vault/TASKS current, writes the handoff for
  Windows, and does only code that is fully testable on the mock (planner text rules, README, reports).

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
- 2026-11-12: **placeComponent verified on Windows** (69f5bc8, bridge 0.4.0). smoke 10/10, smoke:w2 10/10. Catalog: 31 components measured in 36 s, none unusable; measuring left nothing behind (plants copy +3.92 MB over the smoke copy = exactly the two placed components). Plants brief: qwen3:8b picked `3DW_money_tree_Pachira_VitorB_86654.skp` and `3DW_coffee_table_marble_round.skp` from the catalog by itself; 4/4 ok, read-back 0.1 / 0.4 mm, nothing else changed, both upright. **Problem:** the "coffee table" file is 3.96 × 3.92 × 2.64 m (mis-scaled 3D Warehouse model) and nothing objected; also easel 2.93 × 3.60, zen gardens 54.75 m and 16.3 m long, banyan 24 × 24 × 15 m. Note: close and reopen the dev model between test suites so each saved copy has only its own work.
- 2026-11-12: **Fix (Mac):** `plausibility()` in catalog.ts compares each component's size with what its name says (coffee table, table, chair, sofa/bench, easel, mat, basin, lamp, pot plant, zen garden/rocks; anything over 12 m across). A mis-scaled component is marked "DO NOT USE: looks wrong" in the list the model sees, refused by the resolver with the reason, and listed by `npm run components` with how to fix it. A component that would go through the ceiling is refused. Plan lines show each component's height against a door (2.1 m). 297 Vitest.
- 2026-11-12: **Component workflow agreed with Htain.** 3D Warehouse has no public API, downloads need a sign-in and its terms forbid scraping, so the agent will never download by itself: it will search the web and show candidates (Week 4), Htain clicks Download into `components/`, the agent takes over. Wanted: scale that fits the room, "which one do you like?" before placing, and some interior-designer sense (style from the brief; vision tagging later; the designer decides).
- 2026-11-12: **Scale-to-fit and choosing (bridge 0.5.0, mock-tested).** `fitComponent()` in catalog.ts replaces "refuse mis-scaled files": each kind of piece has a usual range for one measurement (coffee table 0.30–0.55 m high → 0.42; table, chair, sofa, bench, easel, mat, basin, lamp, pot plant, zen garden/rocks, indoor tree), a size outside it is brought to a typical value with **one uniform scale** (nothing squashed; the file is never changed); a size the brief gives wins (`place.size`); always fits under the ceiling; only an unknown kind over 12 m with no size is refused. The model sees every piece at its placed size. `placeComponent` takes `scale` (0.01–100). New read tool `componentPreview` (PNG of a component FILE via `Sketchup.save_thumbnail`, into `agent_queue/images/previews/`). New `choose.ts`: for every placed component, the agent's pick plus up to 2 of the same kind, each with preview and placed size; the designer picks (Enter keeps the agent's pick); choices go to `choices.json` and the report. New `cli/terminal.ts`: questions that also work with piped answers (readline dropped early lines). 312 Vitest, Ruby 153.
- 2026-11-12/13: **Windows: choosing and scale-to-fit tested on the real model** (edec545 + Windows fix **7d90c7c**: typed answers were not echoed, so Htain answered blind; Windows also lifted too-SMALL pieces only to the bottom of their range, excluded "yoga mats basket" from the mat rule, and relabelled the list). Fittonia placed at ×1.5 → 0.436 × 0.399 × 0.150 m, coffee table at ×0.1593 → 0.63 × 0.62 × 0.42 m, read-back 0.6 / 0.3 mm. Found: a picked component kept the model's name ("Money tree" holding a fittonia); a second definition "…#1" was loaded beside the one already in the model; the tree rule shrank the genuine 15 m banyan (and a scanned trunk) to 2.8 m; the Finkong zen garden scaled to 3.00 × 0.31 × 0.08 m; the easel slipped through (right height, 3.6 m wide).
- 2026-11-13: **Fixes (Mac, bridge 0.5.1).** A different pick renames the step from the file ("Fittonia"), recorded in choices and the report. Ruby `load_definition` reuses the definition already in the model (same component ID, or same name without "#1" and same size to 1 mm) instead of adding a copy. No rule for trees any more (the ceiling limit stops anything impossible; a brief can give the size). Kinds with a known width (coffee table, table, chair, sofa, bench, easel, pot plant) are refused when the right height comes with an impossible width: no single scale can fix wrong proportions. A uniform scale that leaves the piece under 10 cm thick (except flat things like mats) is refused as "probably a whole scene". `npm run components` separates RESIZED WHEN PLACED from CAN'T BE PLACED. Test comment corrected (the cause was the missing echo, not a paste). 327 Vitest, Ruby 157.
- 2026-11-13: **Windows check of 0.5.1** (835ce07): easel and Finkong zen garden refused with clear reasons, the root scans left alone, a different pick renamed ("Money tree" -> "Fittonia"). **Correction:** the "#1" was never a duplicate: `3DW Fittonia (Sasha Alonso)#1` is the real name of the definition already in the model (13 fi-plant copies in the terrariums), so the placement was reusing it all along; the reuse code stays as a safeguard. Open: the real 24 m banyan is now refused ("give its size in the brief").
- 2026-11-13: **Your "right as drawn" list.** `instructions/components_as_drawn.txt` (one file name per line, # for notes): files listed there keep their real size, with no rule from the name, no 12 m limit and no "whole scene" check; only the ceiling limit still applies. Read fresh on every run (not cached), only by the real commands (`agent`, `components`, `bench`), never on `--mock`. `npm run components` shows them as RIGHT AS DRAWN and points to the list from CAN'T BE PLACED. Starts with the banyan. 330 Vitest.
- 2026-11-13: **Verified on Windows** (078a07e): the banyan shows as RIGHT AS DRAWN; only the easel and the Finkong zen garden are refused (wrong files). Week 3 component work done; next: `addScene`.
- 2026-11-13: **`addScene` (bridge 0.6.0), saved camera views for D5.** New write tool: a scene with a camera (eye, target, field of view; up is always z, so walls stay vertical). It remembers which tags are visible at that moment; your own view comes back afterwards; an existing scene is never changed (a taken name gets " (2)"); the camera is read back. Agent: new step `{"op":"scene","name","from","toward"?,"eyeHeight"}`: `from` = a side or corner of the room ("south", "northwest"), an item ref ("R12" = just inside the entrance, on the room's side) or "above" (whole room from the south-east); it looks level at the middle of the room or at `toward`. The code places the camera 0.6 m in from the side and warns if it stands inside an item's box. Planner: "save a scene" is a scene, not a file save; a scene only when the change asks for one; eye height in metres is not a build. Test brief: `instructions/1F_reception_views.md` (arriving, seated, overview, save). 353 Vitest, Ruby + `scene_tools_test.rb` (6).
- 2026-11-13: **Windows check of `addScene`** (06a09e4): first run made 1 of 3 scenes: qwen3:8b wrote `"north-west"` (as the brief does) and `"toward": ""`. Windows fixed it in the planner (`tidyScenes()`, 10b9b26: compass words without hyphens/spaces, empty `toward` dropped, refs upper-cased; schema not loosened). Second run: all 4 changes in 10 s, 3 scenes, saved copy has them, no Scenes-and-Styles popup, your camera restored.
- 2026-11-13: **Blocked views.** Windows noticed the "seated" view of Terrarium A looks straight through Terrarium E. A scene that looks `toward` an item now checks the line of sight at eye height against every item's box (and new blocks) and warns "the view of R1 is blocked by R8 ...", listing the sides of the room with a clear view. Boxes only, so it is a warning, not an error. 365 Vitest.
- 2026-11-13: **Windows: scenes in the meditation suite (brief 4, 7021630 + 1416da9).** Sides that would put the camera inside something are no longer "clear"; a side of the room toward a big target (both sides >= 4 m) lines the camera up with the target's middle, still on the room's edge (meditation view fixed: it stood in the corridor). `from above` warns when a floor or ceiling covers the room. 375 Vitest. Decided (Mac): keep the room's side (a brief that means an area must name it); no fix for the far overview before the deadline (needs a section cut); corners left as they are.
- 2026-11-13: **Brief 5 written: `instructions/1F_meditation_build.md`** (the threshold in T133). The first build in a room other than the reception: a shoe-off bench against the breathing room's east wall, a shoe shelf against the meditation room's west wall, a potted plant (component), tag, material, screenshot, save. Everything sits in the corridor, so the raised tatami floors don't matter. Not run yet: Windows checks the door positions first. Found: the planner can only place things beside or on top of an item, not "inside a room, against its wall" (needed for cushions on the tatami); noted as later.
- 2026-11-13: **Windows: brief 5 not built; the brief and the collision check were both wrong** (plan-only run with a reference draft). The space between the rooms is an open courtyard void with guards; the real link is a walkway south of the room box; a timber screen (B2) stands just east of the breathing room; a water deck lies west of the meditation room; the rooms are raised platforms (~0.55 m above 1F); genkan shoe shelves (G2) already exist at the north entries from the hallway. The planned bench cut 5 screen slats and the shelf sat in the water deck, yet the check said "nothing hit". **Causes:** (a) `findCollisions` only searched inside the room group, and in T133 most parts are in other groups: OPEN, needs a decision (a whole-model search would hit raw-face groups like Group#276 whose one box covers the whole breathing room); (b) a whole-model search hit the 30,000 scan limit and was read as "nothing there": FIXED by Windows in 4ddeb9c (bridge 0.6.1: groups that miss the search box are not opened, 269 groups instead of 30,000; a partial search now throws). Also found: "standing on the floor" buries things 0.5 m in raised rooms; the Windows chat can't reach Ollama and has a 45 s limit per command, so full agent runs must start in PowerShell on the PC. Ruby 171, Vitest 376.
- 2026-11-13: **New split agreed:** Windows owns model-dependent work (starting with the collision-check scope fix and the brief 5 rewrite); the Mac reviews, decides and keeps the docs. See §10.
- 2026-11-13: **Windows: the collision check now sees the whole model, and shells are checked face by face (bridge 0.7.0).** Decided by the Mac, built and tested on Windows. `findCollisions` searches the whole model near the new block instead of only inside the room group. A leaf whose footprint is at least 20 m² and at least 10× the block's is a **shell** (raw geometry like `Group#276`, whose one box covers the whole breathing room, or the 1F floor plate), not a part: its box is ignored and the new tool **`facesInBox`** returns the boxes of its faces near the block. A face is only "cut" when the block crosses its plane (on a face's flat axis the boxes can never overlap by 1 cm), so standing on a floor face or setting a bench against a wall face is not a collision. Anything that cannot be read fully — a group holding more than 20,000 things, more faces than the limit, over 5 s, or a `findEntities` scan limit — is an error saying it was NOT checked, never "clear". The slide repair still only acts on real hits. Verified on the real models: brief 5's bench is now caught cutting 5 `B2` screen slats *and* the wall plane, the shelf is caught inside the landscape platform, each shell answers in about 1 s; reception brief 1 still plans 15 actions with the same single repair as on 2026-11-12 (S4+S5 0.547 m south), so no new false hits. Ruby 183, Vitest 390, typecheck clean.
- 2026-11-13: **Only ONE SketchUp window at a time.** With the meditation and reception models open together, both instances ran a bridge and answered commands in turn from the same queue, so the agent read one model and inspected the other ("room not found"). Found on Windows while testing the above.
- 2026-11-13: **Windows: brief 5 rewritten for the real space, and it builds (`instructions/1F_meditation_build.md`).** Measured first: both rooms are entered from the hallway on their NORTH side, and each entry already has a genkan standing on the 1F floor (1.489) - a low shoe-off stone `G1` and a 0.35 m deep, 0.80 m high shoe shelf `G2`. They are in another group, so they are not in the room summary and cannot be anchors; the brief therefore measures from the `BREATHING ROOM` and the `MEDITATION ROOM`. The brief is now two light oak genkan benches (2.0 x 0.35 x 0.45 m) on the hallway floor beside each shoe-off stone, plus tag, material, screenshot and save. Nothing on the raised tatami floors, nothing in the courtyard void. Run on Windows with the reference draft: both built, painted, read-back exact (0.0 mm), no collisions, copy saved (`UMD_DEV_1F_meditation_build_20261113_154536.skp`); eye-level captures show both benches sitting correctly beside the stone and shelf. Reference answer: `instructions/1F_meditation_build.draft.json`. The two benches warn "it reaches outside the room's box", which is right - the genkan is in the hallway.
- 2026-11-13: **The iso screenshot of a job group outside the room shows roofs** (same framing problem as the `from above` scene): the brief 5 screenshot was useless, and the result had to be checked with eye-level scenes instead. Not fixed.
- 2026-11-13: **A long agent run cannot be started from the Windows chat.** Even with `setsid nohup`, the process is killed when the chat's shell command returns, so SketchUp finishes the work but the run's `report.md` is never written (the plan, draft and summary are). Full runs must be started in PowerShell on the PC.
- 2026-11-13: **Brief 5 AI run (Tyson, PowerShell, run 230100): qwen3:8b planned both genkan benches exactly like the reference draft, and the planner's own check rejected them.** The "outside the room" rule treats the anchor as a wall and tells the model which face points into the room. A whole room inside the room group has no such face: for the breathing room it said `use side "north"` (the model already had), for the meditation room `use side "south"` - into the raised tatami - and the model's retry obeyed. Fixed (Windows): an item at least 4 m both ways (an area) gets no "inside face" hint, and a block outside the room is accepted when the change itself says "<n> m <side> of `<that item>`" with the same side - the plan still shows the warning "it reaches outside the room's box". The name must be the start of the item's real name, so a wall's name can't pass for a side ("EAST GLASS WALL" still gets `use side "west"`). Replayed offline with the model's real answers and the real T133 summary: both benches accepted, the "south" retry still rejected without the wrong hint. Vitest 393.
- 2026-11-13: **Brief 5 DONE: first full AI build in a room other than the reception** (Tyson, PowerShell, run 231558, after 56cedea). qwen3:8b planned all 5 changes in 15 s, each change on the first try; the plan equals the reference draft exactly (S1 x 29..31, S2 x 48.08..50.08). The whole-model collision check found nothing; both benches built 2.000 x 0.350 x 0.450 m, painted, read-back 0.0 mm, nothing else changed; copy saved (`UMD_DEV_1F_meditation_build_20261113_231558.skp`), report written. Still open: the iso screenshot frames roofs, not the new blocks.
- 2026-11-13: **Mac decision: roofs in screenshots.** No section-cut tool before the deadline. The screenshot after a build becomes an eye-level view from inside the room, aimed at the new pieces (reusing the scene camera and its blocked-view check); the iso view is dropped from runs. `from above` keeps its warning. A section cut is postponed (§9). Windows owns it; then the deliberately-wrong test (Week 3 done-when).
- 2026-11-13: **Windows: the screenshot after a build is an eye-level view of the new pieces (bridge 0.7.1); the iso view is gone from runs.** As decided by the Mac. New pieces closer than 4 m share one picture, so a screenshot step can take several (brief 1: counter+top, forest bench, entrance kerbs = 3; brief 5: one per bench). Each group gets four standpoints at eye level, at least 3 m out and far enough to fit the group: in front of its long face before its ends, the side toward the room's middle first, and the summary's box check (camera not inside another item, nothing in between) moves bad ones to the back. Before the plan is shown, the **real model** checks them in that order with two `measure` rays: straight down (the first surface must be the floor the pieces stand on - not a raised platform, a table or a void) and from the eye's spot at the pieces' own height toward them (nothing before their near face). The first that passes is used, and GEOMETRY CHECKS says which side and why the others failed; if none passes, the plan warns that the picture may show what is in the way. `captureView` takes a `camera` (eye, target, fov), so no scene tab is added to the model. The benchmark counts one screenshot step as one operation however many pictures it takes. Tested on Windows with brief 5 (`--draft`, run 164307): both pictures taken from the hallway north of each bench, both benches clearly in view with the shoe-off stone, steps and shelf around them; read-back exact, copy saved, report written. Ruby 190, Vitest 409.
- 2026-11-13: **Correction: `--draft` runs DO work from the Windows chat** when they run in the foreground of one shell command (up to 3 minutes; brief 5 took about 70 s with the save, and its report.md was written). Earlier runs failed only because they were started in the background. Runs that ask the language model still need PowerShell: the Windows chat's shell can't reach Ollama.
- 2026-11-13: **Windows: Week 3 "done when" test passes on the real model - test brief 6 (`instructions/1F_reception_wrong.md`) and a clear outcome in every report.** Every run now ends with ONE outcome, first thing in report.md and on screen: **SUCCESS** (all ran, read-back clean, saved; automatic moves you approved are listed), **BLOCKED** (the plan had a problem the code can't fix, you stopped it, a step failed, or the read-back failed - nothing saved), **MAX_ATTEMPTS_REACHED** (the repair moved a block on all 3 tries and it still collides, or the model couldn't plan a change in its tries; then the rest ran), or NOT RUN (`--dry`). Test brief 6 puts change 1, a travertine plinth, on purpose on a real D500 column (x 93.89..94.39, y 99.49..99.99) and change 2, a window bench, in open floor. On the full 1F dev copy: the reference draft is caught on the column, slid 0.867 m north, the bench untouched, run and saved - **SUCCESS** (run 165406; the eye-level picture shows the plinth just clear of the column). The `.blocked` draft (the same plinth 6.0 m long, through two columns) - **BLOCKED**, both columns named, nothing ran (run 165341). MAX_ATTEMPTS_REACHED is tested on the mock (a block bouncing between two bars for 3 tries). Vitest 424.
- 2026-11-13: **`UMD_DEV_1F_reception.skp` holds only the reception room group - no columns, walls or floor.** Found when test brief 6's "blocked" plinth was built through thin air and reported SUCCESS (run 164919; that dev copy was saved, nothing else). The collision check can't hit a building that isn't in the file, so the agent now probes straight down at four points under the room: with no floor at the floor level, GEOMETRY CHECKS warns that walls and columns could NOT be checked, the outcome lists "NOT CHECKED", and the picture standpoints are checked only for things in between. Tests that need the building (like test brief 6) run on the full 1F copy (`UMD_DEV_1F_meditation.skp`).
- 2026-11-14: **Week 3 DONE (Mac review of 1a794bc).** Done-when passed on the real 1F copy: SUCCESS (plinth slid off a column) and BLOCKED (6 m plinth through two columns), outcome at the top of report.md; screenshots eye-level and checked with rays. Note: `UMD_DEV_1F_reception.skp` has no building in it; collision tests need the full 1F copy. **Week 4 order (agreed by Mac):** Mac rewrites README now; Htain makes 2F and 3F dev copies; Windows reads a 2F room summary and writes + runs a real thesis brief there, then 3F; one timed run on a full copy of the MASTER; feature freeze 2026-11-19, then only bugs and thesis rooms. `cutOpening`/section cut postponed; floor height for raised rooms only if a thesis brief needs it.
- 2026-11-14: **Windows: 2F and 3F dev copies checked, and the first 2F build (test brief 7, `instructions/2F_pool_build.md`).** Htain made `dev/UMD_DEV_2F.skp` (135 MB) and `dev/UMD_DEV_3F.skp` (228 MB) from the MASTER with Paste In Place: each floor shell (`UMD 2F` / `UMD 3F`) holds its own floor plate, walls, columns, ceilings and glass, and the thesis rooms are separate top-level groups copied with it (2F: both lobby versions, pool area, foot massage, plus `VOID_GARDEN_MASTER`). Checked on the 2F copy: same coordinates as the MASTER, the 2F floor (5.479) found by rays under every room probed. **Bug found and fixed:** the floor level came from a "1F/2F/3F" word in the room's name, and `NEW_2F_Pool_Area...` didn't match (the underscore) - so the pool room's floor became the bottom of the pool basin (4.279), 1.2 m down; `LOBBY_WAITING (T138)` has no floor in its name at all. Now an underscore counts as a gap, and a room with no floor in its name takes the confirmed finish floor that lies within its height. **Brief 7** (the pool room, 2F "Releasing"): a towel station - a light oak robe bench on the floor plus a towel shelf on the north wall above it (underside 1.5 m, flush against the wall face) - in the one free corner. Measured first: the room's spa loungers, side tables and olive trees are items 50-64 of 70, past the summary's 40, so the planner can't see them but the collision check does; the first two ideas were moved (one left only 0.6 m of wet floor at the pool edge, the other hit a lounger). `--draft` run 181912: both built where measured, read-back exact, nothing else changed - **SUCCESS**; the eye-level picture shows the bench and shelf with the loungers beside them. Vitest 430. Next: Tyson's AI run of brief 7 (it is the first brief with a raised piece, `base` 1.5), then 3F.
- 2026-11-14: **Brief 7 AI run (Tyson, PowerShell, run 012351): every change failed, and the evidence was lost.** Changes 1-2 ended with the generic "S1 ends up outside the room: check side and shift"; changes 3-5 (tags, materials, check it) then failed because the model kept trying to build the bench there (a cascade). The error said "see the answers in the run folder", but it was thrown before model_answers.json was written, so the cause can't be read. Fixed (Windows): the planner keeps the checker's reply to every try next to each answer, and when nothing at all can be planned it throws `NothingPlannedError` carrying them; the run saves model_answers.json and outcomes.json and still writes report.md with the outcome **MAX_ATTEMPTS_REACHED**. Not yet known: why change 1 failed. The generic hint means the last try's anchor had no "inside face" (an area such as the floor finish R1 or the 4.26 x 9.3 m coping R2, or a square item such as a downlight), not the north wall R20 the brief names. To be found from the rerun's answers, not guessed. Vitest 431.
- 2026-11-14: **Brief 7 AI failure found (rerun 013138 kept the answers): the checker's own example misled the model.** On try 1 qwen3:8b answered changes 1-2 exactly like the reference draft except the anchor: it wrote the wall's NAME, `WALL_LimePlaster_North`, instead of `R20` (on 2F the names look like identifiers). The checker replied `anchor: an item ref from the summary, like "R1"`, and on try 2 the model wrote `R1` - the floor finish - which put the bench outside the room. Changes 3-5 then failed because the model kept rebuilding the bench in them. Fixed (Windows): a name where a ref belongs is turned into the ref when it is exactly one item's name or the start of exactly one (the code can work it out, so it does); a name that fits several items, or none, gets a reply listing the candidates; the ref message no longer contains an example ref. Replayed with the run's real answers: changes 1 and 2 accepted on try 1 with anchor R20, the "R1" retry still refused. Seen in the replay, not fixed: a build answer to a "Tags." change is accepted when nothing is built yet (its text says "new"); in a real run the duplicate check catches it. Vitest 434.
- 2026-11-14: **Brief 7 AI run 013801: the bench planned right; the shelf failed on `base`, and again the checker pointed the wrong way.** qwen3:8b left "base" out of the towel shelf (every example in the prompt has base 0), so the shelf stood on the floor inside the bench; the reply "S2 overlaps S1: check eastWest/northSouth and shift" named the wrong fields and the model re-sent the same answer. Changes 3-5 then went astray (a second bench, then empty answers, even for "Check it"), as in the earlier runs after a failed change. Fixed (Windows): when a change names one height "N m above the floor" and a block placed beside an item has a different base, the reply gives the value: `set "base": 1.5`; the overlap reply also names base. Replayed with the run's real answer: one exact reply, and with base 1.5 the shelf is accepted. For the Mac (planner prompt, not changed): no prompt example has base above 0, and after one failed change the later changes tend to fail too. Vitest 435.
- 2026-11-14: **Brief 7 AI run 014222: told `set "base": 1.5`, qwen3:8b sent the identical shelf answer again, without base.** The schema has base (optional); the model writes other optional fields (material) but never one it has not seen used, and every prompt example has base 0. Fixed (Windows): when a change names exactly one "N m above the floor" and a block placed beside an item leaves base OUT, the code fills in N (it knows the value, like the name-to-ref fix); a base the model did write but different still gets the reply. Not done: making base required in the schema (it would change every answer and the benchmark - the Mac's call). Replayed with the run's real answer: shelf accepted, base 1.5. Vitest 435.
- 2026-11-14: **Brief 7 AI run 014643 (Tyson, PowerShell): first AI build on 2F, built right; outcome MAX_ATTEMPTS_REACHED only for a label.** qwen3:8b planned the robe bench and the towel shelf exactly like the reference draft (the name became R20, the missing base was filled in as 1.5); both built, painted, read-back 0.0 mm, nothing else changed, copy saved, picture taken. Change 4 (Materials, a rule) failed: on try 1 the model repeated the bench (refused), on try 2 it answered "steps" with no steps and the reason "No new items to add" - the meaning of a rule, refused for the label. The material was applied anyway (it travels with each block). Fixed (Windows): "steps" with no steps, for a change that neither asks for an action (add/build/hide/replace/save/screenshot/scene) nor for something new (sizes in metres, add/new/build/top/place), counts as a rule. Brief 1's "Forest bench. A built-in ... bench, 6.0 m long" still needs its build (the old test caught a first, too-loose version). Replayed with the run's real answers: change 4 accepted as a rule, so this run would end SUCCESS. Seen in all four brief-7 runs: for a rule change (Tags, Materials) the model's first answer repeats the last build; the duplicate check catches it, but it costs a try. Vitest 436.
- 2026-11-14: **Windows: 3F copy checked; first 3F build (test brief 8, `instructions/3F_rest_window_benches.md`); and a 3F limit for the Mac.** `dev/UMD_DEV_3F.skp` is right: `UMD 3F` brings its floor (10.979 everywhere probed), walls and columns, plus the T124 interior and the void garden. **Limit found:** both 3F room groups are organised by TRADE, not by room - in `3F THERAPY + PSYCHIATRIST INTERIOR (T124)` every summary item spans the whole 29 x 25 m floor (all doors, all floor finishes, all furniture, all partitions), and "Therapy 1" or "Psychiatrist 2" exist only as words inside them, so the planner cannot say "in Psychiatrist 1": there is no item to measure from. The rest area (T123) is the same apart from its walls. **Decision for the Mac:** how the summary should present a room organised by trade (e.g. virtual sub-rooms from name prefixes like "Therapy 1 ...", or one level deeper for such groups). **Brief 8** therefore uses the one wall-like item, the rest area's north garden glass (R10): two 1.0 m light oak window benches in the only two free gaps along the glass, one each side of a low planted nook (measured first; corner screening rooms, lounge seating and the nook take the rest). `--draft` run 185926: both built where measured, read-back exact, nothing else changed - **SUCCESS**; both benches clear in their pictures. The east bench's view check found every side blocked (the camera spot touches a low piece of lounge furniture, 3 cm out at bench height) and warned, though at eye height the picture is clear: the bench-height ray is strict next to low furniture. Next: Tyson's AI run of brief 8.
- 2026-11-14: **Brief 8 AI run 020530 (Tyson, PowerShell): the west bench planned and built right; the east bench refused for a phrase.** qwen3:8b answered change 2 exactly like the reference draft (beside R10, south, gap 0.1, shift +4.05), twice; the checker refused it as "change 2 puts it ON an earlier block: use onTop", because the brief says "the same bench on the other side of the nook" and the "on something" rule read "on the other" as "on top of the other". Changes 3-5 were planned right first time (rule, rule, 2 steps). Fixed (Windows): "on the <word> side" is a side, never "on top of"; "on the counter" still is. Replayed with the run's real answers and the real 3F summary: both benches accepted, so the run would end SUCCESS. Vitest 437. Across briefs 7 and 8 (six AI runs), every refusal of a correct answer came from the checker's wording rules or replies, not from the model's geometry.
- 2026-11-14: **Brief 8 AI rerun (Tyson, PowerShell, run 021233, after 8c4487a): SUCCESS - the first full AI build on 3F.** qwen3:8b planned all 5 changes on the first try (59 s; change 1 took 40 s because the model starts cold), the plan equals the reference draft exactly (S1 x 35.49..36.49, S2 x 42.689..43.689); no collisions, both benches built and painted, read-back 0.0 mm, nothing else changed, copy saved, two pictures. Week 4 status: AI builds now succeed on 1F (brief 5), 2F (brief 7, after the checker fixes) and 3F (brief 8). Open: the T124 "organised by trade" decision (Mac), the timed run on a full MASTER copy, and a strict bench-height view ray next to low furniture.
- 2026-11-14: **README rewritten (Mac)** for Week 4: a normal run step by step, outcomes, the run folder, how to write a brief (run the summary first; what the planner understands; tips), components and the as-drawn list, safety rules, all commands, the 19 tools (bridge 0.7.0), troubleshooting, one-time setup, adding a tool. Windows: check the commands and paths on the PC and fix anything wrong.
- 2026-11-14: **Mac decision: rooms organised by trade (T124, T123).** (1) **Summary:** when every item of a room group spans nearly the whole group, look one level in and group the named parts by their room label ("Therapy 1", "Psychiatrist 2"). Each label becomes a sub-room item (ref like `V1`, marked "sub-room, from names"); its box is that room's floor-finish part if there is one (the real footprint), otherwise the union of its parts. Its parts (doors, furniture, partitions) are listed under it as normal items, so they can be anchors. Sub-rooms can be measured from but never replaced or moved. (2) **Planner:** a new placement `inside` = against one side of a room or sub-room, the gap measured inward (needed anyway: "beside" a room puts things outside it; this also unlocks the tatami cushions once floors are known). Windows owns both (needs the real 3F data). **Time box:** done by the 2026-11-19 freeze, or dropped and T124 briefs stay at what works. Still open: the timed run on a full MASTER copy (Tyson, soon: a copy named `UMD_DEV_...` so target.txt allows it).
- 2026-11-14: **Windows: the timed run on a full MASTER copy - SUCCESS in 86.5 s, after two fixes (bridge 0.7.2).** Copy: `dev/UMD_DEV_FULL_copy.skp`, byte-identical to the MASTER (600.8 MB; NOT named "...MASTER...": the bridge refuses every change and picture when the file name contains "master", so `UMD_DEV_MASTER_copy.skp` would have blocked everything). Brief 5 with its reference draft (`--draft`, run 212158), final timings: reading the room 4.0 s, components 0.3 s (cached), collision + view checks 4.5 s, build + paint of 2 benches 3.3 s, picture 1 11.1 s, picture 2 11.0 s, read-back 5.8 s, saving the 600 MB copy 45.4 s. **Found on the way:** (1) the first try's picture took **341 s** (client timeout 120 s): shadows are on in the MASTER, and SketchUp works them out for the whole model, floors above included. `captureView` now takes its picture without shadows, and does NOT switch them back on: doing that made SketchUp redraw the live view with shadows and froze it for ~2 minutes, so the next command was cancelled (second try). The open dev model and its saved copy are left with shadows off, and the run says so (MASTER untouched; scenes keep their own shadow settings; D5 has its own sun). (2) A command timeout during a run ended with a bare error and no report; it now ends **BLOCKED** with report.md. (3) Tool warnings on a successful action ("shadows ... now OFF") now appear in the run's result line and report. Ruby 192, Vitest 437. Conclusion: the full model is usable; one picture costs ~11 s and the save ~45 s, so a typical brief runs in 1.5-2 minutes.
- 2026-11-14: **Htain's decisions (Mac chat).** (1) The T124 work (sub-rooms from names + the `inside` placement) is **kept, not droppable**: if it is not done by Nov 19 it continues, ahead of other extras. (2) Wanted: a friendlier interface that shows the process openly. Mac proposal (waiting for Htain's yes): a small local web page on top of the same run files (brief + room picker, live steps, y/n and component choice as buttons, pictures, outcome); the command line stays; built on the Mac against the mock, started after the core is stable; `src/cli/agent.ts` gets ONE owner while the run steps are made reportable.
- 2026-11-14: **Interface decided (Htain): a panel inside SketchUp, with the web page as the base.** One page, two places: the Node app serves a small local page (`npm run ui`, localhost only, plain HTML/JS, no new packages) showing brief + room picker, live steps (summary, the AI's answer per change, checks, each tool call and result), Yes/No buttons, component choice by picture, screenshots and the outcome. The same page opens in a browser AND inside SketchUp through a `UI::HtmlDialog` pointed at that address (menu: Extensions > UMD Bridge > Agent panel). Order: (1) Mac builds page + server against the mock; (2) Windows adds the HtmlDialog menu item and tests it in real SketchUp (to verify: the panel stays responsive while a tool runs; what it shows when the server is not started). If (2) gives trouble, the browser page alone is the fallback. `src/cli/agent.ts` needs its run steps made reportable: ONE owner at a time, agreed in the handoff. T124 sub-rooms + `inside` stay ON (not droppable), ahead of the interface.
- 2026-11-14: **Windows: T124 sub-rooms from names + the `inside` placement - done; brief 9 SUCCESS (`--draft`).** (1) **Summary** (`src/summary/subRooms.ts`): a room label is the text before " - " in a part name that starts parts in at least two different items (longer ones, "Therapy 1 feature wall (north)", fold into "Therapy 1"); the group counts as organised by trade when at least half its items hold labelled parts. T124 gives 6 sub-rooms, V1 Group therapy, V2-V3 Psychiatrist 1-2, V4-V6 Therapy 1-3, each boxed by its floor-finish part (Therapy 1 = its carpet, 10.08 x 4.40 m), from the floor level to the group's top. Parts are listed under each as R12... (92 on T124): copies are joined ("12x circle seat") and so are the pieces of one named wall ("Therapy 1 feature wall (north)": 10 oak boards + plinth + reveal + acoustic panel); parts whose bottom is 1.5 m or more above the floor (ceilings, blind cassettes) and the floor finish itself are left out. T123 (rest area), the 1F reception and the other test rooms get no sub-rooms. Sub-rooms and parts live in `summary.subRooms`, NOT in `summary.items`, so the read-back after a build is unchanged; the resolver can measure from them (beside, inside, scene) but refuses to take them out ("can be measured from, but not taken out"). **Token budget:** all 92 parts = ~4.1k tokens, too much next to an 8k window, so the agent/bench summary lists the parts only of the sub-rooms the brief's changes name ("Therapy 1", not "Therapy 10"); the others get one line. Brief 9's summary is ~2.0k tokens. Trade items' "contains" lines shrink to 3 entries when sub-rooms exist. (2) **Placement `inside`** (build and place): `{"kind":"inside","anchor":"V4"|"R..."|"room","side","gap","eastWest","northSouth","shift"}` = against that side of the room, gap measured inward, centred along it unless shifted. A block that pokes out of the room is an ERROR with the overshoot ("reaches 0.7 m past its north side"), not a warning. Planner: prompt + example 7; V refs accepted everywhere a ref is; a name like "Therapy 1" becomes V4; `beside` a sub-room is refused with a reply to use `inside` (unless the change says outside/beside/next to); base fill-in and the east-west/north-south checks cover `inside` too. Box-overlap warnings skip the trade items (every block overlapped all 8 of them) and use the parts instead. (3) **Collision errors joined:** one block hitting 13 copies of one part was 13 identical lines; now "S1 collides with 13x ..." with the biggest overlap. (4) **Test brief 9** (`instructions/3F_therapy1_inside.md` + `.draft.json`, `dev/UMD_DEV_3F.skp`): in Therapy 1, a 2.4 m light oak waiting bench against the south wall under the acoustic panels and a 2.0 m check-up shelf against the east wall north of the door, both `inside` V4. First `--draft` run BLOCKED, correctly: the bench 0.05 m off the wall cut the Soft Air oak fins (they stand 0.08 m out, inside `Therapy 1 - Soft Air`); brief changed to 0.1 m. Run 221103: **SUCCESS**, both built where measured (bench x 10.075..12.475 y 76.16..76.56, shelf x 18.45..18.75 y 78.3..80.3), read-back 0.0 mm, nothing else changed, 2 pictures (the shelf's view check warned - the camera spot is 0.15 m from a desk part - but the picture shows shelf and door clearly). Vitest 455 (+18), Ruby 192. **Not done:** scenes "from the north side of Therapy 1" still use the whole group's sides (a scene can look toward V4, not stand inside it). Next: Tyson's AI run of brief 9. `src/cli/agent.ts` is free for the Mac.
