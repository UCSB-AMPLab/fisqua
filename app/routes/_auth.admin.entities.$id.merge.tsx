/**
 * Entities Admin — Merge workbench (full-page)
 *
 * This route is the full-viewport merge surface for entity authorities
 * (spec §4, handoff surface 1), replacing the old modal. The `:id`
 * record is the one that will be merged away; the survivor is chosen
 * via the `?survivor=<id>` query param (typeahead selection, list
 * two-row select, or direction swap all navigate here). The loader
 * renders the server-side field comparison for the pair; the action
 * performs the soft merge — the loser keeps its page with `mergedInto`
 * set — and writes the steward's optional note into the ledger row's
 * `detail.reason`, null when none is given.
 *
 * A merge needs evidence: at least one independent fact and one cited
 * description on each side, linked to that side's record
 * (`checkMergeEvidence`), since a shared name is never evidence. The
 * action refuses a merge without it, writing nothing, and returns the
 * refusal's evidence code; the evidence goes into the ledger row's
 * `detail.evidence`, and the batch opens with a guard that every cited
 * link is still there, so a citation removed since the check returns
 * `evidence_stale`. The workbench has no "keep both": a pair without
 * evidence is kept apart on the duplicates card or the pair page.
 *
 * Gated on the `authorities` capability like the other authority admin
 * routes; the mutation additionally follows the authority ownership
 * rule (migration 0067) — no steward needed when this tenant owns both
 * the survivor and the loser, steward-gated otherwise.
 *
 * Both merge sides load rich linked-description context cards
 * (`loadLinkedDescriptionCards`); the survivor's cards are read-only.
 *
 * Every one of the loser's function rows goes to the survivor in the
 * merge's batch, whatever links the cataloguer picked: a row of a
 * function the survivor does not hold moves, and a row of one it holds
 * fills the held row's empty fields and is deleted
 * (`arrivingEntityFunctions`). The ledger row names the rows moved
 * (`movedFunctions`) and gives the rows folded (`foldedFunctions`), as on
 * the decisions surface. The survivor's `updated_at` is set on every merge, even when
 * no names fold and no rows move, since the survivor publishes the
 * loser's retired codes and current code among its own former codes.
 *
 * A record merged away is never a side of a merge. A loser merged away
 * sends the reader to its final survivor (`finalSurvivorId`, which
 * follows `merged_into` on the tenant's scope); a survivor merged away
 * is replaced by its final survivor, or by none when its chain loops or
 * ends at the loser. The loader does this for the ids in the URL, and
 * the action, finding either merged away since the page was loaded,
 * redirects to the page the loader would give. The batch runs only
 * while both are unmerged and hold the version and the function rows
 * read; an edit that lands between
 * the action's reads and its batch returns the conflict, as a stale
 * form does. A merge whose relation repoints would leave two links under
 * one key of the unique index is refused before the batch
 * (`linkCollisions`), and the page names the description, the entity and
 * the role.
 *
 * The loader reads the federation's role lists once (`readRolePickers`),
 * and the cards show its labels for the document and place roles, a
 * relation side's from the relation roles.
 * A refusal for two links that would name the same link gives the role
 * its relation role's label.
 *
 * The page passes the workbench each record's linked descriptions, as
 * its cards list them, for the evidence panel, and shows a refusal for
 * the evidence as a sentence above the comparison.
 *
 * @version v0.9.0
 */

import { useTranslation } from "react-i18next";
import { entityRoleLabel, placeRoleLabel } from "~/lib/role-options";
import { redirect } from "react-router";
import { useActionData } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime, requestTimeZone } from "~/lib/format";
import {
  MergeWorkbench,
  type ComparisonField,
} from "~/components/admin/merge-workbench";
import type { Route } from "./+types/_auth.admin.entities.$id.merge";
import { evidenceErrorKey, evidenceShape, type EvidenceSide } from "~/components/admin/merge-evidence-panel";
import type { LinkedDescriptionCardList } from "~/lib/authority-linked-context.server";
import { isEvidenceError } from "~/lib/merge-facts";
import { pageMeta, heading } from "../lib/page-title";

