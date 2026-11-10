/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP الخالص.
 *
 * قرار معماري: نحوّل libsql:// إلى https:// حتى يعمل الاتصال عبر HTTP/fetch
 * (إلزامي للتوافق مع Vercel serverless حيث لا يوجد socket دائم ولا ملفات SQLite محلية).
 * الجداول تُنشأ عند أول وصول عبر CREATE TABLE IF NOT EXISTS — بلا أداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

export function getTursoClient(): Client {
  if (!_client) {
    const raw = (process.env.TURSO_DATABASE_URL || "").trim();
    if (!raw) throw new Error("TURSO_DATABASE_URL غير مضبوط في متغيرات البيئة");
    // HTTP الخالص بدل WebSocket — متوافق مع serverless
    const url = raw.replace(/^libsql:\/\//, "https://");
    const token = (process.env.TURSO_AUTH_TOKEN || "").trim();
    _client = createClient({ url, authToken: token || undefined });
  }
  return _client;
}

export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const c = getTursoClient();
      await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
    })().catch((e) => {
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getTursoClient().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ================== الأنواع ==================

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptRec {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  params_json?: string;
  newAttempts?: AttemptRec[];
}

type DbRecord = Record<string, unknown>;

const num = (v: unknown, d = 0) => (v === null || v === undefined ? d : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function asTask(r: DbRecord): TaskRow {
  return {
    id: String(r.id),
    provider: str(r.provider),
    provider_task_id: str(r.provider_task_id),
    key_id: str(r.key_id),
    model: String(r.model),
    type: String(r.type) as TaskRow["type"],
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status) as TaskRow["status"],
    progress: num(r.progress),
    result_urls_json: str(r.result_urls_json),
    error_message: str(r.error_message),
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: str(r.completed_at),
  };
}

function asKey(r: DbRecord): KeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider) as KeyRow["provider"],
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status ?? "active") as KeyRow["status"],
    usage_count: num(r.usage_count),
    success_count: num(r.success_count),
    fail_count: num(r.fail_count),
    last_used_at: str(r.last_used_at),
    last_checked_at: str(r.last_checked_at),
    last_error: str(r.last_error),
    created_at: String(r.created_at ?? ""),
  };
}

// ================== المهام ==================

export async function insertTask(t: {
  id: string;
  model: string;
  type: TaskRow["type"];
  prompt: string;
  params: unknown;
  status?: TaskRow["status"];
}): Promise<void> {
  await ensureSchema();
  const now = nowIso();
  // نضبط الطوابع الزمنية صراحةً بدقة المللي ثانية (وليس datetime('now') بدقة الثانية)
  await getTursoClient().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    args: [t.id, t.model, t.type, t.prompt ?? "", JSON.stringify(t.params ?? {}), t.status ?? "processing", now, now],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getTursoClient().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  return res.rows.length ? asTask(res.rows[0] as DbRecord) : null;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.result_urls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.result_urls)); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params_json !== undefined) { sets.push("params_json = ?"); args.push(patch.params_json); }

  // إضافة المحاولات الجديدة إلى السجل (قراءة-تعديل-كتابة)
  if (patch.newAttempts?.length) {
    const cur = await getTask(id);
    let arr: AttemptRec[] = [];
    try { arr = JSON.parse(cur?.attempts_json || "[]"); } catch { /* سجل تالف → نبدأ من جديد */ }
    arr.push(...patch.newAttempts);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(arr));
  }

  // ضبط completed_at تلقائيًا عند الاكتمال
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, ?)");
    args.push(nowIso());
  }
  // إلغاء الاكتمال إذا عادت المهمة للمعالجة (تبديل مفتاح في منتصف المهمة)
  if (patch.status === "processing") {
    sets.push("completed_at = NULL");
  }
  sets.push("updated_at = ?");
  args.push(nowIso());

  args.push(id);
  await getTursoClient().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit: number,
  filters: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters.status) { where.push("status = ?"); args.push(filters.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, updated_at DESC LIMIT ?`;
  args.push(limit);
  const res = await getTursoClient().execute({ sql, args });
  return res.rows.map((r) => asTask(r as DbRecord));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const res = await getTursoClient().execute(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status IN ('processing', 'pending') THEN 1 ELSE 0 END), 0) AS processing
     FROM tasks`
  );
  const r = res.rows[0] as DbRecord | undefined;
  return { total: num(r?.total), completed: num(r?.completed), failed: num(r?.failed), processing: num(r?.processing) };
}

/** حذف المهام (لتنظيف آثار الاختبار) */
export async function deleteTasks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ensureSchema();
  await getTursoClient().execute({
    sql: `DELETE FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
}

// ================== المفاتيح ==================

/**
 * إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا.
 * المفاتيح الطويلة: أول 7 + 8 نقاط + آخر 4 — القصيرة: أول 3 + 4 نقاط.
 */
export function maskKey(k: string): string {
  if (k.length > 11) return k.slice(0, 7) + "••••••••" + k.slice(-4);
  if (k.length > 6) return k.slice(0, 3) + "••••";
  return "••••";
}

export async function insertKey(input: { id: string; provider: string; label: string; api_key: string }): Promise<void> {
  await ensureSchema();
  // نضبط created_at صراحةً بدقة المللي ثانية لضمان الترتيب التسلسلي الصارم
  // (لو أُضيف مفتاحان في نفس الثانية لكان الترتيب حسب id العشوائي)
  await getTursoClient().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, usage_count, success_count, fail_count, created_at)
          VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?)`,
    args: [input.id, input.provider, input.label ?? "", input.api_key, nowIso()],
  });
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const res = await getTursoClient().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => asKey(r as DbRecord));
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const res = await getTursoClient().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  return res.rows.length ? asKey(res.rows[0] as DbRecord) : null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<KeyRow | null> {
  await ensureSchema();
  const res = await getTursoClient().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return res.rows.length ? asKey(res.rows[0] as DbRecord) : null;
}

export async function setKeyStatus(id: string, status: KeyRow["status"], lastError?: string | null): Promise<void> {
  await ensureSchema();
  const sets = ["status = ?", "last_checked_at = ?"];
  const args: InValue[] = [status, nowIso()];
  if (lastError !== undefined) { sets.push("last_error = ?"); args.push(lastError); }
  args.push(id);
  await getTursoClient().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTursoClient().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

/**
 * تحديث عدّادات المفتاح — تُحدَّث دائمًا مع كل محاولة (نجاح أو فشل).
 * التصنيف يحدد الانتقال التلقائي للحالة: disabled / exhausted.
 */
export async function bumpKeyCounters(
  id: string,
  opts: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  await ensureSchema();
  const now = nowIso();
  const errTrunc = opts.error ? String(opts.error).slice(0, 300) : null;
  const statusSet =
    opts.ok
      ? ""
      : opts.errorClass === "disabled"
        ? ", status = 'disabled'"
        : opts.errorClass === "exhausted"
          ? ", status = 'exhausted'"
          : "";
  await getTursoClient().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ${opts.ok ? 1 : 0},
            fail_count = fail_count + ${opts.ok ? 0 : 1},
            last_used_at = ?,
            last_checked_at = ?,
            last_error = COALESCE(?, last_error)${statusSet}
          WHERE id = ?`,
    args: [now, now, errTrunc, id],
  });
}

/**
 * مسبح المفاتيح بالترتيب التسلسلي الصارم حسب ترتيب الإضافة.
 * أول مفتاح أُضيف يُجرَّب أولًا — هذا ليس round-robin وليس «الأقل استخدامًا أولًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد للتعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getTursoClient().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return res.rows.map((r) => asKey(r as DbRecord));
}
