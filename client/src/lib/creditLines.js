// Builds the per-creditor credit lines shown on the Sales Book for one date.
//
// Source of truth is credit_sales (recorded on the Creditors screen) — this
// only groups it. Every ACTIVE creditor gets a line (GHS 0.00 if they had no
// sale that day, so a missing line never gets mistaken for "not checked").
// A creditor who has since been deactivated still gets a line if they had a
// sale on this date, so a historical day always adds up to what was
// actually sold that day.
export function buildCreditLines(creditors, creditSales) {
  const totals = new Map()
  for (const cs of creditSales || []) {
    totals.set(cs.creditor_id, (totals.get(cs.creditor_id) || 0) + (parseFloat(cs.total_amount_ghs) || 0))
  }

  const lines = []
  const seen = new Set()
  for (const c of creditors || []) {
    const active = c.is_active !== false
    const amount = totals.get(c.id) || 0
    if (!active && amount === 0) continue
    seen.add(c.id)
    lines.push({ creditor_id: c.id, name: c.name, amount, active })
  }

  // A sale tied to a creditor that isn't in the creditor list at all
  // (soft-deleted) must still be counted, or the lines won't add up to the
  // stored total.
  for (const [creditorId, amount] of totals) {
    if (seen.has(creditorId)) continue
    const nameFromSale = (creditSales || []).find(cs => cs.creditor_id === creditorId)?.creditors?.name
    lines.push({ creditor_id: creditorId, name: nameFromSale || 'Unknown creditor', amount, active: false })
  }

  lines.sort((a, b) => a.name.localeCompare(b.name))
  const round2 = (n) => Math.round(n * 100) / 100
  const total = round2(lines.reduce((s, l) => s + l.amount, 0))
  return { lines: lines.map(l => ({ ...l, amount: round2(l.amount) })), total }
}
