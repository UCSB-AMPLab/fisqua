/**
 * Spanish translations — emails namespace
 *
 * Strings for outbound notification mail: the coalesced digest the
 * sweep sends to each due recipient. Colombian Spanish, tú-form,
 * composed from meaning rather than translated phrase by phrase. The
 * digest keeps the decisions surface's vocabulary: the pending items
 * are "preguntas", and "planteaste" covers both a filed proposal and
 * a duplicate question a colleague opened.
 *
 * @version v0.7.0
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
} as const;
