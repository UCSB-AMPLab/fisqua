/**
 * EAD XML — a resolved scope, encoded as a finding aid
 *
 * This module deals with the seam between an export scope and the EAD3
 * builder: reading the scope's descriptions as `EadInput` rows,
 * refusing the two things a finding aid cannot encode, and choosing the
 * per-standard profile. The XML itself is `ead/builder.ts`'s, which the
 * publish pipeline also uses and which this work extended rather than
 * forked.
 *
 * THE DUPLICATE REFERENCE CODE IS CHECKED BEFORE ANYTHING IS
 * SERIALISED, and it is the failure the design cards make canonical:
 * «Two records share the reference code CMD-SR-0441. Reference codes
 * must be unique to encode a finding aid.» A reference code is a
 * document's `<unitid>` and, in an arbitrary set, the only handle a
 * child has on its parent; two records sharing one make the hierarchy
 * ambiguous and the document a lie about which record is which. The run
 * fails with the code, both titles and both ids, so the history row can
 * say the sentence and offer "Open the records" — a failure a
 * cataloguer can act on in a minute, rather than a file that silently
 * merged two records.
 *
 * Reference codes are unique per tenant at the schema level
 * (`desc_ref_code_idx` on `(tenant_id, reference_code)`), so this check
 * should never fire on a healthy workspace. It exists because the index
 * is a v0.4 addition over imported data and because the alternative to
 * checking is emitting the ambiguity.
 *
 * AN AUTHORITY SCOPE NEVER REACHES HERE — the legality matrix refuses
 * EAD for one before a run row exists («an authority file is not a
 * finding aid») — and neither does a Dublin Core or canonical form. The
 * guards below restate both, because a crafted form body can name any
 * pair and a failed run with a named reason is a better answer than a
 * confusing document.
 *
 * WHAT LEAVES: every description in the scope, published or not. The
 * publish pipeline filters on `isPublished` because it is building a
 * public site; a workspace encoding its own scope as a finding aid is
 * not publishing it, and the confirm bar already stated the count.
 *
 * @version v0.7.0
 */

import { buildEad3ForSet } from "./ead/builder";
import { getEadProfile } from "./ead/profiles/registry";
import type { ExportArtifact, ExportEmitContext } from "./canonical-csv.server";
import { standardForForm } from "./forms";
import type { ExportEmitInput } from "./emitters.server";
import { ExportRunFailure } from "./run.server";
import { readRepositories, readScopedDescriptions } from "./rows.server";
import type { EadInput, EadRepository } from "./types";

/** How many titles a duplicate failure carries. The card shows two. */
const DUPLICATE_TITLE_SAMPLE = 2;

/**
 * Emit a scope as one EAD3 finding aid.
 *
 * The scope's order is the document's order: the hierarchy's preorder,
 * the handlist's own sequence, the carried set's. Structure is rebuilt
 * from parent reference codes, so a row whose parent was not selected
 * becomes a root — which is how a branch export rooted at a series
 * encodes as a finding aid of that series.
 */
