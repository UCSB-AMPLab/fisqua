/**
 * Spanish translations — exports namespace
 *
 * Las cadenas de la superficie de exportación: los tres ejes que una
 * persona escoge (qué sale, bajo qué norma descriptiva y en qué
 * formato), el diálogo que acompaña una ejecución, y la bitácora que
 * anota todo lo que ha salido del espacio de trabajo.
 *
 * DOS EJES, DOS PALABRAS. `norma` nombra la norma descriptiva y
 * `formato` el archivo. Juntarlas en «formato» borraría la distinción
 * sobre la que está construida toda la superficie.
 *
 * ALCANCE, NO ÁMBITO. En este espacio `alcance` traduce *scope* — el
 * eje del Qué — por decisión explícita del contrato de cadenas. No hay
 * colisión con «alcance y contenido» porque ese elemento no aparece
 * aquí como etiqueta, solo como nombre de campo en el informe de
 * pérdidas.
 *
 * LAS LÍNEAS CON CIFRAS SE COMPONEN, NO SE ARMAN POR PEDAZOS. Cada
 * frase que lleva un número y una clase de cosa tiene su propia clave
 * por clase, porque el artículo y el participio concuerdan con el
 * sustantivo: «{{n}} entidades encontradas» y «{{n}} lugares
 * encontrados» no salen del mismo molde. Cada clave recibe `count`
 * (para que i18next escoja el plural) y `formatted` (el número ya
 * agrupado con la coma y el punto de es-CO).
 *
 * @version v0.7.0
 */
