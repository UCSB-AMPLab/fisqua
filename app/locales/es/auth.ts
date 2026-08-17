/**
 * Spanish translations — auth namespace
 *
 * This locale namespace carries the Spanish strings for the
 * unauthenticated sign-in surface — the email-magic-link form, the
 * "Continue with GitHub" OAuth button, the divider, and the error
 * messages routed through `/login`.
 *
 * Copia bloqueada: la etiqueta del botón
 * "Continuar con GitHub" sigue siendo válida; sólo cambió el destino
 * del enlace (ahora apunta al apex `/auth/github?return_to=<slug>` en
 * lugar del subdominio del cliente). Las cadenas literales, el
 * divisor y los mensajes de error se mantienen sin cambios. Español
 * colombiano: tuteo, sin voseo.
 *
 * @version v0.7.0
 */
export default {
  email_label: "Correo electrónico",
  login_button: "Enviar enlace de acceso",
  success_message: "Revisa tu correo.",
  github_login_button: "Continuar con GitHub",
  or_divider: "o",
  error: {
    expired_link: "Este enlace ha expirado. Solicita uno nuevo.",
    invalid_link: "Este enlace no es válido. Solicita uno nuevo.",
    invalid_email: "Ingresa una dirección de correo válida.",
    oauth_failed: "Error al iniciar sesión con GitHub. Intenta de nuevo.",
    no_email:
      "No se encontró un correo verificado en tu cuenta de GitHub.",
    no_account:
      "No existe una cuenta con el correo de tu GitHub. Pide una invitación al administrador del proyecto.",
  },
  placeholder: "tu@ejemplo.com",
  // Tokens del enlace mágico por correo (`login.*`), distintos de
  // `error.no_account`, que es el mensaje específico de GitHub OAuth.
  login: {
    no_account: "No encontramos una cuenta con este correo.",
  },
  page_title: "Iniciar sesión | Fisqua",
  footer_note:
    "Inicia sesión con GitHub o con el correo de tu cuenta.",
  wrong_workspace: {
    page_title: "Espacio incorrecto | Fisqua",
    eyebrow: "Espacio incorrecto",
    title: "Estás en el lugar equivocado",
    body: "Parece que iniciaste sesión desde un subdominio que no corresponde. Tu cuenta está en otro espacio de trabajo.",
    body_fallback: "Parece que iniciaste sesión desde un subdominio que no corresponde. Tu cuenta está en otro espacio.",
    cta: "Ir a tu espacio {{name}}",
    cta_fallback: "Volver a iniciar sesión",
    sign_out_link: "¿No es tu cuenta? Cerrar sesión",
    comparison_aria: "Comparación de espacios de trabajo",
  },
} as const;
