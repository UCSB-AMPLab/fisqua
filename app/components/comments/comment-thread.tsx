import { useState, useCallback, useMemo } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import type { CommentWithAuthor } from "../../lib/description-types";
import { CommentCard } from "./comment-card";
import { CommentInput } from "./comment-input";

type CommentThreadProps = {
  entryId: string;
  comments: CommentWithAuthor[];
  onCommentAdded?: () => void;
};

type CommentTree = CommentWithAuthor & {
  children: CommentTree[];
};

function buildTree(comments: CommentWithAuthor[]): CommentTree[] {
  const byParent = new Map<string | null, CommentWithAuthor[]>();

  for (const comment of comments) {
    const key = comment.parentId ?? null;
    const group = byParent.get(key);
    if (group) {
      group.push(comment);
    } else {
      byParent.set(key, [comment]);
    }
  }

  function buildChildren(parentId: string | null): CommentTree[] {
    const children = byParent.get(parentId) || [];
    return children
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((comment) => ({
        ...comment,
        children: buildChildren(comment.id),
      }));
  }

  return buildChildren(null);
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function RenderTree({
  nodes,
  depth,
  replyingTo,
  onReply,
  entryId,
  onSubmitReply,
  onCancelReply,
}: {
  nodes: CommentTree[];
  depth: number;
  replyingTo: string | null;
  onReply: (commentId: string) => void;
  entryId: string;
  onSubmitReply: (data: { entryId: string; parentId: string | null; text: string }) => void;
  onCancelReply: () => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.id}>
          <CommentCard comment={node} onReply={onReply} depth={depth} />
          {replyingTo === node.id && (
            <div style={{ marginLeft: `${(depth + 1) * 1.5}rem` }} className="mt-2">
              <CommentInput
                entryId={entryId}
                parentId={node.id}
                onSubmit={onSubmitReply}
                onCancel={onCancelReply}
              />
            </div>
          )}
          {node.children.length > 0 && (
            <div className="mt-2">
              <RenderTree
                nodes={node.children}
                depth={depth + 1}
                replyingTo={replyingTo}
                onReply={onReply}
                entryId={entryId}
                onSubmitReply={onSubmitReply}
                onCancelReply={onCancelReply}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function CommentThread({ entryId, comments, onCommentAdded }: CommentThreadProps) {
  const { t } = useTranslation("comments");
  const fetcher = useFetcher();
  const [isOpen, setIsOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(comments), [comments]);
  const commentCount = comments.length;

  const handleReply = useCallback(
    (commentId: string) => {
      setReplyingTo((prev) => (prev === commentId ? null : commentId));
    },
    []
  );

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const handleSubmit = useCallback(
    (data: { entryId: string; parentId: string | null; text: string }) => {
      fetcher.submit(
        {
          entryId: data.entryId,
          ...(data.parentId ? { parentId: data.parentId } : {}),
          text: data.text,
        },
        { method: "POST", action: "/api/comments" }
      );
      setReplyingTo(null);
      onCommentAdded?.();
    },
    [fetcher, onCommentAdded]
  );

  const heading =
    commentCount > 0
      ? `${t("comentarios")} (${commentCount})`
      : t("comentarios");

  return (
    <div className="mt-6 border-t border-[#E7E5E4] pt-6">
      {/* Section heading */}
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <h3 className="font-['Cormorant_Garamond'] text-[1.25rem] font-semibold text-[#44403C]">
          {heading}
        </h3>
        <ChevronIcon open={isOpen} />
      </button>

      {/* Collapsible content */}
      <div className="comments-collapse" data-open={isOpen}>
        <div>
          <div className="mt-4 space-y-2">
            <RenderTree
              nodes={tree}
              depth={0}
              replyingTo={replyingTo}
              onReply={handleReply}
              entryId={entryId}
              onSubmitReply={handleSubmit}
              onCancelReply={handleCancelReply}
            />

            {/* New top-level comment input -- always visible when expanded */}
            <div className="mt-4">
              <CommentInput
                entryId={entryId}
                parentId={null}
                onSubmit={handleSubmit}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
