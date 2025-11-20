import store from "@/lib/sales";
import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
//バックアップ
//import { startBackupScheduler } from "@/lib/backupScheduler";
//startBackupScheduler();

const COMPLETED_ORDER_IDS = new Set<string>();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- restore gate (server-boot limited) ----
const BOOT_TIME = Date.now();
const RESTORE_WINDOW_MS = Number(process.env.RESTORE_WINDOW_MS ?? "180000"); // default 3 minutes
let RESTORE_USED = false; // allow only once per boot

// ---- helpers ----
function ensureCsvField(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

function hoursFilter(hStart: number, hEnd: number) {
  return (iso: string) => {
    const h = new Date(iso).getHours();
    return h >= hStart && h < hEnd;
  };
}

async function triggerBackupNow() {
  try {
    const base = new Date();
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0).toISOString();
    const e = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 0).toISOString();
    const qs = new URLSearchParams({ action: 'backup', bucket: '30', start: s, end: e });
    const baseUrl = process.env.BACKUP_BASE_URL ?? 'http://localhost:3000/api/sales';
    await fetch(`${baseUrl}?${qs.toString()}`, { method: 'GET', cache: 'no-store' });
  } catch {
    // 失敗は無視（本処理を妨げない）
  }
}

// Build CSV strings
function buildRecentCsv() {
  // orderId を含み、完了状態 done もCSVに永続化
  const header = ["orderId", "Time", "Product", "num", "price", "cost", "note", "done"];
  const body = store
    .listSales(10_000)
    .map((r) => [
      (r as any).orderId ?? "",
      r.ts.toISOString(),
      r.product,
      r.qty,
      r.price,
      r.cost,
      r.note ?? "",
      (r as any).done ? "true" : "false",
    ]);
  const lines = [header, ...body]
    .map((cols) => cols.map(ensureCsvField).join(","))
    .join("\n");
  return lines;
}

function buildReportCsv(
  { bucketMinutes, start, end, hStart, hEnd }:
  { bucketMinutes: number; start?: string; end?: string; hStart: number; hEnd: number; }
) {
  const data = store.getReport({ bucketMinutes, start, end });
  const isWorkHour = hoursFilter(hStart, hEnd);

  // 商品別に合算（TimeBucket列は出力しない）
  const agg = new Map<string, { qty: number; revenue: number; profit: number }>();
  for (const r of data) {
    if (!isWorkHour(r.bucket_start)) continue;
    const cur = agg.get(r.product) ?? { qty: 0, revenue: 0, profit: 0 };
    cur.qty += r.qty;
    cur.revenue += r.revenue;
    cur.profit += r.profit;
    agg.set(r.product, cur);
  }

  const header = ['Product', 'num', 'sales', 'profit'];
  const body = Array.from(agg.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue) // 任意：売上降順
    .map(([product, v]) => [product, v.qty, v.revenue, v.profit]);

  const lines = [header, ...body]
    .map(cols => cols.map(ensureCsvField).join(','))
    .join('\n');
  return lines;
}

async function writeBackups(params: {
  bucketMinutes: number;
  start?: string;
  end?: string;
  hStart: number;
  hEnd: number;
}) {
  const dir = path.join(process.cwd(), "backups");
  await ensureDir(dir);
  const dateStr = new Date().toISOString().slice(0, 10);
  const recentCsv = buildRecentCsv();
  const reportCsv = buildReportCsv(params);
  const recentPath = path.join(dir, `recent_${dateStr}.csv`);
  const reportPath = path.join(dir, `report_${dateStr}.csv`);
  await fs.writeFile(recentPath, recentCsv, "utf8");
  await fs.writeFile(reportPath, reportCsv, "utf8");
  return { recentPath, reportPath };
}

// Parse simple CSV (double-quote aware)
function parseCsv(text: string): string[][] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.length > 0);
  const out: string[][] = [];
  for (const line of lines) {
    const row: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQ = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === ",") {
          row.push(cur);
          cur = "";
        } else if (ch === '"') {
          inQ = true;
        } else {
          cur += ch;
        }
      }
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

