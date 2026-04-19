/**
 * Vocabularies Hub Layout
 *
 * Parent route for the vocabularies admin subsection. Renders the
 * secondary navigation between Enums, Functions, and Review, loads
 * the shared counts panel, and routes each child page into the
 * shared layout.
 *
 * @version v0.3.0
 */

import { Outlet } from "react-router";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.admin.vocabularies";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  requireAdmin(user);

  return { user };
}

export default function AdminVocabulariesLayout() {
  return <Outlet />;
}
