/**
 * Reads a brief like instructions/1F_reception.md into its numbered changes.
 *
 *   1. **Take out "Sofa set 4".** Move ...        -> change 1 (continuation lines belong to it)
 *   ## Later ...  /  - (later) Lowered waiting area  -> later items: not planned, reported as not done
 *
 * Everything else (title, intent, model, floor) is context the model still sees in full.
 */

export type BriefChange = { line: number; text: string };
export type Brief = { text: string; changes: BriefChange[]; later: string[] };

export function parseBrief(text: string): Brief {
  const changes: BriefChange[] = [];
  const later: string[] = [];
  let inLater = false;
  let current: BriefChange | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      inLater = /\blater\b/i.test(line);
      continue;
    }
    const numbered = line.match(/^\s*(\d{1,2})\.\s+(.*)$/);
    if (numbered && !inLater) {
      current = { line: Number(numbered[1]), text: numbered[2]!.trim() };
      changes.push(current);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet && (inLater || /\(later\)/i.test(bullet[1]!))) {
      later.push(bullet[1]!.replace(/^\(later\)\s*/i, "").trim());
      current = null;
      continue;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (current && /^\s+\S/.test(raw)) current.text += ` ${line.trim()}`; // an indented continuation line
  }
  return { text, changes, later };
}
