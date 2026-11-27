/**
 * English translations — emails namespace
 *
 * This module deals with the English strings for outbound mail: the digest
 * the 15-minute sweep assembles for each due recipient, the sign-in link,
 * the two project invitations (one for a person who has no account yet,
 * one for a user added to a project), and the notice to an operator that a
 * workspace's stored scanner keys were erased. They are kept in their own
 * namespace because email copy is rendered server-side, against a language
 * chosen for the recipient (`app/lib/email-locale.server.ts`) rather than
 * the page's, and because the surface namespaces assume page chrome around
 * them that an email does not have.
 *
 * The digest speaks the decisions surface's language: pending
 * decisions are "questions", and the three groups mirror the three
 * Tier-1 events (a question you raised was ruled; new comments on a
 * thread you took part in; new proposals awaiting your ruling).
 *
 * @version v0.9.0
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

  // Sign-in link. The fifteen-minute expiry is enforced by the
  // magic_links table; the text states it and nothing more.
  magicLinkSubject: "Your {{appName}} login link",
  magicLinkIntro: "Click the link below to log in to {{appName}}:",
  magicLinkAction: "Log in to {{appName}}",
  magicLinkExpiry:
    "This link expires in 15 minutes. If you did not request this, you can safely ignore this email.",

  // Invitation for a person who has no account yet: accepting it also
  // signs them in. The seven-day expiry is enforced by project_invites.
  // {{projectName}} arrives already escaped and wrapped in <strong>.
  newUserInviteSubject:
    "{{inviterName}} invited you to {{projectName}} on {{appName}}",
  newUserInviteBody:
    "{{inviterName}} has invited you to join the project {{projectName}} on {{appName}}.",
  newUserInviteInstruction:
    "Click the link below to accept the invitation and log in:",
  newUserInviteAction: "Accept invitation",
  newUserInviteExpiry: "This link expires in 7 days.",

  // Notice to an existing user who was added to a project.
  existingUserInviteSubject: "You were added to {{projectName}} on {{appName}}",
  existingUserInviteBody:
    "{{inviterName}} has added you to the project {{projectName}} on {{appName}}.",
  existingUserInviteAction: "Go to project",

  // Notice to an operator that a workspace's scanner keys must be revoked
  // in Backblaze B2: its stored keys were erased, or its unit was reported
  // lost, stolen or compromised while Fisqua held no stored copy. Either
  // way the keys listed still work in B2 until the operator revokes them
  // there; each pair is an upload key and a read key. {{name}} arrives
  // already escaped and wrapped in <code>.
  keysErasedSubject: "Revoke the scanner keys of {{workspace}} in Backblaze B2",
  keysErasedBody:
    "{{appName}} has erased its copy of the scanner keys of the workspace {{workspace}} ({{slug}}).",
  keysErasedInstruction:
    "Revoke every key listed below in Backblaze B2. {{appName}} erased only its own copy, so the keys work until you revoke them there:",
  keysNotStoredBody:
    "A unit of the workspace {{workspace}} ({{slug}}) was reported lost, stolen or compromised. {{appName}} held no stored copy of its scanner keys, so it erased nothing.",
  keysNotStoredInstruction:
    "Revoke every key listed below in Backblaze B2. The keys work until you revoke them there:",
  keysErasedWriteKey: "Upload key: {{name}}",
  keysErasedReadKey: "Read key: {{name}}",
  keysErasedPairing: "No unit can be paired with this workspace until new keys are stored for it.",
} as const;

// @version v0.9.0
