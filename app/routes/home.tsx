import { userContext } from "../context";
import type { Route } from "./+types/home";

export function meta() {
  return [
    { title: "Dashboard" },
    {
      name: "description",
      content: "Project dashboard",
    },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  return { user };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-xl font-semibold text-stone-900">
        Welcome, {loaderData.user.name || loaderData.user.email}
      </h1>
      <p className="mt-2 text-sm text-stone-500">
        Your projects will appear here.
      </p>
    </div>
  );
}
