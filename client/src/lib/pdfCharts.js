// Chart drawing for the monthly PDF, kept out of Reports.jsx so it can be rendered and checked on its
// own. Pure jsPDF primitives (rect / line / text / triangle) — vector output, no canvas, no chart
// library, ASCII text only (jsPDF's built-in helvetica silently corrupts anything outside WinAnsi).

const nf0 = (n) => Math.round(n).toLocaleString('en-US')

// Total litres per day as stacked bars (SXP bottom, DXP on top), with:
//  - weekends shaded behind the bar (weekday taken from the business date shown in the report)
//  - a dashed average line
//  - a dashed vertical marker + label where a price change took effect (from fuel_prices)
//  - a red triangle over any day the station traded but sold no SXP at all
// days: [{ date: 'YYYY-MM-DD', sxp, dxp }]  (one entry per day that has meter data; gaps stay empty)
// Returns the height used, so the caller can advance its y cursor.
export function drawDailyLitresChart(doc, { x, y, w, h, days, daysInSlots, priceChanges = [], colors }) {
  const { ORANGE, DARK_GREY, MID_GREY, ASH, LIGHT_ASH, RED } = colors
  const byDay = {}
  days.forEach(d => { byDay[parseInt(d.date.slice(8, 10), 10)] = d })
  const lastData = days.length ? Math.max(...days.map(d => parseInt(d.date.slice(8, 10), 10))) : 0
  const slots = Math.max(daysInSlots || 0, lastData, 1)
  const ym = days.length ? days[0].date.slice(0, 7) : null

  const totals = days.map(d => d.sxp + d.dxp)
  const maxTotal = Math.max(1, ...totals)
  const step = maxTotal > 8000 ? 2000 : 1000
  const niceMax = Math.max(step * 2, Math.ceil((maxTotal * 1.1) / step) * step)
  const labelW = 11                       // room for y-axis labels
  const plotX = x + labelW
  const plotW = w - labelW
  const slotW = plotW / slots
  const barW = slotW * 0.62
  const yBase = y + h                     // baseline (litres = 0)
  const yOf = (litres) => yBase - (litres / niceMax) * h

  // weekend bands first so everything else draws over them
  if (ym) {
    for (let day = 1; day <= slots; day++) {
      const dow = new Date(`${ym}-${String(day).padStart(2, '0')}T00:00:00Z`).getUTCDay()
      if (dow === 0 || dow === 6) {
        doc.setFillColor(...LIGHT_ASH)
        doc.rect(plotX + (day - 1) * slotW, y, slotW, h, 'F')
      }
    }
  }

  // gridlines + y labels
  doc.setDrawColor(...ASH)
  doc.setLineWidth(0.15)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  doc.setTextColor(...MID_GREY)
  for (let v = 0; v <= niceMax; v += step) {
    doc.line(plotX, yOf(v), plotX + plotW, yOf(v))
    doc.text(nf0(v), plotX - 1.5, yOf(v) + 1.2, { align: 'right' })
  }

  // bars
  for (let day = 1; day <= slots; day++) {
    const d = byDay[day]
    if (!d) continue
    const bx = plotX + (day - 1) * slotW + (slotW - barW) / 2
    const hS = (d.sxp / niceMax) * h
    const hD = (d.dxp / niceMax) * h
    doc.setFillColor(...ORANGE)
    if (hS > 0) doc.rect(bx, yBase - hS, barW, hS, 'F')
    doc.setFillColor(...DARK_GREY)
    if (hD > 0) doc.rect(bx, yBase - hS - hD, barW, hD, 'F')
    if (d.sxp === 0 && d.dxp > 0) {
      const topY = yBase - hS - hD
      doc.setFillColor(...RED)
      doc.triangle(bx + barW / 2 - 1.3, topY - 3.2, bx + barW / 2 + 1.3, topY - 3.2, bx + barW / 2, topY - 0.8, 'F')
    }
  }

  // x labels (day of month)
  doc.setFontSize(5.5)
  doc.setTextColor(...MID_GREY)
  for (let day = 1; day <= slots; day++) {
    doc.text(String(day), plotX + (day - 0.5) * slotW, yBase + 3.6, { align: 'center' })
  }

  // average line (its value goes in the legend, not on the plot where it would sit over the bars)
  let avgLabel = null
  if (totals.length > 0) {
    const avg = totals.reduce((s, t) => s + t, 0) / totals.length
    doc.setDrawColor(...MID_GREY)
    doc.setLineWidth(0.25)
    doc.setLineDashPattern([1.5, 1.2], 0)
    doc.line(plotX, yOf(avg), plotX + plotW, yOf(avg))
    doc.setLineDashPattern([], 0)
    avgLabel = `Daily average ${nf0(avg)} L`
  }

  // price changes: dashed vertical line + label
  const changesByDate = {}
  priceChanges.forEach(p => {
    if (!ym || !p.date || p.date.slice(0, 7) !== ym) return
    ;(changesByDate[p.date] = changesByDate[p.date] || []).push(p)
  })
  Object.keys(changesByDate).sort().forEach((date, i) => {
    const day = parseInt(date.slice(8, 10), 10)
    if (day < 1 || day > slots) return
    const px = plotX + (day - 1) * slotW
    doc.setDrawColor(...ORANGE)
    doc.setLineWidth(0.35)
    doc.setLineDashPattern([1.2, 1.2], 0)
    doc.line(px, y - 2, px, yBase)
    doc.setLineDashPattern([], 0)
    const label = 'Price change: ' + changesByDate[date].map(p => `${p.fuel_type} ${Number(p.price).toFixed(2)}`).join(' / ')
    doc.setFontSize(6)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...ORANGE)
    const rightSide = px > plotX + plotW * 0.6
    doc.text(label, rightSide ? px - 1.2 : px + 1.2, y - 3.2 - i * 3, { align: rightSide ? 'right' : 'left' })
    doc.setFont('helvetica', 'normal')
  })

  // legend
  let ly = yBase + 9
  let lx = plotX
  doc.setFontSize(7)
  doc.setTextColor(...MID_GREY)
  const swatch = (rgb, label, wText) => {
    doc.setFillColor(...rgb)
    doc.rect(lx, ly - 2.6, 3, 3, 'F')
    doc.text(label, lx + 4.5, ly)
    lx += 4.5 + wText + 4
  }
  swatch(ORANGE, 'SXP', 7)
  swatch(DARK_GREY, 'DXP', 7)
  swatch(LIGHT_ASH, 'Weekend', 13)
  doc.setFillColor(...RED)
  doc.triangle(lx, ly - 2.8, lx + 2.6, ly - 2.8, lx + 1.3, ly - 0.4, 'F')
  doc.text('No SXP sold that day', lx + 4.5, ly)
  lx += 4.5 + 33 + 4
  if (avgLabel) {
    doc.setDrawColor(...MID_GREY)
    doc.setLineWidth(0.25)
    doc.setLineDashPattern([1.2, 1], 0)
    doc.line(lx, ly - 1.2, lx + 6, ly - 1.2)
    doc.setLineDashPattern([], 0)
    doc.text(avgLabel, lx + 8, ly)
  }
  return h + 16
}