export default {
  // ── La superficie ────────────────────────────────────────────────
  eyebrow: "Importación y exportación",
  title: "Exportar registros",
  titleAuthority: "Exportar registros de autoridad",
  intro:
    "Escoge qué sale del espacio de trabajo, bajo qué norma descriptiva sale y en qué archivo viaja. Las tres decisiones son independientes: los mismos registros pueden salir bajo cualquier norma que sepa representarlos.",
  introAuthority:
    "El alcance trae su propio tipo, y este contiene entidades, no descripciones archivísticas. Ese solo hecho reordena los dos ejes que lo acompañan: casi ninguna norma descriptiva tiene algo que decir sobre una persona, y un fichero de autoridades no es algo que se pueda codificar como instrumento de descripción.",

  axisWhat: "1 · Qué",
  axisForm: "2 · Norma",
  axisFormat: "3 · Formato",

  // ── Conteos ──────────────────────────────────────────────────────
  countRecords_one: "{{formatted}} registro",
  countRecords_other: "{{formatted}} registros",
  countEntities_one: "{{formatted}} entidad",
  countEntities_other: "{{formatted}} entidades",
  countPlaces_one: "{{formatted}} lugar",
  countPlaces_other: "{{formatted}} lugares",
  countLinks_one: "{{formatted}} enlace a descripciones",
  countLinks_other: "{{formatted}} enlaces a descripciones",
  countSeries_one: "{{formatted}} serie",
  countSeries_other: "{{formatted}} series",
  countCollections_one: "{{formatted}} colección",
  countCollections_other: "{{formatted}} colecciones",
  andTheirLinks: "y sus {{links}}",
  joinOr: "{{head}} o {{tail}}",

  // ── El eje del Qué ───────────────────────────────────────────────
  doorWorkspace: "Todo el espacio de trabajo",
  doorBranch: "Una colección o una rama",
  doorBranchSub:
    "Escoge cualquier nivel de la jerarquía; lo que está debajo se va con él",
  doorCarried: "Una búsqueda o una selección",
  doorCarriedSub:
    "Traída desde la página de búsqueda: una consulta, los registros que marcaste, o ambas cosas",
  doorCarriedSubEmpty: "Todavía no has traído nada",
  doorHandlist: "Una lista de trabajo",
  doorHandlistSub:
    "Una de tus listas de trabajo guardadas, exportable cuantas veces quieras",
  doorHandlistSubAuthority: "Una lista de trabajo tuya, del tipo entidades",

  reasonDoorHoldsRecords:
    "Contiene registros, no registros de autoridad: escoge un alcance de autoridades",
  reasonDoorNotInHierarchy:
    "Los registros de autoridad no están en la jerarquía archivística",

  // ── El selector de rama ──────────────────────────────────────────
  branchFilterPlaceholder: "Filtrar colecciones y series…",
  branchEscHint: "esc",
  branchUse: "Usar esta rama",
  branchChange: "Cambiar",
  branchNothingChosen: "Todavía no has escogido nada.",
  branchChosen: "{{name}} — {{records}} en {{series}} por debajo",
  branchChosenFlat: "{{name}} — {{records}}",
  branchSummary: "{{records}} · {{series}} por debajo",
  branchSummaryFlat: "{{records}}",
  branchMatches_one: "{{count}} coincidencia en {{collections}}",
  branchMatches_other: "{{count}} coincidencias en {{collections}}",
  branchHidden_one: "{{count}} serie sin coincidencias, oculta",
  branchHidden_other: "{{count}} series sin coincidencias, ocultas",
  branchNoMatchHeading: "Ninguna colección o serie coincide con «{{term}}»",
  branchNoMatchBody:
    "Revisa la ortografía, o limpia el filtro para recorrer toda la jerarquía.",
  branchNoMatchCount: "0 coincidencias.",
  branchEmptyHeading: "Este espacio de trabajo todavía no tiene descripciones",
  branchEmptyBody:
    "Una rama es una posición en la jerarquía, así que no hay nada que escoger hasta que se catalogue algo.",

  // ── El alcance traído ────────────────────────────────────────────
  carriedAllMatches: "{{items}} · todas las coincidencias incluidas",
  carriedRunStamp: "búsqueda {{stamp}}",
  carriedFoundRecords: "{{records}} encontrados",
  carriedFoundEntities: "{{entities}} encontradas",
  carriedFoundPlaces: "{{places}} encontrados",
  carriedUnticked: "− {{formatted}} sin marcar",
  carriedWillExport: "{{items}} se exportarán",
  carriedRerun:
    "Vuelve a hacer la búsqueda antes de exportar si los registros cambiaron desde las {{time}}: una consulta es una afirmación sobre el índice en el momento en que se hizo.",
  carriedTickedRecords: "{{records}}, marcados uno por uno",
  carriedTickedEntities: "{{entities}} · marcadas en la pestaña Entidades",
  carriedTickedPlaces: "{{places}} · marcados en la pestaña Lugares",
  carriedNoQuery: "sin consulta",
  carriedNotSaved:
    "Este conjunto no queda guardado. Sirve solo para esta exportación; la fila de la bitácora deja el número, no los registros. Para conservarlo, agrégalo a una lista de trabajo: la lista de trabajo es el alcance guardado, y tiene su propia entrada en este eje.",
  carriedEmptyHeading: "Todavía no has traído ninguna búsqueda ni selección",
  carriedEmptyBody:
    "Arma una en la página de búsqueda y mándala aquí, o escoge una de las búsquedas recientes.",
  carriedRecentLabel: "Búsquedas recientes",
  carriedOpenSearch: "Abrir la página de búsqueda",
  carriedChange: "Cambiar",

  // ── La lista de trabajo ──────────────────────────────────────────
  handlistMeta: "{{records}} · guardada el {{date}}",
  handlistMetaEntities: "{{entities}} · guardada el {{date}}",
  handlistMetaPlaces: "{{places}} · guardada el {{date}}",
  handlistOrderNote:
    "El orden propio de la lista de trabajo se conserva en la exportación. Editarla después no cambia una ejecución ya registrada.",
  handlistTypedEntities:
    "Es una lista de entidades, así que toda ella es una sola clase de cosa, y eso es lo que permite que los dos ejes de al lado se reduzcan con honestidad.",
  handlistTypedPlaces:
    "Es una lista de lugares, así que toda ella es una sola clase de cosa, y eso es lo que permite que los dos ejes de al lado se reduzcan con honestidad.",
  handlistChange: "Cambiar de lista",
  handlistChoose: "Escoge una lista de trabajo",
  handlistEmptyHeading: "Todavía no hay listas de trabajo para exportar",
  handlistEmptyBody:
    "La lista de trabajo es el alcance guardado: arma una desde una búsqueda y vuelve a exportarla cuantas veces necesites.",
  handlistOpen: "Abrir las listas de trabajo",

  // ── Las autoridades ──────────────────────────────────────────────
  toggleTitle: "Incluir las autoridades y sus enlaces",
  toggleSub:
    "Tus entidades y lugares propios, más los compartidos que tus registros citan.",
  toggleOff:
    "Las descripciones siguen nombrando a sus personas y sus lugares. Sin los registros de autoridad, esos nombres llegan como texto plano: sin códigos, sin fechas, sin variantes y sin nada que permita reconocer que dos grafías son la misma persona.",
  toggleNotApplicable:
    "No aplica: el alcance son autoridades. Sus descripciones enlazadas se nombran en el resumen.",

  // ── El eje de la Norma ───────────────────────────────────────────
  formIsadg: "ISAD(G)",
  formDacs: "DACS",
  formRad: "RAD",
  formDc: "Dublin Core",
  formCanonical: "Canónico de Fisqua",
  formOwnSub: "La norma propia de este espacio de trabajo",
  formCrosswalkSub: "Equivalencia entre normas",
  formDcSub: "Equivalencia de quince elementos",
  formDcSubAuthority:
    "Equivalencia de quince elementos · los agentes van como creador y como materia",
  formCanonicalSub: "Va y vuelve por la importación",
  reasonDescriptiveStandardNotAuthority:
    "Describe materiales de archivo, no registros de autoridad",
  eacLabel: "Propuesto · para más adelante",
  eacTitle: "EAC-CPF",
  eacBody:
    "La norma hecha para los registros de autoridad. Mientras no exista aquí como norma, una exportación de autoridades sale en canónico o en Dublin Core.",

  // ── El eje del Formato ───────────────────────────────────────────
  formatCsv: "CSV",
  formatCsvSub: "Filas de hoja de cálculo, una por registro",
  formatCsvSubCanonical:
    "Exporta, edita y vuelve a importar: las mismas columnas que lee el importador",
  formatEad: "EAD XML",
  formatEadSub: "Instrumento de descripción codificado",
  formatJson: "JSON",
  formatJsonSub: "Datos estructurados",
  formatPdf: "PDF",
  formatPdfSub:
    "Instrumento de descripción formateado: se abre listo para imprimir en una pestaña nueva",
  reasonEadNeedsDescriptiveStandard:
    "Solo las normas descriptivas se representan como instrumento de descripción codificado",
  reasonEadNotAuthority:
    "Codifica un instrumento de descripción, que un fichero de autoridades no es",
  reasonPdfNeedsDescriptiveStandard:
    "Un instrumento de descripción necesita una norma descriptiva",

  // ── Lo que cuesta una equivalencia ───────────────────────────────
  lossTitle: "{{form}} no alcanza a llevar todo lo que {{own}} guarda",
  lossDroppedLabel: "Se pierden",
  lossDroppedBody:
    "Ningún elemento de {{form}} lleva {{fields}}. Están escritos en {{own}} y no van a aparecer en el archivo.",
  lossFieldFirst_one: "{{field}} ({{formatted}} registro)",
  lossFieldFirst_other: "{{field}} ({{formatted}} registros)",
  lossField: "{{field}} ({{formatted}})",
  lossMergedLabel: "Se fusionan",
  lossMergedFirst_one:
    "{{fields}} pasan a ser {{into}}. En el {{formatted}} registro que tiene los dos, quedan en un solo párrafo y después no hay cómo distinguirlos.",
  lossMergedFirst_other:
    "{{fields}} pasan a ser {{into}}. En los {{formatted}} registros que tienen los dos, quedan en un solo párrafo y después no hay cómo distinguirlos.",
  lossMergedMore: "{{fields}} se fusionan igual, en {{into}}.",
  lossMergedPair: "{{a}} y {{b}}",
  lossFlattenedLabel: "Se aplana",
  lossFlattenedBody:
    "{{form}} no tiene forma de decir que un registro está dentro de otro. Estos {{records}} están en {{series}} de {{collections}}; llegan como {{plain}} elementos sueltos, y la organización que les da sentido no se puede reconstruir a partir del archivo.",
  lossFooter: "Todo esto sobrevive en la norma propia de este espacio de trabajo.",
  lossEscape: "Exportar en {{standard}} en su lugar",
  lossCompactDropped_one: "{{count}} campo que se pierde",
  lossCompactDropped_other: "{{count}} campos que se pierden",
  lossCompactMerged_one: "{{count}} par fusionado",
  lossCompactMerged_other: "{{count}} pares fusionados",
  lossCompactFlattened: "jerarquía aplanada",

  // Las columnas de descripción que puede nombrar el informe de
  // pérdidas, con la misma clave que el código de columna. En
  // minúscula: todas aparecen dentro de una frase.
  fieldAccessConditions: "condiciones de acceso",
  fieldAcquisitionInfo: "forma de ingreso",
  fieldAdminBiogHistory: "historia institucional o biográfica",
  fieldArrangement: "organización",
  fieldCreatorDisplay: "creador",
  fieldDateCertainty: "certeza de la fecha",
  fieldDateEnd: "fecha final",
  fieldDateExpression: "fecha",
  fieldDateStart: "fecha inicial",
  fieldDescriptionLevel: "nivel de descripción",
  fieldDimensions: "dimensiones",
  fieldEditionStatement: "mención de edición",
  fieldExtent: "volumen y soporte",
  fieldFindingAids: "instrumentos de descripción",
  fieldGenre: "género",
  fieldHasDigital: "disponibilidad digital",
  fieldIiifManifestUrl: "manifiesto IIIF",
  fieldImprint: "pie de imprenta",
  fieldInternalNotes: "notas internas",
  fieldIssueNumber: "número",
  fieldLanguage: "lengua",
  fieldLegacyIds: "identificadores heredados",
  fieldLocalIdentifier: "identificador local",
  fieldLocationOfCopies: "ubicación de las copias",
  fieldLocationOfOriginals: "ubicación de los originales",
  fieldMedium: "soporte",
  fieldNotes: "notas",
  fieldOcrText: "texto transcrito",
  fieldPages: "páginas",
  fieldPhysicalCharacteristics: "características físicas",
  fieldPreferredCitation: "cita recomendada",
  fieldProvenance: "historia custodial",
  fieldPublicationTitle: "título de la publicación",
  fieldReferenceCode: "código de referencia",
  fieldRepositoryId: "repositorio",
  fieldReproductionConditions: "condiciones de reproducción",
  fieldResourceType: "tipo de recurso",
  fieldScopeContent: "alcance y contenido",
  fieldSectionTitle: "título de la sección",
  fieldSeriesStatement: "mención de serie",
  fieldSystemOfArrangement: "sistema de organización",
  fieldTitle: "título",
  fieldTranslatedTitle: "título traducido",
  fieldUniformTitle: "título uniforme",
  fieldVolumeNumber: "número de volumen",

  // ── La barra de confirmación ─────────────────────────────────────
  barSummary: "{{scope}} · {{form}} como {{format}} — {{counts}}",
  barRecorded: "Queda registrado en la bitácora de exportaciones.",
  barRecordedAuthority:
    "Queda registrado en la bitácora de exportaciones. Las descripciones no se incluyen; sus enlaces sí.",
  barNothingChosen: "Escoge qué sale y bajo qué norma.",
  exportAction: "Exportar",

  scopeWorkspace: "Todo el espacio de trabajo",
  scopeSelection: "Una selección",

  // ── El diálogo ───────────────────────────────────────────────────
  dialogProvenance: "Exportación · {{scope}}",
  confirmTitleRecords_one: "¿Exportar {{formatted}} registro?",
  confirmTitleRecords_other: "¿Exportar {{formatted}} registros?",
  confirmTitleEntities_one: "¿Exportar {{formatted}} entidad?",
  confirmTitleEntities_other: "¿Exportar {{formatted}} entidades?",
  confirmTitlePlaces_one: "¿Exportar {{formatted}} lugar?",
  confirmTitlePlaces_other: "¿Exportar {{formatted}} lugares?",
  confirmBody:
    "Fisqua prepara el archivo y anota la ejecución en la bitácora de exportaciones. Nada cambia en el espacio de trabajo.",
  rowScope: "Alcance",
  rowForm: "Norma",
  rowFormat: "Formato",
  rowFormOwn: "la norma propia de este espacio de trabajo",
  rowFormCrosswalk: "convertida desde {{own}}",
  rowFormatCsv: "una fila por registro",
  rowFormatEad: "instrumento de descripción codificado",
  rowFormatJson: "datos estructurados",
  rowFormatPdf: "instrumento de descripción formateado",
  confirmFooterAuthoritiesOn:
    "Queda en la bitácora de exportaciones con su alcance, su norma y sus conteos. Las autoridades se incluyen porque escogiste incluirlas.",
  confirmFooterAuthoritiesOff:
    "Queda en la bitácora de exportaciones con su alcance, su norma y sus conteos. Las autoridades no se incluyen porque escogiste dejarlas por fuera.",
  confirmFooterAuthorityScope:
    "Queda en la bitácora de exportaciones con su alcance, su norma y sus conteos. Las descripciones a las que están enlazadas estas autoridades se nombran como enlaces, no se exportan.",
  cancel: "Cancelar",

  workingTitle: "Preparando tu exportación",
  statusInProgress: "En curso",
  workingProgress: "{{done}} de {{items}}",
  workingEta_one: "falta como {{count}} minuto",
  workingEta_other: "faltan como {{count}} minutos",
  stageDescriptions: "Escribiendo las descripciones.",
  stageAuthorities: "Escribiendo las autoridades.",
  stageSerializing: "Escribiendo {{artifact}}.",
  stageThenAuthorities: "Luego las autoridades, y después {{artifact}}.",
  stageThen: "Después {{artifact}}.",
  artifactCsv: "la hoja de cálculo",
  artifactEad: "el instrumento de descripción codificado",
  artifactJson: "los datos estructurados",
  artifactPdf: "el instrumento de descripción",
  workingLeave:
    "Puedes cerrar esto y seguir trabajando. La ejecución continúa y termina en la bitácora de exportaciones.",
  workingStarted: "Empezó a las {{time}}",
  cancelRun: "Cancelar la ejecución",
  close: "Cerrar",

  readyTitle: "Tu exportación está lista",
  statusCompleted: "Completada",
  readyFinished: "terminó a las {{time}} · tardó {{duration}}",
  readyMeta: "{{format}} · {{size}} · {{counts}}",
  readyRetention:
    "Se conserva 30 días en la bitácora de exportaciones, y desde ahí se puede volver a descargar.",
  download: "Descargar",
  openFindingAid: "Abrir el instrumento de descripción",

  failedTitle: "La exportación se detuvo",
  statusFailed: "Falló",
  statusCancelled: "Cancelada",
  failedStopped: "se detuvo después de {{done}} de {{items}}",
  failedStoppedEarly: "se detuvo antes de escribir nada",
  failedRecorded:
    "Queda en la bitácora de exportaciones como una ejecución fallida, con este motivo.",
  failedWindow: "{{from}} – {{to}}",
  openRecords: "Abrir los registros",
  tryAgain: "Volver a intentar",

  failureDuplicateReferenceCode:
    "Dos registros comparten el código de referencia {{code}}. Los códigos de referencia tienen que ser únicos para codificar un instrumento de descripción.",
  failureDuplicateReferenceCodeFix:
    "Abre cualquiera de los dos registros, corrige uno y vuelve a exportar.",
  failureFormatNotBuilt:
    "Este formato todavía no está disponible. Se está construyendo; los otros formatos ya funcionan.",
  failureUnexpected:
    "La ejecución se detuvo por algo que Fisqua no supo nombrar. Vuelve a intentar: de todos modos queda anotada aquí.",
  failureWorkspaceStandardUnset:
    "Este espacio de trabajo no tiene una norma descriptiva definida, así que una exportación no tiene forma que tomar.",
  failureFormatRequiresAdmin:
    "Ese formato es solo para los administradores del espacio de trabajo.",
  failureHandlistNeedsReview:
    "Esta lista de trabajo tiene miembros pendientes de una decisión. Resuélvelos en la página de la lista y después exporta.",
  failureHandlistEmpty: "No hay nada en esta lista de trabajo que se pueda exportar.",
  failureHandlistUntyped:
    "Esta lista de trabajo todavía no tiene miembros, así que no tiene tipo con el cual exportarse.",
  failureBranchNotFound: "Esa rama ya no está en este espacio de trabajo.",
  failureScopeEmpty: "Este alcance no tiene nada que exportar.",
  failureIllegalCombination:
    "Esa norma y ese formato no producen ningún archivo. Escoge de nuevo.",

  // ── La bitácora ──────────────────────────────────────────────────
  historyTitle: "Bitácora de exportaciones",
  historyIntro:
    "Estos registros son tuyos, y sacarlos nunca depende de nosotros. Cada exportación queda anotada aquí, para que el espacio de trabajo siempre pueda decir qué salió, con qué forma y cuándo.",
  historyEmptyHeading: "Todavía no hay exportaciones",
  historyEmptyBody:
    "Escoge arriba qué exportar. Cada ejecución queda anotada aquí con su alcance, su norma y sus conteos.",
  rowTitle: "{{scope}} · {{form}} · {{format}}",
  rowPreparing: "Preparando · {{counts}}",
  rowProgress: "{{stage}} · {{done}} de {{items}}",
  rowLeaveWithEta:
    "{{eta}}. Puedes salir de esta página: la ejecución continúa y termina aquí.",
  rowLeave: "Puedes salir de esta página: la ejecución continúa y termina aquí.",
  rowReadyShortly: "Lista en un momento",
  rowHandlist: "lista de trabajo",
  rowCarriedFound: "{{exported}} de los {{found}} que se encontraron",
  rowCarriedUnticked: "{{count}} sin marcar",
  rowFileGone:
    "El archivo se eliminó a los 30 días. Qué salió, con qué forma y cuándo sigue anotado aquí.",
  openAgain: "Abrir de nuevo",

  // ── Cuando no hay nada que ofrecer ───────────────────────────────
  nothingHeading: "Aquí no hay nada que puedas llevarte",
  nothingBody:
    "Los registros de autoridad salen como datos, no como instrumento de descripción, y los formatos legibles por máquina son de los administradores del espacio de trabajo. Pídele a un administrador de este espacio que exporte este alcance.",
  standardUnsetHeading: "Este espacio de trabajo no tiene norma descriptiva",
  standardUnsetBody:
    "Una exportación toma la forma de una norma descriptiva, así que un espacio de trabajo sin norma no tiene forma en la cual salir. Un administrador puede definirla en la configuración del espacio de trabajo.",
} as const;
