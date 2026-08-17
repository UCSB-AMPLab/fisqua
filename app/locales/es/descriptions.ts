/**
 * Traducciones al español — namespace descriptions (administración)
 *
 * This locale namespace deals with las etiquetas de la administración
 * para el formulario de descripción archivística estándar-consciente.
 * Un solo namespace con
 * sobreescrituras por estándar; claves por nombre de columna; las
 * secciones también se traducen vía i18n. Las claves planas
 * `field_X` / `section_X` de v0.3 se normalizan a claves anidadas
 * `fields.<columna>` / `sections.<id>`, con las sobreescrituras por
 * estándar como claves literales hermanas en el mismo nivel (p. ej.
 * `sections["context.dacs"]` junto a `sections.context`).
 *
 * Configuración keySeparator (verificada 2026-05-03 contra
 * `app/middleware/i18next.ts`): el proyecto NO establece
 * `keySeparator: false`, así que i18next usa el separador punto por
 * defecto. En ese modo, el resolver de i18next busca primero una
 * coincidencia literal de la clave antes de descender; almacenar la
 * sobreescritura como clave literal `"context.dacs"` resuelve
 * correctamente vía `t("sections.context.dacs")` sin romper
 * `t("sections.context")`. Esa es la forma que consume `tStd`
 * (`app/lib/i18n/standard-aware.ts`).
 *
 * Estilo: español colombiano (forma tú, sin voseo). Nunca `querés`,
 * `preferís`, `sabés`, `tenés`, `sos`; siempre `quieres`, `prefieres`,
 * `sabes`, `tienes`, `eres`.
 *
 * @version v0.4.3
 */
