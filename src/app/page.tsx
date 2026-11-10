"use client";

/**
 * لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
 * (أ) مدير المفاتيح (ب) لوحة المهام (ج) ربط السيرفر
 * الهيدر يعرض حالة /api/health — والقوائم تتحدث تلقائيًا كل ~5 ثوانٍ.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

interface HealthData {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  prompt: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const TYPE_ICON: Record<string, string> = { image: "🖼️", video: "🎬", merge: "🔗" };

const KEY_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  exhausted: { label: "مستنزف", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  disabled: { label: "معطّل", cls: "bg-zinc-200 text-zinc-600 border-zinc-300" },
};

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "بالانتظار", cls: "bg-violet-100 text-violet-800 border-violet-300" },
  processing: { label: "جارية", cls: "bg-violet-100 text-violet-800 border-violet-300" },
  completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  failed: { label: "فاشلة", cls: "bg-rose-100 text-rose-800 border-rose-300" },
};

const PROVIDER_LABEL: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

function fmtTime(iso: string): string {
  return iso ? iso.slice(5, 16).replace("T", " ") : "";
}

function parseUrls(json: string | null): string[] {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function attemptsCount(json: string): number {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value, label = "نسخ", className = "" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={`shrink-0 ${className}`}
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? "✅ تم النسخ" : `📋 ${label}`}
    </Button>
  );
}

// ================== (أ) مدير المفاتيح ==================

function KeyManager({ keys, onReload }: { keys: KeyItem[]; onReload: () => void }) {
  const [provider, setProvider] = useState("kie");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function addKey() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = (await r.json()) as { message?: string; error?: string };
      setMsg({ text: r.ok ? j.message ?? "تم" : j.error ?? "خطأ", ok: r.ok });
      if (r.ok) {
        setApiKey("");
        setLabel("");
        onReload();
      }
    } catch {
      setMsg({ text: "فشل الاتصال بالسيرفر", ok: false });
    }
    setBusy(false);
  }

  async function toggle(k: KeyItem) {
    const next = k.status === "disabled" ? "active" : "disabled";
    const r = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const j = (await r.json()) as { message?: string; error?: string };
    setMsg({ text: r.ok ? j.message ?? "تم" : j.error ?? "خطأ", ok: r.ok });
    onReload();
  }

  async function remove(k: KeyItem) {
    if (!window.confirm(`حذف المفتاح ${k.api_key} نهائيًا؟`)) return;
    const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    const j = (await r.json()) as { message?: string; error?: string };
    setMsg({ text: r.ok ? j.message ?? "تم" : j.error ?? "خطأ", ok: r.ok });
    onReload();
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">🔑 مدير المفاتيح</CardTitle>
        <CardDescription>
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ
          أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="provider">المزود</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue placeholder="اختر المزود" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kie">kie.ai</SelectItem>
                <SelectItem value="cometapi">CometAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apikey">مفتاح API</Label>
            <Input
              id="apikey"
              dir="ltr"
              placeholder="k-xxxxxxxxxxxxxxxxxxxxxxxx"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="keylabel">تسمية (اختياري)</Label>
            <Input
              id="keylabel"
              placeholder="مثال: الحساب الرئيسي"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button onClick={addKey} disabled={busy || apiKey.trim().length < 8} className="w-full sm:w-auto">
            {busy ? "جارٍ الإضافة…" : "➕ إضافة المفتاح"}
          </Button>
        </div>

        {msg && (
          <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`} role="status">
            {msg.text}
          </p>
        )}

        <Separator />

        {keys.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>
        ) : (
          <ul className="max-h-96 space-y-3 overflow-y-auto custom-scroll pl-1">
            {keys.map((k, i) => {
              const st = KEY_STATUS[k.status] ?? KEY_STATUS.disabled;
              return (
                <li key={k.id} className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="font-mono text-sm" dir="ltr">
                      {k.api_key}
                    </span>
                    <Badge variant="outline" className="border-zinc-300 text-zinc-700">
                      {PROVIDER_LABEL[k.provider] ?? k.provider}
                    </Badge>
                    <Badge className={`border ${st.cls}`}>{st.label}</Badge>
                    {k.label && <span className="text-sm text-zinc-600">«{k.label}»</span>}
                    <span className="ms-auto flex gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => toggle(k)}>
                        {k.status === "disabled" ? "▶️ تنشيط" : "⏸️ تعطيل"}
                      </Button>
                      <Button variant="outline" size="sm" className="text-rose-700 hover:bg-rose-50" onClick={() => remove(k)}>
                        🗑️ حذف
                      </Button>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500" dir="rtl">
                    <span>الاستخدام: {k.usage_count}</span>
                    <span className="text-emerald-700">نجاح: {k.success_count}</span>
                    <span className="text-rose-700">فشل: {k.fail_count}</span>
                    {k.last_used_at && <span>آخر استخدام: {fmtTime(k.last_used_at)}</span>}
                    {k.last_error && (
                      <span className="w-full truncate text-amber-700" title={k.last_error}>
                        آخر خطأ: {k.last_error}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ================== (ب) لوحة المهام ==================

function TasksPanel({
  tasks,
  stats,
  onReload,
}: {
  tasks: TaskItem[];
  stats: Stats;
  onReload: () => void;
}) {
  const statChips = [
    { label: "الإجمالي", value: stats.total, cls: "bg-zinc-200 text-zinc-800" },
    { label: "مكتملة", value: stats.completed, cls: "bg-emerald-100 text-emerald-800" },
    { label: "فاشلة", value: stats.failed, cls: "bg-rose-100 text-rose-800" },
    { label: "جارية", value: stats.processing, cls: "bg-violet-100 text-violet-800" },
  ];

  return (
    <Card className="shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-lg">📋 لوحة المهام</CardTitle>
          <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onReload}>
          🔄 تحديث الآن
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          {statChips.map((c) => (
            <div key={c.label} className={`rounded-lg p-3 text-center ${c.cls}`}>
              <div className="text-xl font-bold">{c.value}</div>
              <div className="text-xs">{c.label}</div>
            </div>
          ))}
        </div>

        {tasks.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            لا توجد مهام بعد — استدعِ generate_image أو generate_video من أي عميل MCP.
          </p>
        ) : (
          <ul className="max-h-96 space-y-3 overflow-y-auto custom-scroll pl-1">
            {tasks.map((t) => {
              const st = TASK_STATUS[t.status] ?? TASK_STATUS.processing;
              const urls = parseUrls(t.result_urls_json);
              const isMerge = t.type === "merge";
              return (
                <li key={t.id} className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base">
                      {TYPE_ICON[t.type] ?? "📄"} {TYPE_LABEL[t.type] ?? t.type}
                    </span>
                    <Badge className={`border ${st.cls}`}>{st.label}</Badge>
                    <span className="font-mono text-xs text-zinc-500" dir="ltr">
                      {t.model}
                    </span>
                    <span className="text-xs text-zinc-400">· {fmtTime(t.created_at)}</span>
                    {attemptsCount(t.attempts_json) > 0 && (
                      <Badge variant="outline" className="border-zinc-300 text-xs text-zinc-500">
                        محاولات: {attemptsCount(t.attempts_json)}
                      </Badge>
                    )}
                    {t.status === "completed" && urls.length > 0 && (
                      <span className="ms-auto flex gap-1.5">
                        <Button variant="outline" size="sm" asChild>
                          <a href={urls[0]} target="_blank" rel="noopener noreferrer">
                            🔗 فتح الرابط
                          </a>
                        </Button>
                        <CopyButton value={urls[0]} label="نسخ الرابط" />
                      </span>
                    )}
                  </div>
                  {t.prompt && (
                    <p className="mt-1.5 line-clamp-2 text-sm text-zinc-600">«{t.prompt}»</p>
                  )}
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="mt-2 flex items-center gap-2">
                      <Progress value={t.progress} className="h-2 flex-1" />
                      <span className="text-xs text-zinc-500">{t.progress}%</span>
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="mt-1.5 text-sm text-rose-700">❌ {t.error_message}</p>
                  )}
                  {isMerge && t.status === "completed" && (
                    <p className="mt-1.5 text-xs text-amber-700">⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ================== (ج) ربط السيرفر ==================

const TOOLS_INFO: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي وإرجاع الرابط جاهزًا." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن (image-to-video اختياري) ويُتابَع بـ get_task." },
  { name: "merge_videos", desc: "دمج حتى 10 مقاطع بترتيب معيّن في مقطع واحد (الناتج يُحذف بعد ~24 ساعة)." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وإرجاع الروابط." },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزّنة بروابطها دون إعادة توليد." },
];

function ConnectCard({ health }: { health: HealthData | null }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setOrigin(window.location.origin), 0);
    return () => clearTimeout(t);
  }, []);
  const mcpUrl = `${origin}/mcp`;
  const authSuffix = health?.authRequired
    ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";

  const chatgptJson = `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authSuffix}
    }
  }
}`;
  const claudeJson = `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${authSuffix}
    }
  }
}`;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">🔌 ربط السيرفر</CardTitle>
        <CardDescription>انسخ الرابط أو إعداد JSON الجاهز لأي عميل MCP</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Input dir="ltr" readOnly value={mcpUrl} className="font-mono text-sm" aria-label="MCP endpoint URL" />
          <CopyButton value={mcpUrl} />
        </div>

        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-xs text-zinc-500">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
            </p>
            <div className="flex items-start gap-2">
              <pre dir="ltr" className="max-h-40 flex-1 overflow-auto rounded-lg bg-zinc-900 p-3 text-left text-xs leading-5 text-zinc-100 custom-scroll">
                {chatgptJson}
              </pre>
              <CopyButton value={chatgptJson} />
            </div>
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <p className="text-xs text-zinc-500">الملف: claude_desktop_config.json — بنفس الصيغة مع «type»: «http».</p>
            <div className="flex items-start gap-2">
              <pre dir="ltr" className="max-h-40 flex-1 overflow-auto rounded-lg bg-zinc-900 p-3 text-left text-xs leading-5 text-zinc-100 custom-scroll">
                {claudeJson}
              </pre>
              <CopyButton value={claudeJson} />
            </div>
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <p className="text-xs text-zinc-500">الملف: mcp.json — نفس صيغة ChatGPT / GPT Agents.</p>
            <div className="flex items-start gap-2">
              <pre dir="ltr" className="max-h-40 flex-1 overflow-auto rounded-lg bg-zinc-900 p-3 text-left text-xs leading-5 text-zinc-100 custom-scroll">
                {chatgptJson}
              </pre>
              <CopyButton value={chatgptJson} />
            </div>
          </TabsContent>
        </Tabs>

        <Separator />

        <div className="flex flex-wrap gap-2">
          {TOOLS_INFO.map((t) => (
            <span
              key={t.name}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs"
              title={t.desc}
            >
              <code dir="ltr" className="font-mono font-semibold text-violet-800">
                {t.name}
              </code>
              <span className="text-zinc-600">— {t.desc}</span>
            </span>
          ))}
        </div>

        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
          المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
          العملية.
        </div>
      </CardContent>
    </Card>
  );
}

// ================== الصفحة الرئيسية ==================

export default function Dashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth((await r.json()) as HealthData);
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      if (r.ok) setKeys(((await r.json()) as { keys: KeyItem[] }).keys ?? []);
    } catch {
      /* تجاهل — المحاولة القادمة */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks");
      if (r.ok) {
        const j = (await r.json()) as { stats: Stats; tasks: TaskItem[] };
        setStats(j.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
        setTasks(j.tasks ?? []);
      }
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول خارج التأثير المتزامن (قاعدة react-hooks/set-state-in-effect)
    const t0 = setTimeout(() => {
      loadHealth();
      loadKeys();
      loadTasks();
    }, 0);
    const t = setInterval(loadTasks, 5000);
    const k = setInterval(loadKeys, 5000);
    const h = setInterval(loadHealth, 10000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
      clearInterval(k);
      clearInterval(h);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  const dbOk = health?.ok === true && health.database === "turso-connected";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-100">
      <header className="border-b border-zinc-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4">
          <div className="me-auto">
            <h1 className="text-xl font-bold">🎨 مولّد الوسائط — خادم MCP</h1>
            <p className="text-xs text-zinc-500">
              توليد صور وفيديو بالذكاء الاصطناعي + دمج المقاطع — تبديل مفاتيح تسلسلي تلقائي دون توقف
            </p>
          </div>
          <Badge
            className={`border ${dbOk ? "border-emerald-300 bg-emerald-100 text-emerald-800" : "border-rose-300 bg-rose-100 text-rose-800"}`}
          >
            <span className={`me-1.5 inline-block h-2 w-2 rounded-full ${dbOk ? "bg-emerald-500" : "bg-rose-500"}`} />
            {dbOk ? "Turso متصل" : "غير متصل"}
          </Badge>
          {health && (
            <Badge
              className={`border ${
                health.merger.healthy
                  ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                  : "border-amber-300 bg-amber-100 text-amber-800"
              }`}
            >
              خدمة الدمج: {health.merger.healthy ? "متصلة" : health.merger.base ? "غير متصلة" : "غير مهيأة"}
            </Badge>
          )}
          {health?.authRequired && <Badge className="border border-zinc-300 bg-zinc-200 text-zinc-700">محمي بـ Bearer Token</Badge>}
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-6">
        <KeyManager keys={keys} onReload={loadKeys} />
        <TasksPanel tasks={tasks} stats={stats} onReload={loadTasks} />
        <ConnectCard health={health} />
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white py-4 text-center text-xs text-zinc-500">
        media-generator-mcp v1.2.0 — روابط فقط، لا ملفات على السيرفر — التبديل التسلسلي صامت تمامًا أمام العميل
      </footer>
    </div>
  );
}
