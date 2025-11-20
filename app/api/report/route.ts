import { NextRequest, NextResponse } from 'next/server';
import store from '@/lib/sales';

function parseBucketMinutes(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30; // 既定
  const m = Math.floor(n);
  return Math.min(1440, Math.max(1, m)); // 1〜1440分にクランプ
}

function parseIsoOrUndefined(v: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) return undefined; // 無効値は無視（400にする場合はここでthrowでも可）
  return d.toISOString();
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const bucketMinutes = parseBucketMinutes(searchParams.get('bucket'));
    const start = parseIsoOrUndefined(searchParams.get('start'));
    const end = parseIsoOrUndefined(searchParams.get('end'));

    const data = store.getReport({ bucketMinutes, start, end });

    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'failed_to_build_report', message: err?.message ?? String(err) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}