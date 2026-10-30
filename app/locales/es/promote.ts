/**
 * Spanish translations — promote namespace
 *
 * This locale namespace carries the Spanish strings for the promote
 * surface — the volume picker and the approved-entries table that
 * lets a superadmin lift entries out of the cataloguing tree into the
 * published archival data model.
 *
 * @version v0.8.0
 */
export default {
  heading: {
    title: "Promover entradas",
  },
  superadmin_only: "Solo los superadministradores pueden acceder a esta página.",
  approved_entries_one: "{{count}} entrada aprobada",
  approved_entries_other: "{{count}} entradas aprobadas",
  viewer_placeholder: "Visor IIIF — {{url}}",
  volume: {
    heading: "Seleccionar un volumen",
    empty: "No hay volúmenes con entradas aprobadas listas para promover.",
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
    children_one: "{{count}} entrada hija",
    children_other: "{{count}} entradas hijas",
  },
  refCode: {
    patternLabel: "Patrón de código de referencia",
    prefixPlaceholder: "Prefijo (p. ej., d)",
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
    promote_one: "Promover {{count}} entrada",
    promote_other: "Promover {{count}} entradas",
    back: "Volver a la selección",
  },
  summary: {
    heading: "Resumen de promoción",
    col: {
      fields: "Campos que se copian",
      parent: "Descripción padre",
    },
  },
  toast: {
    success: "Entradas promovidas: {{count}}.",
  },
  error: {
    noParent:
      "No se encontró la descripción padre del volumen {{code}}. Primero importa la descripción del volumen.",
    generic:
      "La promoción falló. Intenta de nuevo o avísale a quien administra el espacio.",
    noSelection: "Selecciona al menos una entrada para promover.",
    duplicateRefCode: 'El código de referencia "{{code}}" ya existe.',
    batch_too_large: "El lote supera el máximo de {{max}}",
    volume_not_found: "No se encontró el volumen: {{id}}",
    no_matching_description:
      "Ninguna descripción coincide con el código de referencia del volumen {{code}}",
    tenant_destination_unset:
      "No se pueden promover las entradas: este espacio de trabajo aún no tiene definido dónde guardar los manifiestos. Pídele al equipo de Fisqua que lo configure.",
  },
} as const;
