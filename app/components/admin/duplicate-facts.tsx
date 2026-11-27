/**
 * DuplicateFacts — the facts that support a possible-duplicate pair
 *
 * This component shows, on the card of a stored pair of entity records,
 * the reasons the pair was queued: an office both records hold, associates
 * they appear with, documents that name both, their dates, and places they
 * share. It shows those facts in a fixed order: the warning for a shared
 * document first, then offices, associates, documents, dates and places.
 * Each list shows the three items the stored facts carry, followed by a
 * "+N more" line when the pair has more. An associate links to its record
 * page and a document to its description page.
 *
 * The facts are what the merge dialog asks the person ruling to confirm,
 * so the card puts them in view before the dialog opens. They inform the
 * ruling and do not decide it, so the block uses the card's quiet chip
 * and hairline styles; only the shared-document warning takes the
 * saffron tone, because it is the one fact that argues against a merge.
 * A pair with no office, associate, document, date or place shows
 * nothing.
 *
 * @version v0.9.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { PairFacts } from "~/lib/duplicate-facts";

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-13 leading-[1.5] text-stone-700">
      <dt className="w-20 shrink-0 text-11 font-semibold uppercase tracking-[0.06em] text-stone-400 pt-px">
        {label}
      </dt>
      <dd className="min-w-0 [text-wrap:pretty]">{children}</dd>
    </div>
  );
}

function Items({ children }: { children: React.ReactNode[] }) {
  return (
    <>
      {children.map((child, i) => (
        <span key={i}>
          {i > 0 ? ", " : ""}
          {child}
        </span>
      ))}
    </>
  );
}

export function DuplicateFacts({ facts }: { facts: PairFacts }) {
  const { t } = useTranslation("authorities");
  const more = (n: number) =>
    n > 0 ? <span className="ml-1.5 text-xs text-stone-500">{t("duplicates.facts.more", { count: n })}</span> : null;
  const linkClass = "font-medium text-indigo hover:underline";
  const showDates = facts.dates.a != null || facts.dates.b != null;
  const empty =
    !facts.warning &&
    facts.offices.length === 0 &&
    facts.associates.length === 0 &&
    facts.documents.length === 0 &&
    !showDates &&
    facts.places.length === 0;
  if (empty) return null;

  return (
    <div className="mt-3.5" data-testid="duplicate-facts">
      {facts.warning === "same-document" ? (
        <p
          role="note"
          className="mb-2.5 rounded-md border border-saffron/40 bg-saffron-tint/40 px-3 py-2 text-13 leading-[1.5] text-saffron-deep [text-wrap:pretty]"
        >
          <span className="font-semibold">{t("duplicates.facts.warningTitle")}</span>{" "}
          {t("duplicates.facts.warningBody")}
        </p>
      ) : null}
      <dl className="flex flex-col gap-1.5" aria-label={t("duplicates.facts.label")}>
        {facts.offices.length > 0 ? (
          <FactRow label={t("duplicates.facts.offices", { count: facts.offices.length })}>
            {t("duplicates.facts.officesLead")}{" "}
            <Items>{facts.offices.map((o) => `“${o}”`)}</Items>
          </FactRow>
        ) : null}
        {facts.associates.length > 0 ? (
          <FactRow label={t("duplicates.facts.associates", { count: facts.associates.length + facts.more.associates })}>
            {t("duplicates.facts.associatesLead")}{" "}
            <Items>
              {facts.associates.map((a) => (
                <span key={a.id}>
                  <Link to={`/admin/entities/${a.id}`} className={linkClass}>
                    {a.name}
                  </Link>
                  {a.code ? <span className="ml-1 font-mono text-11 text-stone-500">{a.code}</span> : null}
                </span>
              ))}
            </Items>
            {more(facts.more.associates)}
          </FactRow>
        ) : null}
        {facts.documents.length > 0 ? (
          <FactRow label={t("duplicates.facts.documents", { count: facts.documents.length + facts.more.documents })}>
            {t("duplicates.facts.documentsLead")}{" "}
            <Items>
              {facts.documents.map((d) => (
                <Link key={d.id} to={`/admin/descriptions/${d.id}`} className={linkClass}>
                  {d.title || t("duplicates.facts.untitled")}
                </Link>
              ))}
            </Items>
            {more(facts.more.documents)}
          </FactRow>
        ) : null}
        {showDates ? (
          <FactRow label={t("duplicates.facts.dates")}>
            {t("duplicates.facts.datesBoth", { a: facts.dates.a ?? "—", b: facts.dates.b ?? "—" })}
            {facts.dates.overlap ? (
              <span className="ml-1.5 text-xs text-stone-500">{t("duplicates.facts.datesOverlap")}</span>
            ) : null}
          </FactRow>
        ) : null}
        {facts.places.length > 0 ? (
          <FactRow label={t("duplicates.facts.places", { count: facts.places.length + facts.more.places })}>
            {t("duplicates.facts.placesLead")} <Items>{facts.places.map((p) => p.name)}</Items>
            {more(facts.more.places)}
          </FactRow>
        ) : null}
      </dl>
    </div>
  );
}

// @version v0.9.0
