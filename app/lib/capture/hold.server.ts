/**
 * Capture QC — the Hold on Processing
 *
 * This module deals with the one rule capture QC imposes on the media
 * pipeline: a volume whose pages came from a Captua capture delivery
 * goes to processing only when every opening of its current delivery
 * is approved, as the Captua exchange contract has it. Dispatch asks it
 * in two places, and both ask the same predicate,
 * `captureQcPendingSql`.
 *
 * `captureQcPendingSql` is an SQL condition on the `pipeline_volumes`
 * row of the statement it sits in. It holds when the volume has a
 * delivery in state `registered` (the one that holds it), no run has
 * named the volume, and either of two things is true of that delivery:
 *
 *   - its manifest has a record `rejected` (its `rejected_records`). A
 *     rejected record is an opening with a retake outstanding on the
 *     unit, whether Fisqua asked for the retake or the unit marked it.
 *     It has no pages planned (`planPages` leaves it out) and is not
 *     among the delivery's openings, so it can never be approved on this
 *     delivery: the volume is held whatever the openings and the decision
 *     set say, until a newer delivery replaces this one with the record
 *     retaken (`in_review` or `approved`) and that opening is approved
 *     in turn;
 *   - it has at least one opening (its `openings`, the records
 *     `in_review` or `approved`) and its decision set is not `approved`,
 *     which it is only once every opening is approved.
 *
 * Both counts are taken when the delivery is registered. A delivery
 * with no openings and no rejected record does not hold: only a staging
 * test registered with `--allow-captured`, every record still
 * `captured`, has neither, and it would otherwise wait for decisions
 * nobody can make. The counts are columns because records past 64 KiB
 * are stored packed (`{"$gzip": ...}`), which SQL cannot read. A volume
 * with no Captua delivery is not held, and nor is one a run has already
 * named: decisions are fixed once a run starts and a newer manifest is
 * refused after it, so a volume that has run was either approved when
 * its first run claimed it or ran before capture QC existed, and holding
 * it would leave it with no way forward. The condition binds nothing; it
 * reads the volume's tenant and id from the row, so a claim statement
 * can carry it within D1's 100 bound parameters.
 *
 * `readCaptureQcPending` is dispatch's step-4 read: which of the
 * requested volumes are held, 90 ids per statement. The claim carries
 * the same condition, so a decision that rejects an opening, or a newer
 * delivery with a rejected record, landing between the read and the
 * claim makes the claim fail rather than process a volume with a retake
 * outstanding.
 *
 * A volume registered from a manifest file with the registration
 * command has a delivery as well, with route `file`
 * (`file-route.server.ts`), and is held as one delivered over the link
 * is: the condition reads the delivery, not its route. A volume with no
 * delivery is material digitised elsewhere and is not held.
 *
 * @version v0.8.0
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { pipelineVolumes } from "../../db/schema";

/** Ids per read statement, under D1's 100 bound parameters. */
const READ_ID_CHUNK = 90;

/**
 * The `pipeline_volumes` row of the enclosing statement is held by
 * capture QC (module header).
 */
export function captureQcPendingSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM capture_deliveries hd WHERE hd.tenant_id = pipeline_volumes.tenant_id
    AND hd.pipeline_volume_id = pipeline_volumes.id AND hd.state = 'registered'
    AND NOT EXISTS (SELECT 1 FROM pipeline_run_volumes hrv WHERE hrv.tenant_id = pipeline_volumes.tenant_id
      AND hrv.pipeline_volume_id = pipeline_volumes.id)
    AND (hd.rejected_records > 0
      OR (hd.openings > 0
        AND NOT EXISTS (SELECT 1 FROM capture_qc_sets hs WHERE hs.tenant_id = pipeline_volumes.tenant_id
          AND hs.delivery_id = hd.id AND hs.state = 'approved'))))`;
}

/** Which of `ids`, volumes of the tenant, capture QC holds, in request order. */
export async function readCaptureQcPending(
  db: DrizzleD1Database<any>,
  tenantId: string,
  ids: string[],
): Promise<string[]> {
  const held = new Set<string>();
  for (let i = 0; i < ids.length; i += READ_ID_CHUNK) {
    const rows = await db
      .select({ id: pipelineVolumes.id })
      .from(pipelineVolumes)
      .where(
        and(
          eq(pipelineVolumes.tenantId, tenantId),
          inArray(pipelineVolumes.id, ids.slice(i, i + READ_ID_CHUNK)),
          captureQcPendingSql(),
        ),
      )
      .all();
    for (const r of rows) held.add(r.id);
  }
  return ids.filter((id) => held.has(id));
}

// @version v0.8.0
