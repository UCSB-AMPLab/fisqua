/**
 * Spanish translations — decisions namespace
 *
 * Strings for the Pending decisions surface (Decisiones pendientes):
 * chrome and tab bar, the authority-proposal queue with its rulings,
 * the duplicates toggle, and the ruling feedback lines. Colombian
 * Spanish, tú-form, composed from meaning rather than translated
 * phrase-by-phrase; type labels and "Nombre para ordenar" follow the
 * entities module's established terminology.
 *
 * @version v0.7.0
 */
export default {
  // Surface chrome
  surfaceName: "Decisiones pendientes",
  surfaceIntro:
    "Preguntas que este espacio de trabajo aún no ha resuelto: registros de autoridad propuestos por una importación, registros que podrían ser el mismo y términos de vocabulario en espera de revisión.",

  // Tabs
  tabProposals: "Propuestas",
  tabDuplicates: "Posibles duplicados",
  tabVocabulary: "Vocabulario",

  // Proposals — status filter
  filterOpen: "Abiertas",
  filterRuled: "Resueltas",
  countOpen_one: "{{count}} propuesta abierta",
  countOpen_other: "{{count}} propuestas abiertas",
  countRuled_one: "{{count}} propuesta resuelta en esta página",
  countRuled_other: "{{count}} propuestas resueltas en esta página",

  // Proposals — empty states
  emptyOpenHeading: "Nada en espera",
  emptyOpenBody:
    "No hay propuestas abiertas. Las importaciones y las cargas masivas dejan aquí los nombres que no logran resolver por su cuenta.",
  emptyRuledHeading: "Aún no hay decisiones",
  emptyRuledBody:
    "Las propuestas que aceptes, modifiques o rechaces aparecerán aquí.",

  // Proposals — card body
  sortNameLabel: "Nombre para ordenar",

  // Proposal types
  typePerson: "Persona",
  typeFamily: "Familia",
  typeCorporate: "Entidad corporativa",
  typePlace: "Lugar",
  typeTopic: "Tema",

  // Proposals — card anatomy: object, then the ask panel ("Acción
  // sugerida" eyebrow over the recommendation), the comment thread,
  // and the options row
  inTheIndexAs: "En el índice figura como",
  suggestedActionEyebrow: "Acción sugerida",
  recommendCreate: "Crear un registro de {{type}}",
  recommendLink: "Vincular con un registro existente",
  recommendTopic: "Ninguna — es una materia, no un nombre; no hay nada que crear",
  recommendUndetermined: "Ninguna — esta requiere tu criterio",
  commentsHeading: "Comentarios",
  optCreate: "Crear registro",
  optConfirmTopic: "Confirmar como materia",
  optNoCreate: "No crear",
  reviewAndDecide: "Revisar y decidir",
  optNoRecord: "Descartar",

  // Evidencia y vínculos. Cuando la propuesta salió de un registro, lo
  // nombra: la tarjeta dice qué se vincularía al aceptar y la página de
  // detalle lista las descripciones donde aparece el encabezado. Cuando
  // salió solo del encabezado, lo dice en vez de callar. El bloque
  // externo es informativo hasta que confirmes una coincidencia: las
  // candidatas del proceso nunca se registran por su cuenta.
  mentionCount_one: "Se menciona en {{count}} registro",
  mentionCount_other: "Se menciona en {{count}} registros",
  classifiedFromHeading:
    "Clasificado solo a partir del encabezado; no se propone vínculo con ningún registro.",
  wouldLinkAs: "Se vincularía como {{role}} a {{ref}}",
  evidenceHeading: "Registros que mencionan este encabezado",
  evidenceRelatedHeading: "Registros que mencionan términos relacionados",
  evidenceSeeAll: "Ver todos en la búsqueda",
  linkRoleLabel: "Vincular como",
  skipLinkLabel: "No crear este vínculo",
  externalHeading: "Coincidencias externas",
  externalNone: "No registrar ninguna coincidencia",
  externalConfirmHint: "La coincidencia seleccionada se registra al aceptar.",
  linkCreated: "Vinculado a {{ref}} como {{role}}.",

  // Comment attribution pills
  pillSystem: "Sistema",
  pill_admin: "Admin",
  pill_lead: "Líder",
  pill_reviewer: "Revisor",
  pill_cataloguer: "Catalogador",
  quoteSource: "Citado del catálogo de este espacio de trabajo",

  // Proposals — ruling controls
  cancel: "Cancelar",
  amendTypeLabel: "Tipo de registro",
  amendNameLabel: "Nombre",
  amendSortNameLabel: "Nombre para ordenar",
  amendSortNamePlaceholder:
    "Forma para ordenar (si se deja vacía, se usa el nombre)",
  rejectReasonPlaceholder: "Por qué no debería crearse",

  // Proposals — ruled rows
  ruledAccepted: "Aceptada",
  ruledAmended: "Modificada",
  ruledRejected: "Rechazada",
  ruledOn: "Resuelta el {{date}}",
  ruledResult: "Registro creado",

  // Proposals — feedback
  feedbackAccepted: "Propuesta aceptada.",
  feedbackAmended: "Propuesta modificada y aceptada.",
  feedbackRejected: "Propuesta rechazada.",
  errorConflict: "Esta propuesta ya fue resuelta.",
  errorInvalid:
    "No se pudo guardar la decisión. Revisa el nombre e intenta de nuevo.",
  errorGeneric: "La decisión no se guardó.",

  // Detail page — the considered lane
  backToQueue: "Volver a decisiones pendientes",
  recordToCreate: "Registro por crear",

  detailPlaceType: "Tipo de lugar",
  detailPlaceTypeNone: "Sin especificar",
  detailVariants: "Variantes del nombre",
  detailVariantsPlaceholder: "Una grafía por línea",
  detailInternalNote: "Nota interna",
  detailInternalNotePlaceholder: "Se conserva en el registro, después de la línea de procedencia",
  detailEditorHint:
    "Las coordenadas, los identificadores externos, las fechas y todo lo demás pueden agregarse en el editor del registro una vez que este exista.",
  detailCreatedHeading: "Registro creado",
  detailTopicHeading: "Registrado como tema",
  detailRejectedHeading: "Propuesta rechazada",
  detailAlreadyRuled: "Esta pregunta ya fue resuelta.",
  viewRecord: "Ver registro",

  addComment: "Agregar un comentario",
  addCommentPlaceholder: "Para quien consulte esta decisión más adelante",
  postComment: "Publicar comentario",

  // Acciones sobre comentarios: editar es solo del autor, eliminar es
  // del autor o de un admin, y el botón de eliminar pide un segundo
  // clic de confirmación en vez de abrir un diálogo — eliminar un
  // comentario no es una decisión.
  commentEdit: "Editar",
  commentDelete: "Eliminar",
  commentDeleteArmed: "¿Eliminar?",
  commentEdited: "Editado",
  commentSave: "Guardar",
  commentError: "El comentario no se guardó.",
  commentDeleteError: "El comentario no se eliminó.",

  optAcceptRecommendation: "Aceptar recomendación",
  optDismiss: "Descartar",
  dismissModalTitle: "¿Descartar la propuesta para {{name}}?",
  // States the consequence plainly, without softening it.
  dismissModalBody:
    "No se creará nada. La pregunta queda cerrada y se conserva en la lista de resueltas, con tu nombre y la fecha de hoy.",
  dismissConfirm: "Descartar propuesta",
  rejectReasonLabel: "Motivo (opcional)",

  // Pagination
  previous: "Anterior",
  next: "Siguiente",
  pageOf: "Página {{page}}",

  // Duplicates tab
  dupTypeEntities: "Entidades",
  dupTypePlaces: "Lugares",
  dupDismissedNote:
    "Los pares que marcaste como registros distintos no vuelven a aparecer en esta lista.",

  // Tarjeta de par duplicado. El escaneo pregunta — nunca recomienda
  // sobre identidad — así que el panel usa la ceja de pregunta, no
  // "Acción sugerida". La línea de carga separa la evidencia (prosa de
  // procedencia) de la consecuencia (cuántas descripciones dependen de
  // la forma).
  askQuestionEyebrow: "La pregunta",
  pairLoad_one: "{{formattedCount}} descripción nombra esta forma",
  pairLoad_other: "{{formattedCount}} descripciones nombran esta forma",
  pairLoadNone: "Aún no hay descripciones asociadas",
  lookCloser: "Ver en detalle",
  keepBoth: "Conservar ambos",
  mergeIntoOne: "Fusionar en un solo registro",

  // Tarjeta de término de vocabulario: dos paneles para leer las dos
  // formas lado a lado; la línea de carga lleva el uso por entidades,
  // la consecuencia de fusionar un término.
  vocabIncomingLabel: "En espera de revisión",
  vocabExistingLabel: "Ya está en el vocabulario",
  vocabLoad_one: "{{formattedCount}} entidad usa esta forma",
  vocabLoad_other: "{{formattedCount}} entidades usan esta forma",
  vocabLoadNone: "Ninguna entidad usa esta forma todavía",
  keepOwnTerm: "Conservar como término propio",
  mergeIntoExisting: "Fusionar con el término existente",

  // Página de colación del par
  collationFieldLabel: "Campo",

  // Confirmación de fusión: la dirección se elige AQUÍ, y las
  // etiquetas de destino cambian con la selección para que el
  // resultado de ambos registros se lea antes de confirmar. El texto
  // nunca sugiere que se pueda deshacer.
  mergeDirectionLabel: "Qué registro sobrevive",
  mergeSurvives: "Sobrevive",
  mergeRetired: "Retirado",
  mergeModalBody:
    "Un registro sobrevive y conserva su código. El otro se retira: su forma de nombre queda como variante en el registro que sobrevive, y todas las descripciones que le apuntaban se trasladan a este. Esto no se puede deshacer.",
  mergeConfirm: "Fusionar registros",

  // Contexto y preguntas de la tarjeta de par. La pregunta nombra lo
  // que los dos registros tendrían que ser para que la fusión sea
  // correcta; si los dos lados difieren de tipo, la forma genérica
  // pregunta por el registro.
  pairContext: "Dos registros responden a este nombre",
  pairQuestion_person: "¿Son la misma persona?",
  pairQuestion_family: "¿Son la misma familia?",
  pairQuestion_corporate: "¿Son la misma entidad corporativa?",
  pairQuestion_place: "¿Son el mismo lugar?",
  pairQuestion_generic: "¿Son el mismo registro?",

  // Líneas de dirección: una consecuencia mecánica en el tono más
  // discreto de la tarjeta, nunca una recomendación. La forma desigual
  // lleva el código del sobreviviente en mono mediante un span <0>.
  dirEven:
    "Ninguno de los dos registros tiene descripciones: tú eliges qué código sobrevive.",
  dirUneven_one:
    "Fusionar conservaría <0>{{code}}</0>: {{formattedCount}} descripción apunta a él.",
  dirUneven_other:
    "Fusionar conservaría <0>{{code}}</0>: {{formattedCount}} descripciones apuntan a él.",

  // Conservar ambos: la confirmación en tono neutro. Definitiva, no
  // destructiva: nada se fusiona, la pregunta se cierra.
  keepBothModalTitle: "¿Conservar ambos registros de {{name}}?",
  keepBothModalBody:
    "Los dos registros quedan tal como están y nada se fusiona. La pregunta se cierra y queda en la lista de resueltas: se puede consultar, no revertir.",
  whyDifferent_person: "Por qué son personas distintas",
  whyDifferent_family: "Por qué son familias distintas",
  whyDifferent_corporate: "Por qué son entidades distintas",
  whyDifferent_place: "Por qué son lugares distintos",
  whyDifferent_generic: "Por qué son registros distintos",

  // Fusión: título del diálogo y textos guía del motivo por tipo.
  mergeModalTitle: "¿Fusionar los dos registros de {{name}}?",
  whySame_person: "Por qué son la misma persona",
  whySame_family: "Por qué son la misma familia",
  whySame_corporate: "Por qué son la misma entidad",
  whySame_place: "Por qué son el mismo lugar",
  whySame_generic: "Por qué son el mismo registro",

  // Filas de pares resueltos
  ruledPairMerged: "Fusionados: sobrevivió {{code}}",
  ruledPairKeptBoth: "Se conservaron ambos",

  // Procedencia ausente en el panel y mensajes del par
  pairProvNone: "Sin procedencia registrada.",
  pairErrorConflict: "Este par ya fue resuelto.",
  feedbackPairMerged: "Registros fusionados.",
  feedbackPairKeptBoth: "Se conservaron ambos registros.",

  // Tarjetas de términos cercanos del vocabulario. La procedencia es
  // deliberadamente sobria: el estado es el dato que importa, y las
  // cifras llevan el peso.
  vocabContext: "Término de materia en espera de revisión",
  vocabIncomingProv: "Propuesto para el vocabulario; aún sin aprobar.",
  vocabExistingProv: "Aprobado como término de materia.",
  vocabSuggestedMerge: 'Fusionar con "{{term}}"',
  vocabDirection: "La fusión conserva {{term}}, la forma aprobada.",
  vocabKeepModalTitle: '¿Conservar "{{term}}" como término propio?',
  vocabKeepModalBody:
    "El término se aprueba y entra al vocabulario como forma propia, junto al término existente.",
  whyOwnTerm: "Por qué es una materia aparte",
  vocabMergeModalTitle: "¿Fusionar las dos formas de esta materia?",
  vocabMergeModalBody:
    "Una forma sobrevive como el término de materia. La otra se retira: todas las entidades clasificadas con ella pasan a la forma que sobrevive. Esto no se puede deshacer.",
  whySameSubject: "Por qué son la misma materia",
} as const;
