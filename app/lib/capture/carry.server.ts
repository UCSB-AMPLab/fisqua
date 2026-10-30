/**
 * Capture QC — Approvals Carried Across a Retake
 *
 * This module deals with what a retake keeps of capture QC's work. A
 * retake arrives as a new delivery of the volume, which supersedes the
 * older one. Decisions belong to the
 * delivery they were made on, but an opening whose images the retake did
 * not change has already been looked at: each such opening keeps the
 * approval it had, and only openings with new or changed images are
 * reviewed again.
 *
 * An opening of the new delivery is carried when the delivery it
 * supersedes approved it and the set of its images is the same in both,
 * each image named by its capture id, its role, the sha256 of its
 * capture and its `rotate_deg` (`capture_images`), a null rotation
 * matching only a null one: the same pixels turned another way, or read
 * by EXIF on one side and by a given rotation on the other, are a
 * changed image. Only the images of each delivery's
 * openings are compared (`record_status` `in_review` or `approved`);
 * an image whose record status is unknown is never compared, so it
 * carries nothing. Its approval comes over whole: the note,
 * who decided and when, and the rotations of its images. A rejected
 * opening is never carried, nor is an opening the new delivery does not
 * count among its openings (records `in_review` or `approved`), nor one
 * whose images differ in number, capture id, role, digest or rotation.
 *
 * `buildCarryForwardStatements` builds the statements; the registration
 * batch (`buildRegistrationStatements` in `link.server.ts`) appends them
 * after the new delivery and its images, so the new delivery's set
 * exists from the moment it is registered, whichever route it came by.
 * Each statement finds the delivery the batch superseded by the new
 * delivery's id (`superseded_by`) and acts only on the set this batch
 * wrote, recognised by the batch's write id and a non-null
 * `carried_from`; a batch whose registration did not land writes no set,
 * so every later statement is a no-op. The statements, in order:
 *
 *   a. the new delivery's set, with a new `decisionsId`, revision 1, the
 *      delivery's opening count and `carried_from` naming the older
 *      delivery, written only when the older delivery's set approved at
 *      least one opening;
 *   b. the carried decisions, `CARRY_IDS_PER_STATEMENT` openings of the
 *      new delivery to a statement, as a JSON array bound as one value;
 *   c. their rotations, as the older delivery holds them;
 *   d. the set's counts and notes' bytes, recounted from its decisions;
 *   e. its state: `approved` when every opening came over, otherwise
 *      `in_capture_qc` (nothing carried is rejected);
 *   f. the set deleted again when no opening qualified, so a retake
 *      whose every opening changed starts with no set, as before.
 *
 * The hold and the status call then read the set as any other: a retake
 * whose every opening is approved again releases the hold
 * (`hold.server.ts`). Every statement binds a fixed handful of values
 * and at most one JSON array of up to `CARRY_IDS_PER_STATEMENT` record
 * ids, which keeps it within D1's 100 bound parameters, and within the
 * 95,000 bytes a file delivery's statement may take once its values are
 * written into the text (`file-route.server.ts`).
 *
 * @version v0.8.0
 */

import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { rawBatchItem } from "../pipeline/callback.server";

/** An image of one of its delivery's openings: its record `in_review` or `approved`. */
const OPENING_IMAGE = (alias: string): SQL => sql.raw(`${alias}.record_status IN ('in_review', 'approved')`);

/**
 * Openings per carried-decisions statement. A Captua record id is an
 * integer; 1,000 of them as a JSON array take at most some 17 KB.
 */
export const CARRY_IDS_PER_STATEMENT = 1000;

export interface CarryForward {
  tenantId: string;
  volumeId: string;
  /** The new delivery, registered by the same batch. */
  deliveryId: string;
  /** The registration batch's write id, which the new delivery row carries. */
  writeId: string;
  /** The new delivery's opening count, as the delivery row records it. */
  openings: number;
  /** The Captua record ids of the new delivery's openings. */
  openingIds: number[];
  /** The `decisionsId` of the carried set. */
  decisionsId: string;
  now: number;
}

