# UMD SketchUp Agent

AI-assisted modelling for **SketchUp 2025**: written design instructions become validated
operations, which run through a **fixed set of tested Ruby tools** inside SketchUp. The result
is checked, and a **new copy** of the model is saved. The AI never writes SketchUp code.

Built for the *Urban Mind Detox* thesis model. Full plan and decisions: [`PLAN.md`](PLAN.md).

**Status:** Week 1. Bridge + 6 tools (`ping`, `getModelInfo`, `createBox`, `applyMaterial`,
`captureView`, `saveCopy`). No AI yet; that arrives in Week 2.

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
   The Ruby Console (Extensions ▸ Developer ▸ Ruby Console) shows `[UMD Bridge 0.1.1] watching …`.

**Each test**

```powershell
git pull                 # get the latest code
# in SketchUp: Extensions > UMD Bridge > Reload (after git pull)
# open E:\Cowork_Field\Thesis_SketchUp\dev\UMD_DEV_1F.skp
npm run ping             # quick: is SketchUp listening?
npm run smoke            # Week 1 acceptance test
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
