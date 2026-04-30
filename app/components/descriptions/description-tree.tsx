/**
 * Description Tree
 *
 * A lazy-loading tree component for the archival description hierarchy.
 * Each node fetches its direct children on expand via
 * `api/descriptions/children/:parentId`, so even a 100,000-record fonds
 * renders instantly and the server only produces the branches the user
 * asks for. Nodes show reference code, title, and description level;
 * click-to-open deep-links into the edit page.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useCallback } from "react";
import { useFetcher, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, FolderOpen, FileText, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeNode {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  childCount: number;
}

interface DescriptionTreeProps {
  repositoryId: string;
  descriptionCount: number;
  initialDescriptions?: TreeNode[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DescriptionTree({
  repositoryId,
  descriptionCount,
  initialDescriptions,
}: DescriptionTreeProps) {
  const { t } = useTranslation("repositories");
  const fetcher = useFetcher();

  const [roots, setRoots] = useState<TreeNode[]>(initialDescriptions ?? []);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, TreeNode[]>>(
    new Map()
  );
  const [loadingNode, setLoadingNode] = useState<string | null>(null);

  // Load root descriptions on mount if not provided via SSR
  useEffect(() => {
    if (!initialDescriptions && descriptionCount > 0) {
      fetcher.load(`/admin/descriptions/api/children/repo__${repositoryId}`);
    }
  }, [repositoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle fetcher data for root load
  useEffect(() => {
    if (fetcher.data && roots.length === 0 && !initialDescriptions) {
      setRoots(fetcher.data as TreeNode[]);
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (descriptionCount === 0) {
    return (
      <p className="text-sm text-stone-400">{t("no_linked_descriptions")}</p>
    );
  }

  if (roots.length === 0 && fetcher.state === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-stone-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("loading", { defaultValue: "Loading..." })}</span>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {roots.map((node) => (
        <TreeNodeRow
          key={node.id}
          node={node}
          depth={0}
          expandedNodes={expandedNodes}
          childrenCache={childrenCache}
          loadingNode={loadingNode}
          onToggle={(id) => {
            const next = new Set(expandedNodes);
            if (next.has(id)) {
              next.delete(id);
            } else {
              next.add(id);
              // Load children if not cached
              if (!childrenCache.has(id)) {
                setLoadingNode(id);
              }
            }
            setExpandedNodes(next);
          }}
          onChildrenLoaded={(parentId, children) => {
            setChildrenCache((prev) => {
              const next = new Map(prev);
              next.set(parentId, children);
              return next;
            });
            setLoadingNode(null);
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree node row (recursive)
// ---------------------------------------------------------------------------

function TreeNodeRow({
  node,
  depth,
  expandedNodes,
  childrenCache,
  loadingNode,
  onToggle,
  onChildrenLoaded,
}: {
  node: TreeNode;
  depth: number;
  expandedNodes: Set<string>;
  childrenCache: Map<string, TreeNode[]>;
  loadingNode: string | null;
  onToggle: (id: string) => void;
  onChildrenLoaded: (parentId: string, children: TreeNode[]) => void;
}) {
  const fetcher = useFetcher();
  const isExpanded = expandedNodes.has(node.id);
  const hasChildren = node.childCount > 0;
  const children = childrenCache.get(node.id);
  const isLoading = loadingNode === node.id;

  // Determine icon based on description level
  const isFolderLevel = ["fonds", "subfonds", "series", "subseries", "collection"].includes(
    node.descriptionLevel
  );
  const Icon = isFolderLevel ? FolderOpen : FileText;
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

  // Load children when expanded and not cached
  useEffect(() => {
    if (isExpanded && !children && isLoading) {
      fetcher.load(`/admin/descriptions/api/children/${node.id}`);
    }
  }, [isExpanded, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle fetcher response
  useEffect(() => {
    if (fetcher.data && isLoading) {
      onChildrenLoaded(node.id, fetcher.data as TreeNode[]);
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-stone-50"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-500 hover:text-stone-700"
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronIcon className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}

        {/* Icon */}
        <Icon className="h-4 w-4 shrink-0 text-stone-400" />

        {/* Reference code */}
        <span className="shrink-0 font-mono text-xs text-stone-500">
          {node.referenceCode}
        </span>

        {/* Title as link */}
        <Link
          to={`/admin/descriptions/${node.id}`}
          className="truncate text-sm text-stone-700 hover:text-indigo-deep hover:underline"
        >
          {node.title}
        </Link>
      </div>

      {/* Children */}
      {isExpanded && children && (
        <div>
          {children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              childrenCache={childrenCache}
              loadingNode={loadingNode}
              onToggle={onToggle}
              onChildrenLoaded={onChildrenLoaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
