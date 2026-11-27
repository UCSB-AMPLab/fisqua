/**
 * Scripts — the acting user's read
 *
 * This module deals with the one helper the operator commands share
 * from the planning library of the retired date-corrections command:
 *
 *   actorQuery  the SELECT that reads a user by email, with their
 *               tenant's slug, whether the tenant is disabled, and the
 *               area flags (`is_admin`, `is_super_admin`,
 *               `is_records_admin`). `./authority-links.ts` resolves who
 *               acts with it.
 *
 * @version v0.9.0
 */

import { escapeSql } from "./sql";

/** The user of `email`, with their tenant and the area flags. */
export function actorQuery(email: string): string {
  return `SELECT u.id AS id, u.email AS email, IFNULL(u.name, '') AS name, u.tenant_id AS tenant_id,
    u.is_admin AS is_admin, u.is_super_admin AS is_super_admin, u.is_records_admin AS is_records_admin,
    t.slug AS tenant_slug, IFNULL(t.disabled_at, '') AS tenant_disabled_at
    FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = lower(${escapeSql(email)})`;
}

// @version v0.9.0
