/**
 * خدمة دمج الفيديو — Video Merger API v2 (عميل فقط — بلا مفاتيح ولا توثيق).
 * القواعد الذهبية للدمج:
 *  - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
 *  - أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → تُستأنف الاستعلامات حتى انتهاء النافذة.
 *  - GET يرد فيه error بدون حقل status → عاملها failed فورًا.
 *  - 404 على المهمة → فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة).
 *  - لا يُنزَّل أي ملف على سيرفرنا — روابط فقط.
 */
import { randomUUID } from "node:crypto";
import { getTask, insertTask, nowIso, updateTask, type TaskRow } from "./turso";
import { safeParse, sleep, effectiveWait, secondsSince, type ToolReply, type Notify } from "./util";
import {
  MERGE_NOT_FOUND_IN_SERVICE,
  MERGE_TOO_FEW,
  MERGE_TOO_MANY,
  MERGER_NOT_CONFIGURED,
  badMergeUrlMessage,
  fmtFailed,
  fmtMergeDone,
  fmtProcessing,
  sanitizeError,
  taskNotReadyMessage,
  taskNotVideoMessage,
} from "./messages";

const rawBase = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
// حماية من القيمة الوهمية الافتراضية "https://xxxxxxxx" في المواصفة
export function mergerConfigured(): boolean {
  const base = mergerBase();
  return base.length > 0 && !base.includes("xxxxxxxx");
}
function mergerBase(): string {
  const base = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  return base.includes("xxxxxxxx") ? "" : base;
}

/** خطأ شبكتنا نحن (fetch/timeout) — مؤقت */
class MergerNetworkError extends Error {}
/** خطأ معلن من الخدمة (HTTP 4xx/5xx) — نهائي */
class MergerServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function mergerFetch(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MergerNetworkError((e as Error).message);
  }
}

async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ================== التحقق الصارم من الروابط ==================

/** رابط http/https مباشر وعام — يرفض localhost والنطاقات الداخلية والعناوين الخاصة */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!h || h === "localhost" || h === "::1" || h === "0.0.0.0") return false;
    if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home")) return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (!h.includes(".") && !h.includes(":")) return false; // اسم مضيف غير مؤهل = داخلي
    return true;
  } catch {
    return false;
  }
}

type Resolution = { ok: true; urls: string[] } | { ok: false; text: string };

