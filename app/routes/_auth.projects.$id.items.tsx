import { redirect } from "react-router";

export function loader({ params }: { params: { id: string } }) {
  throw redirect(`/projects/${params.id}/volumes`);
}

export default function ProjectItems() {
  return null;
}
