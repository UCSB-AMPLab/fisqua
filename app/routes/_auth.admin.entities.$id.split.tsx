/**
 * Entities Admin — Split workbench (full-page)
 *
 * This route is the full-viewport split surface for entity authorities
 * (spec §4, handoff surface 2), replacing the old modal. Every splittable
 * field is assigned Original / Both / New; external identifiers (Wikidata,
 * VIAF) are exactly-one-side; both halves get distinct, editable names;
 * and linked descriptions are divided by checkbox. The original record is
 * updated in place and a new record is inserted; the required reason lands
 * in the ledger row's `detail.reason`. Confirm is server-revalidated
 * (reason present, names distinct, every row assigned) so a hand-crafted
 * POST cannot bypass the client gate.
 *
 * Per spec §4 the action lands on the ORIGINAL with a link to the new
 * record; both records stay live (a split does not supersede either
 * half — only a merge does).
 *
 * Linked descriptions render as rich context cards grouped by
 * description; a multi-role description is routed as one unit.
 *
 * The new record gets a copy of the source's `entity_functions` rows,
 * in their order, in the same batch; the source keeps its own. A row
 * of a function an earlier row holds, case and spacing aside, is not
 * copied: its empty fields' values go to the earlier row's copy
 * (`copiedEntityFunctions`). The
 * `entities.functions` column is not written. The original takes a new
 * `updated_at` past the version read even when the clock has not passed
 * it (`nextVersion`), so a save that read it before the split fails
 * after it. The batch opens with `entitiesAsReadGuard`: it runs only
 * while the original is unmerged and holds the version and the function
 * rows the split read, so a merge or save that lands between the reads
 * and the batch fails it whole and the split returns the conflict. A
 * record already merged away is not split.
 *
 * The loader reads the federation's role lists once (`readRolePickers`),
 * and the cards show its labels for the document and place roles, a
 * relation side's from the relation roles.
 *
 * @version v0.9.0
 */

import { useTranslation } from "react-i18next";
import { entityRoleLabel, placeRoleLabel } from "~/lib/role-options";
import { redirect, useActionData } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime, requestTimeZone } from "~/lib/format";
import {
  SplitWorkbench,
  type SplitFieldRow,
} from "~/components/admin/split-workbench";
import type { Route } from "./+types/_auth.admin.entities.$id.split";
import { pageMeta, heading } from "../lib/page-title";

type Choice = "original" | "both" | "new";

export function meta(args: Route.MetaArgs) {
  const data = args.data;
  return pageMeta(
    args,
    data?.entity?.displayName,
    heading("authorities:splitHeading"),
    heading("entities:title"),
  );
}

