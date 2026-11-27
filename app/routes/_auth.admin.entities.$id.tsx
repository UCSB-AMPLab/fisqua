/**
 * Entities Admin — record detail (two-column redesign)
 *
 * This route is the authority record page for a single entity (spec §5
 * redesign, mockup 2026-07-11): a ~420px left column carries the record
 * itself — Identity, Description, Control, and Linked open data
 * (Wikidata/VIAF/DBE; no map) — while the right column serves the
 * linked descriptions as a WORKLIST: server-side search over
 * title/reference code (`?dq=`), role pills with real GROUP BY counts
 * (spec §11's per-record role filter), sort by date/title/reference
 * code, and honest offset pagination with a user-selectable page size
 * (25/50/100). The loader ships ONE filtered page, never the whole link
 * set. Narrow screens stack record-first. Edit swaps the left column to
 * the existing inline form in place (autosave drafts + optimistic lock
 * untouched) without remounting the right column.
 *
 * Merge and split live on their own full-page workbench routes
 * (`entities.$id.merge`, `entities.$id.split`) — this action handles
 * only update/delete/autosave and the description-link intents. The
 * header's Merge/Split buttons navigate to the workbenches, which
 * enforce the required-reason ledger invariant this action does not
 * carry. An update writes only the fields the request carries: a field
 * it leaves out keeps its stored value, the function rows are replaced
 * only when `functions` is carried, the primary-function term link
 * changes only when `primaryFunction` is, and a blank field whose
 * stored value is already blank is left as stored.
 *
 * Authority scope is the federation (migrations 0045-0048). Every
 * read/update/delete of `entities` and every vocabulary-term lookup is
 * filtered by `tenant.federationId`. The description-search subquery
 * stays `tenant.id`-scoped (descriptions remain tenant-scoped). Migration 0067 narrowed that scope one level:
 * the filter is now `authorityScope(...)`, the federation plus the
 * ownership arm (shared records, or this tenant's own), spelt out at
 * each query site. Nothing changes while every record is shared.
 *
 * An entity's functions are its `entity_functions` rows, the only place
 * they are kept: the page shows them one per line, in the order they
 * were entered, and a save replaces the entity's set with the field's
 * lines, together with the entity's fields and `updated_at`, in one
 * batch (`entity-functions.server.ts`). A line that would add a
 * function the record keeps or adds already, case and spacing aside,
 * is dropped before the save (`distinctFunctionLines`), and the
 * changelog records the lines kept. Every statement of the batch is
 * conditional on the version the save read, so of two saves from the
 * same version the second changes nothing and gets the conflict
 * response. The new `updated_at` is the clock, or one past the version
 * read when the clock has not passed it, so every save moves the
 * version. The `entities.functions` column is neither shown nor
 * written.
 *
 * The header's "Add to handlist" is the browse-time half of how a
 * handlist gets built: one record at a time, through the same
 * type-matched picker the search page's selection bar opens. It offers
 * only handlists that hold entities, and it reports the resulting count
 * rather than a bare "Added".
 *
 * A save's UPDATE runs only while the record holds the version the
 * save read, so a save that another lands between the version check and
 * the write changes nothing, logs nothing and gets the conflict
 * response. A successful save returns the new version, and the form
 * submits the version its field values were loaded from
 * (`useFormVersion`), which a loader revalidation does not move.
 *
 * After an edit conflict, the overwrite resubmits the editor's fields
 * with `_force=true`. A forced update that carries none of the editable
 * fields is refused, and a save deletes the autosaved draft only when
 * it carried fields.
 *
 * A hard delete runs only while the record holds the version the delete
 * read and no record is merged into it: a record others were merged
 * into is refused (`merge_survivor`), and one changed between the
 * delete's reads and its batch gets the conflict response. The loader
 * says whether the record is a merge survivor (`isMergeSurvivor`), and
 * the page disables Delete for one, with the reason as its title; a
 * refusal shows the same reason in the error banner.
 *
 * The linked descriptions carry each link's relation as read
 * (`related_to` and the links naming it). An edit or an unlink sends it
 * back, and the action writes only while the link's relation is the one
 * read (`relation-sides.server.ts`): a relation side, and a relation
 * changed since the read, are refused each with its own message.
 *
 * The loader reads the federation's role lists once (`readRolePickers`).
 * The link dialogs offer its approved roles, the worklist and the
 * context cards show its labels, and the worklist's role filter takes
 * any code its document or relation roles hold. A role pill whose links
 * are all relation sides is labelled from the relation roles, as its
 * rows are.
 *
 * The link actions write a role only while the federation's list
 * approves it, checked inside the INSERT or UPDATE
 * (`link-roles.server.ts`); an edit may keep the link's current code
 * even when the list has deprecated it, and a refused role gets the
 * generic refusal.
 *
 * @version v0.9.0
 */

