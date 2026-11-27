/**
 * Spanish translations — emails namespace
 *
 * This module deals with the Spanish strings for outbound mail: the
 * coalesced digest the sweep sends to each due recipient, the sign-in
 * link, the two project invitations, and the notice to an operator that a
 * workspace's stored scanner keys were erased. Colombian Spanish, tú-form,
 * composed from meaning rather than translated phrase by phrase. The
 * digest keeps the decisions surface's vocabulary: the pending items are
 * "preguntas", and "planteaste" covers both a filed proposal and a
 * duplicate question a colleague opened.
 *
 * @version v0.9.0
 */
export default {
  digestSubject_one: "{{count}} novedad en {{appName}}",
  digestSubject_other: "{{count}} novedades en {{appName}}",
  intro: "Esto es lo que ha pasado desde tu último resumen.",
  ruledHeading_one: "Se resolvió {{count}} pregunta que planteaste",
  ruledHeading_other: "Se resolvieron {{count}} preguntas que planteaste",
  commentHeading_one:
    "Hay comentarios nuevos en {{count}} pregunta en la que participaste",
  commentHeading_other:
    "Hay comentarios nuevos en {{count}} preguntas en las que participaste",
  filedHeading_one: "{{count}} propuesta nueva espera tu decisión",
  filedHeading_other: "{{count}} propuestas nuevas esperan tu decisión",
  manageLine:
    "Puedes cambiar la frecuencia de estos resúmenes, o desactivarlos, en la configuración de tu cuenta.",
  accountLinkLabel: "Configuración de la cuenta",
  // Colofón del pie: atribución, no navegación — sin enlace, un paso por
  // debajo de la línea de preferencias. Nombres institucionales en sus
  // formas verificadas ("Santa Bárbara" lleva tilde en texto en español).
  colophon:
    "Fisqua es un proyecto de Neogranadina y el Laboratorio de Archivos, Memoria y Preservación (AMPL) de la Universidad de California, Santa Bárbara.",

  // El plazo de quince minutos lo fija la tabla magic_links; el texto
  // solo lo anuncia.
  magicLinkSubject: "Tu enlace de acceso a {{appName}}",
  magicLinkIntro: "Haz clic en el siguiente enlace para iniciar sesión en {{appName}}:",
  magicLinkAction: "Iniciar sesión en {{appName}}",
  magicLinkExpiry:
    "Este enlace vence en 15 minutos. Si no lo pediste, puedes ignorar este correo sin problema.",

  // Invitación para quien aún no tiene cuenta: al aceptarla, la persona
  // también inicia sesión. El plazo de siete días lo fija la tabla
  // project_invites. {{projectName}} llega ya escapado y dentro de
  // <strong>.
  newUserInviteSubject: "{{inviterName}} te invitó al proyecto {{projectName}} en {{appName}}",
  newUserInviteBody:
    "{{inviterName}} te invitó a unirte al proyecto {{projectName}} en {{appName}}.",
  newUserInviteInstruction:
    "Haz clic en el siguiente enlace para aceptar la invitación e iniciar sesión:",
  newUserInviteAction: "Aceptar invitación",
  newUserInviteExpiry: "Este enlace vence en 7 días.",

  // Aviso para quien ya tiene cuenta cuando alguien lo agrega a un
  // proyecto.
  existingUserInviteSubject: "Te agregaron al proyecto {{projectName}} en {{appName}}",
  existingUserInviteBody:
    "{{inviterName}} te agregó al proyecto {{projectName}} en {{appName}}.",
  existingUserInviteAction: "Ir al proyecto",

  // Aviso a un operador de que hay que revocar en Backblaze B2 las claves
  // del escáner de un espacio de trabajo: se borraron las claves
  // guardadas, o se informó que un equipo Captua se perdió, lo robaron o
  // alguien sin autorización pudo acceder a él cuando Fisqua no guardaba
  // ninguna copia. En los dos
  // casos, las claves de la lista siguen activas en B2 hasta que el
  // operador las revoque allí; cada par es una clave de carga y una de
  // lectura. {{name}} llega ya escapado y dentro de <code>.
  keysErasedSubject: "Revoca en Backblaze B2 las claves del escáner de {{workspace}}",
  keysErasedBody:
    "{{appName}} borró la copia que guardaba de las claves del escáner del espacio de trabajo {{workspace}} ({{slug}}).",
  keysErasedInstruction:
    "Revoca en Backblaze B2 todas las claves de esta lista. {{appName}} solo borró su propia copia, así que las claves siguen activas hasta que las revoques allí:",
  keysNotStoredBody:
    "Se informó que un equipo Captua del espacio de trabajo {{workspace}} ({{slug}}) se perdió, lo robaron o alguien sin autorización pudo acceder a él. {{appName}} no guardaba ninguna copia de las claves del escáner, así que no borró nada.",
  keysNotStoredInstruction:
    "Revoca en Backblaze B2 todas las claves de esta lista. Las claves siguen activas hasta que las revoques allí:",
  keysErasedWriteKey: "Clave de carga: {{name}}",
  keysErasedReadKey: "Clave de lectura: {{name}}",
  keysErasedPairing:
    "No se podrá vincular ningún equipo Captua con este espacio de trabajo hasta que se guarden claves nuevas.",
} as const;

// @version v0.9.0
