/**
 * Publish Changelog Section
 *
 * Renders the pre-flight summary of what a publish run would change:
 * per-fonds counts of added, modified, and unpublished descriptions
 * plus aggregate modification counts for repositories, entities, and
 * places. Read-only display consumed by the publish dashboard.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

export interface FondsChangelog {
  fonds: string;
  fondsLabel: string;
  added: number;
  modified: number;
  unpublished: number;
}

export interface ChangelogData {
  descriptions: FondsChangelog[];
  repositories: { modified: number };
  entities: { modified: number };
  places: { modified: number };
}

interface ChangelogSectionProps {
  changelog: ChangelogData;
}

export function ChangelogSection({ changelog }: ChangelogSectionProps) {
  const { t } = useTranslation("publish");

  const totalAdded = changelog.descriptions.reduce((s, f) => s + f.added, 0);
  const totalModified = changelog.descriptions.reduce((s, f) => s + f.modified, 0);
  const totalUnpublished = changelog.descriptions.reduce((s, f) => s + f.unpublished, 0);
  const hasDescriptionChanges = totalAdded + totalModified + totalUnpublished > 0;

  return (
    <section className="space-y-4">
      <h2 className="font-sans text-lg font-semibold text-stone-800">
        {t("changelog.title")}
      </h2>

      {/* Descriptions per fonds */}
      <div className="overflow-hidden rounded-lg border border-stone-200">
        <div className="border-b border-stone-200 bg-stone-50 px-4 py-2.5">
          <h3 className="font-sans text-sm font-medium text-stone-700">
            {t("changelog.descriptions")}
          </h3>
        </div>
        {hasDescriptionChanges ? (
          <div className="divide-y divide-stone-100">
            {changelog.descriptions
              .filter((f) => f.added + f.modified + f.unpublished > 0)
              .map((f) => (
                <div
                  key={f.fonds}
                  className="flex items-center justify-between px-4 py-2.5"
                >
                  <div>
                    <span className="font-sans text-sm font-medium text-stone-800">
                      {f.fondsLabel}
                    </span>
                    <span className="ml-2 font-sans text-xs text-stone-400">
                      {f.fonds}
                    </span>
                  </div>
                  <div className="flex gap-3">
                    {f.added > 0 && (
                      <span className="font-sans text-xs text-green-700">
                        +{f.added} {t("changelog.added")}
                      </span>
                    )}
                    {f.modified > 0 && (
                      <span className="font-sans text-xs text-amber-700">
                        {f.modified} {t("changelog.modified")}
                      </span>
                    )}
                    {f.unpublished > 0 && (
                      <span className="font-sans text-xs text-red-700">
                        {f.unpublished} {t("changelog.unpublished")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            <div className="flex items-center justify-between bg-stone-50 px-4 py-2">
              <span className="font-sans text-xs font-medium uppercase text-stone-500">
                {t("changelog.total")}
              </span>
              <div className="flex gap-3">
                {totalAdded > 0 && (
                  <span className="font-sans text-xs text-green-700">
                    +{totalAdded}
                  </span>
                )}
                {totalModified > 0 && (
                  <span className="font-sans text-xs text-amber-700">
                    {totalModified}
                  </span>
                )}
                {totalUnpublished > 0 && (
                  <span className="font-sans text-xs text-red-700">
                    {totalUnpublished}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="px-4 py-3 font-sans text-sm text-stone-400">
            {t("changelog.noChanges")}
          </p>
        )}
      </div>

      {/* Other data types */}
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            { key: "repositories", count: changelog.repositories.modified },
            { key: "entities", count: changelog.entities.modified },
            { key: "places", count: changelog.places.modified },
          ] as const
        ).map(({ key, count }) => (
          <div
            key={key}
            className="rounded-lg border border-stone-200 px-4 py-3"
          >
            <h3 className="font-sans text-sm font-medium text-stone-700">
              {t(`changelog.${key}`)}
            </h3>
            {count > 0 ? (
              <p className="mt-1 font-sans text-xs text-amber-700">
                {count} {t("changelog.modified")}
              </p>
            ) : (
              <p className="mt-1 font-sans text-xs text-stone-400">
                {t("changelog.noChanges")}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
