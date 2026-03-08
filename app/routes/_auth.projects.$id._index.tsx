import { redirect } from "react-router";
import type { Route } from "./+types/_auth.projects.$id._index";

export function loader({ params }: Route.LoaderArgs) {
  // Redirect to settings by default
  throw redirect(`/projects/${params.id}/settings`);
}
