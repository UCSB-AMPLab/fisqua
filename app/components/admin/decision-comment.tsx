/**
 * DecisionThread — renders a pending-decision conversation.
 *
 * A comment is the producer's whole message to the reviewer: prose
 * first (reasoning, caveats, and the source sentence at its end), and
 * optionally one passage lifted off the catalogue. Attribution is
 * author + pill + date: label authors ("Fisqua") get the System pill,
 * human authors get a pill naming their snapshotted role. Comment
 * prose is set in the sans — Spectral italic is reserved for quoted
 * catalogue text, so quotation keeps reading as quotation. The quote
 * sits on parchment (the archival surface), its reference in mono with
 * a render-time source line; none of that presentation is stored.
 *
 * The `note` column stays in the data shape but is no longer rendered
 * on decision threads: what a producer knows and how sure it is belongs
 * in its prose, and a demoted second paragraph only split the reading.
 * Where the surrounding route has resolved a quote's reference code to
 * a description of its own, the mono reference becomes a link to it —
 * the resolution is the route's (one scoped query per thread), never
 * this component's.
 *
 * Attribution is one system, not two: Fisqua carries the System pill,
 * humans carry their role pill, and both share the same pill geometry.
 * The role colour pairs (admin/cataloguer/lead/reviewer) come from the
 * duplicates design round's unified attribution table.
 *
 * The thread is read-only by default and becomes writable only where a
 * `viewer` is handed in — the queue cards and the duplicates list pass
 * nothing and render exactly as they always have. Where a viewer is
 * present, each comment carries the two acts its author (or, for
 * delete, a tenant admin) is entitled to, at the quietest tier the
 * card has: a text Edit that swaps the prose for a textarea in place,
 * and a Delete that arms on first click and commits on the second.
 * Deleting one comment is not a ruling, so it gets no dialog — the
 * armed label IS the confirmation, and it disarms on blur or after
 * four seconds so a stray click never lands on a live trigger. The
 * "Edited" chip is not viewer-gated: that a comment was rewritten is
 * part of the record, so every surface shows it.
 *
 * @version v0.7.0
 */

import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

export interface ThreadComment {
  id: string;
  author: string;
  /** NULL for label-authored (pipeline) comments — never editable. */
  authorId: string | null;
  role: string | null;
  isSystem: boolean;
  body: string;
  quote: string | null;
  quoteRef: string | null;
  note: string | null;
  createdAt: number;
  editedAt: number | null;
}

/** The signed-in reader, when the surface lets them act on the thread. */
export interface ThreadViewer {
  userId: string;
  isAdmin: boolean;
}

/** Role pills use the system's status pairs, keyed by role. */
const ROLE_PILL_CLASSES: Record<string, string> = {
  admin: "bg-madder-tint text-madder-deep",
  cataloguer: "bg-indigo-tint text-indigo",
  lead: "bg-verdigris-tint text-verdigris-deep",
  reviewer: "border border-sage-soft bg-white text-sage-deep",
};

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`rounded-full px-1.5 py-px text-[0.625rem] font-semibold uppercase tracking-[0.06em] ${className}`}
    >
      {label}
    </span>
  );
}

/** The producer's prose, one paragraph per non-empty line. */
function CommentBody({ body }: { body: string }) {
  return (
    <>
      {body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, i) => (
          <p
            key={i}
            className="mt-1.5 text-sm leading-relaxed text-stone-700 [text-wrap:pretty]"
          >
            {line}
          </p>
        ))}
    </>
  );
}

/** The reference-code chip under a quote, linked or not. */
const QUOTE_REF_CLASS =
  "font-mono text-11 font-medium tracking-[0.02em] text-indigo-soft";

/**
 * What hangs off the prose — the lifted passage. It is not editable
 * here, so it survives edit mode untouched.
 */
