/**
 * Viewer Save Status
 *
 * Inline pill that surfaces the save state of the currently edited
 * entry: clean, dirty, saving, error. Drives the "unsaved changes"
 * beforeunload guard when the state is dirty.
 *
 * @version v0.3.0
 */
import { useTranslation } from "react-i18next";

type SaveStatusProps = {
  status: "saved" | "saving" | "unsaved";
};

const statusColors = {
  saved: "bg-verdigris",
  saving: "bg-saffron",
  unsaved: "bg-saffron",
} as const;

export function SaveStatus({ status }: SaveStatusProps) {
  const { t } = useTranslation("viewer");
  const color = statusColors[status];
  const label = t(`save_status.${status}`);

  return (
 <span className="flex items-center gap-1.5 text-xs text-stone-500">
 <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
 {label}
 </span>
  );
}
