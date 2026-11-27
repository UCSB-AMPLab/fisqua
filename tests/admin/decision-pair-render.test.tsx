/**
 * Tests — the duplicate pair page's context rows, rendered
 *
 * This suite pins the four rows that the pair page adds to its comparison
 * table for each record: the descriptions that name it, the entities and
 * the places in those descriptions, and its origin. It renders the page
 * component with fixed loader data, in English and in Spanish, and pins
 * that the rows carry their labels, the links to each description, the
 * record's page for the rest of its descriptions and its history page, the
 * role labels, and the plain statement when nothing records how a record
 * was created. The role labels come from the loader's `roles`, the
 * federation's lists in the viewer's language: here the Neogranadina set,
 * and a list whose label differs from it.
 *
 * Rendered with `renderToStaticMarkup` and an isolated i18next instance
 * over the real locale bundles, inside `createRoutesStub`, as
 * `tests/admin/save-feedback.test.tsx` does.
 *
 * Every value here is a test value.
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
import DecisionPairPage from "../../app/routes/_auth.admin.decisions.pair";
import { roleSetPickers } from "../helpers/vocabulary";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";
import type { RolePickers } from "../../app/lib/role-options";

async function makeI18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  return inst;
}

function side(over: Record<string, unknown>) {
  return {
    id: "x",
    name: "Juan de Mosquera",
    code: "ne-x",
    entityType: "person",
    dates: null,
    nameVariants: "[]",
    sources: null,
    wikidataId: null,
    viafId: null,
    dbeId: null,
    tgnId: null,
    descriptionCount: 0,
    ...over,
  };
}

const LEFT = side({
  id: "left-id",
  code: "ne-left",
  descriptionCount: 12,
  context: {
    descriptionTotal: 12,
    descriptions: [
      {
        id: "desc-1",
        title: "Pleito por tierras",
        referenceCode: "co-acc-1",
        dateExpression: "1711",
        dateStart: "1711-01-01",
        dateEnd: null,
        roles: ["plaintiff"],
        nameAsRecorded: "Ju.o de Mosquera",
      },
    ],
    entities: [
      { id: "wit", name: "Pedro Testigo", code: "ne-wit", count: 12 },
      { id: "solo", name: "Solo Izquierda", code: "ne-solo", count: 1 },
    ],
    places: [{ id: "pop", name: "Popayán", code: "nl-pop", count: 3 }],
    origin: {
      createdAt: Date.UTC(2026, 3, 1),
      legacyIds: [{ provider: "django-zasqua", id: "801088" }],
      journal: null,
      pipeline: {
        createdAt: Date.UTC(2026, 3, 16),
        decisionSource: "agent",
        decisionRule: null,
        reasoning: "Same given name and surname.",
        mentionCount: 48,
        pipelineEntityId: "acc-00002",
      },
      splitFrom: [],
      absorbed: { count: 2, latestAt: Date.UTC(2026, 3, 16) },
    },
  },
});

const RIGHT = side({
  id: "right-id",
  code: "ne-right",
  name: "Juan Mosquera",
  context: {
    descriptionTotal: 0,
    descriptions: [],
    entities: [{ id: "wit", name: "Pedro Testigo", code: "ne-wit", count: 1 }],
    places: [],
    origin: {
      createdAt: Date.UTC(2026, 6, 3),
      legacyIds: [],
      journal: {
        userName: "Ana Archivista",
        note: null,
        createdAt: Date.UTC(2026, 6, 3),
        run: null,
      },
      pipeline: null,
      splitFrom: [],
      absorbed: null,
    },
  },
});

const BARE = side({
  id: "bare-id",
  code: "ne-bare",
  context: {
    descriptionTotal: 0,
    descriptions: [],
    entities: [],
    places: [],
    origin: {
      createdAt: Date.UTC(2026, 6, 3),
      legacyIds: [],
      journal: null,
      pipeline: null,
      splitFrom: [],
      absorbed: null,
    },
  },
});

async function renderPage(lang: "en" | "es", right = RIGHT, roles: RolePickers = roleSetPickers(NEOGRANADINA_ROLES, lang)) {
  const inst = await makeI18n(lang);
  const path = "/admin/decisions/pair";
  const Stub = createRoutesStub([
    {
      path,
      Component: () =>
        React.createElement(DecisionPairPage as any, {
          loaderData: {
            kind: "entities",
            left: LEFT,
            right,
            comments: [],
            viewer: { userId: "u1", isAdmin: true },
            roles,
          },
          actionData: undefined,
          params: {},
          matches: [],
        }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: [path] }),
    ),
  );
}

describe("duplicate pair page: rendered context", () => {
  it("renders the context rows in English", async () => {
    const html = await renderPage("en");
    expect(html).toContain("Named in");
    expect(html).toContain("Criterion: agent");
    expect(html).toContain("Earlier identifiers");
    expect(html).toContain('href="/admin/descriptions/desc-1"');
    expect(html).toContain("Pleito por tierras");
    expect(html).toContain("co-acc-1");
    expect(html).toContain("Plaintiff");
    expect(html).toContain("Recorded as “Ju.o de Mosquera”");
    expect(html).toContain('href="/admin/entities/left-id"');
    expect(html).toContain("and 11 more");
    expect(html).toContain("Entities in the same descriptions");
    expect(html).toContain("Places in the same descriptions");
    expect(html).toContain("Popayán");
    expect(html).toContain("Origin");
    expect(html).toContain("Created by the automatic entity identification process");
    expect(html).toContain("48 mentions");
    expect(html).toContain("django-zasqua");
    expect(html).toContain("2 records merged into this one");
    expect(html).toContain('href="/admin/entities/left-id/history"');
    expect(html).toContain("Created by Ana Archivista");
  });

  it("renders the context rows in Spanish", async () => {
    const html = await renderPage("es");
    expect(html).toContain("Aparece en");
    expect(html).toContain("Figura como “Ju.o de Mosquera”");
    expect(html).toContain("Criterio: agent");
    expect(html).toContain("48 menciones en las fuentes que analizó el proceso");
    expect(html).toContain("Identificadores anteriores");
    expect(html).toContain("Demandante");
    expect(html).toContain("y 11 más");
    expect(html).toContain("Entidades en las mismas descripciones");
    expect(html).toContain("Lugares en las mismas descripciones");
    expect(html).toContain("Origen");
    expect(html).toContain("Creado por el proceso automático de identificación de entidades");
    expect(html).toContain("Creado por Ana Archivista");
  });

  it("labels a role from the federation's lists", async () => {
    const set = {
      ...NEOGRANADINA_ROLES,
      entityRoles: NEOGRANADINA_ROLES.entityRoles.map((r) =>
        r.code === "plaintiff" ? { ...r, es: "Querellante", en: "Complainant" } : r,
      ),
    };
    expect(await renderPage("en", RIGHT, roleSetPickers(set, "en"))).toContain("Complainant");
    expect(await renderPage("es", RIGHT, roleSetPickers(set, "es"))).toContain("Querellante");
  });

  it("says plainly when nothing records a record's origin", async () => {
    const en = await renderPage("en", BARE);
    expect(en).toContain("Fisqua has no record of how this record was created.");
    const es = await renderPage("es", BARE);
    expect(es).toContain("Fisqua no tiene constancia de cómo se creó este registro.");
  });
});

/* @version v0.9.0 */
