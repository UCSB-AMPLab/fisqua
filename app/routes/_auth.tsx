import { Outlet } from "react-router";
import { authMiddleware } from "../middleware/auth.server";
import { userContext } from "../context";
import { getAppConfig } from "../lib/config.server";
import { TopBar } from "../components/layout/top-bar";
import type { Route } from "./+types/_auth";

export const middleware = [authMiddleware];

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);
  return { user, appName };
}

export default function AuthLayout({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <TopBar user={loaderData.user} appName={loaderData.appName} />
      <main className="pt-12">
        <Outlet />
      </main>
    </>
  );
}
