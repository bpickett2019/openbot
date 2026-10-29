import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed": "无法更改服务器套餐，请刷新账单后重试。",
  "error.billing.confirmMismatch": "请输入服务器名称以确认删除。",
  "error.billing.organizationManaged": "该主机由管理员管理。不提供结账和套餐更改功能。",
  "error.billing.fundingRevoked": "组织资助未启用。请让管理员恢复资助后再启动该服务器。",
  // License errors.
  "error.billing.licenseExists": "该账号已有许可证，请改为更改其用户数。",
  "error.billing.licenseCurrency": "许可证必须使用你其他套餐的币种。",
  "error.billing.licenseUsersInUse": "许可证的用户数不能少于当前正在使用的人数。",
  "error.billing.licensePaymentFailed": "新增用户的付款失败。请更新付款方式后重试。",
  "error.billing.licenseUnavailable": "许可证暂时不可用。",
  "error.billing.noLicense": "该账号没有许可证。",
  // Billing errors that the desktop and web clients make.
  "error.billing.invalidRequest": "账单请求无效。",
  "error.billing.invalidResponse": "账单响应无效。",
  "error.billing.notStripePage": "该账单页面不是 Stripe 页面。",
} as const satisfies PartialTranslation<typeof source>;
