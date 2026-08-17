/**
 * English translations — settings namespace
 *
 * This locale namespace carries the English strings for the
 * per-user account-settings page — the profile form (name, email),
 * the save affordance, and the language picker. Language labels are
 * deliberately rendered in their own language ("Español", "English")
 * rather than translated.
 *
 * @version v0.3.0
 */
export default {
  title: "Settings",
  profile: "Profile",
  name: "Name",
  email: "Email address",
  save: "Save changes",
  saved: "Changes saved",
  language: "Language",
  language_es: "Español",
  language_en: "English",
  connected_accounts: "Connected accounts",
  github_connected: "Connected",
  github_not_connected: "Not connected",
  github_connect: "Connect",

  // Notifications: the digest-frequency preference the sweep reads.
  notifications: "Notifications",
  notificationsHint:
    "An email summary of activity on your pending decisions: rulings on questions you raised, new comments, new proposals.",
  freqLegend: "Summary frequency",
  freq_15min: "Every 15 minutes",
  freq_hourly: "Hourly",
  freq_daily: "Daily",
  freq_weekly: "Weekly",
  freq_off: "Off",
} as const;
