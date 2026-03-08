type PageLabelsProps = {
  pages: Array<{ position: number; label: string | null }>;
  currentPageIndex: number;
};

export function PageLabels({ pages, currentPageIndex }: PageLabelsProps) {
  const currentPage = pages[currentPageIndex];
  if (!currentPage) return null;

  const label = currentPage.label || String(currentPage.position);

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-10 flex h-full items-start pt-3 pl-3">
      <div className="rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">
        {label}
      </div>
    </div>
  );
}
