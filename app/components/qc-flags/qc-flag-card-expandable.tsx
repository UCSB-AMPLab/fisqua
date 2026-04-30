/**
 * Expandable QC Flag Card
 *
 * Thin wrapper around `QcFlagCard` that adds the inline comments
 * thread when the user expands the card. Keeps role-based visibility
 * in sync with the server-side guard so a cataloguer never sees the
 * resolver affordance even briefly.
 *
 * @version v0.3.0
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { QcFlagCard, type QcFlagCardData, type QcStatus } from "./qc-flag-card";
import { CommentThread } from "../comments/comment-thread";
import type { CommentWithAuthor } from "../../lib/description-types";

export type QCFlagCardExpandableProps = {
  flag: QcFlagCardData;
  volumeId: string;
  comments: CommentWithAuthor[];
  userRole: "lead" | "cataloguer" | "reviewer";
  onResolveClick?: (flagId: string) => void;
  onCommentAdded?: () => void;
};

/**
 * Pure predicate: may the current user see the Resolver button on this
 * flag? True iff the user is a project lead AND the flag is still open.
 * Exported so tests can exercise + without rendering.
 *
 * A flag's `wontfix` status also hides the button -- only `open` qualifies.
 * This is the single source of truth for the client-side gate; the render
 * body calls this helper to decide whether to forward `onResolveClick`.
 */
export function shouldForwardResolve(
  userRole: "lead" | "cataloguer" | "reviewer",
  flagStatus: QcStatus,
): boolean {
  return userRole === "lead" && flagStatus === "open";
}

export function QCFlagCardExpandable({
  flag,
  volumeId,
  comments,
  userRole,
  onResolveClick,
  onCommentAdded,
}: QCFlagCardExpandableProps) {
  const { t } = useTranslation(["comments"]);
  const [expanded, setExpanded] = useState(false);

  const canResolve = shouldForwardResolve(userRole, flag.status);
  // Only forward the handler when the user may act AND the caller wants
  // to handle the click. `undefined` is the signal QcFlagCard uses to
  // hide the button entirely.
  const forwardedOnResolve =
 canResolve && onResolveClick ? () => onResolveClick(flag.id) : undefined;

  return (
 <div>
 <QcFlagCard flag={flag} onResolveClick={forwardedOnResolve} />

 {/* inline comments toggle */}
 <button
 type="button"
 onClick={() => setExpanded((v) => !v)}
 aria-expanded={expanded}
 className="mt-2 inline-flex items-center gap-1 font-sans text-xs font-semibold text-indigo hover:underline focus:outline-none focus:ring-2 focus:ring-indigo/40"
 >
 <ChevronDown
 size={14}
 aria-hidden="true"
 className={`transition-transform ${expanded ? "rotate-180" : ""}`}
 />
 {t("comments:comentarios", { defaultValue: "Comentarios" })} (
 {comments.length})
 </button>

 {expanded && (
 <div className="mt-3 border-l-2 border-stone-200 pl-3">
 <CommentThread
 target={{ kind: "qcFlag", qcFlagId: flag.id }}
 volumeId={volumeId}
 comments={comments}
 onCommentAdded={onCommentAdded}
 />
 </div>
 )}
 </div>
  );
}