function CommentExtras({
  comment,
  quoteRefHref,
}: {
  comment: ThreadComment;
  /** Set when the route resolved `quoteRef` to a description it owns. */
  quoteRefHref?: string;
}) {
  const { t } = useTranslation("decisions");
  return (
    <>
      {comment.quote && (
        <blockquote className="mt-2 rounded-sm bg-parchment px-3.5 py-2.5">
          <p className="font-serif text-15 italic leading-relaxed text-indigo">
            {comment.quote}
          </p>
          {comment.quoteRef && (
            <footer className="mt-2 flex items-baseline gap-2 border-t border-parchment-deep pt-2">
              {quoteRefHref ? (
                <Link
                  to={quoteRefHref}
                  className={`${QUOTE_REF_CLASS} hover:underline`}
                >
                  {comment.quoteRef}
                </Link>
              ) : (
                <span className={QUOTE_REF_CLASS}>{comment.quoteRef}</span>
              )}
              <span className="text-11 text-stone-500">{t("quoteSource")}</span>
            </footer>
          )}
        </blockquote>
      )}
    </>
  );
}

const EDIT_TEXTAREA_CLASS =
  "mt-1.5 block w-full resize-none rounded-lg border border-stone-300 bg-white p-3 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris";
const EDIT_SAVE_CLASS =
  "inline-flex h-[42px] items-center rounded-lg border border-stone-300 bg-white px-3.5 text-sm font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30";
const QUIET_ACTION_CLASS = "text-11 font-medium text-stone-400";

/** Which act the open fetcher is carrying, so a stale result can't fire twice. */
type PendingAct = "edit" | "delete" | null;

/**
 * The writable face of a comment: prose that can become a textarea,
 * and the quiet act row underneath. Mounted only where a viewer was
 * handed in, so read-only surfaces open no fetchers at all.
 */
function EditableComment({
  comment,
  viewer,
  quoteRefHref,
}: {
  comment: ThreadComment;
  viewer: ThreadViewer;
  quoteRefHref?: string;
}) {
  const { t } = useTranslation("decisions");
  const fetcher = useFetcher<{ ok: boolean }>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [armed, setArmed] = useState(false);
  // Which act failed, so the error line can say the right thing — a
  // rejected retraction must not read "could not be saved".
  const [failedAct, setFailedAct] = useState<PendingAct>(null);
  const pendingAct = useRef<PendingAct>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Author-only edit, author-or-admin delete — the same split the
  // server enforces, so the buttons never offer what a call would 403.
  const isAuthor =
    comment.authorId !== null && comment.authorId === viewer.userId;
  const canEdit = isAuthor;
  const canDelete = isAuthor || viewer.isAdmin;

  function clearDisarmTimer() {
    if (disarmTimer.current !== null) {
      clearTimeout(disarmTimer.current);
      disarmTimer.current = null;
    }
  }

  function disarm() {
    clearDisarmTimer();
    setArmed(false);
  }

  useEffect(() => clearDisarmTimer, []);

  // The fetcher's result is read once, against the act that opened it:
  // `fetcher.data` outlives its submission, so a second Edit click must
  // not be closed by the previous save's `ok`.
  useEffect(() => {
    if (fetcher.state !== "idle" || pendingAct.current === null) return;
    const act = pendingAct.current;
    pendingAct.current = null;
    const ok = fetcher.data?.ok === true;
    setFailedAct(ok ? null : act);
    if (ok && act === "edit") setEditing(false);
  }, [fetcher.state, fetcher.data]);

  const saving = fetcher.state !== "idle";

  function saveEdit() {
    pendingAct.current = "edit";
    setFailedAct(null);
    fetcher.submit(
      { _action: "editComment", commentId: comment.id, body: draft },
      { method: "post" },
    );
  }

  function onDeleteClick() {
    if (!armed) {
      clearDisarmTimer();
      setArmed(true);
      // Arming starts a fresh attempt; a stale error under an armed
      // button would read as this click already failing.
      setFailedAct(null);
      disarmTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    disarm();
    pendingAct.current = "delete";
    setFailedAct(null);
    fetcher.submit(
      { _action: "deleteComment", commentId: comment.id },
      { method: "post" },
    );
  }

  return (
    <>
      {editing ? (
        <>
          <textarea
            value={draft}
            rows={3}
            aria-label={t("commentEdit")}
            onChange={(e) => setDraft(e.target.value)}
            className={EDIT_TEXTAREA_CLASS}
          />
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving || draft.trim().length === 0}
              className={EDIT_SAVE_CLASS}
            >
              {t("commentSave")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setFailedAct(null);
              }}
              className="text-13 font-medium text-indigo hover:underline"
            >
              {t("cancel")}
            </button>
          </div>
        </>
      ) : (
        <CommentBody body={comment.body} />
      )}

      <CommentExtras comment={comment} quoteRefHref={quoteRefHref} />

      {!editing && (canEdit || canDelete) && (
        <div className="mt-1 flex items-center gap-3">
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body);
                setFailedAct(null);
                setEditing(true);
                disarm();
              }}
              disabled={saving}
              className={`${QUIET_ACTION_CLASS} hover:text-indigo`}
            >
              {t("commentEdit")}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDeleteClick}
              onBlur={disarm}
              disabled={saving}
              className={
                armed
                  ? "text-11 font-semibold text-madder-deep"
                  : `${QUIET_ACTION_CLASS} hover:text-madder-deep`
              }
            >
              {armed ? t("commentDeleteArmed") : t("commentDelete")}
            </button>
          )}
        </div>
      )}

      {failedAct !== null && (
        <p className="mt-1 text-11 text-madder-deep">
          {t(failedAct === "delete" ? "commentDeleteError" : "commentError")}
        </p>
      )}
    </>
  );
}

