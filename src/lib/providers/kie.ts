/**
 * محوّل kie.ai — Jobs API الموحد (المزود الأساسي).
 *
 * POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
 * GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *                                     "resultJson":"{\"resultUrls\":[...]}","failMsg":"..."}}
 * انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
 * إذا تغيّر الشكل مستقبلًا نتبع توثيق docs.kie.ai الرسمي — لا اختراع حقول.
 */
import { ProviderError } from "../classify";
import type { ProviderAdapter, ProviderTaskInput } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

function authHeaders(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function readJson(res: Response): Promise<{ code?: number; msg?: string; message?: string; data?: unknown } | null> {
  try {
    return (await res.json()) as { code?: number; msg?: string; message?: string; data?: unknown };
  } catch {
    return null;
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: string, providerModel: string, input: ProviderTaskInput) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/createTask`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ model: providerModel, input }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // انقطاع شبكة/timeout → يُصنَّف مؤقتًا لاحقًا
      throw new ProviderError(undefined, `kie.ai network error: ${(e as Error).message}`);
    }
    const json = await readJson(res);
    const data = json?.data as { taskId?: string } | undefined;
    if (!res.ok || json?.code !== 200 || !data?.taskId) {
      const msg = json?.msg || json?.message || `HTTP ${res.status}`;
      const status = res.ok && typeof json?.code === "number" ? json.code : res.status;
      throw new ProviderError(status, `kie.ai: ${msg}`);
    }
    return { providerTaskId: String(data.taskId) };
  },

  async checkTask(key: string, providerTaskId: string) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
        headers: authHeaders(key),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `kie.ai network error: ${(e as Error).message}`);
    }
    const json = await readJson(res);
    if (!res.ok || (json && typeof json.code === "number" && json.code !== 200)) {
      const status = res.ok && typeof json?.code === "number" ? json.code : res.status;
      throw new ProviderError(status, `kie.ai: ${json?.msg || json?.message || `HTTP ${res.status}`}`);
    }
    const data = (json?.data ?? null) as
      | { state?: string; resultJson?: string; failMsg?: string; progress?: number }
      | null;

    if (!data) {
      // السجل غير موجود بعد — نعامله كخطأ مؤقت يحتمل إعادة المحاولة
      throw new ProviderError(undefined, "kie.ai: record not found yet");
    }

    const state = String(data.state || "waiting");

    if (state === "success") {
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(String(data.resultJson || "{}")) as { resultUrls?: unknown };
        if (Array.isArray(parsed.resultUrls)) {
          urls = parsed.resultUrls.map(String).filter((u) => /^https?:\/\//i.test(u));
        }
      } catch {
        // resultJson ليس JSON صالحًا — نترك القائمة فارغة
      }
      if (!urls.length) {
        // نجاح بلا روابط — نعامله كفشل حقيقي حتى لا يعلّق العميل في الانتظار
        return { status: "failed" as const, error: "kie.ai: success without result URLs" };
      }
      return { status: "completed" as const, urls, progress: 100 };
    }

    if (state === "fail") {
      return { status: "failed" as const, error: String(data.failMsg || "kie.ai: generation failed") };
    }

    // waiting | queuing | generating
    const progress =
      typeof data.progress === "number" && data.progress > 0
        ? Math.min(95, Math.round(data.progress))
        : state === "generating"
          ? 45
          : state === "queuing"
            ? 18
            : 8;
    return { status: "processing" as const, progress };
  },
};