/** The statements that carry approvals into a new delivery (module header). Pure. */
export function buildCarryForwardStatements(db: DrizzleD1Database<any>, c: CarryForward): BatchItem<"sqlite">[] {
  if (c.openings < 1 || c.openingIds.length === 0) return [];
  const { tenantId: t, deliveryId: d, writeId: w, now } = c;
  const out: BatchItem<"sqlite">[] = [];

  // The set this batch carried, written under the batch's write id. Each
  // statement names the tenant beside it.
  const carried = (alias: string): SQL =>
    sql`${sql.raw(alias)}.delivery_id = ${d} AND ${sql.raw(alias)}.write_id = ${w}
      AND ${sql.raw(alias)}.carried_from IS NOT NULL`;

  // a. The set, when the superseded delivery approved anything.
  out.push(
    rawBatchItem(
      db,
      sql`INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
          opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id,
          carried_from)
        SELECT ${t}, ${d}, ${c.volumeId}, ${c.decisionsId}, ${now}, 1, ${c.openings}, 0, 0, 0, 0, 'in_capture_qc', ${now},
          ${w}, ps.delivery_id
        FROM capture_qc_sets ps
        JOIN capture_deliveries p ON p.tenant_id = ${t} AND p.id = ps.delivery_id
        WHERE ps.tenant_id = ${t} AND ps.approved_count > 0
          AND p.pipeline_volume_id = ${c.volumeId} AND p.state = 'superseded' AND p.superseded_by = ${d}
          AND EXISTS (SELECT 1 FROM capture_deliveries cd WHERE cd.tenant_id = ${t} AND cd.id = ${d}
            AND cd.state = 'registered' AND cd.write_id = ${w})
          AND NOT EXISTS (SELECT 1 FROM capture_qc_sets es WHERE es.tenant_id = ${t} AND es.delivery_id = ${d})`,
    ),
  );

  // b. The approvals of the openings whose images are unchanged: as many
  // images in both deliveries, and each new one matched by capture id,
  // role, digest and rotation (`IS`, so null matches null and nothing
  // else), counting only the images of each delivery's
  // openings. Within an opening a role is never repeated, so the two
  // together mean the same set of images.
  for (let i = 0; i < c.openingIds.length; i += CARRY_IDS_PER_STATEMENT) {
    const ids = JSON.stringify(c.openingIds.slice(i, i + CARRY_IDS_PER_STATEMENT));
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, note,
            decided_by, decided_by_name, decided_at, set_revision)
          SELECT s.tenant_id, s.delivery_id, o.captua_record_id, 'approved', NULL, o.note,
            o.decided_by, o.decided_by_name, o.decided_at, s.revision
          FROM json_each(${ids}) j
          JOIN capture_qc_sets s ON s.tenant_id = ${t} AND ${carried("s")}
          JOIN capture_qc_decisions o ON o.tenant_id = ${t} AND o.delivery_id = s.carried_from
            AND o.captua_record_id = j.value AND o.decision = 'approved'
          WHERE (SELECT COUNT(*) FROM capture_images ni WHERE ni.tenant_id = ${t} AND ni.delivery_id = s.delivery_id
                AND ni.captua_record_id = j.value AND ${OPENING_IMAGE("ni")}) > 0
            AND (SELECT COUNT(*) FROM capture_images ni WHERE ni.tenant_id = ${t} AND ni.delivery_id = s.delivery_id
                AND ni.captua_record_id = j.value AND ${OPENING_IMAGE("ni")})
              = (SELECT COUNT(*) FROM capture_images oi WHERE oi.tenant_id = ${t} AND oi.delivery_id = s.carried_from
                AND oi.captua_record_id = j.value AND ${OPENING_IMAGE("oi")})
            AND NOT EXISTS (SELECT 1 FROM capture_images ni WHERE ni.tenant_id = ${t} AND ni.delivery_id = s.delivery_id
                AND ni.captua_record_id = j.value AND ${OPENING_IMAGE("ni")}
                AND NOT EXISTS (SELECT 1 FROM capture_images oi WHERE oi.tenant_id = ${t}
                  AND oi.delivery_id = s.carried_from AND oi.captua_record_id = j.value AND ${OPENING_IMAGE("oi")}
                  AND oi.capture_id = ni.capture_id AND oi.role = ni.role AND oi.capture_sha256 = ni.capture_sha256
                  AND oi.rotate_deg IS ni.rotate_deg))`,
      ),
    );
  }

  // c. Their rotations.
  out.push(
    rawBatchItem(
      db,
      sql`INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
        SELECT nd.tenant_id, nd.delivery_id, r.captua_record_id, r.capture_id, r.role, r.quarter_turns
        FROM capture_qc_sets s
        JOIN capture_qc_decisions nd ON nd.tenant_id = ${t} AND nd.delivery_id = s.delivery_id
        JOIN capture_qc_rotations r ON r.tenant_id = ${t} AND r.delivery_id = s.carried_from
          AND r.captua_record_id = nd.captua_record_id
        WHERE s.tenant_id = ${t} AND ${carried("s")}`,
    ),
  );

  // d. The counts. Nothing carried is rejected.
  out.push(
    rawBatchItem(
      db,
      sql`UPDATE capture_qc_sets SET
          decided_count = (SELECT COUNT(*) FROM capture_qc_decisions x1 WHERE x1.tenant_id = ${t} AND x1.delivery_id = ${d}),
          approved_count = (SELECT COUNT(*) FROM capture_qc_decisions x2 WHERE x2.tenant_id = ${t} AND x2.delivery_id = ${d}
            AND x2.decision = 'approved'),
          notes_bytes = (SELECT COALESCE(SUM(length(CAST(x3.note AS BLOB))), 0) FROM capture_qc_decisions x3
            WHERE x3.tenant_id = ${t} AND x3.delivery_id = ${d})
        WHERE tenant_id = ${t} AND ${carried("capture_qc_sets")}`,
    ),
  );

  // e. The state.
  out.push(
    rawBatchItem(
      db,
      sql`UPDATE capture_qc_sets SET
          state = CASE WHEN approved_count = opening_count THEN 'approved' ELSE 'in_capture_qc' END
        WHERE tenant_id = ${t} AND ${carried("capture_qc_sets")}`,
    ),
  );

  // f. No set when nothing came over.
  out.push(
    rawBatchItem(
      db,
      sql`DELETE FROM capture_qc_sets WHERE tenant_id = ${t} AND ${carried("capture_qc_sets")} AND decided_count = 0`,
    ),
  );
  return out;
}

// @version v0.8.0
