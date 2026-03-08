import { useState, useRef, useCallback } from "react";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { volumes, volumePages } from "../db/schema";
import { DivaViewer } from "../components/viewer/diva-viewer";
import { PageLabels } from "../components/viewer/page-labels";
import { ViewerToolbar } from "../components/viewer/viewer-toolbar";
import { ViewerTopBar } from "../components/viewer/viewer-top-bar";
import type { Route } from "./+types/_auth.viewer.$projectId.$volumeId";

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access (admins bypass)
  await requireProjectRole(db, user.id, params.projectId, ["lead"], user.isAdmin);

  // Fetch volume, verify it belongs to this project
  const volume = await db
    .select()
    .from(volumes)
    .where(
      and(eq(volumes.id, params.volumeId), eq(volumes.projectId, params.projectId))
    )
    .get();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  // Fetch page labels for the left gutter
  const pages = await db
    .select({ position: volumePages.position, label: volumePages.label })
    .from(volumePages)
    .where(eq(volumePages.volumeId, params.volumeId))
    .orderBy(volumePages.position)
    .all();

  return { volume, pages, projectId: params.projectId };
}

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  const { volume, pages, projectId } = loaderData;
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const divaRef = useRef<any>(null);

  const handlePageChange = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
  }, []);

  const handleZoomIn = useCallback(() => {
    divaRef.current?.app?.ports?.zoomByStep?.send(1);
  }, []);

  const handleZoomOut = useCallback(() => {
    divaRef.current?.app?.ports?.zoomByStep?.send(-1);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <ViewerTopBar volumeName={volume.name} projectId={projectId} />
      <div className="relative flex-1 overflow-hidden">
        <PageLabels pages={pages} currentPageIndex={currentPageIndex} />
        <DivaViewer
          manifestUrl={volume.manifestUrl}
          onPageChange={handlePageChange}
          divaRef={divaRef}
        />
        <ViewerToolbar onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />
      </div>
    </div>
  );
}
