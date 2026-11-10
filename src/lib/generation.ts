/**
 * منسّق التوليد — قلب المشروع.
 *
 * سلوك التبديل «لا توقف أبدًا»:
 * 1. المرشحون يُجرَّبون بالترتيب التسلسلي الصارم (ترتيب الإضافة) — أول نجاح يربط المهمة بالمزود والمفتاح.
 * 2. كل محاولة (نجاح/فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 * 3. فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي —
 *    العميل يرى «قيد المعالجة» فقط ولا يعلم بأي تبديل.
 * 4. فشل الإنشاء على كل المفاتيح → المهمة تبقى processing «بانتظار توفر مفتاح صالح…»
 *    وتُعاد محاولتها تلقائيًا مع كل get_task (بتهدئة ~45 ثانية).
 * 5. نموذج الذكاء الاصطناعي لا يرى أبدًا خطأ مفتاح أو رصيد — التبديل صامت من وجهة نظره.
 * 6. روابط فقط — لا يُنزَّل أي ملف وسائط على سيرفرنا إطلاقًا.
 */
import { randomUUID } from "node:crypto";
import { bumpKeyCounters, getKey, getKeyPool, getTask, insertTask, listRecentTasks, nowIso, updateTask, type KeyRow } from "./turso";
import { classifyProviderError, errorToClass, isKeyOrBalanceError, type ErrorClass } from "./classify";
import { normalizeModel, getModels, type ModelDef } from "./models";
import { getAdapter, type ProviderAdapter, type ProviderTaskInput } from "./providers";
import { effectiveWait, safeParse, secondsSince, sleep, type Notify, type ToolReply } from "./util";
import { refreshMergeTask } from "./merger";
import {
  fmtFailed,
  fmtImageDone,
  fmtListMedia,
  fmtProcessing,
  fmtStored,
  fmtVideoDone,
  INTERNAL_WAITING,
  noKeysMessage,
  sanitizeError,
  unknownModelMessage,
  unknownTaskMessage,
} from "./messages";

// ================== بناء معطيات المزود ==================

function buildProviderInput(type: "image" | "video", args: Record<string, unknown>): ProviderTaskInput {
  if (type === "image") {
    return {
      prompt: args.prompt,
      // "auto" لا نرسله — نترك المزود يستخدم افتراضه
      ...(args.aspect_ratio && args.aspect_ratio !== "auto" ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution && args.resolution !== "auto" ? { resolution: args.resolution } : {}),
      ...(args.background && args.background !== "auto" ? { background: args.background } : {}),
      ...(args.output_format && args.output_format !== "auto" ? { output_format: args.output_format } : {}),
    };
  }
  return {
    prompt: args.prompt,
    ...(args.image_url ? { image_url: args.image_url } : {}),
    ...(args.aspect_ratio && args.aspect_ratio !== "auto" ? { aspect_ratio: args.aspect_ratio } : {}),
    ...(args.resolution && args.resolution !== "auto" ? { resolution: args.resolution } : {}),
    ...(args.enable_audio !== undefined ? { enable_audio: args.enable_audio } : {}),
    ...(args.duration ? { duration: args.duration } : {}),
  };
}

// ================== الاستعلام عن الحالة ==================

type Outcome =
  | { kind: "completed"; urls: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "key_dead"; cls: ErrorClass; reason: string }
  | { kind: "processing"; progress: number }
  | { kind: "timeout" };

