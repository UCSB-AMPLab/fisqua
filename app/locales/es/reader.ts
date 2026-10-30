/**
 * Spanish translations — reader namespace
 *
 * This locale namespace carries the Spanish strings for the Reader's
 * pages under `/records`: the published records list a Reader lands
 * on, and one published record with its contents. Level names,
 * field labels and pagination come from the `descriptions_admin` and
 * `common` namespaces, as on the admin pages.
 *
 * @version v0.8.0
 */
export default {
  records_title: "Registros",
  records_intro: "Los registros publicados de este espacio de trabajo.",
  records_empty_title: "Aún no hay registros publicados",
  records_empty_body: "Los registros aparecerán aquí cuando se publiquen.",
  contents_heading: "Contenido",
  contents_count_one: "{{count}} registro publicado",
  contents_count_other: "{{count}} registros publicados",
} as const;

// @version v0.8.0
