/**
 * اختبار معيار القبول 7: مفتاح مستنزف (402) يظهر بحالة exhausted ويبقى في القاعدة
 * دون عرقلة المفاتيح التالية — والعميل لا يرى أي ذكر للمفاتيح/الرصيد.
 *
 * نحاكي: مفتاح cometapi يرد 402 (بجسم "insufficient credits") ثم مفتاح kie الحقيقي.
 * نبثّ fetch عالميًا داخل هذا السكربت فقط لاعتراض نداءات api.cometapi.com.
 * التشغيل: bun run scripts/test-exhausted-402.ts   (bun يحمّل .env.local تلقائيًا)
 */
import { randomUUID } from "node:crypto";
import { deleteKey, findDuplicateKey, getKeyPool, insertKey, deleteTasks, listRecentTasks, getTursoClient } from "../src/lib/turso";
import { runGeneration } from "../src/lib/generation";

const COMET_KEY = "comet_test_exhausted_key_402";
const results: { name: string; ok: boolean; detail?: string }[] = [];

// اعتراض نداءات cometapi داخل هذا العملية فقط — 402 نفاد رصيد
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  if (url.startsWith("https://api.cometapi.com")) {
    return new Response(JSON.stringify({ error: { message: "insufficient credits, please recharge" } }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
};

async function main() {
  let createdTaskId: string | null = null;
  try {
    // 1) أضف مفتاح cometapi المستنزف (سيُجرَّب أولًا لأنه الأقدم — ما لم يوجد مفتاح أقدم)
    const dup = await findDuplicateKey("cometapi", COMET_KEY);
    const keyId = dup?.id ?? randomUUID();
    if (!dup) await insertKey({ id: keyId, provider: "cometapi", label: "402-test", api_key: COMET_KEY });
    await getTursoClient().execute({
      sql: "UPDATE api_keys SET created_at = '2026-01-01T00:00:00.000Z', status = 'active' WHERE id = ?",
      args: [keyId],
    });

    // تأكد أنه أول المرشحين: نتحقق من الترتيب الحالي لمسبح image
    const poolBefore = await getKeyPool(["kie", "cometapi"]);
    results.push({
      name: "exhausted key first in strict sequential pool",
      ok: poolBefore[0]?.api_key === COMET_KEY,
      detail: poolBefore.map((k) => `${k.provider}:${k.api_key.slice(0, 6)}…`).join(" → "),
    });

    // 2) شغّل توليد صورة — يجب أن يُجاوَز المستنزف ويكتمل على kie دون أي ذكر للمفاتيح
    const reply = await runGeneration("image", { prompt: "a small paper boat on calm water", wait_seconds: 120 });
    // نجمع معرف مهمة الاختبار للتنظيف لاحقًا (يُنشأ داخليًا في runGeneration)
    const recent = await listRecentTasks(10, { type: "image" });
    createdTaskId = recent.find((t) => t.prompt === "a small paper boat on calm water")?.id ?? null;
    const noKeyMention = !/(مفتاح|رصيد|key|balance|credit|quota|402|exhausted)/i.test(reply.text);
    results.push({ name: "التوليد اكتمل بنجاح عبر المفتاح التالي", ok: !reply.isError && reply.text.includes("✅"), detail: reply.text.slice(0, 120) });
    results.push({ name: "العميل لم يرَ أي ذكر للمفاتيح/الرصيد", ok: noKeyMention, detail: reply.text.slice(0, 80) });

    // 3) المفتاح المستنزف صار exhausted وفقًا للقاعدة
    const poolAfter = await getKeyPool(["kie", "cometapi"]);
    const cometRow = poolAfter.find((k) => k.api_key === COMET_KEY);
    // ملاحظة: getKeyPool يستثني disabled فقط — exhausted يبقى في القائمة (كما في المواصفة)
    results.push({
      name: "حالة المفتاح صارت exhausted (يبقى في القاعدة)",
      ok: cometRow?.status === "exhausted",
      detail: `status=${cometRow?.status} fail_count=${cometRow?.fail_count} last_error=${cometRow?.last_error?.slice(0, 60)}`,
    });
  } catch (e) {
    results.push({ name: "استثناء غير متوقع", ok: false, detail: (e as Error).message });
  } finally {
    // تنظيف آثار الاختبار: مفتاح الاختبار + مهمة الاختبار
    const keys = await getKeyPool(["cometapi"]);
    for (const k of keys) if (k.api_key === COMET_KEY) await deleteKey(k.id);
    if (createdTaskId) await deleteTasks([createdTaskId]);
  }

  console.log("\n===== نتائج اختبار 402 =====");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.ok) pass++;
  }
  console.log(`\nالنتيجة: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
}

void main();