/** استعلام واحد عن حالة مهمة مربوطة بمزود — يحوّل الأخطاء إلى نتائج مفهومة */
async function checkOnce(adapter: ProviderAdapter, apiKey: string, providerTaskId: string): Promise<Outcome> {
  let st: Awaited<ReturnType<ProviderAdapter["checkTask"]>>;
  try {
    st = await adapter.checkTask(apiKey, providerTaskId);
  } catch (e) {
    const { cls, message } = errorToClass(e);
    if (cls === "temporary") return { kind: "processing", progress: 0 }; // تجاهل — نستمر الاستعلام
    if (cls === "disabled" || cls === "exhausted") return { kind: "key_dead", cls, reason: message };
    return { kind: "failed", reason: message };
  }
  if (st.status === "completed") {
    const urls = (st.urls ?? []).filter((u) => /^https?:\/\//i.test(u));
    if (!urls.length) return { kind: "failed", reason: "اكتمل التوليد دون روابط نتيجة" };
    return { kind: "completed", urls };
  }
  if (st.status === "failed") {
    const reason = st.error || "فشل المزود";
    // فشل مفتاح/رصيد في منتصف المهمة → تبديل صامت
    if (isKeyOrBalanceError(reason)) {
      return { kind: "key_dead", cls: classifyProviderError(undefined, reason), reason };
    }
    return { kind: "failed", reason };
  }
  return { kind: "processing", progress: Math.max(0, Math.min(95, st.progress ?? 0)) };
}

/** نافذة انتظار مع بث تقدم كل ~3 ثوانٍ حتى اكتمال النتيجة أو انتهاء النافذة */
async function pollWindow(
  taskId: string,
  adapter: ProviderAdapter,
  apiKey: string,
  providerTaskId: string,
  windowSec: number,
  notify?: Notify
): Promise<Outcome> {
  const deadline = Date.now() + windowSec * 1000;
  let lastProgress = -1;
  while (true) {
    await sleep(3000);
    const outcome = await checkOnce(adapter, apiKey, providerTaskId);
    if (outcome.kind !== "processing") return outcome;
    if (outcome.progress !== lastProgress) {
      lastProgress = outcome.progress;
      await updateTask(taskId, { progress: Math.max(1, outcome.progress) });
      await notify?.(Math.max(1, outcome.progress), `قيد التوليد… ${Math.max(1, outcome.progress)}%`);
    }
    if (Date.now() >= deadline) return { kind: "timeout" };
  }
}

function doneMessage(type: "image" | "video", urls: string[]): string {
  return type === "image" ? fmtImageDone(urls) : fmtVideoDone(urls);
}

/** يسجّل نتائج الاستعلام في القاعدة — يعيد ردًا جاهزًا إذا كانت النتيجة نهائية */
async function handleOutcome(
  taskId: string,
  type: "image" | "video",
  provider: string,
  keyId: string,
  keyLabel: string,
  outcome: Outcome
): Promise<ToolReply | null> {
  if (outcome.kind === "completed") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls: outcome.urls });
    return { text: doneMessage(type, outcome.urls) };
  }
  if (outcome.kind === "failed") {
    const reason = sanitizeError(outcome.reason);
    await updateTask(taskId, { status: "failed", error_message: reason });
    return { text: fmtFailed(reason), isError: true };
  }
  if (outcome.kind === "key_dead") {
    // سجّل فشل المفتاح وسجل المحاولة — ثم انتقل للمفتاح التالي (إعادة إنشاء بنفس task_id)
    await bumpKeyCounters(keyId, { ok: false, errorClass: outcome.cls, error: outcome.reason });
    await updateTask(taskId, {
      newAttempts: [{ provider, keyId, keyLabel, ok: false, errorClass: outcome.cls, error: outcome.reason.slice(0, 300), at: nowIso() }],
    });
    return null;
  }
  return null;
}

// ================== المحاولة الرئيسية ==================

/**
 * يجرّب المرشحين بالترتيب حتى نجاح الإنشاء ثم ينتظر داخل النافذة.
 * waitWindow=false → استعلام واحد فقط بعد الإنشاء (لمسار get_task حتى لا نحبس العميل).
 */