// ---- routes ----
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");

    if (action === 'completeOrder') {
      const { orderId } = await req.json();
      if (!orderId) return NextResponse.json({ error: 'orderId is required' }, { status: 400 });
      // 永続データに反映
      const updated = store.markDoneByOrderId(String(orderId));
      // 互換: 旧来の in-memory セットにも入れておく（再起動までは二重ガード）
      COMPLETED_ORDER_IDS.add(String(orderId));
      await triggerBackupNow();
      return NextResponse.json({ ok: true, completed: orderId, updated });
    }
    if (action === "restore") {
      const allowDuplicates = searchParams.get("allowDuplicates") === "1";

      // Accept restore only shortly after server start (and only once)
      const now = Date.now();
      if (
        now - BOOT_TIME > RESTORE_WINDOW_MS &&
        process.env.ALLOW_RESTORE_ANYTIME !== "1"
      ) {
        return NextResponse.json(
          {
            error: "restore is allowed only right after server start",
            windowMs: RESTORE_WINDOW_MS,
          },
          { status: 403 }
        );
      }
      if (RESTORE_USED && process.env.ALLOW_RESTORE_ANYTIME !== "1") {
        return NextResponse.json(
          { error: "restore already used once this boot" },
          { status: 409 }
        );
      }
      // restore from latest recent_*.csv in backups/
      const dir = path.join(process.cwd(), "backups");
      try {
        await ensureDir(dir);
      } catch {}
      const files = await fs.readdir(dir);
      const target = files
        .filter((f) => f.startsWith("recent_") && f.endsWith(".csv"))
        .sort()
        .pop();
      if (!target)
        return NextResponse.json(
          { error: "no recent_*.csv found" },
          { status: 404 }
        );
      const text = await fs.readFile(path.join(dir, target), "utf8");
      const rows = parseCsv(text);
      if (rows.length <= 1)
        return NextResponse.json({ error: "empty csv" }, { status: 400 });
      const header = rows[0];
      const idx = (name: string) => header.findIndex((h) => h.trim() === name);
      const iTime = idx("Time");
      const iProduct = idx("Product");
      const iNum = idx("num");
      const iPrice = idx("price");
      const iCost = idx("cost");
      const iNote = idx("note");
      const iOrderId = idx("orderId");
      const iDone = idx("done");

      // 既存データのキー（重複スキップ用）
      const existing = new Set(
        store.listSales(100000).map((s) => {
          const noteStr = s.note ?? "";
          return `${s.ts.toISOString()}|${s.product}|${s.qty}|${s.price}|${s.cost}|${noteStr}`;
        })
      );

      let skipped = 0;
      let ok = 0;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const tsIso = row[iTime] ? new Date(row[iTime]).toISOString() : undefined;
        const payload = {
          product: row[iProduct] ?? "",
          price: Number(row[iPrice] ?? 0),
          cost: Number(row[iCost] ?? 0),
          qty: Number(row[iNum] ?? 1),
          ts: tsIso,
          note: iNote >= 0 ? row[iNote] : undefined,
          orderId: iOrderId >= 0 ? row[iOrderId] : undefined,
          done: iDone >= 0 ? String(row[iDone]).toLowerCase() === 'true' : false,
        } as any;
        if (!payload.product || !Number.isFinite(payload.price) || !Number.isFinite(payload.cost)) continue;

        const key = `${tsIso ?? ''}|${payload.product}|${payload.qty}|${payload.price}|${payload.cost}|${payload.note ?? ''}`;
        if (!allowDuplicates && existing.has(key)) { skipped++; continue; }

        store.addSale(payload);
        existing.add(key);
        ok++;
      }
      RESTORE_USED = true;
      return NextResponse.json({ ok: true, restored: ok, skipped, bootLimited: true, usedOnce: true });
    }

    const body = await req.json();
    const product = String(body.product ?? '').trim();
    const price = Number(body.price);
    const cost  = Number(body.cost ?? 0);
    const qty   = Number(body.qty ?? 1);
    const tsIso = body.ts ? new Date(body.ts).toISOString() : undefined;
    const note  = typeof body.note === 'string' ? body.note : undefined;
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : undefined;
    const done = !!body.done;

    if (!product || !Number.isFinite(price)) {
      return NextResponse.json({ error: 'product/price は必須' }, { status: 400 });
    }

    const sale = store.addSale({ product, price, cost, qty, ts: tsIso, note, orderId, done });
    await triggerBackupNow();
    return NextResponse.json({ ok: true, sale });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "unknown error" },
      { status: 400 }
    );
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === 'openOrders') {
    const all = store.listSales(100000);
    const groups = new Map<string, { orderId: string; totalQty: number; totalAmount: number; items: any[] }>();
    for (const s of all) {
      const oid = (s as any).orderId as string | undefined;
      const isDone = (s as any).done === true;
      if (!oid || isDone || COMPLETED_ORDER_IDS.has(oid)) continue;
      const q = Number(s.qty) || 0;
      const p = Number(s.price) || 0;
      const g = groups.get(oid) ?? { orderId: oid, totalQty: 0, totalAmount: 0, items: [] };
      g.totalQty += q;
      g.totalAmount += q * p;
      g.items.push({ id: s.id, ts: s.ts, product: s.product, qty: s.qty, price: s.price });
      groups.set(oid, g);
    }
    return NextResponse.json({ orders: Array.from(groups.values()) });
  }

  if (action === "backup") {
    const bucket = Number(searchParams.get("bucket") ?? "30");
    const start = searchParams.get("start") ?? undefined;
    const end = searchParams.get("end") ?? undefined;
    const hStart = Number(searchParams.get("startHour") ?? "0");
    const hEnd = Number(searchParams.get("endHour") ?? "24");
    const { recentPath, reportPath } = await writeBackups({
      bucketMinutes: Number.isFinite(bucket) ? bucket : 30,
      start,
      end,
      hStart,
      hEnd,
    });
    return NextResponse.json({ ok: true, recentPath, reportPath });
  }

  const limit = Number(searchParams.get("limit") ?? "150");
  const sales = store
    .listSales(Number.isFinite(limit) ? limit : 150)
    .map((s) => ({
      ...s,
      ts: s.ts.toISOString(),
    }));
  return NextResponse.json({ sales });
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let idStr = searchParams.get('id');
    if (!idStr) {
      try {
        const body = await req.json();
        if (body && body.id != null) idStr = String(body.id);
      } catch {}
    }
    const id = Number(idStr);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const ok = store.removeSale(id);
    if (!ok) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    await triggerBackupNow();
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'unknown error' }, { status: 400 });
  }
}