/** حل المصادر: روابط task_ids المكتملة أولًا ثم urls المباشرة بنفس ترتيبها */
export async function resolveMergeSources(args: { urls?: string[]; task_ids?: string[] }): Promise<Resolution> {
  const out: string[] = [];
  const taskIds = (args.task_ids ?? []).map(String).filter(Boolean);
  const directUrls = (args.urls ?? []).map(String).filter(Boolean);

  if (taskIds.length + directUrls.length < 2) return { ok: false, text: MERGE_TOO_FEW };
  if (taskIds.length + directUrls.length > 10) return { ok: false, text: MERGE_TOO_MANY };

  for (const tid of taskIds) {
    const t = await getTask(tid);
    if (!t) return { ok: false, text: taskNotReadyMessage(tid, "غير موجودة") };
    if (t.status !== "completed") return { ok: false, text: taskNotReadyMessage(tid, t.status) };
    if (t.type !== "video") return { ok: false, text: taskNotVideoMessage(tid) };
    let urls: string[] = [];
    try { urls = JSON.parse(t.result_urls_json || "[]"); } catch { /* لا روابط */ }
    const first = urls.find((u) => /^https?:\/\//i.test(u));
    if (!first) return { ok: false, text: taskNotReadyMessage(tid, "مكتملة بلا رابط نتيجة") };
    out.push(first);
  }
  for (const u of directUrls) {
    if (!isPublicHttpUrl(u)) return { ok: false, text: badMergeUrlMessage(u) };
    out.push(u);
  }
  return { ok: true, urls: out };
}

// ================== تحليل الحالة (دفاعي) ==================

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAIL_RE = /^(error|failed|failure|cancelled|canceled)$/i;

function parseStatus(raw: unknown): "processing" | "done" | "failed" {
  const s = String(raw ?? "").toLowerCase();
  if (DONE_RE.test(s)) return "done";
  if (FAIL_RE.test(s)) return "failed";
  return "processing";
}

function parseProgress(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100
  const p = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function pickResultUrl(json: Record<string, unknown>, jobId: string): string {
  // فضّل videoUrl ثم downloadUrl — وإن غابا فاضبط رابط الملف مباشرة
  const videoUrl = typeof json.videoUrl === "string" ? json.videoUrl : null;
  const downloadUrl = typeof json.downloadUrl === "string" ? json.downloadUrl : null;
  return videoUrl || downloadUrl || `${mergerBase()}/api/jobs/${jobId}/video`;
}

interface MergerJobStatus {
  status: "processing" | "done" | "failed";
  progress: number;
  url?: string;
  error?: string;
}

/** GET /api/jobs/{id} — يرمي MergerNetworkError / MergerServiceError */
async function fetchJobStatus(jobId: string): Promise<MergerJobStatus> {
  const res = await mergerFetch(`${mergerBase()}/api/jobs/${encodeURIComponent(jobId)}`, {}, 20_000);
  const json = await readBody(res);
  // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  const announcedError = typeof json?.error === "string" && json.error.trim() ? json.error : null;
  if (!res.ok) {
    if (res.status === 404) throw new MergerServiceError(404, MERGE_NOT_FOUND_IN_SERVICE);
    throw new MergerServiceError(res.status, announcedError || `HTTP ${res.status}`);
  }
  if (announcedError && !json?.status) {
    return { status: "failed", progress: 0, error: announcedError };
  }
  const status = parseStatus(json?.status);
  const progress = parseProgress(json?.progress);
  if (status === "done") {
    return { status: "done", progress: 100, url: pickResultUrl(json ?? {}, jobId) };
  }
  if (status === "failed") {
    return { status: "failed", progress: 0, error: announcedError || "فشلت خدمة الدمج" };
  }
  return { status: "processing", progress };
}

// ================== تنفيذ process مرة واحدة فقط ==================

/** قفل في الذاكرة حتى لا يتزامن process مع get_task */
const processInFlight = new Set<string>();

function fireProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      // POST .../process يستغرق ~10-15 ثانية (blocking) — نتجاهل النتيجة ونقرأ الحالة عبر GET
      const res = await mergerFetch(`${mergerBase()}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 240_000);
      if (!res.ok) {
        // فشل معلن (مثل مصدر يرفض التحميل) = فشل حتمي — الحالة ستظهر عبر GET أيضاً
        return;
      }
    } catch {
      // شبكتنا — الحالة تُقرأ لاحقًا عبر GET
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

async function ensureProcessStarted(taskId: string, jobId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const params = safeParse<Record<string, unknown>>(task.params_json, {});
  if (params.processStarted === true) return;
  params.processStarted = true;
  await updateTask(taskId, { params_json: JSON.stringify(params) });
  fireProcess(jobId);
}

// ================== التدفق الرئيسي ==================

type MergeOutcome =
  | { kind: "completed"; url: string }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" };

/** إنشاء مهمة الدمج لدى الخدمة — يرمي MergerNetworkError / MergerServiceError */
async function createMergerJob(videos: string[]): Promise<string> {
  const res = await mergerFetch(`${mergerBase()}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  }, 30_000);
  const json = await readBody(res);
  const jobId = json?.jobId ?? json?.id;
  if (!res.ok || !jobId) {
    const err = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new MergerServiceError(res.status, err);
  }
  return String(jobId);
}

async function pollMergeWindow(taskId: string, jobId: string, windowSec: number, notify?: Notify): Promise<MergeOutcome> {
  const deadline = Date.now() + windowSec * 1000;
  let lastProgress = 0;
  while (true) {
    await sleep(3000);
    let st: MergerJobStatus;
    try {
      st = await fetchJobStatus(jobId);
    } catch (e) {
      if (e instanceof MergerNetworkError) continue; // مؤقت → نستمر بالاستعلام حتى انتهاء النافذة
      if (e instanceof MergerServiceError) {
        return { kind: "failed", reason: e.status === 404 ? MERGE_NOT_FOUND_IN_SERVICE : e.message };
      }
      continue;
    }
    if (st.status === "done") return { kind: "completed", url: st.url! };
    if (st.status === "failed") return { kind: "failed", reason: st.error || "فشلت خدمة الدمج" };
    if (st.progress !== lastProgress) {
      lastProgress = st.progress;
      await updateTask(taskId, { progress: st.progress });
      await notify?.(st.progress, `قيد الدمج… ${st.progress}%`);
    }
    if (Date.now() >= deadline) return { kind: "timeout" };
  }
}

