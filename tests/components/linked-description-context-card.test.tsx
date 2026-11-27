/**
 * Tests — the merge and split workbenches' context card, rendered
 *
 * This suite renders the context card of the merge and split workbenches
 * with fixed card data. The card lists a linked description's roles as
 * chips and its places in the metadata strip. The suite pins that:
 *
 *   - every place carries its role's label before its name, `mentioned`
 *     included, and a role the labels do not hold shows the code;
 *   - the role chips show the labels the card is given.
 *
 * Rendered with `renderToStaticMarkup` inside `createRoutesStub`, which
 * the card's links need. Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { LinkedDescriptionContextCard } from "../../app/components/admin/linked-description-context-card";
import type { LinkedDescriptionCardData } from "../../app/lib/authority-linked-context.server";

const LABELS: Record<string, string> = {
  mentioned: "Named",
  venue: "Held at",
  plaintiff: "Complainant",
};

const CARD: LinkedDescriptionCardData = {
  descriptionId: "desc-1",
  title: "Pleito por tierras",
  referenceCode: "co-test-1",
  roles: [{ role: "plaintiff", roleRaw: null, relationSide: false }],
  linkIds: ["link-1"],
  dateExpression: "1711",
  dateStart: null,
  dateEnd: null,
  extent: null,
  repositoryName: null,
  places: [
    { name: "Popayán", role: "mentioned" },
    { name: "Tunja", role: "venue" },
    { name: "Honda", role: "landing" },
  ],
  nameAsRecorded: null,
  asRecordedRoleRaw: null,
  asRecordedRole: null,
  snippet: null,
};

function render(): string {
  const label = (r: string) => LABELS[r] ?? r;
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () =>
        React.createElement(LinkedDescriptionContextCard, {
          card: CARD,
          showAsRecorded: false,
          roleLabel: label,
          placeRoleLabel: label,
          t: (k: string) => k,
        }),
    },
  ]);
  return renderToStaticMarkup(React.createElement(Stub, { initialEntries: ["/"] }));
}

describe("linked-description context card", () => {
  it("labels every place's role, mentioned included", () => {
    const html = render();
    expect(html).toContain("Named: Popayán");
    expect(html).toContain("Held at: Tunja");
    expect(html).toContain("landing: Honda");
  });

  it("shows the role chips' labels", () => {
    expect(render()).toContain("Complainant");
  });
});

// @version v0.9.0
