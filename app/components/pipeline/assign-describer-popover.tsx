/**
 * Assign Describer Popover
 *
 * Popover on the pipeline card that lets a lead assign or reassign
 * the describer for an entry. Runs a typeahead against project
 * members, respects the workflow-role gate, and submits through a
 * fetcher so the card updates in place.
 *
 * @version v0.3.0
 */
import { useState, useRef, useEffect } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

interface TeamMember {
  id: string;
  name: string | null;
  email: string;
}

interface AssignDescriberPopoverProps {
  entryId: string;
  projectId: string;
  teamMembers: TeamMember[];
  onClose: () => void;
}

export function AssignDescriberPopover({
  entryId,
  projectId,
  teamMembers,
  onClose,
}: AssignDescriberPopoverProps) {
  const { t } = useTranslation("pipeline");
  const fetcher = useFetcher();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const filteredMembers = teamMembers.filter((m) => {
    const query = search.toLowerCase();
    return (
      (m.name?.toLowerCase().includes(query) ?? false) ||
      m.email.toLowerCase().includes(query)
    );
  });

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Close after successful submission
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose]);

  function handleAssign() {
    if (!selectedId) return;
    fetcher.submit(
      {
        intent: "assignDescriber",
        entryId,
        describerId: selectedId,
      },
      { method: "POST" }
    );
  }

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-stone-200 bg-white p-3 shadow-lg"
    >
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("search_team")}
        className="mb-2 w-full rounded border border-stone-200 px-2 py-1.5 text-sm text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none"
      />

      <ul className="max-h-40 overflow-y-auto">
        {filteredMembers.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              onClick={() => setSelectedId(member.id)}
              className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                selectedId === member.id
                  ? "bg-indigo-tint text-indigo"
                  : "text-stone-700 hover:bg-stone-50"
              }`}
            >
              <span className="block">{member.name ?? member.email}</span>
              {member.name && (
                <span className="block text-xs text-stone-400">
                  {member.email}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-50"
        >
          {t("assign_cancel")}
        </button>
        <button
          type="button"
          onClick={handleAssign}
          disabled={!selectedId || fetcher.state !== "idle"}
          className="rounded bg-indigo px-3 py-1.5 text-sm text-parchment hover:bg-indigo-deep disabled:opacity-50"
        >
          {t("assign_confirm")}
        </button>
      </div>

      {fetcher.data?.error && (
        <p className="mt-2 text-xs text-madder-deep">{t("error_assign")}</p>
      )}
    </div>
  );
}
