type SaveStatusProps = {
  status: "saved" | "saving" | "unsaved";
};

const statusConfig = {
  saved: { label: "Guardado", color: "bg-green-500" },
  saving: { label: "Guardando...", color: "bg-amber-500" },
  unsaved: { label: "Sin guardar", color: "bg-amber-500" },
} as const;

export function SaveStatus({ status }: SaveStatusProps) {
  const { label, color } = statusConfig[status];

  return (
    <span className="flex items-center gap-1.5 text-xs text-stone-500">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
