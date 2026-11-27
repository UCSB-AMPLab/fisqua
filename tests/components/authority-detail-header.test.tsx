/**
 * Tests — the authority detail header's Delete button
 *
 * This suite renders `AuthorityDetailHeader` and pins when its Delete
 * button is disabled and what it says why: a record with linked
 * descriptions shows the linked-descriptions count, a record given a
 * `deleteBlockedReason` (an entity others were merged into) shows that
 * reason, and a record with neither keeps the button enabled.
 *
 * Rendered with `renderToStaticMarkup`, as the other component suites
 * are, inside a memory router for the merge and split links.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { AuthorityDetailHeader } from "../../app/components/admin/authority-detail-header";

const t = (key: string, opts?: Record<string, unknown>) =>
  opts && "count" in opts ? `${key}:${opts.count}` : key;

function render(props: { hasDescriptions: boolean; deleteBlockedReason?: string }): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AuthorityDetailHeader
        title="Record"
        isEditing={false}
        isMerged={false}
        descLinkCount={props.hasDescriptions ? 3 : 0}
        mergeTo="/merge"
        splitTo="/split"
        onEdit={() => {}}
        onDelete={() => {}}
        t={t}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** The Delete button's markup. */
const deleteButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*deleteButton<\/button>/s)![0];

describe("AuthorityDetailHeader's Delete button", () => {
  it("is enabled for a record with no linked descriptions and no other reason", () => {
    const button = deleteButton(render({ hasDescriptions: false }));
    expect(button).not.toContain("disabled");
    expect(button).not.toContain("title=");
  });

  it("is disabled with the linked-descriptions count for a record with linked descriptions", () => {
    const button = deleteButton(render({ hasDescriptions: true }));
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('title="deleteBlocked:3"');
  });

  it("is disabled with the reason given for a record others were merged into", () => {
    const button = deleteButton(
      render({ hasDescriptions: false, deleteBlockedReason: "merged into it" }),
    );
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('title="merged into it"');
  });
});

/* @version v0.9.0 */
