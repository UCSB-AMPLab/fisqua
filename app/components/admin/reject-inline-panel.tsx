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
    <div className="rounded-lg border border-[#DC2626] bg-[#FEF2F2] px-4 py-3">
      <p className="mb-2 text-sm text-[#44403C]">
        {t("reject_confirm", { term: termName })}
      </p>
      <Form method="post">
        <input type="hidden" name="_action" value="reject" />
        <input type="hidden" name="termId" value={termId} />
        <textarea
          name="reason"
          rows={2}
          placeholder="Reason for rejection..."
          className="mb-2 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#DC2626]"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            {t("reject_term")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[#78716C] hover:text-[#44403C]"
          >
            Cancel
          </button>
        </div>
      </Form>
    </div>
  );
}
