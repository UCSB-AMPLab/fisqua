/**
 * Spanish translations — user_admin namespace
 *
 * This locale namespace carries the Spanish strings for the
 * `/admin/users/*` surface: the list's summary line, search, area
 * filter, badge legend and the table of people from the federation;
 * the area names; the role labels and descriptions of the detail
 * page's sections (Platform, Federation, Records management,
 * Authorities, Cataloguing, Digitization, Imports and exports); the
 * project and reviewed-volume tables; the access history; and the
 * notices, tooltips, errors and confirmations of both pages.
 *
 * @version v0.8.0
 */
export default {
  people_count_one: "{{count}} persona en este espacio de trabajo",
  people_count_other: "{{count}} personas en este espacio de trabajo",
  federation_people_count: "{{number}} de otros espacios de {{federation}}",
  search_label: "Buscar por nombre o correo",
  search_placeholder: "Nombre o correo",
  area_label: "Área",
  area_all: "Todas las áreas",
  area_platform: "Plataforma",
  area_federation: "Federación",
  area_records: "Gestión documental",
  area_authorities: "Autoridades",
  area_cataloguing: "Catalogación",
  area_digitization: "Digitalización",
  area_imports: "Importación y exportación",
  legend_area: "Área",
  legend_administers: "administra el área",
  legend_works: "trabaja en el área",
  no_matches: "No se encontró a nadie con esta búsqueda.",
  col_access: "Acceso",
  col_last_active: "Última actividad",
  no_access_yet: "Aún sin acceso",
  badge_reader: "Lector",
  federation_heading: "Personas de {{federation}}",
  federation_intro:
    "Trabajan aquí, pero pertenecen a otros espacios de trabajo de la federación. Sus perfiles se gestionan en su espacio de trabajo de origen.",
  col_home_workspace: "Espacio de trabajo de origen",
  col_access_here: "Acceso aquí",
  federation_role_steward: "Encargado de la federación",
  federation_role_staff: "Equipo de la federación",
  reviews_volumes_one: "revisa {{count}} volumen",
  reviews_volumes_other: "revisa {{count}} volúmenes",
  role_super_admin: "Superadministrador",
  role_user_manager: "Gestor de usuarios",
  role_steward: "Encargado",
  role_staff: "Miembro del equipo",
  role_workspace_admin: "Administrador del espacio de trabajo",
  role_records_admin: "Administrador de registros",
  role_archive_user: "Lector",
  role_authorities_admin: "Administrador de autoridades",
  role_cataloguing_admin: "Administrador de catalogación",
  role_cataloguer: "Catalogador",
  role_digitization_admin: "Administrador de digitalización",
  role_imports_admin: "Administrador de importaciones",
  super_admin_description:
    "Acceso total a todas las áreas, incluyendo gestión de usuarios y configuración del sistema",
  user_manager_description:
    "Invitar usuarios, editar perfiles y asignarlos a proyectos",
  steward_description:
    "Lo otorga un superadministrador. Quien lo tiene se encarga del almacenamiento, del procesamiento de imágenes y de las autoridades compartidas de la federación",
  staff_description:
    "Lo otorga un encargado. Quien lo tiene trabaja en todos los espacios de trabajo de la federación",
  workspace_admin_description:
    "Administrar todas las áreas, los proyectos y los usuarios de este espacio de trabajo",
  records_admin_description:
    "Gestionar descripciones, repositorios y vocabularios",
  archive_user_description:
    "Consultar los registros publicados de este espacio de trabajo, sin editarlos",
  authorities_admin_description:
    "Gestionar entidades, lugares y decisiones pendientes",
  cataloguing_admin_description:
    "Gestionar proyectos, miembros del equipo y promover entradas a descripciones",
  cataloguer_description:
    "Puede ser asignado a proyectos de catalogación y acceder al área de catalogación",
  digitization_admin_description:
    "Gestionar el escáner y los volúmenes que entrega, y asignar revisores",
  imports_admin_description:
    "Importar datos a este espacio de trabajo y descargar sus exportaciones en formatos legibles por máquina",
  scope_platform: "Todos los espacios de trabajo",
  scope_workspace: "Este espacio de trabajo",
  last_active_on: "Última actividad: {{date}}",
  never_active: "Sin actividad registrada",
  joined_on: "Se unió el {{date}}",
  section_profile: "Perfil",
  section_access_history: "Historial de acceso",
  history_role_granted: "{{actor}} le otorgó el rol de {{role}}",
  history_role_revoked: "{{actor}} le retiró el rol de {{role}}",
  history_federation_granted: "{{actor}} le otorgó el rol de {{role}} de la federación",
  history_federation_revoked: "{{actor}} le retiró el rol de {{role}} de la federación",
  history_project_added: "{{actor}} asignó a esta persona a {{project}} con el rol de {{role}}",
  history_project_changed: "{{actor}} cambió el rol de esta persona en {{project}} por el de {{role}}",
  history_project_removed: "{{actor}} retiró a esta persona de {{project}}",
  history_invited: "{{actor}} invitó a esta persona con el rol de {{role}}",
  history_invited_no_role: "{{actor}} invitó a esta persona",
  history_empty: "Aún no hay cambios registrados en el acceso de esta persona.",
  projects_heading: "Proyectos",
  col_project_role: "Rol en el proyecto",
  col_actions: "Acciones",
  project_role_for: "Rol en {{project}}",
  col_volume_reviewed: "Volumen que revisa",
  col_status: "Estado",
  no_reviewed_volumes: "No revisa ningún volumen.",
  reviewers_assigned_note:
    "Los revisores se asignan en la pantalla «Revisión de capturas».",
  self_warning:
    "Esta es tu propia cuenta. Los cambios de rol están deshabilitados para evitar una degradación accidental.",
  non_superadmin_notice:
    "Solo un superadministrador o un administrador del espacio de trabajo puede cambiar los roles.",
  tenant_admin_roles_notice:
    "Puedes otorgar los roles de este espacio de trabajo. Los de superadministrador y gestor de usuarios solo los puede otorgar un superadministrador.",
  self_role_badge_tooltip: "No puedes cambiar tus propios roles",
  platform_role_tooltip: "Solo un superadministrador puede otorgar este rol",
  workspace_role_tooltip:
    "Solo un administrador del espacio de trabajo puede otorgar este rol",
  steward_grant_tooltip:
    "Solo un superadministrador del espacio de trabajo principal de la federación puede otorgar este rol",
  staff_grant_tooltip: "Solo un encargado de la federación puede otorgar este rol",
  invite_role_label: "Rol inicial",
  invite_role_none: "Sin rol",
  invite_role_hint:
    "Sin un rol, la persona invitada solo verá una página de inicio vacía.",
  name_label: "Nombre",
  email_label: "Correo",
  never: "Nunca",
  save_profile: "Guardar perfil",
  save_roles: "Guardar roles",
  assign_to_project: "+ Asignar a proyecto",
  cancel: "Cancelar",
  project_label: "Proyecto",
  role_label: "Rol",
  select_project: "Seleccionar proyecto...",
  select_role: "Seleccionar rol...",
  role_lead: "Responsable",
  role_reviewer: "Revisor",
  assign: "Asignar",
  remove: "Eliminar",
  remove_confirm: "¿Eliminar de {{project}}?",
  no_memberships: "No es miembro de ningún proyecto",
  error_email_required: "El correo es obligatorio",
  error_email_duplicate: "Otro usuario ya tiene este correo",
  error_invalid_request: "Solicitud inválida",
  error_cannot_change_own_roles: "No puedes cambiar tus propios roles",
  error_role_not_assignable:
    "La solicitud incluía un rol que no se puede otorgar desde esta cuenta. No se cambió ningún rol.",
  error_already_member: "Ya es miembro de este proyecto",
  error_roles_changed:
    "Se modificó el acceso de esta persona mientras tenías esta página abierta. Vuelve a cargarla e inténtalo de nuevo.",
  error_last_workspace_admin:
    "Debe quedar al menos un administrador del espacio de trabajo. Primero otórgale ese rol a otra persona.",
  error_operator_no_grants:
    "No puedes cambiar roles durante una suplantación.",
  error_forbidden: "Prohibido",
  success_profile_updated: "Perfil actualizado",
  success_roles_updated: "Roles actualizados",
  success_assigned: "Asignado al proyecto",
  success_role_updated: "Rol actualizado",
  success_removed: "Eliminado del proyecto",
} as const;

// @version v0.8.0