export async function emitEadXml(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportArtifact> {
  const { db, tenant, scope } = input;

  if (scope.recordClass !== "records") {
    throw new ExportRunFailure({ code: "ead-not-authority" });
  }
  const standard = standardForForm(input.form, input.ownStandard);
  if (standard === null || input.form === "canonical") {
    throw new ExportRunFailure({
      code: "ead-needs-descriptive-standard",
      detail: { form: input.form },
    });
  }

  await ctx.checkpoint("descriptions", 0, scope.memberIds.length);
  const scoped = await readScopedDescriptions(db, tenant, scope.memberIds);
  await ctx.checkpoint("descriptions", scoped.length, scope.memberIds.length);

  assertUniqueReferenceCodes(scoped);

  const repos = await readRepositories(
    db,
    tenant,
    scoped.map((s) => s.row.repositoryId),
  );

  const rows: EadInput[] = scoped.map((s) => ({
    id: s.row.id,
    referenceCode: s.row.referenceCode,
    title: s.row.title,
    descriptionLevel: s.row.descriptionLevel,
    dateExpression: s.row.dateExpression,
    extent: s.row.extent,
    creatorDisplay: s.row.creatorDisplay,
    scopeContent: s.row.scopeContent,
    accessConditions: s.row.accessConditions,
    language: s.row.language,
    placeDisplay: s.row.placeDisplay,
    imprint: s.row.imprint,
    parentReferenceCode: s.parentReferenceCode,
    repositoryId: s.row.repositoryId,
    isPublished: s.row.isPublished ?? false,
    legacyIds: s.legacyIds,
    adminBiogHistory: s.row.adminBiogHistory,
    preferredCitation: s.row.preferredCitation,
    acquisitionInfo: s.row.acquisitionInfo,
    systemOfArrangement: s.row.systemOfArrangement,
    physicalCharacteristics: s.row.physicalCharacteristics,
  }));

  await ctx.checkpoint("serializing", 0, 1);

  // The maintenance agency is the workspace's own repository when the
  // scope has one, and the tenant otherwise: a finding aid must name
  // who maintains it, and for a set spanning repositories that is the
  // workspace rather than any one of them.
  const repoList = [...repos.values()];
  const agencyName =
    repoList.length === 1 ? repoList[0].name : (tenant.name ?? "Fisqua");

  const body = buildEad3ForSet(
    rows,
    repos as ReadonlyMap<string, EadRepository>,
    getEadProfile(standard),
    new Date().toISOString(),
    {
      recordId: scopeRecordId(input),
      scopeTitle: scopeTitle(input),
      agencyName,
      agentName: "Fisqua export",
    },
  );

  await ctx.checkpoint("serializing", 1, 1);
  return { body, contentType: "application/xml; charset=utf-8", extension: "xml" };
}

/**
 * Refuse a set whose reference codes collide, naming the code and both
 * records. Raised before serialisation, so nothing partial is written
 * and the run's own stage tells the reader how far it got.
 */
function assertUniqueReferenceCodes(
  scoped: ReadonlyArray<{ row: { id: string; referenceCode: string; title: string } }>,
): void {
  const seen = new Map<string, { id: string; title: string }>();
  for (const { row } of scoped) {
    const first = seen.get(row.referenceCode);
    if (first) {
      throw new ExportRunFailure({
        code: "duplicate-reference-code",
        detail: {
          referenceCode: row.referenceCode,
          titles: [first.title, row.title].slice(0, DUPLICATE_TITLE_SAMPLE),
          // The ids are what "Open the records" needs; the titles are
          // what the sentence shows.
          ids: [first.id, row.id].slice(0, DUPLICATE_TITLE_SAMPLE),
        },
      });
    }
    seen.set(row.referenceCode, { id: row.id, title: row.title });
  }
}

/**
 * The document's `<recordid>`: the scope in a stable, code-like form.
 * A branch names its own reference code, which is what an aggregator
 * would expect to find; the other doors name what they are, because a
 * handlist and a search result have no archival identifier and
 * inventing one would put a fictitious code into a finding aid.
 */
function scopeRecordId(input: ExportEmitInput): string {
  const descriptor = input.scope.descriptor;
  switch (descriptor.kind) {
    case "branch":
      return descriptor.referenceCode;
    case "handlist":
      return `handlist:${descriptor.handlistId}`;
    case "carried":
      return `selection:${descriptor.carriedScopeId}`;
    case "workspace":
      return `workspace:${input.tenant.slug}`;
  }
}

/** The scope in words, for `<titleproper>` and a wrapper's `<unittitle>`. */
function scopeTitle(input: ExportEmitInput): string {
  const descriptor = input.scope.descriptor;
  switch (descriptor.kind) {
    case "branch":
      return descriptor.title;
    case "handlist":
      return descriptor.name;
    case "carried":
      return descriptor.pills.join(" · ") || input.tenant.name;
    case "workspace":
      return input.tenant.name;
  }
}

/* @version v0.7.0 */
