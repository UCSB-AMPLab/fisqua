export type EntryType = "item" | "blank" | "front_matter" | "back_matter";

export type Entry = {
  id: string;
  volumeId: string;
  parentId: string | null;
  position: number; // 0-based sibling order
  startPage: number; // 1-based page number
  startY: number; // 0.0-1.0 fraction of page height (0 = top)
  endPage: number | null; // explicit for children, null for top-level
  endY: number | null; // 0.0-1.0, null for top-level
  type: EntryType | null; // null = unset
  title: string | null;
  note: string | null;
  noteUpdatedBy: string | null;
  noteUpdatedAt: number | null;
  reviewerComment: string | null;
  reviewerCommentUpdatedBy: string | null;
  reviewerCommentUpdatedAt: number | null;
  modifiedBy: string | null; // userId of last modifier, null = original cataloguer
  // Description fields (all nullable -- populated during description workflow)
  translatedTitle: string | null;
  resourceType: string | null;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  extent: string | null;
  scopeContent: string | null;
  language: string | null;
  descriptionNotes: string | null;
  internalNotes: string | null;
  descriptionLevel: string | null;
  descriptionStatus: string | null;
  assignedDescriber: string | null;
  assignedDescriptionReviewer: string | null;
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
  | { type: "ADD_BOUNDARY"; startPage: number; startY?: number; id?: string; modifiedBy?: string }
  | { type: "MOVE_BOUNDARY"; entryId: string; startPage: number; toY?: number; modifiedBy?: string }
  | { type: "DELETE_BOUNDARY"; entryId: string; modifiedBy?: string }
  | { type: "INDENT"; entryId: string; modifiedBy?: string }
  | { type: "OUTDENT"; entryId: string; modifiedBy?: string }
  | { type: "SET_TYPE"; entryId: string; entryType: EntryType | null; modifiedBy?: string }
  | { type: "SET_TITLE"; entryId: string; title: string; modifiedBy?: string }
  | { type: "SET_END_PAGE"; entryId: string; endPage: number; modifiedBy?: string }
  | { type: "SET_END_Y"; entryId: string; endY: number; modifiedBy?: string }
  | { type: "SET_NOTE"; entryId: string; note: string; noteUpdatedBy?: string }
  | { type: "SET_REVIEWER_COMMENT"; entryId: string; reviewerComment: string; reviewerCommentUpdatedBy?: string }
  | { type: "MARK_SAVED" }
  | { type: "MARK_SAVING" }
  | { type: "MARK_DIRTY" };
