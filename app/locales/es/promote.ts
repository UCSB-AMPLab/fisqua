/**
 * Spanish translations — promote namespace
 *
 * @version v0.3.0
 */
export default {
  heading: {
    title: "Promover entradas",
  },
  volume: {
    heading: "Seleccionar un volumen",
    empty: "No hay volúmenes con entradas aprobadas listas para promoción.",
  },
  table: {
    selectAll: "Seleccionar todo",
    deselectAll: "Deseleccionar todo",
    col: {
      title: "Título",
      pages: "Páginas",
      refCode: "Código de referencia",
      status: "Estado",
    },
    children: "{{count}} subentradas",
  },
  refCode: {
    patternLabel: "Patrón de código de referencia",
    prefixPlaceholder: "Prefijo (ej. d)",
    applyPattern: "Aplicar patrón",
  },
  status: {
    alreadyPromoted: "Ya promovida",
  },
  viewer: {
    noManifest: "No hay manifiesto disponible para este volumen.",
  },
  action: {
    review: "Revisar promoción",
    promote: "Promover {{count}} entradas",
    back: "Volver a la selección",
  },
  summary: {
    heading: "Resumen de promoción",
    col: {
      fields: "Campos mapeados",
      parent: "Descripción padre",
    },
  },
  toast: {
    success: "{{count}} entradas promovidas exitosamente.",
  },
  error: {
    noParent:
      "No se encontró descripción padre para el volumen {{code}}. Importe primero la descripción del volumen.",
    generic:
      "La promoción falló. Intente de nuevo o contacte a un administrador.",
    noSelection: "Seleccione al menos una entrada para promover.",
    duplicateRefCode: 'El código de referencia "{{code}}" ya existe.',
  },
} as const;