export default {
  // Página
  page_title: "Descripciones",
  new_description: "Nueva descripción",
  create_description: "Crear descripción",
  save_changes: "Guardar cambios",
  edit: "Editar",
  discard_changes: "Descartar cambios",
  back_to_descriptions: "Volver a descripciones",
  delete_description: "Eliminar descripción",
  delete_cancel: "Volver",
  move_button: "Mover...",
  move_title: "Mover descripción",
  move_subtitle: "Selecciona el nuevo padre para '{{title}}'.",
  move_confirm: "Confirmar movimiento",
  move_cancel: "Cancelar",
  add_child: "Agregar hijo",
  reorder: "Reordenar",
  breadcrumb_new: "Nueva descripción",
  breadcrumb_root: "Descripciones",
  empty_heading: "No hay descripciones",
  empty_body:
    "Agrega la primera descripción o importa registros existentes.",
  filter_placeholder: "Filtrar...",
  ref_code_helper:
    "Sugerido a partir del registro padre. Lo puedes editar.",
  parent_helper: "Padre: {{parentTitle}}",
  level_required_helper:
    "El nivel {{level}} también exige estos campos. Los puedes ajustar después en la misma descripción.",

  // Orientación por campo: lo que la propia norma dice que es cada
  // elemento, citado textualmente. Se organiza por norma y NO hereda de
  // una norma a otra: ver FieldConfig.guidance en
  // app/lib/standards/types.ts, porque heredar equivaldría a atribuirle
  // a una norma palabras de otra. La cita viene del config, no de aquí.
  //
  // ISAD(G): Norma Internacional General de Descripción Archivística,
  // 2a ed. (Consejo Internacional de Archivos, Madrid, 2000), tomado
  // del "Objetivo" de cada elemento. Esta versión española es una
  // traducción de referencia, no un documento oficial; se transcribe
  // tal cual, corrigiendo únicamente los errores de digitalización del
  // ejemplar escaneado.
  guidance: {
    "referenceCode.isadg":
      "Identificar de un modo único la unidad de descripción y establecer el vínculo con la descripción que la representa.",
    "title.isadg": "Denominar la unidad de descripción.",
    "dateExpression.isadg":
      "Identificar y consignar la(s) fecha(s) de la unidad de descripción.",
    "descriptionLevel.isadg":
      "Identificar el nivel de organización de la unidad de descripción.",
    "extent.isadg":
      "Identificar y describir: a. la extensión física o lógica y b. el soporte de la unidad de descripción.",
    "creatorDisplay.isadg":
      "Identificar el productor o los productores de la unidad de descripción.",
    "scopeContent.isadg":
      "Proporcionar a los usuarios la información necesaria para apreciar el valor potencial de la unidad de descripción.",
    "provenance.isadg":
      "Proporcionar información sobre la historia de la unidad de descripción que sea significativa para su autenticidad, integridad e interpretación.",
    "arrangement.isadg":
      "Informar sobre la estructura interna, la ordenación y/o el sistema de clasificación de la unidad de descripción.",
    "accessConditions.isadg":
      "Informar sobre la situación jurídica y cualquier otra normativa que restrinja o afecte el acceso a la unidad de descripción.",
    "reproductionConditions.isadg":
      "Identificar cualquier tipo de restricción relativa a la reproducción de la unidad de descripción.",
    "language.isadg":
      "Identificar la(s) lengua(s), escritura(s) y sistemas de símbolos utilizados en la unidad de descripción.",
    "findingAids.isadg":
      "Identificar cualquier tipo de instrumento de descripción relativo a la unidad de descripción.",
    "locationOfOriginals.isadg":
      "En el caso de que la unidad de descripción esté formada por copias, indicar la existencia, localización, disponibilidad y/o eliminación de los originales.",
    "locationOfCopies.isadg":
      "Indicar la existencia, localización y disponibilidad de copias de la unidad de descripción.",
    "notes.isadg":
      "Dar información que no haya podido ser incluida en ninguna de las otras áreas.",
    // DACS: Describing Archives: A Content Standard, 2019.0.3 (Society
    // of American Archivists), del "Purpose and Scope" de cada elemento.
    // A diferencia de ISAD(G), DACS NO tiene edición en español: estas
    // son traducciones nuestras, que la licencia CC-BY permite como obra
    // derivada. «Atribuido» (nunca «atributado») traduce el "devised"
    // de DACS, siguiendo los «títulos atribuidos» de la ISAD(G) española
    // para que ambas normas usen el mismo término.
    "referenceCode.dacs":
      "Este elemento proporciona un identificador único para la unidad que se describe. El identificador puede constar de tres subelementos: un identificador local, un código del repositorio y un código del país.",
    "repositoryId.dacs":
      "Este elemento identifica el nombre y la ubicación del repositorio que custodia los materiales descritos.",
    "title.dacs":
      "Este elemento proporciona una palabra o frase por la cual se conoce o se puede identificar el material descrito. El título puede ser atribuido o formal.",
    "dateExpression.dacs":
      "Este elemento identifica y consigna la o las fechas relacionadas con la creación, reunión, acumulación y/o conservación y uso de los materiales descritos.",
    "extent.dacs":
      "Este elemento indica el volumen y la naturaleza física de los materiales descritos. Se expresa en dos partes: una cantidad y una expresión del volumen o del tipo de material.",
    "creatorDisplay.dacs":
      "Este elemento identifica las entidades, personas y familias vinculadas con la creación, reunión, acumulación y/o conservación y uso de los materiales descritos, para dejarlas debidamente documentadas y usarlas como puntos de acceso con los que los usuarios puedan buscar y recuperar los registros descriptivos.",
    "adminBiogHistory.dacs":
      "La historia administrativa o reseña biográfica aporta información relevante sobre las entidades, personas o familias que se identifican en el elemento Nombre del productor y que, por lo tanto, funcionan como puntos de acceso onomásticos.",
    "scopeContent.dacs":
      "Este elemento aporta información sobre la naturaleza de los materiales y las actividades que refleja la unidad descrita, para que los usuarios puedan juzgar su posible relevancia.",
    "accessConditions.dacs":
      "Este elemento aporta información sobre las restricciones de acceso derivadas de la naturaleza de la información contenida en los materiales descritos, como las que imponen el donante, el repositorio o requisitos legales o reglamentarios.",
    "language.dacs":
      "Este elemento identifica las lenguas, escrituras y sistemas de símbolos empleados en los materiales descritos, sobre todo en cuanto puedan afectar su uso.",
    // RAD: Rules for Archival Description (Canadian Council of
    // Archives), capítulo 1, versión revisada de julio de 2008. El texto
    // de RAD tiene todos los derechos reservados, así que estos son
    // RESÚMENES nuestros, no citas: el config marca la norma con
    // `guidanceVerbatim: false` y la ayuda no pone comillas.
    "title.rad":
      "Transcribe el título formal que traen los propios documentos; si no lo traen, redacta uno.",
    "editionStatement.rad":
      "Transcribe la mención de edición del documento. Solo en el nivel de unidad documental.",
    "dateExpression.rad":
      "La fecha o las fechas de creación. En los niveles de agrupación se consignan las fechas de creación, no los datos de publicación.",
    "extent.rad":
      "Cuántas unidades físicas hay, en cifras arábigas, con la designación específica del tipo de material.",
    "dimensions.rad":
      "Las dimensiones del material, según las reglas de su clase.",
    "seriesStatement.rad":
      "El título de la serie del editor o del artista a la que pertenece el documento; no se trata de una serie archivística.",
    "adminBiogHistory.rad":
      "La historia de la entidad, la persona o la familia responsable de crear, acumular y usar los documentos.",
    "provenance.rad":
      "Los traspasos sucesivos de propiedad, custodia o control de los documentos, con sus fechas, hasta donde se puedan establecer. No se confunde con la historia del productor.",
    "scopeContent.rad":
      "Las funciones o actividades de las que provienen los documentos, la relación entre ellos, cómo están organizados y sus tipos documentales, además del periodo, la materia y el ámbito geográfico que abarcan.",
    "systemOfArrangement.rad":
      "La organización que ayuda a entender los documentos pero no cabe en alcance y contenido: una reorganización hecha por el productor, la ordenación hecha por el archivista, un cambio en el cuadro de clasificación.",
    "notes.rad":
      "Información descriptiva que no cabe en ninguna otra área.",
  },
  guidance_source: "{{standard}} {{element}}",
  guidance_source_summary: "Según {{standard}} {{element}}",
  guidance_example_label: "p. ej.",
  // Ejemplos tomados de los bloques de Ejemplos de las propias normas.
  // Cada idioma usa los de su edición, así que el español muestra
  // ejemplos de archivos de habla hispana y no la traducción de uno en
  // inglés. Solo se incluyen los que se leen de un vistazo: los de
  // alcance y contenido ocupan un párrafo, así que ese campo lleva
  // únicamente el objetivo.
  guidance_example: {
    "referenceCode.isadg": "ES AGI CORREOS",
    "title.isadg": "Consejo de Inquisición",
    "dateExpression.isadg": "1752-1839",
    "descriptionLevel.isadg": "Fondo",
    "extent.isadg": "895 unidades de instalación",
    "creatorDisplay.isadg": "Consejo Real de España e Indias",
  },

  // Etiquetas de sección: identificadas por el id estable en
  // inglés desde los configs de estándar
  // (`app/lib/standards/{isadg,dacs,rad}.ts`). Las sobreescrituras
  // por estándar viven como claves literales hermanas (p. ej.
  // `"context.dacs"`) y se resuelven vía `tStd(t,
  // "sections.context", standard)`.
  sections: {
    // Compartidas (base ISAD(G) + solapamiento con DACS/RAD)
    identity: "Identificación",
    context: "Contexto",
    content: "Contenido y estructura",
    conditions: "Condiciones de acceso y uso",
    allied: "Materiales relacionados",
    notes: "Notas",
    bibliographic: "Datos bibliográficos",
    digital: "Objetos digitales",
    entities: "Entidades vinculadas",
    places: "Lugares vinculados",

    // Sobreescritura por estándar: DACS llama al bloque de contexto
    // "Nota biográfica/histórica" en lugar de "Contexto".
    "context.dacs": "Nota biográfica/histórica",

    // Etiquetas específicas de DACS
    description_control: "Control de la descripción",
    acquisition: "Información de adquisición y valoración",
    related_materials: "Materiales relacionados",
    conditions_access: "Condiciones de acceso y uso",
    rights: "Declaraciones de derechos",

    // Etiquetas específicas de RAD
    edition: "Edición",
    // La sección RAD class-specific se renderiza vacía en v0.4 (no
    // hay columnas cartográficas/arquitectónicas/filatélicas tras
    // ver el encabezado de `app/lib/standards/rad.ts`).
    class_specific: "Detalles específicos por clase de material",
    dates_creation: "Fechas de creación",
    physical_description: "Descripción física",
    publishers_series: "Serie del editor",
    archival_description: "Descripción archivística",
    standard_number: "Número estándar",
    access_points: "Puntos de acceso",
  },

  // Etiquetas de campo: identificadas por el nombre de la
  // columna en `descriptions`. Las sobreescrituras por estándar como
  // claves literales hermanas en el mismo nivel.
  fields: {
    // Área de identificación
    referenceCode: "Código de referencia",
    localIdentifier: "Identificador local",
    legacyIds: "Identificadores anteriores",
    title: "Título",
    translatedTitle: "Título traducido",
    uniformTitle: "Título uniforme",
    descriptionLevel: "Nivel de descripción",
    resourceType: "Tipo de recurso",
    genre: "Género",
    repositoryId: "Repositorio",
    parentId: "Registro padre",
    childCount: "Sub-elementos",

    // Sobreescritura por estándar: RAD distingue "Title proper" de
    // títulos suministrados/paralelos (1.1B1 / 2.1B); ISAD(G) y DACS
    // usan el "Título" sin matices.
    "title.rad": "Título propio",

    // Fechas / extensión
    dateExpression: "Fecha(s)",
    dateStart: "Fecha de inicio",
    dateEnd: "Fecha de fin",
    dateCertainty: "Certeza de fecha",
    extent: "Extensión",
    dimensions: "Dimensiones",
    medium: "Soporte",

    // Contexto
    creatorDisplay: "Creador",
    provenance: "Historia custodial",
    adminBiogHistory: "Historia administrativa/biográfica",

    // Contenido y estructura
    scopeContent: "Alcance y contenido",
    systemOfArrangement: "Sistema de organización",
    physicalCharacteristics: "Características físicas",
    arrangement: "Organización",
    ocrText: "Texto OCR",

    // Condiciones
    accessConditions: "Condiciones que rigen el acceso",
    reproductionConditions: "Condiciones que rigen la reproducción",
    language: "Idioma del material",

    // Materiales relacionados
    locationOfOriginals: "Localización de originales",
    locationOfCopies: "Localización de copias",
    findingAids: "Instrumentos de descripción",

    // Notas / citación
    notes: "Notas",
    internalNotes: "Notas internas",
    preferredCitation: "Citación preferida",

    // Adquisición (DACS)
    acquisitionInfo: "Información de adquisición",

    // Bibliográficos
    imprint: "Pie de imprenta",
    editionStatement: "Mención de edición",
    seriesStatement: "Mención de serie",
    volumeNumber: "Número de volumen",
    issueNumber: "Número de ejemplar",
    pages: "Páginas",
    sectionTitle: "Título de sección",
    publicationTitle: "Título de la publicación",

    // Control de descripción (RAD `standard_number` cae aquí)
    descriptionsArchivists: "Archivistas",
    revisionHistory: "Historial de revisiones",
    languageOfDescription: "Idioma de la descripción",

    // Identificador DBE (referencia cruzada de autoridad RAD)
    dbeId: "Identificador DBE",

    // Sustituto digital
    iiifManifestUrl: "URL del manifiesto IIIF",
    hasDigital: "Tiene sustituto digital",
  },

  // Vinculación de entidades/lugares
  add_entity: "Agregar entidad",
  add_place: "Agregar lugar",
  search_entity: "Buscar entidad...",
  search_place: "Buscar lugar...",
  role_label: "Rol",
  // Roles de entidad (deben coincidir con ENTITY_ROLES en lib/validation/enums.ts)
  role_creator: "Creador",
  role_author: "Autor",
  role_editor: "Editor",
  role_publisher: "Editor (publicación)",
  role_sender: "Remitente",
  role_recipient: "Destinatario",
  role_mentioned: "Mencionado",
  role_subject: "Tema",
  role_scribe: "Escribano",
  role_witness: "Testigo",
  role_notary: "Notario",
  role_photographer: "Fotógrafo",
  role_artist: "Artista",
  role_plaintiff: "Demandante",
  role_defendant: "Demandado",
  role_petitioner: "Peticionario",
  role_judge: "Juez",
  role_appellant: "Apelante",
  role_official: "Funcionario",
  role_heir: "Heredero",
  role_albacea: "Albacea",
  role_spouse: "Cónyuge",
  role_victim: "Víctima",
  role_grantor: "Otorgante",
  role_donor: "Donante",
  role_seller: "Vendedor",
  role_buyer: "Comprador",
  role_mortgagor: "Deudor hipotecario",
  role_mortgagee: "Acreedor hipotecario",
  role_creditor: "Acreedor",
  role_debtor: "Deudor",
  role_fiador: "Fiador",
  role_apoderado: "Apoderado",
  // Roles de lugar (deben coincidir con PLACE_ROLES en lib/validation/enums.ts)
  role_created: "Creado",
  role_sent_from: "Enviado desde",
  role_sent_to: "Recibido en",
  role_published: "Publicado",
  role_venue: "Lugar",
  // Etiquetas de grupo del selector de rol (optgroups; las claves reflejan ENTITY_ROLE_GROUPS)
  role_group_production: "Producción y menciones",
  role_group_correspondence: "Correspondencia",
  role_group_notarial: "Actuación notarial",
  role_group_legal: "Procedimientos judiciales",
  role_group_family: "Familia y herencia",
  role_group_transactions: "Transacciones",
  role_group_visual: "Materiales visuales",
  honorific_label: "Honorífico",
  function_label: "Función",
  name_as_recorded_label: "Nombre registrado",
  link_confirm: "Confirmar",
  link_cancel: "Cancelar",
  remove_link_confirm: "¿Eliminar vínculo con {{name}}?",
  remove_link_button: "Eliminar",
  no_results: "No se encontraron resultados",

  // Borrador / changelog
  commit_note_placeholder: "Nota sobre los cambios (opcional)",
  autosave_saving: "Guardando...",
  autosave_saved: "Borrador guardado",
  conflict_banner:
    "{{name}} tiene cambios sin guardar desde {{time}}.",
  overwrite_confirm:
    "Este registro fue modificado por {{name}} a las {{time}}. ¿Deseas sobrescribir?",
  overwrite_button: "Sobrescribir",
  overwrite_cancel: "Cancelar",

  // Publicación
  published_badge: "Publicada",
  unpublished_badge: "No publicada",
  pending_publish: "Pendiente de publicación",
  pending_removal: "Pendiente de retiro",
  live_badge: "En línea",
  publish_action: "Publicar",
  unpublish_action: "Despublicar",

  // Errores
  error_generic: "Ocurrió un error. Inténtalo de nuevo.",
  error_required: "Este campo es obligatorio.",
  error_duplicate_ref:
    "Ya existe una descripción con ese código de referencia.",
  error_invalid_level:
    "El nivel debe ser inferior al del registro padre.",
  error_delete_blocked:
    "No se puede eliminar -- {{count}} descripciones hijas",
  error_delete_cascade:
    "Al eliminar esta descripción se eliminarán {{entityCount}} vínculos con entidades y {{placeCount}} vínculos con lugares.",
  error_delete_confirm:
    "¿Estás seguro de que deseas eliminar {{title}}? Esta acción no se puede deshacer.",
  error_move_children:
    "Esta descripción tiene {{count}} hijos que también se moverán.",

  // Éxito
  success_created: "Descripción creada.",
  success_updated: "Descripción actualizada.",
  success_deleted: "Descripción eliminada.",
  success_moved: "Descripción movida.",
  success_published: "Descripción publicada.",
  success_unpublished: "Descripción despublicada.",
  success_entity_linked: "Entidad vinculada.",
  success_place_linked: "Lugar vinculado.",
  success_link_removed: "Vínculo eliminado.",

  // Etiquetas de accesibilidad
  aria_move_up: "Mover arriba",
  aria_move_down: "Mover abajo",
  aria_edit_link: "Editar vínculo",
  aria_remove_link: "Eliminar vínculo con {{name}}",

  // Nombres de los niveles de descripción
  level_fonds: "Fondo",
  level_subfonds: "Subfondo",
  level_series: "Serie",
  level_subseries: "Subserie",
  level_file: "Expediente",
  level_item: "Pieza",
  level_collection: "Colección",
  level_section: "Sección",
  level_volume: "Volumen",

  // Vista
  view_tree: "Árbol de archivos",
  view_columns: "Vista de columnas",

  // Encabezados de tabla en la vista de columnas
  col_reference_code: "Código de referencia",
  col_title: "Título",
  col_level: "Nivel",
  col_repository: "Repositorio",
  col_has_digital: "Objeto digital",
  col_parent_code: "Código padre",
  col_toggle: "Columnas",

  // Filtros de la vista de columnas
  filter_level: "Nivel de descripción",
  filter_repository: "Repositorio",
  filter_has_digital: "Tiene objeto digital",
  search_descriptions: "Buscar por título o código de referencia...",

  // Navegador del árbol
  root_column_title: "Contenido",
  loading: "Cargando...",

  // Marcador de posición sin manifiesto
  no_manifest: "No hay material digitalizado",
  add_manifest: "Agregar URL de manifiesto IIIF",

  // Visor IIIF
  loading_manifest: "Cargando manifiesto...",
  empty_manifest: "No se encontraron páginas en el manifiesto",
  manifest_load_error: "No se pudo cargar el manifiesto",
  zoom_in: "Acercar",
  zoom_out: "Alejar",
  prev_page: "Página anterior",
  next_page: "Página siguiente",
} as const;

/* @version v0.4.3 */
