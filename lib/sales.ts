export type Product = string;

export interface Sale {
  id: number;
  ts: Date;
  product: Product;
  qty: number;
  price: number;
  cost: number;
  note?: string;
  orderId?: string;    // 1人の複数商品をまとめるID
  done: boolean;       // 注文完了フラグ（永続化対象）
}

function floorToBucketStart(d: Date, bucketMinutes: number): Date {
  const dt = new Date(d);
  dt.setSeconds(0, 0);
  const m = Math.floor(dt.getMinutes() / bucketMinutes) * bucketMinutes;
  dt.setMinutes(m);
  return dt;
}

class SalesStore {
  private sales: Sale[] = [];
  private nextId = 1;

  addSale(input: { product: Product; price: number; cost: number; qty?: number; ts?: string | Date; note?: string; orderId?: string; done?: boolean }) {
    const qty = input.qty ?? 1;
    if (qty <= 0) throw new Error('qty は 1 以上');

    const ts = input.ts ? new Date(input.ts) : new Date();
    if (Number.isNaN(ts.getTime())) throw new Error('ts が不正');

    const sale: Sale = {
      id: this.nextId++,
      ts,
      product: input.product,
      qty,
      price: input.price,
      cost: input.cost,
      note: input.note,
      orderId: input.orderId,
      done: !!input.done, // 常に boolean に正規化（未指定は false）
    };
    this.sales.push(sale);
    return sale;
  }

  listSales(limit = 50): Sale[] {
    return [...this.sales]
      .sort((a, b) => b.ts.getTime() - a.ts.getTime())
      .slice(0, limit);
  }

  removeSale(id: number): boolean {
    const i = this.sales.findIndex((s) => s.id === id);
    if (i === -1) return false;
    this.sales.splice(i, 1);
    return true;
  }

  /** 全レコードを返す（復元後の確認や openOrders 集計に使用） */
  getAll(): Sale[] {
    return [...this.sales];
  }

  /** 注文IDに紐づくすべてのレコードを完了にする。戻り値は更新件数。*/
  markDoneByOrderId(orderId: string): number {
    if (!orderId) return 0;
    let updated = 0;
    for (const s of this.sales) {
      if (s.orderId === orderId && !s.done) {
        s.done = true;
        updated++;
      }
    }
    return updated;
  }

  getReport(params?: { bucketMinutes?: number; start?: string | Date; end?: string | Date }) {
    const bucketMinutes = Math.max(1, Math.floor(params?.bucketMinutes ?? 15));
    const start = params?.start ? new Date(params.start) : undefined;
    const end = params?.end ? new Date(params.end) : undefined;

    const map = new Map<string, { bucket_start: string; product: Product; qty: number; revenue: number; profit: number }>();

    for (const s of this.sales) {
      if (start && s.ts < start) continue;
      if (end && s.ts >= end) continue;

      const b = floorToBucketStart(s.ts, bucketMinutes);
      const key = `${b.toISOString()}__${s.product}`;

      const revenue = s.price * s.qty;
      const profit = (s.price - s.cost) * s.qty;

      if (!map.has(key)) {
        map.set(key, { bucket_start: b.toISOString(), product: s.product, qty: 0, revenue: 0, profit: 0 });
      }
      const v = map.get(key)!;
      v.qty += s.qty;
      v.revenue += revenue;
      v.profit += profit;
    }

    return Array.from(map.values()).sort((a, b) =>
      a.bucket_start === b.bucket_start ? a.product.localeCompare(b.product) : a.bucket_start < b.bucket_start ? -1 : 1
    );
  }
}

declare global { // dev中はホットリロードで状態を維持
  // eslint-disable-next-line no-var
  var __salesStore: SalesStore | undefined;
}
const store = global.__salesStore ?? new SalesStore();
if (process.env.NODE_ENV !== 'production') global.__salesStore = store;
export default store;