// Date helpers for 'YYYY-MM-DD' strings. Pure string/UTC arithmetic — no local
// timezone involved, so a date can never slip a day (Ghana is UTC+0 but dev
// machines and phones travelling abroad are not).
//
// Called during render (e.g. labels in TankStock / MeterBook), so it must NEVER
// throw: anything that isn't a full YYYY-MM-DD string is returned unchanged
// (a date input is '' until the user has picked a complete date).
export function addDays(dateStr, n) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(dt.getTime())) return dateStr
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