export function meta(args: Route.MetaArgs) {
  const data = args.data;
  return pageMeta(
    args,
    data?.loser?.displayName,
    heading("authorities:mergeHeading"),
    heading("entities:title"),
  );
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { entities } = await import("~/db/schema");
  const { loadLinkedDescriptionCards } = await import(
    "~/lib/authority-linked-context.server"
  );

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;
  const url = new URL(request.url);
  const survivorId = url.searchParams.get("survivor");

  const loser = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
    .get();
  if (!loser) throw new Response("Not found", { status: 404 });

  // A loser merged away is merged no further: the reader goes to its
  // final survivor.
  const { finalSurvivorId } = await import("~/lib/pair-merge.server");
  if (loser.mergedInto) {
    throw redirect(`/admin/entities/${(await finalSurvivorId(db, tenant, "entity", id)) ?? id}`);
  }

  const loserCards = await loadLinkedDescriptionCards(db, {
    recordType: "entity",
    ownerId: id,
    displayName: loser.displayName,
    tenantId: tenant.id,
  });

  let survivor: typeof loser | null = null;
  let survivorCards: Awaited<ReturnType<typeof loadLinkedDescriptionCards>> | null =
    null;
  // A survivor merged away is replaced by its final survivor, or by none
  // when its chain loops or ends at the loser.
  const finalId = survivorId ? await finalSurvivorId(db, tenant, "entity", survivorId) : null;
  if (finalId && finalId !== id) {
    survivor =
      (await db
        .select()
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenant.id),
            eq(entities.id, finalId),
          ),
        )
        .get()) ?? null;
    if (survivor) {
      survivorCards = await loadLinkedDescriptionCards(db, {
        recordType: "entity",
        ownerId: survivor.id,
        displayName: survivor.displayName,
        tenantId: tenant.id,
      });
    }
  }

  // The role labels come from the federation's lists.
  const { readRolePickers } = await import("~/lib/vocabulary.server");
  const roles = await readRolePickers(db, tenant.federationId, context);

  return {
    loser,
    loserCards,
    survivor,
    survivorCards,
    roles,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const { authorityScope, requireAuthorityMutation } = await import(
    "~/lib/authority-ownership.server"
  );
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, inArray, isNull, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions } = await import("~/db/schema");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  // The steward's note, optional: the evidence carries the reason.
  const reason = (formData.get("reason") as string)?.trim() || null;

  const loserId = (formData.get("loserId") as string) || params.id;
  const survivorId = formData.get("survivorId") as string;
  if (!survivorId) return { ok: false as const, error: "survivor" as const };

  // A merge rewrites BOTH sides, so the pair rule applies: no steward is
  // needed only when this tenant owns the survivor AND the loser.
  // Merging an owned record into a shared one changes what the shared
  // record is, so that combination stays steward-gated; a record owned
  // by another tenant 404s rather than admitting it exists.
  await requireAuthorityMutation(db, user, tenant, "entity", [
    survivorId,
    loserId,
  ]);

  const addVariants = formData.get("addVariants") === "true";
  let linkIds: string[] = [];
  try {
    linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
  } catch {
    linkIds = [];
  }

  const survivor = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, survivorId)))
    .get();
  const loser = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, loserId)))
    .get();
  if (!survivor || !loser) return { ok: false as const, error: "generic" as const };

  // A record merged away since the page was loaded is neither a loser
  // nor a survivor. A loser merged away sends the reader to its final
  // survivor; a survivor merged away is replaced on the reopened page by
  // its final survivor, or by none when its chain loops or ends at the
  // loser.
  if (loser.mergedInto || survivor.mergedInto) {
    const { finalSurvivorId } = await import("~/lib/pair-merge.server");
    if (loser.mergedInto) {
      const to = await finalSurvivorId(db, tenant, "entity", loserId);
      return redirect(`/admin/entities/${to ?? loserId}`);
    }
    const to = await finalSurvivorId(db, tenant, "entity", survivorId);
    return redirect(
      to && to !== loserId
        ? `/admin/entities/${loserId}/merge?survivor=${to}`
        : `/admin/entities/${loserId}/merge`,
    );
  }

  // The evidence for the merge: a fact and a cited description on each
  // side, linked as read. Without it the merge is refused, nothing written.
  const { checkMergeEvidence, evidenceFromForm, evidenceStillLinked, evidenceStillLinkedGuard } = await import(
    "~/lib/merge-evidence.server"
  );
  const checked = await checkMergeEvidence(db, tenant.id, loserId, survivorId, evidenceFromForm(formData));
  if (!checked.ok) return { ok: false as const, error: checked.error };
  const evidence = checked.evidence;

  // Optimistic lock on the loser (the record being mutated to mergedInto).
  const formUpdatedAt = formData.get("_updatedAt") as string;
  const forceOverwrite = formData.get("_force") === "true";
  if (!forceOverwrite && formUpdatedAt && String(loser.updatedAt) !== formUpdatedAt) {
    return {
      ok: false as const,
      error: "conflict" as const,
      modifiedAt: loser.updatedAt,
    };
  }

  // Resolve each selected link before the batch: reassignments become
  // UPDATEs; rows colliding with the survivor's (descriptionId, entityId,
  // role) unique index are captured in full for the ledger, then deleted.
  // Each link must belong to the LOSER — a crafted linkId pointing at
  // another record's junction row is skipped, never repointed.
  // Only the request tenant's description links are touched: a link
  // whose description belongs to another tenant stays where it is,
  // whatever ids the form names.
  const tenantDescriptions = db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenant.id));
  const linkStatements: any[] = [];
  const droppedLinks: unknown[] = [];
  const repointed: Array<{ droppedId: string; keptId: string }> = [];
  // The entity each moved link holds once the batch is made: this
  // surface journals no move, so a repoint's journal ends at that row.
  const movedTo = new Map<string, string>();
  const readLinks: Array<typeof descriptionEntities.$inferSelect> = [];
  let movedLinks = 0;
  for (const linkId of linkIds) {
    const link = await db
      .select()
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.id, linkId),
          eq(descriptionEntities.entityId, loserId),
          inArray(descriptionEntities.descriptionId, tenantDescriptions),
        ),
      )
      .get();
    if (!link) continue;
    readLinks.push(link);
    const conflict = await db
      .select({ id: descriptionEntities.id })
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.descriptionId, link.descriptionId),
          eq(descriptionEntities.entityId, survivorId),
          eq(descriptionEntities.role, link.role),
          // The unique index takes the link a relation side names
          // (migration 0125): a side only sharing a role is no collision.
          link.relatedTo === null
            ? isNull(descriptionEntities.relatedTo)
            : eq(descriptionEntities.relatedTo, link.relatedTo),
        ),
      )
      .get();
    if (conflict) {
      droppedLinks.push(link);
      repointed.push({ droppedId: linkId, keptId: conflict.id });
      linkStatements.push(
        db.delete(descriptionEntities).where(eq(descriptionEntities.id, linkId)),
      );
    } else {
      movedLinks += 1;
      movedTo.set(linkId, survivorId);
      linkStatements.push(
        db
          .update(descriptionEntities)
          .set({ entityId: survivorId })
          .where(eq(descriptionEntities.id, linkId)),
      );
    }
  }

  // The other side of each relation whose loser side was dropped names
  // the survivor's link instead, in the same batch (migration 0125).
  let incoming: { deletedIds: string[]; readIds: string[]; keptIds: string[] } | undefined;
  if (repointed.length > 0) {
    const { composeRepoints, linkCollisions, linkCollisionError, linksNaming } = await import("~/lib/pair-merge.server");
    const pointing = new Map<string, any[]>();
    const ids = repointed.map((r) => r.droppedId);
    const pointingRows = await linksNaming(db, ids, tenant.id);
    for (const p of pointingRows) pointing.set(p.relatedTo as string, [...(pointing.get(p.relatedTo as string) ?? []), p]);
    const repoints = composeRepoints(db, repointed, pointing, new Set(ids), user.id, Date.now(), movedTo);
    // A repoint must not leave two links under one key of the unique
    // index; the batch would fail whole and say nothing of which links.
    // The links that could share a key with a moved or repointed link are
    // those read here and those naming a link the repoints name.
    const keptIds = [...new Set(repointed.map((r) => r.keptId))];
    const collisions = linkCollisions(
      [...readLinks, ...pointingRows, ...(await linksNaming(db, keptIds, tenant.id))],
      { entityOf: movedTo, relatedToOf: new Map(repoints.rows.map((r) => [r.id, r.relatedTo])), dropped: new Set(ids) },
    );
    if (collisions.length > 0) {
      const { collision } = await linkCollisionError(db, collisions[0], tenant.id);
      return { ok: false as const, error: "relation_collision" as const, collision };
    }
    // The repoints go first: the foreign key on `related_to` refuses the
    // delete of a link that is still named, so each link naming a dropped
    // one must name the kept one before the drop; nothing has moved yet.
    linkStatements.unshift(...repoints.statements);
    incoming = {
      deletedIds: ids,
      readIds: [...pointing.values()].flat().map((p) => p.id),
      keptIds: [...new Set(repointed.map((r) => r.keptId))],
    };
  }

  // Fold the loser's names into the survivor's variants when requested.
  let survivorVariants = survivor.nameVariants;
  if (addVariants) {
    let existing: string[] = [];
    try {
      existing = JSON.parse(survivor.nameVariants || "[]");
    } catch {
      existing = [];
    }
    let loserVariants: string[] = [];
    try {
      loserVariants = JSON.parse(loser.nameVariants || "[]");
    } catch {
      loserVariants = [];
    }
    const merged = new Set([...existing, loser.displayName, ...loserVariants]);
    survivorVariants = JSON.stringify(Array.from(merged));
  }

  // Links left behind on the loser = this tenant's live links on it minus those
  // actually reassigned or conflict-dropped (not the raw client count,
  // which may contain ids that were skipped as not the loser's).
  const [{ count: loserLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .where(
      and(
        eq(descriptionEntities.entityId, loserId),
        inArray(descriptionEntities.descriptionId, tenantDescriptions),
      ),
    )
    .all();
  const leftBehind = Math.max(
    0,
    loserLinkCount - movedLinks - droppedLinks.length,
  );

  // The loser's function rows all go to the survivor: a row of a
  // function the survivor does not hold moves, and a row of one it holds
  // fills the held row's empty fields and is deleted. The batch opens
  // with a guard that both records are still unmerged and hold the
  // version and the rows read, and the moves are followed by a guard that the
  // loser holds no rows; an edit between these reads and the batch fails
  // it whole and comes back as the conflict.
  const {
    arrivingEntityFunctions,
    entitiesAsReadGuard,
    entitiesStillAsRead,
    entityLeftWithoutFunctionsGuard,
    nextVersion,
    planFunctionArrivals,
    readEntityFunctionRows,
  } = await import("~/lib/entity-functions.server");
  const loserFunctions = await readEntityFunctionRows(db, loserId);
  const survivorFunctions = await readEntityFunctionRows(db, survivorId);
  const functions = planFunctionArrivals(survivorFunctions, loserFunctions);
  const movedFunctions = functions.moved;
  const asRead = [
    { id: loserId, version: loser.updatedAt, unmerged: true, functionIds: loserFunctions.map((r) => r.id) },
    { id: survivorId, version: survivor.updatedAt, unmerged: true, functionIds: survivorFunctions.map((r) => r.id) },
  ];

  const timestamp = Date.now();
  // Each record's new version is past the one read, whatever the clock,
  // so a save that read it before the merge fails after it.
  const loserVersion = nextVersion(loser.updatedAt, timestamp);
  const survivorVersion = nextVersion(survivor.updatedAt, timestamp);
  // The provenance line's date is the acting member's calendar day.
  const now = formatIsoDateTime(timestamp, requestTimeZone(request)).slice(0, 10);
  const sourceNote = `Merged into ${survivor.displayName} (${survivor.entityCode}) on ${now}`;

  const scope = authorityScope(entities, tenant.federationId, tenant.id);
  const { incomingReferencesAsReadGuard, incomingReferencesStillAsRead } = await import("~/lib/pair-merge.server");
  const batch: any[] = [
    // The cited links are as read: one removed since fails the merge whole.
    evidenceStillLinkedGuard(db, tenant.id, evidence),
    entitiesAsReadGuard(db, asRead),
    // The links naming a link the batch drops are the ones read.
    ...(incoming ? [incomingReferencesAsReadGuard(db, incoming)] : []),
    ...linkStatements,
    ...arrivingEntityFunctions(db, loserId, survivorId, functions, scope, timestamp),
    entityLeftWithoutFunctionsGuard(db, loserId),
    db
      .update(entities)
      .set({
        mergedInto: survivorId,
        sources: loser.sources ? `${loser.sources}\n${sourceNote}` : sourceNote,
        updatedAt: loserVersion,
      })
      .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, loserId))),
  ];
  // The survivor's version moves on every merge: it publishes the
  // loser's retired codes and current code as its own `former_codes`,
  // and takes its function rows, whether or not names fold.
  batch.push(
    db
      .update(entities)
      .set(
        addVariants
          ? { nameVariants: survivorVariants, updatedAt: survivorVersion }
          : { updatedAt: survivorVersion },
      )
      .where(
        and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, survivorId)),
      ),
  );
  batch.push(
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "entity",
      operation: "merge",
      sourceId: loserId,
      targetId: survivorId,
      userId: user.id,
      detail: { reason, movedLinks, droppedLinks, addVariants, leftBehind, movedFunctions, foldedFunctions: functions.folded, evidence },
    }),
  );

  try {
    await db.batch(batch as any);
  } catch (err) {
    if (!(await evidenceStillLinked(db, tenant.id, evidence))) {
      return { ok: false as const, error: "evidence_stale" as const };
    }
    if (
      (await entitiesStillAsRead(db, asRead)) &&
      (!incoming || (await incomingReferencesStillAsRead(db, incoming)))
    ) {
      throw err;
    }
    const current = await db
      .select({ updatedAt: entities.updatedAt })
      .from(entities)
      .where(eq(entities.id, loserId))
      .get();
    return {
      ok: false as const,
      error: "conflict" as const,
      modifiedAt: current?.updatedAt ?? loser.updatedAt,
    };
  }
  return redirect(`/admin/entities/${survivorId}`);
}