import { useState, useEffect } from "react";
import { Form, useActionData, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { useFormatters } from "~/lib/use-formatters";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { StatusBand } from "~/components/admin/status-band";
import { NameVariantInput } from "~/components/forms/name-variant-input";
import { LodLinkField, SERVICE_URLS } from "~/components/forms/lod-link-field";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import {
  AdminBreadcrumb,
  AuthorityDetailHeader,
} from "~/components/admin/authority-detail-header";
import { HandlistPicker } from "~/components/handlists/handlist-picker";
import { ConflictDialog } from "~/components/admin/conflict-dialog";
import { useAutosaveDraft } from "~/components/admin/use-autosave-draft";
import { useFormVersion, useRecordEditMode } from "~/lib/use-form-version";
import { FieldDisplay } from "~/components/admin/field-display";
import { EditField, EditTextarea } from "~/components/admin/edit-field";
import {
  TwoColumnDetail,
  DetailCard,
  VariantChips,
  NotesCards,
  NotesEditFields,
} from "~/components/admin/authority-detail-layout";
import { LinkedDescriptionsWorklist } from "~/components/admin/linked-descriptions-worklist";
import { parseWorklistParams } from "~/lib/worklist-params";
import type { ENTITY_ROLES } from "~/lib/validation/enums";
import { entityRoleLabel, entityRoleOptions, placeRoleLabel } from "~/lib/role-options";
import { TypeaheadInput } from "~/components/admin/typeahead-input";
import { resolveSubmittedTerm } from "~/lib/typeahead-term.server";
import type { Route } from "./+types/_auth.admin.entities.$id";
import type { BatchItem } from "drizzle-orm/batch";
import { pageMeta, heading } from "../lib/page-title";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function meta(args: Route.MetaArgs) {
  const data = args.data;
  return pageMeta(
    args,
    data?.entity?.displayName,
    heading("entities:title"),
  );
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, or, like, asc, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions, vocabularyTerms, repositories } = await import(
    "~/db/schema"
  );

  const { namedBySql, relatedToSql } = await import("~/lib/relation-sides.server");
  const { namedByList } = await import("~/lib/relation-as-read");

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const entityRow = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
    .get();

  if (!entityRow) {
    throw new Response("Not found", { status: 404 });
  }

  // Functions are the entity's entity_functions rows, one per line.
  const { readEntityFunctionRows, functionsText } = await import("~/lib/entity-functions.server");
  const { officeSql } = await import("~/lib/link-attributes.server");
  const entity = {
    ...entityRow,
    functions: functionsText(await readEntityFunctionRows(db, id)),
  };

  // Click-to-unfold context card (spec §5 worklist enhancement):
  // fetched on demand by junction id, never eager-loaded for the page.
  // Ownership is enforced in the helper — a junction id belonging to
  // another entity resolves to null (an IDOR surface), so the response
  // carries `card: null` rather than a foreign record's scope text.
  const cardUrl = new URL(request.url);
  const cardJunctionId = cardUrl.searchParams.get("card");
  if (cardJunctionId) {
    // "Show all" (`&full=1`): the full OCR transcript for that junction,
    // fetched only on that click — never eager-shipped (transcripts reach
    // 89 KB). Ownership is enforced in the helper identically to the card.
    if (cardUrl.searchParams.get("full") === "1") {
      const { loadJunctionOcrText } = await import(
        "~/lib/authority-linked-context.server"
      );
      const ocrFull = await loadJunctionOcrText(db, {
        recordType: "entity",
        ownerId: id,
        junctionId: cardJunctionId,
        tenantId: tenant.id,
      });
      // A link that is not this record's, or whose description is not
      // this tenant's, has no transcript to show.
      if (ocrFull === null) throw new Response("Not found", { status: 404 });
      return Response.json({ ocrFull });
    }
    const { loadLinkedDescriptionCard } = await import(
      "~/lib/authority-linked-context.server"
    );
    const card = await loadLinkedDescriptionCard(db, {
      recordType: "entity",
      ownerId: id,
      displayName: entity.displayName,
      junctionId: cardJunctionId,
      tenantId: tenant.id,
    });
    return Response.json({ card });
  }

  // Fetch linked vocabulary term for primaryFunction display
  let functionTerm: { id: string; canonical: string; status: string; category: string | null } | null = null;
  if (entity.primaryFunctionId) {
    const term = await db
      .select({
        id: vocabularyTerms.id,
        canonical: vocabularyTerms.canonical,
        status: vocabularyTerms.status,
        category: vocabularyTerms.category,
      })
      .from(vocabularyTerms)
      .where(
        and(
          eq(vocabularyTerms.id, entity.primaryFunctionId),
          eq(vocabularyTerms.federationId, tenant.federationId)
        )
      )
      .get();
    if (term) {
      functionTerm = term;
    }
  }

  // Count this tenant's linked descriptions. The delete action still
  // counts every tenant's links before it deletes.
  const [{ count: descLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .innerJoin(descriptions, eq(descriptionEntities.descriptionId, descriptions.id))
    .where(and(eq(descriptionEntities.entityId, id), eq(descriptions.tenantId, tenant.id)))
    .all();

  // A record others were merged into is not deleted; the page disables
  // Delete for it, and the delete action refuses it.
  const { isMergeSurvivor } = await import("~/lib/entity-functions.server");
  const mergeSurvivor = await isMergeSurvivor(db, id);

  // ---- Linked-descriptions worklist (spec §5 redesign; round-3 filters) ----
  const sp = new URL(request.url).searchParams;
  const wl = parseWorklistParams(sp);
  // The federation's role pickers and labels, read once. A role param
  // its lists do not hold is ignored, never an empty worklist.
  const { readRolePickers } = await import("~/lib/vocabulary.server");
  const roles = await readRolePickers(db, tenant.federationId, context);
  const role =
    wl.role && (Object.hasOwn(roles.labels.entity, wl.role) || Object.hasOwn(roles.labels.relation, wl.role))
      ? (wl.role as (typeof ENTITY_ROLES)[number])
      : null;

  // The record's OWN repository ids (unfiltered): drives repo-pill
  // progressive disclosure (shown only when the links span > 1 repo) and
  // validates the `?repo=` param — an id that is not one of the record's
  // is ignored, never an empty worklist. Keyed by id, not label.
  const recordRepoRows = await db
    .select({ repositoryId: descriptions.repositoryId })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(eq(descriptionEntities.entityId, id), eq(descriptions.tenantId, tenant.id)))
    .groupBy(descriptions.repositoryId)
    .all();
  const recordRepoIds = new Set(recordRepoRows.map((r) => r.repositoryId));
  const repoSpan = recordRepoIds.size;
  const repo = wl.repo && recordRepoIds.has(wl.repo) ? wl.repo : null;

  // Search predicate over the joined description (title + reference
  // code), shared by the counts, the filtered total, and the page.
  // A shared record can be linked from several tenants' descriptions;
  // every list, count and card here reads only the request tenant's.
  const dqConditions: any[] = [
    eq(descriptionEntities.entityId, id),
    eq(descriptions.tenantId, tenant.id),
  ];
  if (wl.dq) {
    const pat = `%${wl.dq}%`;
    dqConditions.push(
      or(
        like(descriptions.title, pat),
        like(descriptions.referenceCode, pat),
      )!,
    );
  }

  // Cross-honest counts (spec §3): role counts under the search AND the
  // repository filter; repo counts under the search AND the role filter.
  const roleCountConditions = repo
    ? [...dqConditions, eq(descriptions.repositoryId, repo)]
    : dqConditions;
  // A pill whose links are all relation sides takes the relation role's
  // label, as its rows do (`relationSide`).
  const { relationSideSql } = await import("~/lib/relation-sides.server");
  const roleCounts = await db
    .select({
      role: descriptionEntities.role,
      count: sql<number>`count(*)`,
      relationSide: sql<number>`min(${relationSideSql()})`.mapWith((v: unknown) => Number(v) === 1),
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...roleCountConditions))
    .groupBy(descriptionEntities.role)
    .orderBy(sql`count(*) DESC`)
    .all();
  const allCount = roleCounts.reduce((sum, rc) => sum + rc.count, 0);

  // Repo pills: GROUP BY repository id, labelled short_name → code → name
  // (COALESCE(NULLIF(...)) — the AHRB repository's short_name is empty at
  // 13k-link scale), under the search + role filter.
  const repoCountConditions = role
    ? [...dqConditions, eq(descriptionEntities.role, role)]
    : dqConditions;
  const repoCounts = await db
    .select({
      repositoryId: descriptions.repositoryId,
      label: sql<string>`COALESCE(NULLIF(${repositories.shortName}, ''), NULLIF(${repositories.code}, ''), ${repositories.name})`,
      count: sql<number>`count(*)`,
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .innerJoin(repositories, eq(descriptions.repositoryId, repositories.id))
    .where(and(...repoCountConditions))
    .groupBy(descriptions.repositoryId)
    .orderBy(sql`count(*) DESC`)
    .all();

  // Honest filtered total (search + role + repo) from a real COUNT.
  const filterConditions: any[] = [...dqConditions];
  if (role) filterConditions.push(eq(descriptionEntities.role, role));
  if (repo) filterConditions.push(eq(descriptions.repositoryId, repo));
  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .all();

  // One page, sorted server-side. Date sorts newest-first with undated
  // rows last; title and reference code sort ascending. The junction id
  // breaks ties so paging is stable.
  const orderBy =
    wl.sort === "title"
      ? [asc(descriptions.title), asc(descriptionEntities.id)]
      : wl.sort === "code"
        ? [asc(descriptions.referenceCode), asc(descriptionEntities.id)]
        : [
            sql`${descriptions.dateStart} IS NULL`,
            sql`${descriptions.dateStart} DESC`,
            asc(descriptionEntities.id),
          ];
  const links = await db
    .select({
      id: descriptionEntities.id,
      descriptionId: descriptionEntities.descriptionId,
      role: descriptionEntities.role,
      roleNote: descriptionEntities.roleNote,
      sequence: descriptionEntities.sequence,
      honorific: descriptionEntities.honorific,
      function: officeSql(),
      nameAsRecorded: descriptionEntities.nameAsRecorded,
      descriptionTitle: descriptions.title,
      referenceCode: descriptions.referenceCode,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      dateStart: descriptions.dateStart,
      dateEnd: descriptions.dateEnd,
      creatorDisplay: descriptions.creatorDisplay,
      placeDisplay: descriptions.placeDisplay,
      // The relation as read, which the link forms send back with an edit
      // or a removal (`relation-as-read.ts`).
      relatedTo: relatedToSql(),
      namedByJoined: namedBySql(),
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .orderBy(...orderBy)
    .limit(wl.size)
    .offset((wl.page - 1) * wl.size)
    .all()
    .then((rows) => rows.map(({ namedByJoined, ...l }) => ({ ...l, namedBy: namedByList(namedByJoined) })));

  // If merged, fetch target entity's displayName + the ledger-derived
  // band actor (who merged it, when). Superseded status is derived from
  // the ledger — no schema column.
  let mergeTarget: { id: string; displayName: string } | null = null;
  let mergeBand: { createdAt: number; user: string } | null = null;
  if (entity.mergedInto) {
    const target = await db
      .select({ id: entities.id, displayName: entities.displayName })
      .from(entities)
      .where(
        and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, entity.mergedInto))
      )
      .get();
    if (target) {
      mergeTarget = target;
    }
    const { getOperationActor } = await import(
      "~/lib/authority-workbench.server"
    );
    const actor = await getOperationActor(db, {
      recordType: "entity",
      operation: "merge",
      sourceId: id,
      targetId: entity.mergedInto,
    });
    if (actor) {
      mergeBand = { createdAt: actor.createdAt, user: actor.userName ?? "" };
    }
  }

  // Informational split bands (spec §4 — both halves stay live and
  // editable): "Split into…" on a split parent, "Split from…" on a
  // record a split created. The merged band takes precedence when the
  // record was later merged away.
  let splitIntoBand: {
    createdAt: number;
    user: string;
    targets: { id: string; displayName: string }[];
  } | null = null;
  let splitFromBand: {
    createdAt: number;
    user: string;
    parent: { id: string; displayName: string };
  } | null = null;
  if (!entity.mergedInto) {
    const { getOperationActor, getSplitTargets } = await import(
      "~/lib/authority-workbench.server"
    );
    const { inArray } = await import("drizzle-orm");

    const targetIds = await getSplitTargets(db, "entity", id);
    if (targetIds.length > 0) {
      const targets = await db
        .select({ id: entities.id, displayName: entities.displayName })
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenant.id),
            inArray(entities.id, targetIds),
          ),
        )
        .all();
      const actor = await getOperationActor(db, {
        recordType: "entity",
        operation: "split",
        sourceId: id,
      });
      if (targets.length > 0 && actor) {
        splitIntoBand = {
          createdAt: actor.createdAt,
          user: actor.userName ?? "",
          targets,
        };
      }
    }

    const fromActor = await getOperationActor(db, {
      recordType: "entity",
      operation: "split",
      targetId: id,
    });
    if (fromActor) {
      const parent = await db
        .select({ id: entities.id, displayName: entities.displayName })
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenant.id),
            eq(entities.id, fromActor.sourceId),
          ),
        )
        .get();
      if (parent) {
        splitFromBand = {
          createdAt: fromActor.createdAt,
          user: fromActor.userName ?? "",
          parent,
        };
      }
    }
  }

  // Check for another user's draft on this record. Entities are
  // federation-shared (migrations 0045-0048), so the conflicting editor may
  // legitimately live in ANY tenant of the session tenant's federation —
  // resolve their name through the tenants join scoped to the
  // federation, not to the session tenant alone (a same-federation
  // cross-tenant editor must not render as "Unknown").
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users, tenants } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, tenant.id, id, "entity", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .innerJoin(tenants, eq(users.tenantId, tenants.id))
      .where(
        and(
          eq(tenants.federationId, tenant.federationId),
          eq(users.id, conflictRaw.userId)
        )
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  const { countHoldingHandlists } = await import("~/lib/handlists.server");
  const holdingHandlists = await countHoldingHandlists(db, tenant, user, id);

  return {
    entity,
    // How many handlists this person can reach already hold it.
    holdingHandlists,
    descLinkCount,
    isMergeSurvivor: mergeSurvivor,
    mergeTarget,
    mergeBand,
    splitIntoBand,
    splitFromBand,
    links,
    total,
    allCount,
    roleCounts,
    repoCounts,
    repoSpan,
    roles,
    wl: {
      dq: wl.dq,
      role,
      repo,
      sort: wl.sort,
      size: wl.size,
      page: wl.page,
    },
    conflictDraft,
    functionTerm,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { authorityScope, requireAuthorityMutation } = await import(
    "~/lib/authority-ownership.server"
  );
  const { requireArea, requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, inArray, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions, vocabularyTerms } = await import(
    "~/db/schema"
  );
  const { updateEntitySchema } = await import("~/lib/validation/entity");
  const { submittedFields, fieldsToWrite } = await import(
    "~/lib/validation/update-schema"
  );
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  // Authority mutation gate helper (2026-07-08 rule as reworked by
  // migration 0067). Applied per-intent below to the canonical entity
  // mutations (update, delete, merge, split). It reads the record's
  // OWNER and branches: this tenant's own record needs only the ordinary
  // admin rights already checked above; a federation-shared record still
  // needs a steward; another tenant's record 404s. NOT applied to
  // autosave (drafts), the read searches, or the description-link
  // intents, which stay open to member-tenant admins (READ + member-side
  // junction ops).

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  // The description-link intents act on this page's entity, which must be
  // one this tenant can see, and on links whose description is the
  // request tenant's. A link row named by id is reached only through
  // both, so another tenant's links can be neither changed nor removed.
  const notFound = () => new Response("Not found", { status: 404 });
  const tenantDescriptions = db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenant.id));
  const linkHere = (linkId: string) =>
    and(
      eq(descriptionEntities.id, linkId),
      eq(descriptionEntities.entityId, id),
      inArray(descriptionEntities.descriptionId, tenantDescriptions),
    );
  if (
    intent === "link_description" ||
    intent === "edit_description_link" ||
    intent === "unlink_description"
  ) {
    const visible = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, id), authorityScope(entities, tenant.federationId, tenant.id)))
      .get();
    if (!visible) throw notFound();
  }

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, tenant.id, id, "entity", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      await requireAuthorityMutation(db, user, tenant, "entity", [id]);
      // Each field is read only when the request carries it: a field
      // absent from the request (a section the page did not submit) is
      // absent from the values and is never written, and the entity's
      // function rows are replaced only when `functions` is carried. A
      // blank field the request carries is cleared (null), except the
      // NOT NULL ones, which a blank leaves as stored.
      const { has, trimmed } = submittedFields(formData);
      const input: Record<string, unknown> = { id };
      for (const name of ["displayName", "sortName", "entityType"] as const) {
        if (has(name)) input[name] = trimmed(name) || undefined;
      }
      for (const name of [
        "surname",
        "givenName",
        "honorific",
        "primaryFunction",
        "datesOfExistence",
        "dateStart",
        "dateEnd",
        "history",
        "sources",
        "wikidataId",
        "viafId",
        "notes",
        "internalNotes",
      ] as const) {
        if (has(name)) input[name] = trimmed(name) || null;
      }
      if (has("nameVariants")) {
        let nameVariants: string[] = [];
        try {
          nameVariants = JSON.parse((formData.get("nameVariants") as string) || "[]");
        } catch {
          nameVariants = [];
        }
        input.nameVariants = JSON.stringify(nameVariants);
      }
      // One function per line, written to entity_functions below.
      const { functionLines, functionsText, readEntityFunctionRows, entityFunctionsReplacement } =
        await import("~/lib/entity-functions.server");
      const { distinctFunctionLines } = await import("~/lib/function-duplicates");
      const functionsSubmitted = has("functions");
      // The entity's function rows before the save, for the diff and to
      // keep the rows a kept line names. A line that would add a
      // function the record keeps or adds already is dropped.
      const existingFunctions = await readEntityFunctionRows(db, id);
      const lines = distinctFunctionLines(
        functionLines(formData.get("functions") as string | null),
        existingFunctions
      );
      if (functionsSubmitted) input.functions = lines.join("\n") || null;

      // Several of these fields are optional but not nullable in the
      // schema, so a cleared field is validated as absent and carried
      // back as null after parsing.
      const cleared = Object.keys(input).filter((key) => input[key] === null);
      const parsed = updateEntitySchema.safeParse(
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null))
      );

      if (!parsed.success) {
        return {
          ok: false as const,
          errors: parsed.error.flatten().fieldErrors,
        };
      }

      // Fetch original for changelog diff
      const original = await db
        .select()
        .from(entities)
        .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
        .get();

      // Optimistic lock check
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      // Whether the request carries any field the editor submits. An
      // overwrite after a conflict resubmits the editor's fields; a
      // forced update without any would write nothing and report
      // success while the user's edits stay unsaved, so it is refused.
      const carriesFields = Object.keys(input).some((key) => key !== "id");
      if (forceOverwrite && !carriesFields) {
        return { ok: false as const, error: "generic" };
      }
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        original &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedAt: original.updatedAt,
        };
      }

      if (!original) throw new Response("Not found", { status: 404 });

      const { id: _id, ...parsedUpdates } = parsed.data;
      const updates: Record<string, unknown> = {
        ...parsedUpdates,
        ...Object.fromEntries(cleared.map((key) => [key, null])),
      };

      // Resolve primaryFunctionId from the typeahead, only when the
      // request carries the primary function: without it the stored
      // term link stays as it is.
      const primaryFunctionSubmitted = has("primaryFunction");
      let resolvedFunctionId: string | null = null;
      const primaryFunctionIdRaw = trimmed("primaryFunctionId");
      const primaryFunctionText = (updates.primaryFunction as string | null | undefined) ?? null;

      // The hidden id bypasses the Zod schema and feeds an FK column, so
      // it must name a term of this federation, or the whole UPDATE
      // would fail and lose every other edit; a missing term fails
      // field-scoped. The id is kept while the text still names the
      // pick (its current name, or its name as picked), and a merged
      // term is followed to its survivor.
      const functionResolution =
        primaryFunctionSubmitted && primaryFunctionIdRaw
          ? await resolveSubmittedTerm(
              db,
              tenant.federationId,
              primaryFunctionIdRaw,
              primaryFunctionText,
              trimmed("primaryFunctionSelectedText") || null
            )
          : null;
      if (functionResolution?.kind === "missing") {
        return {
          ok: false as const,
          errors: {
            primaryFunction: [
              "Selected function no longer exists; reselect or retype it",
            ],
          },
        };
      }

      if (functionResolution?.kind === "use") {
        resolvedFunctionId = functionResolution.id;
        // The text stored is the kept term's current name, whatever the
        // request carried.
        updates.primaryFunction = functionResolution.canonical;
      } else if (primaryFunctionSubmitted && primaryFunctionText) {
        // User typed a value -- check if it matches an existing term (case-insensitive)
        const { like: likeFn, isNull: isNullFn } = await import("drizzle-orm");
        const existingTerm = await db
          .select({ id: vocabularyTerms.id })
          .from(vocabularyTerms)
          .where(
            and(
              eq(vocabularyTerms.federationId, tenant.federationId),
              sql`LOWER(${vocabularyTerms.canonical}) = LOWER(${primaryFunctionText})`,
              isNullFn(vocabularyTerms.mergedInto)
            )
          )
          .get();

        if (existingTerm) {
          resolvedFunctionId = existingTerm.id;
        } else {
          // Create proposed term
          const newTermId = crypto.randomUUID();
          const now = Date.now();
          await db.insert(vocabularyTerms).values({
            id: newTermId,
            federationId: tenant.federationId,
            canonical: primaryFunctionText,
            category: null,
            status: "proposed",
            entityCount: 0,
            proposedBy: user.id,
            createdAt: now,
            updatedAt: now,
          });
          resolvedFunctionId = newTermId;
        }
      }

      const updatedFields = fieldsToWrite(
        {
          ...updates,
          ...(primaryFunctionSubmitted ? { primaryFunctionId: resolvedFunctionId } : {}),
        },
        {
          ...original,
          functions: functionsText(existingFunctions),
        } as unknown as Record<string, unknown>
      );

      // The functions go to entity_functions, never to the column.
      const { functions: _functionsText, ...entityFields } = updatedFields;

      const { nextVersion } = await import("~/lib/record-version.server");
      const savedVersion = nextVersion(original.updatedAt);
      try {
        // Every statement runs only while the entity holds the version
        // read above (which the form's version was checked against), the
        // entity update last: a save that another lands before loses the
        // whole batch, and the update's changes count says so. The new
        // version is past the one read even when the clock is not, so a
        // merge that read the old version always sees the save. The
        // function rows are replaced only when the request carries them.
        const now = savedVersion;
        const { functionStatements } = functionsSubmitted
          ? entityFunctionsReplacement(db, id, lines, existingFunctions, original.updatedAt, now)
          : { functionStatements: [] };
        const results = await db.batch([
          ...functionStatements,
          db
            .update(entities)
            .set({ ...entityFields, updatedAt: now })
            .where(
              and(
                authorityScope(entities, tenant.federationId, tenant.id),
                eq(entities.id, id),
                eq(entities.updatedAt, original.updatedAt)
              )
            ),
        ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
        if (((results.at(-1) as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
          const current = await db
            .select({ updatedAt: entities.updatedAt })
            .from(entities)
            .where(eq(entities.id, id))
            .get();
          return {
            ok: false as const,
            error: "conflict" as const,
            modifiedAt: current?.updatedAt ?? original.updatedAt,
          };
        }

        // Update entity count on the vocabulary term
        if (resolvedFunctionId) {
          const [{ count: entityCountForTerm }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(entities)
            .where(
              and(
                authorityScope(entities, tenant.federationId, tenant.id),
                eq(entities.primaryFunctionId, resolvedFunctionId)
              )
            )
            .all();
          await db
            .update(vocabularyTerms)
            .set({ entityCount: entityCountForTerm, updatedAt: Date.now() })
            .where(
              and(
                eq(vocabularyTerms.id, resolvedFunctionId),
                eq(vocabularyTerms.federationId, tenant.federationId)
              )
            );
        }
      } catch (e) {
        // Residual race: the term can still vanish between the
        // existence check above and the UPDATE. Surface it on the
        // field rather than as the generic failure.
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("FOREIGN KEY constraint failed")) {
          return {
            ok: false as const,
            errors: {
              primaryFunction: [
                "Selected function no longer exists; reselect or retype it",
              ],
            },
          };
        }
        return { ok: false as const, error: "generic" };
      }

      // Compute diff and create changelog entry
      if (original) {
        const { computeDiff, createChangelogEntry } = await import(
          "~/lib/changelog.server"
        );
        const diff = computeDiff(
          {
            ...original,
            functions: functionsText(existingFunctions),
          } as unknown as Record<string, unknown>,
          updatedFields as unknown as Record<string, unknown>
        );
        if (diff) {
          const commitNote =
            (formData.get("commitNote") as string)?.trim() || undefined;
          await createChangelogEntry(db, id, "entity", user.id, diff, commitNote);
        }
      }

      // The saved fields supersede the autosaved draft. A request that
      // carried none of them saved nothing, and the draft is kept.
      if (carriesFields) {
        const { deleteDraft } = await import("~/lib/drafts.server");
        await deleteDraft(db, tenant.id, id, "entity");
      }

      // The new version, which the form submits with its next save.
      return { ok: true as const, message: "updated", updatedAt: savedVersion };
    }

    case "delete": {
      // Deleting a record is administration, which a staff grant does not have.
      requireArea(user, "authorities");
      await requireAuthorityMutation(db, user, tenant, "entity", [id]);
      // Server-side cascade check
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptionEntities)
        .where(eq(descriptionEntities.entityId, id))
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      // Snapshot the full row before deletion so the ledger row makes the
      // hard delete reconstructible (delete is unrecorded and unrecoverable
      // today). The delete + ledger insert share one batch: source_id is
      // the gone record's id and carries no FK, so ordering is free.
      const original = await db
        .select()
        .from(entities)
        .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
        .get();
      if (!original) {
        return redirect("/admin/entities");
      }

      // A record others were merged into holds their functions and is
      // their pointer's target; deleting it would cascade the functions
      // away and leave the pointers dangling. The batch opens with guards
      // that the record still holds the version read and is no merge's
      // survivor, so a merge or save between these reads and the batch
      // fails it whole.
      const {
        entitiesAsReadGuard,
        entitiesStillAsRead,
        entityNotMergeSurvivorGuard,
        isMergeSurvivor,
      } = await import("~/lib/entity-functions.server");
      if (await isMergeSurvivor(db, id)) {
        return { ok: false as const, error: "merge_survivor" };
      }
      const asRead = [{ id, version: original.updatedAt }];
      try {
        await db.batch([
          entitiesAsReadGuard(db, asRead),
          entityNotMergeSurvivorGuard(db, id),
          db
            .delete(entities)
            .where(
              and(
                authorityScope(entities, tenant.federationId, tenant.id),
                eq(entities.id, id),
                eq(entities.updatedAt, original.updatedAt)
              )
            ),
          logAuthorityOperation(db, {
            federationId: tenant.federationId,
            recordType: "entity",
            operation: "delete",
            sourceId: id,
            targetId: null,
            userId: user.id,
            detail: { snapshot: original },
          }),
        ] as any);
      } catch (err) {
        if (await isMergeSurvivor(db, id)) {
          return { ok: false as const, error: "merge_survivor" };
        }
        if (await entitiesStillAsRead(db, asRead)) throw err;
        const current = await db
          .select({ updatedAt: entities.updatedAt })
          .from(entities)
          .where(eq(entities.id, id))
          .get();
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedAt: current?.updatedAt ?? original.updatedAt,
        };
      }
      return redirect("/admin/entities");
    }

    case "search-functions": {
      const q = (formData.get("q") as string)?.trim();
      if (!q || q.length < 2) return { searchResults: [] };
      const { like, isNull } = await import("drizzle-orm");
      const results = await db
        .select({
          id: vocabularyTerms.id,
          canonical: vocabularyTerms.canonical,
          category: vocabularyTerms.category,
        })
        .from(vocabularyTerms)
        .where(
          and(
            eq(vocabularyTerms.federationId, tenant.federationId),
            like(vocabularyTerms.canonical, `%${q}%`),
            isNull(vocabularyTerms.mergedInto),
            eq(vocabularyTerms.status, "approved")
          )
        )
        .limit(8)
        .all();
      return { searchResults: results };
    }

    case "search_descriptions": {
      const q = (formData.get("q") as string)?.trim();
      if (!q || q.length < 2) return Response.json({ results: [] });
      const results = await db
        .select({
          id: descriptions.id,
          title: descriptions.title,
          referenceCode: descriptions.referenceCode,
          descriptionLevel: descriptions.descriptionLevel,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            sql`(${descriptions.title} LIKE ${"%" + q + "%"} OR ${descriptions.referenceCode} LIKE ${"%" + q + "%"})`
          )
        )
        .limit(20)
        .all();
      return Response.json({ results });
    }

    case "link_description": {
      const descriptionId = formData.get("descriptionId") as string;
      const { roleCode } = await import("~/lib/role-options");
      const role = roleCode(formData.get("role") as string | null);
      if (!descriptionId || !role) {
        return { ok: false as const, error: "generic" };
      }
      const description = await db
        .select({ id: descriptions.id })
        .from(descriptions)
        .where(and(eq(descriptions.id, descriptionId), eq(descriptions.tenantId, tenant.id)))
        .get();
      if (!description) throw notFound();
      // The role is checked inside the INSERT: a code the federation's
      // list does not approve, at the moment of the write, writes nothing.
      const { insertEntityLink } = await import("~/lib/link-roles.server");
      try {
        const written = await insertEntityLink(db, tenant.federationId, {
          id: crypto.randomUUID(),
          descriptionId,
          entityId: id,
          role,
          sequence: 0,
          createdAt: Date.now(),
        });
        if (!written) return { ok: false as const, error: "generic" };
      } catch (e) {
        if (String(e).includes("UNIQUE constraint failed")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const };
    }

    case "edit_description_link": {
      const linkId = formData.get("linkId") as string;
      const { roleCode } = await import("~/lib/role-options");
      const role = roleCode(formData.get("role") as string | null);
      if (!linkId || !role) {
        return { ok: false as const, error: "generic" };
      }
      const roleNote = (formData.get("roleNote") as string)?.trim() || null;
      const sequence = parseInt(formData.get("sequence") as string, 10) || 0;
      const honorific = (formData.get("honorific") as string)?.trim() || null;
      const func = (formData.get("function") as string)?.trim() || null;
      const { withOfficeSql } = await import("~/lib/link-attributes.server");
      const nameAsRecorded =
        (formData.get("nameAsRecorded") as string)?.trim() || null;
      const link = await db
        .select({ id: descriptionEntities.id })
        .from(descriptionEntities)
        .where(linkHere(linkId))
        .get();
      if (!link) throw notFound();
      // A relation side is not edited from this form. The UPDATE carries
      // the relation the form read, outside every relation, so a change to
      // it that lands in between is refused, not overwritten
      // (relation-sides.server.ts).
      const { relationRefusal, updateLinkAsRead } = await import("~/lib/relation-sides.server");
      const { OUTSIDE_RELATIONS, isRelationSide, relationAsReadFrom } = await import("~/lib/relation-as-read");
      const asRead = relationAsReadFrom(formData);
      if (asRead && isRelationSide(asRead)) return { ok: false as const, error: "relation_side_save" as const };
      // The role is checked inside the UPDATE: the link's current code, or
      // one the federation's list approves at the moment of the write.
      const { roleKeptOrApprovedSql } = await import("~/lib/link-roles.server");
      const roleAllowed = roleKeptOrApprovedSql(descriptionEntities.role, tenant.federationId, "entity_role", role);
      const updated = await updateLinkAsRead(db, linkId, and(linkHere(linkId), roleAllowed), asRead ?? OUTSIDE_RELATIONS, {
        role: role as (typeof ENTITY_ROLES)[number], roleNote, sequence, honorific, attributes: withOfficeSql(func), nameAsRecorded,
      });
      if (!updated) {
        const refusal = await relationRefusal(db, linkId, linkHere(linkId), asRead, "save");
        if (refusal === null) throw notFound();
        return { ok: false as const, error: refusal };
      }
      return { ok: true as const };
    }

    case "unlink_description": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) {
        return { ok: false as const, error: "generic" };
      }
      const link = await db
        .select({ id: descriptionEntities.id })
        .from(descriptionEntities)
        .where(linkHere(linkId))
        .get();
      if (!link) throw notFound();
      // Removing a relation side would leave its partner naming a link
      // that is gone, with no kept link to repoint it to. The DELETE
      // carries the relation the form read, outside every relation, so a
      // change to it that lands in between is refused.
      const { deleteLinkAsRead, relationRefusal } = await import("~/lib/relation-sides.server");
      const { OUTSIDE_RELATIONS, isRelationSide, relationAsReadFrom } = await import("~/lib/relation-as-read");
      const asRead = relationAsReadFrom(formData);
      if (asRead && isRelationSide(asRead)) return { ok: false as const, error: "relation_side_remove" as const };
      if (!(await deleteLinkAsRead(db, linkId, linkHere(linkId), asRead ?? OUTSIDE_RELATIONS))) {
        const refusal = await relationRefusal(db, linkId, linkHere(linkId), asRead, "remove");
        if (refusal === null) throw notFound();
        return { ok: false as const, error: refusal };
      }
      return { ok: true as const };
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EntityDetailPage({
  loaderData,
}: Route.ComponentProps) {
  // The loader sends the band's raw timestamp so its day is formatted
  // in the same zone as every other date on the page.
  const { formatIsoDateTime } = useFormatters();
  const bandDay = (createdAt: number) => formatIsoDateTime(createdAt).slice(0, 10);
  const {
    entity,
    holdingHandlists,
    descLinkCount,
    isMergeSurvivor,
    mergeTarget,
    mergeBand,
    splitIntoBand,
    splitFromBand,
    links,
    total,
    allCount,
    roleCounts,
    repoCounts,
    repoSpan,
    wl,
    roles,
    conflictDraft,
    functionTerm,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("entities");
  const { t: ta } = useTranslation("authorities");
  // The handlists namespace owns every string the picker says,
  // including the label on the control that opens it.
  const { t: th } = useTranslation("handlists");

  // Edit mode belongs to the record it was opened on: following a link
  // to another entity leaves it, so the form's inputs and its version
  // always come from the same load.
  const [isEditing, setIsEditing] = useRecordEditMode(entity.id);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasDescriptions = descLinkCount > 0;
  const isMerged = !!entity.mergedInto;

  // Show conflict dialog when server returns optimistic lock error
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error === "conflict") {
      setShowConflictDialog(true);
    }
  }, [actionData]);

  // Autosave via shared debounced-draft hook
  const { formRef, handleFormChange, draftStatus } = useAutosaveDraft(isEditing);
  // The version the form's field values were loaded from, which it
  // submits; a loader revalidation does not move it.
  const formVersion = useFormVersion(`${entity.id}:${isEditing}`, entity.updatedAt, actionData);

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

  // Parse name variants for display
  let nameVariantsList: string[] = [];
  try {
    nameVariantsList = JSON.parse(entity.nameVariants || "[]");
  } catch {
    nameVariantsList = [];
  }

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Breadcrumb */}
      <AdminBreadcrumb
        rootTo="/admin/entities"
        rootLabel={t("title")}
        current={entity.displayName}
      />

      {/* Title row: name + code + type, and the record actions */}
      <AuthorityDetailHeader
        title={entity.displayName}
        isEditing={isEditing}
        isMerged={isMerged}
        hasDescriptions={hasDescriptions}
        descLinkCount={descLinkCount}
        mergeTo={`/admin/entities/${entity.id}/merge`}
        splitTo={`/admin/entities/${entity.id}/split`}
        onEdit={() => setIsEditing(true)}
        onDelete={() => setShowDeleteModal(true)}
        deleteBlockedReason={isMergeSurvivor ? t("deleteBlockedMergeSurvivor") : undefined}
        extraActions={
          <HandlistPicker
            recordType="entities"
            memberIds={[entity.id]}
            triggerLabel={th("pickerAddTitle")}
            holdingCount={holdingHandlists}
          />
        }
        t={t}
      />
      <p className="mt-0.5 font-mono text-12 text-stone-500">
        {[
          entity.entityCode,
          entity.entityType === "person"
            ? t("person")
            : entity.entityType === "family"
              ? t("family")
              : t("corporate"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
            namespace="entities"
          />
        </div>
      )}

      {/* Autosave status */}
      {isEditing && draftStatus && (
        <p className="mt-2 text-xs text-stone-400">
          {draftStatus === "saving"
            ? t("autosave_saving")
            : t("autosave_saved")}
        </p>
      )}

      {/* Superseded status band (ledger-derived) */}
      {isMerged && mergeTarget && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="merged"
            date={mergeBand ? bandDay(mergeBand.createdAt) : ""}
            user={mergeBand?.user || ta("bandUnknownUser")}
            survivor={{
              id: mergeTarget.id,
              name: mergeTarget.displayName,
              href: `/admin/entities/${mergeTarget.id}`,
            }}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}

      {/* Informational split bands — the record stays live and editable */}
      {splitIntoBand && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="split"
            date={bandDay(splitIntoBand.createdAt)}
            user={splitIntoBand.user || ta("bandUnknownUser")}
            records={splitIntoBand.targets.map((r) => ({
              id: r.id,
              name: r.displayName,
              href: `/admin/entities/${r.id}`,
            }))}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}
      {splitFromBand && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="splitFrom"
            date={bandDay(splitFromBand.createdAt)}
            user={splitFromBand.user || ta("bandUnknownUser")}
            parent={{
              id: splitFromBand.parent.id,
              name: splitFromBand.parent.displayName,
              href: `/admin/entities/${splitFromBand.parent.id}`,
            }}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("successUpdated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && globalError !== "conflict" && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "has_descriptions"
            ? t("deleteBlocked", { count: descLinkCount })
            : globalError === "merge_survivor"
              ? t("deleteBlockedMergeSurvivor")
              : t("errorGeneric")}
        </div>
      )}

      {/* Two columns: the record on the left (always visible), the
          linked-descriptions worklist on the right. Toggling edit swaps
          only the left column's content — the worklist keeps its
          position in the tree and never remounts. */}
      <TwoColumnDetail
        left={
          isEditing ? (
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <EditMode
                entity={entity}
                nameVariantsList={nameVariantsList}
                functionTerm={functionTerm}
                errors={errors}
                t={t}
                onDiscard={() => setIsEditing(false)}
                formRef={formRef}
                onFormChange={handleFormChange}
                formVersion={formVersion}
              />
            </div>
          ) : (
            <ViewCards
              entity={entity}
              nameVariantsList={nameVariantsList}
              functionTerm={functionTerm}
              isMerged={isMerged}
              t={t}
            />
          )
        }
        right={
          <LinkedDescriptionsWorklist
            links={links}
            total={total}
            allCount={allCount}
            recordTotal={descLinkCount}
            roleCounts={roleCounts}
            repoCounts={repoCounts}
            repoSpan={repoSpan}
            dq={wl.dq}
            role={wl.role}
            repo={wl.repo}
            sort={wl.sort}
            size={wl.size}
            page={wl.page}
            isMerged={isMerged}
            roleOptions={entityRoleOptions(roles)}
            recordId={entity.id}
            recordType="entity"
            showEntityFields={true}
            roleLabel={(r, relationSide) => entityRoleLabel(roles.labels, r, relationSide)}
            placeRoleLabel={(r) => placeRoleLabel(roles.labels, r)}
            t={t}
            ta={ta}
          />
        }
      />

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowDeleteModal(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="delete-modal-title"
            aria-describedby="delete-modal-body"
            className="max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("deleteTitle")}
            </h2>
            <p
              id="delete-modal-body"
              className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto"
            >
              {t("deleteBody", { name: entity.displayName })}
            </p>
            <div className="mt-3">
              <label
                htmlFor="delete-confirm-input"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {t("field.entityCode")}: {entity.entityCode}
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                autoComplete="off"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("mergeCancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  disabled={deleteConfirmation !== entity.entityCode}
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("deleteButton")}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}

      {/* Optimistic lock conflict dialog */}
      {showConflictDialog &&
        actionData &&
        "error" in actionData &&
        actionData.error === "conflict" && (
          <ConflictDialog
            modifiedByName=""
            modifiedAt={
              "modifiedAt" in actionData
                ? (actionData.modifiedAt as number)
                : null
            }
            formRef={formRef}
            onCancel={() => setShowConflictDialog(false)}
            t={t}
          />
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode — always-visible cards with real values
// ---------------------------------------------------------------------------

function ViewCards({
  entity,
  nameVariantsList,
  functionTerm,
  isMerged,
  t,
}: {
  entity: any;
  nameVariantsList: string[];
  functionTerm: { id: string; canonical: string; status: string; category: string | null } | null;
  isMerged: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // DBE has no stable public URL scheme on record — rendered as a
  // value, never an invented link.
  const lodLinks: Array<{
    label: string;
    value: string | null;
    href: ((id: string) => string) | null;
  }> = [
    {
      label: t("field.wikidataId"),
      value: entity.wikidataId,
      href: SERVICE_URLS.wikidata,
    },
    { label: t("field.viafId"), value: entity.viafId, href: SERVICE_URLS.viaf },
    { label: t("field.dbeId"), value: entity.dbeId, href: null },
  ];
  return (
    <div>
      {/* Identity */}
      <DetailCard title={t("sectionIdentity")} dimmed={isMerged}>
        <div className="space-y-2.5">
          <FieldDisplay
            label={t("field.displayName")}
            value={entity.displayName}
          />
          <FieldDisplay label={t("field.sortName")} value={entity.sortName} />
          <div className="grid grid-cols-3 gap-4">
            <FieldDisplay label={t("field.surname")} value={entity.surname} />
            <FieldDisplay
              label={t("field.givenName")}
              value={entity.givenName}
            />
            <FieldDisplay
              label={t("field.honorific")}
              value={entity.honorific}
            />
          </div>
          <FieldDisplay
            label={t("field.entityType")}
            value={
              entity.entityType === "person"
                ? t("person")
                : entity.entityType === "family"
                  ? t("family")
                  : t("corporate")
            }
          />
          <div>
            <p className="text-xs text-stone-500">{t("field.nameVariants")}</p>
            <VariantChips variants={nameVariantsList} />
          </div>
        </div>
      </DetailCard>

      {/* Description */}
      <DetailCard title={t("sectionDescription")} dimmed={isMerged}>
        <div className="space-y-2.5">
          <FieldDisplay
            label={t("field.datesOfExistence")}
            value={entity.datesOfExistence}
          />
          <div className="grid grid-cols-2 gap-4">
            <FieldDisplay
              label={t("field.dateStart")}
              value={entity.dateStart}
            />
            <FieldDisplay label={t("field.dateEnd")} value={entity.dateEnd} />
          </div>
          <FieldDisplay label={t("field.history")} value={entity.history} />
          <div>
            <p className="text-xs text-stone-500">
              {t("field.primaryFunction")}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm text-stone-700">
                {functionTerm?.canonical ?? entity.primaryFunction ?? "—"}
              </p>
              {functionTerm?.status === "proposed" && (
                <span className="rounded-full bg-saffron-tint px-2 py-0.5 text-xs font-semibold text-saffron-deep">
                  Proposed
                </span>
              )}
            </div>
          </div>
          {/* legalStatus dropped in 0036 (0% populated). */}
          <FieldDisplay label={t("field.functions")} value={entity.functions} />
        </div>
      </DetailCard>

      {/* Control */}
      <DetailCard title={t("sectionControl")} dimmed={isMerged}>
        <FieldDisplay label={t("field.sources")} value={entity.sources} />
      </DetailCard>

      {/* Linked open data */}
      <DetailCard title={t("sectionLod")} dimmed={isMerged}>
        <div className="space-y-2.5">
          {lodLinks.map(({ label, value, href }) => (
            <div key={label}>
              <p className="text-xs text-stone-500">{label}</p>
              {value ? (
                href ? (
                  <a
                    href={href(value)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-13 font-semibold text-verdigris-deep hover:underline"
                  >
                    {value}
                  </a>
                ) : (
                  <p className="font-mono text-13 text-stone-700">{value}</p>
                )
              ) : (
                <p className="text-sm text-stone-700">{"—"}</p>
              )}
            </div>
          ))}
        </div>
      </DetailCard>

      {/* Notes — each card shows only when its value is non-empty. */}
      <NotesCards
        notes={entity.notes}
        internalNotes={entity.internalNotes}
        notesLabel={t("sectionNotes")}
        internalNotesLabel={t("sectionInternalNotes")}
        internalBadge={t("internalBadge")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  entity,
  nameVariantsList,
  functionTerm,
  errors,
  t,
  onDiscard,
  formRef,
  onFormChange,
  formVersion,
}: {
  entity: any;
  nameVariantsList: string[];
  functionTerm: { id: string; canonical: string; status: string; category: string | null } | null;
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
  /** The version the form's field values were loaded from, submitted as `_updatedAt`. */
  formVersion: number;
}) {
  const [nameVariants, setNameVariants] = useState<string[]>(nameVariantsList);
  const [wikidataId, setWikidataId] = useState(entity.wikidataId || "");
  const [viafId, setViafId] = useState(entity.viafId || "");

  return (
    <Form method="post" ref={formRef} onChange={onFormChange}>
      <input type="hidden" name="_action" value="update" />
      <input
        type="hidden"
        name="_updatedAt"
        value={String(formVersion)}
      />
      <input
        type="hidden"
        name="nameVariants"
        value={JSON.stringify(nameVariants)}
      />
      <input type="hidden" name="wikidataId" value={wikidataId} />
      <input type="hidden" name="viafId" value={viafId} />

      {/* Identity area */}
      <CollapsibleSection title={t("sectionIdentity")}>
        <div className="space-y-4">
          <EditField
            name="displayName"
            label={t("field.displayName")}
            defaultValue={entity.displayName}
            required
            error={errors?.displayName?.[0]}
          />
          <EditField
            name="sortName"
            label={t("field.sortName")}
            defaultValue={entity.sortName}
            required
            error={errors?.sortName?.[0]}
          />
          <div className="grid grid-cols-3 gap-4">
            <EditField
              name="surname"
              label={t("field.surname")}
              defaultValue={entity.surname ?? ""}
              error={errors?.surname?.[0]}
            />
            <EditField
              name="givenName"
              label={t("field.givenName")}
              defaultValue={entity.givenName ?? ""}
              error={errors?.givenName?.[0]}
            />
            <EditField
              name="honorific"
              label={t("field.honorific")}
              defaultValue={entity.honorific ?? ""}
              error={errors?.honorific?.[0]}
            />
          </div>
          <div>
            <label
              htmlFor="entityType"
              className="mb-1 block text-xs font-medium text-indigo"
            >
              {t("field.entityType")}
              <span className="text-madder"> *</span>
            </label>
            <select
              id="entityType"
              name="entityType"
              defaultValue={entity.entityType}
              aria-required="true"
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              <option value="person">{t("person")}</option>
              <option value="family">{t("family")}</option>
              <option value="corporate">{t("corporate")}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.entityCode")}
            </label>
            <p className="text-sm text-stone-700">{entity.entityCode}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.nameVariants")}
            </label>
            <NameVariantInput
              value={nameVariants}
              onChange={setNameVariants}
              addLabel={t("addVariant")}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* Description area */}
      <CollapsibleSection title={t("sectionDescription")}>
        <div className="space-y-4">
          <EditField
            name="datesOfExistence"
            label={t("field.datesOfExistence")}
            defaultValue={entity.datesOfExistence ?? ""}
            error={errors?.datesOfExistence?.[0]}
          />
          <div className="grid grid-cols-2 gap-4">
            <EditField
              name="dateStart"
              label={t("field.dateStart")}
              defaultValue={entity.dateStart ?? ""}
              error={errors?.dateStart?.[0]}
            />
            <EditField
              name="dateEnd"
              label={t("field.dateEnd")}
              defaultValue={entity.dateEnd ?? ""}
              error={errors?.dateEnd?.[0]}
            />
          </div>
          <EditTextarea
            name="history"
            label={t("field.history")}
            defaultValue={entity.history ?? ""}
            error={errors?.history?.[0]}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.primaryFunction")}
            </label>
            <TypeaheadInput
              name="primaryFunction"
              defaultValue={functionTerm?.canonical ?? entity.primaryFunction ?? ""}
              defaultTermId={entity.primaryFunctionId ?? ""}
              defaultTermStatus={functionTerm?.status}
              searchEndpoint={`/admin/entities/${entity.id}`}
              placeholder={t("primary_function_placeholder")}
            />
            {errors?.primaryFunction?.[0] && (
              <p className="mt-1 text-xs text-madder">
                {errors.primaryFunction[0]}
              </p>
            )}
          </div>
          {/* legalStatus form field removed alongside the column
              drop in drizzle/0036_union_schema.sql (0% populated). */}
          <EditTextarea
            name="functions"
            label={t("field.functions")}
            defaultValue={entity.functions ?? ""}
            error={errors?.functions?.[0]}
          />
        </div>
      </CollapsibleSection>

      {/* Control area */}
      <CollapsibleSection title={t("sectionControl")}>
        <div className="space-y-4">
          <EditTextarea
            name="sources"
            label={t("field.sources")}
            defaultValue={entity.sources ?? ""}
            error={errors?.sources?.[0]}
          />
          <LodLinkField
            label={t("field.wikidataId")}
            value={wikidataId}
            onChange={setWikidataId}
            service="wikidata"
            error={errors?.wikidataId?.[0]}
          />
          <LodLinkField
            label={t("field.viafId")}
            value={viafId}
            onChange={setViafId}
            service="viaf"
            error={errors?.viafId?.[0]}
          />
        </div>
      </CollapsibleSection>

      {/* Notes area */}
      <CollapsibleSection title={t("sectionNotes")}>
        <NotesEditFields
          notes={entity.notes}
          internalNotes={entity.internalNotes}
          notesLabel={t("field.notes")}
          internalNotesLabel={t("field.internalNotes")}
          internalBadge={t("internalBadge")}
        />
      </CollapsibleSection>

      {/* Actions */}
      <div className="mt-6 space-y-3 border-t border-stone-200 pt-4">
        <input
          type="text"
          name="commitNote"
          placeholder={t("commit_note_placeholder")}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("editSave")}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("discardButton")}
          </button>
        </div>
      </div>
    </Form>
  );
}

/* @version v0.9.0 */
