import { Form, Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { User } from "../../context";

interface TopBarProps {
  user: User;
  appName: string;
}

export function TopBar({ user, appName }: TopBarProps) {
  const { t } = useTranslation("dashboard");
  const { t: tCommon } = useTranslation("common");

  return (
    <header className="fixed top-0 right-0 left-0 z-50 border-b border-[#E7E5E4] bg-white">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <Link to="/dashboard" className="flex items-center gap-3 no-underline">
          <img src="/pomegranate.svg" alt="" className="h-8 w-8" aria-hidden="true" />
          <div className="h-6 border-l border-[#E7E5E4]" aria-hidden="true" />
          <span className="font-sans text-[0.875rem] text-[#78716C]">
            Zasqua: <strong className="font-semibold">{tCommon("app_name")}</strong>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <span className="font-sans text-[0.875rem] text-[#78716C]">{user.email}</span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-[0.875rem] font-medium text-[#8B2942] hover:underline"
            >
              {t("nav.log_out")}
            </button>
          </Form>
        </div>
      </div>
    </header>
  );
}
