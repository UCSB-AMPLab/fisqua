/**
 * Documentation help link
 *
 * This component deals with the small "?" affordance beside a step
 * heading that opens the matching page of the public documentation site
 * in a new tab. It reads the active language from i18next so the link
 * lands on the reader's own locale — English `/docs/…` or Spanish
 * `/guia/…`. It is a plain anchor, not a scripted tooltip, so it works
 * without JavaScript and reads cleanly to a screen reader.
 *
 * @version v0.6.0
 */
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type DocsTopic, docsUrl } from "../../lib/docs-links";

export function DocsHelpLink({
  topic,
  className,
}: {
  topic: DocsTopic;
  className?: string;
}) {
  const { t, i18n } = useTranslation("common");
  const label = t("help.openDocs");
  return (
    <a
      href={docsUrl(topic, i18n.language)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={`inline-flex items-center text-stone-400 transition-colors hover:text-indigo focus-visible:text-indigo ${className ?? ""}`}
    >
      <CircleHelp className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}
