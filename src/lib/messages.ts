/**
 * صياغة الردود العربية لأدوات MCP.
 * القاعدة الذهبية 8: كل رسائل الأدوات بالعربية — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية.
 * القاعدة الذهبية 4: لا يصل للعميل أي ذكر لأخطاء المفاتيح أو الرصيد أبدًا (sanitizeError).
 */
import type { TaskRow } from "./turso";
import { isKeyOrBalanceError } from "./classify";
import { getModels } from "./models";

export const INTERNAL_WAITING = "بانتظار توفر مفتاح صالح…";

export const typeLabel = (t: string) => (t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج");

/** تنقية رسائل الأخطاء: إخفاء أي أثر لمفاتيح/رصيد وأي نص يشبه التوكنات */
export function sanitizeError(raw?: string | null): string {
  const s = String(raw ?? "").slice(0, 300);
  if (isKeyOrBalanceError(s)) return "تعذّر إكمال التوليد حاليًا — سيعاد المحاولة تلقائيًا.";
  const cleaned = s.replace(/[A-Za-z0-9._\-+/=]{20,}/g, "***").trim();
  return cleaned || "خطأ غير معروف";
}

export function fmtImageDone(urls: string[]): string {
  const md = urls.map((u) => `![image](${u})`).join("\n\n");
  let text = `✅ تم توليد الصورة بنجاح\n\n${md}\n\nالرابط المباشر: ${urls[0]}`;
  if (urls.length > 1) {
    text += `\n\nروابط إضافية:\n${urls.slice(1).map((u) => `- ${u}`).join("\n")}`;
  }
  return text;
}

export function fmtVideoDone(urls: string[]): string {
  return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${urls.map((u) => `- ${u}`).join("\n")}`;
}

export function fmtMergeDone(urls: string[]): string {
  return `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

export function fmtProcessing(task: Pick<TaskRow, "id" | "type" | "model" | "progress">): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nالنوع: ${typeLabel(task.type)} | الموديل: ${task.model} | التقدم: ${task.progress}%\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export const fmtFailed = (reason: string) => `❌ فشلت المهمة: ${reason}`;

export const noKeysMessage = (model: string) =>
  `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;

export const MERGE_TOO_FEW =
  "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";

export const MERGE_TOO_MANY =
  "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";

export const MERGER_NOT_CONFIGURED =
  "❌ خدمة الدمج غير مهيأة على السيرفر بعد — يجب ضبط MERGER_API_BASE أولًا من متغيرات البيئة.";

export const MERGE_NOT_FOUND_IN_SERVICE =
  "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";

export const unknownModelMessage = (m: string) =>
  `❌ موديل غير معروف: ${m}. المتاح: ${getModels().map((x) => x.canonical).join(" ، ")}`;

export const unknownTaskMessage = (id: string) => `❌ لم يتم العثور على مهمة بهذا المعرّف: ${id}`;

export const badMergeUrlMessage = (u: string) =>
  `❌ الرابط غير صالح أو غير عام: ${u} — يجب أن يكون رابط فيديو مباشر http/https.`;

export const taskNotReadyMessage = (id: string, status: string) =>
  `❌ المهمة ${id} غير مكتملة (حالتها: ${status}) — لا يمكن دمجها.`;

export const taskNotVideoMessage = (id: string) => `❌ المهمة ${id} ليست مهمة فيديو.`;

/** صياغة جاهزة للعرض حسب حالة المهمة المخزّنة */
export function fmtStored(task: TaskRow): string {
  if (task.status === "completed") {
    let urls: string[] = [];
    try { urls = JSON.parse(task.result_urls_json || "[]"); } catch { /* لا روابط */ }
    if (urls.length) {
      if (task.type === "image") return fmtImageDone(urls);
      if (task.type === "merge") return fmtMergeDone(urls);
      return fmtVideoDone(urls);
    }
    return `✅ المهمة مكتملة — task_id: ${task.id}`;
  }
  if (task.status === "failed") {
    return fmtFailed(sanitizeError(task.error_message));
  }
  // processing / pending
  return fmtProcessing(task);
}

/** قائمة الوسائط المخزّنة بالعربية (الأحدث أولًا) */
export function fmtListMedia(tasks: TaskRow[]): string {
  if (!tasks.length) return "📚 لا توجد وسائط مخزّنة بعد — ابدأ بـ generate_image أو generate_video.";
  const lines = tasks.map((t, i) => {
    let urls: string[] = [];
    try { urls = JSON.parse(t.result_urls_json || "[]"); } catch { /* لا روابط */ }
    const when = t.created_at ? t.created_at.replace("T", " ").slice(0, 19) : "";
    const head = `${i + 1}. [${typeLabel(t.type)}] ${t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⏳"} — ${t.model}${t.prompt ? ` — «${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? "…" : ""}»` : ""} (${when})`;
    const link = t.status === "completed" && urls.length ? `   الرابط: ${urls[0]}` : "";
    const tid = `   task_id: ${t.id}`;
    return `${head}\n${tid}${link}`;
  });
  return `📚 أحدث الوسائط المخزّنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}
