/**
 * Descriptions Admin — Edit
 *
 * This route is the standard-aware editor for a single archival
 * description. Surfaces every section defined by the active descriptive
 * standard (resolved from `tenant.descriptiveStandard` via
 * `getStandardConfig`) plus the bibliographic, digital, and entity/
 * place linker primitives the renderer composes. Autosaves to `drafts`
 * on a debounce and writes a diff to `changelog` on explicit save so
 * every edit is auditable. A conflict banner warns when another user
 * holds an open draft on the same record.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `descriptions`,
 * `repositories`, and `users` is filtered by `tenant.id`;
 * description-entities and description-places joins inherit tenant
 * scope through the parent `descriptions.tenantId`.
 *
 * The `case "update"` branch invokes the standard-aware validator
 * factory
 * (`descriptionValidatorFor(tenant.descriptiveStandard,
 * desc.descriptionLevel)`) before the DB write — this is the single
 * write boundary the per-standard mandatoriness rules enforce. The
 * `case "autosave"` branch is INTENTIONALLY untouched: autosave
 * writes to the `drafts` table, which is a forgiving snapshot
 * store; only the explicit save path crosses into `descriptions` and
 * only that path enforces the validator.
 *
 * The update writes only the fields the request carries, and of those
 * only the ones that change the stored row; the changelog records the
 * same set. Each standard's form renders a subset of the description
 * columns, so a save never touches the columns its standard leaves
 * out. The digital-flag checkbox travels with a hidden input of the
 * same name, so an unchecked box reads as false and a request without
 * the name leaves the flag as stored.
 *
 * The header's "Add to handlist" is the browse-time half of how a
 * handlist gets built: one record at a time, from its own page, through
 * the same type-matched picker the search page's selection bar opens.
 * It offers only handlists that hold records, and it reports the
 * resulting count rather than a bare "Added".
 *
 * Beside it, on a workspace with the digitization capability and for
 * someone who works in capture (`canQueue`), "Add to digitization
 * queue" adds the description, and "Add the N descriptions below this" adds
 * the deepest volume or file on each branch below it (the rule the add
 * route applies). The loader counts them with `countBelow`, which stops
 * past 50, and the button shows only for 1 to 50 picks below the
 * description.
 *
 * OCR text is not a form field. The transcript lives in OCR page rows,
 * read-only in Fisqua; the loader reports its page count and length
 * (`transcript`) without reading the page text, and the update action
 * ignores a posted `ocrText`. Under the level and reference badges, a
 * read-only line gives the page count and links to the transcript view
 * when the description has OCR pages. A `?page=` value opens the image
 * viewer at that canvas, so a transcript hit can link to the page it
 * was read from.
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
 * A parent publishes its children's level (`children_level`), read from
 * its published children. Publishing or unpublishing a description, and
 * a save that changes its level, move its parent's version in the same
 * batch; deleting it moves the parent's version with its child count.
 *
 * The loader reads the federation's role lists once (`readRolePickers`)
 * and hands the option groups and labels to the entity and place
 * linkers, so the pickers offer the federation's codes and the links
 * show its labels.
 *
 * The entity links carry their relation as read (`related_to` and the
 * links naming each one). The link form sends it back with an edit or a
 * removal, and the action writes only while the link's relation is the
 * one read (`relation-sides.server.ts`), so a change to the relation that
 * lands in between is refused, not overwritten. A relation side is
 * refused with its own message, and so is a relation changed since the
 * read (`relation_side_*`, `relation_changed_*`).
 *
 * A link's role is written only while the federation's list approves
 * it, checked inside the INSERT or UPDATE (`link-roles.server.ts`); an
 * edit may keep the link's current code even when the list has
 * deprecated it. A refused role writes nothing and gets the generic
 * refusal.
 *
 * @version v0.9.0
 */

