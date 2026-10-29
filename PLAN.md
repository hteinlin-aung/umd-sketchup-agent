# UMD SketchUp Agent — PLAN

*Created 2026-10-29 · Deadline 2026-11-26 (4 weeks) · Status: Week 1 code written, mock-tested; waiting for the first real Windows run*

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

### Week 1 (Oct 29 – Nov 4): TypeScript drives real SketchUp
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

### Week 2 (Nov 5 – Nov 11): read the architecture + turn instructions into operations
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
- Compare `qwen3:4b-instruct` with one larger model that fits about 5 GB VRAM, on my real instruction files.

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
