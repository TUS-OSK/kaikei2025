'use client';

import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Colors,
  Legend,
  LinearScale,
  Title,
  Tooltip,
} from 'chart.js';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, Colors);
ChartJS.defaults.color = '#e5e7eb';
ChartJS.defaults.borderColor = 'rgba(148,163,184,0.25)';

//note
//集計時間　何時から 129行目 %デフォルトで「今日の 0:00〜23:59」をセット
//原価、価格、商品の追加 41行目
//復元 curl -X POST "http://localhost:3000/api/sales?action=restore"
//バックアップ　curl "http://localhost:3000/api/sales?action=backup"
// http://localhost:3000/?view=charts グラフ、集計のみ
//http://localhost:3000/　全て
//npm run dev 起動


// ==== 型 ====
type Row = {
  bucket_start: string; // ISO(UTC) バケット開始
  product: string;
  qty: number;
  revenue: number;
  profit: number;
};
type SaleItem = { id: number; ts: string; product: string; qty: number; price: number; cost: number; note?: string; orderId?: string };

// ==== 商品と価格マスタ（ここを編集するとUIと価格が変わる）====
//原価、価格の変更はここから
const PRICE_MAP: Record<string, { price: number; cost: number }> = {
  //price:価格,cost:原価
  'Tea_Hot': { price: 350, cost: 180 },
  'Tea_Ice': { price: 350, cost: 190 },
  'Lemonade': { price: 300, cost: 150 },
  'kasi1': { price: 250, cost: 190 },
  'kasi2': { price: 250, cost: 190 }
};
const PRODUCT_OPTIONS = Object.keys(PRICE_MAP) as (keyof typeof PRICE_MAP)[];

// ==== 商品ごとの色（未指定は自動HSLへフォールバック） ====

const PRODUCT_COLORS: Record<string, { bg: string; border: string }> = {
  'Tea_Hot': { bg: '#a34016ff', border: '#a34016ff' },     // 赤
  'Tea_Ice': { bg: '#025b92ff', border: '#025b92ff' },     // 青
  'Lemonade':     { bg: '#f6ed3bff', border: '#f6ed3bff' },     //黄
  'kasi1': { bg: '#06d937ff', border: '#06d937ff' }, // 黄緑
  'kasi2': { bg: '#08eabdff', border: '#08eabdff' },   // 翡翠？
};

