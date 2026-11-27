/**
 * Workspace Default Language — the One Rule for Setting It
 *
 * This module deals with changing a workspace's default interface
 * language, `tenants.default_locale`: the language its pages are shown
 * in to a visitor who has not chosen one (the i18next middleware reads
 * it after `?lang=` and the `lang` cookie). Two screens set it, the
 * operator console's tenant page and the workspace's own Users page,
 * and both call `setDefaultLocale`, so the value they accept and the
 * audit row they write cannot drift apart.
 *
 * `setDefaultLocale` takes the submitted form value: `en` or `es`, or an
 * empty value for no default, where the browser's language decides.
 * Any other value is refused with a field error naming
 * `defaultLocale`, and nothing is written. An unchanged value answers
 * `noop` and writes nothing, audit included. A change updates the
 * tenant row and writes one `set_capability` audit row in the same
 * batch (`withAuditLog`), whose details carry the tenant's slug,
 * `settingsChanged: 'default_locale'`, and the value before and after.
 *
 * Who may call it is the caller's decision, and so is the actor the
 * row names: the operator console passes the platform tenant as the
 * actor's tenant; the Users page passes the person's home tenant (their
 * own workspace, or the home a federation grant came from) and the
 * impersonation session, if any.
 *
 * @version v0.9.0
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { tenants } from "../db/schema";
import type { Tenant } from "../context";
import { withAuditLog } from "./audit.server";
import { isSupportedLanguage } from "./language-cookie.server";

/** Who is making the change, as the audit row records them. */
export interface DefaultLocaleActor {
  userId: string;
  email: string;
  /** The tenant the actor acts from: the platform for an operator, the home tenant otherwise. */
  tenantId: string;
  impersonationSessionId?: string | null;
}

/** What a submission answers: saved (or unchanged), or the field's error. */
export type DefaultLocaleResult =
  | { localeSaved: true; noop: boolean }
  | { fieldErrors: { defaultLocale: string[] } };

/**
 * Set `tenant`'s default language from the submitted form value, and
 * audit the change (module header).
 */
export async function setDefaultLocale(
  db: DrizzleD1Database<any>,
  tenant: Pick<Tenant, "id" | "slug" | "defaultLocale">,
  submittedValue: FormDataEntryValue | null,
  actor: DefaultLocaleActor,
): Promise<DefaultLocaleResult> {
  const submitted = typeof submittedValue === "string" ? submittedValue : "";
  if (submitted !== "" && !isSupportedLanguage(submitted)) {
    return { fieldErrors: { defaultLocale: ["default_locale_invalid"] } };
  }
  const next = submitted === "" ? null : submitted;
  const current = tenant.defaultLocale ?? null;
  if (next === current) {
    return { localeSaved: true, noop: true };
  }
  const now = Date.now();
  await withAuditLog(
    db,
    {
      action: "set_capability",
      actorUserId: actor.userId,
      actorUserIdText: actor.email,
      actorTenantId: actor.tenantId,
      targetTenantId: tenant.id,
      targetObjectKind: "tenant",
      targetObjectId: tenant.id,
      impersonationSessionId: actor.impersonationSessionId ?? null,
      details: { slug: tenant.slug, settingsChanged: "default_locale", from: current, to: next },
      now,
    },
    async (txDb) => {
      const update = txDb
        .update(tenants)
        .set({ defaultLocale: next, updatedAt: now })
        .where(eq(tenants.id, tenant.id));
      return { workStatements: [update], result: undefined };
    },
  );
  return { localeSaved: true, noop: false };
}

// @version v0.9.0
