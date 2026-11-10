/**
 * تنظيف آثار الاختبار من قاعدة البيانات:
 *  - حذف كل مهام الدمج (type=merge) — روابطها كانت على الخدمة الاختبارية المحلية (127.0.0.1) وهي ميتة الآن
 *  - حذف المهام الفاشلة/الجارية العالقة
 *  - يُبقي على مهام الصور/الفيديو المكتملة بروابطها الدائمة (أدلة نجاح حقيقية)
 * التشغيل: bun run scripts/cleanup-test-data.mjs
 */
import { getTursoClient, ensureSchema } from "../src/lib/turso.js";

async function main() {
  await ensureSchema();
  const c = getTursoClient();

  const res = await c.execute("SELECT id, type, status FROM tasks");
  const doomed = res.rows
    .map((r) => ({ id: String(r.id), type: String(r.type), status: String(r.status) }))
    .filter((t) => t.type === "merge" || t.status === "failed" || t.status === "pending" || t.status === "processing");

  if (!doomed.length) {
    console.log("لا توجد مهام اختبار للحذف — القاعدة نظيفة.");
    return;
  }
  for (const t of doomed) console.log(`🗑️ حذف: ${t.id} (${t.type}/${t.status})`);
  await c.execute({
    sql: `DELETE FROM tasks WHERE id IN (${doomed.map(() => "?").join(",")})`,
    args: doomed.map((t) => t.id),
  });

  const after = await c.execute("SELECT type, status, COUNT(*) AS n FROM tasks GROUP BY type, status");
  console.log("\nالمتبقي:");
  for (const r of after.rows) console.log(`  ${r.type}/${r.status}: ${r.n}`);
}

void main();
