/**
 * Spanish translations — publish namespace
 *
 * This locale namespace carries the Spanish strings for the
 * `/admin/publish` superadmin surface — the run trigger, the
 * in-flight progress panel, and the history table. The `counts` block
 * is the notice shown in the changelog's place while its counts load
 * after the page renders, and the retry notice when they fail.
 *
 * El bloque `progress.stepLabels` permite que el panel
 * de progreso y la tabla de historial muestren los IDs de paso por fondo
 * (`descriptions:`, `children:`, `ead:`, `dc:`) con etiquetas
 * localizadas en español colombiano (sin voseo: tú, prefieres, sabes).
 *
 * The progress panel lists every step of the run, grouped by artefact:
 * `progress.state` names each step's state for screen readers,
 * `progress.groupCount` is a group's "3 de 10", and `progress.files_count`
 * what a children step wrote. The link files have their own `stepLabels`,
 * and `stepLabels.mets` names the METS steps of runs created when the
 * plan held them.
 *
 * The `changelog` labels and `detail.childrenFilesTotal` follow a
 * number, so they carry `_one` / `_other` forms.
 *
 * @version v0.9.0
 */
export default {
  title: "Publicar",
  subtitle: "Exportar datos al sitio público",
  superadminRequired: "Solo los superadministradores pueden acceder a esta página.",
  changelog: {
    title: "Cambios desde la última exportación",
    descriptions: "Descripciones",
    repositories: "Repositorios",
    entities: "Entidades",
    places: "Lugares",
    added_one: "agregada",
    added_other: "agregadas",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    added: "agregadas",
    modified_one: "con cambios",
    modified_other: "con cambios",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    modified: "con cambios",
    unpublished_one: "despublicada",
    unpublished_other: "despublicadas",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    unpublished: "despublicadas",
    noChanges: "Sin cambios",
    total: "total",
    fonds: "Fondo",
  },
  counts: {
    loadingTitle: "Contando lo que se va a publicar…",
    loadingBody: "Fisqua está contando las descripciones, los repositorios, las entidades y los lugares de todas las instituciones de la federación. Esto puede tardar unos segundos.",
    failed: "No se pudo completar el conteo. Puedes publicar de todos modos.",
    retry: "Reintentar",
  },
  controls: {
    title: "Exportar",
    selectFonds: "Seleccionar fondos",
    selectTypes: "Seleccionar tipos de datos",
    descriptions: "Descripciones",
    repositories: "Repositorios",
    entities: "Entidades",
    places: "Lugares",
    selectAll: "Seleccionar todo",
    deselectAll: "Deseleccionar todo",
    triggerExport: "Iniciar exportación",
    exporting: "Exportando…",
  },
  warning: {
    title: "Confirmar publicación",
    body: "Al publicar, Fisqua vuelve a generar todos los archivos de los fondos y tipos de datos seleccionados. Si hay muchos datos, puede tardar varios minutos. El panel muestra el avance mientras tanto; déjalo abierto hasta que termine.",
    estimate: "Tiempo estimado: unos {{minutes}} min",
    confirm: "Sí, publicar",
    cancel: "Cancelar",
  },
  progress: {
    title: "Avance de la exportación",
    step: "Paso",
    of: "de",
    starting: "Iniciando…",
    processing: "Procesando",
    complete: "Exportación completada",
    error: "Error en la exportación",
    records: "registros",
    records_count_one: "{{formattedCount}} registro",
    records_count_other: "{{formattedCount}} registros",
    stepElapsed: "Tiempo en el paso actual: {{minutes}} min {{seconds}} s",
    totalElapsed: "Tiempo total: {{minutes}} min {{seconds}} s",
    lastUpdate: "Última actualización: {{timestamp}}",
    files_count_one: "{{formattedCount}} archivo",
    files_count_other: "{{formattedCount}} archivos",
    stepsTitle: "Pasos",
    groupCount: "{{done}} de {{total}}",
    duration: "{{minutes}} min {{seconds}} s",
    state: {
      completed: "Completado",
      running: "En curso",
      pending: "Pendiente",
      failed: "Falló",
      partial: "Completado en parte",
    },
    reassurance: {
      children: "Se están generando las listas de descripciones subordinadas, una por cada descripción que tiene otras debajo. En los fondos grandes es el paso más largo; puedes dejar la página abierta sin problema.",
      index: "Se está generando el índice de descripciones; ya falta poco.",
    },
    stepLabels: {
      descriptions: "Descripciones",
      children: "Listas de descripciones subordinadas",
      mets: "Archivos METS",
      ead: "Instrumentos de descripción EAD3",
      dc: "Registros Dublin Core",
      repositories: "Repositorios",
      entities: "Entidades",
      places: "Lugares",
      index: "Índice de descripciones",
      entity_links: "Vínculos con entidades",
      place_links: "Vínculos con lugares",
    },
  },
  history: {
    title: "Historial de exportaciones",
    date: "Fecha",
    status: "Estado",
    triggeredBy: "Iniciada por",
    duration: "Duración",
    records: "Registros",
    recordsDescriptions: "desc.",
    recordsDescriptions_count_one: "{{formattedCount}} desc.",
    recordsDescriptions_count_other: "{{formattedCount}} desc.",
    recordsEntities: "ent.",
    recordsEntities_count_one: "{{formattedCount}} ent.",
    recordsEntities_count_other: "{{formattedCount}} ent.",
    recordsPlaces: "lug.",
    recordsPlaces_count_one: "{{formattedCount}} lug.",
    recordsPlaces_count_other: "{{formattedCount}} lug.",
    recordsRepositories: "rep.",
    recordsRepositories_count_one: "{{formattedCount}} rep.",
    recordsRepositories_count_other: "{{formattedCount}} rep.",
    noHistory: "Aún no hay exportaciones",
    complete: "Completada",
    error: "Falló",
    running: "En curso",
    pending: "Pendiente",
  },
  detail: {
    title: "Detalle de la publicación",
    backToPublish: "Volver a la página de publicación",
    overview: "Resumen",
    runId: "ID de ejecución",
    workflowInstanceId: "ID de instancia del flujo de trabajo",
    status: "Estado",
    triggeredBy: "Iniciada por",
    selectedFonds: "Fondos seleccionados",
    selectedTypes: "Tipos de datos seleccionados",
    timings: "Tiempos",
    createdAt: "Creada",
    startedAt: "Iniciada",
    completedAt: "Completada",
    duration: "Duración",
    currentStep: "Paso actual",
    stepStartedAt: "Inicio del paso",
    stepCompletedAt: "Fin del paso",
    lastHeartbeatAt: "Última actualización",
    stepsCompleted: "Pasos completados",
    recordCounts: "Conteos por paso",
    noRecordCounts: "Sin conteos registrados",
    childrenFiles: "Listas de descripciones subordinadas",
    childrenFilesTotal_one: "Se generó {{count}} archivo children/{refCode}.json en todos los fondos",
    childrenFilesTotal_other: "Se generaron {{count}} archivos children/{refCode}.json en todos los fondos",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    childrenFilesTotal: "Se generaron {{count}} archivos children/{refCode}.json en todos los fondos",
    childrenFilesFonds: "Fondo",
    childrenFilesCount: "Archivos generados",
    errorTitle: "Error",
    rawJson: "Datos sin procesar",
    notFound: "No se encontró esta exportación",
  },
  rebuild: {
    title: "Siguiente paso: volver a generar el sitio",
    message: "La exportación terminó. Para que los cambios aparezcan en el sitio público, vuelve a generarlo desde GitHub Actions.",
    link: "Ir a GitHub Actions",
  },
  publish_in_progress: "Ya hay una publicación en curso. Espera a que termine para iniciar otra.",
  publish_start_failed: "No se pudo iniciar la publicación. Intenta de nuevo.",
} as const;
