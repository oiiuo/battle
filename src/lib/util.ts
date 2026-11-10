/** أدوات مساعدة مشتركة (بلا اعتماديات دائرية) */

export interface ToolReply {
  text: string;
  isError?: boolean;
}

export type Notify = (progress: number, message: string) => Promise<void> | void;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function secondsSince(iso?: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
}

export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try {
    return (JSON.parse(json || "") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * نافذة الانتظار الفعّالة.
 * على Vercel نُقصّر النافذة إلى 50 ثانية حتى لا يُقتل طلب /mcp عند حد مدة الدالة —
 * العميل يتابع بأداة get_task وفق التصميم غير المتزامن.
 */
export function effectiveWait(requested: number | undefined, type: "image" | "video" | "merge"): number {
  const defaults: Record<typeof type, number> = { image: 90, video: 25, merge: 60 };
  const cap = process.env.VERCEL ? 50 : 240;
  const req = typeof requested === "number" && requested >= 0 ? requested : defaults[type];
  return Math.min(Math.round(req), cap);
}
