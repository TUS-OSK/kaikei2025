// lib/backupScheduler.ts
let started = false;
export function startBackupScheduler() {
  if (started) return;
  started = true;

  const intervalMs = Number(process.env.BACKUP_INTERVAL_MS ?? 5 * 60 * 1000); // 5分
  const url =
    process.env.BACKUP_URL ??
    "http://localhost:3000/api/sales?action=backup&bucket=30&startHour=0&endHour=24";

  setInterval(async () => {
    try {
      await fetch(url, { method: "GET" });
    } catch {
      // dev中に落ちてても無視
    }
  }, intervalMs);
}
