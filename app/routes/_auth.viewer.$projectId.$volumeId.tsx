import { useState, useRef, useCallback } from "react";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { volumes, volumePages } from "../db/schema";
import { IIIFViewer } from "../components/viewer/iiif-viewer";
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

  // Fetch pages with dimensions for virtualised viewer
  const pages = await db
    .select({
      position: volumePages.position,
      label: volumePages.label,
      imageUrl: volumePages.imageUrl,
      width: volumePages.width,
      height: volumePages.height,
    })
    .from(volumePages)
    .where(eq(volumePages.volumeId, params.volumeId))
    .orderBy(volumePages.position)
    .all();

  return { volume, pages, projectId: params.projectId };
}

export type PageData = {
  position: number;
  label: string | null;
  imageUrl: string;
  width: number;
  height: number;
};

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  const { volume, pages, projectId } = loaderData;
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const viewerRef = useRef<{ zoomIn: () => void; zoomOut: () => void; scrollToPage: (index: number) => void } | null>(null);

  const handlePageChange = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
  }, []);

  const handleZoomIn = useCallback(() => {
    viewerRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    viewerRef.current?.zoomOut();
  }, []);

  const currentPage = pages[currentPageIndex];
  const pageLabel = currentPage?.label || String(currentPage?.position ?? 1);

  return (
    <div className="flex h-screen flex-col">
      <ViewerTopBar volumeName={volume.name} projectId={projectId} pageLabel={pageLabel} />
      <div className="relative flex-1 overflow-hidden">
        <IIIFViewer
          pages={pages}
          onPageChange={handlePageChange}
          ref={viewerRef}
        />
        <ViewerToolbar onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />
      </div>
    </div>
  );
}
