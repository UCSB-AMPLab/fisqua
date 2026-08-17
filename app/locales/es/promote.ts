/**
 * Spanish translations — promote namespace
 *
 * This locale namespace carries the Spanish strings for the promote
 * surface — the volume picker and the approved-entries table that
 * lets a superadmin lift entries out of the cataloguing tree into the
 * published archival data model.
 *
 * @version v0.7.0
 */
export default {
  heading: {
    title: "Promover entradas",
  },
  superadmin_only: "Solo superadministradores pueden acceder a esta página.",
  approved_entries_one: "{{count}} entrada aprobada",
  approved_entries_other: "{{count}} entradas aprobadas",
  viewer_placeholder: "Visor IIIF — {{url}}",
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
      "La promoción falló. Intenta de nuevo o contacta a un administrador.",
    noSelection: "Seleccione al menos una entrada para promover.",
    duplicateRefCode: 'El código de referencia "{{code}}" ya existe.',
    batch_too_large: "El lote supera el máximo de {{max}}",
    volume_not_found: "No se encontró la unidad: {{id}}",
    no_matching_description:
      "Ninguna descripción coincide con el código de referencia {{code}}",
  },
} as const;
