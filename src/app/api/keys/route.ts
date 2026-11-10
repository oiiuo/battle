/**
 * إدارة المفاتيح — GET القائمة (مُقنَّعة دائمًا) و POST إضافة.
 * القاعدة الذهبية 9: إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { findDuplicateKey, insertKey, listKeys, maskKey, type KeyRow } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"];

function masked(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    api_key: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(masked) });
  } catch (e) {
    return NextResponse.json({ error: `تعذر جلب المفاتيح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { provider?: string; api_key?: string; label?: string } | null;
    const provider = String(body?.provider ?? "").trim();
    const apiKey = String(body?.api_key ?? "").trim();
    const label = String(body?.label ?? "").trim().slice(0, 60);

    if (!PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "❌ المزود غير مدعوم — القيم المسموحة: kie أو cometapi" }, { status: 400 });
    }
    if (apiKey.length < 8) {
      return NextResponse.json({ error: "❌ المفتاح قصير جدًا — تأكد من نسخه كاملًا من مزود kie.ai" }, { status: 400 });
    }
    const dup = await findDuplicateKey(provider, apiKey);
    if (dup) {
      return NextResponse.json({ error: "❌ هذا المفتاح مُضاف مسبقًا لنفس المزود" }, { status: 409 });
    }
    const id = randomUUID();
    await insertKey({ id, provider, label, api_key: apiKey });
    const keys = await listKeys();
    const added = keys.find((k) => k.id === id)!;
    return NextResponse.json({ ok: true, message: "✅ تمت إضافة المفتاح — التجربة تسلسلية حسب ترتيب الإضافة", key: masked(added) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: `تعذر إضافة المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