export default function Page() {
  const sp = useSearchParams();
  //chartのみのリンク生成
  const chartsOnly = sp.get('view') === 'charts';
  // 入力フォーム
  const [product, setProduct] = useState<string>(PRODUCT_OPTIONS[0]);
  const [price, setPrice]   = useState<number>(PRICE_MAP[PRODUCT_OPTIONS[0]].price);
  const [qty, setQty]       = useState<number>(1);
  const [note, setNote]     = useState<string>('');

  // 注文ID：1から始まる連番（同一日のみ有効・日付が変わると自動リセット）
  function makeDateKey(d: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`; // 例: 20251029
  }
  const [dateKey, setDateKey] = useState<string>(makeDateKey(new Date()));
  const storageKey = useMemo(() => `orderCounter_${dateKey}`, [dateKey]);
  const [orderCounter, setOrderCounter] = useState<number>(1);
  const [orderId, setOrderId] = useState<string>('1');

  const [issuing, setIssuing] = useState(false);          // 連打防止
  const [toastMsg, setToastMsg] = useState<string | null>(null); // トースト
/////////////
//見直し
/////////////
  // 深夜0時の跨ぎを検知（30秒おきに日付キーをチェック）
  useEffect(() => {
    const timer = setInterval(() => {
      const k = makeDateKey(new Date());
      setDateKey(prev => (prev === k ? prev : k));
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  // 初期化：localStorage から当日のカウンタを読む（なければ1）
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const n = saved ? Math.max(1, parseInt(saved, 10) || 1) : 1;
      setOrderCounter(n);
      setOrderId(String(n));
    } catch {
      // SSR/権限などで例外なら既定のまま
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // 新しい注文IDを発行（現在のカウンタ値を採用 → カウンタ+1 を保存）
  function issueNewOrderId() {
  if (issuing) return;          // 連打防止
  setIssuing(true);

  const current = orderCounter;
  const next = current + 1;

  setOrderId(String(current));
  setOrderCounter(next);
  try { localStorage.setItem(storageKey, String(next)); } catch {}

  // 押したことを分かりやすく
  setToastMsg(`新しい注文ID ${current} を発行しました`);
  navigator.vibrate?.(40); // 対応端末で軽いバイブ

  // 後始末
  setTimeout(() => setToastMsg(null), 1800); // トースト消す
  setTimeout(() => setIssuing(false), 600);  // 短時間だけ無効化
  }
////////////////////
  // 集計条件
  //何分ごとに集計するか
////////////////////
  const [bucket, setBucket] = useState<number>(30);
  const [start, setStart]   = useState<string>(''); // datetime-local
  const [end, setEnd]       = useState<string>('');
  const [startHour, setStartHour] = useState<number>(0);
  const [endHour, setEndHour] = useState<number>(24);

  // 結果
  const [rows, setRows]     = useState<Row[]>([]);
  const [recent, setRecent] = useState<SaleItem[]>([]);
  const [loading, setLoading] = useState(false);

  const yen = useMemo(() => new Intl.NumberFormat('ja-JP'), []);

  // 数値サニタイズと原価のフォールバック（復元データ対策）
  function toNumOrNaN(v: any): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return NaN;
  }
  function resolveCost(item: SaleItem): number {
    const n = toNumOrNaN((item as any).cost);
    if (!Number.isNaN(n)) return n;
    const master = PRICE_MAP[item.product]?.cost;
    return typeof master === 'number' ? master : 0;
  }

  // === 共通ユーティリティ ===
  const toLocalInput = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const isWorkHour = (iso: string) => {
    const h = new Date(iso).getHours();
    return h >= startHour && h < endHour; // 動的にUIから変更
  };

  // 表示用：期間のラベル（同日なら1日、異なるなら範囲）
  function formatDateLabel(startStr: string, endStr: string) {
    if (!startStr || !endStr) return '';
    const s = new Date(startStr);
    const e = new Date(endStr);
    const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    const same = s.getFullYear()===e.getFullYear() && s.getMonth()===e.getMonth() && s.getDate()===e.getDate();
    return same ? fmt(s) : `${fmt(s)}〜${fmt(e)}`;
  }
  const dateLabel = useMemo(() => formatDateLabel(start, end), [start, end]);

  // ---- 商品名の正規化（スペース/全角/大小のゆらぎを吸収してキーを統一）
  function normalizeProductName(raw: string) {
    if (!raw) return '';
    const z2h = raw.replace(/[\u3000]/g, ' '); // 全角スペース→半角
    const trimmed = z2h.trim().replace(/\s+/g, ' '); // 連続空白を1つに
    return trimmed.toLowerCase(); // 小文字化
  }

  // ゆらぎ→正式表示名のエイリアス（必要に応じて追加）
  const PRODUCT_ALIAS: Record<string, string> = {
    'tea hot': 'Tea_Hot',
    'tea_hot': 'Tea_Hot',
    'tea  hot': 'Tea_Hot',
    'tea ice': 'Tea_Ice',
    'tea_ice': 'Tea_Ice',
    'lemonade': 'Lemonade',
    'kasi1': 'kasi1',
    'kasi2': 'kasi2',
  };
  function toCanonicalDisplay(raw: string) {
    const key = normalizeProductName(raw);
    return PRODUCT_ALIAS[key] ?? raw.trim();
  }

  // デフォルトで「今日の 0:00〜23:59」をセット
  useEffect(() => {
    const base = new Date();
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
    const e = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 0);
    setStart(toLocalInput(s));
    setEnd(toLocalInput(e));
  }, []);

  // start/end（期間）が入ったらレポートを読み込む
  useEffect(() => {
    if (!start || !end) return;
    loadReport();
  }, [start, end, bucket]);

  // === API ===
  async function loadReport() {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      q.set('bucket', String(bucket));
      if (start) q.set('start', new Date(start).toISOString());
      if (end) q.set('end', new Date(end).toISOString());
      const res = await fetch(`/api/report?${q.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      setRows(json.data ?? []);
    } finally {
      setLoading(false);
    }
  }
  async function loadRecent() {
    const res = await fetch('/api/sales?limit=50', { cache: 'no-store' });
    const json = await res.json();
    setRecent(json.sales ?? []);
  }
  useEffect(() => { loadRecent(); }, []);

  type OpenOrder = { orderId: string; totalQty: number; totalAmount: number; items: { id: number; ts: string; product: string; qty: number; price: number; }[] };
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  async function loadOpenOrders() {
    const res = await fetch('/api/sales?action=openOrders', { cache: 'no-store' });
    const json = await res.json();
    setOpenOrders(json.orders ?? []);
  }
  useEffect(() => { loadOpenOrders(); }, []);
  async function completeOrder(oid: string) {
    await fetch('/api/sales?action=completeOrder', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: oid })
    });
    await Promise.all([loadOpenOrders(), loadRecent(), loadReport()]);
  }

  async function submitSale(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/sales', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product, price: Number(price), qty: Number(qty), note, orderId }),
    });
    await Promise.all([loadReport(), loadRecent(), loadOpenOrders()]);
    setQty(1);   // 追加後、自動で 1 個に戻す
    setNote(''); // メモはクリア
  }
  async function deleteSale(id: number) {
    await fetch(`/api/sales/${id}`, { method: 'DELETE' });
    await Promise.all([loadRecent(), loadReport()]);
  }

  // === ビュー用の整形（9–17時のみ） ===
  const allBuckets = useMemo(() =>
    Array.from(new Set(rows.map(r => r.bucket_start))).sort(),
  [rows]);

  const filteredBuckets = useMemo(
    () => allBuckets.filter(isWorkHour),
    [allBuckets, startHour, endHour]
  );

  const labels = useMemo(
    () => filteredBuckets.map(iso =>
      new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })
    ),
    [filteredBuckets]
  );

  // グラフの積み上げ順はセレクトの並び（PRODUCT_OPTIONS）に固定
  const orderedProducts = PRODUCT_OPTIONS;

  function colorHsl(i: number, alpha = 0.8) {
    const h = (i * 55) % 360;
    return `hsl(${h} 90% 60% / ${alpha})`;
  }

  // 商品別サマリー（時間帯フィルタ後に、表記ゆれを吸収して1行に集約）
  const summaryByProduct = useMemo(() => {
    const agg = new Map<string, { label: string; qty: number; revenue: number; profit: number }>();
    for (const r of rows) {
      if (!isWorkHour(r.bucket_start)) continue;
      const key = normalizeProductName(r.product);
      const label = toCanonicalDisplay(r.product);
      const cur = agg.get(key) ?? { label, qty: 0, revenue: 0, profit: 0 };
      cur.qty += r.qty;
      cur.revenue += r.revenue;
      cur.profit += (r.revenue - r.qty * (PRICE_MAP[r.product]?.cost ?? 0));
      agg.set(key, cur);
    }
    // 売上降順で並べ替え（任意）
    return Array.from(agg.values()).sort((a, b) => b.revenue - a.revenue);
  }, [rows, startHour, endHour]);

  // 積み上げ棒（9–17時のバケットだけを使う）
  const datasets = useMemo(() =>
    orderedProducts.map((p, i) => ({
      label: p,
      stack: 'qty',
      data: filteredBuckets.map(b => rows.find(r => r.bucket_start === b && r.product === p)?.qty ?? 0),
      backgroundColor: PRODUCT_COLORS[p]?.bg ?? colorHsl(i, 0.75),
      borderColor:     PRODUCT_COLORS[p]?.border ?? colorHsl(i, 1),
      borderWidth: 1,
    })),
  [orderedProducts, filteredBuckets, rows]);

  const barData = { labels, datasets };
  const barOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const },
      title: { display: true, text: `${dateLabel ? dateLabel + ' ' : ''}時間帯ごとの販売数量` },
      tooltip: { intersect: false },
    },
    scales: { x: { stacked: true }, y: { beginAtZero: true, stacked: true } },
  }), [startHour, endHour, dateLabel]);


  // ==== 最近の記録テーブルを CSV 出力 ====
  function exportRecentCsv() {
    const header = ['注文ID', 'Time', 'Product', 'num', 'price'];
    const body = recent.map(r => [
      r.orderId ?? '',
      new Date(r.ts).toLocaleString('ja-JP', { hour12: false }),
      r.product,
      r.qty,
      r.price,
    ]);
    const lines = [header, ...body].map(cols =>
      cols.map(v => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\n');

    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `day1.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ==== 集計（画面上の表）を CSV 出力 ====
  function exportAggregatedCsv() {
    const header = ['Time', 'Product', 'num', 'sales', 'profit'];
    const body = rows
      .filter(r => isWorkHour(r.bucket_start))
      .map(r => [
        new Date(r.bucket_start).toLocaleString('ja-JP', { hour12: false }),
        r.product,
        r.qty,
        r.revenue,
        (r.revenue - r.qty * (PRICE_MAP[r.product]?.cost ?? 0)),
      ]);

    const lines = [header, ...body]
      .map(cols => cols.map(v => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
      .join('\n');

    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `day1_all.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ maxWidth: 1200, margin: '40px auto', padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>紅茶の売り上げ</h1>

      <div style={{ display: 'grid', gridTemplateColumns: chartsOnly ? '1fr' : '1fr 2fr', gap: 24 }}>
        {/* 左：販売入力 */}
        {!chartsOnly && (
          <section style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>販売を記録</h2>
          <form onSubmit={submitSale} style={{ display: 'grid', gap: 12 }}>
            <label>注文ID
              <div style={{ display:'flex', gap:8 }}>
                <input
                  value={orderId}
                  onChange={(e) => setOrderId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      issueNewOrderId();
                    }
                  }}
                  style={{ flex:1, padding:8 }}
                />
                <button
                type="button"
                onClick={issueNewOrderId}
                disabled={issuing}
                title="新しい注文IDを発行"
                aria-label="新しい注文IDを発行"
                style={{
                  padding: '8px 12px',
                  background: 'transparent',
                  color: '#10b981',                 // エメラルド
                  border: '2px solid #10b981',
                  borderRadius: 8,
                  fontWeight: 800,                  // 強調
                  cursor: issuing ? 'not-allowed' : 'pointer',
                   opacity: issuing ? 0.6 : 1,
                   }}>
                    新しい注文ID
                    </button>
              </div>
            </label>
            <label>商品
              <select
                value={product}
                onChange={(e) => {
                  const p = e.target.value;
                  setProduct(p);
                  if (PRICE_MAP[p]) {
                    setPrice(PRICE_MAP[p].price);
                  }
                  setQty(1); // 追加したら1個に戻す要件に合わせ、選択時点でも1へ
                }}
                style={{ width: '100%', padding: 8 }}
              >
                {PRODUCT_OPTIONS.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>価格（円）
              <input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} required style={{ width: '100%', padding: 8 }} />
            </label>
            <label>数量
              <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} required style={{ width: '100%', padding: 8 }} />
            </label>
            <label>メモ（任意）
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="氷少なめ など" style={{ width: '100%', padding: 8 }} />
            </label>
            <button
              type="submit"
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: '#1d4ed8', // blue background
                color: '#ffffff', // white text
                border: 'none',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'background 0.2s ease',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = '#2563eb')}
              onMouseOut={(e) => (e.currentTarget.style.background = '#1d4ed8')}
            >
              追加
            </button>
          </form>
        </section>
        )}

        {/* 右：集計・操作 */}
        <section style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          {/* 操作列 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label>バケット（分）
              <input type="number" min={1} value={bucket} onChange={(e) => setBucket(Number(e.target.value))} style={{ width: 100, padding: 6, marginLeft: 8 }} />
            </label>
            <label>開始時刻(時)
              <input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(Math.min(23, Math.max(0, Number(e.target.value))))} style={{ width: 80, padding: 6, marginLeft: 8 }} />
            </label>
            <label>終了時刻(時)
              <input type="number" min={1} max={24} value={endHour} onChange={(e) => setEndHour(Math.min(24, Math.max(1, Number(e.target.value))))} style={{ width: 80, padding: 6, marginLeft: 8 }} />
            </label>
            <label>期間開始
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} style={{ padding: 6, marginLeft: 8 }} />
            </label>
            <label>期間終了
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} style={{ padding: 6, marginLeft: 8 }} />
            </label>
            <button onClick={loadReport}>{loading ? '更新中…' : '集計を更新'}</button>
            <button onClick={exportAggregatedCsv}>集計をCSV</button>
          </div>


          {/* 積み上げ棒グラフ（9〜17時のみ） */}
          <div style={{ height: 360, marginTop: 16 }}>
            <Bar data={barData} options={barOptions} />
          </div>

          {/* 未完了の注文一覧 */}
          {!chartsOnly && (
            <div style={{ marginTop: 16 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>未完了の注文</h3>
              <button onClick={loadOpenOrders} style={{ padding:'6px 10px', border:'1px solid #1f2937', borderRadius:6 }}>更新</button>
            </div>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>注文ID</th>
                    <th style={th}>明細</th>
                    <th style={th}>商品数</th>
                    <th style={th}>合計金額</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map(o => {
  const map = new Map<string, number>();
  for (const it of o.items) {
    const q = Number(it.qty) || 0;
    map.set(it.product, (map.get(it.product) || 0) + q);
  }
  const orderRank = new Map(PRODUCT_OPTIONS.map((p, idx) => [p, idx]));
  const detail = Array.from(map.entries())
    .sort((a, b) => (orderRank.get(a[0]) ?? 999) - (orderRank.get(b[0]) ?? 999))
    .map(([name, q]) => `${name}×${q}`)
    .join(', ');
  return (
    <tr key={o.orderId}>
      <td style={td}>{o.orderId}</td>
      <td style={td}>{detail}</td>
      <td style={td}>{o.totalQty}</td>
      <td style={td}>{yen.format(o.totalAmount)}</td>
      <td style={td}>
        <button onClick={() => completeOrder(o.orderId)} style={{ padding:'6px 10px', border:'1px solid #10b981', borderRadius:6 }}>完了</button>
      </td>
    </tr>
  );
})}
                  {openOrders.length === 0 && (
                    <tr><td colSpan={5} style={td}>（未完了の注文はありません）</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            </div>
          )}
        </section>
      </div>

      {/* 最近の記録（削除可） */}
      {!chartsOnly && (
        <div style={{ marginTop: 24 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>最近の記録</h3>
          <button onClick={exportRecentCsv} style={{ padding:'6px 10px', border:'1px solid #1f2937', borderRadius:6 }}>CSVで保存</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>注文ID</th>
                <th style={th}>時刻</th>
                <th style={th}>商品</th>
                <th style={th}>数量</th>
                <th style={th}>価格</th>
                <th style={th}>原価</th>
                <th style={th}>メモ</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td style={td}>{s.orderId ?? ''}</td>
                  <td style={td}>{new Date(s.ts).toLocaleString('ja-JP', { hour12:false })}</td>
                  <td style={td}>{s.product}</td>
                  <td style={td}>{s.qty}</td>
                  <td style={td}>{yen.format(s.price)}</td>
                  <td style={td}>{yen.format(resolveCost(s))}</td>
                  <td style={td}>{s.note ?? ''}</td>
                  <td style={td}>
                    <button onClick={() => deleteSale(s.id)} style={{ padding:'6px 10px', border:'1px solid #ef4444', borderRadius:6 }}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
              {recent.length === 0 && <tr><td style={td} colSpan={8}>データなし</td></tr>}
            </tbody>
          </table>
        </div>        
        </div>
      )}
      {toastMsg && (
        <div
    role="status"
    aria-live="polite"
    style={{
      position: 'fixed',
      top: 100,
      left: 390,
      background: '#0d5480ff',
      color: '#ffffffff',
      padding: '10px 14px',
      borderRadius: 8,
      boxShadow: '0 10px 20px rgba(0,0,0,.2)',
      zIndex: 50
    }}
  >
    {toastMsg}
  </div>
)}
    </main>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 8px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontWeight: 600 };
const td: React.CSSProperties = { padding: '10px 8px', borderBottom: '1px solid #f3f4f6', whiteSpace: 'nowrap' };