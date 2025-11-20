// app/api/sales/[id]/route.ts
import store from "@/lib/sales";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function DELETE(req: NextRequest, ctx?: Ctx) {
  // 1) 動的ルートの params  2) パス末尾  3) ?id= の順で取得（安全側）
  const idStr =
    ctx?.params?.id ??
    req.nextUrl.pathname.split("/").pop() ??
    req.nextUrl.searchParams.get("id") ??
    "";

  const idNum = Number(idStr);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ok = store.removeSale(idNum);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
