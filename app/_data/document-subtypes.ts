/**
 * Document Subtypes Seed
 *
 * Default per-project list of document subtype labels ("Escritura",
 * "Poder", and other archival document categories). Acts as the seed
 * list each new project starts with; projects can customise the list
 * in the settings page. The `OTHER_SUBTYPE_SENTINEL` marks the entry
 * that unlocks a free-text subtype field in the outline.
 *
 * @version v0.3.0
 */
export const DEFAULT_DOCUMENT_SUBTYPES: readonly string[] = [
  "Aprobación",
  "Arrendamiento",
  "Asiento",
  "Carta",
  "Causa",
  "Censo",
  "Cobranza",
  "Concierto",
  "Cuenta",
  "Demanda",
  "Depósito",
  "Escritura",
  "Fianza",
  "Nombramiento",
  "Obligación",
  "Parte de título",
  "Pedimento",
  "Poder",
  "Recibo",
  "Reconocimiento",
  "Registro",
  "Renunciación",
  "Revocación",
  "Revocatoria",
  "Testamento",
  "Testimonio",
  "Transacción",
  "Traspaso",
  "Venta",
] as const;

/**
 * Sentinel value surfaced in the two-step type picker's document branch
 * as a free-text escape hatch. Not stored verbatim -- the cataloguer's
 * typed value replaces it before the reducer commits. Exported so UI
 * code and tests share one spelling.
 */
export const OTHER_SUBTYPE_SENTINEL = "OTRO";

