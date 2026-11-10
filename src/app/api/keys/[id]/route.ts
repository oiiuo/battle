/**
 * تعديل/حذف مفتاح — PATCH تعطيل/تنشيط يدوي، DELETE حذف نهائي.
 * المفتاح المعطّل (disabled) هو الوحيد المستبعد من مسبح التجربة التسلسلي.
 */
import { NextRequest, NextResponse } from "next/server";
import { deleteKey, getKey, maskKey, setKeyStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { status?: string } | null;
    const status = String(body?.status ?? "");
    if (!["active", "disabled"].includes(status)) {
      return NextResponse.json({ error: "❌ القيمة المسموحة للحالة: active أو disabled" }, { status: 400 });
    }
    const key = await getKey(id);
    if (!key) return NextResponse.json({ error: "❌ المفتاح غير موجود" }, { status: 404 });
    await setKeyStatus(id, status as "active" | "disabled");
    const updated = await getKey(id);
    return NextResponse.json({
      ok: true,
      message: status === "disabled" ? "⏸️ تم تعطيل المفتاح — سيُستبعد من التجربة التسلسلية" : "▶️ تم تنشيط المفتاح",
      key: updated ? { ...updated, api_key: maskKey(updated.api_key) } : null,
    });
  } catch (e) {
    return NextResponse.json({ error: `تعذر تعديل المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const key = await getKey(id);
    if (!key) return NextResponse.json({ error: "❌ المفتاح غير موجود" }, { status: 404 });
    await deleteKey(id);
    return NextResponse.json({ ok: true, message: "🗑️ تم حذف المفتاح نهائيًا" });
  } catch (e) {
    return NextResponse.json({ error: `تعذر حذف المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