export async function loader({ params, context }: Route.LoaderArgs) {
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

  const entity = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
    .get();
  if (!entity) throw new Response("Not found", { status: 404 });

  const cards = await loadLinkedDescriptionCards(db, {
    recordType: "entity",
    ownerId: id,
    displayName: entity.displayName,
    tenantId: tenant.id,
  });

  // The role labels come from the federation's lists.
  const { readRolePickers } = await import("~/lib/vocabulary.server");
  const roles = await readRolePickers(db, tenant.federationId, context);

  return { entity, cards, roles };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const { authorityScope, requireAuthorityMutation } = await import(
    "~/lib/authority-ownership.server"
  );
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions } = await import("~/db/schema");
  const { generateUniqueCode } = await import("~/lib/codes.server");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  const id = params.id;
  // A split rewrites the source and mints a sibling from it, so the
  // source's ownership governs the whole operation: this tenant's own
  // record splits without a steward, a shared one does not, another
  // tenant's 404s.
  await requireAuthorityMutation(db, user, tenant, "entity", [id]);
  const formData = await request.formData();

  const reason = (formData.get("reason") as string)?.trim() || "";
  if (!reason) return { ok: false as const, error: "reason" as const };

  const nameA = (formData.get("nameA") as string)?.trim() || "";
  const nameB = (formData.get("nameB") as string)?.trim() || "";
  if (!nameA || !nameB || nameA === nameB) {
    return { ok: false as const, error: "names" as const };
  }

  let choices: Record<string, Choice> = {};
  try {
    choices = JSON.parse((formData.get("choices") as string) || "{}");
  } catch {
    choices = {};
  }

  let linkIds: string[] = [];
  try {
    linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
  } catch {
    linkIds = [];
  }

  const source = await db
    .select()
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), eq(entities.id, id)))
    .get();
  if (!source) return { ok: false as const, error: "generic" as const };

  const formUpdatedAt = formData.get("_updatedAt") as string;
  const forceOverwrite = formData.get("_force") === "true";
  if (!forceOverwrite && formUpdatedAt && String(source.updatedAt) !== formUpdatedAt) {
    return { ok: false as const, error: "conflict" as const, modifiedAt: source.updatedAt };
  }
  // A record merged away is not split: its functions and links live on
  // its survivor.
  if (source.mergedInto !== null) {
    return { ok: false as const, error: "conflict" as const, modifiedAt: source.updatedAt };
  }

  let sourceVariants: string[] = [];
  try {
    sourceVariants = JSON.parse(source.nameVariants || "[]");
  } catch {
    sourceVariants = [];
  }

  // Full-assignment enforcement: rebuild the expected field-key set
  // server-side (the same enumerated assignable rows the loader
  // renders) and require every key to carry a valid choice. A missing
  // key rejects — an empty `choices` object must not silently null out
  // the surviving original's fields. External-ID rows are exactly-one-
  // side (spec §4): "both" is rejected for them.
  const threeStateKeys = [
    "datesOfExistence",
    "history",
    ...sourceVariants.map((_, i) => `variant:${i}`),
  ];
  const twoSidedKeys = ["wikidataId", "viafId", "dbeId"];
  for (const key of threeStateKeys) {
    const c = choices[key];
    if (c !== "original" && c !== "both" && c !== "new") {
      return { ok: false as const, error: "unassigned" as const };
    }
  }
  for (const key of twoSidedKeys) {
    const c = choices[key];
    if (c === "both") {
      return { ok: false as const, error: "invalid_choice" as const };
    }
    if (c !== "original" && c !== "new") {
      return { ok: false as const, error: "unassigned" as const };
    }
  }

  const toNew = (key: string) => choices[key] === "new" || choices[key] === "both";
  const toOrig = (key: string) => choices[key] === "original" || choices[key] === "both";
  const origVariants: string[] = [];
  const newVariants: string[] = [];
  sourceVariants.forEach((v, i) => {
    const key = `variant:${i}`;
    if (toOrig(key)) origVariants.push(v);
    if (toNew(key)) newVariants.push(v);
  });

  // Each link must belong to the record BEING SPLIT — a crafted linkId
  // pointing at another record's junction row is skipped, never
  // repointed (the same ownership discipline as the merge action).
  // `inArray` on an empty list is a D1 error, so guard it. The ledger's
  // movedLinks counts only verified rows.
  let verifiedLinkIds: string[] = [];
  if (linkIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const owned = await db
      .select({ id: descriptionEntities.id })
      .from(descriptionEntities)
      .where(
        and(
          inArray(descriptionEntities.id, linkIds),
          eq(descriptionEntities.entityId, id),
          // Only links whose description is the request tenant's move.
          inArray(
            descriptionEntities.descriptionId,
            db
              .select({ id: descriptions.id })
              .from(descriptions)
              .where(eq(descriptions.tenantId, tenant.id)),
          ),
        ),
      )
      .all();
    verifiedLinkIds = owned.map((r) => r.id);
  }

  // The sibling inherits the source's ownership (see the insert below),
  // so it also inherits the agency whose mark goes on its code: a shared
  // record splits into two shared records under the federation's prefix,
  // an owned one into two of that tenant's.
  const { resolveAuthorityCodePrefix } = await import("~/lib/codes.server");
  const newCode = await generateUniqueCode(
    db,
    await resolveAuthorityCodePrefix(
      db,
      "entity",
      tenant.federationId,
      source.tenantId,
    ),
    entities,
    entities.entityCode,
  );
  const newId = crypto.randomUUID();
  const timestamp = Date.now();
  // The new record gets a copy of the source's function rows, in order;
  // the source keeps its own.
  const {
    readEntityFunctionRows,
    copiedEntityFunctions,
    nextVersion,
    entitiesAsReadGuard,
    entitiesStillAsRead,
  } = await import("~/lib/entity-functions.server");
  const sourceFunctions = await readEntityFunctionRows(db, id);
  // The batch runs only while the original is unmerged and holds the
  // version and the function rows read: a merge or a save that lands
  // between these reads and the batch fails it whole, and the split
  // returns the conflict.
  const asRead = [
    {
      id,
      version: source.updatedAt,
      unmerged: true,
      functionIds: sourceFunctions.map((r) => r.id),
    },
  ];
  // The provenance line's date is the acting member's calendar day.
  const now = formatIsoDateTime(timestamp, requestTimeZone(request)).slice(0, 10);
  const splitFromNote = `Split from ${source.displayName} (${source.entityCode}) on ${now}`;
  const splitIntoNote = `Split into ${nameB} (${newCode}) on ${now}`;

  const batch = [
    entitiesAsReadGuard(db, asRead),
    // New record: identity fields clone; assignable fields follow choices.
    db.insert(entities).values({
      federationId: tenant.federationId,
      // The sibling INHERITS the source's ownership rather than taking
      // the federation's minting default: a split preserves what the
      // record already was, so a shared record splits into shared
      // records and an owned one into owned records. Anything else would
      // leave the two halves of one split under different mutation
      // rules the moment they were created.
      tenantId: source.tenantId,
      id: newId,
      entityCode: newCode,
      displayName: nameB,
      sortName: source.sortName,
      surname: source.surname,
      givenName: source.givenName,
      entityType: source.entityType,
      honorific: source.honorific,
      primaryFunction: source.primaryFunction,
      primaryFunctionId: source.primaryFunctionId,
      nameVariants: JSON.stringify(newVariants),
      datesOfExistence: toNew("datesOfExistence") ? source.datesOfExistence : null,
      dateStart: toNew("datesOfExistence") ? source.dateStart : null,
      dateEnd: toNew("datesOfExistence") ? source.dateEnd : null,
      history: toNew("history") ? source.history : null,
      sources: splitFromNote,
      mergedInto: null,
      wikidataId: choices.wikidataId === "new" ? source.wikidataId : null,
      viafId: choices.viafId === "new" ? source.viafId : null,
      dbeId: choices.dbeId === "new" ? source.dbeId : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    ...copiedEntityFunctions(db, newId, sourceFunctions, timestamp),
    // Original record: rename; keep only fields whose choice assigns
    // them to the original (or both).
    db
      .update(entities)
      .set({
        displayName: nameA,
        nameVariants: JSON.stringify(origVariants),
        datesOfExistence: toOrig("datesOfExistence") ? source.datesOfExistence : null,
        dateStart: toOrig("datesOfExistence") ? source.dateStart : null,
        dateEnd: toOrig("datesOfExistence") ? source.dateEnd : null,
        history: toOrig("history") ? source.history : null,
        wikidataId: choices.wikidataId === "original" ? source.wikidataId : null,
        viafId: choices.viafId === "original" ? source.viafId : null,
        dbeId: choices.dbeId === "original" ? source.dbeId : null,
        sources: source.sources ? `${source.sources}\n${splitIntoNote}` : splitIntoNote,
        // Past the version read, whatever the clock, so a save that read
        // the original before the split fails after it.
        updatedAt: nextVersion(source.updatedAt, timestamp),
      })
      .where(
        and(
          authorityScope(entities, tenant.federationId, tenant.id),
          eq(entities.id, id),
          eq(entities.updatedAt, source.updatedAt),
        ),
      ),
    ...verifiedLinkIds.map((linkId) =>
      db
        .update(descriptionEntities)
        .set({ entityId: newId })
        .where(
          and(
            eq(descriptionEntities.id, linkId),
            eq(descriptionEntities.entityId, id),
          ),
        ),
    ),
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "entity",
      operation: "split",
      sourceId: id,
      targetId: newId,
      userId: user.id,
      detail: { reason, choices, movedLinks: verifiedLinkIds.length, nameA, nameB },
    }),
  ];

  try {
    await db.batch(batch as any);
  } catch (err) {
    if (await entitiesStillAsRead(db, asRead)) throw err;
    const current = await db
      .select({ updatedAt: entities.updatedAt })
      .from(entities)
      .where(eq(entities.id, id))
      .get();
    return {
      ok: false as const,
      error: "conflict" as const,
      modifiedAt: current?.updatedAt ?? source.updatedAt,
    };
  }

  return redirect(`/admin/entities/${id}`);
}

