export type EntryType = "item" | "blank" | "front_matter" | "back_matter";

export type Entry = {
  id: string;
  volumeId: string;
  parentId: string | null;
  position: number; // 0-based sibling order
  startPage: number; // 1-based page number
  endPage: number | null; // explicit for children, null for top-level
  type: EntryType | null; // null = unset
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BoundaryState = {
  entries: Entry[];
  isDirty: boolean;
  saveStatus: "saved" | "saving" | "unsaved";
  version: number;
};

export type BoundaryAction =
  | { type: "INIT"; entries: Entry[] }
  | { type: "ADD_BOUNDARY"; afterPage: number; id?: string }
  | { type: "MOVE_BOUNDARY"; entryId: string; toPage: number }
  | { type: "DELETE_BOUNDARY"; entryId: string }
  | { type: "INDENT"; entryId: string }
  | { type: "OUTDENT"; entryId: string }
  | { type: "SET_TYPE"; entryId: string; entryType: EntryType | null }
  | { type: "SET_TITLE"; entryId: string; title: string }
  | { type: "SET_END_PAGE"; entryId: string; endPage: number }
  | { type: "MARK_SAVED" }
  | { type: "MARK_SAVING" }
  | { type: "MARK_DIRTY" };
