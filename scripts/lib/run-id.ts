/**
 * Scripts — naming an operator command's run
 *
 * This module deals with the name an operator command gives one run,
 * which its report, its SQL file and any folder of files it writes all
 * carry. A stamp to the second alone is not enough: two runs started in
 * the same second would write the same SQL file, and the one that
 * applies it last would run the other's statements. So the run id is
 * the stamp followed by eight hex characters of a random id.
 *
 *   - `stampOf` is the clock in UTC, to the second, as the reports print
 *     it (`20261109T120000Z`);
 *   - `runIdOf` adds the random part (`20261109T120000Z-3f9c2a1b`); the
 *     caller passes the id, so a command's injected `newId` provider
 *     decides it.
 *
 * @version v0.9.0
 */

/** The clock in UTC, to the second. */
export function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** A run's id: its stamp and eight hex characters of `randomId`. */
export function runIdOf(now: number, randomId: string): string {
  const suffix = randomId.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8);
  if (suffix.length < 8) throw new Error(`A run id needs eight hex characters, and ${JSON.stringify(randomId)} has fewer`);
  return `${stampOf(now)}-${suffix}`;
}

// @version v0.9.0
