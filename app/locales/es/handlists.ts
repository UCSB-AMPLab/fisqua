/**
 * Spanish translations — handlists namespace
 *
 * The Spanish mirror of the handlists namespace. The feature is
 * «listas de trabajo» — ruled, and a translation of the sense rather
 * than of the word: a bare «lista» loses the working-document meaning
 * that carries the snapshot rule, while «inventario» and «catálogo»
 * both name something more formal and more permanent. Once the context
 * has been set the strings shorten to «lista», the way buttons are
 * allowed to shorten and warnings are not.
 *
 * COUNT LINES ARE COMPOSED, NEVER ASSEMBLED. Each kind of thing gets
 * its own whole sentence — «1 registro se exportará», «3 entidades se
 * exportarán» — because the article and any participle agree with the
 * noun, and a sentence built from fragments would be wrong for half
 * the nouns it meets.
 *
 * Colombian usage throughout: «agregar» rather than «añadir», tú-form
 * («elige», «marca», «inténtalo»), no voseo. User content — a
 * handlist's name, a record's title, a reference code — is never
 * translated; it appears exactly as its owner typed it.
 *
 * @version v0.7.0
 */
export default {
  // ── La superficie ────────────────────────────────────────────────
  title: "Listas de trabajo",
  intro:
    "Una lista de trabajo es un conjunto de registros que guardas. Ármala desde una búsqueda o agrega registros a medida que los encuentres: una lista sobrevive a la búsqueda que la creó, así que es el alcance al que conviene recurrir cuando el mismo conjunto se va a exportar más de una vez.",
  newHandlist: "Nueva lista de trabajo",

  // ── Pestañas del índice ──────────────────────────────────────────
  tabMine: "Mías",
  tabShared: "Compartidas conmigo",
  tabAll: "Todas",

  // ── Tabla del índice ─────────────────────────────────────────────
  colHandlist: "Lista de trabajo",
  colHolds: "Contiene",
  colOwner: "Propietario",
  colUpdated: "Actualizada",
  open: "Abrir",
  export: "Exportar",
  ownerYou: "Tú",
  sharedWith_one: "Compartida con 1",
  sharedWith_other: "Compartida con {{count}}",
  workspaceVisibleBadge: "Todo el espacio",

  holdsRecords: "registros",
  holdsEntities: "entidades",
  holdsPlaces: "lugares",
  holdsEmpty: "vacía",

  // ── La fila que quedó bloqueada ──────────────────────────────────
  lockedLabel: "No puedes abrirla",
  reasonAuthoritiesAdminOnly:
    "Solo los administradores del espacio de trabajo pueden abrir una lista de registros de autoridad.",

  // ── Estados vacíos ───────────────────────────────────────────────
  emptyMineHeading: "Todavía no tienes listas de trabajo",
  emptyMineBody:
    "Marca resultados en la página de búsqueda y elige «Agregar a una lista de trabajo», o agrega un registro a una lista desde su propia página mientras navegas.",
  emptySharedHeading: "Nadie ha compartido una lista contigo",
  emptySharedBody:
    "Cuando alguien comparta una lista de trabajo contigo, aparecerá aquí con el nombre de quien la compartió.",
  emptyAllHeading: "Todavía no hay listas de trabajo",
  emptyAllBody:
    "Marca resultados en la página de búsqueda y elige «Agregar a una lista de trabajo», o agrega un registro a una lista desde su propia página mientras navegas.",
  emptyMembersHeading: "Esta lista todavía está vacía",
  emptyMembersBody:
    "Marca resultados en la página de búsqueda y elige «Agregar a una lista de trabajo», o agrega un registro desde su propia página mientras navegas. Lo primero que agregues fija lo que contiene esta lista.",

  // ── La página de la lista ────────────────────────────────────────
  ownYours: "es tuya",
  sharedBy: "compartida por {{name}}",
  savedAt: "guardada {{date}}",
  updatedAt: "actualizada {{date}}",
  rename: "Cambiar el nombre",
  share: "Compartir",
  delete: "Eliminar",
  exportHandlist: "Exportar esta lista",
  roleViewOnly: "Solo lectura",
  roleCanEdit: "Puede editar",

  metaHeld_records_one: "{{count}} registro",
  metaHeld_records_other: "{{count}} registros",
  metaHeld_entities_one: "{{count}} entidad",
  metaHeld_entities_other: "{{count}} entidades",
  metaHeld_places_one: "{{count}} lugar",
  metaHeld_places_other: "{{count}} lugares",
  metaHeldEmpty: "Todavía sin miembros",

  metaWillExport_records_one: "{{count}} registro se exportará",
  metaWillExport_records_other: "{{count}} registros se exportarán",
  metaWillExport_entities_one: "{{count}} entidad se exportará",
  metaWillExport_entities_other: "{{count}} entidades se exportarán",
  metaWillExport_places_one: "{{count}} lugar se exportará",
  metaWillExport_places_other: "{{count}} lugares se exportarán",

  metaNeedsReview_one: "{{count}} necesita revisión",
  metaNeedsReview_other: "{{count}} necesitan revisión",
  metaMissing_one: "{{count}} ya no existe",
  metaMissing_other: "{{count}} ya no existen",

  // ── El aviso de deriva ───────────────────────────────────────────
  driftLead_one: "Un miembro cambió bajo esta lista.",
  driftLead_other: "{{count}} miembros cambiaron bajo esta lista.",
  driftExport_one:
    "Exportar ahora deja por fuera un miembro, así que saldrían {{exportable}} de {{total}}.",
  driftExport_other:
    "Exportar ahora deja por fuera {{count}} miembros, así que saldrían {{exportable}} de {{total}}.",
  driftReview_one: "Revísalo",
  driftReview_other: "Revisa los {{count}}",

  // ── Notas de integridad por fila ─────────────────────────────────
  noteMerged: "Siguió una fusión",
  noteCollapsed_one: "Siguió una fusión — se plegó 1 fila duplicada",
  noteCollapsed_other: "Siguió una fusión — se plegaron {{count}} filas duplicadas",
  noteSplit: "Se dividió en dos registros — elige cuál pertenece aquí",
  noteMissing: "Ya no está en el espacio de trabajo — no se cuenta ni se exporta",
  acknowledge: "Aceptar el cambio",
  keepBoth: "Conservar ambos",
  keepOnly: "Solo {{name}}",
  keepOnlyUntitled: "Solo el original",
  removeFromHandlist: "Quitar de la lista",
  dragHandle: "Arrastra para reordenar",
  footDragHint: "arrastra para reordenar; el orden se conserva al exportar",
  footExportHint: "{{exportable}} se exportarán · {{excluded}} quedan por fuera",

  // ── La otra entrada a la búsqueda dentro de la lista ─────────────
  // Escribir aquí lleva a la superficie de búsqueda con la etiqueta de
  // la lista ya puesta, en vez de hacer una búsqueda aparte dentro de
  // esta página: una sola faceta, dos entradas. El conteo es el de la
  // lista, así que el marcador de posición dice en qué conjunto se va
  // a buscar, con una frase completa por tipo.
  searchWithin_records_one: "Busca en este registro…",
  searchWithin_records_other: "Busca en estos {{count}} registros…",
  searchWithin_entities_one: "Busca en esta entidad…",
  searchWithin_entities_other: "Busca en estas {{count}} entidades…",
  searchWithin_places_one: "Busca en este lugar…",
  searchWithin_places_other: "Busca en estos {{count}} lugares…",

  // ── La exportación espera a la revisión ──────────────────────────
  exportBlockedWhy:
    "La exportación espera a la revisión. Una lista con miembros pendientes de una decisión los dejaría por fuera sin avisar, así que la acción vuelve cuando resuelvas cada fila.",

  // ── Crear ────────────────────────────────────────────────────────
  provenance: "Listas de trabajo",
  createTitle: "Nueva lista de trabajo",
  createBody:
    "Una lista de trabajo conserva el conjunto que le pongas y sobrevive a la búsqueda que lo armó. Ponle un nombre para que la reconozcas después.",
  createAside:
    "Lo primero que agregues fija lo que contiene esta lista —registros, entidades o lugares— y eso no se puede cambiar después.",
  createConfirm: "Crear lista de trabajo",
  nameLabel: "Nombre (obligatorio)",
  namePlaceholder: "Ponle nombre a esta lista",
  cancel: "Cancelar",

  // ── Cambiar el nombre ────────────────────────────────────────────
  renameTitle: "Cambiar el nombre de la lista",
  renameConfirm: "Guardar",
  renameUnaffected: "sin cambios",

  // ── Eliminar ─────────────────────────────────────────────────────
  deleteTitle: "¿Eliminar «{{name}}»?",
  deleteBody:
    "La lista y su orden se pierden para siempre. Esto no se puede deshacer.",
  deleteKeepLead: "No se afecta ningún registro.",
  deleteKeepBody_one:
    "El único miembro se queda exactamente donde está en el espacio de trabajo: una lista solo lo señala. No se quita nada de ninguna colección y ninguna descripción cambia.",
  deleteKeepBody_other:
    "Los {{count}} miembros se quedan exactamente donde están en el espacio de trabajo: una lista solo los señala. No se quita nada de ninguna colección y ninguna descripción cambia.",
  deleteLossLead: "Lo que pierdes:",
  deleteLoss_one:
    "el nombre, el lugar que le diste a su único miembro y esta lista como alcance de exportación.",
  deleteLoss_other:
    "el nombre, el orden que elegiste para los {{count}} miembros y esta lista como alcance de exportación.",
  deleteSharedNote_one: "Compartida con 1 persona. Dejará de verla.",
  deleteSharedNote_other: "Compartida con {{count}} personas. Dejarán de verla.",
  deleteConfirm: "Eliminar lista de trabajo",

  // ── Compartir ────────────────────────────────────────────────────
  shareTitle: "Compartir «{{name}}»",
  shareBody:
    "Las personas con quienes la compartas pueden leer esta lista y abrir sus miembros.",
  shareAddLabel: "Agregar a alguien",
  shareOwner: "Propietario",
  shareRoleViewer: "Solo lectura",
  shareRoleEditor: "Puede editar",
  shareKeepLead: "Compartir no otorga nada más.",
  shareKeepBody_one:
    "No da acceso a ningún módulo ni cambia los formatos de exportación que se le ofrecen a cada persona: eso depende de su propio rol. Tampoco esconde nada: todas las personas con quienes la compartas ven el único miembro que contiene esta lista.",
  shareKeepBody_other:
    "No da acceso a ningún módulo ni cambia los formatos de exportación que se le ofrecen a cada persona: eso depende de su propio rol. Tampoco esconde nada: todas las personas con quienes la compartas ven los {{count}} miembros.",
  shareAside:
    "Solo tú puedes cambiarle el nombre, compartirla y eliminarla. Quien tenga permiso de edición puede agregar, quitar y reordenar sus miembros.",
  shareIneligible: "No se puede compartir",
  shareNobody: "Todavía no hay más personas en este espacio de trabajo.",
  shareDone: "Listo",

  workspaceVisibleLabel: "Visible para todo el espacio de trabajo",
  workspaceVisibleHint:
    "Cualquier persona de este espacio de trabajo puede encontrarla y leerla, sin que la nombres aquí.",

  // ── Negativas, dichas donde se tomó la decisión ──────────────────
  errorNameRequired: "La lista necesita un nombre.",
  errorDuplicateName:
    "Ya tienes una lista de trabajo llamada «{{name}}». Los nombres deben ser distintos para poder diferenciar las exportaciones en el historial.",
  errorCeiling:
    "Una lista de trabajo admite máximo {{max}} miembros. Exporta una rama o todo el espacio de trabajo en su lugar.",
  errorIneligibleShare:
    "Esa persona no puede abrir esta lista, así que no se la puedes compartir.",
  errorForbidden: "No puedes hacer eso en esta lista.",
  errorNotFound: "Esa lista de trabajo ya no está aquí.",
  errorGeneric: "Eso no se pudo completar. Inténtalo de nuevo.",
  warnCeiling_one:
    "Esta lista ya tiene {{count}} miembro. Pasados unos pocos miles, una rama o todo el espacio de trabajo es mejor alcance que una lista.",
  warnCeiling_other:
    "Esta lista ya tiene {{count}} miembros. Pasados unos pocos miles, una rama o todo el espacio de trabajo es mejor alcance que una lista.",

  // ── Sin acceso ───────────────────────────────────────────────────
  noAccessTitle: "No puedes abrir esta lista de trabajo",

  // ── El selector de listas (lo consumen búsqueda y las fichas) ────
  pickerSaveTitle: "Agregar a una lista de trabajo",
  pickerAddTitle: "Agregar a una lista de trabajo",
  pickerNewOption: "Nueva lista de trabajo…",
  pickerNameLabel: "Nombre (obligatorio)",
  pickerNamePlaceholder: "Ponle nombre a esta lista",
  pickerAdd: "Agregar",
  pickerCreateAndAdd: "Crear y agregar",
  pickerCancel: "Cancelar",
  pickerEmpty: "Todavía no tienes listas de este tipo. Crea una para empezar.",
  pickerResult_one: "Ahora hay 1 en {{name}}",
  pickerResult_other: "Ahora hay {{count}} en {{name}}",
  pickerAlreadyIn_one: "1 ya estaba",
  pickerAlreadyIn_other: "{{count}} ya estaban",
  // La pertenencia, dicha antes de agregar y no después: en la fila
  // que ya contiene el registro, y en el botón mismo, que dice dónde
  // está el registro en vez de solo ofrecer guardarlo.
  pickerHoldsThis: "Ya está aquí",
  inHandlists_one: "En 1 lista de trabajo",
  inHandlists_other: "En {{count}} listas de trabajo",
  pickerErrorTypeMismatch: "Esa lista contiene otro tipo de cosas.",
  pickerErrorCeiling:
    "Eso llevaría la lista más allá de {{max}} miembros. Exporta una rama o todo el espacio de trabajo en su lugar.",
  pickerErrorDuplicateName:
    "Ya tienes una lista con ese nombre. Los nombres deben ser distintos para poder diferenciar las exportaciones en el historial.",
  pickerErrorNameRequired: "La lista necesita un nombre.",
} as const;
