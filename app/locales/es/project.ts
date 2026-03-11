export default {
  settings: {
    project_name: "Nombre del proyecto",
    manifest_url: "URL del manifiesto",
    email: "Correo electronico",
    role: "Rol",
  },
  action: {
    invite_member: "Invitar miembro",
  },
  tab: {
    settings: "Configuracion",
    members: "Miembros",
    volumes: "Unidades compuestas",
  },
  table: {
    volume: "Unidad compuesta",
    images: "Imagenes",
    cataloguer: "Catalogador",
    reviewer: "Revisor",
    status: "Estado",
    last_updated: "Ultima actualizacion",
    entries: "Documentos",
  },
  team: {
    heading: "Progreso del equipo",
    empty: "Aun no hay miembros asignados.",
    completed_of: "{{completed}} / {{total}} completadas",
    entries: "documentos",
  },
  empty: {
    no_volumes: "Aun no hay unidades compuestas en este proyecto.",
  },
  volume_card: {
    first_page_alt: "Primera imagen de {{name}}",
    delete_confirm: "Eliminar esta unidad compuesta? Esta accion no se puede deshacer.",
  },
} as const;
