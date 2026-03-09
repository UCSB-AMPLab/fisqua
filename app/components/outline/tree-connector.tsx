type TreeConnectorProps = {
  depth: number;
  isLast: boolean;
  hasChildren: boolean;
};

const INDENT_PX = 20;

export function TreeConnector({ depth, isLast }: TreeConnectorProps) {
  if (depth === 0) return null;

  return (
    <span className="flex shrink-0 items-stretch" style={{ width: depth * INDENT_PX }}>
      {/* Vertical lines for ancestor levels */}
      {Array.from({ length: depth - 1 }, (_, i) => (
        <span
          key={i}
          className="shrink-0 border-l border-stone-300"
          style={{ width: INDENT_PX }}
        />
      ))}
      {/* Connector at current depth: L-shape if last, T-shape otherwise */}
      <span
        className={`shrink-0 border-l border-stone-300 ${isLast ? "" : ""}`}
        style={{
          width: INDENT_PX,
          borderBottom: "1px solid rgb(214, 211, 209)", // stone-300
          height: isLast ? "50%" : "100%",
          alignSelf: isLast ? "flex-start" : "stretch",
        }}
      />
    </span>
  );
}
