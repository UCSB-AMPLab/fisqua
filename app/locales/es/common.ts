/**
 * Spanish translations — common namespace
 *
 * This locale namespace carries the cross-cutting Spanish strings
 * every other namespace builds on top of — the app brand name and the
 * shared button vocabulary (Guardar, Cancelar, Crear, Eliminar,
 * Aplicar, Limpiar). i18next loads it as the default namespace, so
 * bare keys like `t("button.save")` resolve here without an explicit
 * prefix.
 *
 * @version v0.7.0
 */
export default {
  app_name: "Fisqua",
  button: {
    save: "Guardar",
    cancel: "Cancelar",
    create: "Crear",
    delete: "Eliminar",
    apply: "Aplicar",
    clear: "Limpiar",
  },
  label: {
    loading: "Cargando...",
    search: "Buscar",
    actions: "Acciones",
    name: "Nombre",
    email: "Correo electrónico",
    role: "Rol",
    status: "Estado",
    none: "Ninguno",
    yes: "Sí",
    no: "No",
    back: "Volver",
    close: "Cerrar",
    confirm: "Confirmar",
    edit: "Editar",
    details: "Detalles",
  },
  collapse: "Contraer",
  expand: "Expandir",
  field_required: "Este campo es obligatorio",
  aria: {
    breadcrumb: "Ruta de navegación",
    main_navigation: "Navegación principal",
  },
  help: {
    openDocs: "Ver la guía para esta pantalla",
  },
  // Vocabulario compartido de confirmación de guardado en los
  // formularios de administración. `saved` y `failed` son los textos de
  // reserva cuando la acción informa el resultado sin mensaje propio;
  // `saving` es la etiqueta del botón mientras el envío está en curso.
  save: {
    saved: "Se guardaron los cambios",
    saving: "Guardando...",
    failed: "No se guardaron los cambios",
  },
  domain: {
    document_count_one: "{{count}} documento",
    document_count_other: "{{count}} documentos",
    image_count_one: "{{count}} imagen",
    image_count_other: "{{count}} imágenes",
    volume_count_one: "{{count}} unidad compuesta",
    volume_count_other: "{{count}} uds.",
    volume_count_full_one: "{{count}} unidad compuesta",
    volume_count_full_other: "{{count}} unidades compuestas",
  },
  error: {
    generic_title: "Algo salió mal",
    generic_detail: "Ocurrió un error inesperado.",
    // El 404 cubre a propósito tanto lo inexistente como lo ajeno a
    // este espacio (los recursos de otros responden 404 por diseño):
    // nunca debe sugerir que la página existe en otra parte.
    not_found_title: "No hay nada en esta dirección",
    not_found:
      "En este espacio de trabajo no hay ninguna página con esta dirección. Revisa la dirección o vuelve al espacio de trabajo y sigue desde ahí.",
    forbidden_title: "No tienes acceso a esto",
    forbidden:
      "Tu rol en este espacio de trabajo no permite esta acción. Si la necesitas, pídele acceso a quien administra el espacio.",
    server_error_title: "Algo falló de nuestro lado",
    server_error:
      "La solicitud no se completó. Intenta de nuevo y, si sigue fallando, cuéntale a quien administra el espacio qué estabas haciendo y en qué momento.",
    back_home: "Volver al espacio de trabajo",
    try_again: "Intentar de nuevo",
  },
  pagination: {
    previous: "Anterior",
    next: "Siguiente",
    previous_page: "Página anterior",
    next_page: "Página siguiente",
    page_of: "Página {{current}} de {{total}}",
    // `label` trae el sustantivo ya en plural, así que ambas formas
    // comparten la misma plantilla.
    showing_one: "Mostrando {{count}} {{label}}",
    showing_other: "Mostrando {{count}} {{label}}",
  },
} as const;
