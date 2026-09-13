import { useState, Fragment } from 'react'
import api from '../lib/api'
import { useToast } from '../components/Toast'

// GHS currency formatter — shared by the in-app screen and the PDF export.
// Previously this was re-declared locally inside handleExportPDF (as
// `fmt`) and, separately, as eight inline `.toLocaleString(undefined, {
// minimumFractionDigits: 2 })` calls scattered through the JSX render.
// Both forms were missing `maximumFractionDigits`, so any figure whose
// underlying float has more than 2 decimal digits — e.g. dealer earnings,
// litres × a 1-decimal rate — printed with 3+ decimals instead of being
// rounded to currency precision (visible in the Aug 2026 report: "GHS
// 8,537.022" throughout Section 5, 7, and the KPI header). One formatter,
// capped correctly, used everywhere.
const fmt = (n) => parseFloat(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtL = (n) => fmt(n) + ' L'

// Groups a date-bearing array into per-day blocks, sorted by date. Used by
// Section 1 (Fuel Sales) and Section 7 (Dealer Margin) — both are really
// one row per pump/fuel per day, which read as a wall of ~155 rows with no
// way to jump to a given day. Grouping mirrors how Meter Book itself is
// laid out (one block per day) so the report reads the same way the data
// was entered.
const groupByDate = (rows, dateKey) => {
  const map = new Map()
  for (const r of rows) {
    const key = r[dateKey]
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(r)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => ({ date, rows: dayRows }))
}

export default function Reports() {
  const { showToast } = useToast()
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [activeSection, setActiveSection] = useState('s1')

  const loadReport = async () => {
    setLoading(true)
    setReport(null)
    try {
      const res = await api.get(`/reports/${month}`)
      const safe = {
        ...res.data,
        section1_fuel_sales: res.data.section1_fuel_sales || [],
        section2_sales_book: res.data.section2_sales_book || [],
        section3_banking: res.data.section3_banking || [],
        section4_credit_sales: res.data.section4_credit_sales || [],
        section5_consolidated: res.data.section5_consolidated || {
          total_revenue: 0, total_sxp_litres: 0, total_dxp_litres: 0,
          total_litres: 0, dealer_earnings: 0, total_expenses: 0, net_dealer_profit: 0,
          total_banked: 0, total_credit: 0,
        },
        section6_stock_movement: res.data.section6_stock_movement || [],
        // Rollup used to be computed twice client-side (once for the PDF,
        // once here) — now it's assembled once server-side; this is just
        // a safe fallback shape while `report` briefly hasn't loaded yet.
        section6_summary: res.data.section6_summary || {
          sxp: { opening: 0, received: 0, sold: 0, closing: 0, variance: 0 },
          dxp: { opening: 0, received: 0, sold: 0, closing: 0, variance: 0 },
          combined: { opening: 0, received: 0, sold: 0, closing: 0, variance: 0 },
        },
        section7_dealer_margin: res.data.section7_dealer_margin || {
          daily: [], total_litres: 0, margin_per_litre: 0.30, total_earnings: 0
        },
        previous_month: res.data.previous_month || { month: null, has_data: false, section5_consolidated: null },
        flags: res.data.flags || [],
        revenue_trend: res.data.revenue_trend || [],
      }
      setReport(safe)
      showToast('success', 'Report generated', month)
    } catch (err) {
      console.error('Report error:', err)
      showToast('error', 'Failed to load report', err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleExportPDF = async () => {
    setExporting(true)
    showToast('info', 'Generating PDF...', 'This may take a few seconds')
    try {
      // Was: manual fetch() to /pdf/:month with a hand-attached Bearer token.
      // That route (server/routes/pdf.js) re-ran the same 6 queries as this
      // endpoint and computed nothing — retired. Reusing `api` also picks up
      // its shared 15s timeout and 401-redirect handling for free.
      const { data } = await api.get(`/reports/${month}`)

      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

      const monthLabel = new Date(month + '-01').toLocaleString('default', { month: 'long', year: 'numeric' })
      const margin = data.dealer_margin_per_litre
      const meter = data.section1_fuel_sales || []
      const sales = data.section2_sales_book || []
      const banking = data.section3_banking || []
      const credits = data.section4_credit_sales || []
      const tanks = data.section6_stock_movement || []

      const totalSXP = meter.filter(r => r.fuel_type === 'SXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
      const totalDXP = meter.filter(r => r.fuel_type === 'DXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
      const totalLitres = totalSXP + totalDXP
      const totalRevenue = sales.reduce((s, r) => s + parseFloat(r.total_sales_ghs || 0), 0)
      const dealerEarnings = totalLitres * margin
      // total_expenses / total_banked / total_credit now computed once,
      // server-side, in section5_consolidated — no longer re-derived here.
      const totalExpenses = data.section5_consolidated.total_expenses
      const netDealerProfit = dealerEarnings - totalExpenses
      const totalBanked = data.section5_consolidated.total_banked
      const totalCredit = data.section5_consolidated.total_credit

      // ── GOIL brand palette ──────────────────────────────
      // GOIL's corporate colour is orange (company statement at the 2012
      // rebrand: "the corporate colour will remain orange to reflect the
      // goodness of the sun and the energy it provides"), paired with a
      // charcoal-grey wordmark. This report intentionally uses GOIL's own
      // brand colours rather than this app's internal navy/red UI tokens
      // (PRD §3.1) — the PDF is a station document that may be seen outside
      // this app, the in-app screens are not. If GOIL ever publishes an
      // official brand-guideline hex for the orange, swap ORANGE below —
      // every other value derives visually from these two anchors, so one
      // change here is the only change needed.
      const ORANGE       = [210, 90, 20]   // GOIL corporate orange
      const BLACK        = [0, 0, 0]
      const DARK_GREY    = [45, 45, 45]    // wordmark charcoal
      const LABEL_GREY   = [68, 68, 68]    // KPI/field labels — one step lighter than DARK_GREY
      const MID_GREY     = [150, 150, 150] // footnotes, source lines, cover meta text
      const ASH          = [220, 220, 220] // table header fill
      const LIGHT_ASH    = [240, 240, 240] // zebra-striped row fill
      const WHITE        = [255, 255, 255]

      // Semantic status colours — NOT brand colours. These flag good/bad
      // figures (variance, profit) and must stay green/red regardless of
      // what GOIL's brand palette is, same convention as the in-app screens.
      const GREEN       = [26, 107, 58]
      const GREEN_LIGHT = [237, 247, 241]
      const RED         = [196, 30, 30]
      const RED_LIGHT   = [253, 241, 241]

      const pw = 210
      const ph = 297
      const ml = 15
      const mr = 15
      const cw = pw - ml - mr
      let y = 0

      const newPage = () => { doc.addPage(); y = 20 }
      const checkPage = (needed = 20) => { if (y + needed > ph - 20) newPage() }

      // ── COVER PAGE ──────────────────────────────────────
      doc.setFillColor(...BLACK)
      doc.rect(0, 0, pw, 90, 'F')

      // Orange accent bar
      doc.setFillColor(...ORANGE)
      doc.rect(0, 90, pw, 3, 'F')

      doc.setFillColor(...ORANGE)
      doc.circle(ml, 25, 4, 'F')

      doc.setTextColor(...WHITE)
      doc.setFontSize(22)
      doc.setFont('helvetica', 'bold')
      doc.text('T-Man Kuntunso GOIL Station', ml + 8, 28)

      doc.setFontSize(13)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...MID_GREY)
      doc.text('Monthly Operations Report', ml + 8, 36)

      doc.setFontSize(10)
      doc.setTextColor(...MID_GREY)
      doc.text(`Report period: ${monthLabel}`, ml + 8, 52)
      doc.text(`Station: ${data.setup?.station_name || 'T-Man Kuntunso GOIL Station'}`, ml + 8, 58)
      doc.text(`Location: ${data.setup?.location || 'Kuntunso, Western Region'}`, ml + 8, 64)
      doc.text(`Generated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, ml + 8, 70)

      // KPI summary
      y = 102
      doc.setTextColor(...DARK_GREY)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...ORANGE)
      doc.text('KEY PERFORMANCE INDICATORS', ml, y)
      y += 6

      const kpis = [
        ['Total Fuel Sales Revenue', `GHS ${fmt(totalRevenue)}`, totalRevenue, 'total_revenue'],
        ['Total Litres Dispensed', fmtL(totalLitres), totalLitres, 'total_litres'],
        ['SXP Litres', fmtL(totalSXP), totalSXP, 'total_sxp_litres'],
        ['DXP Litres', fmtL(totalDXP), totalDXP, 'total_dxp_litres'],
        ['Total Banked', `GHS ${fmt(totalBanked)}`, totalBanked, 'total_banked'],
        ['Merka Wood Credit Sales', `GHS ${fmt(totalCredit)}`, totalCredit, 'total_credit'],
        ['Dealer Earnings', `GHS ${fmt(dealerEarnings)}`, dealerEarnings, 'dealer_earnings'],
        ['Total Expenses', `GHS ${fmt(totalExpenses)}`, totalExpenses, 'total_expenses'],
        ['Net Dealer Profit', `GHS ${fmt(netDealerProfit)}`, netDealerProfit, 'net_dealer_profit'],
      ]

      // Month-over-month deltas — null when there's no prior-month data to
      // compare against (e.g. the first month after launch) or when the
      // prior value was zero (a % change against zero is meaningless, not
      // "infinite growth"). Live re-query from the backend, not a stored
      // snapshot — see reports.js for why.
      const prevS5 = data.previous_month?.has_data ? data.previous_month.section5_consolidated : null

      doc.setFontSize(9)
      kpis.forEach(([label, value, rawValue, key], i) => {
        const isProfit = label === 'Net Dealer Profit'
        if (i % 2 === 0) {
          doc.setFillColor(...LIGHT_ASH)
          doc.rect(ml, y - 4, cw, 8, 'F')
        }
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(...LABEL_GREY)
        doc.text(label, ml + 2, y)

        if (prevS5 && parseFloat(prevS5[key] || 0) !== 0) {
          const prevVal = parseFloat(prevS5[key])
          const delta = (rawValue - prevVal) / Math.abs(prevVal)
          // jsPDF's built-in fonts don't include ▲/▼ (U+25B2/U+25BC) — they
          // silently substitute a fallback glyph instead of erroring, which
          // rendered as a stray "%" character. Plain +/- is in every font.
          const deltaText = `${delta >= 0 ? '+' : '-'}${Math.abs(delta * 100).toFixed(1)}%`
          doc.setFontSize(7.5)
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(...(delta >= 0 ? GREEN : RED))
          doc.text(deltaText, ml + 2 + doc.getTextWidth(label) + 7, y)
          doc.setFontSize(9)
        }

        doc.setFont('helvetica', 'bold')
        if (isProfit) {
          doc.setTextColor(...(netDealerProfit >= 0 ? GREEN : RED))
        } else {
          doc.setTextColor(...DARK_GREY)
        }
        doc.text(value, pw - mr, y, { align: 'right' })
        doc.setTextColor(...DARK_GREY)
        y += 8
      })

      // ── EXECUTIVE SUMMARY: Key Callouts ─────────────────
      // Deterministic, rule-based flags (revenue swing, tank variance,
      // creditor exposure, compliance expiry) computed server-side in
      // reports.js from FLAG_THRESHOLDS — nothing here is AI-generated,
      // every line traces to a specific number already in this report.
      const flags = data.flags || []
      if (flags.length > 0) {
        y += 6
        checkPage(14 + flags.length * 7)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.setTextColor(...ORANGE)
        doc.text('KEY CALLOUTS', ml, y)
        y += 7

        const FLAG_COLORS = { critical: RED, warning: [146, 83, 10], positive: GREEN }
        const FLAG_BG = { critical: RED_LIGHT, warning: [253, 245, 230], positive: GREEN_LIGHT }
        flags.forEach(flag => {
          checkPage(9)
          doc.setFillColor(...(FLAG_BG[flag.severity] || LIGHT_ASH))
          doc.rect(ml, y - 4.5, cw, 7.5, 'F')
          doc.setFillColor(...(FLAG_COLORS[flag.severity] || MID_GREY))
          doc.rect(ml, y - 4.5, 1.5, 7.5, 'F')
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(8)
          doc.setTextColor(...DARK_GREY)
          doc.text(flag.message, ml + 5, y)
          y += 7.5
        })
        y += 2
      }

      // ── EXECUTIVE SUMMARY: 6-month revenue trend ────────
      const trend = data.revenue_trend || []
      if (trend.length > 0) {
        y += 4
        checkPage(60)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.setTextColor(...ORANGE)
        doc.text('REVENUE TREND — LAST 6 MONTHS (SXP vs DXP)', ml, y)
        y += 4

        const chartX = ml + 4
        const chartW = cw - 8
        const chartH = 42
        const chartMax = Math.max(1, ...trend.flatMap(t => [t.sxp, t.dxp])) * 1.15
        const groupW = chartW / trend.length
        const barW = groupW * 0.30
        const barGap = groupW * 0.06

        doc.setDrawColor(...ASH)
        doc.setLineWidth(0.2)
        doc.line(chartX, y + chartH, chartX + chartW, y + chartH)

        trend.forEach((t, i) => {
          const groupX = chartX + i * groupW + groupW * 0.17
          const hSxp = (t.sxp / chartMax) * chartH
          const hDxp = (t.dxp / chartMax) * chartH
          doc.setFillColor(...ORANGE)
          doc.rect(groupX, y + chartH - hSxp, barW, hSxp, 'F')
          doc.setFillColor(...DARK_GREY)
          doc.rect(groupX + barW + barGap, y + chartH - hDxp, barW, hDxp, 'F')
          doc.setFontSize(6.5)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(...MID_GREY)
          const [ty, tm] = t.month.split('-')
          const monthShort = new Date(`${t.month}-01T00:00:00Z`).toLocaleString('default', { month: 'short', timeZone: 'UTC' })
          doc.text(monthShort, groupX + barW + barGap / 2, y + chartH + 5, { align: 'center' })
        })

        y += chartH + 10
        doc.setFillColor(...ORANGE)
        doc.rect(chartX, y - 3, 3, 3, 'F')
        doc.setFontSize(7.5)
        doc.setTextColor(...MID_GREY)
        doc.text('SXP revenue', chartX + 5, y)
        doc.setFillColor(...DARK_GREY)
        doc.rect(chartX + 35, y - 3, 3, 3, 'F')
        doc.text('DXP revenue', chartX + 40, y)
        y += 6
      }

      // ── SECTION 1: FUEL SALES ──────────────────────────
      newPage()
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 1 — FUEL SALES SUMMARY', ml + 6, y + 2)
      y += 12

      const s1Headers = ['Pump', 'Fuel', 'Litres Sold', 'Amount (GHS)', 'RTT (L)']
      const s1Widths = [30, 25, 40, 55, 30]
      const meterByDate = groupByDate(meter, 'reading_date')
      let x = ml

      meterByDate.forEach(({ date, rows }) => {
        // Try to keep a whole day's block together rather than splitting
        // it across a page break — date band + column header + every row
        // for that day, plus a small buffer.
        checkPage(6 + 5 + rows.length * 7 + 4)

        const dayLitres = rows.reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
        const dayAmount = rows.reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0)
        doc.setFillColor(...ORANGE)
        doc.rect(ml, y - 4, cw, 7, 'F')
        doc.setTextColor(...WHITE)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8)
        doc.text(date, ml + 2, y)
        doc.text(`${fmtL(dayLitres)}  ·  GHS ${fmt(dayAmount)}`, pw - mr - 1, y, { align: 'right' })
        y += 6

        doc.setFillColor(...ASH)
        doc.rect(ml, y - 4, cw, 6, 'F')
        doc.setTextColor(...ORANGE)
        doc.setFontSize(7)
        let hx = ml
        s1Headers.forEach((h, i) => { doc.text(h, hx + 1, y); hx += s1Widths[i] })
        y += 5

        doc.setFont('helvetica', 'normal')
        rows.forEach((r, idx) => {
          checkPage(7)
          if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
          doc.setTextColor(...DARK_GREY)
          let rx = ml
          const row = [r.pump_id, r.fuel_type, fmt(r.litres_sold), `GHS ${fmt(r.amount_ghs)}`, fmt(r.rtt_litres)]
          row.forEach((cell, i) => { doc.text(String(cell), rx + 1, y); rx += s1Widths[i] })
          y += 7
        })
        y += 3
      })

      checkPage(8)
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 8, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...DARK_GREY)
      x = ml
      const s1Totals = ['MONTH TOTAL', '', fmtL(totalLitres), `GHS ${fmt(totalRevenue)}`, fmtL(meter.reduce((s, r) => s + parseFloat(r.rtt_litres || 0), 0))]
      s1Totals.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += s1Widths[i] })
      y += 10

      doc.setFont('helvetica', 'italic')
      doc.setFontSize(7)
      doc.setTextColor(...MID_GREY)
      doc.text('RTT = Return to Tank. Stock event only — excluded from all revenue totals.', ml, y)
      y += 4
      doc.text('Dates shown are business dates, corrected for a confirmed one-day system-entry lag — one day earlier than the raw recorded date.', ml, y)
      y += 8

      // ── SECTION 2: SALES BOOK ──────────────────────────
      checkPage(40)
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 2 — SALES BOOK', ml + 6, y + 2)
      y += 12

      const s2Headers = ['Date', 'Cash', 'Coupons', 'GoCard', 'MoMo', 'Merka', 'Genset', 'Lubricant', 'Total']
      const s2Widths = [20, 20, 18, 18, 18, 20, 16, 16, 34]
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 7, 'F')
      doc.setTextColor(...ORANGE)
      doc.setFontSize(7)
      x = ml
      s2Headers.forEach((h, i) => { doc.text(h, x + 1, y); x += s2Widths[i] })
      y += 5

      doc.setTextColor(...DARK_GREY)
      doc.setFont('helvetica', 'normal')
      sales.forEach((s, idx) => {
        checkPage(7)
        if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
        x = ml
        const row = [s.entry_date, fmt(s.physical_cash_ghs || 0), fmt(s.coupons_ghs), fmt(s.gocard_ghs), fmt(s.momo_ghs), fmt(s.merka_wood_ghs), fmt(s.genset_ghs), fmt(s.lubricant_ghs), `GHS ${fmt(s.total_sales_ghs)}`]
        row.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += s2Widths[i] })
        y += 7
      })

      if (sales.length > 0) {
        checkPage(8)
        doc.setFillColor(...ASH)
        doc.rect(ml, y - 4, cw, 8, 'F')
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(...DARK_GREY)
        x = ml
        const s2Totals = [
          'TOTAL', '',
          '', '', '', '', '', '',
          `GHS ${fmt(sales.reduce((s, r) => s + parseFloat(r.total_sales_ghs || 0), 0))}`,
        ]
        s2Totals.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += s2Widths[i] })
        y += 10
      }

      if (sales.length === 0) {
        doc.setTextColor(...MID_GREY)
        doc.setFontSize(8)
        doc.text('No data for this period', ml + cw / 2, y + 5, { align: 'center' })
        y += 12
      }

      doc.setFont('helvetica', 'italic')
      doc.setFontSize(7)
      doc.setTextColor(...MID_GREY)
      doc.text('Dates shown are business dates, corrected for a confirmed one-day system-entry lag.', ml, y)
      y += 8

      // ── SECTION 3: BANKING ─────────────────────────────
      checkPage(40)
      newPage()
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 3 — BANKING', ml + 6, y + 2)
      y += 12

      const s3Headers = ['Date', 'NIB', 'UMB/MoMo', 'GoCard', 'Coupons @50', 'Coupons @100', 'Total Banked']
      const s3Widths = [22, 25, 25, 25, 28, 28, 27]
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 7, 'F')
      doc.setTextColor(...ORANGE)
      doc.setFontSize(7)
      x = ml
      s3Headers.forEach((h, i) => { doc.text(h, x + 1, y); x += s3Widths[i] })
      y += 5

      doc.setTextColor(...DARK_GREY)
      doc.setFont('helvetica', 'normal')
      banking.forEach((b, idx) => {
        checkPage(7)
        if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
        x = ml
        const row = [b.entry_date, fmt(b.nib_ghs), fmt(b.umb_momo_ghs), fmt(b.gocard_ghs), fmt(b.coupons_50_ghs), fmt(b.coupons_100_ghs), `GHS ${fmt(b.total_banked_ghs)}`]
        row.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += s3Widths[i] })
        y += 7
      })

      checkPage(8)
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 8, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...DARK_GREY)
      doc.setFontSize(8)
      doc.text('TOTAL BANKED', ml + 2, y)
      doc.text(`GHS ${fmt(totalBanked)}`, pw - mr, y, { align: 'right' })
      y += 12

      // ── SECTION 4: MERKA WOOD ──────────────────────────
      checkPage(40)
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 4 — MERKA WOOD CREDIT SALES', ml + 6, y + 2)
      y += 12

      const s4Headers = ['Date', 'SXP (L)', 'DXP (L)', 'SXP Amount', 'DXP Amount', 'Total']
      const s4Widths = [25, 25, 25, 35, 35, 35]
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 7, 'F')
      doc.setTextColor(...ORANGE)
      doc.setFontSize(8)
      x = ml
      s4Headers.forEach((h, i) => { doc.text(h, x + 1, y); x += s4Widths[i] })
      y += 5

      doc.setTextColor(...DARK_GREY)
      doc.setFont('helvetica', 'normal')
      credits.forEach((c, idx) => {
        checkPage(7)
        if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
        x = ml
        const row = [c.sale_date, fmt(c.sxp_litres), fmt(c.dxp_litres), parseFloat(c.sxp_amount_ghs) > 0 ? `GHS ${fmt(c.sxp_amount_ghs)}` : '—', `GHS ${fmt(c.dxp_amount_ghs)}`, `GHS ${fmt(c.total_amount_ghs)}`]
        row.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += s4Widths[i] })
        y += 7
      })

      if (credits.length === 0) {
        doc.setTextColor(...MID_GREY)
        doc.setFontSize(8)
        doc.text('No credit sales for this period', ml + cw / 2, y + 5, { align: 'center' })
        y += 12
      }

      doc.setFont('helvetica', 'italic')
      doc.setFontSize(7)
      doc.setTextColor(...MID_GREY)
      doc.text('Dates shown are business dates, corrected for a confirmed one-day system-entry lag.', ml, y)
      y += 8

      // ── SECTION 5: CONSOLIDATED ────────────────────────
      newPage()
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 5 — CONSOLIDATED FINANCIAL SUMMARY', ml + 6, y + 2)
      y += 15

      const formulaRows = [
        { step: '1', label: 'Total Revenue (Meter Book)', value: `GHS ${fmt(totalRevenue)}`, source: 'SUM(sales_book.total_sales_ghs)', highlight: null },
        { step: '', label: 'SXP litres dispensed', value: fmtL(totalSXP), source: 'fuel_type = SXP', highlight: null },
        { step: '', label: 'DXP litres dispensed', value: fmtL(totalDXP), source: 'fuel_type = DXP', highlight: null },
        { step: '', label: 'Total litres dispensed', value: fmtL(totalLitres), source: 'SXP + DXP', highlight: null },
        { step: '2', label: 'Dealer Earnings', value: `GHS ${fmt(dealerEarnings)}`, source: `Total litres × GHS ${margin}/L`, highlight: 'green' },
        { step: '3', label: 'Total Expenses', value: `GHS ${fmt(totalExpenses)}`, source: 'SUM(expenses.amount_ghs)', highlight: null },
        { step: '4', label: 'NET DEALER PROFIT ★', value: `GHS ${fmt(netDealerProfit)}`, source: 'Dealer Earnings − Total Expenses', highlight: netDealerProfit >= 0 ? 'green' : 'red' },
      ]

      formulaRows.forEach((row, idx) => {
        checkPage(12)
        if (row.highlight === 'green') {
          doc.setFillColor(...GREEN_LIGHT)
          doc.rect(ml, y - 5, cw, 10, 'F')
        } else if (row.highlight === 'red') {
          doc.setFillColor(...RED_LIGHT)
          doc.rect(ml, y - 5, cw, 10, 'F')
        } else if (idx % 2 === 0) {
          doc.setFillColor(...LIGHT_ASH)
          doc.rect(ml, y - 5, cw, 10, 'F')
        }

        if (row.step) {
          doc.setFillColor(...ORANGE)
          doc.rect(ml, y - 5, 10, 10, 'F')
          doc.setTextColor(...WHITE)
          doc.setFontSize(8)
          doc.setFont('helvetica', 'bold')
          doc.text(`Step ${row.step}`, ml + 1, y)
        }

        doc.setFont('helvetica', row.step || row.highlight ? 'bold' : 'normal')
        doc.setFontSize(9)
        if (row.highlight === 'green') doc.setTextColor(...GREEN)
        else if (row.highlight === 'red') doc.setTextColor(...RED)
        else doc.setTextColor(...DARK_GREY)
        doc.text(row.label, ml + 13, y)
        doc.text(row.value, pw - mr, y, { align: 'right' })

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7)
        doc.setTextColor(...MID_GREY)
        doc.text(row.source, ml + 13, y + 4)
        y += 13
      })

      y += 4
      doc.setFontSize(7)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(...MID_GREY)
      doc.text(`★ Total Revenue is shown for audit purposes only. Dealer income = GHS ${margin}/L margin, not total revenue.`, ml, y)
      y += 12

      // ── SECTION 6: STOCK MOVEMENT ──────────────────────
      checkPage(60)
      doc.setFillColor(...DARK_GREY)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setFillColor(...ORANGE)
      doc.rect(ml, y - 5, 3, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('SECTION 6 — MONTHLY STOCK MOVEMENT', ml + 6, y + 2)
      y += 15

      const { sxp: sxpStock, dxp: dxpStock } = data.section6_summary
      const sxpOpening = sxpStock.opening
      const sxpReceived = sxpStock.received
      const sxpSold = sxpStock.sold
      const sxpClosing = sxpStock.closing
      const dxpOpening = dxpStock.opening
      const dxpReceived = dxpStock.received
      const dxpSold = dxpStock.sold
      const dxpClosing = dxpStock.closing
      const sxpVar = sxpStock.variance
      const dxpVar = dxpStock.variance

      const stockRows = [
        ['Opening stock — 1st of month', fmtL(sxpOpening), fmtL(dxpOpening), fmtL(sxpOpening + dxpOpening)],
        ['Total received this month', fmtL(sxpReceived), fmtL(dxpReceived), fmtL(sxpReceived + dxpReceived)],
        ['Total sold this month', fmtL(sxpSold), fmtL(dxpSold), fmtL(sxpSold + dxpSold)],
        ['Expected closing stock', fmtL(sxpOpening + sxpReceived - sxpSold), fmtL(dxpOpening + dxpReceived - dxpSold), fmtL(sxpOpening + sxpReceived - sxpSold + dxpOpening + dxpReceived - dxpSold)],
        ['Actual closing stock (last dip)', fmtL(sxpClosing), fmtL(dxpClosing), fmtL(sxpClosing + dxpClosing)],
      ]

      const sWidths = [70, 35, 35, 40]
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 7, 'F')
      doc.setTextColor(...ORANGE)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      x = ml
      ;['Metric', 'SXP (Tank A)', 'DXP (Tank B)', 'Combined'].forEach((h, i) => { doc.text(h, x + 1, y); x += sWidths[i] })
      y += 5

      stockRows.forEach((row, idx) => {
        checkPage(7)
        if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(...DARK_GREY)
        doc.setFontSize(8)
        x = ml
        row.forEach((cell, i) => { doc.text(String(cell), x + 1, y); x += sWidths[i] })
        y += 7
      })

      checkPage(8)
      doc.setFillColor(...ASH)
      doc.rect(ml, y - 4, cw, 8, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.text('Net variance', ml + 1, y)
      const varCols = [sxpVar, dxpVar, sxpVar + dxpVar]
      let vx = ml + sWidths[0]
      varCols.forEach((v, i) => {
        doc.setTextColor(...(v >= 0 ? GREEN : RED))
        doc.text(`${v >= 0 ? '+' : ''}${fmtL(v)}`, vx + 1, y)
        vx += sWidths[i + 1]
      })
      y += 12

      // ── SECTION 7: DEALER MARGIN ───────────────────────
      checkPage(40)
      doc.setFillColor(...GREEN)
      doc.rect(ml, y - 5, cw, 10, 'F')
      doc.setTextColor(...WHITE)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text(`SECTION 7 — DEALER MARGIN SUMMARY (GHS ${margin}/L)`, ml + 2, y + 2)
      y += 12

      const s7Headers = ['Pump', 'Fuel', 'Litres Dispensed', 'Rate (GHS/L)', 'Dealer Earnings']
      const s7Widths = [25, 25, 45, 35, 50]

      meterByDate.forEach(({ date, rows }) => {
        checkPage(6 + 5 + rows.length * 7 + 4)

        const dayLitres = rows.reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
        const dayEarnings = dayLitres * margin
        doc.setFillColor(...GREEN)
        doc.rect(ml, y - 4, cw, 7, 'F')
        doc.setTextColor(...WHITE)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8)
        doc.text(date, ml + 2, y)
        doc.text(`${fmtL(dayLitres)}  ·  GHS ${fmt(dayEarnings)}`, pw - mr - 1, y, { align: 'right' })
        y += 6

        doc.setFillColor(...GREEN_LIGHT)
        doc.rect(ml, y - 4, cw, 6, 'F')
        doc.setTextColor(...GREEN)
        doc.setFontSize(7)
        let hx = ml
        s7Headers.forEach((h, i) => { doc.text(h, hx + 1, y); hx += s7Widths[i] })
        y += 5

        doc.setFont('helvetica', 'normal')
        rows.forEach((r, idx) => {
          checkPage(7)
          if (idx % 2 === 0) { doc.setFillColor(...LIGHT_ASH); doc.rect(ml, y - 4, cw, 7, 'F') }
          let rx = ml
          const earnings = parseFloat(r.litres_sold) * margin
          const row = [r.pump_id, r.fuel_type, fmtL(r.litres_sold), String(margin), `GHS ${fmt(earnings)}`]
          row.forEach((cell, i) => {
            doc.setTextColor(...(i === 4 ? GREEN : DARK_GREY))
            doc.text(String(cell), rx + 1, y)
            rx += s7Widths[i]
          })
          y += 7
        })
        y += 3
      })

      checkPage(10)
      doc.setFillColor(...GREEN_LIGHT)
      doc.rect(ml, y - 4, cw, 10, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(...DARK_GREY)
      doc.text('MONTHLY TOTAL', ml + 1, y)
      doc.text(fmtL(totalLitres), ml + s7Widths[0] + s7Widths[1] + 1, y)
      doc.setTextColor(...GREEN)
      doc.setFontSize(11)
      doc.text(`GHS ${fmt(dealerEarnings)}`, pw - mr, y, { align: 'right' })
      y += 12

      doc.setFont('helvetica', 'italic')
      doc.setFontSize(7)
      doc.setTextColor(...MID_GREY)
      doc.text('Dates shown are business dates, corrected for a confirmed one-day system-entry lag.', ml, y)
      y += 8

      // ── FOOTER on all pages ────────────────────────────
      const totalPages = doc.getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        doc.setFillColor(...DARK_GREY)
        doc.rect(0, ph - 12, pw, 12, 'F')
        doc.setTextColor(...MID_GREY)
        doc.setFontSize(7)
        doc.setFont('helvetica', 'normal')
        doc.text(`T-Man Kuntunso GOIL Station · ${monthLabel} Report · Confidential`, ml, ph - 5)
        doc.text(`Page ${i} of ${totalPages}`, pw - mr, ph - 5, { align: 'right' })
      }

      doc.save(`GOIL-Kuntunso-${month}.pdf`)
      showToast('success', 'PDF downloaded', `GOIL-Kuntunso-${month}.pdf`)
    } catch (err) {
      console.error('PDF export error:', err)
      showToast('error', 'PDF export failed', err.message)
    } finally {
      setExporting(false)
    }
  }

  const s5 = report?.section5_consolidated

  const months = []
  for (let i = 0; i < 6; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    months.push(d.toISOString().slice(0, 7))
  }

  const sections = [
    { key: 's1', label: 'Section 1', title: 'Fuel Sales' },
    { key: 's2', label: 'Section 2', title: 'Sales Book' },
    { key: 's3', label: 'Section 3', title: 'Banking' },
    { key: 's4', label: 'Section 4', title: 'Merka Wood' },
    { key: 's5', label: 'Section 5', title: 'Consolidated' },
    { key: 's6', label: 'Section 6', title: 'Stock Movement' },
    { key: 's7', label: 'Section 7', title: 'Dealer Margin' },
  ]

  return (
    <div>
      <div className="page-header">
        <div><h2>Reports</h2><p>Monthly operations report — 7 sections</p></div>
        <div className="page-header-actions">
          <select className="form-select" value={month}
            onChange={e => setMonth(e.target.value)} style={{ width: 160 }}>
            {months.map(m => (
              <option key={m} value={m}>
                {new Date(m + '-01').toLocaleString('default', { month: 'long', year: 'numeric' })}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={loadReport} disabled={loading}>
            <i className="ph ph-chart-bar"></i> {loading ? 'Generating...' : 'Generate report'}
          </button>
          {report && (
            <button className="btn btn-ghost" onClick={handleExportPDF} disabled={exporting}>
              <i className="ph ph-download-simple"></i> {exporting ? 'Exporting...' : 'Export PDF'}
            </button>
          )}
        </div>
      </div>

      {!report && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 48 }}>
          <i className="ph ph-chart-bar" style={{ fontSize: 48, color: 'var(--text-3)', display: 'block', marginBottom: 16 }}></i>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--navy)', marginBottom: 8 }}>
            Select a month and generate the report
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
            All 7 sections will appear — fuel sales, banking, creditors, stock movement, and dealer margin summary.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={loadReport} disabled={loading}>
            <i className="ph ph-chart-bar"></i> Generate report
          </button>
        </div>
      )}

      {report && (
        <>
          {/* KPI summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
            <div className="kpi-card kpi-red">
              <div className="kpi-label">Total revenue</div>
              <div className="kpi-value">GHS {fmt(s5?.total_revenue || 0)}</div>
              <div className="kpi-sub">Meter book total</div>
            </div>
            <div className="kpi-card kpi-blue">
              <div className="kpi-label">Total litres</div>
              <div className="kpi-value">{fmt(s5?.total_litres || 0)} L</div>
              <div className="kpi-sub">SXP {parseFloat(s5?.total_sxp_litres || 0).toFixed(2)} · DXP {parseFloat(s5?.total_dxp_litres || 0).toFixed(2)}</div>
            </div>
            <div className="kpi-card kpi-green">
              <div className="kpi-label">Dealer earnings</div>
              <div className="kpi-value">GHS {fmt(s5?.dealer_earnings || 0)}</div>
              <div className="kpi-sub">GHS {report.dealer_margin_per_litre}/L × {parseFloat(s5?.total_litres || 0).toFixed(2)} L</div>
            </div>
            <div className="kpi-card kpi-green">
              <div className="kpi-label">Net dealer profit</div>
              <div className="kpi-value" style={{ color: parseFloat(s5?.net_dealer_profit || 0) < 0 ? 'var(--red)' : 'var(--navy)' }}>
                GHS {fmt(s5?.net_dealer_profit || 0)}
              </div>
              <div className="kpi-sub">Earnings − Expenses</div>
            </div>
          </div>

          {/* Section nav */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' }}>
            {sections.map(s => (
              <button key={s.key}
                className={`btn btn-sm ${activeSection === s.key ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setActiveSection(s.key)}>
                {s.label} — {s.title}
              </button>
            ))}
          </div>

          {/* Section 1 */}
          {activeSection === 's1' && (
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Section 1 — Fuel Sales Summary</div>
                  <div className="card-subtitle">Daily SXP/DXP litres and revenue · RTT shown for reference only</div>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pump</th><th>Fuel</th>
                      <th>Litres sold</th><th>Amount (GHS)</th>
                      <th style={{ background: 'var(--amber)' }}>RTT (L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupByDate(report.section1_fuel_sales, 'reading_date').map(({ date, rows }) => (
                      <Fragment key={date}>
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--navy-light)', color: 'var(--navy)', fontWeight: 700, fontSize: 12 }}>
                            {date}
                            <span style={{ float: 'right', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                              {rows.reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0).toFixed(2)} L · GHS {rows.reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0).toFixed(2)}
                            </span>
                          </td>
                        </tr>
                        {rows.map(r => (
                          <tr key={r.id}>
                            <td><span className="badge badge-navy">{r.pump_id}</span></td>
                            <td><span className={`badge ${r.fuel_type === 'SXP' ? 'badge-blue' : 'badge-amber'}`}>{r.fuel_type}</span></td>
                            <td className="td-calc">{parseFloat(r.litres_sold).toFixed(2)}</td>
                            <td className="td-calc">GHS {parseFloat(r.amount_ghs).toFixed(2)}</td>
                            <td style={{ background: 'var(--amber-subtle)', color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {parseFloat(r.rtt_litres).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                    {report.section1_fuel_sales.length === 0 && (
                      <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No data for this period</td></tr>
                    )}
                    {report.section1_fuel_sales.length > 0 && (
                      <tr className="tr-total">
                        <td colSpan={2}><strong>Month total</strong></td>
                        <td className="td-calc"><strong>{parseFloat(s5?.total_litres || 0).toFixed(2)} L</strong></td>
                        <td className="td-calc"><strong>GHS {parseFloat(s5?.total_revenue || 0).toFixed(2)}</strong></td>
                        <td style={{ background: 'var(--amber-subtle)', color: 'var(--amber)', fontWeight: 700 }}>
                          {report.section1_fuel_sales.reduce((s, r) => s + parseFloat(r.rtt_litres || 0), 0).toFixed(2)} L
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
                RTT = Return to Tank. Stock event only — excluded from all revenue totals.<br />
                Dates shown are business dates, corrected for a confirmed one-day system-entry lag — one day earlier than the raw recorded date.
              </div>
            </div>
          )}

          {/* Section 2 */}
          {activeSection === 's2' && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Section 2 — Sales Book</div>
                <div className="card-subtitle">Revenue by channel · RTT excluded</div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Cash</th><th>Coupons</th><th>GoCard</th><th>MoMo</th><th>Merka</th><th>Genset</th><th>Lubricant</th><th>Total</th><th>Variance</th></tr>
                  </thead>
                  <tbody>
                    {report.section2_sales_book.map(s => (
                      <tr key={s.id}>
                        <td>{s.entry_date}</td>
                        <td className="td-calc">{parseFloat(s.physical_cash_ghs || 0).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.coupons_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.gocard_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.momo_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.merka_wood_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.genset_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(s.lubricant_ghs).toFixed(2)}</td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(s.total_sales_ghs).toFixed(2)}</td>
                        <td><span className={`badge ${parseFloat(s.variance_ghs) >= 0 ? 'badge-green' : 'badge-red'}`}>{parseFloat(s.variance_ghs) >= 0 ? '+' : ''}{parseFloat(s.variance_ghs).toFixed(2)}</span></td>
                      </tr>
                    ))}
                    {report.section2_sales_book.length === 0 && (
                      <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No data for this period</td></tr>
                    )}
                    {report.section2_sales_book.length > 0 && (
                      <tr className="tr-total">
                        <td><strong>Total</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.physical_cash_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.coupons_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.gocard_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.momo_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.merka_wood_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.genset_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section2_sales_book.reduce((s, r) => s + parseFloat(r.lubricant_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(s5?.total_revenue || 0).toFixed(2)}</td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
                Dates shown are business dates, corrected for a confirmed one-day system-entry lag.
              </div>
            </div>
          )}

          {/* Section 3 */}
          {activeSection === 's3' && (
            <div className="card">
              <div className="card-header"><div className="card-title">Section 3 — Banking</div></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Date</th><th>NIB</th><th>MoMo</th><th>GoCard</th><th>Coupons @50</th><th>Coupons @100</th><th>Total banked</th></tr>
                  </thead>
                  <tbody>
                    {report.section3_banking.map(b => (
                      <tr key={b.id}>
                        <td>{b.entry_date}</td>
                        <td className="td-calc">{parseFloat(b.nib_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(b.umb_momo_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(b.gocard_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(b.coupons_50_ghs).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(b.coupons_100_ghs).toFixed(2)}</td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(b.total_banked_ghs).toFixed(2)}</td>
                      </tr>
                    ))}
                    {report.section3_banking.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No data for this period</td></tr>
                    )}
                    {report.section3_banking.length > 0 && (
                      <tr className="tr-total">
                        <td><strong>Total</strong></td>
                        <td className="td-calc"><strong>{report.section3_banking.reduce((s, b) => s + parseFloat(b.nib_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section3_banking.reduce((s, b) => s + parseFloat(b.umb_momo_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section3_banking.reduce((s, b) => s + parseFloat(b.gocard_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section3_banking.reduce((s, b) => s + parseFloat(b.coupons_50_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc"><strong>{report.section3_banking.reduce((s, b) => s + parseFloat(b.coupons_100_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {report.section3_banking.reduce((s, b) => s + parseFloat(b.total_banked_ghs || 0), 0).toFixed(2)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Section 4 */}
          {activeSection === 's4' && (
            <div className="card">
              <div className="card-header"><div className="card-title">Section 4 — Merka Wood Credit Sales</div></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Date</th><th>SXP (L)</th><th>DXP (L)</th><th>SXP amt</th><th>DXP amt</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {report.section4_credit_sales.map(cs => (
                      <tr key={cs.id}>
                        <td>{cs.sale_date}</td>
                        <td className="td-calc">{parseFloat(cs.sxp_litres).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(cs.dxp_litres).toFixed(2)}</td>
                        <td className="td-calc">{parseFloat(cs.sxp_amount_ghs) > 0 ? 'GHS ' + parseFloat(cs.sxp_amount_ghs).toFixed(2) : '—'}</td>
                        <td className="td-calc">GHS {parseFloat(cs.dxp_amount_ghs).toFixed(2)}</td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(cs.total_amount_ghs).toFixed(2)}</td>
                      </tr>
                    ))}
                    {report.section4_credit_sales.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No credit sales for this period</td></tr>
                    )}
                    {report.section4_credit_sales.length > 0 && (
                      <tr className="tr-total">
                        <td><strong>Total</strong></td>
                        <td className="td-calc"><strong>{report.section4_credit_sales.reduce((s, c) => s + parseFloat(c.sxp_litres || 0), 0).toFixed(2)} L</strong></td>
                        <td className="td-calc"><strong>{report.section4_credit_sales.reduce((s, c) => s + parseFloat(c.dxp_litres || 0), 0).toFixed(2)} L</strong></td>
                        <td></td>
                        <td className="td-calc"><strong>GHS {report.section4_credit_sales.reduce((s, c) => s + parseFloat(c.dxp_amount_ghs || 0), 0).toFixed(2)}</strong></td>
                        <td className="td-calc" style={{ fontWeight: 700 }}>GHS {report.section4_credit_sales.reduce((s, c) => s + parseFloat(c.total_amount_ghs || 0), 0).toFixed(2)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
                Dates shown are business dates, corrected for a confirmed one-day system-entry lag.
              </div>
            </div>
          )}

          {/* Section 5 */}
          {activeSection === 's5' && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Section 5 — Consolidated Financial Summary</div>
                <div className="card-subtitle">Formula chain: Total Revenue → Dealer Earnings → Total Expenses → Net Dealer Profit</div>
              </div>
              <table>
                <thead><tr><th>Step</th><th>Metric</th><th>Value</th><th>Source</th></tr></thead>
                <tbody>
                  <tr>
                    <td><span className="badge badge-navy">1</span></td>
                    <td><strong>Total Revenue</strong></td>
                    <td className="td-calc">GHS {fmt(s5?.total_revenue || 0)}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>SUM(sales_book.total_sales_ghs)</td>
                  </tr>
                  <tr>
                    <td></td><td>SXP litres dispensed</td>
                    <td className="td-calc">{parseFloat(s5?.total_sxp_litres || 0).toFixed(2)} L</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>fuel_type = SXP</td>
                  </tr>
                  <tr>
                    <td></td><td>DXP litres dispensed</td>
                    <td className="td-calc">{parseFloat(s5?.total_dxp_litres || 0).toFixed(2)} L</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>fuel_type = DXP</td>
                  </tr>
                  <tr>
                    <td></td><td>Total litres dispensed</td>
                    <td className="td-calc">{parseFloat(s5?.total_litres || 0).toFixed(2)} L</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>SXP + DXP</td>
                  </tr>
                  <tr style={{ background: 'var(--green-subtle)' }}>
                    <td><span className="badge badge-green">2</span></td>
                    <td><strong>Dealer Earnings</strong></td>
                    <td className="td-calc" style={{ color: 'var(--green)', fontWeight: 700 }}>GHS {fmt(s5?.dealer_earnings || 0)}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>Total litres × GHS {report.dealer_margin_per_litre}/L</td>
                  </tr>
                  <tr>
                    <td><span className="badge badge-red">3</span></td>
                    <td><strong>Total Expenses</strong></td>
                    <td className="td-calc">GHS {fmt(s5?.total_expenses || 0)}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>SUM(expenses.amount_ghs)</td>
                  </tr>
                  <tr style={{ background: parseFloat(s5?.net_dealer_profit || 0) < 0 ? 'var(--red-subtle)' : 'var(--green-subtle)' }}>
                    <td><span className={`badge ${parseFloat(s5?.net_dealer_profit || 0) >= 0 ? 'badge-green' : 'badge-red'}`}>4</span></td>
                    <td><strong>Net Dealer Profit ★</strong></td>
                    <td className="td-calc" style={{ color: parseFloat(s5?.net_dealer_profit || 0) < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 700, fontSize: 15 }}>
                      GHS {fmt(s5?.net_dealer_profit || 0)}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>Dealer Earnings − Total Expenses</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.6, padding: '10px 12px', background: 'var(--navy-light)', border: '1px solid var(--navy-border)', borderRadius: 'var(--r-sm)' }}>
                ★ Total Revenue (Step 1) is shown for cross-checking only — it is NOT used to calculate Net Dealer Profit. The dealer's income is the margin (GHS {report.dealer_margin_per_litre}/L), not the total revenue which is remitted to GOIL for restocking.
              </div>
            </div>
          )}

          {/* Section 6 */}
          {activeSection === 's6' && (
            <div className="card" style={{ borderColor: 'var(--navy-border)' }}>
              <div className="card-header">
                <div className="card-title">Section 6 — Monthly Stock Movement</div>
                <div className="card-subtitle">Opening stock + received − sold = closing · per fuel type</div>
              </div>
              {(() => {
                // Was: a second copy of the same rollup formula computed
                // in handleExportPDF for the PDF — now both read
                // report.section6_summary, computed once server-side.
                const { sxp, dxp, combined } = report.section6_summary
                return (
                  <table>
                    <thead><tr><th>Metric</th><th>SXP (Tank A)</th><th>DXP (Tank B)</th><th>Combined</th></tr></thead>
                    <tbody>
                      <tr><td><strong>Opening stock — 1st of month</strong></td><td className="td-calc">{sxp.opening.toFixed(2)} L</td><td className="td-calc">{dxp.opening.toFixed(2)} L</td><td className="td-calc">{combined.opening.toFixed(2)} L</td></tr>
                      <tr><td><strong>Total received this month</strong></td><td className="td-calc">{sxp.received.toFixed(2)} L</td><td className="td-calc">{dxp.received.toFixed(2)} L</td><td className="td-calc">{combined.received.toFixed(2)} L</td></tr>
                      <tr><td><strong>Total sold this month</strong></td><td className="td-calc">{sxp.sold.toFixed(2)} L</td><td className="td-calc">{dxp.sold.toFixed(2)} L</td><td className="td-calc">{combined.sold.toFixed(2)} L</td></tr>
                      <tr><td><strong>Expected closing stock</strong></td><td className="td-calc">{(sxp.opening + sxp.received - sxp.sold).toFixed(2)} L</td><td className="td-calc">{(dxp.opening + dxp.received - dxp.sold).toFixed(2)} L</td><td className="td-calc">{(combined.opening + combined.received - combined.sold).toFixed(2)} L</td></tr>
                      <tr><td><strong>Actual closing stock (last dip)</strong></td><td className="td-calc">{sxp.closing.toFixed(2)} L</td><td className="td-calc">{dxp.closing.toFixed(2)} L</td><td className="td-calc">{combined.closing.toFixed(2)} L</td></tr>
                      <tr className="tr-total">
                        <td><strong>Net variance</strong></td>
                        <td><span className={`badge ${sxp.variance >= 0 ? 'badge-green' : 'badge-red'}`}>{sxp.variance >= 0 ? '+' : ''}{sxp.variance.toFixed(2)} L</span></td>
                        <td><span className={`badge ${dxp.variance >= 0 ? 'badge-green' : 'badge-red'}`}>{dxp.variance >= 0 ? '+' : ''}{dxp.variance.toFixed(2)} L</span></td>
                        <td><span className={`badge ${combined.variance >= 0 ? 'badge-green' : 'badge-red'}`}>{combined.variance >= 0 ? '+' : ''}{combined.variance.toFixed(2)} L</span></td>
                      </tr>
                    </tbody>
                  </table>
                )
              })()}
              {report.section6_stock_movement.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No tank stock data for this period</div>
              )}
            </div>
          )}

          {/* Section 7 */}
          {activeSection === 's7' && (
            <div className="card" style={{ borderColor: 'var(--green-border)' }}>
              <div className="card-header">
                <div>
                  <div className="card-title" style={{ color: 'var(--green)' }}>Section 7 — Dealer Margin Summary</div>
                  <div className="card-subtitle">GHS {report.dealer_margin_per_litre}/L × total litres dispensed</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 2 }}>Monthly total</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                    GHS {parseFloat(s5?.dealer_earnings || 0).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {parseFloat(s5?.total_litres || 0).toFixed(2)} L × GHS {report.dealer_margin_per_litre}
                  </div>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Pump</th><th>Fuel</th><th>Litres</th><th>Rate (GHS/L)</th><th>Dealer earnings</th></tr>
                  </thead>
                  <tbody>
                    {groupByDate(report.section7_dealer_margin.daily, 'reading_date').map(({ date, rows }) => {
                      const dayLitres = rows.reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
                      const dayEarnings = dayLitres * parseFloat(report.dealer_margin_per_litre)
                      return (
                        <Fragment key={date}>
                          <tr>
                            <td colSpan={5} style={{ background: 'var(--green-subtle)', color: 'var(--green)', fontWeight: 700, fontSize: 12 }}>
                              {date}
                              <span style={{ float: 'right', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                                {dayLitres.toFixed(2)} L · GHS {dayEarnings.toFixed(2)}
                              </span>
                            </td>
                          </tr>
                          {rows.map(r => (
                            <tr key={r.id}>
                              <td><span className="badge badge-navy">{r.pump_id}</span></td>
                              <td><span className={`badge ${r.fuel_type === 'SXP' ? 'badge-blue' : 'badge-amber'}`}>{r.fuel_type}</span></td>
                              <td className="td-calc">{parseFloat(r.litres_sold).toFixed(2)}</td>
                              <td className="td-calc">{report.dealer_margin_per_litre}</td>
                              <td className="td-calc" style={{ color: 'var(--green)' }}>
                                GHS {(parseFloat(r.litres_sold) * parseFloat(report.dealer_margin_per_litre)).toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      )
                    })}
                    {report.section7_dealer_margin.daily.length === 0 && (
                      <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No data for this period</td></tr>
                    )}
                    {report.section7_dealer_margin.daily.length > 0 && (
                      <tr className="tr-total">
                        <td colSpan={2}><strong>Monthly total</strong></td>
                        <td className="td-calc"><strong>{parseFloat(s5?.total_litres || 0).toFixed(2)} L</strong></td>
                        <td className="td-calc">{report.dealer_margin_per_litre}</td>
                        <td className="td-calc" style={{ color: 'var(--green)', fontSize: 15 }}>
                          <strong>GHS {parseFloat(s5?.dealer_earnings || 0).toFixed(2)}</strong>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
                Dates shown are business dates, corrected for a confirmed one-day system-entry lag.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}