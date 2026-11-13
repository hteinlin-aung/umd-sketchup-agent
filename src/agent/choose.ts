import type { BridgeClient } from "../bridge/client";
import { fitComponent, TYPICAL, type Catalog, type CatalogEntry } from "./catalog";
import type { Draft, DraftStep } from "./draft";

/**
 * "Which one do you like?" Before anything is placed, the designer chooses.
 *
 * For every component the model picked, the designer sees that one and up to two others of the same kind
 * from the components folder (same kind = same rule in catalog.ts: tables with tables, plants with plants),
 * each with a preview picture SketchUp makes from the file, and the size it would be placed at.
 * The model's pick is option 1; pressing Enter keeps it.
 */

export type Candidate = { entry: CatalogEntry; size: [number, number, number]; scaled: boolean; preview: string | null };
export type Choice = { step: string; line: number; picked: string; from: string[]; renamed?: { from: string; to: string } };

/**
 * A readable name from a 3D Warehouse file name: "3DW_fittonia_SashaAlonso.skp" -> "Fittonia",
 * "3DW_money_tree_Pachira_VitorB_86654.skp" -> "Money tree Pachira". Drops the 3DW prefix, numbers
 * and author names written as one CamelCase word.
 */
export function componentName(file: string): string {
  const words = file
    .replace(/\.skp$/i, "")
    .replace(/^(?:[A-Z+]+)?3DW[_ ]?/i, "")
    .split(/[_\s]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^[A-Z][a-z]+[A-Z]/.test(w) && !/^[A-Z][a-z]*[A-Z]$/.test(w) && !/^(SPACESCAN|3D)$/i.test(w));
  const name = words.join(" ").trim() || file.replace(/\.skp$/i, "");
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 80);
}
/** Shows the question and returns the answer typed (the terminal in agent.ts; a fake in tests). */
export type Ask = (question: string) => Promise<string>;

/** Up to `max` other components of the same kind as `file`. */
export function similarComponents(file: string, catalog: Catalog, max = 2): CatalogEntry[] {
  const rule = TYPICAL.find((t) => t.words.test(file));
  if (!rule) return [];
  return [...catalog.values()]
    .filter((c) => c.file !== file && TYPICAL.find((t) => t.words.test(c.file)) === rule && fitComponent(c.file, c.size, { asDrawn: c.asDrawn }))
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, max);
}

async function candidate(client: BridgeClient, entry: CatalogEntry): Promise<Candidate> {
  const fit = fitComponent(entry.file, entry.size, { asDrawn: entry.asDrawn })!;
  const res = await client.call("componentPreview", { file: entry.file });
  return { entry, size: fit.size, scaled: fit.scale !== 1, preview: res.ok ? res.data.path : null };
}

export function renderCandidates(step: { id: string; line: number; name: string }, list: Candidate[]): string {
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  const lines = [`Change ${step.line}, ${step.id} "${step.name}": which one do you like?`];
  list.forEach((c, i) => {
    lines.push(`  [${i + 1}] ${c.entry.file}${i === 0 ? "   (the agent's pick)" : ""}`);
    lines.push(`      ${c.size.map(f).join(" x ")} m (east-west x north-south x height)${c.scaled ? ", resized from a file drawn at the wrong scale" : ""}`);
    lines.push(`      preview: ${c.preview ?? "(no preview)"}`);
  });
  return lines.join("\n");
}

/**
 * Asks about every place step that has alternatives; returns the draft with the designer's picks.
 * With `ask` = null (plan only, --dry) the candidates are listed but the model's picks are kept.
 */
export async function chooseComponents(
  client: BridgeClient,
  draft: Draft,
  catalog: Catalog,
  ask: Ask | null,
  print: (text: string) => void = console.log,
): Promise<{ draft: Draft; choices: Choice[] }> {
  const choices: Choice[] = [];
  const steps: DraftStep[] = [];
  for (const st of draft.steps) {
    if (st.op !== "place") {
      steps.push(st);
      continue;
    }
    const chosen = catalog.get(st.component) ?? [...catalog.values()].find((c) => c.file.toLowerCase().replace(/\.skp$/, "") === st.component.toLowerCase().replace(/\.skp$/, ""));
    if (!chosen) {
      steps.push(st); // the resolver will explain that the file isn't in the folder
      continue;
    }
    const others = similarComponents(chosen.file, catalog);
    if (others.length === 0) {
      steps.push(st);
      continue;
    }
    const list = [await candidate(client, chosen), ...(await Promise.all(others.map((o) => candidate(client, o))))];
    print(renderCandidates(st, list));
    let pick = 0;
    if (ask) {
      for (;;) {
        const answer = (await ask(`Pick 1-${list.length} (Enter = 1): `)).trim();
        if (answer === "") break;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= list.length) {
          pick = n - 1;
          break;
        }
        print(`  "${answer}" is not one of the numbers 1-${list.length}.`);
      }
    }
    const file = list[pick]!.entry.file;
    // A different pick gets a name that says what it IS: otherwise the model would hold an object called
    // "Money tree" that is a fittonia (Windows, 2026-11-12), the very name-vs-contents mix-up that
    // "Sofa set 4 holding only a palm" taught us to catch.
    const name = pick === 0 ? st.name : componentName(file);
    choices.push({ step: st.id, line: st.line, picked: file, from: list.map((c) => c.entry.file), ...(name !== st.name ? { renamed: { from: st.name, to: name } } : {}) });
    steps.push({ ...st, component: file, name });
  }
  return { draft: { ...draft, steps }, choices };
}
