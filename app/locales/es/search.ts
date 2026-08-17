/**
 * Spanish translations — search namespace
 *
 * Strings for the global search surface. Colombian Spanish, tú-form,
 * composed from meaning. Category labels keep the sidebar's module
 * vocabulary (Registros / Entidades / Lugares); "Cualquiera" is the
 * facet's neutral first option because the facet nouns disagree on
 * gender (el nivel, la función).
 *
 * The refine vocabulary (sí/no, the «No: » pill prefix, «Agregar
 * filtro de texto», the help copy's include/exclude phrasing) is
 * carried over verbatim from Zasqua's search so the two systems read
 * as one family; there are no operator keywords in any language.
 *
 * Las cadenas de listas de trabajo que viven aquí son solo las que dice
 * la superficie de BÚSQUEDA: el botón de la barra de selección, el menú
 * que ofrece una lista donde pararse, la etiqueta verdigrís del
 * conjunto y las líneas de conteo de una búsqueda hecha dentro de una
 * lista. Lo que dicen el diálogo y las páginas de listas vive en el
 * espacio de nombres `handlists` — incluida la línea «{{count}}
 * registros» que las filas del menú toman prestada en vez de repetir.
 *
 * @version v0.7.0
 */
export default {
  title: "Búsqueda",
  placeholder: "Busca en todo el espacio de trabajo",

  catAll: "Todo",
  catDescriptions: "Registros",
  catEntities: "Entidades",
  catPlaces: "Lugares",

  seeAll: "Ver todos",

  promptHeading: "Busca en todo el espacio de trabajo",
  promptBody:
    "Registros, entidades y lugares en una sola búsqueda. Cada resultado abre en su propia página.",
  helpP1:
    "Escribe un término o selecciona un filtro en el panel de filtros para comenzar a explorar, y luego agrega más hasta encontrar lo que buscas. La búsqueda ignora las tildes y busca palabras completas; antepón un guion a un término para excluirlo.",
  helpP2:
    "Agrega términos escribiéndolos en el panel de filtros: selecciona sí o no para incluir o excluir, elige un campo si quieres acotar, y presiona + o Enter. Cada término o filtro aparecerá como una etiqueta que puedes eliminar y reemplazar con facilidad, así que siéntete libre de experimentar.",

  // Panel de filtros (el panel de Zasqua: el widget de refinamiento
  // arriba, los grupos de facetas con conteos debajo).
  filterBy: "Filtrar por:",
  filtersToggle: "Filtros",
  clearFilters: "Limpiar filtros",

  // Encabezado de resultados
  resultsCount_one: "{{count}} resultado",
  resultsCount_other: "{{count}} resultados",
  sortBy: "Ordenar por:",
  sortDate: "Fecha",
  sortTitle: "Título",
  sortCode: "Código",
  sortName: "Nombre",
  sortRelevance: "Relevancia",

  // El conmutador de vista. La vista predeterminada se nombra por lo
  // que hace — buscar y filtrar por facetas — porque «Búsqueda» a
  // secas no dice nada junto a «Búsqueda avanzada».
  facetedToggle: "Búsqueda con facetas y filtros",
  facetedBlurb:
    "Este es el sistema de búsqueda de Zasqua, como en el catálogo público: agrega términos y filtros, refina incluyendo o excluyendo, y cada elección se convierte en una etiqueta que puedes quitar.",

  // Búsqueda avanzada (el formulario booleano clásico detrás del
  // conmutador de vista; los operadores son opciones de un selector,
  // nunca palabras clave escritas).
  advancedToggle: "Búsqueda avanzada",
  advancedBlurb:
    "La búsqueda avanzada clásica: combina criterios fila por fila — campos, fechas, niveles, categorías — con y, o y no.",
  opAnd: "y",
  opOr: "o",
  opNot: "no",
  advTermPlaceholder: "Texto a buscar…",
  advOpLabel: "Operador",
  rowLabel: "Criterio {{n}}",
  addRow: "Agregar criterio",
  removeRow: "Quitar criterio",
  dateHeading: "Fecha",
  dateFrom: "Desde",
  dateTo: "Hasta",
  searchAction: "Buscar",

  // Widget de refinamiento (el de Zasqua, más el selector de campo
  // propio de Fisqua).
  refineLabel: "Refinar la búsqueda",
  refinePlaceholder: "Búsqueda...",
  refineFieldLabel: "Campo de búsqueda",
  refineOpLabel: "Incluir o excluir",
  opYes: "Sí",
  opNo: "No",
  addTextFilter: "Agregar filtro de texto",
  notPrefix: "No: ",
  removeFilter: "Quitar filtro",
  fieldAll: "Todos los campos",
  fieldTitle: "Título",
  fieldScope: "Alcance",
  fieldNotes: "Notas",
  fieldRef: "Código de referencia",
  fieldLegacy: "Identificadores antiguos",

  // emptyBody: la búsqueda no coincide con nada en ninguna categoría;
  // emptyCategoryBody: la pestaña elegida (o sus filtros) quedó vacía
  // mientras otras pestañas sí tienen resultados.
  emptyHeading: "Sin resultados",
  emptyBody:
    "No hay resultados para «{{query}}». Prueba con menos palabras o con otras.",
  emptyCategoryBody:
    "Nada en esta categoría coincide con la búsqueda. Prueba otra pestaña o menos filtros.",

  filterLevel: "Nivel",
  filterRepository: "Repositorio",
  filterType: "Tipo",
  // El criterio de clase de objeto del formulario avanzado; «Tipo» le
  // pertenece a la faceta de tipo de entidad.
  filterCategory: "Categoría",
  filterFunction: "Función",
  filterPlaceType: "Tipo de lugar",
  anyOption: "Cualquiera",

  // Selección (la columna de marcas, la barra de selección y la
  // advertencia que aparece cuando un cambio de búsqueda costaría las
  // marcas). Cada frase de conteo se escribe completa por tipo de
  // registro: los participios concuerdan en género y número, así que
  // una frase armada por fragmentos quedaría mal para la mitad de los
  // sustantivos. «Conjunto» nombra aquí el grupo que se lleva a
  // exportación; «alcance» ya es la etiqueta del campo scope_content
  // en este espacio de nombres.
  selBar_records_one: "{{count}} registro seleccionado",
  selBar_records_other: "{{count}} registros seleccionados",
  selBar_entities_one: "{{count}} entidad seleccionada",
  selBar_entities_other: "{{count}} entidades seleccionadas",
  selBar_places_one: "{{count}} lugar seleccionado",
  selBar_places_other: "{{count}} lugares seleccionados",
  selAll_records: "Seleccionar los {{count}} registros coincidentes",
  selAll_entities: "Seleccionar las {{count}} entidades coincidentes",
  selAll_places: "Seleccionar los {{count}} lugares coincidentes",
  selAllHeld_records:
    "Todos los {{count}} registros coincidentes están seleccionados",
  selAllHeld_entities:
    "Todas las {{count}} entidades coincidentes están seleccionadas",
  selAllHeld_places:
    "Todos los {{count}} lugares coincidentes están seleccionados",
  selAcrossPages: "en {{count}} páginas",
  selOnlyPage: "Seleccionar solo esta página ({{count}})",
  selClear: "Limpiar selección",
  selSend: "Exportar la selección",
  // El otro destino de una selección, junto a exportarla: conservarla.
  // El artículo indefinido importa — estás eligiendo en cuál lista.
  selSave: "Agregar a una lista de trabajo",
  selKeptHint: "las marcas se conservan al cambiar de página",

  // Elegir la lista donde se va a buscar. El disparador se ofrece desde
  // la fila de etiquetas, como cualquier otra restricción, y el menú
  // enumera todas las listas que esta persona alcanza — incluidas las
  // que no pueden acotar la pestaña en pantalla, que quedan listadas y
  // dicen por qué. Un menú que se vacía a sí mismo no enseña nada.
  chooserTrigger: "Dentro de una lista de trabajo…",
  chooserHeader: "Buscar dentro de una lista de trabajo",
  // La segunda mitad del encabezado cuando ninguna lista contiene lo
  // que esta pestaña muestra: el problema dicho una vez, arriba de
  // filas que repiten cada una su parte.
  chooserNone_records: "ninguna de tus listas contiene registros",
  chooserNone_entities: "ninguna de tus listas contiene entidades",
  chooserNone_places: "ninguna de tus listas contiene lugares",
  // Por qué una lista listada no puede acotar esta pestaña: lo que
  // contiene y luego lo que se pidió. Una clave por par dirigido — el
  // primer sustantivo es el de la lista, el segundo el de la pestaña —
  // porque cada frase se escribe completa, nunca armada por plantilla.
  chooserWhy_records_entities: "contiene registros, no entidades",
  chooserWhy_records_places: "contiene registros, no lugares",
  chooserWhy_entities_records: "contiene entidades, no registros",
  chooserWhy_entities_places: "contiene entidades, no lugares",
  chooserWhy_places_records: "contiene lugares, no registros",
  chooserWhy_places_entities: "contiene lugares, no entidades",
  // De quién es la lista, después del conteo en cada fila del menú.
  // Concuerda con «lista», que es femenina.
  chooserYours: "tuya",
  chooserSharedBy: "compartida por {{name}}",

  // Búsqueda dentro de una lista de trabajo. La etiqueta nombra el
  // terreno donde se hace la pregunta, no un término buscado, así que
  // se lee como un lugar («en Inventarios de misiones»). Cada línea de
  // conteo se escribe completa por tipo: el verbo y el sustantivo
  // concuerdan, y una plantilla dejaría mal la mitad de los casos.
  handlistPill: "en {{name}}",
  inHandlistCount: "{{count}} de {{held}}",
  inHandlistOfSet: "en esta lista de trabajo",
  inHandlistWorkspace_records_one:
    "{{count}} registro coincide en todo el espacio de trabajo",
  inHandlistWorkspace_records_other:
    "{{count}} registros coinciden en todo el espacio de trabajo",
  inHandlistWorkspace_entities_one:
    "{{count}} entidad coincide en todo el espacio de trabajo",
  inHandlistWorkspace_entities_other:
    "{{count}} entidades coinciden en todo el espacio de trabajo",
  inHandlistWorkspace_places_one:
    "{{count}} lugar coincide en todo el espacio de trabajo",
  inHandlistWorkspace_places_other:
    "{{count}} lugares coinciden en todo el espacio de trabajo",
  inHandlistWiden: "Buscar en todo el espacio de trabajo",

  // Aquí no hay nada, allá sí. El título nombra la lista; el cuerpo
  // dice qué encontró la búsqueda adentro y cuánto alcanza la misma
  // pregunta afuera, para que un callejón sin salida se vuelva un
  // siguiente paso.
  emptyInHandlistTitle: "Sin resultados en {{name}}",
  emptyInHandlistSet_records_one:
    "no coincide con el único registro de esta lista de trabajo",
  emptyInHandlistSet_records_other:
    "no coincide con ninguno de los {{count}} registros de esta lista de trabajo",
  emptyInHandlistSet_entities_one:
    "no coincide con la única entidad de esta lista de trabajo",
  emptyInHandlistSet_entities_other:
    "no coincide con ninguna de las {{count}} entidades de esta lista de trabajo",
  emptyInHandlistSet_places_one:
    "no coincide con el único lugar de esta lista de trabajo",
  emptyInHandlistSet_places_other:
    "no coincide con ninguno de los {{count}} lugares de esta lista de trabajo",
  emptyInHandlistClearDates: "Quitar las fechas",

  warnChangeTitle: "¿{{act}}?",
  warnChangeBody1:
    "Esto cambia la búsqueda y los resultados se consultan de nuevo.",
  // El singular se escribe completo, con su género: «único registro»,
  // «única entidad». La segunda frase no cambia — es general.
  // El costo, una frase por tipo de registro, y la razón dicha una
  // sola vez debajo (la vista agrupada puede tener dos tipos marcados
  // a la vez). Para un solo tipo, el texto que se ve es exactamente el
  // que decía warnChangeBody2_*.
  warnChangeHold_records_one: "Tu único registro seleccionado se descartará.",
  warnChangeHold_records_other:
    "Tus {{count}} registros seleccionados se descartarán.",
  warnChangeHold_entities_one: "Tu única entidad seleccionada se descartará.",
  warnChangeHold_entities_other:
    "Tus {{count}} entidades seleccionadas se descartarán.",
  warnChangeHold_places_one: "Tu único lugar seleccionado se descartará.",
  warnChangeHold_places_other:
    "Tus {{count}} lugares seleccionados se descartarán.",
  warnChangeBelong:
    "Las selecciones pertenecen al conjunto de resultados en el que se hicieron, así que no sobreviven a una búsqueda nueva.",

  warnChangeBody3:
    "Si primero los envías a exportación se conservan: la página de exportación retiene el conjunto aunque vuelvas a buscar.",
  warnSendFirst: "Exportar la selección primero",
  warnRemoveClear: "Quitar y descartar",

  previous: "Anterior",
  next: "Siguiente",
  pageOf: "Página {{page}}",
  showingRange: "Mostrando {{from}}–{{to}} de {{count}}",
} as const;
