/**
 * Spanish translations — settings namespace
 *
 * This locale namespace carries the Spanish strings for the
 * per-user account-settings page — the profile form (name, email),
 * the save affordance, and the language picker. Language labels are
 * deliberately rendered in their own language ("Español", "English")
 * rather than translated.
 *
 * @version v0.3.0
 */
export default {
  title: "Configuración",
  profile: "Perfil",
  name: "Nombre",
  email: "Correo electrónico",
  save: "Guardar cambios",
  saved: "Cambios guardados",
  language: "Idioma",
  language_es: "Español",
  language_en: "English",
  connected_accounts: "Cuentas conectadas",
  github_connected: "Conectado",
  github_not_connected: "No conectado",
  github_connect: "Conectar",

  // Notificaciones: la preferencia de frecuencia que lee el barrido.
  // "Desactivado" concuerda con "el resumen".
  notifications: "Notificaciones",
  notificationsHint:
    "Un resumen por correo de la actividad en tus decisiones pendientes: preguntas tuyas resueltas, comentarios nuevos y propuestas nuevas.",
  freqLegend: "Frecuencia del resumen",
  freq_15min: "Cada 15 minutos",
  freq_hourly: "Cada hora",
  freq_daily: "Una vez al día",
  freq_weekly: "Una vez a la semana",
  freq_off: "Desactivado",
} as const;
