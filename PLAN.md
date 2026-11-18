# UMD SketchUp Agent — PLAN

*Created 2026-10-29 · No deadline and no feature freeze (removed 2026-11-19; was 2026-11-26): work goes into this plan and carries on as normal · Status: **Week 1 DONE 2026-10-29** · **Week 2 DONE 2026-11-12** (brief → qwen3:8b plan → approval → built and saved, 15/15) · **Week 3 DONE 2026-11-14** (whole-model checks, components, scenes, clear outcomes) · Week 4 next*

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
| D3 | **Fixed list of Ruby tools; no `eval`** (later: one exception, `runRuby`, for the Claude API only, see §9) | Safety rule: the AI chooses tools, it never writes code. Unknown tools or bad parameters are rejected. | Each new ability needs a new tool to be written and tested. That's intended. |
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
- Tools: `placeComponent`, `cutOpening`, `addScene`, `createMaterial`. (`placeComponent` and `addScene` built; `cutOpening` and `createMaterial` were NOT built when Week 3 was marked done; moved to Week 4 on 2026-11-19.)
- Screenshots after each milestone. Optional vision-model notes (flags only, never proof of correctness).
- ~~Compare `qwen3:4b-instruct` with one larger model~~ done early (`npm run bench`, 2026-11-11/12): qwen3:8b chosen.
- From the Week 2 finish: the size-direction check must follow the BLOCK, not only the change text it came from
  (runs 2–3 built the counter rotated 90° after it migrated to change 3).
- Brief 2 on a different room, to see the planner work beyond the room it was tuned on.

**Done when:** a run with a deliberately wrong instruction (e.g. a built-in overlapping a column) is
caught by a check, fixed by a predefined tool or reported honestly, and the run ends with a clear outcome.

### Week 4 (from Nov 19, no end date): thesis testing + stabilising
- Real tasks on all three floors, run against copies of the master.
- Fix the integration bugs that show up. Add the edge cases found to the tests.
- Furniture from a hand-picked local component folder, if the core is solid.
- `README.md`: how to run it, and how to add a new tool (step-by-step).

**Order of work (agreed 2026-11-19, no end date):**
1. Chat in the panel + the panel makes the safe copy itself.
2. **`cutOpening`** (rectangular door/window opening in a wall group) + **`createMaterial`** (colour and/or texture image with a real-world size), the two tools left over from Week 3.
3. Component picture buttons tried in the panel; scenes inside a sub-room.
4. Htain's own thesis brief/chat run end to end.
5. Final pass on README + HOW-IT-WORKS.
6. Claude API + `runRuby` (§9).

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
| **Claude API as the planner** (decided 2026-11-19) | Planned | A model adapter: one file per provider with the same "ask → JSON" function (Ollama + Claude API); Claude gets the tool list as native tool definitions; the small-model helper layers (one change at a time, sub-room hints) become switches, safety layers stay on. Other providers maybe later. No cost limit for now. |
| **`runRuby`: Claude writes its own Ruby when no tool fits** (decided 2026-11-19, Plan A) | Planned, changes D3 | Tools first; only when no tool can do it, Claude proposes Ruby. Htain ALWAYS sees the code and presses Yes (he can ask Claude to explain it). Runs only on the copy, inside one SketchUp operation (abort on error), with a timeout; blocked: file delete, system commands, network, opening/saving files. Then the same checks, read-back and report (the code is saved in the report). Honest limit: Ruby inside SketchUp cannot be fully locked; the copy + approval + checks are the real protection. Never for the small local model. |
| **Working code becomes a new tool** (decided 2026-11-19, Plan B) | After Plan A works | When `runRuby` code works and Htain likes the result, it is saved as a new fixed tool with a Zod schema and a test, so qwen can use it too. |
| **Any SketchUp model; sharing later** (decided 2026-11-19) | Planned | Personal use first, on any model (safe copy next to it). Before sharing with other people: stricter rules for `runRuby`. |
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

Only the **last 10 entries** stay here, to keep this file short. Older entries (2026-10-29 to 2026-11-14, 74 entries) are in [`CHANGELOG.md`](CHANGELOG.md). When this list grows past about 15, move the oldest ones there (oldest first, same wording).

