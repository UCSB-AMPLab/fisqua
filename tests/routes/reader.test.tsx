/**
 * Tests — the Reader role and its published records pages
 *
 * This suite pins the Reader (`isArchiveUser`) as a read-only role
 * that sees published records only. Six parts:
 *
 *   1. The record page, `/records/:id`. A Reader gets a published
 *      record; an unpublished record is a 404, and so is a published
 *      record's unpublished child, which its parent's contents neither
 *      list nor count. The ancestor trail stops at the first
 *      unpublished ancestor. Columns that never leave the admin
 *      surface (internal notes among them) are not in the payload, and
 *      the rendered page links only under `/records/`. Linked
 *      authorities are read by visibility: one owned by another member
 *      tenant of the federation, or one from another federation, is
 *      not shown. A record unpublished after its first read shows no
 *      repository, children, ancestors or links from the later reads. A workspace
 *      admin on an unpublished record also gets a 404: the filter
 *      belongs to the page. A cataloguer without records access gets
 *      a 403.
 *
 *   2. The records list, `/records`: published entry points only (no
 *      parent, or an unpublished parent), with a total under the same
 *      filter. A records admin opens it; the other area admins get a
 *      403.
 *
 *   3. `confineMemberAccess`. A Reader with no other role is sent from
 *      the dashboard, admin, project, import, export, capture, users,
 *      search and handlists paths to `/records`, and refused 403 on a
 *      write; a member with no role, membership or grant is sent to
 *      `/no-access`. A Reader who is also staff, a project member, a
 *      grant holder, a member holding a federation membership in the
 *      tenant's federation (on their home tenant) and an impersonating
 *      operator all pass. An assigned capture reviewer is covered,
 *      through the request handler, in `tests/capture/qc.test.ts`. The whole
 *      chain is run once more behind the real `authMiddleware`. Only a
 *      document navigation is redirected: through React Router's request
 *      handler, a Reader's `.data` request and a resource route fetched
 *      by script are answered 403, and `isDocumentNavigation` reads the
 *      fetch metadata and the Accept fallback. A prefetch or prerender
 *      (`Sec-Purpose`, or the older `Purpose: prefetch`) is answered 403
 *      whatever else it carries, and a HEAD navigation is redirected.
 *
 *   4. The existing guards on representative surfaces refuse a Reader
 *      on their own: admin descriptions, users, imports, capture
 *      volumes and a project. Exports has no guard of its own (it is
 *      member-level by design), which is why the confinement exists.
 *
 *   5. The sidebar: a Reader sees Records alone, a member with no
 *      access sees no sections, a Reader who is also a cataloguer
 *      keeps everything and gains Records.
 *
 *   6. Area admins: each area flag makes a member staff, never
 *      confined, and `canReadRecords` admits a Reader and whoever passes
 *      the records area (workspace, super and records admins) only.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub, RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import resources from "../../app/locales";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  seedFederations,
} from "../helpers/db";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { createTestUser } from "../helpers/auth";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type ImpersonatingState,
  type Tenant,
  type User,
} from "../../app/context";
import {
  canReadRecords,
  confineMemberAccess,
  isDocumentNavigation,
  loadPublishedRecord,
  memberAccessFrom,
} from "../../app/lib/reader.server";
import { authMiddleware } from "../../app/middleware/auth.server";
import { createSessionStorage } from "../../app/sessions.server";
import { getSidebarSections } from "../../app/components/layout/sidebar";
import {
  loader as recordLoader,
  default as RecordPage,
} from "../../app/routes/_auth.records.$id";
import { loader as recordsLoader } from "../../app/routes/_auth.records._index";
import { loader as adminDescriptionsLoader } from "../../app/routes/_auth.admin.descriptions";
import { loader as usersLoader } from "../../app/routes/_auth.admin.users";
import { loader as importsLoader } from "../../app/routes/_auth.admin.imports";
import { loader as captureVolumesLoader } from "../../app/routes/_auth.admin.capture.volumes";
import { loader as projectLoader } from "../../app/routes/_auth.projects.$id";

const HOST = "https://neogranadina.fisqua.test";

function db() {
  return drizzle(env.DB);
}

function buildContext(args: {
  user: User;
  tenant?: Partial<Tenant>;
  grant?: GrantState | null;
  impersonating?: ImpersonatingState | null;
}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, args.user);
  ctx.set(
    tenantContext,
    makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, ...args.tenant }),
  );
  ctx.set(grantContext, args.grant ?? null);
  ctx.set(impersonationContext, args.impersonating ?? null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

const reader = (overrides: Partial<User> = {}) =>
  makeUserContext({ id: crypto.randomUUID(), isArchiveUser: true, ...overrides });

/** Runs a loader or middleware and returns the thrown or returned Response. */
async function settle(run: () => Promise<unknown>): Promise<Response | unknown> {
  try {
    return await run();
  } catch (thrown) {
    return thrown;
  }
}