export default function EntitySplitWorkbench({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { t: te } = useTranslation("entities");
  const actionData = useActionData<typeof action>();
  const { entity, cards, roles } = loaderData;

  const fieldRows: SplitFieldRow[] = [
    { key: "datesOfExistence", label: te("field.datesOfExistence"), value: entity.datesOfExistence, mode: "three" },
    { key: "history", label: te("field.history"), value: entity.history ? "—" : null, mode: "three" },
    { key: "wikidataId", label: te("field.wikidataId"), value: entity.wikidataId, mode: "twoSided" },
    { key: "viafId", label: te("field.viafId"), value: entity.viafId, mode: "twoSided" },
    { key: "dbeId", label: te("field.dbeId"), value: entity.dbeId, mode: "twoSided" },
  ];

  let variants: string[] = [];
  try {
    variants = JSON.parse(entity.nameVariants || "[]");
  } catch {
    variants = [];
  }
  const nameVariantRows: SplitFieldRow[] = variants.map((v, i) => ({
    key: `variant:${i}`,
    label: `${te("field.nameVariants")}: ${v}`,
    value: null,
    mode: "three",
  }));

  const conflictModifiedAt =
    actionData && "error" in actionData && actionData.error === "conflict"
      ? actionData.modifiedAt
      : null;

  return (
    <SplitWorkbench
      eyebrow={t("mergeEyebrowEntities")}
      record={entity.displayName}
      recordCode={entity.entityCode ?? ""}
      cards={cards}
      showAsRecorded
      roleLabel={(role, relationSide) => entityRoleLabel(roles.labels, role, relationSide)}
      placeRoleLabel={(role) => placeRoleLabel(roles.labels, role)}
      fieldRows={fieldRows}
      nameVariantRows={nameVariantRows}
      initialName={entity.displayName}
      nameLabel={te("field.displayName")}
      recordUpdatedAt={entity.updatedAt}
      conflictModifiedAt={conflictModifiedAt}
      t={t}
    />
  );
}

/* @version v0.9.0 */
