/**
 * Reject Inline Panel
 *
 * Inline panel shown when a reviewer rejects a draft record. Captures
 * the rejection reason, lets the reviewer pin the record for a later
 * pass, and forwards the payload to the parent form for commit.
 *
 * @version v0.3.0
 */

import { Form } from "react-router";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RejectInlinePanelProps {
  termId: string;
  termName: string;
  isOpen: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// RejectInlinePanel
// ---------------------------------------------------------------------------

export function RejectInlinePanel({
  termId,
  termName,
  isOpen,
  onClose,
}: RejectInlinePanelProps) {
  const { t } = useTranslation("vocabularies");

  if (!isOpen) return null;

  return (
    <div className="rounded-md border border-madder bg-madder-tint px-4 py-3">
      <p className="mb-2 text-sm text-stone-700">
        {t("reject_confirm", { term: termName })}
      </p>
      <Form method="post">
        <input type="hidden" name="_action" value="reject" />
        <input type="hidden" name="termId" value={termId} />
        <textarea
          name="reason"
          rows={2}
          placeholder="Reason for rejection..."
          className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-madder px-3 py-1.5 text-sm font-semibold text-parchment hover:bg-madder-deep"
          >
            {t("reject_term")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-stone-500 hover:text-stone-700"
          >
            Cancel
          </button>
        </div>
      </Form>
    </div>
  );
}
