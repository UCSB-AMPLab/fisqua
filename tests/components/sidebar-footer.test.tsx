/**
 * Tests — the version and partner logos at the foot of the sidebar
 *
 * This suite renders the sidebar, expanded and collapsed, and pins the
 * band at its foot: expanded, the Fisqua version links to its release
 * notes, the two partner logos sit beside it, and the collapse button
 * keeps its accessible name between them; collapsed, the band holds the
 * expand button alone.
 *
 * Rendered with `renderToStaticMarkup` and an isolated i18next instance
 * over the real locale bundles, inside `createRoutesStub`, as
 * `tests/admin/users-reach.test.tsx` does.
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
import { Sidebar, type SidebarTenant, type SidebarUser } from "../../app/components/layout/sidebar";
import { VERSION } from "../../app/components/layout/footer";

const tenant: SidebarTenant = {
  crowdsourcingEnabled: false,
  vocabularyHubEnabled: false,
  publishPipelineEnabled: false,
  multiRepositoryEnabled: false,
  authoritiesEnabled: false,
  importsEnabled: false,
  digitizationEnabled: false,
};

const user: SidebarUser = {
  isAdmin: true,
  isSuperAdmin: false,
  isCollabAdmin: false,
  isArchiveUser: false,
  isUserManager: false,
  isCataloguer: false,
  isRecordsAdmin: false,
  isAuthoritiesAdmin: false,
  isImportsAdmin: false,
  hasAnyProjectMembership: false,
  isCaptureWorker: false,
  isCaptureReviewer: false,
};

async function renderSidebar(collapsed: boolean): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([
    { path: "/", Component: () => React.createElement(Sidebar, { user, tenant, collapsed, onToggle: () => {} }) },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/"] })),
  );
}

/** The markup of the band at the foot of the sidebar. */
function band(html: string): string {
  const start = html.indexOf('data-testid="sidebar-footer"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

describe("the foot of the sidebar", () => {
  it("shows the version, the partner logos and the collapse button when expanded", async () => {
    const foot = band(await renderSidebar(false));
    expect(foot).toMatch(
      new RegExp(`href="https://github.com/UCSB-AMPLab/fisqua/releases/tag/v${VERSION.replace(/\./g, "\\.")}"[^>]*>Fisqua v${VERSION.replace(/\./g, "\\.")}<`),
    );
    expect(foot).toContain('src="/brand/neogranadina-logo.svg"');
    expect(foot).toContain('alt="Neogranadina"');
    expect(foot).toContain('src="/ampl-cropped-1.png"');
    expect(foot).toContain('alt="AMP Lab, UC Santa Barbara"');
    expect(foot).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-label="Collapse sidebar"/);
  });

  it("keeps only the expand button when collapsed", async () => {
    const foot = band(await renderSidebar(true));
    expect(foot).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Expand sidebar"/);
    expect(foot).not.toContain("Fisqua v");
    expect(foot).not.toContain("<img");
  });
});

// @version v0.9.0
