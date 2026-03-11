export default {
  status: {
    unstarted: "Sin comenzar",
    in_progress: "En curso",
    segmented: "Segmentado",
    sent_back: "Necesita revision",
    reviewed: "Revisado",
    approved: "Aprobado",
  },
  action: {
    assign: "Asignar",
    approve: "Aprobar",
    send_back: "Rechazar",
    submit_for_review: "Enviar para revision",
    accept_corrections: "Aceptar correcciones",
    unassign: "Desasignar",
  },
  role: {
    lead: "Coordinador",
    cataloguer: "Catalogador",
    reviewer: "Revisor",
  },
  bulk: {
    selected_one: "{{count}} unidad compuesta seleccionada",
    selected_other: "{{count}} uds. seleccionadas",
  },
  dropdown: {
    cataloguer_placeholder: "Catalogador...",
    reviewer_placeholder: "Revisor...",
    unassigned: "Sin asignar",
  },
  dialog: {
    confirm_assign: "Asignar unidad compuesta",
    confirm_unassign: "Desasignar unidad compuesta",
    confirm_approve: "Aprobar unidad compuesta",
    confirm_send_back: "Rechazar unidad compuesta",
  },
} as const;
