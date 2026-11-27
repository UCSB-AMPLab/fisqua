/**
 * Traducciones al español — namespace operator
 *
 * This locale namespace carries las cadenas para la superficie del
 * operador: navegación de la barra superior, lista de espacios de trabajo,
 * formulario de creación, página de detalle del espacio de trabajo (con
 * su aviso de claves del escáner borradas), el banner
 * de suplantación que se renderiza en los subdominios durante una
 * sesión de "ingresar como", y un conjunto pequeño de errores
 * genéricos del operador.
 *
 * Español colombiano: tuteo, sin voseo. Las formas verbales válidas
 * son `tú prefieres / quieres / sabes / eres / tienes`. NUNCA usar
 * `preferís / querés / sabés / sos / tenés`.
 *
 * @version v0.9.0
 */
export default {
  brand: "Fisqua Operador",
  nav: {
    tenants: "Espacios de trabajo",
    logout: "Cerrar sesión",
    end_impersonation: "Salir de la suplantación",
  },
  tenants_list: {
    page_title: "Espacios de trabajo",
    new_tenant_button: "Nuevo espacio de trabajo",
    columns: {
      slug: "Identificador",
      name: "Nombre",
      kind: "Tipo",
      descriptive_standard: "Estándar",
      capabilities: "Capacidades",
      disabled: "Desactivado",
      actions: "Acciones",
    },
    badges: {
      platform: "[plataforma]",
      disabled: "Desactivado",
    },
    capabilities: {
      crowdsourcing: "Colaboración abierta",
      vocabulary_hub: "Centro de vocabularios",
      publish_pipeline: "Canal de publicación",
      multi_repository: "Multi-repositorio",
      authorities: "Autoridades",
      imports: "Importaciones",
      media_pipeline: "Procesamiento de imágenes",
      digitization: "Digitalización",
    },
    view_link: "Ver",
    empty_state: "Aún no hay espacios de trabajo.",
  },
  // Cadenas de creación y detalle del espacio de trabajo.
  tenant_new: {
    page_title: "Crear espacio de trabajo",
    fields: {
      slug: "Identificador",
      slug_help:
        "Letras minúsculas, dígitos y guiones. Reservados: platform, www, api, admin, app.",
      name: "Nombre visible",
      descriptive_standard: "Estándar descriptivo",
      capabilities_legend: "Capacidades",
      quota_storage_bytes: "Cuota de almacenamiento (bytes)",
      quota_storage_help: "Opcional. Déjalo en blanco para no limitarlo.",
      bootstrap_email: "Correo del primer superadministrador",
      bootstrap_email_help:
        "Le enviaremos a esta persona un enlace mágico para iniciar sesión.",
    },
    submit: "Crear e invitar al superadministrador",
    errors: {
      slug_taken: "Este identificador ya está en uso.",
      slug_reserved: "Este identificador está reservado.",
      slug_invalid:
        "Identificador no válido. Usa letras minúsculas, dígitos y guiones.",
      bootstrap_email_invalid: "Ingresa una dirección de correo válida.",
    },
  },
  tenant_detail: {
    page_title: "Espacio de trabajo: {{name}}",
    sections: {
      overview: "Resumen",
      capabilities: "Capacidades",
      impersonate: "Ingresar como",
      danger_zone: "Zona de riesgo",
      manifests: "Manifiestos IIIF",
      default_locale: "Idioma predeterminado",
      scanner_keys_erased: "Claves del escáner borradas",
    },
    scanner_keys_erased: {
      erased_at: "Fisqua borró la copia que guardaba de las claves del escáner de este espacio de trabajo el {{date}}.",
      revoke:
        "Revoca las dos claves en Backblaze B2. Fisqua solo borró su propia copia, así que las claves siguen activas hasta que las revoques allí.",
      write_key: "Clave de carga",
      read_key: "Clave de lectura",
      pairing:
        "No se podrá vincular ningún equipo Captua con este espacio de trabajo hasta que se guarden claves nuevas.",
    },
    overview: {
      slug: "Identificador",
      kind: "Tipo",
      descriptive_standard: "Estándar descriptivo",
      created_at: "Creado",
      disabled_at: "Desactivado el",
    },
    capabilities_form: {
      submit: "Guardar capacidades",
      success: "Capacidades guardadas.",
      destination_unset:
        "No se puede activar el procesamiento de imágenes: el destino de almacenamiento de este espacio de trabajo no está configurado.",
    },
    default_locale_form: {
      label: "Idioma predeterminado de la interfaz",
      browser: "Según el navegador",
      es: "Español",
      en: "Inglés",
      help: "Quienes no hayan elegido un idioma ven este espacio de trabajo en el idioma que selecciones aquí. Si una persona elige un idioma con los enlaces EN / ES o lo guarda en su configuración, se respeta esa elección.",
      submit: "Guardar idioma predeterminado",
      success: "Idioma predeterminado guardado.",
    },
    manifest_form: {
      public_site_url: "URL del sitio público",
      public_site_name: "Nombre del sitio público",
      provider_name: "Nombre de la entidad responsable",
      provider_url: "URL de la entidad responsable",
      mets_base_url: "URL base de los archivos METS",
      submit: "Guardar configuración de manifiestos",
      success: "Configuración de manifiestos guardada.",
    },
    impersonate_form: {
      role_legend: "¿Con cuál rol quieres iniciar sesión en este espacio de trabajo?",
      reason_label: "Motivo (opcional)",
      reason_help: "Queda registrado en la bitácora de auditoría.",
      submit: "Ingresar como {{role}}",
    },
    soft_disable: {
      title: "Desactivar este espacio de trabajo",
      help:
        "Quien entre al subdominio del espacio de trabajo verá un error 404; desde la consola del operador lo sigues viendo. Para reactivarlo, quita la marca de desactivación.",
      submit: "Desactivar",
      reenable: "Reactivar",
      confirm_disable:
        "Confirmar: ¿desactivar {{slug}}? Escribe el identificador para confirmar.",
    },
  },
  banner: {
    impersonating: "Suplantando {{role}} en {{tenant}}",
    end_button: "Salir de la suplantación",
  },
  errors: {
    not_operator: "No eres un operador de la instancia.",
    no_session: "Inicia sesión para continuar.",
  },
  // Tokens de validación por campo de la acción de crear un espacio de trabajo.
  field_error: {
    name_required: "El nombre es obligatorio",
    email_invalid: "El correo electrónico no es válido",
    slug_format:
      "El identificador debe ir en minúsculas, empezar con una letra y contener solo letras, dígitos y guiones",
    slug_length: "El identificador debe tener entre 1 y 63 caracteres",
    slug_reserved_word: "Este identificador está reservado",
  },
} as const;

// @version v0.9.0
