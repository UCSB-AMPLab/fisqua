import { Form, Link } from "react-router";

type VolumeCardProps = {
  volume: {
    id: string;
    name: string;
    referenceCode: string;
    pageCount: number;
    status: string;
    assignedTo: string | null;
    firstPageImageUrl: string | null;
  };
  projectId: string;
};

const statusBadgeColors: Record<string, string> = {
  unstarted: "bg-stone-100 text-stone-600",
  in_progress: "bg-blue-100 text-blue-800",
  segmented: "bg-amber-100 text-amber-800",
  reviewed: "bg-green-100 text-green-800",
  approved: "bg-emerald-100 text-emerald-800",
  sent_back: "bg-red-100 text-red-700",
};

const statusLabels: Record<string, string> = {
  unstarted: "Unstarted",
  in_progress: "In progress",
  segmented: "Segmented",
  reviewed: "Reviewed",
  approved: "Approved",
  sent_back: "Needs revision",
};

export function VolumeCard({ volume, projectId }: VolumeCardProps) {
  const thumbnailUrl = volume.firstPageImageUrl
    ? `${volume.firstPageImageUrl}/full/200,/0/default.jpg`
    : null;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <Link
        to={`/projects/${projectId}/volumes/${volume.id}`}
        className="block"
      >
        {/* Thumbnail */}
        <div className="flex h-40 items-center justify-center bg-stone-50">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={`First page of ${volume.name}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <svg
              className="h-12 w-12 text-stone-300"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
          )}
        </div>

        {/* Body */}
        <div className="p-3">
          <h3 className="truncate text-sm font-semibold text-stone-900">
            {volume.name}
          </h3>
          <p className="mt-0.5 text-xs text-stone-500">{volume.referenceCode}</p>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-stone-500">
              {volume.pageCount} {volume.pageCount === 1 ? "page" : "pages"}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeColors[volume.status] || "bg-stone-100 text-stone-600"}`}
            >
              {statusLabels[volume.status] || volume.status}
            </span>
          </div>
        </div>
      </Link>

      {/* Footer -- delete action */}
      {volume.status === "unstarted" && (
        <div className="border-t border-stone-100 px-3 py-2">
          <Form
            method="post"
            onSubmit={(e) => {
              if (
                !window.confirm(
                  "Delete this volume? This cannot be undone."
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="_action" value="delete-volume" />
            <input type="hidden" name="volumeId" value={volume.id} />
            <button
              type="submit"
              className="text-xs text-red-500 hover:text-red-700"
            >
              Delete
            </button>
          </Form>
        </div>
      )}
    </div>
  );
}