function statusOf(result: unknown): number | undefined {
  return result instanceof Response ? result.status : undefined;
}

function locationOf(result: unknown): string | null {
  return result instanceof Response ? result.headers.get("Location") : null;
}

// ---------------------------------------------------------------------------
// Fixture: a small tree with published and unpublished records
// ---------------------------------------------------------------------------
//
//   fonds (published)
//     series (published)
//       file (published)
//       hiddenFile (unpublished)
//     hiddenSeries (unpublished)
//       orphan (published, parent unpublished)
//   draftFonds (unpublished)

interface Tree {
  repositoryId: string;
  fonds: string;
  series: string;
  file: string;
  hiddenFile: string;
  hiddenSeries: string;
  orphan: string;
  draftFonds: string;
}

async function seedTree(): Promise<Tree> {
  const repo = await createTestRepository({ name: "Archivo de prueba" });
  const make = (
    title: string,
    isPublished: boolean,
    parentId: string | null,
    level: string,
    position = 0,
  ) =>
    createTestDescription({
      repositoryId: repo.id,
      title,
      isPublished,
      parentId,
      descriptionLevel: level,
      position,
      referenceCode: `REF-${title.replace(/\s+/g, "-")}`,
    });
  const fonds = await make("Fondo publicado", true, null, "fonds");
  const series = await make("Serie publicada", true, fonds.id, "series", 0);
  const hiddenSeries = await make("Serie oculta", false, fonds.id, "series", 1);
  const file = await make("Expediente publicado", true, series.id, "file", 0);
  const hiddenFile = await make("Expediente oculto", false, series.id, "file", 1);
  const orphan = await make("Expediente huerfano", true, hiddenSeries.id, "file", 0);
  const draftFonds = await make("Fondo borrador", false, null, "fonds");
  // Denormalised counts as the tree would hold them: they include the
  // unpublished children, which the Reader pages must not.
  await db()
    .update(schema.descriptions)
    .set({ childCount: 2 })
    .where(eq(schema.descriptions.id, fonds.id));
  await db()
    .update(schema.descriptions)
    .set({ childCount: 2, internalNotes: "Nota interna confidencial" })
    .where(eq(schema.descriptions.id, series.id));
  return {
    repositoryId: repo.id,
    fonds: fonds.id,
    series: series.id,
    file: file.id,
    hiddenFile: hiddenFile.id,
    hiddenSeries: hiddenSeries.id,
    orphan: orphan.id,
    draftFonds: draftFonds.id,
  };
}

function recordRequest(id: string): Request {
  return new Request(`${HOST}/records/${id}`);
}

