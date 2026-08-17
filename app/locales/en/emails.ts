/**
 * English translations — emails namespace
 *
 * Strings for outbound notification mail: the digest the 15-minute
 * sweep assembles for each due recipient. Kept in its own namespace
 * because email copy is rendered server-side (outside any request,
 * from the cron) against the recipient's stored locale, and because
 * the surface namespaces assume page chrome around them that an email
 * does not have.
 *
 * The digest speaks the decisions surface's language: pending
 * decisions are "questions", and the three groups mirror the three
 * Tier-1 events (a question you raised was ruled; new comments on a
 * thread you took part in; new proposals awaiting your ruling).
 *
 * @version v0.7.0
 */
export default {
  digestSubject_one: "{{count}} update in {{appName}}",
  digestSubject_other: "{{count}} updates in {{appName}}",
  intro: "Here is what has happened since your last summary.",
  ruledHeading_one: "{{count}} question you raised was ruled",
  ruledHeading_other: "{{count}} questions you raised were ruled",
  commentHeading_one: "New comments on {{count}} question you have taken part in",
  commentHeading_other:
    "New comments on {{count}} questions you have taken part in",
  filedHeading_one: "{{count}} new proposal awaits your ruling",
  filedHeading_other: "{{count}} new proposals await your ruling",
  manageLine:
    "You can change how often you receive these summaries, or turn them off, in your account settings.",
  accountLinkLabel: "Account settings",
  // Footer colophon: attribution, not navigation — rendered unlinked, a
  // step below the manage line. Institutional names in their verified
  // forms; never re-expand or restyle them here.
  colophon:
    "Fisqua is a project of Neogranadina and the Archives, Memory, and Preservation Lab (AMPL) at UC Santa Barbara.",
} as const;
