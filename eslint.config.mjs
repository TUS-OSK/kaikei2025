import { useMemo } from "react";
// ... other imports

// 商品別サマリー
const summaryByProduct = useMemo(() => {
  // ... existing calculation code
}, [/* dependencies */]);

  // 総合計（選択期間 & 時間帯の合計）
  const grandTotal = useMemo(() => {
    return summaryByProduct.reduce(
      (acc, cur) => ({
        qty: acc.qty + cur.qty,
        revenue: acc.revenue + cur.revenue,
        profit: acc.profit + cur.profit,
      }),
      { qty: 0, revenue: 0, profit: 0 }
    );
  }, [summaryByProduct]);

// ... other code

          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>
              {dateLabel ? `${dateLabel} ` : ''}{startHour}〜{endHour}時 の合計（商品別）
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Product</th>
                  <th style={th}>num</th>
                  <th style={th}>sales</th>
                  <th style={th}>profit</th>
                </tr>
              </thead>
              <tbody>
                {summaryByProduct.map((r) => (
                  <tr key={r.product}>
                    <td style={td}>{r.product}</td>
                    <td style={td}>{r.qty}</td>
                    <td style={td}>{yen.format(r.revenue)}</td>
                    <td style={td}>{yen.format(r.profit)}</td>
                  </tr>
                ))}
                {summaryByProduct.length === 0 && (
                  <tr><td style={td} colSpan={4}>（該当データなし）</td></tr>
                )}
              </tbody>
              {summaryByProduct.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={{ ...td, fontWeight: 700 }}>合計</td>
                    <td style={{ ...td, fontWeight: 700 }}>{grandTotal.qty}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{yen.format(grandTotal.revenue)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{yen.format(grandTotal.profit)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
