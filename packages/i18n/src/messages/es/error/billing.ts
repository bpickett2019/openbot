import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed":
    "No se pudo cambiar el plan del servidor. Actualiza Facturación e inténtalo de nuevo.",
  "error.billing.confirmMismatch": "Escribe el nombre del servidor para eliminarlo.",
  "error.billing.organizationManaged": "Un administrador gestiona este host. No se puede pagar ni cambiar de plan.",
  "error.billing.fundingRevoked":
    "La financiación está inactiva. Pide al administrador que la restablezca antes de iniciar este servidor.",
  "error.billing.licenseExists": "Esta cuenta ya tiene una licencia. Cambia sus usuarios en su lugar.",
  "error.billing.licenseCurrency": "La licencia debe usar la moneda de tus otros planes.",
  "error.billing.licenseUsersInUse": "La licencia no puede tener menos usuarios que las personas que la usan ahora.",
  "error.billing.licensePaymentFailed":
    "El pago de los usuarios añadidos falló. Actualiza el método de pago e inténtalo de nuevo.",
  "error.billing.licenseUnavailable": "Las licencias no están disponibles ahora.",
  "error.billing.noLicense": "Esta cuenta no tiene licencia.",
  "error.billing.invalidRequest": "La solicitud de facturación no es válida.",
  "error.billing.invalidResponse": "La respuesta de facturación no es válida.",
  "error.billing.notStripePage": "La página de facturación no es una página de Stripe.",
} as const satisfies PartialTranslation<typeof source>;
