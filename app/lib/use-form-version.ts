/**
 * Edit forms — the version a form submits, and the record it edits
 *
 * This module deals with the version an admin edit form (descriptions,
 * entities, places, repositories) submits: `_updatedAt`, the version of
 * the record its field values were loaded from. The update action refuses
 * the save when the stored version differs. The fields are uncontrolled
 * inputs that keep what the editor typed, so the version must not follow
 * the loader: the page revalidates its loader after every action on it
 * (the autosave POST, a link change, a comment), and a version taken from
 * the revalidated loader would let a save carrying this editor's older
 * field values pass after another editor saved.
 *
 * The version is therefore held in state. It is the loader's version
 * when the form's fields are loaded, which `formKey` marks (the record
 * and whether the form is in edit mode: the inputs mount, with the
 * loader's values, when edit mode opens), and it becomes the version a
 * successful save of the form returned (`updatedAt` in the action's
 * response), whose values are the ones the form now holds. A write to
 * the record from another fetcher on the page (publishing a
 * description) returns the versions it moved the record `from` and
 * `to`; the form takes `to` only when it holds `from`, so such a write
 * never hides another editor's save made before it. Every such
 * transition seen for the form's current load is kept, and after any
 * response the form follows each kept transition that starts at its
 * version, so the order in which a save's and a toggle's responses
 * arrive does not matter. Nothing else moves the version.
 *
 * Edit mode belongs to the record it was opened on (`useRecordEditMode`).
 * The route component is reused when the editor follows a link to
 * another record of the same type; the page is then not in edit
 * mode, the inputs loaded for the first record unmount in the same
 * render, and the form's key changes with the record. A form's inputs
 * and its version therefore always come from the same load.
 *
 * @version v0.9.0
 */

import { useState } from "react";

/** A move of the record's version by another write on the page. */
interface Transition {
  from: number;
  to: number;
}

export interface FormVersionState {
  /** The record and mode the form's fields were loaded for. */
  key: string;
  /** The version the form submits. */
  version: number;
  /** The last action response seen, so each save is taken once. */
  saved: unknown;
  /** The last response of the other record write seen, taken once too. */
  moved: unknown;
  /** The transitions of other writes seen since the fields were loaded. */
  transitions: Transition[];
}

/** The most transitions kept; a page sees a handful per edit. */
const MAX_TRANSITIONS = 32;

/** The version a successful save returned, if `saved` is one. */
function savedVersion(saved: unknown): number | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as { ok?: unknown; updatedAt?: unknown };
  return s.ok === true && typeof s.updatedAt === "number" ? s.updatedAt : null;
}

/** The versions another write moved the record between, if `moved` is one. */
function movedVersions(moved: unknown): Transition | null {
  if (!moved || typeof moved !== "object") return null;
  const m = moved as { ok?: unknown; from?: unknown; to?: unknown };
  return m.ok === true && typeof m.from === "number" && typeof m.to === "number"
    ? { from: m.from, to: m.to }
    : null;
}

/** `version` after every kept transition that starts at it, in chain. */
function follow(version: number, transitions: Transition[]): number {
  let current = version;
  // Each transition moves the version forward, so the chain ends; the
  // bound guards against malformed input.
  for (let i = 0; i <= transitions.length; i++) {
    const step = transitions.find((t) => t.from === current);
    if (!step) break;
    current = step.to;
  }
  return current;
}

/**
 * The form version after a render with `formKey`, the loader's
 * `loaderVersion`, the action response `saved` and the response
 * `moved` of another write to the record. Returns `state` itself when
 * nothing moves.
 */
export function nextFormVersion(
  state: FormVersionState | null,
  formKey: string,
  loaderVersion: number,
  saved: unknown,
  moved?: unknown,
): FormVersionState {
  if (!state) return { key: formKey, version: loaderVersion, saved, moved, transitions: [] };
  let next = state;
  if (formKey !== next.key) {
    next = { ...next, key: formKey, version: loaderVersion, transitions: [] };
  }
  if (saved !== next.saved) {
    next = { ...next, saved, version: savedVersion(saved) ?? next.version };
  }
  if (moved !== next.moved) {
    const transition = movedVersions(moved);
    next = {
      ...next,
      moved,
      transitions: transition
        ? [...next.transitions, transition].slice(-MAX_TRANSITIONS)
        : next.transitions,
    };
  }
  if (next !== state) {
    const version = follow(next.version, next.transitions);
    if (version !== next.version) next = { ...next, version };
  }
  return next;
}

/** The version the edit form submits as `_updatedAt`. */
export function useFormVersion(
  formKey: string,
  loaderVersion: number,
  saved: unknown,
  moved?: unknown,
): number {
  const [state, setState] = useState<FormVersionState>(() =>
    nextFormVersion(null, formKey, loaderVersion, saved, moved),
  );
  const next = nextFormVersion(state, formKey, loaderVersion, saved, moved);
  if (next !== state) setState(next);
  return next.version;
}

/** Whether the page is in edit mode for `recordId`, given the record edit mode was opened on. */
export function isEditingRecord(editingId: string | null, recordId: string): boolean {
  return editingId !== null && editingId === recordId;
}

/**
 * Edit mode for the record a detail page shows, as `[isEditing,
 * setIsEditing]`. Opening it records the record's id; on another
 * record the page is not in edit mode.
 */
export function useRecordEditMode(recordId: string): [boolean, (editing: boolean) => void] {
  const [editingId, setEditingId] = useState<string | null>(null);
  return [
    isEditingRecord(editingId, recordId),
    (editing: boolean) => setEditingId(editing ? recordId : null),
  ];
}

// @version v0.9.0
