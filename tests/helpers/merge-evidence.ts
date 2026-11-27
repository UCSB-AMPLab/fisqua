/**
 * Tests — evidence for an entity merge
 *
 * This module gives evidence to the merges of the suites that test other
 * parts of an entity merge (functions, relation sides, the ledger). An
 * entity merge needs a stated fact and one cited description on each side,
 * linked to that side's record. `evidenceFor` cites, for each side, a
 * description of the tenant already linked to the record; a side with none
 * is given one, a new description linked to it, so the merge moves (or
 * keeps) that link as it does any other. `evidenceFields` gives the same
 * evidence as the form fields the evidence panel posts, and
 * `mergeWithEvidence` rules a pair merge with it, and `withEvidence` wraps
 * a route action so that the form it is posted carries it.
 *
 * @version v0.9.0
 */
import { env } from "cloudflare:test";
import { createTestRepository } from "./repositories";
import { createTestDescription } from "./descriptions";
import { DEFAULT_TEST_TENANT_ID } from "./db";
import { rulePairMerge } from "../../app/lib/pair-merge.server";

export interface EvidenceInput {
  facts: string[];
  cited: Array<{ entityId: string; descriptionId: string }>;
}

async function repositoryOf(tenantId: string): Promise<string> {
  const id = `repo-evidence-${tenantId.slice(0, 8)}`;
  const held = await env.DB.prepare("SELECT id FROM repositories WHERE id = ?").bind(id).first<{ id: string }>();
  if (held) return held.id;
  return (await createTestRepository({ id, tenantId, code: id })).id;
}

/** A description of the tenant linked to the entity, made when it has none. */
export async function citedDescription(entityId: string, tenantId = DEFAULT_TEST_TENANT_ID): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT l.description_id AS id FROM description_entities l JOIN descriptions d ON d.id = l.description_id " +
      "WHERE l.entity_id = ? AND d.tenant_id = ? ORDER BY d.reference_code, l.id LIMIT 1",
  )
    .bind(entityId, tenantId)
    .first<{ id: string }>();
  if (row) return row.id;
  const description = await createTestDescription({ tenantId, repositoryId: await repositoryOf(tenantId), title: "Evidence" });
  await env.DB.prepare(
    "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES (?, ?, ?, 'creator', 0, 1)",
  )
    .bind(`evidence-${entityId}-${description.id.slice(0, 8)}`, description.id, entityId)
    .run();
  return description.id;
}

/** Evidence for merging `loserId` into `survivorId`: the fact `matter` and one description each. */
export async function evidenceFor(
  loserId: string,
  survivorId: string,
  tenantId = DEFAULT_TEST_TENANT_ID,
): Promise<EvidenceInput> {
  return {
    facts: ["matter"],
    cited: [
      { entityId: loserId, descriptionId: await citedDescription(loserId, tenantId) },
      { entityId: survivorId, descriptionId: await citedDescription(survivorId, tenantId) },
    ],
  };
}

/** The same evidence as the panel's form fields, for `FormData.append`. */
export function evidenceFields(evidence: EvidenceInput): Array<[string, string]> {
  return [
    ...evidence.facts.map((f): [string, string] => ["evidence_fact", f]),
    ...evidence.cited.map((c): [string, string] => ["evidence_description", `${c.entityId}:${c.descriptionId}`]),
  ];
}

/**
 * A route action that merges two entity records (the merge workbench,
 * the duplicates card), with evidence added to the form it is posted:
 * for the loser (`loserId`, or the route's `:id`) and the survivor
 * (`survivorId`), when both are entity records and the form carries no
 * evidence of its own.
 */
export function withEvidence<T extends (args: any) => any>(action: T, tenantId = DEFAULT_TEST_TENANT_ID): T {
  return (async (args: any) => {
    const form = await args.request.clone().formData();
    const survivorId = String(form.get("survivorId") ?? "");
    const loserId = String(form.get("loserId") || args.params?.id || "");
    if (survivorId && loserId && survivorId !== loserId && !form.has("evidence_fact")) {
      const found = await env.DB.prepare("SELECT count(*) AS n FROM entities WHERE id IN (?, ?)").bind(survivorId, loserId).first<{ n: number }>();
      if (found?.n === 2) {
        const next = new FormData();
        for (const [k, v] of form.entries()) next.append(k, v);
        for (const [k, v] of evidenceFields(await evidenceFor(loserId, survivorId, tenantId))) next.append(k, v);
        args = { ...args, request: new Request(args.request.url, { method: "POST", body: next }) };
      }
    }
    return action(args);
  }) as T;
}

/**
 * `rulePairMerge` for an entity pair, with evidence for it
 * (`evidenceFor`, on the tenant's descriptions) given as the steward
 * would give it.
 */
export async function mergeWithEvidence(...args: Parameters<typeof rulePairMerge>): ReturnType<typeof rulePairMerge> {
  const [db, user, tenant, recordType, survivorId, loserId, reason, now = Date.now(), timeZone] = args;
  const evidence = recordType === "entity" && survivorId !== loserId ? await evidenceFor(loserId, survivorId, tenant.id) : undefined;
  return rulePairMerge(db, user, tenant, recordType, survivorId, loserId, reason, now, timeZone, evidence);
}

// @version v0.9.0