import { useState, useEffect } from "react";
import {
  Form,
  useFetcher,
  useLoaderData,
  useActionData,
  redirect,
  Link,
  useSearchParams,
} from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Trash2, Plus, Image } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DescriptionForm } from "~/components/descriptions/description-form";
import { ResizablePane } from "~/components/descriptions/resizable-pane";
import {
  AdminIiifViewer,
  parsePageParam,
} from "~/components/descriptions/admin-iiif-viewer";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { ConflictDialog } from "~/components/admin/conflict-dialog";
import { useAutosaveDraft } from "~/components/admin/use-autosave-draft";
import { useFormVersion, useRecordEditMode } from "~/lib/use-form-version";
import { PublishToggle, publishToggleKey } from "~/components/descriptions/publish-toggle";
import { TranscriptLine } from "~/components/descriptions/transcript-line";
import { HandlistPicker } from "~/components/handlists/handlist-picker";
import { AddToQueueButton } from "~/components/capture/add-to-queue";
import { hasCapability } from "~/lib/tenant";
import type { Route } from "./+types/_auth.admin.descriptions.$id";
import { pageMeta, heading } from "../lib/page-title";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function meta(args: Route.MetaArgs) {
  const data = args.data;
  return pageMeta(
    args,
    data?.description?.title,
    heading("descriptions_admin:page_title"),
  );
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { canAdministerArea, requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const {
    descriptions,
    repositories,
    descriptionEntities,
    descriptionPlaces,
    entities,
    places,
  } = await import("~/db/schema");
  const { getAllowedChildLevels } = await import(
    "~/lib/description-levels"
  );
  const { officeSql } = await import("~/lib/link-attributes.server");
  const { namedBySql, relatedToSql } = await import("~/lib/relation-sides.server");
  const { namedByList } = await import("~/lib/relation-as-read");

  const user = context.get(userContext);
  requireAreaWork(user, "records");
  const tenant = context.get(tenantContext);
  // Schema-invariant guard — see action handler.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }
  const descriptiveStandard = tenant.descriptiveStandard;

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  // Fetch description
  const description = await db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
    .get();

  if (!description) {
    throw new Response("Not found", { status: 404 });
  }

  // Fetch ancestor chain for breadcrumbs (limit to 10 to prevent infinite loops)
  const ancestors: { id: string; title: string; referenceCode: string }[] = [];
  let currentParentId = description.parentId;
  let depth = 0;
  while (currentParentId && depth < 10) {
    const ancestor = await db
      .select({
        id: descriptions.id,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        parentId: descriptions.parentId,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.id, currentParentId)
        )
      )
      .get();

    if (!ancestor) break;
    ancestors.unshift({
      id: ancestor.id,
      title: ancestor.title,
      referenceCode: ancestor.referenceCode,
    });
    currentParentId = ancestor.parentId;
    depth++;
  }

  // Fetch enabled repositories for edit mode
  const repoList = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(
      and(eq(repositories.tenantId, tenant.id), eq(repositories.enabled, true))
    )
    .all();

  // Fetch parent for level constraint in edit mode
  let parent: { descriptionLevel: string } | null = null;
  if (description.parentId) {
    parent =
      (await db
        .select({ descriptionLevel: descriptions.descriptionLevel })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, description.parentId)
          )
        )
        .get()) ?? null;
  }

  const allowedLevels = parent
    ? getAllowedChildLevels(parent.descriptionLevel)
    : getAllowedChildLevels(null);

  // Fetch entity links joined with entity display name
  const entityLinks = await db
    .select({
      id: descriptionEntities.id,
      descriptionId: descriptionEntities.descriptionId,
      entityId: descriptionEntities.entityId,
      role: descriptionEntities.role,
      roleNote: descriptionEntities.roleNote,
      sequence: descriptionEntities.sequence,
      honorific: descriptionEntities.honorific,
      function: officeSql(),
      nameAsRecorded: descriptionEntities.nameAsRecorded,
      createdAt: descriptionEntities.createdAt,
      entityDisplayName: entities.displayName,
      entityCode: entities.entityCode,
      // The relation as read, which the link forms send back with an edit
      // or a removal (`relation-as-read.ts`).
      relatedTo: relatedToSql(),
      namedByJoined: namedBySql(),
    })
    .from(descriptionEntities)
    .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
    .where(eq(descriptionEntities.descriptionId, id))
    .orderBy(descriptionEntities.sequence)
    .all()
    .then((rows) => rows.map(({ namedByJoined, ...l }) => ({ ...l, namedBy: namedByList(namedByJoined) })));

  // Fetch place links joined with place label
  const placeLinks = await db
    .select({
      id: descriptionPlaces.id,
      descriptionId: descriptionPlaces.descriptionId,
      placeId: descriptionPlaces.placeId,
      role: descriptionPlaces.role,
      roleNote: descriptionPlaces.roleNote,
      createdAt: descriptionPlaces.createdAt,
      placeLabel: places.label,
      placeCode: places.placeCode,
    })
    .from(descriptionPlaces)
    .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
    .where(eq(descriptionPlaces.descriptionId, id))
    .orderBy(descriptionPlaces.createdAt)
    .all();

  const entityLinkCount = entityLinks.length;
  const placeLinkCount = placeLinks.length;

  // The role pickers and labels come from the federation's lists; a
  // workspace without authorities shows no linkers, and reads none.
  const { readRolePickers } = await import("~/lib/vocabulary.server");
  const { NO_ROLE_PICKERS } = await import("~/lib/role-options");
  const roles = tenant.authoritiesEnabled
    ? await readRolePickers(db, tenant.federationId, context)
    : NO_ROLE_PICKERS;

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(
    db,
    tenant.id,
    id,
    "description",
    user.id
  );
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(
        and(eq(users.tenantId, tenant.id), eq(users.id, conflictRaw.userId))
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  const { countHoldingHandlists } = await import("~/lib/handlists.server");
  const holdingHandlists = await countHoldingHandlists(db, tenant, user, id);

  // The digitization queue's add buttons: the capability, then capture management.
  let canQueue = false;
  if (hasCapability(tenant, "digitization")) {
    const { captureAccess } = await import("~/lib/capture/screens.server");
    canQueue = (await captureAccess(db, tenant, user)).worker;
  }
  // How many "add everything below this" would add: shown only from 1 to
  // the limit, and only when it picks something below the description.
  let queueBelow: number | null = null;
  if (canQueue && (description.childCount ?? 0) > 0) {
    const { countBelow } = await import("~/lib/capture/queue.server");
    queueBelow = await countBelow(db, tenant.id, id);
  }

  // The transcript is read-only here: its size, not its page text.
  const { transcriptSummary } = await import("~/lib/ocr/search.server");
  const transcript = await transcriptSummary(db, tenant.id, id);

  return {
    description,
    ancestors,
    repositories: repoList,
    parent,
    allowedLevels,
    entityLinkCount,
    placeLinkCount,
    entityLinks,
    placeLinks,
    roles,
    conflictDraft,
    // How many handlists this person can reach already hold this
    // record: the affordance states where it is rather than only
    // offering to put it somewhere.
    holdingHandlists,
    canQueue,
    queueBelow,
    // Publishing and deleting are administration: offered to those who
    // administer the records area, not to a staff grant.
    canAdminister: canAdministerArea(user, "records"),
    transcript,
    // Hand the active standard down to <DescriptionForm> so the
    // renderer picks the correct StandardConfig.
    descriptiveStandard,
    // Gates the Entity/Place linker fields; off tenants catalogue with
    // the plain-text creator/place display fields.
    authoritiesEnabled: tenant.authoritiesEnabled,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireArea, requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, and } = await import("drizzle-orm");
  const { descriptions, descriptionEntities, descriptionPlaces, entities, places } =
    await import("~/db/schema");
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { isValidChildLevel } = await import("~/lib/description-levels");
  const { attributesJson, withOfficeSql } = await import("~/lib/link-attributes.server");
  const { deleteLinkAsRead, relationRefusal, updateLinkAsRead } = await import("~/lib/relation-sides.server");
  const { OUTSIDE_RELATIONS, isRelationSide, relationAsReadFrom } = await import("~/lib/relation-as-read");
  const {
    DESCRIPTION_LEVELS,
    RESOURCE_TYPES,
    ENTITY_ROLES,
    PLACE_ROLES,
  } = await import("~/lib/validation/enums");
  const { z } = await import("zod/v4");
  const { descriptionValidatorFor } = await import(
    "~/lib/standards/validator-factory"
  );
  type DescriptionLevel =
    import("~/lib/standards/types").DescriptionLevel;

  const user = context.get(userContext);
  requireAreaWork(user, "records");
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  // The statement that moves the version of this description's parent
  // after a write that changes what the parent publishes, in the same
  // batch (`parentVersionFollows`).
  const { parentVersionFollows } = await import("~/lib/description-versions.server");
  const parentFollows = (childVersion: number) =>
    parentVersionFollows(db, tenant.id, id, childVersion);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  // Off-state authority link/unlink intents: reject hand-crafted POSTs
  // to the Entity/Place junction ops when the tenant lacks the
  // authorities capability. The pickers are hidden client-side; this is
  // the server-side backstop. Core description edits are unaffected.
  const AUTHORITY_LINK_INTENTS = new Set([
    "link_entity",
    "update_entity_link",
    "remove_entity_link",
    "reorder_entity_link",
    "link_place",
    "update_place_link",
    "remove_place_link",
  ]);
  if (AUTHORITY_LINK_INTENTS.has(intent)) {
    const { requireCapability } = await import("~/lib/tenant");
    requireCapability(tenant, "authorities");
    // Every link intent acts on this page's description, which must be
    // the request tenant's; a link row is only ever reached through it.
    const own = await db
      .select({ id: descriptions.id })
      .from(descriptions)
      .where(and(eq(descriptions.id, id), eq(descriptions.tenantId, tenant.id)))
      .get();
    if (!own) throw new Response("Not found", { status: 404 });
  }
  const notFound = () => new Response("Not found", { status: 404 });

  switch (intent) {
    case "toggle_publish": {
      // Publishing or unpublishing exposes or withdraws a record; it is
      // administration, which a staff grant does not have.
      requireArea(user, "records");
      const desc = await db
        .select({ isPublished: descriptions.isPublished, updatedAt: descriptions.updatedAt })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      if (!desc) {
        throw new Response("Not found", { status: 404 });
      }

      // The toggle moves the version on (the publish finds changed
      // records by it), only from the version it read: a save that lands
      // in between leaves the toggle a no-op, and the page's reload shows
      // the state as stored. It returns both versions, so an edit form
      // open on the description takes the new one only when it held the
      // one the toggle moved from.
      // The parent's version moves with it, in the same batch: the
      // child's publication changes the parent's `children_level`.
      const { nextVersion } = await import("~/lib/record-version.server");
      const to = nextVersion(desc.updatedAt);
      const [result] = await db.batch([
        db
          .update(descriptions)
          .set({
            isPublished: !desc.isPublished,
            updatedAt: to,
          })
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, id),
              eq(descriptions.updatedAt, desc.updatedAt)
            )
          ),
        parentFollows(to),
      ]);
      if ((result.meta?.changes ?? 0) === 0) return { ok: false as const };

      return { ok: true as const, from: desc.updatedAt, to };
    }

    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, tenant.id, id, "description", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      // A field is read only when the request carries it. Each
      // standard's form renders a subset of the description columns,
      // and a request may carry fewer still (a partial post, another
      // client), so a field the request does not carry keeps its stored
      // value; a carried, blank field clears its column.
      const { submittedFields, fieldsToWrite } = await import(
        "~/lib/validation/update-schema"
      );
      const { has, trimmed } = submittedFields(formData);

      // The registry of description columns the edit form carries as
      // text. The validator payload and the DB write both derive from
      // it. descriptionLevel (enum-parsed), hasDigital (checkbox) and
      // referenceCode (read-only, taken from the record) are handled
      // explicitly below.
      const UPDATE_FORM_FIELDS = [
        "title",
        "localIdentifier",
        "repositoryId",
        "translatedTitle",
        "uniformTitle",
        "resourceType",
        "genre",
        "dateExpression",
        "dateStart",
        "dateEnd",
        "dateCertainty",
        "extent",
        "dimensions",
        "medium",
        "provenance",
        "scopeContent",
        "arrangement",
        "accessConditions",
        "reproductionConditions",
        "language",
        "locationOfOriginals",
        "locationOfCopies",
        "findingAids",
        "notes",
        "internalNotes",
        "imprint",
        "editionStatement",
        "seriesStatement",
        "volumeNumber",
        "issueNumber",
        "pages",
        "sectionTitle",
        "publicationTitle",
        "adminBiogHistory",
        "acquisitionInfo",
        "preferredCitation",
        "systemOfArrangement",
        "physicalCharacteristics",
        "creatorDisplay",
        "iiifManifestUrl",
      ] as const;

      const original = await db
        .select()
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();
      if (!original) throw notFound();
      const stored = original as unknown as Record<string, unknown>;

      // The level: the submitted one, enum-checked, or the stored one.
      // A submitted value outside the closed enum gets a field-level
      // error here rather than an obscure config-lookup throw in the
      // validator factory below.
      const levelParse = z
        .enum(DESCRIPTION_LEVELS)
        .safeParse(has("descriptionLevel") ? trimmed("descriptionLevel") : original.descriptionLevel);
      if (!levelParse.success) {
        return {
          ok: false as const,
          errors: { descriptionLevel: ["required"] },
        };
      }

      if (original.parentId) {
        const parent = await db
          .select({ descriptionLevel: descriptions.descriptionLevel })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, original.parentId)
            )
          )
          .get();

        if (
          parent &&
          !isValidChildLevel(
            parent.descriptionLevel,
            levelParse.data
          )
        ) {
          return {
            ok: false as const,
            errors: { descriptionLevel: ["invalid_level"] },
          };
        }
      }

      // The digital flag is a checkbox, which a browser does not submit
      // when unchecked. The form posts a hidden `hasDigital` input
      // before the checkbox, so a request that carries the name at all
      // came from a rendered checkbox, and "on" among its values means
      // checked. A request without the name leaves the flag as stored.
      const hasDigital = has("hasDigital")
        ? formData.getAll("hasDigital").includes("on")
        : undefined;

      // Standard-aware validation of the record as it will stand: each
      // carried field's submitted value, each other field's stored
      // value, run through the per-standard validator picked from
      // `tenant.descriptiveStandard`, which collects every required-
      // field issue in one pass. A blank input reaches the validator as
      // absent, not null (the base schema's optional fields are not
      // nullable); the required-field check still fires on it.
      const formObject: Record<string, unknown> = {
        // referenceCode is read-only in edit mode and never travels in
        // the form, but every standard requires it, so the validator
        // sees the record's own value.
        referenceCode: original.referenceCode,
        descriptionLevel: levelParse.data,
        hasDigital: hasDigital ?? original.hasDigital,
      };
      for (const name of UPDATE_FORM_FIELDS) {
        formObject[name] = has(name)
          ? trimmed(name) || undefined
          : (stored[name] ?? undefined);
      }

      // `tenants.descriptive_standard` is NOT NULL when
      // `kind = 'tenant'` per the schema CHECK in
      // drizzle/0034_tenants_table.sql. Operators with
      // `kind = 'platform'` never reach description CRUD routes (the
      // auth middleware blocks). The Drizzle inferred type is
      // nullable; we narrow with an explicit invariant throw rather
      // than silently defaulting.
      if (tenant.descriptiveStandard == null) {
        throw new Error(
          "Schema invariant violation: tenant.descriptiveStandard is null",
        );
      }
      const validator = descriptionValidatorFor(
        tenant.descriptiveStandard,
        levelParse.data as DescriptionLevel,
      );
      const errors: Record<string, string[]> = {};
      // Required fields are checked here, over the record as it will
      // stand, and not left to the validator: Zod skips the validator's
      // required-field check whenever any field fails its own schema,
      // and an untouched stored value (a legacy value outside an enum)
      // can fail it.
      const { getStandardConfig } = await import("~/lib/standards/registry");
      const requiredColumns = getStandardConfig(tenant.descriptiveStandard)
        .requiredFieldsForLevel(levelParse.data as DescriptionLevel);
      for (const col of requiredColumns) {
        const value = formObject[col];
        if (value == null || value === "") errors[col] = ["field_required"];
      }
      // Format errors count only for the fields the request carries. A
      // stored value in a field the request did not carry is not the
      // request's to fix, and this write leaves it alone.
      const stdParsed = validator.safeParse(formObject);
      if (!stdParsed.success) {
        const fieldErrors = z.flattenError(stdParsed.error).fieldErrors as Record<
          string,
          string[] | undefined
        >;
        for (const [name, messages] of Object.entries(fieldErrors)) {
          if (!messages?.length || !has(name) || errors[name]) continue;
          errors[name] = messages;
        }
      }
      if (Object.keys(errors).length > 0) {
        return { ok: false as const, errors };
      }

      // Optimistic lock check: compare updatedAt from form vs DB
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      // Whether the request carries any field the editor submits. An
      // overwrite after a conflict resubmits the editor's fields; a
      // forced update without any would write nothing and report
      // success while the user's edits stay unsaved, so it is refused.
      const carriesFields =
        UPDATE_FORM_FIELDS.some((name) => has(name)) ||
        has("descriptionLevel") ||
        has("hasDigital");
      if (forceOverwrite && !carriesFields) {
        return { ok: false as const, error: "generic" };
      }
      // The conflict response names who last saved the record and when.
      const conflict = async (current: { updatedAt: number; updatedBy: string | null }) => {
        const { users } = await import("~/db/schema");
        let modifiedBy = "Unknown";
        if (current.updatedBy) {
          const modifier = await db
            .select({ name: users.name })
            .from(users)
            .where(
              and(eq(users.tenantId, tenant.id), eq(users.id, current.updatedBy))
            )
            .get();
          if (modifier?.name) modifiedBy = modifier.name;
        }
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedBy,
          modifiedAt: current.updatedAt,
        };
      };
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        return conflict(original);
      }

      // The values the request carried, keyed by column; an absent
      // field stays undefined and is not written. title and
      // repositoryId are NOT NULL: a blank one (which the validator has
      // already refused when the standard requires it) stays as stored.
      // genre is a JSON list whose empty value is "[]".
      // resourceType is enum-gated (the validator already rejects
      // other values).
      const updates: Record<string, unknown> = {};
      for (const name of UPDATE_FORM_FIELDS) {
        if (has(name)) updates[name] = trimmed(name) || null;
      }
      if (has("title")) updates.title = trimmed("title") || undefined;
      if (has("repositoryId")) {
        updates.repositoryId = trimmed("repositoryId") || undefined;
      }
      if (has("genre")) updates.genre = trimmed("genre") || "[]";
      if (has("resourceType")) {
        const rt = trimmed("resourceType");
        updates.resourceType = RESOURCE_TYPES.includes(
          rt as (typeof RESOURCE_TYPES)[number]
        )
          ? rt
          : null;
      }
      if (has("descriptionLevel")) updates.descriptionLevel = levelParse.data;
      if (hasDigital !== undefined) updates.hasDigital = hasDigital;

      // Of those, only the ones that change the stored row are written
      // and logged: an unchanged value, or a blank over a stored blank
      // ("" or NULL, and an empty genre list over NULL), is left out.
      const changed: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(fieldsToWrite(updates, stored))) {
        if (name === "genre" && value === "[]" && stored.genre == null) continue;
        if (JSON.stringify(stored[name]) === JSON.stringify(value)) continue;
        changed[name] = value;
      }

      // The write runs only while the description holds the version
      // read above (the one the form's version was checked against, or
      // that a forced overwrite applies to): a save that another lands
      // before changes nothing, and its changes count says so.
      // A change of level changes the parent's `children_level`, so the
      // parent's version moves with it, in the same batch.
      const { nextVersion } = await import("~/lib/record-version.server");
      const savedVersion = nextVersion(original.updatedAt);
      try {
        const [result] = await db.batch([
          db
            .update(descriptions)
            .set({
              ...(changed as Partial<typeof descriptions.$inferInsert>),
              updatedBy: user.id,
              updatedAt: savedVersion,
            })
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.id, id),
                eq(descriptions.updatedAt, original.updatedAt)
              )
            ),
          ...("descriptionLevel" in changed ? [parentFollows(savedVersion)] : []),
        ]);
        if ((result.meta?.changes ?? 0) === 0) {
          const current = await db
            .select({ updatedAt: descriptions.updatedAt, updatedBy: descriptions.updatedBy })
            .from(descriptions)
            .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
            .get();
          return conflict(current ?? original);
        }
      } catch {
        return { ok: false as const, error: "generic" };
      }

      // Changelog entry for the fields that changed.
      const { computeDiff, createChangelogEntry } = await import(
        "~/lib/changelog.server"
      );
      const diff = computeDiff(stored, changed);
      if (diff) {
        const commitNote =
          (formData.get("commitNote") as string)?.trim() || undefined;
        await createChangelogEntry(
          db,
          id,
          "description",
          user.id,
          diff,
          commitNote
        );
      }

      // The saved fields supersede the autosaved draft. A request that
      // carried none of them saved nothing, and the draft is kept.
      if (carriesFields) {
        const { deleteDraft } = await import("~/lib/drafts.server");
        await deleteDraft(db, tenant.id, id, "description");
      }

      // The new version, which the form submits with its next save.
      return { ok: true as const, message: "updated", updatedAt: savedVersion };
    }

    case "delete": {
      // Deleting a record is administration, as publishing is.
      requireArea(user, "records");
      // Check childCount > 0
      const desc = await db
        .select({
          childCount: descriptions.childCount,
          parentId: descriptions.parentId,
          referenceCode: descriptions.referenceCode,
        })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      if (!desc) {
        throw new Response("Not found", { status: 404 });
      }

      if (desc.childCount > 0) {
        return {
          ok: false as const,
          error: "delete_blocked",
          count: desc.childCount,
        };
      }

      // Delete description (entity/place links cascade per schema). The
      // descriptions that record its code as a former one publish it
      // again once the code is free, so their versions move in the same
      // batch (`formerCodeHoldersFollow`).
      const { formerCodeHoldersFollow } = await import("~/lib/export/former-codes.server");
      const holders = formerCodeHoldersFollow(db, tenant.id, [desc.referenceCode]);
      await db.batch([
        db
          .delete(descriptions)
          .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id))),
        ...(holders ? [holders] : []),
      ] as any);

      // Decrement parent's childCount if parentId exists
      if (desc.parentId) {
        const parent = await db
          .select({ childCount: descriptions.childCount })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, desc.parentId)
            )
          )
          .get();

        if (parent) {
          // The count is part of the parent's published record: its
          // version moves with it, past the version it holds.
          const { nextVersionSql } = await import("~/lib/record-version.server");
          await db
            .update(descriptions)
            .set({
              childCount: Math.max(0, parent.childCount - 1),
              updatedAt: nextVersionSql(descriptions.updatedAt),
            })
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.id, desc.parentId)
              )
            );
        }
      }

      return redirect("/admin/descriptions");
    }

    // -----------------------------------------------------------------
    // Entity link actions
    // -----------------------------------------------------------------

    case "link_entity": {
      const linkSchema = z.object({
        descriptionId: z.string().uuid(),
        entityId: z.string().uuid(),
        // Any code; the federation's list decides at write time.
        role: z.string().trim().min(1),
        sequence: z.coerce.number().int().min(0).default(0),
        honorific: z.string().max(100).optional(),
        function: z.string().max(300).optional(),
        nameAsRecorded: z.string().max(500).optional(),
      });
      const parsed = linkSchema.safeParse({
        descriptionId: formData.get("descriptionId"),
        entityId: formData.get("entityId"),
        role: formData.get("role"),
        sequence: formData.get("sequence"),
        honorific: (formData.get("honorific") as string)?.trim() || undefined,
        function: (formData.get("function") as string)?.trim() || undefined,
        nameAsRecorded:
          (formData.get("nameAsRecorded") as string)?.trim() || undefined,
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      // The link is made on this page's description, to an entity this
      // tenant can see (shared, or its own).
      if (parsed.data.descriptionId !== id) throw notFound();
      const entity = await db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.id, parsed.data.entityId),
            authorityScope(entities, tenant.federationId, tenant.id),
          ),
        )
        .get();
      if (!entity) throw notFound();
      // The role is checked inside the INSERT: a code the federation's
      // list does not approve, at the moment of the write, writes nothing.
      const { insertEntityLink } = await import("~/lib/link-roles.server");
      try {
        const written = await insertEntityLink(db, tenant.federationId, {
          id: crypto.randomUUID(),
          descriptionId: parsed.data.descriptionId,
          entityId: parsed.data.entityId,
          role: parsed.data.role,
          sequence: parsed.data.sequence,
          honorific: parsed.data.honorific ?? null,
          attributes: attributesJson(parsed.data.function),
          nameAsRecorded: parsed.data.nameAsRecorded ?? null,
          createdAt: Date.now(),
        });
        if (!written) return { ok: false as const, error: "generic" };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("UNIQUE constraint")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const, message: "entity_linked" };
    }

    case "update_entity_link": {
      const entityLinkSchema = z.object({
        linkId: z.string().uuid(),
        role: z.string().trim().min(1),
        honorific: z.string().max(100).optional(),
        function: z.string().max(300).optional(),
        nameAsRecorded: z.string().max(500).optional(),
      });
      const parsed = entityLinkSchema.safeParse({
        linkId: formData.get("linkId"),
        role: formData.get("role"),
        honorific: (formData.get("honorific") as string)?.trim() || undefined,
        function: (formData.get("function") as string)?.trim() || undefined,
        nameAsRecorded:
          (formData.get("nameAsRecorded") as string)?.trim() || undefined,
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      const entityLinkHere = and(
        eq(descriptionEntities.id, parsed.data.linkId),
        eq(descriptionEntities.descriptionId, id),
      );
      const entityLink = await db
        .select({ id: descriptionEntities.id })
        .from(descriptionEntities)
        .where(entityLinkHere)
        .get();
      if (!entityLink) throw notFound();
      // A relation side is not edited from this form. The UPDATE carries
      // the relation the form read, outside every relation, so a change to
      // it that lands in between is refused, not overwritten
      // (relation-sides.server.ts).
      const asRead = relationAsReadFrom(formData);
      if (asRead && isRelationSide(asRead)) return { ok: false as const, error: "relation_side_save" as const };
      // The role is checked inside the UPDATE: the link's current code, or
      // one the federation's list approves at the moment of the write.
      const { roleKeptOrApprovedSql } = await import("~/lib/link-roles.server");
      const roleAllowed = roleKeptOrApprovedSql(descriptionEntities.role, tenant.federationId, "entity_role", parsed.data.role);
      const updated = await updateLinkAsRead(db, parsed.data.linkId, and(entityLinkHere, roleAllowed), asRead ?? OUTSIDE_RELATIONS, {
        role: parsed.data.role as (typeof ENTITY_ROLES)[number],
        honorific: parsed.data.honorific ?? null,
        attributes: withOfficeSql(parsed.data.function),
        nameAsRecorded: parsed.data.nameAsRecorded ?? null,
      });
      if (!updated) {
        const refusal = await relationRefusal(db, parsed.data.linkId, entityLinkHere, asRead, "save");
        if (refusal === null) throw notFound();
        return { ok: false as const, error: refusal };
      }
      return { ok: true as const, message: "updated" };
    }

    case "remove_entity_link": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) return { ok: false as const, error: "generic" };
      const entityLinkHere = and(
        eq(descriptionEntities.id, linkId),
        eq(descriptionEntities.descriptionId, id),
      );
      const entityLink = await db
        .select({ id: descriptionEntities.id })
        .from(descriptionEntities)
        .where(entityLinkHere)
        .get();
      if (!entityLink) throw notFound();
      // Removing a relation side would leave its partner naming a link
      // that is gone, with no kept link to repoint it to. The DELETE
      // carries the relation the form read, outside every relation, so a
      // change to it that lands in between is refused.
      const asRead = relationAsReadFrom(formData);
      if (asRead && isRelationSide(asRead)) return { ok: false as const, error: "relation_side_remove" as const };
      if (!(await deleteLinkAsRead(db, linkId, entityLinkHere, asRead ?? OUTSIDE_RELATIONS))) {
        const refusal = await relationRefusal(db, linkId, entityLinkHere, asRead, "remove");
        if (refusal === null) throw notFound();
        return { ok: false as const, error: refusal };
      }
      return { ok: true as const, message: "link_removed" };
    }

    case "reorder_entity_link": {
      // `sequence` is document order, not relation data: a relation side
      // reordered here keeps its role, `related_to` and partner, so the
      // relation is unharmed and this path needs no relation check.
      const linkId = formData.get("linkId") as string;
      const direction = formData.get("direction") as string;
      if (!linkId || !["up", "down"].includes(direction)) {
        return { ok: false as const, error: "generic" };
      }
      const current = await db
        .select()
        .from(descriptionEntities)
        .where(
          and(
            eq(descriptionEntities.id, linkId),
            eq(descriptionEntities.descriptionId, id),
          ),
        )
        .get();
      if (!current) return { ok: false as const, error: "generic" };

      const targetSeq =
        direction === "up" ? current.sequence - 1 : current.sequence + 1;

      const adjacent = await db
        .select()
        .from(descriptionEntities)
        .where(
          and(
            eq(descriptionEntities.descriptionId, current.descriptionId),
            eq(descriptionEntities.sequence, targetSeq)
          )
        )
        .get();

      if (!adjacent) return { ok: false as const, error: "generic" };

      // Swap sequences
      await db
        .update(descriptionEntities)
        .set({ sequence: adjacent.sequence })
        .where(eq(descriptionEntities.id, current.id));
      await db
        .update(descriptionEntities)
        .set({ sequence: current.sequence })
        .where(eq(descriptionEntities.id, adjacent.id));

      return { ok: true as const, message: "reordered" };
    }

    // -----------------------------------------------------------------
    // Place link actions
    // -----------------------------------------------------------------

    case "link_place": {
      const linkSchema = z.object({
        descriptionId: z.string().uuid(),
        placeId: z.string().uuid(),
        role: z.string().trim().min(1),
      });
      const parsed = linkSchema.safeParse({
        descriptionId: formData.get("descriptionId"),
        placeId: formData.get("placeId"),
        role: formData.get("role"),
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      // The link is made on this page's description, to a place this
      // tenant can see (shared, or its own).
      if (parsed.data.descriptionId !== id) throw notFound();
      const place = await db
        .select({ id: places.id })
        .from(places)
        .where(
          and(
            eq(places.id, parsed.data.placeId),
            authorityScope(places, tenant.federationId, tenant.id),
          ),
        )
        .get();
      if (!place) throw notFound();
      const { insertPlaceLink } = await import("~/lib/link-roles.server");
      try {
        const written = await insertPlaceLink(db, tenant.federationId, {
          id: crypto.randomUUID(),
          descriptionId: parsed.data.descriptionId,
          placeId: parsed.data.placeId,
          role: parsed.data.role,
          createdAt: Date.now(),
        });
        if (!written) return { ok: false as const, error: "generic" };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("UNIQUE constraint")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const, message: "place_linked" };
    }

    case "update_place_link": {
      const placeLinkSchema = z.object({
        linkId: z.string().uuid(),
        role: z.string().trim().min(1),
      });
      const parsed = placeLinkSchema.safeParse({
        linkId: formData.get("linkId"),
        role: formData.get("role"),
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      const placeLinkHere = and(
        eq(descriptionPlaces.id, parsed.data.linkId),
        eq(descriptionPlaces.descriptionId, id),
      );
      const placeLink = await db
        .select({ id: descriptionPlaces.id })
        .from(descriptionPlaces)
        .where(placeLinkHere)
        .get();
      if (!placeLink) throw notFound();
      const { roleKeptOrApprovedSql } = await import("~/lib/link-roles.server");
      const placeUpdated = await db
        .update(descriptionPlaces)
        .set({ role: parsed.data.role as (typeof PLACE_ROLES)[number] })
        .where(and(placeLinkHere, roleKeptOrApprovedSql(descriptionPlaces.role, tenant.federationId, "place_role", parsed.data.role)))
        .returning({ id: descriptionPlaces.id });
      if (placeUpdated.length === 0) return { ok: false as const, error: "generic" };
      return { ok: true as const, message: "updated" };
    }

    case "remove_place_link": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) return { ok: false as const, error: "generic" };
      const placeLinkHere = and(
        eq(descriptionPlaces.id, linkId),
        eq(descriptionPlaces.descriptionId, id),
      );
      const placeLink = await db
        .select({ id: descriptionPlaces.id })
        .from(descriptionPlaces)
        .where(placeLinkHere)
        .get();
      if (!placeLink) throw notFound();
      await db.delete(descriptionPlaces).where(placeLinkHere);
      return { ok: true as const, message: "link_removed" };
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DescriptionDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    description,
    ancestors,
    repositories,
    allowedLevels,
    entityLinkCount,
    placeLinkCount,
    entityLinks,
    placeLinks,
    roles,
    conflictDraft,
    holdingHandlists,
    canQueue,
    queueBelow,
    canAdminister,
    transcript,
    descriptiveStandard,
    authoritiesEnabled,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("descriptions_admin");
  // The handlists namespace owns every string the picker says,
  // including the label on the control that opens it.
  const { t: th } = useTranslation("handlists");
  const { t: tq } = useTranslation("capture");

  // Edit mode belongs to the record it was opened on: following a link
  // to another description leaves it, so the form's inputs and its version
  // always come from the same load.
  const [isEditing, setIsEditing] = useRecordEditMode(description.id);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasChildren = description.childCount > 0;

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

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
  // The publish toggle's fetcher, read by its key for the versions a
  // toggle moved the description from and to.
  const publishFetcher = useFetcher({ key: publishToggleKey(description.id) });
  const formVersion = useFormVersion(
    `${description.id}:${isEditing}`,
    description.updatedAt,
    actionData,
    publishFetcher.data
  );

  const [searchParams] = useSearchParams();
  const initialCanvas = parsePageParam(searchParams.get("page"));

  // Collapse middle breadcrumb ancestors if > 4
  const showAllAncestors = ancestors.length <= 4;
  const visibleAncestors = showAllAncestors
    ? ancestors
    : [...ancestors.slice(0, 1), ...ancestors.slice(-2)];
  const collapsedCount = showAllAncestors ? 0 : ancestors.length - 3;

  // Right pane content: IIIF viewer or placeholder. `?page=` opens the
  // viewer at that canvas; transcript hits link here with it.
  const rightPane = description.iiifManifestUrl ? (
    <AdminIiifViewer
      manifestUrl={description.iiifManifestUrl}
      initialCanvas={initialCanvas}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Image className="h-16 w-16 text-stone-300" />
      <p className="mt-4 text-sm text-stone-500">{t("no_manifest")}</p>
      {isEditing && (
        <button
          type="button"
          onClick={() => {
            const field = document.querySelector<HTMLInputElement>(
              'input[name="iiifManifestUrl"]'
            );
            field?.scrollIntoView({ behavior: "smooth", block: "center" });
            field?.focus();
          }}
          className="mt-2 text-xs text-indigo-deep underline"
        >
          {t("add_manifest")}
        </button>
      )}
    </div>
  );

  return (
    <div className="px-8 py-6">
      {/* Breadcrumb */}
      <nav aria-label={t("common:aria.breadcrumb")} className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link
              to="/admin/descriptions"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("breadcrumb_root")}
            </Link>
          </li>
          {visibleAncestors.map((ancestor, i) => (
            <li key={ancestor.id} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-stone-400" />
              {/* Show collapsed indicator after first ancestor */}
              {!showAllAncestors && i === 1 && collapsedCount > 0 && (
                <>
                  <span className="text-stone-400">...</span>
                  <ChevronRight className="h-4 w-4 text-stone-400" />
                </>
              )}
              <Link
                to={`/admin/descriptions/${ancestor.id}`}
                className="text-stone-500 hover:text-stone-700"
              >
                {ancestor.title}
              </Link>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <ChevronRight className="h-4 w-4 text-stone-400" />
            <span className="text-stone-700">{description.title}</span>
          </li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {description.title}
        </h1>

        {!isEditing && (
          <div className="flex flex-wrap items-start justify-end gap-2">
            {/* One record at a time, into a handlist that holds
                records. First in the row because it is the only action
                here that neither edits nor deletes anything. */}
            <HandlistPicker
              recordType="records"
              memberIds={[description.id]}
              triggerLabel={th("pickerAddTitle")}
              holdingCount={holdingHandlists}
            />
            {canQueue ? (
              <AddToQueueButton target={{ descriptionIds: [description.id] }} label={tq("dqueue.add")} />
            ) : null}
            {canQueue && queueBelow !== null ? (
              <AddToQueueButton target={{ below: description.id }} label={tq("dqueue.add_below", { count: queueBelow })} />
            ) : null}
            <Link
              to={`/admin/descriptions/new?parentId=${description.id}`}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Plus className="h-4 w-4" />
              {t("add_child")}
            </Link>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Pencil className="h-4 w-4" />
              {t("edit")}
            </button>
            {canAdminister && (
            <button
              type="button"
              onClick={() => !hasChildren && setShowDeleteModal(true)}
              disabled={hasChildren}
              aria-disabled={hasChildren ? "true" : undefined}
              title={
                hasChildren
                  ? t("error_delete_blocked", {
                      count: description.childCount,
                    })
                  : undefined
              }
              className={
                hasChildren
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                  : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
              }
            >
              <Trash2 className="h-4 w-4" />
              {t("delete_description")}
            </button>
            )}
          </div>
        )}
      </div>

      {/* Level and ref code badges */}
      <div className="mt-2 flex items-center gap-3">
        <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500">
          {t(`level_${description.descriptionLevel}`)}
        </span>
        <span className="text-xs text-stone-500">
          {description.referenceCode}
        </span>
        <PublishToggle
          descriptionId={description.id}
          isPublished={description.isPublished ?? false}
          lastExportedAt={description.lastExportedAt}
          updatedAt={description.updatedAt}
          canChange={canAdminister}
        />
      </div>

      {/* OCR transcript: page count and a link to read it; absent when
          the description has no OCR pages. */}
      <TranscriptLine
        descriptionId={description.id}
        pageCount={transcript.pageCount}
      />

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
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

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("success_updated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "delete_blocked"
            ? t("error_delete_blocked", {
                count:
                  actionData && "count" in actionData
                    ? actionData.count
                    : description.childCount,
              })
            : t("error_generic")}
        </div>
      )}

      {/* Split pane: form (left) + IIIF viewer (right) */}
      <div className="mt-4">
        <ResizablePane
          left={
            <Form method="post" ref={formRef} onChange={handleFormChange}>
              <input
                type="hidden"
                name="_updatedAt"
                value={String(formVersion)}
              />
              <DescriptionForm
                description={description}
                isEditing={isEditing}
                repositories={repositories}
                allowedLevels={allowedLevels as string[]}
                errors={errors as Record<string, string[]> | undefined}
                entityLinks={entityLinks}
                placeLinks={placeLinks}
                roles={roles}
                standard={descriptiveStandard}
                authoritiesEnabled={authoritiesEnabled}
              />
            </Form>
          }
          right={rightPane}
        />
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-stone-700">
              {t("delete_description")}
            </h2>
            <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
              {t("error_delete_confirm", { title: description.title })}
            </p>
            {(entityLinkCount > 0 || placeLinkCount > 0) && (
              <p className="mt-2 text-sm text-madder">
                {t("error_delete_cascade", {
                  entityCount: entityLinkCount,
                  placeCount: placeLinkCount,
                })}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("delete_cancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
                >
                  {t("delete_description")}
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
            modifiedByName={
              ("modifiedBy" in actionData ? actionData.modifiedBy : "") ?? ""
            }
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

// @version v0.9.0
