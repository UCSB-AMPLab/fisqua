/**
 * Tests — the reviewed entity merge list's command refuses to apply
 *
 * This suite pins that the command for the reviewed entity merge list
 * refuses to apply. No entity record is merged without evidence on any
 * path, and the rows of the reviewed merge list
 * (`scripts/commands/entity-merges.ts`) carry none. The command therefore
 * refuses `--apply` before it reads the list or the target, naming
 * `merge-entity` rows of an authorities file as the way to merge. The
 * suite runs the command with a list path that does not exist: the apply
 * is refused with that message, which shows that nothing was read, so
 * nothing was written either; the dry run passes the refusal
 * (`refuseApply`). Nothing here reaches D1.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { APPLY_REFUSED, main, refuseApply } from "../../scripts/commands/entity-merges";

const MISSING = "/nonexistent/entity-merges-final.csv";
const base = ["--target", "staging", "--tenant", "neogranadina", "--list", MISSING];

describe("entity-merges --apply", () => {
  it("is refused before anything is read or written, naming merge-entity rows with facts and evidence_codes", async () => {
    await expect(main([...base, "--apply"])).rejects.toThrow(APPLY_REFUSED);
    expect(APPLY_REFUSED).toMatch(/merge-entity rows in an authorities file/);
    expect(APPLY_REFUSED).toMatch(/facts and evidence_codes/);
    // Production, with its confirmation, is refused the same way.
    await expect(main(["--target", "production", "--tenant", "neogranadina", "--list", MISSING, "--apply", "--confirm-production"]))
      .rejects.toThrow(APPLY_REFUSED);
  });

  it("lets the dry run through", () => {
    expect(() => refuseApply({ apply: false })).not.toThrow();
    expect(() => refuseApply({ apply: true })).toThrow(APPLY_REFUSED);
  });
});

// @version v0.9.0
