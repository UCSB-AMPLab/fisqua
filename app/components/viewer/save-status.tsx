import { useTranslation } from "react-i18next";

type SaveStatusProps = {
  status: "saved" | "saving" | "unsaved";
};

const statusColors = {
  saved: "bg-green-500",
  saving: "bg-amber-500",
  unsaved: "bg-amber-500",
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
