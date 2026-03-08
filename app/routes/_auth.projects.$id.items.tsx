import type { Route } from "./+types/_auth.projects.$id.items";

export default function ProjectItems({ params }: Route.ComponentProps) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-8 text-center">
      <h2 className="text-lg font-semibold text-stone-900">
        Domain Features
      </h2>
      <p className="mt-2 text-sm text-stone-600">
        This is where you add your domain-specific features. Replace this page
        with your own content — for example, a list of items, documents, or
        records belonging to this project.
      </p>
      <p className="mt-4 text-xs text-stone-400">
        See TEMPLATE.md for guidance on extending this route.
      </p>
    </div>
  );
}
