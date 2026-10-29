import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed":
    "サーバーのプランを変更できませんでした。「お支払い」を更新して、もう一度お試しください。",
  "error.billing.confirmMismatch": "削除するにはサーバー名を入力してください。",
  "error.billing.organizationManaged": "このホストは管理者が管理しています。購入手続きとプラン変更は利用できません。",
  "error.billing.fundingRevoked":
    "組織の費用負担が無効です。このサーバーを起動する前に、管理者に再開を依頼してください。",
  // Billing errors.
  "error.billing.licenseExists": "このアカウントにはすでにライセンスがあります。代わりにユーザー数を変更してください。",
  "error.billing.licenseCurrency": "ライセンスは他のプランと同じ通貨を使う必要があります。",
  "error.billing.licenseUsersInUse": "ライセンスのユーザー数を、現在使っている人数より少なくすることはできません。",
  "error.billing.licensePaymentFailed":
    "追加ユーザーの支払いに失敗しました。支払い方法を更新して、もう一度お試しください。",
  "error.billing.licenseUnavailable": "現在ライセンスは利用できません。",
  "error.billing.noLicense": "このアカウントにはライセンスがありません。",
  "error.billing.invalidRequest": "お支払いのリクエストが無効です。",
  "error.billing.invalidResponse": "お支払いの応答が無効です。",
  "error.billing.notStripePage": "お支払いページが Stripe のページではありません。",
} as const satisfies PartialTranslation<typeof source>;
