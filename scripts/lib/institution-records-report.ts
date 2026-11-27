/**
 * Scripts — the institution-records fill's report and hero upload plan
 *
 * This module renders, as Markdown, what
 * `scripts/lib/institution-records-fill.ts` planned: `renderReport` the
 * report the operator reads before an apply, per repository and field the
 * value held, the value proposed, the action (`replace` where an exact
 * previous text is replaced) and the source; the funders, with the inserts
 * and deletions listed first and each funder's source kind (D1 evidence, a
 * web page and its quote, or a held row to delete); the hero upload plan;
 * the federation's publisher record against the instance's settings; each
 * federation's vocabulary values, usage and authority sources (to insert,
 * with a link template replaced, and differing); the gaps; and the number
 * of SQL statements. `renderHeroPlan` renders the upload plan alone, for
 * whoever uploads the hero images. Both read only the report; neither
 * reads the database.
 *
 * @version v0.9.0
 */

import type { FillReport } from "./institution-records-fill";
import { funderLine } from "./institution-records-funders";
import { appendAll } from "./arrays";


const cell = (v: string | null | undefined) => (v === null || v === undefined ? "—" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));

export function renderReport(r: FillReport): string {
  const lines: string[] = [
    `# Fill institution records — ${r.federation}, ${r.target}${r.apply ? "" : " (dry run)"}`,
    "",
    `Generated ${r.generatedAt}.${r.withHeroes ? " Hero URLs included." : " Hero URLs not included (run with --with-heroes after the upload)."}`,
    "",
    r.schemaReady
      ? "Migrations 0119, 0120 and 0121 are applied."
      : `Migrations 0119, 0120 and 0121 are not all applied on ${r.target} (missing: ${r.missingSchema.join(", ")}). Missing columns are read as null; --apply is refused until they exist.`,
    "",
    "## Repositories by federation",
    "",
    ...r.membership.map((m) => `- ${m.code}: ${m.federation}`),
    "",
    `Without an entry in the data file: ${r.withoutSource.join(", ") || "none"}. In the data file but not in this federation: ${r.notFound.join(", ") || "none"}.`,
    "",
    "## Repository fields",
    "",
  ];
  for (const repo of r.repositories) {
    lines.push(`### ${repo.code}`, "", "| Field | Held | Proposed | Action | Source |", "|---|---|---|---|---|");
    for (const f of repo.fields) {
      lines.push(`| ${f.column} | ${cell(f.current)} | ${cell(f.proposed)} | ${f.action}${f.note ? ` (${cell(f.note)})` : ""} | ${cell(f.source)} |`);
    }
    lines.push("");
  }
  const written = r.funders.filter((f) => f.action === "insert" || f.action === "delete");
  appendAll(lines, [
    "## Funders",
    "",
    "Where the data file lists a repository's funders, the list is the whole set: a held funder not listed is deleted.",
    "",
    ...(written.length > 0 ? written.map((f) => `- ${funderLine(f)}`) : ["- nothing to insert or delete"]),
    "",
    "| Repository | Name | Programme | Project id | URL | Position | Action | Source kind | Source |",
    "|---|---|---|---|---|---|---|---|---|",
  ]);
  for (const f of r.funders) {
    lines.push(
      `| ${f.code} | ${cell(f.name)} | ${cell(f.programme)} | ${cell(f.projectId)} | ${cell(f.url)} | ${f.position} | ` +
        `${f.action}${f.note ? ` (${cell(f.note)})` : ""} | ${f.sourceKind} | ${cell(f.source)} |`,
    );
  }
  lines.push("", "## Hero images (upload plan; nothing is uploaded)", "", "| Repository | Source file | Size | SHA-256 | Bucket | Key | URL |" + (r.withHeroes ? " Found |" : ""), "|---|---|---|---|---|---|---|" + (r.withHeroes ? "---|" : ""));
  for (const h of r.heroes) {
    lines.push(`| ${h.code} | ${h.sourcePath} | ${h.size} | ${h.sha256} | ${cell(h.bucket)} | ${h.key} | ${cell(h.url)} |` + (r.withHeroes ? ` ${h.found} |` : ""));
  }
  lines.push("", "## Federation publisher record", "", "| Field | Held | Proposed | Action | Source |", "|---|---|---|---|---|");
  for (const f of r.federationFields) {
    lines.push(`| ${f.column} | ${cell(f.current)} | ${cell(f.proposed)} | ${f.action} | ${cell(f.source)} |`);
  }
  lines.push("", "The instance's settings, against what the federation holds (nothing below is written):", "", "| Setting | Instance value | Column | Held | Note | Source |", "|---|---|---|---|---|---|");
  for (const n of r.federationNotes) {
    const same = n.held === null ? "" : n.held === n.value ? " (same)" : " (differs)";
    lines.push(`| ${n.setting} | ${cell(n.value)} | ${cell(n.column)} | ${cell(n.held)}${same} | ${cell(n.note)} | ${n.source} |`);
  }
  lines.push("", "## Vocabularies", "", "| Federation | Held | To insert | Differing | Orphan codes in use | Records with no code |", "|---|---|---|---|---|---|");
  for (const v of r.vocabularies) {
    lines.push(
      `| ${v.federation} | ${v.existing} | ${v.toInsert} | ${v.differing.join(", ") || "none"} | ` +
        `${v.orphans.map((o) => `${o.list}:${o.code} (${o.count})`).join(", ") || "none"} | ` +
        `${v.unset.map((u) => `${u.list} (${u.count})`).join(", ") || "none"} |`,
    );
  }
  lines.push("", "### The values each federation receives", "", "| List | Code | Spanish | English | Group | Position | External term | Source |", "|---|---|---|---|---|---|---|---|");
  for (const e of r.vocabularySeed) {
    lines.push(`| ${e.list} | ${e.code} | ${cell(e.labelEs)} | ${cell(e.labelEn)} | ${cell(e.groupCode)} | ${e.position} | ${e.externalUri ? `${e.externalUri} "${e.externalLabel}"` : "—"} | ${e.source} |`);
  }
  lines.push("", "### Usage per federation", "");
  for (const v of r.vocabularies) {
    lines.push(`- ${v.federation}: ${v.usage.map((u) => `${u.list}:${u.code} ${u.count}`).join(", ") || "none"}`);
  }
  lines.push("", "## Authority sources", "", "| Federation | Held | To insert | Template replaced | Differing |", "|---|---|---|---|---|");
  for (const a of r.authoritySources) {
    lines.push(`| ${a.federation} | ${a.existing} | ${a.toInsert} | ${a.toUpdate.map((u) => u.key).join(", ") || "none"} | ${a.differing.join(", ") || "none"} |`);
  }
  lines.push("", "| Key | Spanish | English | URL template | Applies to | Source |", "|---|---|---|---|---|---|");
  for (const s of r.authoritySourceSeed) {
    lines.push(`| ${s.key} | ${cell(s.labelEs)} | ${cell(s.labelEn)} | ${s.urlTemplate ?? "none"} | ${s.appliesTo.join(", ")} | ${s.source} |`);
  }
  appendAll(lines, ["", "## Gaps", "", ...r.gaps.map((g) => `- ${g}`), "", `## SQL`, "", `${r.statements.length} statement(s).`, ""]);
  return lines.join("\n");
}

export function renderHeroPlan(r: FillReport): string {
  const lines = [
    `# Hero image upload plan — ${r.federation}, ${r.target}`,
    "",
    "Nothing is uploaded by the command. Each file goes to the federation's manifests bucket under the key given; its public URL is written to hero_image_url by a later run with --with-heroes, which checks the object's size and SHA-256 first.",
    "",
    "| Repository | Source (zasqua-neogranadina-dev) | Size | SHA-256 | Bucket | Key | Public URL |",
    "|---|---|---|---|---|---|---|",
    ...r.heroes.map((h) => `| ${h.code} | ${h.sourcePath} | ${h.size} | ${h.sha256} | ${cell(h.bucket)} | ${h.key} | ${cell(h.url)} |`),
    "",
  ];
  return lines.join("\n");
}

// @version v0.9.0
