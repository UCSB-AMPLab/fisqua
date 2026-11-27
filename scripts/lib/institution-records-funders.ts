/**
 * Scripts — the institution-records fill's funders
 *
 * This module plans one repository's funders for
 * `scripts/lib/institution-records-fill.ts` against the list the data file
 * gives it (`scripts/data/institution-records/`). The list is the whole
 * set: a held funder whose name is not listed is planned for deletion, a
 * listed one not held is planned for insertion at its place in the list
 * (positions from 1), and a held one with a listed name is left, reported
 * as differing when its programme, project id, URL or position differ from
 * the list. A D1 funder is inserted only while its evidence still appears
 * verbatim in the column named; otherwise it is a gap. A web funder
 * carries its page's URL and the quote taken from it into the plan; the
 * page is not fetched. The caller writes the SQL and its guards; this
 * module reads nothing and writes nothing.
 *
 * @version v0.9.0
 */

import type { D1FunderSource, FunderSource } from "../data/institution-records/neogranadina";

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface FunderPlan {
  code: string;
  repositoryId: string;
  /** The held row's id, for a funder held. */
  id?: string;
  name: string;
  programme: string | null;
  projectId: string | null;
  url: string | null;
  position: number;
  sourceKind: "d1" | "web" | "held";
  /** For a web funder: the page and the quote taken from it. */
  sourceUrl?: string;
  quote?: string;
  source: string;
  action: "insert" | "unchanged" | "differs" | "delete" | "gap";
  note?: string;
}

/** The held values a listed funder is compared on, by the column and the plan's key. */
const COMPARED = [
  ["programme", "programme"],
  ["project_id", "projectId"],
  ["url", "url"],
] as const;

/** One repository's funders against its list: inserts, deletes, and the rows left. */
export function planFunders(
  code: string,
  v: Record<string, string | null>,
  list: FunderSource[],
  held: Record<string, unknown>[],
  gaps: string[],
): FunderPlan[] {
  const out: FunderPlan[] = [];
  list.forEach((f, i) => {
    const base = {
      code,
      repositoryId: v.id!,
      name: f.name,
      programme: f.programme,
      projectId: f.projectId,
      url: f.url,
      position: i + 1,
    };
    const sourced =
      f.kind === "web"
        ? { sourceKind: "web" as const, sourceUrl: f.sourceUrl, quote: f.quote, source: `${f.sourceUrl} ("${f.quote}"); ${f.ruling}` }
        : { sourceKind: "d1" as const, source: f.source };
    const h = held.find((x) => text(x.name) === f.name);
    if (h) {
      const differing: string[] = COMPARED.filter(([column, key]) => text(h[column]) !== base[key]).map(([column]) => column);
      if (Number(h.position) !== base.position) differing.push("position");
      out.push({
        ...base,
        ...sourced,
        id: String(h.id),
        position: Number(h.position),
        action: differing.length > 0 ? "differs" : "unchanged",
        note: differing.length > 0 ? `held with another ${differing.join(", ")}; left alone` : undefined,
      });
      return;
    }
    const evidenced = f.kind === "web" || f.evidence.every((e) => (v[f.column] ?? "").includes(e));
    if (!evidenced) gaps.push(`${code}: funder ${f.name} not written; ${(f as D1FunderSource).column} no longer contains its evidence`);
    out.push({ ...base, ...sourced, action: evidenced ? "insert" : "gap" });
  });
  for (const h of held.filter((x) => !list.some((f) => f.name === text(x.name)))) {
    out.push({
      code,
      repositoryId: v.id!,
      id: String(h.id),
      name: String(h.name),
      programme: text(h.programme),
      projectId: text(h.project_id),
      url: text(h.url),
      position: Number(h.position),
      sourceKind: "held",
      source: "held in D1; not in the data file's list",
      action: "delete",
    });
  }
  return out;
}

/** The report's line for a funder written. */
export const funderLine = (f: FunderPlan) =>
  f.action === "delete" ? `delete funder ${f.name} from ${f.code}` : `insert funder ${f.name} into ${f.code} at position ${f.position}`;

// @version v0.9.0
