/**
 * Add to handlist — the endpoint behind the picker
 *
 * This route has no page. It is the one address the add-to-handlist
 * picker talks to, wherever that picker is opened from: the search
 * page's selection bar, a description's own page, an entity's, a
 * place's. Keeping it in one place is what lets those surfaces share a
 * component rather than each growing an action of their own, and it is
 * why the JSON shapes below are a contract rather than an
 * implementation detail.
 *
 * TWO ERRANDS.
 *
 *   `_action=targets`  — which handlists may receive this kind of
 *                        thing. Answers `{ ok, targets: [{ id, name,
 *                        total, alreadyIn }] }`, the list the picker
 *                        draws; `alreadyIn` counts the members named
 *                        in the optional `memberIds` that the handlist
 *                        already holds, so the menu can say where the
 *                        record already is. Only
 *                        handlists this person can WRITE to and whose
 *                        type matches (or is not yet fixed) come back,
 *                        because a menu that offers a handlist and
 *                        then errors on submit is the failure the type
 *                        rule exists to prevent. Reachable by GET or
 *                        POST; the picker fetches it.
 *
 *   the default        — put these members in a handlist. Either
 *                        `handlistId` (an existing one) or `newName`
 *                        (make one and fill it), never both, plus
 *                        `recordType` and a JSON array of `memberIds`.
 *
 * WHAT COMES BACK. Success is `{ ok: true, id, name, added, alreadyIn,
 * total, warn }` — every field the confirmation needs, because a
 * handlist never confirms with a bare "Added": it states the resulting
 * count, and says how many were already in when a bulk add overlapped.
 * `warn` is true past the soft ceiling, and the add still landed.
 *
 * REFUSALS ARE MACHINE CODES, NOT PROSE. `{ ok: false, error: <code> }`
 * with the matching HTTP status, so the picker renders the sentence in
 * the reader's own language from the handlists namespace rather than
 * displaying a server string that is always English. The codes are
 * `type-mismatch`, `ceiling`, `duplicate-name`, `not-found`,
 * `forbidden` and `name-required`; anything else is re-thrown, because
 * an unrecognised failure is not something to paper over with a
 * friendly message.
 *
 * @version v0.7.0
 */
import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.handlists.add";

/** The vocabulary the search tabs and the handlist type share. */
const RECORD_TYPES = ["records", "entities", "places"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

/** Every refusal the picker knows how to phrase. */
type AddErrorCode =
  | "type-mismatch"
  | "ceiling"
  | "duplicate-name"
  | "not-found"
  | "forbidden"
  | "name-required";

function readRecordType(value: FormDataEntryValue | null): RecordType | null {
  return typeof value === "string" &&
    (RECORD_TYPES as readonly string[]).includes(value)
    ? (value as RecordType)
    : null;
}

/**
 * The ids arrive JSON-encoded rather than as repeated fields: a
 * select-all can carry thousands of them, and one parse is cheaper to
 * reason about than a `getAll` whose ordering is the browser's
 * business. Anything that is not an array of strings is simply empty.
 */
function readMemberIds(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

function fail(error: AddErrorCode, status: number) {
  return Response.json({ ok: false as const, error }, { status });
}

/**
 * Translate a refusal thrown by `handlists.server` into the code the
 * picker phrases. The server states its reasons in prose on purpose —
 * it has no locale — so the mapping reads the status plus the one
 * detail that tells two 400s apart.
 */
function codeFor(err: Response, context: "add" | "create"): AddErrorCode | null {
  if (err.status === 403) return "forbidden";
  if (err.status === 404) return "not-found";
  if (err.status === 409) return "duplicate-name";
  if (err.status !== 400) return null;
  // The two 400s a picker can actually provoke: the ceiling and a
  // mismatched type. A create that reached here already has a name, so
  // `name-required` is caught before the call rather than after it.
  return context === "create" ? "ceiling" : "type-mismatch";
}

/**
 * GET is the targets errand only. Anything else is a 405 rather than a
 * silent empty list — a picker asking the wrong way should find out.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("_action") !== "targets") {
    return Response.json({ ok: false as const, error: "not-found" }, { status: 405 });
  }
  const recordType = readRecordType(url.searchParams.get("recordType"));
  if (recordType === null) return fail("type-mismatch", 400);
  return listTargets(
    context,
    recordType,
    readMemberIds(url.searchParams.get("memberIds")),
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("_action");

  const recordType = readRecordType(formData.get("recordType"));
  if (recordType === null) return fail("type-mismatch", 400);

  if (intent === "targets") {
    return listTargets(
      context,
      recordType,
      readMemberIds(formData.get("memberIds")),
    );
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { addMembers, createHandlist } = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const memberIds = readMemberIds(formData.get("memberIds"));
  const handlistId = (formData.get("handlistId") as string) || "";
  const newName = ((formData.get("newName") as string) || "").trim();

  // A handlist is named at creation — an "Untitled" handlist is one
  // nobody reopens — so an empty name is refused here rather than
  // travelling to the server to be refused there.
  if (!handlistId && !newName) return fail("name-required", 400);

  try {
    const result = handlistId
      ? await addMembers(db, tenant, user, handlistId, { recordType, memberIds })
      : await createHandlist(db, tenant, user, {
          name: newName,
          recordType,
          memberIds,
        });

    // The name is what the confirmation says the members are now in,
    // and the create path is the only one that already knows it.
    const name = handlistId
      ? await readName(context, result.id)
      : newName;

    return Response.json({
      ok: true as const,
      id: result.id,
      name,
      added: result.added,
      alreadyIn: result.alreadyIn,
      total: result.total,
      warn: result.warn,
    });
  } catch (err) {
    if (err instanceof Response) {
      const code = codeFor(err, handlistId ? "add" : "create");
      if (code) return fail(code, err.status);
    }
    throw err;
  }
}

/**
 * The add menu's list, for one kind of thing. When the picker names
 * the members it is about to add, every row also reports how many of
 * them it already holds — the menu says so before the add rather than
 * after it.
 */
async function listTargets(
  context: Route.LoaderArgs["context"],
  recordType: RecordType,
  memberIds: string[],
) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { listAddTargets } = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const rows = await listAddTargets(db, tenant, user, recordType, memberIds);
  return Response.json({
    ok: true as const,
    targets: rows.map((row) => ({
      id: row.id,
      name: row.name,
      total: row.memberCount,
      alreadyIn: row.alreadyIn,
    })),
  });
}

/**
 * The handlist's name after an add. `addMembers` reports counts rather
 * than the row, and the confirmation names the handlist, so one small
 * read closes the gap — under the same visibility rule, because the
 * add already passed it.
 */
async function readName(
  context: Route.ActionArgs["context"],
  handlistId: string,
): Promise<string> {
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { handlists } = await import("~/db/schema");

  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);
  const row = await db
    .select({ name: handlists.name })
    .from(handlists)
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)))
    .get();
  return row?.name ?? "";
}
