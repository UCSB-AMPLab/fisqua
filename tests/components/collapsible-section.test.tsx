/**
 * Tests — a closed collapsible section keeps its content in the page
 *
 * This suite renders `CollapsibleSection` open and closed and pins what
 * a closed section must still hold: its content stays in the markup,
 * inside a region carrying the `hidden` attribute, so the inputs of a
 * closed section in an edit form are still submitted with it. The
 * toggle's `aria-expanded` follows the open state and its
 * `aria-controls` names the region in both states.
 *
 * Rendered with `renderToStaticMarkup`, as the other component suites
 * here are.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapsibleSection } from "../../app/components/admin/collapsible-section";

function render(defaultOpen: boolean): string {
  return renderToStaticMarkup(
    <form>
      <CollapsibleSection title="Notes" defaultOpen={defaultOpen}>
        <textarea name="notes" defaultValue="Public note" />
      </CollapsibleSection>
    </form>
  );
}

function regionTag(html: string): string {
  const match = html.match(/<div[^>]*role="region"[^>]*>/);
  expect(match).not.toBeNull();
  return match![0];
}

describe("CollapsibleSection", () => {
  it("keeps a closed section's inputs in the markup, hidden", () => {
    const html = render(false);
    expect(html).toContain('name="notes"');
    expect(html).toContain("Public note");
    expect(regionTag(html)).toMatch(/\shidden(=""|\s|>)/);
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows an open section's region without the hidden attribute", () => {
    const html = render(true);
    expect(html).toContain('name="notes"');
    expect(regionTag(html)).not.toMatch(/\shidden(=""|\s|>)/);
    expect(html).toContain('aria-expanded="true"');
  });

  it("points aria-controls at the region in both states", () => {
    for (const open of [true, false]) {
      const html = render(open);
      const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
      expect(controls).toBeTruthy();
      expect(regionTag(html)).toContain(`id="${controls}"`);
    }
  });
});
