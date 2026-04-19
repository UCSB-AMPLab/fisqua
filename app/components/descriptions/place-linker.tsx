/**
 * Place Linker
 *
 * Dialog for linking a place authority record to the current description,
 * with typeahead search, role picker, and inline create-new flow.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Pencil, X, Plus } from "lucide-react";
import { SearchPopover } from "./search-popover";
import { PLACE_ROLES } from "~/lib/validation/enums";

export interface DescriptionPlaceLink {
  id: string;
  descriptionId: string;
  placeId: string;
  role: string;
  roleNote: string | null;
  createdAt: number;
  placeLabel: string;
  placeCode: string | null;
}

interface PlaceLinkerProps {
  descriptionId: string;
  links: DescriptionPlaceLink[];
  isEditing: boolean;
}

interface SelectedPlace {
  id: string;
  name: string;
  code: string;
}

export function PlaceLinker({
  descriptionId,
  links,
  isEditing,
}: PlaceLinkerProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher();
  const [showSearch, setShowSearch] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(
    null
  );
  const [addRole, setAddRole] = useState<string>("created");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const existingPlaceIds = links.map((l) => l.placeId);

  function handleSelect(item: { id: string; name: string; code: string }) {
    setSelectedPlace(item);
    setShowSearch(false);
  }

  function handleConfirmAdd() {
    if (!selectedPlace) return;
    fetcher.submit(
      {
        _action: "link_place",
        descriptionId,
        placeId: selectedPlace.id,
        role: addRole,
      },
      { method: "post" }
    );
    resetAddForm();
  }

  function resetAddForm() {
    setSelectedPlace(null);
    setShowSearch(false);
    setAddRole("created");
  }

  function startEdit(link: DescriptionPlaceLink) {
    setEditingId(link.id);
    setEditRole(link.role);
  }

  function handleSaveEdit() {
    if (!editingId) return;
    fetcher.submit(
      {
        _action: "update_place_link",
        linkId: editingId,
        role: editRole,
      },
      { method: "post" }
    );
    setEditingId(null);
  }

  function handleRemove(linkId: string) {
    fetcher.submit(
      { _action: "remove_place_link", linkId },
      { method: "post" }
    );
    setConfirmRemoveId(null);
  }

  return (
    <div>
      {/* Linked place list */}
      {links.length > 0 && (
        <ul className="space-y-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex items-center gap-2 rounded border border-[#E7E5E4] px-3 py-2"
            >
              {/* Content area */}
              {editingId === link.id ? (
                /* Inline edit mode */
                <div className="flex flex-1 items-center gap-2">
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="rounded border border-[#E7E5E4] px-2 py-1 text-sm"
                  >
                    {PLACE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    className="rounded bg-[#6B1F33] px-3 py-1 text-xs font-semibold text-white hover:bg-[#8B2942]"
                  >
                    {t("save_changes")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="text-xs text-[#78716C] hover:text-[#44403C]"
                  >
                    {t("link_cancel")}
                  </button>
                </div>
              ) : (
                /* Display mode */
                <div className="flex flex-1 items-center gap-2">
                  <span className="text-sm text-[#44403C]">
                    {link.placeLabel}
                  </span>
                  <span className="rounded bg-[#F5E6EA] px-1.5 py-0.5 text-xs font-medium text-[#6B1F33]">
                    {t(`role_${link.role}`, link.role)}
                  </span>
                </div>
              )}

              {/* Action buttons (edit mode, not inline editing) */}
              {isEditing && editingId !== link.id && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={t("aria_edit_link")}
                    onClick={() => startEdit(link)}
                    className="text-[#78716C] hover:text-[#44403C]"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {confirmRemoveId === link.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRemove(link.id)}
                        className="text-xs font-semibold text-[#DC2626] hover:underline"
                      >
                        {t("remove_link_button")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(null)}
                        className="text-xs text-[#78716C] hover:text-[#44403C]"
                      >
                        {t("link_cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("aria_remove_link", {
                        name: link.placeLabel,
                      })}
                      onClick={() => setConfirmRemoveId(link.id)}
                      className="text-[#78716C] hover:text-[#DC2626]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {links.length === 0 && !isEditing && (
        <p className="text-sm text-[#78716C]">{"\u2014"}</p>
      )}

      {/* Add place flow */}
      {isEditing && !selectedPlace && (
        <div className="relative mt-3">
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-[#6B1F33] hover:text-[#8B2942]"
          >
            <Plus className="h-4 w-4" />
            {t("add_place")}
          </button>
          {showSearch && (
            <SearchPopover
              type="place"
              onSelect={handleSelect}
              onClose={() => setShowSearch(false)}
              excludeIds={existingPlaceIds}
            />
          )}
        </div>
      )}

      {/* Selected place — role form */}
      {isEditing && selectedPlace && (
        <div className="mt-3 space-y-2 rounded border border-[#E7E5E4] p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[#44403C]">
              {selectedPlace.name}
            </span>
            <button
              type="button"
              onClick={() => setSelectedPlace(null)}
              className="text-[#78716C] hover:text-[#44403C]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#78716C]">
              {t("role_label")}
            </label>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="w-full rounded border border-[#E7E5E4] px-2 py-1 text-sm"
            >
              {PLACE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirmAdd}
              className="rounded bg-[#6B1F33] px-3 py-1 text-xs font-semibold text-white hover:bg-[#8B2942]"
            >
              {t("link_confirm")}
            </button>
            <button
              type="button"
              onClick={resetAddForm}
              className="text-xs text-[#78716C] hover:text-[#44403C]"
            >
              {t("link_cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
