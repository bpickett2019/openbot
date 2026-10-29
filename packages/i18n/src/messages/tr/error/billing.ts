import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed": "Sunucu planı değiştirilemedi. Faturalandırma'yı yenileyin ve tekrar deneyin.",
  "error.billing.confirmMismatch": "Silmek için sunucu adını yazın.",
  "error.billing.organizationManaged":
    "Bu ana makineyi bir yönetici yönetir. Ödeme ve plan değişiklikleri kullanılamaz.",
  "error.billing.fundingRevoked":
    "Finansman etkin değil. Bu sunucuyu başlatmadan önce yöneticinizden finansmanı yeniden etkinleştirmesini isteyin.",
  // Masaüstü ve web istemcilerinin oluşturduğu faturalandırma hataları.
  "error.billing.licenseExists": "Bu hesabın zaten bir lisansı var. Bunun yerine kullanıcı sayısını değiştirin.",
  "error.billing.licenseCurrency": "Lisans, diğer planlarınızın para birimini kullanmalıdır.",
  "error.billing.licenseUsersInUse": "Lisans, şu anda onu kullanan kişilerden daha az kullanıcıya sahip olamaz.",
  "error.billing.licensePaymentFailed":
    "Eklenen kullanıcıların ödemesi başarısız oldu. Ödeme yöntemini güncelleyip tekrar deneyin.",
  "error.billing.licenseUnavailable": "Lisanslar şu anda kullanılamıyor.",
  "error.billing.noLicense": "Bu hesabın lisansı yok.",
  "error.billing.invalidRequest": "Faturalandırma isteği geçersiz.",
  "error.billing.invalidResponse": "Faturalandırma yanıtı geçersiz.",
  "error.billing.notStripePage": "Faturalandırma sayfası bir Stripe sayfası değil.",
} as const satisfies PartialTranslation<typeof source>;