/** A record's side of the evidence panel: its linked descriptions, as the cards list them. */
function evidenceSide(
  record: { id: string; displayName: string; entityCode: string | null },
  role: "survivor" | "retired",
  cards: LinkedDescriptionCardList,
): EvidenceSide {
  return {
    entityId: record.id,
    name: record.displayName,
    code: record.entityCode ?? undefined,
    role,
    descriptions: cards.cards.map((c) => ({
      id: c.descriptionId,
      code: c.referenceCode,
      date: c.dateExpression ?? c.dateStart,
      title: c.title,
    })),
  };
}

export default function EntityMergeWorkbench({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { t: te } = useTranslation("entities");
  const actionData = useActionData<typeof action>();
  const { loser, loserCards, survivor, survivorCards, roles } = loaderData;

  const comparisonFields: ComparisonField[] = [
    { key: "displayName", label: te("field.displayName") },
    { key: "entityCode", label: te("field.entityCode") },
    { key: "datesOfExistence", label: te("field.datesOfExistence") },
    { key: "wikidataId", label: te("field.wikidataId") },
    { key: "viafId", label: te("field.viafId") },
    { key: "dbeId", label: te("field.dbeId") },
    { key: "linkCount", label: t("mergeLinksHeading") },
  ];

  const toFields = (
    r: typeof loser | null,
    linkCount: number,
  ): Record<string, string | null> =>
    r
      ? {
          displayName: r.displayName,
          entityCode: r.entityCode,
          datesOfExistence: r.datesOfExistence,
          wikidataId: r.wikidataId,
          viafId: r.viafId,
          dbeId: r.dbeId,
          linkCount: String(linkCount),
        }
      : {};

  const conflictModifiedAt =
    actionData && "error" in actionData && actionData.error === "conflict"
      ? actionData.modifiedAt
      : null;
  const evidenceError =
    actionData && "error" in actionData && isEvidenceError(actionData.error)
      ? t(evidenceErrorKey(actionData.error, evidenceShape(loser.entityType, survivor?.entityType)))
      : null;
  const refusal = evidenceError ??
    (actionData && "error" in actionData && actionData.error === "relation_collision"
      ? t("mergeErrorRelationCollision", {
          description: actionData.collision.referenceCode,
          entity: actionData.collision.entityCode,
          role: actionData.collision.role ? entityRoleLabel(roles.labels, actionData.collision.role, true) : "",
        })
      : null);

  return (
    <MergeWorkbench
      eyebrow={t("mergeEyebrowEntities")}
      basePath="/admin/entities"
      searchEndpoint="/admin/entities"
      loser={{
        id: loser.id,
        name: loser.displayName,
        code: loser.entityCode ?? "",
        fields: toFields(loser, loserCards.totalLinks),
      }}
      loserUpdatedAt={loser.updatedAt}
      survivor={
        survivor
          ? {
              id: survivor.id,
              name: survivor.displayName,
              code: survivor.entityCode ?? "",
              fields: toFields(survivor, survivorCards?.totalLinks ?? 0),
            }
          : null
      }
      loserCards={loserCards}
      survivorCards={survivorCards}
      showAsRecorded
      roleLabel={(role, relationSide) => entityRoleLabel(roles.labels, role, relationSide)}
      placeRoleLabel={(role) => placeRoleLabel(roles.labels, role)}
      comparisonFields={comparisonFields}
      conflictModifiedAt={conflictModifiedAt}
      refusal={refusal}
      evidence={
        survivor && survivorCards
          ? {
              sides: [
                evidenceSide(loser, "retired", loserCards),
                evidenceSide(survivor, "survivor", survivorCards),
              ],
              shape: evidenceShape(loser.entityType, survivor.entityType),
            }
          : null
      }
      t={t}
    />
  );
}

/* @version v0.9.0 */
