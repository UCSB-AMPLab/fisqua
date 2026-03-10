import { Outlet, useLocation } from "react-router";
import { authMiddleware } from "../middleware/auth.server";
import { userContext } from "../context";
import { getAppConfig } from "../lib/config.server";
import { TopBar } from "../components/layout/top-bar";
import { Footer } from "../components/layout/footer";
import type { Route } from "./+types/_auth";

export const middleware = [authMiddleware];

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);
  return { user, appName };
}

export default function AuthLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const isViewer = location.pathname.includes("/viewer/");

  return (
    <div className={isViewer ? "" : "flex min-h-screen flex-col"}>
      <TopBar user={loaderData.user} appName={loaderData.appName} />
      <main className="pt-12 flex-1">
        <Outlet />
      </main>
      {!isViewer && <Footer />}
    </div>
  );
}
