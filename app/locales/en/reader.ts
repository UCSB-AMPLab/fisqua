/**
 * English translations — reader namespace
 *
 * This locale namespace carries the English strings for the Reader's
 * pages under `/records`: the published records list a Reader lands
 * on, and one published record with its contents. Level names,
 * field labels and pagination come from the `descriptions_admin` and
 * `common` namespaces, as on the admin pages.
 *
 * @version v0.8.0
 */
export default {
  records_title: "Records",
  records_intro: "The published records in this workspace.",
  records_empty_title: "No published records yet",
  records_empty_body: "Records appear here once they are published.",
  contents_heading: "Contents",
  contents_count_one: "{{count}} published record",
  contents_count_other: "{{count}} published records",
} as const;

// @version v0.8.0
