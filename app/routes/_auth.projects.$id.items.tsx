import { redirect } from "react-router";
import type { Route } from "./+types/_auth.projects.$id.items";

export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/projects/${params.id}/volumes`);
}

export default function ProjectItems() {
  return null;
}
