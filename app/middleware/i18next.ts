import { initReactI18next } from "react-i18next";
import { createI18nextMiddleware } from "remix-i18next/middleware";
import resources from "~/locales";

export const [i18nextMiddleware, getLocale, getInstance] =
  createI18nextMiddleware({
    detection: {
      supportedLanguages: ["es", "en"],
      fallbackLanguage: "es",
    },
    i18next: {
      resources,
      defaultNS: "common",
    },
    plugins: [initReactI18next],
  });