export function DecisionComment({
  comment,
  viewer,
  quoteRefIds,
}: {
  comment: ThreadComment;
  viewer?: ThreadViewer;
  /** Reference code → description id, as the route resolved them. */
  quoteRefIds?: Record<string, string>;
}) {
  const { t } = useTranslation("decisions");
  const quoteRefId = comment.quoteRef
    ? quoteRefIds?.[comment.quoteRef]
    : undefined;
  const quoteRefHref = quoteRefId
    ? `/admin/descriptions/${quoteRefId}`
    : undefined;
  return (
    <div>
      <p className="flex items-baseline gap-2">
        <span className="text-13 font-semibold text-indigo">
          {comment.author}
        </span>
        {comment.isSystem ? (
          <Pill label={t("pillSystem")} className="bg-indigo-tint text-indigo" />
        ) : (
          comment.role && (
            <Pill
              label={t(`pill_${comment.role}`, { defaultValue: comment.role })}
              className={
                ROLE_PILL_CLASSES[comment.role] ?? "bg-stone-100 text-stone-600"
              }
            />
          )
        )}
        <span className="font-mono text-11 text-stone-400 nums">
          {new Date(comment.createdAt).toISOString().slice(0, 10)}
        </span>
        {comment.editedAt !== null && (
          <span className="text-11 text-stone-400">{t("commentEdited")}</span>
        )}
      </p>

      {viewer ? (
        <EditableComment
          comment={comment}
          viewer={viewer}
          quoteRefHref={quoteRefHref}
        />
      ) : (
        <>
          <CommentBody body={comment.body} />
          <CommentExtras comment={comment} quoteRefHref={quoteRefHref} />
        </>
      )}
    </div>
  );
}

/** The conversation on a decision, flat and oldest-first. */
export function DecisionThread({
  comments,
  viewer,
  quoteRefIds,
}: {
  comments: ThreadComment[];
  viewer?: ThreadViewer;
  /** Reference code → description id, as the route resolved them. */
  quoteRefIds?: Record<string, string>;
}) {
  return (
    <div>
      {comments.map((c, i) => (
        <div
          key={c.id}
          className={i > 0 ? "mt-2.5 border-t border-stone-100 pt-2.5" : ""}
        >
          <DecisionComment comment={c} viewer={viewer} quoteRefIds={quoteRefIds} />
        </div>
      ))}
    </div>
  );
}