describe("Reader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // -------------------------------------------------------------------------
  // 1. The record page
  // -------------------------------------------------------------------------

  describe("/records/:id", () => {
    it("gives a Reader a published record with only its published children, listed and counted", async () => {
      const tree = await seedTree();
      const data: any = await recordLoader({
        params: { id: tree.series },
        request: recordRequest(tree.series),
        context: buildContext({ user: reader() }),
      } as any);

      expect(data.record.id).toBe(tree.series);
      expect(data.record.title).toBe("Serie publicada");
      expect(data.children.total).toBe(1);
      expect(data.children.rows.map((r: any) => r.id)).toEqual([tree.file]);
      expect(data.record.childCount).toBe(1);
      expect(data.ancestors).toEqual([{ id: tree.fonds, title: "Fondo publicado" }]);
      expect(data.repositories).toEqual([
        { id: tree.repositoryId, name: "Archivo de prueba" },
      ]);
    });

    it("leaves internal columns out of the record it hands the page", async () => {
      const tree = await seedTree();
      const data: any = await recordLoader({
        params: { id: tree.series },
        request: recordRequest(tree.series),
        context: buildContext({ user: reader() }),
      } as any);

      for (const column of [
        "internalNotes",
        "parentId",
        "rootDescriptionId",
        "pathCache",
        "isPublished",
        "lastExportedAt",
        "legacyIds",
        "createdBy",
        "tenantId",
      ]) {
        expect(data.record).not.toHaveProperty(column);
      }
      expect(JSON.stringify(data)).not.toContain("Nota interna confidencial");
      expect(data.hiddenColumns).toContain("internalNotes");
      expect(data.hiddenColumns).not.toContain("repositoryId");
    });

    it("answers 404 for an unpublished record", async () => {
      const tree = await seedTree();
      const result = await settle(() =>
        recordLoader({
          params: { id: tree.draftFonds },
          request: recordRequest(tree.draftFonds),
          context: buildContext({ user: reader() }),
        } as any),
      );
      expect(statusOf(result)).toBe(404);
    });

    it("answers 404 for a published record's unpublished child", async () => {
      const tree = await seedTree();
      const result = await settle(() =>
        recordLoader({
          params: { id: tree.hiddenFile },
          request: recordRequest(tree.hiddenFile),
          context: buildContext({ user: reader() }),
        } as any),
      );
      expect(statusOf(result)).toBe(404);
    });

    it("answers 404 for a record of another tenant", async () => {
      const tree = await seedTree();
      const result = await settle(() =>
        recordLoader({
          params: { id: tree.fonds },
          request: recordRequest(tree.fonds),
          context: buildContext({
            user: reader(),
            tenant: { id: "22222222-2222-4222-8222-222222222222", slug: "second-tenant" },
          }),
        } as any),
      );
      expect(statusOf(result)).toBe(404);
    });

    it("answers 404 to a workspace admin on an unpublished record", async () => {
      const tree = await seedTree();
      const result = await settle(() =>
        recordLoader({
          params: { id: tree.draftFonds },
          request: recordRequest(tree.draftFonds),
          context: buildContext({ user: makeUserContext({ isAdmin: true }) }),
        } as any),
      );
      expect(statusOf(result)).toBe(404);
    });

    it("shows a workspace admin the same published children a Reader sees", async () => {
      const tree = await seedTree();
      const data: any = await recordLoader({
        params: { id: tree.fonds },
        request: recordRequest(tree.fonds),
        context: buildContext({ user: makeUserContext({ isAdmin: true }) }),
      } as any);
      expect(data.children.rows.map((r: any) => r.id)).toEqual([tree.series]);
      expect(data.children.total).toBe(1);
      expect(data.record.childCount).toBe(1);
    });

    it("stops the ancestor trail at the first unpublished ancestor", async () => {
      const tree = await seedTree();
      const data: any = await recordLoader({
        params: { id: tree.orphan },
        request: recordRequest(tree.orphan),
        context: buildContext({ user: reader() }),
      } as any);
      expect(data.ancestors).toEqual([]);
      expect(JSON.stringify(data)).not.toContain("Serie oculta");
      expect(JSON.stringify(data)).not.toContain(tree.hiddenSeries);
    });

    it("refuses a cataloguer without records access with 403", async () => {
      const tree = await seedTree();
      const result = await settle(() =>
        recordLoader({
          params: { id: tree.fonds },
          request: recordRequest(tree.fonds),
          context: buildContext({ user: makeUserContext({ isCataloguer: true }) }),
        } as any),
      );
      expect(statusOf(result)).toBe(403);
    });

    it("renders linked entities and places as text and links only under /records/", async () => {
      const tree = await seedTree();
      const entity = await createTestEntity({ displayName: "Pedro de Ugarte" });
      const place = await createTestPlace({ label: "Santafé" });
      const now = Date.now();
      await db().insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId: tree.series,
        entityId: entity.id,
        role: "creator",
        sequence: 0,
        createdAt: now,
      });
      await db().insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId: tree.series,
        placeId: place.id,
        role: "created",
        createdAt: now,
      });

      const data: any = await recordLoader({
        params: { id: tree.series },
        request: recordRequest(tree.series),
        context: buildContext({ user: reader() }),
      } as any);
      expect(data.entityLinks.map((l: any) => l.entityDisplayName)).toEqual([
        "Pedro de Ugarte",
      ]);
      expect(data.placeLinks.map((l: any) => l.placeLabel)).toEqual(["Santafé"]);

      const inst = i18next.createInstance();
      await (inst.init as (opts: unknown) => Promise<unknown>)({
        lng: "en",
        fallbackLng: "es",
        defaultNS: "common",
        resources,
        interpolation: { escapeValue: false },
      });
      const path = `/records/${tree.series}`;
      const Stub = createRoutesStub([
        {
          path: "/records/:id",
          Component: () =>
            React.createElement(RecordPage as React.ComponentType<any>, {
              loaderData: data,
            }),
        },
      ]);
      const html = renderToStaticMarkup(
        React.createElement(
          I18nextProvider,
          { i18n: inst },
          React.createElement(Stub, { initialEntries: [path] }),
        ),
      );

      expect(html).toContain("Pedro de Ugarte");
      expect(html).toContain("Santafé");
      expect(html).toContain(`href="/records/${tree.file}"`);
      expect(html).toContain(`href="/records/${tree.fonds}"`);
      expect(html).not.toContain("/admin/");
      expect(html).not.toContain("Expediente oculto");
      expect(html).not.toContain("Nota interna confidencial");
      expect(html).toContain("1 published record");
    });
  });

  describe("authority visibility and publication in every statement", () => {
    const OTHER_MEMBER_ID = "0b2b0000-0000-4000-8000-00000000000b";

    async function seedOtherMember(): Promise<void> {
      const now = Date.now();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
          "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
          "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          OTHER_MEMBER_ID, "other-member", "other-member", "tenant", "isadg", "active",
          0, 1, 0, 0, null, NEOGRANADINA_FEDERATION_ID, now, now,
        )
        .run();
    }

    async function link(descriptionId: string, entityId: string, placeId: string) {
      const now = Date.now();
      await db().insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId,
        entityId,
        role: "creator",
        sequence: 0,
        createdAt: now,
      });
      await db().insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId,
        placeId,
        role: "created",
        createdAt: now,
      });
    }

    async function readSeries(tree: Tree): Promise<any> {
      return recordLoader({
        params: { id: tree.series },
        request: recordRequest(tree.series),
        context: buildContext({ user: reader() }),
      } as any);
    }

    it("hides an authority owned by another member tenant of the federation", async () => {
      const tree = await seedTree();
      await seedOtherMember();
      const entity = await createTestEntity({ displayName: "Privada del vecino", entityCode: "ne-priv01" });
      const place = await createTestPlace({ label: "Lugar del vecino", placeCode: "nl-priv01" });
      await db()
        .update(schema.entities)
        .set({ tenantId: OTHER_MEMBER_ID })
        .where(eq(schema.entities.id, entity.id));
      await db()
        .update(schema.places)
        .set({ tenantId: OTHER_MEMBER_ID })
        .where(eq(schema.places.id, place.id));
      await link(tree.series, entity.id, place.id);

      const data = await readSeries(tree);
      expect(data.entityLinks).toEqual([]);
      expect(data.placeLinks).toEqual([]);
      const json = JSON.stringify(data);
      for (const leak of ["Privada del vecino", "ne-priv01", entity.id, "Lugar del vecino", "nl-priv01", place.id]) {
        expect(json).not.toContain(leak);
      }
    });

    it("hides an authority from another federation", async () => {
      const tree = await seedTree();
      const entity = await createTestEntity({
        displayName: "Ajena",
        entityCode: "ne-ajena1",
        federationId: SECOND_TEST_FEDERATION_ID,
      });
      const place = await createTestPlace({
        label: "Lugar ajeno",
        placeCode: "nl-ajeno1",
        federationId: SECOND_TEST_FEDERATION_ID,
      });
      await link(tree.series, entity.id, place.id);

      const data = await readSeries(tree);
      expect(data.entityLinks).toEqual([]);
      expect(data.placeLinks).toEqual([]);
      expect(JSON.stringify(data)).not.toContain("Ajena");
      expect(JSON.stringify(data)).not.toContain("Lugar ajeno");
    });

    it("still shows a shared authority and one the request tenant owns", async () => {
      const tree = await seedTree();
      const shared = await createTestEntity({ displayName: "Compartida", entityCode: "ne-comp01" });
      const own = await createTestPlace({ label: "Propio", placeCode: "nl-prop01" });
      await db()
        .update(schema.places)
        .set({ tenantId: DEFAULT_TEST_TENANT_ID })
        .where(eq(schema.places.id, own.id));
      await link(tree.series, shared.id, own.id);

      const data = await readSeries(tree);
      expect(data.entityLinks.map((l: any) => l.entityDisplayName)).toEqual(["Compartida"]);
      expect(data.placeLinks.map((l: any) => l.placeLabel)).toEqual(["Propio"]);
    });

    it("shows nothing from the follow-up reads when the record is unpublished after the first read", async () => {
      const tree = await seedTree();
      const entity = await createTestEntity({ displayName: "Tras despublicar" });
      const place = await createTestPlace({ label: "Lugar tras despublicar" });
      await link(tree.series, entity.id, place.id);

      // A D1 binding that unpublishes the record before any statement
      // after the first one runs, as a concurrent unpublish would.
      let prepared = 0;
      let unpublished = false;
      const unpublish = async () => {
        if (unpublished) return;
        unpublished = true;
        await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE id = ?")
          .bind(tree.series)
          .run();
      };
      const wrap = (stmt: any): any =>
        new Proxy(stmt, {
          get(target, prop) {
            if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
            if (prop === "all" || prop === "raw" || prop === "first" || prop === "run") {
              return async (...args: unknown[]) => {
                await unpublish();
                return target[prop](...args);
              };
            }
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      const racingDb = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (query: string) => {
              prepared++;
              const stmt = target.prepare(query);
              return prepared === 1 ? stmt : wrap(stmt);
            };
          }
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const loaded = await loadPublishedRecord(
        drizzle(racingDb as any),
        { id: DEFAULT_TEST_TENANT_ID, federationId: NEOGRANADINA_FEDERATION_ID },
        tree.series,
        1,
      );
      expect(unpublished).toBe(true);
      expect(loaded).not.toBeNull();
      expect(loaded!.ancestors).toEqual([]);
      expect(loaded!.children.rows).toEqual([]);
      expect(loaded!.children.total).toBe(0);
      expect(loaded!.repositories).toEqual([]);
      expect(loaded!.entityLinks).toEqual([]);
      expect(loaded!.placeLinks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. The records list
  // -------------------------------------------------------------------------

  describe("/records", () => {
    it("lists published entry points only, with a total under the same filter", async () => {
      const tree = await seedTree();
      const data: any = await recordsLoader({
        params: {},
        request: new Request(`${HOST}/records`),
        context: buildContext({ user: reader() }),
      } as any);
      const ids = data.rows.map((r: any) => r.id).sort();
      expect(ids).toEqual([tree.fonds, tree.orphan].sort());
      expect(data.total).toBe(2);
    });

    it("opens to a records admin and refuses the other area admins with 403", async () => {
      await seedTree();
      const open = (flag: string) =>
        settle(() =>
          recordsLoader({
            params: {},
            request: new Request(`${HOST}/records`),
            context: buildContext({ user: makeUserContext({ [flag]: true }) }),
          } as any),
        );
      expect(statusOf(await open("isRecordsAdmin"))).toBeUndefined();
      for (const flag of ["isAuthoritiesAdmin", "isImportsAdmin", "isDigitizationAdmin"]) {
        expect(statusOf(await open(flag))).toBe(403);
      }
    });

    it("refuses a member with no records access with 403", async () => {
      const result = await settle(() =>
        recordsLoader({
          params: {},
          request: new Request(`${HOST}/records`),
          context: buildContext({ user: makeUserContext({ isCollabAdmin: true }) }),
        } as any),
      );
      expect(statusOf(result)).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 3. confineMemberAccess
  // -------------------------------------------------------------------------

  describe("confineMemberAccess", () => {
    async function confine(
      user: User,
      path: string,
      init: { method?: string; grant?: GrantState | null; impersonating?: ImpersonatingState | null } = {},
    ) {
      return settle(() =>
        (confineMemberAccess as any)(
          {
            request: new Request(`${HOST}${path}`, {
              method: init.method ?? "GET",
              // A browser's page navigation unless the case says otherwise.
              headers: init.method && init.method !== "GET" ? {} : { "Sec-Fetch-Dest": "document" },
            }),
            context: buildContext({
              user,
              grant: init.grant,
              impersonating: init.impersonating,
            }),
          },
          async () => new Response(null),
        ),
      );
    }

    const confinedPaths = [
      "/dashboard",
      "/admin/descriptions",
      "/admin/descriptions/some-id",
      "/projects/some-project",
      "/proyectos",
      "/admin/imports",
      "/admin/exports",
      "/admin/capture/volumes",
      "/admin/users",
      "/admin/entities",
      "/search",
      "/handlists",
    ];

    for (const path of confinedPaths) {
      it(`sends a Reader from ${path} to /records`, async () => {
        const result = await confine(reader(), path);
        expect(statusOf(result)).toBe(302);
        expect(locationOf(result)).toBe("/records");
      });
    }

    it("refuses a Reader's non-navigation GET outside /records with 403", async () => {
      const result = await settle(() =>
        (confineMemberAccess as any)(
          {
            request: new Request(`${HOST}/admin/exports`, {
              headers: { "Sec-Fetch-Dest": "empty" },
            }),
            context: buildContext({ user: reader() }),
          },
          async () => new Response(null),
        ),
      );
      expect(statusOf(result)).toBe(403);
    });

    it("refuses a Reader's write outside /records with 403", async () => {
      expect(statusOf(await confine(reader(), "/admin/exports", { method: "POST" }))).toBe(403);
      expect(statusOf(await confine(reader(), "/api/comments", { method: "POST" }))).toBe(403);
    });

    it("lets a Reader open /records, a record and their settings", async () => {
      for (const path of ["/records", "/records/abc", "/configuracion"]) {
        expect(await confine(reader(), path)).toBeUndefined();
      }
    });

    it("sends a member with no role, membership or grant to /no-access", async () => {
      const member = makeUserContext({ id: crypto.randomUUID() });
      for (const path of ["/dashboard", "/records", "/admin/exports", "/search"]) {
        const result = await confine(member, path);
        expect(statusOf(result)).toBe(302);
        expect(locationOf(result)).toBe("/no-access");
      }
      expect(await confine(member, "/no-access")).toBeUndefined();
    });

    it("lets a Reader who is also staff go anywhere", async () => {
      const user = reader({ isCataloguer: true });
      expect(await confine(user, "/dashboard")).toBeUndefined();
      expect(await confine(user, "/admin/exports")).toBeUndefined();
    });

    it("treats a project member of this tenant as staff", async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      await db()
        .update(schema.users)
        .set({ isArchiveUser: true })
        .where(eq(schema.users.id, member.id));
      const projectId = crypto.randomUUID();
      const now = Date.now();
      await db().insert(schema.projects).values({
        id: projectId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Proyecto",
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now,
      });
      await db().insert(schema.projectMembers).values({
        id: crypto.randomUUID(),
        projectId,
        userId: member.id,
        role: "cataloguer",
        createdAt: now,
      });
      const user = reader({ id: member.id });
      expect(await confine(user, "/dashboard")).toBeUndefined();
    });

    it("treats a member holding a federation membership in the tenant's federation as staff on their home tenant", async () => {
      await seedFederations();
      for (const role of ["steward", "staff"] as const) {
        const row = await createTestUser();
        await db().insert(schema.federationMemberships).values({
          id: crypto.randomUUID(),
          userId: row.id,
          federationId: NEOGRANADINA_FEDERATION_ID,
          role,
          createdAt: Date.now(),
        });
        const member = makeUserContext({ id: row.id });
        expect(await confine(member, "/dashboard")).toBeUndefined();
      }
      // A membership in another federation gives nothing here.
      const elsewhere = await createTestUser();
      await db().insert(schema.federationMemberships).values({
        id: crypto.randomUUID(),
        userId: elsewhere.id,
        federationId: SECOND_TEST_FEDERATION_ID,
        role: "steward",
        createdAt: Date.now(),
      });
      const result = await confine(makeUserContext({ id: elsewhere.id }), "/dashboard");
      expect(locationOf(result)).toBe("/no-access");
    });

    it("treats a grant holder and an impersonating operator as staff", async () => {
      const member = makeUserContext({ id: crypto.randomUUID() });
      expect(
        await confine(member, "/dashboard", {
          grant: { role: "staff", federationId: "f", homeTenantId: "t" },
        }),
      ).toBeUndefined();
      expect(
        await confine(member, "/dashboard", {
          impersonating: {
            role: "isArchiveUser",
            sessionId: "s",
            lastActivityAt: Date.now(),
          },
        }),
      ).toBeUndefined();
    });

    it("sends a signed-in Reader to /records and a no-role member to /no-access behind the real auth middleware", async () => {
      const readerRow = await createTestUser();
      await db()
        .update(schema.users)
        .set({ isArchiveUser: true })
        .where(eq(schema.users.id, readerRow.id));
      const memberRow = await createTestUser();
      const { getSession, commitSession } = createSessionStorage("test-session-secret");

      async function land(userId: string): Promise<unknown> {
        const session = await getSession();
        session.set("userId", userId);
        const cookie = await commitSession(session);
        const request = new Request(`${HOST}/dashboard`, {
          headers: { Cookie: cookie, "Sec-Fetch-Dest": "document" },
        });
        const ctx = new RouterContextProvider();
        (ctx as any).cloudflare = { env };
        return settle(async () => {
          await authMiddleware({ request, context: ctx } as any, async () => undefined);
          return (confineMemberAccess as any)(
            { request, context: ctx },
            async () => new Response(null),
          );
        });
      }

      const readerLanding = await land(readerRow.id);
      expect(statusOf(readerLanding)).toBe(302);
      expect(locationOf(readerLanding)).toBe("/records");

      const memberLanding = await land(memberRow.id);
      expect(statusOf(memberLanding)).toBe(302);
      expect(locationOf(memberLanding)).toBe("/no-access");
    });
  });

  describe("through the request handler", () => {
    /**
     * A server build with a bare root, a layout carrying the Reader
     * middleware, a page route (`/search`), a resource route
     * (`/admin/exports/download/:runId`) and the records list, driven by
     * React Router's own request handler so `.data` handling and
     * resource-route dispatch are React Router's.
     */
    async function handle(
      path: string,
      headers: Record<string, string>,
      method: "GET" | "HEAD" = "GET",
    ) {
      const { createRequestHandler } = await import("react-router");
      let reached = false;
      const build: any = {
        entry: {
          module: {
            default: (_request: Request, status: number, responseHeaders: Headers) =>
              new Response("document", { status, headers: responseHeaders }),
          },
        },
        routes: {
          root: { id: "root", path: "", module: { default: () => null } },
          layout: {
            id: "layout",
            parentId: "root",
            module: { middleware: [confineMemberAccess], default: () => null },
          },
          search: {
            id: "search",
            parentId: "layout",
            path: "search",
            module: {
              loader: () => {
                reached = true;
                return { ok: true };
              },
              default: () => null,
            },
          },
          download: {
            id: "download",
            parentId: "layout",
            path: "admin/exports/download/:runId",
            module: {
              loader: () => {
                reached = true;
                return new Response("file");
              },
            },
          },
          records: {
            id: "records",
            parentId: "layout",
            path: "records",
            module: { loader: () => ({ ok: true }), default: () => null },
          },
        },
        assets: { entry: { module: "/entry.js", imports: [] }, routes: {}, url: "/manifest.js", version: "test" },
        publicPath: "/",
        assetsBuildDirectory: "build/client",
        future: { v8_middleware: true },
        ssr: true,
        isSpaMode: false,
        prerender: [],
        routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
      };
      const handler = createRequestHandler(build, "production");
      const response = await handler(
        new Request(`${HOST}${path}`, { headers, method }),
        buildContext({ user: reader() }),
      );
      return { response, reached: () => reached };
    }

    it("redirects a Reader's document navigation to /records", async () => {
      const { response, reached } = await handle("/search", {
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        Accept: "text/html",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/records");
      expect(reached()).toBe(false);
    });

    it("answers a Reader's .data request with 403, not a redirect", async () => {
      const { response, reached } = await handle("/search.data", {
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        Accept: "*/*",
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("X-Remix-Redirect")).toBeNull();
      expect(reached()).toBe(false);
    });

    it("answers a resource route fetched by script with 403", async () => {
      const { response, reached } = await handle("/admin/exports/download/run-1", {
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("Location")).toBeNull();
      expect(reached()).toBe(false);
    });

    it("redirects a Reader's HEAD navigation", async () => {
      const { response, reached } = await handle(
        "/search",
        { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
        "HEAD",
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/records");
      expect(reached()).toBe(false);
    });

    const prefetches: Array<[string, Record<string, string>]> = [
      ["Sec-Purpose: prefetch with Sec-Fetch-Dest: document", {
        "Sec-Purpose": "prefetch",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
      }],
      ["Sec-Purpose: prefetch;prerender with Sec-Fetch-Dest: document", {
        "Sec-Purpose": "prefetch;prerender",
        "Sec-Fetch-Dest": "document",
      }],
      ["Sec-Purpose: prefetch with Accept: text/html and no fetch metadata", {
        "Sec-Purpose": "prefetch",
        Accept: "text/html",
      }],
      ["Purpose: prefetch with Accept: text/html and no fetch metadata", {
        Purpose: "prefetch",
        Accept: "text/html",
      }],
      ["Purpose: prefetch with Sec-Fetch-Dest: document", {
        Purpose: "prefetch",
        "Sec-Fetch-Dest": "document",
      }],
    ];
    for (const [label, headers] of prefetches) {
      for (const method of ["GET", "HEAD"] as const) {
        it(`answers a ${method} prefetch (${label}) with 403`, async () => {
          const { response, reached } = await handle("/search", headers, method);
          expect(response.status).toBe(403);
          expect(response.headers.get("Location")).toBeNull();
          expect(reached()).toBe(false);
        });
      }
    }

    it("tells a navigation from other requests by fetch metadata, then by Accept", () => {
      const req = (method: string, headers: Record<string, string>) =>
        new Request(`${HOST}/search`, { method, headers });
      expect(isDocumentNavigation(req("GET", { "Sec-Fetch-Dest": "document" }))).toBe(true);
      expect(isDocumentNavigation(req("HEAD", { "Sec-Fetch-Dest": "document" }))).toBe(true);
      expect(isDocumentNavigation(req("GET", { "Sec-Fetch-Dest": "empty", Accept: "text/html" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", { "Sec-Fetch-Mode": "cors", Accept: "text/html" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", { Accept: "text/html,application/xhtml+xml" }))).toBe(true);
      expect(isDocumentNavigation(req("GET", { Accept: "*/*" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", {}))).toBe(false);
      expect(isDocumentNavigation(req("POST", { "Sec-Fetch-Dest": "document" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", { "Sec-Purpose": "prefetch", "Sec-Fetch-Dest": "document" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", { "Sec-Purpose": "prerender", Accept: "text/html" }))).toBe(false);
      expect(isDocumentNavigation(req("GET", { Purpose: "Prefetch", Accept: "text/html" }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Existing guards refuse a Reader on their own
  // -------------------------------------------------------------------------

  describe("existing route guards", () => {
    async function load(
      loader: (args: any) => Promise<unknown>,
      path: string,
      args: { params?: any; tenant?: Partial<Tenant> } = {},
    ) {
      return settle(() =>
        loader({
          params: args.params ?? {},
          request: new Request(`${HOST}${path}`),
          context: buildContext({ user: reader(), tenant: args.tenant }),
        }),
      );
    }

    it("admin descriptions refuses a Reader with 403", async () => {
      const result = await load(adminDescriptionsLoader, "/admin/descriptions");
      expect(statusOf(result)).toBe(403);
    });

    it("users refuses a Reader with 403", async () => {
      const result = await load(usersLoader, "/admin/users");
      expect(statusOf(result)).toBe(403);
    });

    it("imports refuses a Reader with 403", async () => {
      const result = await load(importsLoader, "/admin/imports", {
        tenant: { importsEnabled: true },
      });
      expect(statusOf(result)).toBe(403);
    });

    it("capture volumes refuses a Reader with 403", async () => {
      const result = await load(
        captureVolumesLoader,
        "/admin/capture/volumes",
        { tenant: { digitizationEnabled: true } },
      );
      expect(statusOf(result)).toBe(403);
    });

    it("a project refuses a Reader who is not a member", async () => {
      const owner = await createTestUser();
      const projectId = crypto.randomUUID();
      const now = Date.now();
      await db().insert(schema.projects).values({
        id: projectId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Proyecto",
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now,
      });
      const result = await load(projectLoader, `/projects/${projectId}`, {
        params: { id: projectId },
      });
      expect([403, 404]).toContain(statusOf(result));
    });
  });

  // -------------------------------------------------------------------------
  // 5. The sidebar
  // -------------------------------------------------------------------------

  describe("sidebar", () => {
    const tenant = {
      crowdsourcingEnabled: true,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
      authoritiesEnabled: true,
      importsEnabled: true,
      digitizationEnabled: true,
    };
    const base = {
      isAdmin: false,
      isSuperAdmin: false,
      isCollabAdmin: false,
      isArchiveUser: false,
      isUserManager: false,
      isCataloguer: false,
      isRecordsAdmin: false,
      isAuthoritiesAdmin: false,
      isImportsAdmin: false,
      hasAnyProjectMembership: false,
      isCaptureManager: false,
      isCaptureReviewer: false,
    };
    const paths = (sections: ReturnType<typeof getSidebarSections>) =>
      sections.flatMap((s) => s.items.map((i) => i.path));

    it("shows a Reader with no other role Records alone", () => {
      const sections = getSidebarSections(
        { ...base, isArchiveUser: true, access: "reader" },
        tenant,
      );
      expect(paths(sections)).toEqual(["/records"]);
    });

    it("shows a member with no access no sections", () => {
      expect(getSidebarSections({ ...base, access: "none" }, tenant)).toEqual([]);
    });

    it("keeps a Reader who is also a cataloguer's sections and adds Records", () => {
      const all = paths(
        getSidebarSections(
          { ...base, isArchiveUser: true, isCataloguer: true, access: "staff" },
          tenant,
        ),
      );
      expect(all).toContain("/records");
      expect(all).toContain("/proyectos");
      expect(all).toContain("/search");
    });
  });
});

describe("area admins and the Reader rules", () => {
  const none = {
    hasProjectMembership: false,
    isCaptureReviewer: false,
    hasFederationMembership: false,
    hasGrant: false,
    isImpersonating: false,
  };

  it("counts each area admin as staff, never confined", () => {
    for (const flag of ["isRecordsAdmin", "isAuthoritiesAdmin", "isImportsAdmin", "isDigitizationAdmin"]) {
      expect(memberAccessFrom(makeUserContext({ [flag]: true }), none)).toBe("staff");
    }
    expect(memberAccessFrom(makeUserContext({}), none)).toBe("none");
  });

  it("lets a Reader and whoever passes the records area read records", () => {
    expect(canReadRecords(makeUserContext({ isArchiveUser: true }))).toBe(true);
    expect(canReadRecords(makeUserContext({ isRecordsAdmin: true }))).toBe(true);
    expect(canReadRecords(makeUserContext({ isAdmin: true }))).toBe(true);
    expect(canReadRecords(makeUserContext({ isSuperAdmin: true }))).toBe(true);
    for (const flag of ["isAuthoritiesAdmin", "isImportsAdmin", "isDigitizationAdmin", "isCollabAdmin"]) {
      expect(canReadRecords(makeUserContext({ [flag]: true }))).toBe(false);
    }
  });
});

// @version v0.8.0
