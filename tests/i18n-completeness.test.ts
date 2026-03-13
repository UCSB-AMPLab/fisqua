import { describe, it, expect } from "vitest";

describe("translation completeness", () => {
  it.todo("every key in es namespace files has a corresponding en key");
  it.todo("every key in en namespace files has a corresponding es key");
  it.todo("no translation value is an empty string");
  it.todo(
    "all 9 namespaces are present in both locales: common, auth, dashboard, viewer, workflow, admin, project, description, comments"
  );
});
