/**
 * Spanish translations — no_access namespace
 *
 * This locale namespace carries the Spanish strings for the
 * "access pending" landing — the page a freshly registered user
 * lands on when none of the five role flags has been turned on yet.
 * It exists so that users hitting an unassigned account see a helpful
 * message instead of a bare 403.
 *
 * @version v0.3.0
 */
export default {
  title: "Acceso pendiente",
  description:
    "Tu cuenta está registrada pero aún no se le ha asignado un rol. Un administrador debe otorgarte acceso. Por favor, vuelve más tarde o contacta al administrador de tu proyecto.",
} as const;
