import type { ResourceLanguage } from "i18next";
import common from "./es/common";
import auth from "./es/auth";
import dashboard from "./es/dashboard";
import viewer from "./es/viewer";
import workflow from "./es/workflow";
import admin from "./es/admin";
import project from "./es/project";
import description from "./es/description";
import comments from "./es/comments";

export default {
  common,
  auth,
  dashboard,
  viewer,
  workflow,
  admin,
  project,
  description,
  comments,
} satisfies ResourceLanguage;
