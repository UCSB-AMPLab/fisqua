/**
 * Notification fan-out — who hears about a decision, and when.
 *
 * Nothing on the decisions surface sends mail inline. Ruling is a bulk
 * workflow: an admin clearing a three-hundred-row queue must produce
 * one email, not three hundred. So every notifiable event writes rows
 * instead of messages. This module is the writing half — it turns one
 * event (a ruling, a comment, a human-filed proposal) into one
 * `notification_outbox` row per person who should hear about it, and
 * the sweep that runs on the clock is what turns a pile of those rows
 * into a single digest.
 *
 * WHO HEARS WHAT is settled per kind, and deliberately narrow. A
 * ruling reaches the person who filed the question, because they asked
 * it and the answer is the point. A comment reaches the filer and
 * everyone who has already spoken in the thread — a conversation, not
 * a broadcast. A human-filed proposal reaches the people who can
 * actually rule it: the owning tenant's admins, or, for a
 * shared-space question that belongs to no single tenant, the
 * federation's lead-tenant admins together with its stewards. That
 * last set is computed without consulting federation status. A steward
 * of a suspended federation receiving a stray notice is harmless, and
 * a suspended federation should have no filing activity to notify
 * about in the first place; the check would buy nothing and would put
 * a second definition of "suspended" in a place that has no business
 * holding one.
 *
 * THREE INVARIANTS hold across every kind. The actor never hears about
 * their own action. A recipient appears at most once however many ways
 * they qualify. And a recipient whose digest frequency is `off` never
 * gets a row at all: the preference is prospective, so switching
 * notifications back on delivers what happens next, never a backlog of
 * what happened while they were away.
 *
 * FAILURE IS SILENT BY DESIGN. This function never throws. A lost
 * notification is an annoyance; a ruling that rolls back because the
 * mail bookkeeping failed is a broken workspace. Callers await it
 * after their primary write has committed, and a crash in the gap
 * between the two simply loses the notification — accepted, and the
 * reason the enqueue is not folded into the caller's batch.
 *
 * @version v0.7.0
 */

import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  comments,
  federationMemberships,
  federations,
  notificationOutbox,
  pendingDecisions,
  users,
  NOTIFICATION_KINDS,
} from "../db/schema";

/**
 * Fan one decision event out into the outbox and report how many rows
 * were written. `actorUserId` is null when the actor is an agency — a
 * pipeline comment has no person behind it, and pipelines are silent
 * on every event anyway, so the null exists to be recorded rather than
 * subtracted.
 */
export async function enqueueDecisionNotifications(
  db: DrizzleD1Database<any>,
  args: {
    kind: (typeof NOTIFICATION_KINDS)[number];
    decisionId: string;
    /** null when the actor is an agency (pipeline). */
    actorUserId: string | null;
    now?: number;
  },
): Promise<number> {
  const now = args.now ?? Date.now();
  try {
    const decision = await db
      .select({
        id: pendingDecisions.id,
        tenantId: pendingDecisions.tenantId,
        federationId: pendingDecisions.federationId,
        filedByUserId: pendingDecisions.filedByUserId,
      })
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, args.decisionId))
      .get();
    // A decision that is not there cannot be notified about. This is
    // the ordinary shape of a race, not an error worth surfacing.
    if (!decision) return 0;

    const recipients = new Set<string>();

    if (args.kind === "decision_ruled") {
      // The answer goes to whoever asked. A pipeline-filed proposal has
      // no filer, so its ruling reaches nobody.
      if (decision.filedByUserId) recipients.add(decision.filedByUserId);
    } else if (args.kind === "decision_comment") {
      if (decision.filedByUserId) recipients.add(decision.filedByUserId);
      // Everyone already in the thread. Tombstoned comments do not
      // qualify their author, and label-authored ones have no author
      // to qualify.
      const priorAuthors = await db
        .select({ authorId: comments.authorId })
        .from(comments)
        .where(
          and(
            eq(comments.decisionId, args.decisionId),
            isNotNull(comments.authorId),
            isNull(comments.deletedAt),
          ),
        )
        .all();
      for (const row of priorAuthors) {
        if (row.authorId) recipients.add(row.authorId);
      }
    } else {
      // proposal_filed: the people who can rule it.
      if (decision.tenantId) {
        const admins = await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.tenantId, decision.tenantId),
              eq(users.isAdmin, true),
            ),
          )
          .all();
        for (const row of admins) recipients.add(row.id);
      } else {
        // A shared-space question belongs to the federation, so the
        // rulers are its lead tenant's admins plus its stewards.
        const leadAdmins = await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(federations, eq(federations.leadTenantId, users.tenantId))
          .where(
            and(
              eq(federations.id, decision.federationId),
              eq(users.isAdmin, true),
            ),
          )
          .all();
        for (const row of leadAdmins) recipients.add(row.id);
        const stewards = await db
          .select({ userId: federationMemberships.userId })
          .from(federationMemberships)
          .where(
            and(
              eq(federationMemberships.federationId, decision.federationId),
              eq(federationMemberships.role, "steward"),
            ),
          )
          .all();
        for (const row of stewards) recipients.add(row.userId);
      }
    }

    if (args.actorUserId) recipients.delete(args.actorUserId);
    const candidates = [...recipients];
    if (candidates.length === 0) return 0;

    // The `off` filter is a join rather than a per-id read, and it
    // doubles as an existence check: an id with no surviving users row
    // drops out here instead of failing the insert's FK.
    const LOOKUP_CHUNK = 50;
    const deliverable: string[] = [];
    for (let i = 0; i < candidates.length; i += LOOKUP_CHUNK) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.id, candidates.slice(i, i + LOOKUP_CHUNK)),
            ne(users.digestFrequency, "off"),
          ),
        )
        .all();
      for (const row of rows) deliverable.push(row.id);
    }
    if (deliverable.length === 0) return 0;

    // 7 columns per row (70 binds per chunk); chunked for the same
    // reason fileAuthorityProposals chunks, with ample margin under
    // D1's bind cap.
    const CHUNK = 10;
    for (let i = 0; i < deliverable.length; i += CHUNK) {
      await db.insert(notificationOutbox).values(
        deliverable.slice(i, i + CHUNK).map((userId) => ({
          id: crypto.randomUUID(),
          userId,
          kind: args.kind,
          decisionId: args.decisionId,
          actorUserId: args.actorUserId,
          createdAt: now,
          sentAt: null,
        })),
      );
    }
    return deliverable.length;
  } catch (err) {
    console.error("notification enqueue failed", err);
    return 0;
  }
}
