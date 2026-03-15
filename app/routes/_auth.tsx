import { Outlet, useLocation } from "react-router";
import { userContext } from "../context";
import { TopBar } from "../components/layout/top-bar";
import { Footer } from "../components/layout/footer";
import type { Route } from "./+types/_auth";

export const middleware = [
  async (args: any, next: any) => {
    const { authMiddleware } = await import("../middleware/auth.server");
    return authMiddleware(args, next);
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { getAppConfig } = await import("../lib/config.server");
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);
  return { user, appName };
}

export default function AuthLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const isViewer = location.pathname.includes("/viewer/");
  const isDescriptionEditor = location.pathname.includes("/describe/");
  const showChrome = !isViewer && !isDescriptionEditor;

  return (
    <div className={showChrome ? "flex min-h-screen flex-col" : ""}>
      {showChrome && (
        <TopBar user={loaderData.user} appName={loaderData.appName} />
      )}
      <main className={showChrome ? "flex-1 pt-12" : ""}>
        <Outlet />
      </main>
      {showChrome && <Footer />}
    </div>
  );
}
