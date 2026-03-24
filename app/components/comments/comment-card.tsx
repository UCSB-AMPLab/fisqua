import { useTranslation } from "react-i18next";
import type { CommentWithAuthor } from "../../lib/description-types";

type CommentCardProps = {
  comment: CommentWithAuthor;
  onReply: (commentId: string) => void;
  depth: number;
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  cataloguer: "bg-[#E0E7F7] text-[#3B5A9A]",
  reviewer: "bg-[#D6E8DB] text-[#2F6B45]",
  lead: "bg-[#E0E7F7] text-[#3B5A9A]",
};

const ROLE_I18N_KEYS: Record<string, string> = {
  cataloguer: "roles.catalogador",
  reviewer: "roles.revisor",
  lead: "roles.lead",
};

function formatRelativeTime(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat("es-CO", { numeric: "auto" });
  const diffMs = timestamp - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  return rtf.format(diffDay, "day");
}

export function CommentCard({ comment, onReply, depth }: CommentCardProps) {
  const { t } = useTranslation("comments");

  const isTopLevel = depth === 0;
  const cardBg = isTopLevel ? "bg-[#F5E6EA]" : "bg-white border border-[#E7E5E4]";
  const indentClass = depth > 0 ? `ml-${Math.min(depth * 6, 24)}` : "";

  return (
    <div
      className={`rounded-lg p-3 ${cardBg}`}
      style={depth > 0 ? { marginLeft: `${depth * 1.5}rem` } : undefined}
    >
      {/* Header: role badge, author, timestamp */}
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 font-['DM_Sans'] text-xs font-semibold ${ROLE_BADGE_STYLES[comment.authorRole] || ROLE_BADGE_STYLES.cataloguer}`}
          >
            {t(ROLE_I18N_KEYS[comment.authorRole] || "roles.catalogador")}
          </span>
          <span className="font-['DM_Sans'] text-[0.75rem] text-[#78716C]">
            {comment.authorEmail}
          </span>
        </div>
        <span className="font-['DM_Sans'] text-[0.75rem] text-[#A8A29E]">
          {formatRelativeTime(comment.createdAt)}
        </span>
      </div>

      {/* Comment text */}
      <p className="font-serif text-[0.9375rem] italic leading-[1.6] text-[#44403C]">
        {comment.text}
      </p>

      {/* Reply link */}
      <button
        type="button"
        className="mt-1.5 font-['DM_Sans'] text-[0.75rem] font-semibold text-[#8B2942] hover:underline"
        onClick={() => onReply(comment.id)}
      >
        {t("responder")}
      </button>
    </div>
  );
}
