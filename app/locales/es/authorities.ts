/**
 * Spanish translations — authorities namespace
 *
 * This module deals with the Latin American / Colombian Spanish strings
 * for the authorities module's full-page merge and split workbenches, the
 * ledger-derived status band, and the list bulk-merge toolbar. Terminology
 * follows the existing `entities`/`places` namespaces: fusionar (merge),
 * dividir (split), vínculos (links).
 *
 * @version v0.9.0
 */
export default {
  // Merge workbench — page head
  mergeEyebrowEntities: "Autoridades · Entidades",
  mergeEyebrowPlaces: "Autoridades · Lugares",
  mergeHeading: "Fusionar registro de autoridad",
  mergeIntro:
    "Fusiona un registro duplicado con el registro que se conserva. Los vínculos con descripciones pasan al registro que se conserva, y el duplicado queda como redirección.",

  // Merge — record pair
  mergeThisRecord: "Este registro · se fusionará",
  mergeSurvivor: "Registro que se conserva",
  mergeSwapDirection: "invertir el sentido",
  mergeSelectSurvivor: "Selecciona el registro que se conserva para comparar",

  // Merge — survivor typeahead
  mergeSearchPlaceholder: "Busca el registro que se conserva…",
  mergeSearchLinks: "{{count}} vínculos",

  // Merge — comparison table
  mergeColField: "Campo",
  mergeColThis: "Este registro",
  mergeColSurvivor: "Se conserva",

  // Merge — linked descriptions
  mergeLinksHeading: "Descripciones vinculadas",
  mergeLinksShowing:
    "Se muestran {{shown}} de {{total}} · todas pasan al registro que se conserva salvo que las desmarques",
  mergeLinksWarning:
    "{{count}} descripciones se quedarán en este registro. Conservan la redirección anterior y no aparecerán bajo el registro que se conserva.",
  mergeDestSurvivor: "Se conserva",
  mergeDestStays: "Se queda",
  mergeLoadMore: "Cargar {{count}} descripciones más",

  // Linked-description context cards (both merge sides + split)
  ctxSurvivorHeading: "Descripciones vinculadas del registro que se conserva",
  ctxSurvivorKept: "Estas permanecen en el registro que se conserva.",
  ctxMergedHeading: "Descripciones vinculadas de este registro",
  ctxShowing: "Se muestran {{shown}} de {{cards}} · {{links}} vínculos",
  ctxAndMore: "… y {{count}} más",
  ctxNoLinks: "No hay descripciones vinculadas.",
  ctxAsRecorded: "tal como se registró:",
  ctxSourceOcr: "Texto OCR",

  // Merge — fold names
  mergeFoldNames:
    "Agregar el nombre (o nombres) de este registro a las variantes del registro que se conserva",
  mergeFoldNamesHelper:
    "Desactivado por defecto. Al activarlo, el nombre preferido y las variantes de este registro se agregan al registro que se conserva.",

  // Merge — bottom bar
  reasonLabel: "Motivo",
  reasonRequired: "· obligatorio",
  reasonOptional: "· opcional",
  reasonPlaceholder: "¿Por qué se hace esto? (queda registrado en el historial)",
  mergeSummary: "{{moved}} vínculos pasan · {{stay}} se quedan",
  mergeConfirm: "Fusionar con {{name}}",
  mergeConfirmGeneric: "Fusionar registro",

  // Fusión rechazada porque el cambio de una relación duplicaría un vínculo
  mergeErrorRelationCollision:
    "No se fusionó nada. Si se hiciera la fusión, {{entity}} tendría dos vínculos con {{description}} como {{role}}, y los dos apuntarían al mismo lado de una relación.",

  // Merge — conflict state
  conflictTitle: "Este registro cambió desde que lo abriste",
  conflictBody:
    "Se editó el {{time}}. Vuelve a cargar para ver la versión actual, o fusiona de todos modos con lo que tienes.",
  conflictReload: "Volver a cargar",
  conflictProceed: "Fusionar de todos modos",
  conflictProceedSplit: "Dividir de todos modos",

  // Split workbench — page head
  splitHeading: "Dividir registro de autoridad",
  splitIntro:
    "Divide un registro que mezcla varios en el original y un registro nuevo. Asigna cada campo y luego reparte las descripciones vinculadas.",

  // Split — record banner
  splitBeingSplit: "Dividiendo este registro",
  splitLinkedCount: "{{count}} descripciones vinculadas",

  // Split — assignment table
  splitColField: "Campo",
  splitColGoesTo: "Va a — Original · Ambos · Registro nuevo",
  splitOriginal: "Original",
  splitBoth: "Ambos",
  splitNew: "Registro nuevo",
  splitUnassigned: "Sin asignar",
  splitNameOriginal: "Nombre del registro original",
  splitNameNew: "Nombre del registro nuevo",
  splitNamesIdentical:
    "Los dos nombres son idénticos: el registro nuevo necesita un nombre distinto.",

  // Split — divide descriptions
  splitDivideHeading: "Repartir las descripciones vinculadas",
  splitDivideNote: "Las descripciones marcadas pasan al registro nuevo",
  splitDestNew: "Registro nuevo",
  splitDestOriginal: "Original",

  // Split — bottom bar
  splitConfirm: "Dividir registro",
  splitSummaryOriginal: "El original conserva {{summary}}",
  splitSummaryNew: "El registro nuevo recibe {{summary}}",
  splitBlockerUnassigned: "Hay {{count}} campos sin asignar.",
  splitBlockerNames: "El registro nuevo necesita un nombre distinto al del original.",
  splitBlockerReason: "Agrega un motivo para poder confirmar.",
  splitDescriptionsUnit: "{{count}} descripciones",

  // Status band
  bandMerged: "Fusionado con {{survivor}} el {{date}} por {{user}}",
  bandSplit: "Dividido en {{records}} el {{date}} por {{user}}",
  bandSplitFrom: "Dividido a partir de {{parent}} el {{date}} por {{user}}",
  bandViewSurvivor: "Ver registro que se conserva",
  bandViewRecords: "Ver registros",
  bandOpenLedger: "Abrir entrada del historial",
  bandRedirectedCount: "0 (redirigidas)",
  bandUnknownUser: "un usuario desconocido",

  // Bulk-merge toolbar (list surfaces)
  bulkSelected: "{{count}} seleccionados",
  // Cada frase de conteo se escribe completa por tipo: el participio
  // concuerda con el sustantivo, así que "{{count}} entidades
  // seleccionadas" y "{{count}} lugares seleccionados" no salen del
  // mismo molde.
  bulkCountRecords_one: "{{count}} registro seleccionado",
  bulkCountRecords_other: "{{count}} registros seleccionados",
  bulkCountEntities_one: "{{count}} entidad seleccionada",
  bulkCountEntities_other: "{{count}} entidades seleccionadas",
  bulkCountPlaces_one: "{{count}} lugar seleccionado",
  bulkCountPlaces_other: "{{count}} lugares seleccionados",
  bulkClear: "Quitar selección",
  bulkMerge: "Fusionar…",
  bulkHintPickTwo: "Selecciona exactamente dos registros para fusionar.",
  bulkAddToHandlist: "Agregar a una lista de trabajo",
  bulkSendToExport: "Exportar la selección",
  bulkSelectRow: "Seleccionar este registro",

  // Show-merged toggle + merged row indicator
  showMerged: "Mostrar fusionados",
  mergedPill: "fusionado",
  mergedArrow: "→ {{survivor}}",

  // Generic errors
  errorReasonRequired: "El motivo es obligatorio.",
  errorSurvivorRequired: "Selecciona el registro que se conserva.",
  errorNamesIdentical: "Los dos registros necesitan nombres distintos.",
  errorUnassigned: "Debes asignar cada campo antes de dividir.",
  errorGeneric: "Algo salió mal. Inténtalo de nuevo.",
  // Possible-duplicates worklist
  dupHeading: "Posibles duplicados",
  dupIntro:
    "Revisa los pares de posibles duplicados: fusiona los que de verdad lo son o descarta las coincidencias falsas con un motivo que queda en el historial.",
  dupCountLine_one: "par candidato",
  dupCountLine_other: "pares candidatos · ordenados de mayor a menor coincidencia",
  dupSignalName: "nombre normalizado",
  dupSignalNearName: "escritura parecida",
  dupNearSpellingHint:
    "Los dos nombres normalizados se diferencian en un solo carácter.",
  dupSignalDates: "fechas que se superponen",
  dupSignalWikidata: "Wikidata compartido",
  dupSignalTgn: "TGN de Getty compartido",
  dupNotDuplicate: "No es un duplicado",
  dupCompareMerge: "Comparar y fusionar",
  dupModalTitle: "Marcar como no duplicado",
  dupModalBody:
    "Deja constancia de que {{a}} y {{b}} son registros distintos. Este par no volverá a aparecer en esta lista.",
  dupModalCancel: "Cancelar",
  dupDismissedBanner:
    "El par se marcó como “No es un duplicado” y la decisión quedó en el historial. No volverá a aparecer en la lista a menos que los registros cambien.",
  dupEmptyHeading: "No hay candidatos a duplicados",
  dupEmptyBody:
    "Todos los pares señalados se fusionaron o se descartaron. Los nuevos candidatos aparecerán aquí a medida que se agreguen o editen registros.",
  dupLinksMeta: "{{count}} vínculos",

  // Operation history
  histHeading: "Historial de operaciones",
  histBackToRecord: "Volver al registro",
  histEmpty: "No hay operaciones registradas para este registro.",
  histMergedInto: "Fusionado con {{name}}",
  histMergedFrom: "Se fusionó {{name}} con este registro",
  histSplitInto: "Dividido en {{name}}",
  histSplitFrom: "Dividido a partir de {{name}}",
  histSeparate: "Marcado como no duplicado de {{name}}",
  histDeleted: "Registro eliminado",
  histResolved: "Procedencia de creación registrada",
  histUnknownRecord: "un registro desconocido",
  histDetailMoved: "{{count}} vínculos reasignados",
  histDetailDropped: "{{count}} vínculos en conflicto registrados",
  histDetailLeft: "{{count}} vínculos se quedaron",
  dupShowing: "Se muestran {{shown}} de {{total}}",
  dupTabEntities: "Entidades",
  dupTabPlaces: "Lugares",
  histShowingLatest: "Se muestran las {{shown}} operaciones más recientes de {{total}}",

  // Lista de trabajo de descripciones vinculadas (rediseño de la página de detalle)
  wlSearchPlaceholder: "Buscar títulos y códigos…",
  wlAll: "Todas",
  wlShowing: "Mostrando {{shown}} de {{total}} descripciones vinculadas",
  wlSortAria: "Ordenar",
  wlSortDate: "Fecha (más recientes primero)",
  wlSortTitle: "Título",
  wlSortCode: "Código de referencia",
  wlSizeAria: "Resultados por página",
  wlPrev: "Anterior",
  wlNext: "Siguiente",
  wlPage: "Página {{page}} de {{pages}}",
  wlNoMatches: "Ninguna descripción vinculada coincide con los filtros actuales.",
  // Tarjeta de contexto que se despliega al hacer clic
  wlToggleCard: "Mostrar u ocultar los detalles de la descripción vinculada",
  wlCardLoading: "Cargando detalles…",
  wlCardError: "No se pudieron cargar estos detalles.",
  // Etiquetas de los grupos de filtros (ronda 3)
  wlFilterByRole: "Filtrar por rol:",
  wlFilterByRepo: "Filtrar por repositorio:",
  // Fragmento desplegable: origen, ampliación y navegación entre coincidencias
  wlSnippetScope: "Alcance y contenido",
  wlSnippetScopeHead: "(sin coincidencia del nombre; se muestra el inicio)",
  wlSnippetOcr: "Texto OCR",
  wlShowMore: "Ver más",
  wlShowLess: "Ver menos",
  wlShowAll: "Ver todo",
  // Solo aparece cuando hay más de una coincidencia, nunca "1 coincidencia".
  wlMatchCount: "{{count}} coincidencias",
  wlPrevMatch: "Coincidencia anterior",
  wlNextMatch: "Coincidencia siguiente",
  wlOcrWindowCaption:
    "Fragmento de una transcripción de {{kb}} KB; el texto completo está en la descripción.",
  wlOcrWideCaption: "Fragmento más amplio (limitado), incluido en la tarjeta.",
  wlOcrFullCaption: "Transcripción completa ({{kb}} KB), cargada al momento.",
  wlOcrLoading: "Cargando la transcripción…",

  // Evidencia para fusionar dos registros de entidad: un hecho y las
  // descripciones que lo muestran. Un nombre compartido nunca es evidencia.
  merge_evidence: {
    // By record type, as the pair page asks its question.
    facts_heading: {
      person: "¿Qué muestra que son la misma persona?",
      family: "¿Qué muestra que son la misma familia?",
      corporate: "¿Qué muestra que son la misma entidad corporativa?",
      generic: "¿Qué muestra que son el mismo registro?",
    },
    facts_hint: "Marca al menos uno",
    fact: {
      dates: "Fechas",
      office: "Cargo",
      kin: "Parentesco",
      place: "Lugar",
      matter: "Asunto",
    },
    fact_help: {
      dates: "Fechas que se superponen y son coherentes",
      office: "El mismo cargo, oficio o función",
      kin: "Padres, cónyuge, hijos o miembros en común",
      place: "La misma residencia u origen",
      matter: "El mismo caso, suceso o negocio",
    },
    name_alone: "Un nombre por sí solo no basta",
    descriptions_heading: "¿Qué descripciones lo muestran?",
    descriptions_hint: "Al menos una de cada registro",
    no_descriptions:
      "Este registro no tiene descripciones en este espacio de trabajo. Sin una descripción que citar, estos dos registros no se pueden fusionar.",
    loading: "Cargando las descripciones…",
    note_label: "Nota (opcional)",
    error: {
      evidence_facts: {
        person: "Marca al menos un hecho que muestre que son la misma persona. Un nombre por sí solo no basta.",
        family: "Marca al menos un hecho que muestre que son la misma familia. Un nombre por sí solo no basta.",
        corporate: "Marca al menos un hecho que muestre que son la misma entidad corporativa. Un nombre por sí solo no basta.",
        generic: "Marca al menos un hecho que muestre que son el mismo registro. Un nombre por sí solo no basta.",
      },
      evidence_loser: "Elige al menos una descripción del registro que se fusiona.",
      evidence_survivor: "Elige al menos una descripción del registro que se conserva.",
      evidence_unlinked: "Una de las descripciones que elegiste no está vinculada con su registro. Vuelve a cargar la página y elige de nuevo.",
      evidence_stale: "Una de las descripciones que elegiste se desvinculó de su registro mientras trabajabas. Vuelve a cargar la página y elige de nuevo.",
    },
  },

  // Tarjeta de posibles duplicados: lo que encontró la revisión, en
  // etiquetas. Informan; no son evidencia.
  duplicates: {
    signals_label: "Coincidencias detectadas",
    signal: {
      name: "Mismo nombre",
      nearName: "Escritura parecida",
      dates: "Fechas que se superponen: {{a}} · {{b}}",
      externalId: "Identificador externo compartido",
    },
    facts: {
      label: "Hechos que respaldan este par",
      warningTitle: "Mismo documento.",
      warningBody: "Los dos registros aparecen en el mismo documento. Puede tratarse de dos personas con el mismo nombre, como un padre y su hijo.",
      offices_one: "Cargo",
      offices_other: "Cargos",
      officesLead: "Los dos figuran como",
      associates_one: "Registro asociado",
      associates_other: "Registros asociados",
      associatesLead: "Los dos aparecen junto a",
      documents_one: "Documento",
      documents_other: "Documentos",
      documentsLead: "Los dos aparecen en",
      untitled: "Descripción sin título",
      dates: "Fechas",
      datesBoth: "{{a}} · {{b}}",
      datesOverlap: "Los períodos se superponen.",
      places_one: "Lugar",
      places_other: "Lugares",
      placesLead: "Los dos están vinculados con",
      more: "+{{count}} más",
    },
  },
} as const;

// @version v0.9.0
