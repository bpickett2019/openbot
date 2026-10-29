import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed":
    "Non è stato possibile cambiare il piano del server. Aggiorna Fatturazione e riprova.",
  "error.billing.confirmMismatch": "Scrivi il nome del server per eliminarlo.",
  "error.billing.organizationManaged":
    "Un amministratore gestisce questo host. Il pagamento e le modifiche al piano non sono disponibili.",
  "error.billing.fundingRevoked":
    "Il finanziamento non è attivo. Chiedi all’amministratore di ripristinarlo prima di avviare questo server.",
  "error.billing.licenseExists": "Questo account ha già una licenza. Modifica invece i suoi utenti.",
  "error.billing.licenseCurrency": "La licenza deve usare la valuta degli altri piani.",
  "error.billing.licenseUsersInUse": "La licenza non può avere meno utenti delle persone che la usano ora.",
  "error.billing.licensePaymentFailed":
    "Il pagamento per gli utenti aggiunti non è riuscito. Aggiorna il metodo di pagamento e riprova.",
  "error.billing.licenseUnavailable": "Le licenze non sono disponibili ora.",
  "error.billing.noLicense": "Questo account non ha una licenza.",
  "error.billing.invalidRequest": "La richiesta di fatturazione non è valida.",
  "error.billing.invalidResponse": "La risposta di fatturazione non è valida.",
  "error.billing.notStripePage": "La pagina di fatturazione non è una pagina Stripe.",
} as const satisfies PartialTranslation<typeof source>;
