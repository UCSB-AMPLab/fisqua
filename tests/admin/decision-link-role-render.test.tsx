/**
 * Tests — the ruling form's link role, rendered
 *
 * This suite pins how the decision page's ruling form offers a link role:
 * from the federation's list for the ruled type, assuming none. It renders
 * the page from fixed loader data and pins that:
 *
 *   - a proposed role the list holds approved is preselected;
 *   - a proposed role the list does not hold, and a proposal with no
 *     role, leave the placeholder selected, with no value, so the
 *     reviewer chooses;
 *   - with an empty list, the placeholder is the only option.
 *
 * Rendered with `renderToStaticMarkup` and an isolated i18next instance
 * over the real locale bundles, inside `createRoutesStub`. Every value
 * here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import resources from "../../app/locales";
import DecisionDetailPage from "../../app/routes/_auth.admin.decisions.$id";
import { roleSetPickers } from "../helpers/vocabulary";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";
import { NO_ROLE_PICKERS, type RolePickers } from "../../app/lib/role-options";

async function render(proposedRole: string | undefined, roles: RolePickers): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const path = "/admin/decisions/p1";
  const loaderData = {
    comments: [],
    viewer: { userId: "u1", isAdmin: true },
    refIds: { "CMD 1": "desc-1" },
    evidence: { phrase: [], related: [], count: 0 },
    roles,
    proposal: {
      id: "p1",
      status: "open",
      ruling: null,
      rulingNote: null,
      resultId: null,
      ruledAt: null,
      sourceModule: "test",
      sourceRef: null,
      payload: {
        heading: "Juan Testigo",
        proposedType: "person",
        proposedName: "Juan Testigo",
        action: "mint",
        evidenceRef: "CMD 1",
        ...(proposedRole ? { proposedRole } : {}),
      },
    },
    proposalTypes: ["person", "family", "corporate", "place", "topic"],
    placeTypes: [],
  };
  const Stub = createRoutesStub([
    {
      path,
      Component: () =>
        React.createElement(DecisionDetailPage as any, { loaderData, actionData: undefined, params: {}, matches: [] }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: [path] })),
  );
}

/** The `linkRole` select's markup. */
function linkRoleSelect(html: string): string {
  const start = html.indexOf('name="linkRole"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</select>", start));
}

const NEOGRANADINA = roleSetPickers(NEOGRANADINA_ROLES, "en");

describe("the ruling form's link role", () => {
  it("preselects a proposed role the federation's list holds", async () => {
    const select = linkRoleSelect(await render("witness", NEOGRANADINA));
    expect(select).toContain('<option value="witness" selected="">');
  });

  it("asks the reviewer to choose when the proposed role is not in the list, or there is none", async () => {
    for (const proposed of ["deponent", undefined]) {
      const select = linkRoleSelect(await render(proposed, NEOGRANADINA));
      expect(select).toContain('<option value="" selected="">Select role</option>');
      expect(select).not.toMatch(/value="[a-z_]+" selected/);
    }
  });

  it("offers only the placeholder when the list is empty", async () => {
    const select = linkRoleSelect(await render("mentioned", NO_ROLE_PICKERS));
    expect(select.match(/<option/g)).toHaveLength(1);
    expect(select).toContain('<option value="" selected="">Select role</option>');
  });
});

// @version v0.9.0
