/**
 * English translations — no_access namespace
 *
 * This locale namespace carries the English strings for the
 * "access pending" landing — the page a freshly registered user lands
 * on when none of the five role flags has been turned on yet. It
 * exists so that users hitting an unassigned account see a helpful
 * message instead of a bare 403.
 *
 * @version v0.3.0
 */
export default {
  title: "Access pending",
  description:
    "Your account is registered but no role has been assigned yet. An administrator needs to grant you access. Please check back later or contact your project administrator.",
} as const;
