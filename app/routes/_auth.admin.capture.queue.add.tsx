/**
 * Add to digitization queue — the endpoint behind the add buttons
 *
 * This route has no page. It is the one address the "Add to
 * digitization queue" buttons post to, wherever they are: a
 * description's page (the description, or everything below it), the
 * actions menu on each row of the Descriptions screen's two views and
 * its preview pane, the search page's selection bar, and a handlist's
 * page. The tenant must
 * have the digitization capability (a bare 404 otherwise) and the
 * person must work in capture (`captureAccess(...).worker`, as the
 * Digitization screens require; a bare 403 otherwise).
 *
 * One form field says what to add:
 *
 *   - `descriptionIds`: a JSON array of description ids;
 *   - `below`: a description id, under which `subtreeToQueue` picks the
 *     deepest volume or file on each branch, at most 50 (`below-limit`
 *     past that);
 *   - `handlistId`: a records handlist, whose members are added in its
 *     order.
 *
 * Success is `{ ok: true, added, alreadyQueued }`, so the button can say
 * how many went in and how many were there already. A refusal is
 * `{ ok: false, error }` with one of `QueueError`'s codes (`not-found`,
 * `ceiling`, `below-limit`, `invalid`) and its status, phrased by the button.
 *
 * A GET with `?below=<id>` answers `{ below }`: how many "add everything
 * below this" would add (`countBelow`), or null when that action does
 * not apply. The Descriptions screen asks it when a row's menu opens,
 * so a column of rows costs nothing until one menu is opened. Same
 * capability and permission rules as the post.
 *
 * @version v0.9.0
 */
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.capture.queue.add";

const STATUS: Record<string, number> = {
  "not-found": 404,
  ceiling: 400,
  "below-limit": 400,
  invalid: 400,
  operator: 400,
  retakes: 409,
};

function readIds(value: FormDataEntryValue | null): string[] | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id !== "") : null;
  } catch {
    return null;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const { countBelow } = await import("~/lib/capture/queue.server");
  const db = drizzle(context.cloudflare.env.DB);
  if (!(await captureAccess(db, tenant, user)).worker) throw new Response(null, { status: 403 });
  const below = new URL(request.url).searchParams.get("below");
  if (!below) return Response.json({ below: null }, { status: 400 });
  return Response.json({ below: await countBelow(db, tenant.id, below) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  if (request.method !== "POST") throw new Response(null, { status: 405, headers: { Allow: "POST" } });
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const { addToQueue, handlistToQueue, subtreeToQueue, QueueError } = await import("~/lib/capture/queue.server");
  const db = drizzle(context.cloudflare.env.DB);
  if (!(await captureAccess(db, tenant, user)).worker) throw new Response(null, { status: 403 });

  const form = await request.formData();
  const deps = { db, now: () => Date.now(), newId: () => crypto.randomUUID() };
  try {
    let ids: string[] | null = readIds(form.get("descriptionIds"));
    const below = form.get("below");
    const handlistId = form.get("handlistId");
    if (ids === null && typeof below === "string" && below !== "") ids = await subtreeToQueue(db, tenant.id, below);
    if (ids === null && typeof handlistId === "string" && handlistId !== "") {
      ids = await handlistToQueue(db, tenant, user, handlistId);
    }
    if (ids === null) return Response.json({ ok: false as const, error: "invalid" }, { status: 400 });
    const result = await addToQueue(deps, tenant, user, ids);
    return Response.json({ ok: true as const, ...result });
  } catch (thrown) {
    if (thrown instanceof QueueError) {
      return Response.json({ ok: false as const, error: thrown.code }, { status: STATUS[thrown.code] ?? 400 });
    }
    throw thrown;
  }
}

// @version v0.9.0
