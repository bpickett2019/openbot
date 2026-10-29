import { defineMessages } from "../../../message";

export const messages = defineMessages("error.billing", {
  "error.billing.lifecycleFailed": "The server plan could not be changed. Refresh Billing and try again.",
  "error.billing.confirmMismatch": "Type the server name to delete it.",
  "error.billing.organizationManaged":
    "An administrator manages this host. Checkout and plan changes are not available.",
  "error.billing.fundingRevoked":
    "Organization funding is inactive. Ask your administrator to restore funding before you start this server.",
  // License errors.
  "error.billing.licenseExists": "This account already has a license. Change its users instead.",
  "error.billing.licenseCurrency": "The license must use the currency of your other plans.",
  "error.billing.licenseUsersInUse": "The license cannot have fewer users than the people who use it now.",
  "error.billing.licensePaymentFailed":
    "The payment for the added users failed. Update the payment method and try again.",
  "error.billing.licenseUnavailable": "Licenses are not available now.",
  "error.billing.noLicense": "This account has no license.",
  // Billing errors that the desktop and web clients make.
  "error.billing.invalidRequest": "The billing request is invalid.",
  "error.billing.invalidResponse": "The billing response is invalid.",
  "error.billing.notStripePage": "The billing page is not a Stripe page.",
});