- 2026-11-14: **Brief 9 AI run (Tyson, PowerShell, run 052135): BLOCKED, correctly - two planner gaps found and fixed.** qwen3:8b planned all 5 changes in 100 s, but (1) it wrote V5 "Therapy 2" for "In Therapy 1" in changes 1 and 2 (its own reason said "Therapy 1"; first as `beside`, which the new check sent back, then as `inside` V5, which was accepted), and (2) change 3 "Tags. Put everything new on the tag ..." rebuilt both pieces again beside R71 (a task chair) - accepted, because "new" in "everything new" counted as asking for something new. The collision check then stopped the run (the wrong-room bench cut the Therapy 2 sofa and armchair, the copies cut desks and a wall), so nothing was built. **Fixes:** (a) the question for each change now ends with `Sub-rooms named in this change: "Therapy 1" = V4.`; (b) when a change names exactly one sub-room, a block measured from another sub-room or from one of its parts is sent back ("change 1 is about "Therapy 1" = V4, but S1 is measured from V5 in "Therapy 2" (V5); use "anchor":"V4""); (c) "everything new / all new / new pieces ..." no longer counts as asking for something new; (d) a build with the same name and size as one from an earlier change is sent back as a repeat. Replays of all three answers are tests. Vitest 458. Next: Tyson reruns brief 9.
- 2026-11-14: **Brief 9 AI rerun (Tyson, PowerShell, run 052732, after e7784f2): SUCCESS - the first AI build inside a sub-room.** qwen3:8b planned all 5 changes in 138 s; the plan equals the reference draft in position (both pieces `inside` V4 "Therapy 1": bench x 10.075..12.475 y 76.16..76.56, shelf x 18.45..18.75 y 78.3..80.3), no collisions, read-back 0.0 mm, nothing else changed, saved. The new checks did their work: change 1's first answer used `beside` V4 and was sent back to `inside`; changes 3 and 4 (Tags, Materials) first rebuilt both pieces and were sent back as "not asking for anything new" + "repeats S1/S2", then answered as rules. **One flaw:** the shelf (change 2) got the tag "Furniture (AGENT)" - the prompt example's - because the Tags change comes after it. Fixed: when the brief puts "everything new on the tag `X`", every build/place step gets tag X (`fillTag`, like `base`). Vitest 459. T124 work is done; `src/cli/agent.ts` is free for the Mac.
- 2026-11-14: **Agent page, part 1 (Mac).** `npm run ui` serves a local page at http://127.0.0.1:4477 (Node built-ins only, no new packages): brief + room picker, plan by AI or by an existing draft, live steps and every line the agent prints, pictures, "which one do you like?" as picture buttons, Yes/No for the plan, outcome + report.md, earlier runs. It starts the SAME `npm run agent` command as a child process and answers its two questions through stdin, so `src/cli/agent.ts` was NOT changed and nothing can bypass the CLI's rules. Safety: listens on 127.0.0.1 only; refuses other hosts/origins and non-JSON posts; brief/draft must be plain file names in instructions/; pictures only from runs/ and the queue folder; one run at a time. Files: `src/ui/server.ts`, `src/ui/page.html`, `src/cli/ui.ts`, `tests/mock/ui.test.ts` (8 tests with a fake agent). Typecheck clean; the server flow was checked with plain Node on the Mac side; Vitest run by Htain. Next: Windows tries it with real SketchUp, then part 2 = the HtmlDialog panel (Extensions > UMD Bridge > Agent panel).
- 2026-11-14: **Mac review of T124 (91bd576, e7784f2, 930fbf9): accepted.** README now covers sub-rooms and `inside`. `src/cli/agent.ts` is NOT needed by the page (it drives the CLI through stdin/stdout), so Windows may keep editing it. Handoff for part 2 sent: Windows adds Extensions > UMD Bridge > Agent panel (UI::HtmlDialog on http://127.0.0.1:4477). Rule for the agent's text: the page reads the lines `model open:`, `reading the room`, `asking ... to plan` / `using the draft`, `which one do you like?`, `checking new blocks`, `  ok [n]` / `  FAILED [n]`, `read-back`, `OUTCOME: X`, `Pick 1-N (Enter = 1): ` and `... Type y to run, anything else to stop: `; change one of them only together with src/ui/page.html or src/ui/server.ts.
- 2026-11-14: **Windows: Agent panel inside SketchUp (80c5be1, bridge 0.8.0) + page layout (69c8e16).** `sketchup/umd_bridge/panel.rb`: Extensions > UMD Bridge > Agent panel = one `UI::HtmlDialog` (1100 x 800, resizable, STYLE_DIALOG) on http://127.0.0.1:4477; opening it again brings it to the front. When nothing listens on the port (a 0.5 s TCP check from Ruby), it shows a local message "Start the page first: npm run ui ..., then press Reload" with a Reload button and re-checks every 5 s (the message is not set again while showing, so no flicker). On a SketchUp that loaded bridge 0.7.x, "Reload (after git pull)" adds "UMD Agent panel" straight under Extensions once (a submenu can't be found again to add to it). Ruby 199 (+7, fake HtmlDialog). **Tyson's tests on the PC:** browser page, brief 9 with the draft: SUCCESS, live lines, both screenshots and the report shown, Yes worked (run 055611). Panel in SketchUp, brief 9 with the AI: SUCCESS (run 060623), "everything works" - the panel showed the run live, the Yes click reached the agent, pictures and report shown. Then confirmed one by one (Tyson): the panel keeps updating while a tool runs (the lines keep moving during the save), and closing the panel mid-run leaves the run going (PowerShell carries on; reopening the panel shows the run again). Component buttons not tested (no 3F brief uses components). **Layout (Tyson: "texts sprawling out of the line"):** the right column could not shrink below its longest unbroken path, so the page grew past the window; now `minmax(0,1fr)` + `min-width:0`, long words wrap anywhere, earlier-runs rows wrap and the outcome pills never break ("MAX TRIES"); the brief list shows "<file> - <title>". Checked at 1600 px in the desktop app's browser pane: no sideways overflow.
- 2026-11-14: **Interface DONE (Mac review of 80c5be1, 69c8e16, 86d4115, d7ba171).** Page + panel inside SketchUp (bridge 0.8.0) work on the PC: live during a 45 s save, closing the panel stops nothing, reopening shows the run. Untested: the component picture buttons (needs a brief that places components). **What is left before 2026-11-26:** (1) Htain writes and runs his OWN thesis brief through the panel (the real finish line); (2) one components brief through the panel; (3) scenes inside a sub-room (small); (4) feature freeze 2026-11-19, then only fixes; (5) final pass on README + HOW-IT-WORKS.
- 2026-11-14: **Htain's decision: chat before the freeze, better chat after the deadline. Not started yet** (Htain has design questions first). Before 2026-11-19: (a) the panel makes the safe copy itself (open ANY model; the agent works on `<name>_AGENT_n.skp` next to it; no `UMD_DEV_` renaming); (b) a chat box: one message = one change, written to a brief file behind the scenes as the record; tag, material, screenshot and save added automatically; room from a dropdown of the open model's rooms; the agent asks a question instead of failing. Same tools, checks and Build button. After 2026-11-26: follow-ups ("move that one"), memory of the conversation, other projects (own floor levels and folder).
- 2026-11-19: **Htain's decisions on bigger models (Mac chat), all for AFTER 2026-11-26.** The system stays model-independent (the model is only the planner). From now on the bigger model is the **Claude API** (others maybe later; no cost limit for now). Plan A + B: Claude may write its own Ruby (`runRuby`) only when no tool fits; Htain always sees the code and presses Yes; it runs only on the copy with the same checks; code that works is saved as a new tool (schema + test) so the small model can use it too. For personal use on any SketchUp model first; stricter rules before sharing. D3 and §9 updated. Nothing built.
- 2026-11-19: **Htain: no deadline and no feature freeze any more.** The 2026-11-26 deadline and the 2026-11-19 freeze are dropped. Anything that needs building or fixing goes into this plan and carries on as normal. Order of work stays: chat in the panel + safe copy; component buttons and scenes in a sub-room; Htain's own thesis brief; README + HOW-IT-WORKS; then the Claude API + `runRuby` (§9).
- 2026-11-19: **`cutOpening` and `createMaterial` back in the plan (Htain: yes).** Both were in §5 and Week 3 but were never built, and Week 3 was marked done without saying so (no decision to drop them was ever made). They are now step 2 of the Week 4 order, before Htain's own thesis brief, which may need doors, windows or new materials.
- 2026-11-19: **PLAN.md made shorter (Htain: yes).** 74 older change log entries moved, word for word, to `CHANGELOG.md` (repo root, tracked; `docs/` is git-ignored). PLAN.md keeps the last 10 and went from 94 KB to 34 KB, so each new chat reads about 60 KB less. README links both. Also: graphify (`graphify-out/`, `.cursor/rules/graphify.mdc`) is for Cursor only; Claude never reads it (note in CLAUDE.md).
