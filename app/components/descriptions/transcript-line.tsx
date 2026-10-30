/**
 * Transcript Line
 *
 * This component is the read-only line on the description detail page
 * that reports a description's OCR transcript: how many pages it holds
 * and a link to the transcript view
 * (`/admin/descriptions/:id/transcript`), where the pages are read. The
 * transcript is not editable in Fisqua, so the line offers nothing
 * else. A description with no OCR pages renders nothing.
 *
 * @version v0.8.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";

interface TranscriptLineProps {
  descriptionId: string;
  /** OCR pages held for the description (`transcriptSummary().pageCount`). */
  pageCount: number;
}

export function TranscriptLine({ descriptionId, pageCount }: TranscriptLineProps) {
  const { t } = useTranslation("descriptions_admin");
  if (pageCount <= 0) return null;

  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-stone-500">
      <span className="font-medium">{t("transcript.label")}</span>
      <span>{t("transcript.pages", { count: pageCount })}</span>
      <Link
        to={`/admin/descriptions/${descriptionId}/transcript`}
        className="text-indigo-deep hover:underline"
      >
        {t("transcript.view")}
      </Link>
    </p>
  );
}

/* @version v0.8.0 */
