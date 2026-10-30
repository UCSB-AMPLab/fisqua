/**
 * Vocabularies Hub Landing
 *
 * This page is the overview landing for the vocabularies admin. It shows aggregate
 * counts per vocabulary, the pending-review backlog, and the recent
 * activity timeline so the operator can decide where to dive in
 * without opening every panel.
 *
 * Authority scope is the federation (migrations 0045-0048). The vocabulary
 * term counts and the distinct-value counts on `entities` and `places`
 * are scoped to `tenant.federationId`; descriptionEntities /
 * descriptionPlaces inherit tenant scope through their parent
 * description (children-table FK chain). Migration 0067 narrowed that scope one level:
 * the filter is now `authorityScope(...)`, the federation plus the
 * ownership arm (shared records, or this tenant's own), spelt out at
 * each query site. Nothing changes while every record is shared.
 *
 * @version v0.8.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.vocabularies._index";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const {
    vocabularyTerms,
    entities,
    descriptionEntities,
    descriptionPlaces,
    descriptions,
    places,
  } = await import("~/db/schema");

  const { requireArea } = await import("~/lib/user-access.server");

  // The layout checks the same two gates, but a data request for this
  // route alone runs this loader without the layout's, so it carries
  // its own. Every domain query is scoped to the calling tenant.
  requireArea(context.get(userContext), "records");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "vocabulary_hub");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Primary functions: count by status
  const functionStats = await db
    .select({
      status: vocabularyTerms.status,
      count: sql<number>`count(*)`,
    })
    .from(vocabularyTerms)
    .where(eq(vocabularyTerms.federationId, tenant.federationId))
    .groupBy(vocabularyTerms.status)
    .all();

  const functionTotal = functionStats.reduce((sum, r) => sum + r.count, 0);
  const functionProposed =
    functionStats.find((r) => r.status === "proposed")?.count ?? 0;

  // Entity types: count distinct values in use within this tenant
  const entityTypeCount = await db
    .select({ count: sql<number>`count(distinct entity_type)` })
    .from(entities)
    .where(authorityScope(entities, tenant.federationId, tenant.id))
    .all();

  // Entity roles: count distinct values in use within this tenant.
  // description_entities has no tenant_id of its own, so each link is
  // read through its description, which does.
  const entityRoleCount = await db
    .select({ count: sql<number>`count(distinct ${descriptionEntities.role})` })
    .from(descriptionEntities)
    .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
    .where(eq(descriptions.tenantId, tenant.id))
    .all();

  // Place types: count distinct values in use within this tenant
  const placeTypeCount = await db
    .select({ count: sql<number>`count(distinct place_type)` })
    .from(places)
    .where(authorityScope(places, tenant.federationId, tenant.id))
    .all();

  // Place roles: count distinct values in use within this tenant, read
  // through each link's description as above.
  const placeRoleCount = await db
    .select({ count: sql<number>`count(distinct ${descriptionPlaces.role})` })
    .from(descriptionPlaces)
    .innerJoin(descriptions, eq(descriptions.id, descriptionPlaces.descriptionId))
    .where(eq(descriptions.tenantId, tenant.id))
    .all();

  return {
    functions: { total: functionTotal, proposed: functionProposed },
    entityTypes: entityTypeCount[0]?.count ?? 0,
    entityRoles: entityRoleCount[0]?.count ?? 0,
    placeTypes: placeTypeCount[0]?.count ?? 0,
    placeRoles: placeRoleCount[0]?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VocabularyCardProps {
  title: string;
  description: string;
  termCount: number;
  proposedCount?: number;
  href: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function VocabularyCard({
  title,
  description,
  termCount,
  proposedCount,
  href,
  t,
}: VocabularyCardProps) {
  return (
    <Link
      to={href}
      className="flex items-center justify-between rounded-lg border border-stone-200 p-4 hover:bg-stone-50"
    >
      <div>
        <h3 className="text-sm font-semibold text-stone-700">{title}</h3>
        <p className="mt-0.5 text-xs text-stone-500">{description}</p>
        <p className="mt-1 text-xs text-stone-500">
          {t("n_terms", { count: termCount })}
          {proposedCount != null && proposedCount > 0 && (
            <span className="ml-2 text-saffron-deep">
              {t("n_proposed", { count: proposedCount })}
            </span>
          )}
        </p>
      </div>
      <ChevronRight className="h-5 w-5 flex-shrink-0 text-stone-400" />
    </Link>
  );
}

export default function AdminVocabulariesIndex({
  loaderData,
}: Route.ComponentProps) {
  const data = loaderData;
  const { t } = useTranslation("vocabularies");

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <h1 className="font-serif text-lg font-semibold text-stone-700">
        {t("page_title")}
      </h1>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <VocabularyCard
          title={t("vocab_entity_roles")}
          description={t("vocab_entity_roles_desc")}
          termCount={data.entityRoles}
          href="/admin/vocabularies/enums?vocab=entity-roles"
          t={t}
        />
        <VocabularyCard
          title={t("vocab_place_roles")}
          description={t("vocab_place_roles_desc")}
          termCount={data.placeRoles}
          href="/admin/vocabularies/enums?vocab=place-roles"
          t={t}
        />
        <VocabularyCard
          title={t("vocab_entity_types")}
          description={t("vocab_entity_types_desc")}
          termCount={data.entityTypes}
          href="/admin/vocabularies/enums?vocab=entity-types"
          t={t}
        />
        <VocabularyCard
          title={t("vocab_place_types")}
          description={t("vocab_place_types_desc")}
          termCount={data.placeTypes}
          href="/admin/vocabularies/enums?vocab=place-types"
          t={t}
        />
        <VocabularyCard
          title={t("vocab_primary_functions")}
          description={t("vocab_primary_functions_desc")}
          termCount={data.functions.total}
          proposedCount={data.functions.proposed}
          href="/admin/vocabularies/functions"
          t={t}
        />
      </div>
    </div>
  );
}