async function attemptGeneration(
  taskId: string,
  def: ModelDef,
  args: Record<string, unknown>,
  pool: KeyRow[],
  notify?: Notify,
  waitWindow = true
): Promise<ToolReply> {
  // هذا المسار يُستدعى للتوليد فقط (صورة/فيديو) — الدمج له مساره الخاص في merger.ts
  const type = def.type as "image" | "video";
  let sawNonProviderFailure = false;

  for (const key of pool) {
    const adapter = getAdapter(key.provider);
    const providerModel = def.providerModel[key.provider] ?? def.canonical;
    const at = nowIso();
    try {
      let providerTaskId: string | null = null;
      let syncUrls: string[] | null = null;

      if (type === "image" && adapter.createImageSync) {
        const sync = await adapter.createImageSync(key.api_key, providerModel, buildProviderInput(type, args));
        syncUrls = sync.urls;
      } else {
        const created = await adapter.createTask(key.api_key, providerModel, buildProviderInput(type, args));
        providerTaskId = created.providerTaskId;
      }

      // نجاح الإنشاء — ربط المهمة بالمزود والمفتاح
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 2,
        error_message: null,
      });
      await bumpKeyCounters(key.id, { ok: true });
      await updateTask(taskId, {
        newAttempts: [{ provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at }],
      });
      await notify?.(2, "بدأ التوليد على المزود…");

      if (syncUrls) {
        // صور متزامنة (CometAPI تعيد الرابط فورًا)
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: syncUrls });
        return { text: doneMessage(type, syncUrls) };
      }

      if (!waitWindow) {
        const outcome = await checkOnce(adapter, key.api_key, providerTaskId!);
        const handled = await handleOutcome(taskId, type, key.provider, key.id, key.label, outcome);
        if (handled) return handled;
        if (outcome.kind === "key_dead") {
          sawNonProviderFailure = true;
          continue; // المفتاح التالي بالترتيب — نفس task_id
        }
        // processing/timeout → رسالة جارية
        return { text: fmtProcessing((await getTask(taskId))!) };
      }

      const outcome = await pollWindow(
        taskId,
        adapter,
        key.api_key,
        providerTaskId!,
        effectiveWait(args.wait_seconds as number | undefined, type),
        notify
      );
      const handled = await handleOutcome(taskId, type, key.provider, key.id, key.label, outcome);
      if (handled) return handled;
      if (outcome.kind === "key_dead") {
        sawNonProviderFailure = true;
        continue; // إعادة إنشاء نفس المهمة على المفتاح التالي — العميل لا يرى شيئًا
      }
      if (outcome.kind === "failed") {
        return { text: fmtFailed(sanitizeError(outcome.reason)), isError: true };
      }
      // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing مع task_id
      return { text: fmtProcessing((await getTask(taskId))!) };
    } catch (e) {
      const { cls, message } = errorToClass(e);
      await bumpKeyCounters(key.id, { ok: false, errorClass: cls, error: message });
      await updateTask(taskId, {
        newAttempts: [{ provider: key.provider, keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: message.slice(0, 300), at: nowIso() }],
      });
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        const reason = sanitizeError(message);
        await updateTask(taskId, { status: "failed", error_message: reason });
        return { text: fmtFailed(reason), isError: true };
      }
      if (cls !== "provider") sawNonProviderFailure = true;
      // وإلا → انتقل للمفتاح التالي بصمت
      continue;
    }
  }

  // فشل على كل المفاتيح
  if (!sawNonProviderFailure && pool.length > 0) {
    // كل المحاولات فشلت لأن الموديل غير مدعوم — حالة دائمة لا يصلحها تبديل المفاتيح
    const reason = "الموديل غير مدعوم لدى المزودين المتاحين حاليًا — تحقق من اسم الموديل أو أضف مزودًا يدعمه.";
    await updateTask(taskId, { status: "failed", error_message: reason });
    return { text: fmtFailed(reason), isError: true };
  }
  // المهمة تبقى processing «بانتظار توفر مفتاح صالح…» وتُعاد مع كل get_task
  await updateTask(taskId, { status: "processing", error_message: INTERNAL_WAITING });
  return { text: fmtProcessing((await getTask(taskId))!) };
}

// ================== نقاط الدخول للأدوات ==================

/** أدوات generate_image / generate_video */
export async function runGeneration(type: "image" | "video", args: Record<string, unknown>, notify?: Notify): Promise<ToolReply> {
  // المخطط يضبط الافتراضي لدى عملاء MCP — نضيف هنا احتياطًا دفاعيًا إن نُسيت
  const def: ModelDef | undefined = normalizeModel(args?.model as string | undefined) ?? getModels().find((m) => m.type === type);
  if (!def) return { text: unknownModelMessage(String(args?.model ?? "")), isError: true };

  const pool = await getKeyPool(def.providers);
  if (!pool.length) return { text: noKeysMessage(def.canonical), isError: true };

  const taskId = randomUUID();
  // سجّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt: String(args?.prompt ?? ""),
    params: args ?? {},
  });

  return await attemptGeneration(taskId, def, args ?? {}, pool, notify, true);
}

