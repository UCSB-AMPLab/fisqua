/**
 * Spanish translations — descriptions namespace
 *
 * @version v0.3.0
 */
export default {
  // Page
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
  move_subtitle: "Seleccione el nuevo padre para '{{title}}'.",
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
    "Sugerido a partir del registro padre. Puede editarlo.",
  parent_helper: "Padre: {{parentTitle}}",

  // ISAD(G) section headings
  section_identity: "Identificación",
  section_context: "Contexto",
  section_content: "Contenido y estructura",
  section_access: "Condiciones de acceso y uso",
  section_allied: "Materiales relacionados",
  section_notes: "Notas",
  section_bibliographic: "Datos bibliográficos",
  section_digital: "Objetos digitales",
  section_entities: "Entidades vinculadas",
  section_places: "Lugares vinculados",

  // Entity/place linking
  add_entity: "Agregar entidad",
  add_place: "Agregar lugar",
  search_entity: "Buscar entidad...",
  search_place: "Buscar lugar...",
  role_label: "Rol",
  // Entity roles (must match ENTITY_ROLES in lib/validation/enums.ts)
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
  // Place roles (must match PLACE_ROLES in lib/validation/enums.ts)
  role_created: "Creado",
  role_sent_from: "Enviado desde",
  role_sent_to: "Recibido en",
  role_published: "Publicado",
  role_venue: "Lugar",
  honorific_label: "Honorificencia",
  function_label: "Función",
  name_as_recorded_label: "Nombre registrado",
  link_confirm: "Confirmar",
  link_cancel: "Cancelar",
  remove_link_confirm: "¿Eliminar vínculo con {{name}}?",
  remove_link_button: "Eliminar",
  no_results: "No se encontraron resultados",

  // Draft/changelog
  commit_note_placeholder: "Nota sobre los cambios (opcional)",
  autosave_saving: "Guardando...",
  autosave_saved: "Borrador guardado",
  conflict_banner:
    "{{name}} tiene cambios sin guardar desde {{time}}.",
  overwrite_confirm:
    "Este registro fue modificado por {{name}} a las {{time}}. ¿Desea sobreescribir?",
  overwrite_button: "Sobreescribir",
  overwrite_cancel: "Cancelar",

  // Publishing
  published_badge: "Publicada",
  unpublished_badge: "No publicada",
  pending_publish: "Pendiente de publicación",
  pending_removal: "Pendiente de retiro",
  live_badge: "En línea",
  publish_action: "Publicar",
  unpublish_action: "Despublicar",

  // Errors
  error_generic: "Ocurrió un error. Intenta de nuevo.",
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
    "¿Está seguro de que desea eliminar {{title}}? Esta acción no se puede deshacer.",
  error_move_children:
    "Esta descripción tiene {{count}} hijos que también se moverán.",

  // Success
  success_created: "Descripción creada.",
  success_updated: "Descripción actualizada.",
  success_deleted: "Descripción eliminada.",
  success_moved: "Descripción movida.",
  success_published: "Descripción publicada.",
  success_unpublished: "Descripción despublicada.",
  success_entity_linked: "Entidad vinculada.",
  success_place_linked: "Lugar vinculado.",
  success_link_removed: "Vínculo eliminado.",

  // Field labels
  field_referenceCode: "Código de referencia",
  field_localIdentifier: "Identificador local",
  field_title: "Título",
  field_translatedTitle: "Título traducido",
  field_uniformTitle: "Título uniforme",
  field_descriptionLevel: "Nivel de descripción",
  field_resourceType: "Tipo de recurso",
  field_genre: "Género",
  field_dateExpression: "Expresión de fecha",
  field_childCount: "Sub-elementos",
  field_dateStart: "Fecha inicio",
  field_dateEnd: "Fecha fin",
  field_dateCertainty: "Certeza de fecha",
  field_extent: "Extensión",
  field_dimensions: "Dimensiones",
  field_medium: "Soporte",
  field_provenance: "Procedencia",
  field_scopeContent: "Alcance y contenido",
  field_arrangement: "Organización",
  field_ocrText: "Texto OCR",
  field_accessConditions: "Condiciones de acceso",
  field_reproductionConditions: "Condiciones de reproducción",
  field_language: "Idioma",
  field_locationOfOriginals: "Localización de originales",
  field_locationOfCopies: "Localización de copias",
  field_relatedMaterials: "Materiales relacionados",
  field_findingAids: "Instrumentos de descripción",
  field_notes: "Notas",
  field_internalNotes: "Notas internas",
  field_imprint: "Pie de imprenta",
  field_editionStatement: "Mención de edición",
  field_seriesStatement: "Mención de serie",
  field_volumeNumber: "Número de volumen",
  field_issueNumber: "Número de ejemplar",
  field_pages: "Páginas",
  field_sectionTitle: "Título de sección",
  field_iiifManifestUrl: "URL de manifiesto IIIF",
  field_hasDigital: "Material digitalizado",
  field_repositoryId: "Repositorio",
  field_parentId: "Registro padre",

  // Accessibility labels
  aria_move_up: "Mover arriba",
  aria_move_down: "Mover abajo",
  aria_edit_link: "Editar vínculo",
  aria_remove_link: "Eliminar vínculo con {{name}}",

  // Description level display names
  level_fonds: "Fondo",
  level_subfonds: "Subfondo",
  level_series: "Serie",
  level_subseries: "Subserie",
  level_file: "Expediente",
  level_item: "Pieza",
  level_collection: "Colección",
  level_section: "Sección",
  level_volume: "Volumen",

  // View toggle
  view_tree: "Árbol de archivos",
  view_columns: "Vista de columnas",

  // Column view table headers
  col_reference_code: "Código de referencia",
  col_title: "Título",
  col_level: "Nivel",
  col_repository: "Repositorio",
  col_has_digital: "Objeto digital",
  col_parent_code: "Código padre",
  col_toggle: "Columnas",

  // Column view filters
  filter_level: "Nivel de descripción",
  filter_repository: "Repositorio",
  filter_has_digital: "Tiene objeto digital",
  search_descriptions: "Buscar por título o código de referencia...",

  // Tree browser
  root_column_title: "Contenido",
  loading: "Cargando...",

  // No manifest placeholder
  no_manifest: "No hay material digitalizado",
  add_manifest: "Agregar URL de manifiesto IIIF",

  // IIIF viewer
  loading_manifest: "Cargando manifiesto...",
  empty_manifest: "No se encontraron páginas en el manifiesto",
  manifest_load_error: "No se pudo cargar el manifiesto",
  zoom_in: "Acercar",
  zoom_out: "Alejar",
  prev_page: "Página anterior",
  next_page: "Página siguiente",
} as const;