async function attemptMergeCreation(taskId: string, videos: string[], waitSeconds: number | undefined, notify?: Notify): Promise<ToolReply> {
  let jobId: string;
  try {
    jobId = await createMergerJob(videos);
  } catch (e) {
    if (e instanceof MergerNetworkError) {
      // خطأ شبكتنا — المهمة تبقى جارية وتُعاد المحاولة تلقائيًا مع كل get_task (بتهدئة)
      await updateTask(taskId, { error_message: "بانتظار توفر خدمة الدمج…" });
      const t = (await getTask(taskId))!;
      return { text: fmtProcessing(t) };
    }
    // خطأ معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
    const reason = e instanceof MergerServiceError ? e.message : String((e as Error).message);
    await updateTask(taskId, {
      status: "failed",
      error_message: sanitizeError(reason),
      newAttempts: [{ provider: "merger", keyId: "-", keyLabel: "merger", ok: false, errorClass: "provider", error: reason.slice(0, 300), at: nowIso() }],
    });
    return { text: fmtFailed(sanitizeError(reason)), isError: true };
  }

  await updateTask(taskId, { provider: "merger", provider_task_id: jobId, status: "processing", progress: 3 });
  await notify?.(3, "بدأ الدمج…");
  await ensureProcessStarted(taskId, jobId);

  const outcome = await pollMergeWindow(taskId, jobId, effectiveWait(waitSeconds, "merge"), notify);
  if (outcome.kind === "completed") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls: [outcome.url] });
    return { text: fmtMergeDone([outcome.url]) };
  }
  if (outcome.kind === "failed") {
    await updateTask(taskId, { status: "failed", error_message: sanitizeError(outcome.reason) });
    return { text: fmtFailed(sanitizeError(outcome.reason)), isError: true };
  }
  // انتهت النافذة — العميل يتابع بـ get_task
  const t = (await getTask(taskId))!;
  return { text: fmtProcessing(t) };
}

/** أداة merge_videos */
export async function runMerge(args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number }, notify?: Notify): Promise<ToolReply> {
  if (!mergerConfigured()) return { text: MERGER_NOT_CONFIGURED, isError: true };
  const resolved = await resolveMergeSources(args);
  if (!resolved.ok) return { text: resolved.text, isError: true };

  const taskId = randomUUID();
  // سجّل المهمة في قاعدة البيانات أولًا
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: "",
    params: { videos: resolved.urls, task_ids: args.task_ids ?? [], urls: args.urls ?? [], processStarted: false, wait_seconds: args.wait_seconds },
  });
  return await attemptMergeCreation(taskId, resolved.urls, args.wait_seconds, notify);
}

/** get_task لمهمة دمج — يحدّث من الخدمة ويكمل ما ينقص */
export async function refreshMergeTask(task: TaskRow): Promise<ToolReply> {
  if (!mergerConfigured()) {
    const t = (await getTask(task.id)) ?? task;
    return { text: fmtProcessing(t) + "\n\n(خدمة الدمج غير مهيأة بعد على السيرفر — ستُكمل المهمة بمجرد ضبط MERGER_API_BASE)" };
  }

  let jobId = task.provider_task_id;
  if (!jobId) {
    // لم يُنشأ Job بعد — أعد المحاولة بتهدئة ~45 ثانية حتى لا نضغط الخدمة
    if (secondsSince(task.updated_at) < 45) {
      return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    }
    const params = safeParse<{ videos?: string[]; wait_seconds?: number }>(task.params_json, {});
    const videos = (params.videos ?? []).filter((u) => isPublicHttpUrl(u));
    if (videos.length < 2) return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    return await attemptMergeCreation(task.id, videos, params.wait_seconds);
  }

  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن
  await ensureProcessStarted(task.id, jobId);

  let st: MergerJobStatus;
  try {
    st = await fetchJobStatus(jobId);
  } catch (e) {
    if (e instanceof MergerServiceError) {
      const reason = e.status === 404 ? MERGE_NOT_FOUND_IN_SERVICE : e.message;
      await updateTask(task.id, { status: "failed", error_message: sanitizeError(reason) });
      return { text: fmtFailed(sanitizeError(reason)), isError: true };
    }
    // شبكتنا — مؤقت
    return { text: fmtProcessing((await getTask(task.id)) ?? task) };
  }

  if (st.status === "done") {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls: [st.url!] });
    return { text: fmtMergeDone([st.url!]) };
  }
  if (st.status === "failed") {
    await updateTask(task.id, { status: "failed", error_message: sanitizeError(st.error) });
    return { text: fmtFailed(sanitizeError(st.error)), isError: true };
  }
  if (st.progress !== task.progress) await updateTask(task.id, { progress: st.progress });
  return { text: fmtProcessing((await getTask(task.id)) ?? task) };
}
