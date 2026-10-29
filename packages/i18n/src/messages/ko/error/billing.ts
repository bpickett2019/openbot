import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed": "서버 요금제를 변경할 수 없어요. 결제를 새로고침한 후 다시 시도해 주세요.",
  "error.billing.confirmMismatch": "삭제하려면 서버 이름을 입력해 주세요.",
  "error.billing.organizationManaged": "관리자가 이 호스트를 관리해요. 결제와 요금제 변경은 사용할 수 없어요.",
  "error.billing.fundingRevoked":
    "조직의 비용 지원이 비활성 상태예요. 서버를 시작하려면 관리자에게 지원 재개를 요청하세요.",
  "error.billing.licenseExists": "이 계정에는 이미 라이선스가 있어요. 대신 사용자 수를 변경해 주세요.",
  "error.billing.licenseCurrency": "라이선스는 다른 요금제와 같은 통화를 사용해야 해요.",
  "error.billing.licenseUsersInUse": "라이선스 사용자 수는 현재 사용 중인 사람 수보다 적을 수 없어요.",
  "error.billing.licensePaymentFailed":
    "추가한 사용자의 결제에 실패했어요. 결제 수단을 업데이트한 후 다시 시도해 주세요.",
  "error.billing.licenseUnavailable": "지금은 라이선스를 사용할 수 없어요.",
  "error.billing.noLicense": "이 계정에는 라이선스가 없어요.",
  "error.billing.invalidRequest": "결제 요청이 올바르지 않아요.",
  "error.billing.invalidResponse": "결제 응답이 올바르지 않아요.",
  "error.billing.notStripePage": "결제 페이지가 Stripe 페이지가 아니에요.",
} as const satisfies PartialTranslation<typeof source>;
