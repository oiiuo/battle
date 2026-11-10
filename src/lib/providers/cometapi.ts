/**
 * محوّل CometAPI — المزود الثاني.
 *
 * الصور: نقطة متوافقة مع OpenAI تعيد النتيجة فورًا:
 *   POST /v1/images/generations → {data:[{url|b64_json}]}
 *
 * الفيديو: مهام غير متزامنة وفق النمط الحالي الموثق لدى CometAPI:
 *   POST /v1/videos/generations → {request_id}
 *   GET  /v1/videos/{request_id} → {data:{status:"SUCCESS"|..., data:{video:{url}}}}
 * (الأشكال دفاعية: نفحص عدة أماكن محتملة للرابط بدل الاعتماد على حقل واحد)
 */
import { ProviderError } from "../classify";
import type { ProviderAdapter, ProviderTaskInput } from "./types";

const BASE = "https://api.cometapi.com/v1";

function authHeaders(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickError(json: Record<string, unknown> | null): string {
  const msg = (json?.error ?? json?.message ?? json?.msg) as unknown;
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object" && typeof (msg as { message?: unknown }).message === "string") {
    return (msg as { message: string }).message;
  }
  return "CometAPI error";
}

/** استخراج روابط الفيديو من شكل استجابة متداخل (data.data.video.url ...) */
function extractVideoUrls(json: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth = 0) => {
    if (depth > 4 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node) && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) out.push(obj.url);
      if (typeof obj.video_url === "string") out.push(obj.video_url);
      Object.values(obj).forEach((v) => visit(v, depth + 1));
    }
  };
  visit(json);
  return [...new Set(out)];
}

export const cometapiAdapter: ProviderAdapter = {
  async createImageSync(key, providerModel, input: ProviderTaskInput) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/images/generations`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          // معطيات اختيارية نمررها كما هي إن وُجدت
          ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.background ? { background: input.background } : {}),
          ...(input.output_format ? { output_format: input.output_format } : {}),
          response_format: "url",
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `CometAPI network error: ${(e as Error).message}`);
    }
    const json = await readJson(res);
    if (!res.ok) throw new ProviderError(res.status, `CometAPI: ${pickError(json)}`);
    const arr = (json?.data as unknown) ?? [];
    const urls: string[] = [];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const it = item as { url?: string; b64_json?: string };
        if (it?.url && /^https?:\/\//i.test(it.url)) urls.push(it.url);
        else if (it?.b64_json) urls.push(`data:image/png;base64,${it.b64_json}`);
      }
    }
    if (!urls.length) throw new ProviderError(res.status, "CometAPI: no image URLs in response");
    return { urls };
  },

  async createTask(key, providerModel, input: ProviderTaskInput) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/videos/generations`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          ...(input.image_url ? { image: input.image_url } : {}),
          ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.duration ? { duration: input.duration } : {}),
          ...(input.enable_audio !== undefined ? { enable_audio: input.enable_audio } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `CometAPI network error: ${(e as Error).message}`);
    }
    const json = await readJson(res);
    if (!res.ok) throw new ProviderError(res.status, `CometAPI: ${pickError(json)}`);
    // المعرّف قد يأتي بأسماء مختلفة: request_id / id / task_id / data.id
    const root = json ?? {};
    const dataObj = (root.data ?? undefined) as { request_id?: string; id?: string } | undefined;
    const id =
      (root.request_id as string) ??
      (root.id as string) ??
      (root.task_id as string) ??
      dataObj?.request_id ??
      dataObj?.id;
    if (!id) throw new ProviderError(res.status, "CometAPI: no task id in response");
    return { providerTaskId: String(id) };
  },

  async checkTask(key, providerTaskId) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/videos/${encodeURIComponent(providerTaskId)}`, {
        headers: authHeaders(key),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `CometAPI network error: ${(e as Error).message}`);
    }
    const json = await readJson(res);
    if (res.status === 404) {
      throw new ProviderError(404, "CometAPI: task not found");
    }
    if (!res.ok) throw new ProviderError(res.status, `CometAPI: ${pickError(json)}`);

    const data = (json?.data ?? {}) as Record<string, unknown>;
    const status = String(data.status ?? json?.status ?? "").toLowerCase();

    if (["success", "succeeded", "completed", "complete", "done", "finished"].includes(status)) {
      const urls = extractVideoUrls(json ?? {});
      if (!urls.length) return { status: "failed" as const, error: "CometAPI: success without video URL" };
      return { status: "completed" as const, urls, progress: 100 };
    }
    if (["failed", "fail", "error", "cancelled", "canceled"].includes(status)) {
      return { status: "failed" as const, error: pickError(json) };
    }
    // queued / in_progress / processing ...
    return { status: "processing" as const, progress: 40 };
  },
};