/** أداة get_task — تُحدّث المهمة الجارية حية من المزود/الخدمة ثم تعيد صياغة عربية */
export async function refreshTask(taskId: string): Promise<ToolReply> {
  const task = await getTask(taskId);
  if (!task) return { text: unknownTaskMessage(taskId), isError: true };
  if (task.status === "completed" || task.status === "failed") {
    return { text: fmtStored(task), isError: task.status === "failed" };
  }
  if (task.type === "merge") {
    return refreshMergeTask(task);
  }

  // مهمة توليد جارية بلا مزود مرتبط — بانتظار مفتاح صالح → أعد المحاولة بتهدئة ~45 ثانية
  if (!task.provider_task_id || !task.provider) {
    if (secondsSince(task.updated_at) < 45) {
      return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    }
    const def = normalizeModel(task.model);
    const pool = def ? await getKeyPool(def.providers) : [];
    if (!def || !pool.length) return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    return await attemptGeneration(task.id, def, safeParse<Record<string, unknown>>(task.params_json, {}), pool, undefined, false);
  }

  const adapter = getAdapter(task.provider);
  const key = task.key_id ? await getKey(task.key_id) : null;

  // مفتاح المهمة صار disabled أو حُذف يدويًا → أعد الإنشاء على المسبح الحالي
  if (!key || key.status === "disabled") {
    if (secondsSince(task.updated_at) < 45) return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    const def = normalizeModel(task.model);
    const pool = def ? await getKeyPool(def.providers) : [];
    if (!def || !pool.length) return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    return await attemptGeneration(task.id, def, safeParse<Record<string, unknown>>(task.params_json, {}), pool, undefined, false);
  }

  const outcome = await checkOnce(adapter, key.api_key, task.provider_task_id);
  if (outcome.kind === "completed") {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls: outcome.urls });
    return { text: doneMessage(task.type as "image" | "video", outcome.urls) };
  }
  if (outcome.kind === "failed") {
    const reason = sanitizeError(outcome.reason);
    await updateTask(task.id, { status: "failed", error_message: reason });
    return { text: fmtFailed(reason), isError: true };
  }
  if (outcome.kind === "key_dead") {
    // تبديل صامت في منتصف المهمة: سجّل الفشل وأعد إنشاء نفس المهمة بنفس task_id
    await bumpKeyCounters(key.id, { ok: false, errorClass: outcome.cls, error: outcome.reason });
    await updateTask(task.id, {
      newAttempts: [{ provider: task.provider, keyId: key.id, keyLabel: key.label, ok: false, errorClass: outcome.cls, error: outcome.reason.slice(0, 300), at: nowIso() }],
      provider: null,
      provider_task_id: null,
      key_id: null,
      status: "processing",
    });
    const def = normalizeModel(task.model);
    const pool = def ? await getKeyPool(def.providers) : [];
    if (!def || !pool.length) return { text: fmtProcessing((await getTask(task.id)) ?? task) };
    return await attemptGeneration(task.id, def, safeParse<Record<string, unknown>>(task.params_json, {}), pool, undefined, false);
  }
  // processing → حدّث التقدم وأعد الصياغة
  if (outcome.kind === "processing" && outcome.progress > task.progress) await updateTask(task.id, { progress: outcome.progress });
  return { text: fmtProcessing((await getTask(task.id)) ?? task) };
}

/** أداة list_media — أحدث الوسائط المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) */
export async function listMedia(args: { type?: string; status?: string; limit?: number }): Promise<ToolReply> {
  const limit = Math.min(Math.max(Math.round(Number(args?.limit ?? 10)) || 10, 1), 50);
  const type = ["image", "video", "merge"].includes(String(args?.type)) ? String(args?.type) : undefined;
  const status = ["completed", "failed", "processing"].includes(String(args?.status)) ? String(args?.status) : undefined;
  const tasks = await listRecentTasks(limit, { type, status });
  return { text: fmtListMedia(tasks) };
}
