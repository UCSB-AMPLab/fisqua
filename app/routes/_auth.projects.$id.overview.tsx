/**
 * Project Overview Page
 *
 * This page is the landing surface for one project: headline stats,
 * the list of volumes with their descrption-workflow status, and
 * quick links into the
 * more specialised project surfaces. The one mutation it hosts is the
 * describer assignment on the kanban card; every other mutation lives
 * on the dedicated sub-pages.
 *
 * @version v0.7.0
 */

import { useState, useCallback } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext, tenantContext } from "../context";
import { PipelineColumn } from "../components/pipeline/pipeline-column";
import { AssignDescriberPopover } from "../components/pipeline/assign-describer-popover";
import type { Route } from "./+types/_auth.projects.$id.overview";
import type { PipelineColumn as PipelineColumnType } from "../lib/pipeline/pipeline.server";
import { PROJECT_ROLES } from "../lib/validation/enums";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getPipelineData, getTeamMembers } = await import(
    "../lib/pipeline/pipeline.server"
  );

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  await requireProjectRole(
    db,
    tenant.id,
    user.id,
    params.id,
    [...PROJECT_ROLES],
    user.isAdmin
  );

  const [columns, teamMembers] = await Promise.all([
    getPipelineData(db, tenant.id, params.id),
    getTeamMembers(db, tenant.id, params.id),
  ]);

  return { columns, teamMembers, user, projectId: params.id };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { z } = await import("zod");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { assignDescriber } = await import(
    "../lib/pipeline/pipeline.server"
  );
  const { entries, volumes, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Loaders and actions are separately reachable, so the action needs
  // its own guard — the loader's proves nothing about this request.
  // Roles mirror the loader's: any member of the project may work the
  // kanban, which is also what the UI offers.
  await requireProjectRole(
    db,
    tenant.id,
    user.id,
    params.id,
    [...PROJECT_ROLES],
    user.isAdmin
  );

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "assignDescriber") {
    const schema = z.object({
      entryId: z.string().min(1),
      describerId: z.string().min(1),
    });

    const parsed = schema.safeParse({
      entryId: formData.get("entryId"),
      describerId: formData.get("describerId"),
    });

    if (!parsed.success) {
      return { success: false, error: "Invalid input" };
    }

    // Holding a role on params.id authorises writes to params.id only.
    // Resolve the submitted entry back to its own project and refuse
    // anything that does not land in the project we authorised against
    // — 404, not 403, so a foreign entry id is not confirmed to exist.
    const [linked] = await db
      .select({ projectId: volumes.projectId })
      .from(entries)
      .innerJoin(volumes, eq(entries.volumeId, volumes.id))
      .where(eq(entries.id, parsed.data.entryId))
      .limit(1)
      .all();

    if (!linked || linked.projectId !== params.id) {
      throw new Response("Not Found", { status: 404 });
    }

    // The describer must already be a member of this project. Without
    // this an arbitrary user id — including one from another tenant —
    // could be written into entries.assigned_describer.
    const [describerMembership] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, params.id),
          eq(projectMembers.userId, parsed.data.describerId)
        )
      )
      .limit(1)
      .all();

    if (!describerMembership) {
      return Response.json(
        { success: false, error: "Describer is not a project member" },
        { status: 400 }
      );
    }

    return assignDescriber(
      db,
      tenant.id,
      parsed.data.entryId,
      parsed.data.describerId
    );
  }

  return { success: false, error: "Unknown intent" };
}

const SEGMENTATION_COLUMN_IDS = [
  "unstarted",
  "segmenting",
  "seg_review",
  "ready_to_describe",
];
const DESCRIPTION_COLUMN_IDS = [
  "describing",
  "desc_review",
  "ready_to_promote",
];

type Stage = "segmentation" | "description";

export default function ProjectOverview({
  loaderData,
}: Route.ComponentProps) {
  const { columns, teamMembers, user, projectId } = loaderData;
  const { t } = useTranslation("pipeline");
  const [searchParams, setSearchParams] = useSearchParams();
  const stage: Stage =
    searchParams.get("stage") === "description" ? "description" : "segmentation";

  const [assignPopover, setAssignPopover] = useState<{
    entryId: string;
    projectId: string;
  } | null>(null);

  const handleAssignClick = useCallback(
    (entryId: string, projectId: string) => {
      setAssignPopover({ entryId, projectId });
    },
    []
  );

  const handleAssignClose = useCallback(() => {
    setAssignPopover(null);
  }, []);

  const filterIds =
    stage === "segmentation" ? SEGMENTATION_COLUMN_IDS : DESCRIPTION_COLUMN_IDS;
  const visibleColumns: PipelineColumnType[] = columns.filter((c) =>
    filterIds.includes(c.id)
  );

  const setStage = (s: Stage) => {
    const next = new URLSearchParams(searchParams);
    if (s === "segmentation") {
      next.delete("stage");
    } else {
      next.set("stage", s);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div>
      {/* Stage toggle */}
      <div className="mb-6 flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-stone-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setStage("segmentation")}
            className={`rounded-md px-3 py-1.5 font-sans text-sm font-medium transition-colors ${
              stage === "segmentation"
                ? "bg-indigo text-parchment"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("stage_segmentation")}
          </button>
          <button
            type="button"
            onClick={() => setStage("description")}
            className={`rounded-md px-3 py-1.5 font-sans text-sm font-medium transition-colors ${
              stage === "description"
                ? "bg-indigo text-parchment"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("stage_description")}
          </button>
        </div>
      </div>

      {/* Kanban */}
      <div className="overflow-x-auto">
        <div className="relative flex gap-4">
          {visibleColumns.map((column) => (
            <PipelineColumn
              key={column.id}
              column={column}
              columnId={column.id}
              isSuperAdmin={user.isSuperAdmin}
              onAssignClick={handleAssignClick}
            />
          ))}

          {assignPopover && (
            <AssignDescriberPopover
              entryId={assignPopover.entryId}
              projectId={assignPopover.projectId}
              teamMembers={teamMembers}
              onClose={handleAssignClose}
            />
          )}
        </div>
      </div>

      {visibleColumns.every((c) => c.items.length === 0) && (
        <p className="mt-8 rounded-lg border border-stone-200 px-4 py-8 text-center font-sans text-sm text-stone-400">
          {stage === "segmentation"
            ? t("empty_segmentation")
            : t("empty_description")}
        </p>
      )}
    </div>
  );
}
