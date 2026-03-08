import { Form } from "react-router";
import type { User } from "../../context";

interface TopBarProps {
  user: User;
  appName: string;
}

export function TopBar({ user, appName }: TopBarProps) {
  return (
    <header className="fixed top-0 right-0 left-0 z-50 border-b border-stone-200 bg-white">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-stone-900">{appName}</span>
          {/* Breadcrumb area -- populated by child routes in future */}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-stone-500">{user.email}</span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-700"
            >
              Log out
            </button>
          </Form>
        </div>
      </div>
    </header>
  );
}
