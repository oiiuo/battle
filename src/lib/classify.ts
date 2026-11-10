/**
 * تصنيف أخطاء المزودين — دالة موحدة تُقرر الإجراء التالي:
 *  - disabled  : مفتاح مرفوض → تعطيل تلقائي والانتقال للمفتاح التالي
 *  - exhausted : نفاد رصيد → تعليم المفتاح والانتقال للتالي
 *  - provider  : الموديل غير مدعوم لدى هذا المزود → الانتقال للتالي
 *  - params    : خطأ في معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلّه)
 *  - temporary : 429/5xx/شبكة → الانتقال للتالي والمفتاح يبقى سليمًا
 */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** خطأ يرميه محوّل المزود مع حالة HTTP إن وُجدت */
export class ProviderError extends Error {
  constructor(
    public status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// أنماط رفض المفتاح (HTTP 401/403 أو رسائل نصية)
const AUTH_RE =
  /(invalid api key|invalid_api_key|api key is invalid|invalid key|unauthorized|forbidden|authentication|auth failed|identity verification failed)/i;

// أنماط نفاد الرصيد — تُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
const EXHAUSTED_RE =
  /(insufficient|quota|balance|credit|exhausted|out of credits|充值|余额不足|payment required|no remaining)/i;

// أنماط موديل غير مدعوم لدى المزود
const MODEL_RE =
  /(model not found|unsupported model|unknown model|not a valid model|no such model|model does not exist|model is not available)/i;

export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = message || "";
  if (status === 401 || status === 403) return "disabled";
  if (AUTH_RE.test(m)) return "disabled";
  if (status === 402) return "exhausted";
  // نفاد الرصيد قبل فحص 400 (بعض المزودين يرسلونه بحالة 400)
  if (EXHAUSTED_RE.test(m)) return "exhausted";
  if (status === 429 || (status !== undefined && status >= 500)) return "temporary";
  if (MODEL_RE.test(m) && (status === 400 || status === 404 || status === 422)) return "provider";
  if (status === 400 || status === 422) return "params";
  // شبكة/انقطاع/timeout/abort أو أي شيء غير معروف → مؤقت
  return "temporary";
}

/** هل رسالة الخطأ تدل على مشكلة مفتاح/رصيد؟ (تُستخدم للتبديل الصامت في منتصف المهمة) */
export function isKeyOrBalanceError(message: string): boolean {
  return /(insufficient|balance|credit|quota|exhausted|充值|402|401|403|unauthorized|forbidden|invalid api key|invalid key)/i.test(
    message || ""
  );
}

export function errorToClass(e: unknown): { cls: ErrorClass; message: string; status?: number } {
  if (e instanceof ProviderError) {
    return { cls: classifyProviderError(e.status, e.message), message: e.message, status: e.status };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { cls: classifyProviderError(undefined, msg), message: msg };
}
