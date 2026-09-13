const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOrManager } = require('../middleware/auth');

// ── Report assembly — single source of truth ─────────────────────
// Previously this logic existed in three places: this file (Section 5
// only, Section 6 passed through raw), server/routes/pdf.js (a parallel
// route that re-ran the same 6 queries and did zero computation), and
// client/src/pages/Reports.jsx (which computed the Section 6 stock-
// movement rollup itself, twice — once for the in-app screen, once again
// for the PDF export, same formula copy-pasted). pdf.js has been retired;
// the PDF export now calls this same GET /:month endpoint the in-app
// screen already used. One formula, one place.

function monthDateRange(month) {
  const startDate = `${month}-01`;
  const endDate = new Date(
    new Date(startDate).getFullYear(),
    new Date(startDate).getMonth() + 1, 0
  ).toISOString().split('T')[0];
  return { startDate, endDate };
}

// ── One-day entry lag — meter readings, Sales Book, Merka Wood credit ──
//
// Confirmed against the physical Merka Wood ledger: what's recorded under
// date N in the system actually happened on date N-1 (staff enter the
// previous day's business the next morning, tagged with that morning's
// date). Per Zube's direction this correction applies ONLY to
// pump_meter_readings, sales_book, and credit_sales — NOT banking (which
// is deliberately filed by physical deposit-slip date, a separate,
// intentional lag per the PRD — stacking this fix on top of that one would
// be wrong) and NOT tank_stock (dip readings aren't reported as lagged).
//
// This is a report-generation-only fix: raw stored dates are never
// altered, no migration, no change to what the entry forms save. Two
// things have to move together for that to work:
//   1. The DB query window shifts one day LATER than the calendar month
//      (query Aug 2 -> Sep 1 to build the "August" report), because the
//      business-day-August data is stored one day ahead.
//   2. Each returned row's date field then shifts one day EARLIER before
//      it's used anywhere downstream, turning stored Aug 2..Sep 1 back
//      into displayed Aug 1..Aug 31.
// Skipping step 1 and only relabeling in place would either lose the last
// business day of the month (Aug 31, stored as Sep 1) or mislabel the
// first (stored Aug 1 would display as Jul 31 — a different month).
function shiftDateBack(dateStr) {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function shiftDateForward(dateStr) {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function previousMonthKey(month) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function lastNMonths(month, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

// Lightweight — only pump_meter_readings, only what the trend chart needs.
// Deliberately not the full assembleReport(): fetching sales/banking/
// credits/expenses/tanks for 5 extra months just to plot two numbers per
// month would be wasted work.
//
// Uses the same lagged query window as assembleReport() (see shiftDateBack/
// shiftDateForward above) — pump_meter_readings is one of the affected
// tables, so this has to stay in sync with Section 1/5's totals for the
// same month, or the trend chart and the KPI header would disagree.
async function getMonthlyFuelRevenue(supabaseAdmin, month) {
  const { startDate, endDate } = monthDateRange(month);
  const { data } = await supabaseAdmin
    .from('pump_meter_readings')
    .select('fuel_type, amount_ghs')
    .gte('reading_date', shiftDateForward(startDate))
    .lte('reading_date', shiftDateForward(endDate));
  const rows = data || [];
  const sxp = rows.filter(r => r.fuel_type === 'SXP').reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0);
  const dxp = rows.filter(r => r.fuel_type === 'DXP').reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0);
  return { month, sxp, dxp };
}

// Flag thresholds — defaults, not yet exposed as configuration anywhere.
// Same status as dealer_margin_per_litre before it got a station_setup
// field: reasonable starting values, worth tuning after real usage, not
// worth blocking this feature on building a settings UI for them first.
const FLAG_THRESHOLDS = {
  revenueSwingPct: 0.10,     // ±10% MoM revenue change
  tankVarianceLitres: 50,    // |actual_variance| on any single tank_stock day
  creditorExposurePct: 0.80, // balance / credit_limit
};

// Deterministic, rule-based — no AI narration (matches what was agreed:
// deterministic only, PDF only). Every flag here traces to a specific
// number already computed elsewhere in this file; nothing is generated.
function computeFlags({ current, previousSection5, creditors, compliance, endDate }) {
  const flags = [];

  if (previousSection5 && previousSection5.total_revenue > 0) {
    const delta = (current.section5_consolidated.total_revenue - previousSection5.total_revenue) / previousSection5.total_revenue;
    if (Math.abs(delta) >= FLAG_THRESHOLDS.revenueSwingPct) {
      flags.push({
        severity: delta > 0 ? 'positive' : 'warning',
        message: `Total revenue ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta * 100).toFixed(1)}% vs last month`,
      });
    }
  }

  const varianceDays = (current.section6_stock_movement || [])
    .filter(row => Math.abs(parseFloat(row.actual_variance || 0)) > FLAG_THRESHOLDS.tankVarianceLitres);
  if (varianceDays.length > 0) {
    const worst = varianceDays.reduce((a, b) =>
      Math.abs(parseFloat(a.actual_variance)) > Math.abs(parseFloat(b.actual_variance)) ? a : b);
    const wv = parseFloat(worst.actual_variance);
    flags.push({
      severity: 'warning',
      message: `Tank variance exceeded ±${FLAG_THRESHOLDS.tankVarianceLitres} L on ${varianceDays.length} day${varianceDays.length > 1 ? 's' : ''} this month (worst: ${worst.stock_date}, ${wv > 0 ? '+' : ''}${wv.toFixed(2)} L, ${worst.tank_id})`,
    });
  }

  (creditors || []).forEach(c => {
    const limit = parseFloat(c.credit_limit_ghs || 0);
    const balance = parseFloat(c.current_balance_ghs || 0);
    if (limit > 0) {
      const pct = balance / limit;
      if (pct >= FLAG_THRESHOLDS.creditorExposurePct) {
        flags.push({
          severity: pct >= 1 ? 'critical' : 'warning',
          message: `${c.name} balance at ${(pct * 100).toFixed(0)}% of credit limit (GHS ${balance.toFixed(2)} of GHS ${limit.toFixed(2)})`,
        });
      }
    }
  });

  (compliance || []).forEach(cert => {
    if (cert.status === 'archived' || !cert.expiry_date) return;
    const expiry = new Date(cert.expiry_date);
    const ref = new Date(endDate);
    const daysLeft = Math.floor((expiry - ref) / (1000 * 60 * 60 * 24));
    const window = cert.alert_days_before ?? 30;
    if (daysLeft <= window) {
      flags.push({
        severity: daysLeft < 0 ? 'critical' : 'warning',
        message: daysLeft < 0
          ? `${cert.certificate_name} expired ${Math.abs(daysLeft)} day(s) ago`
          : `${cert.certificate_name} expires in ${daysLeft} day(s)`,
      });
    }
  });

  const severityRank = { critical: 0, warning: 1, positive: 2 };
  flags.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return flags;
}

// Section 6 rollup: opening + received − sold = expected closing, vs the
// actual last dip. Moved here from Reports.jsx, where it was written
// twice with no backend version at all — see note above.
function summarizeStockMovement(tankStock) {
  const rollupTank = (tankId) => {
    const rows = tankStock.filter(t => t.tank_id === tankId);
    const opening = rows.length > 0 ? parseFloat(rows[0].opening_stock) : 0;
    const received = rows.reduce((s, t) => s + parseFloat(t.delivery_litres || 0), 0);
    const sold = rows.reduce((s, t) => s + parseFloat(t.litres_sold || 0), 0);
    const closing = rows.length > 0 ? parseFloat(rows[rows.length - 1].closing_stock_dip) : 0;
    const variance = closing - (opening + received - sold);
    return { opening, received, sold, closing, variance };
  };

  const sxp = rollupTank('TANK_A');
  const dxp = rollupTank('TANK_B');
  const combined = {
    opening: sxp.opening + dxp.opening,
    received: sxp.received + dxp.received,
    sold: sxp.sold + dxp.sold,
    closing: sxp.closing + dxp.closing,
    variance: sxp.variance + dxp.variance,
  };
  return { sxp, dxp, combined };
}

// Fetches and computes everything needed to render one month's report.
// Called twice per request to GET /:month — once for the requested month,
// once for the previous month (month-over-month comparison). Both calls
// hit the same 6 tables live; nothing is read from generated_reports,
// because nothing in this codebase currently writes to it — see PRD open
// items / conversation history. Live re-computation is correct and cheap
// at this station's data volume (one station, a handful of report loads
// a month). Revisit if generated_reports.snapshot_json ever gets a write
// path and this becomes worth caching.
async function assembleReport(supabaseAdmin, month) {
  const { startDate, endDate } = monthDateRange(month);

  const { data: setup } = await supabaseAdmin
    .from('station_setup')
    .select('*')
    .single();

  const margin = parseFloat(setup?.dealer_margin_per_litre || 0.30);

  // Lagged window for the three affected tables only — see shiftDateBack/
  // shiftDateForward comment above. Banking, expenses, and tank_stock use
  // the plain calendar startDate/endDate, untouched.
  const laggedStart = shiftDateForward(startDate);
  const laggedEnd = shiftDateForward(endDate);

  const [
    meterRes, salesRes, bankingRes,
    creditRes, expensesRes, tankRes
  ] = await Promise.all([
    supabaseAdmin.from('pump_meter_readings').select('*').gte('reading_date', laggedStart).lte('reading_date', laggedEnd).order('reading_date', { ascending: true }).order('pump_id', { ascending: true }).order('fuel_type', { ascending: true }),
    supabaseAdmin.from('sales_book').select('*').gte('entry_date', laggedStart).lte('entry_date', laggedEnd).order('entry_date', { ascending: true }),
    supabaseAdmin.from('banking').select('*').gte('entry_date', startDate).lte('entry_date', endDate).order('entry_date', { ascending: true }),
    // .is('deleted_at', null) was missing here — the only one of these six
    // queries without it (compare expenses, one line below). credit_sales
    // is the one table among these with routine soft-delete traffic (see
    // reverse_credit_sale / edit_credit_sale in creditors.js, where an edit
    // is implemented as reverse-then-reinsert), so every deleted or edited
    // credit sale left a ghost row that still rendered here — the exact
    // duplicate/repeated-date rows seen in the August 2026 Section 4 report
    // (e.g. 08-02, 08-10, 08-16, 08-30 all show identical rows twice).
    // pump_meter_readings / sales_book / banking / tank_stock do NOT have a
    // deleted_at column at all (sales_book and banking hard-delete; meter
    // readings have no delete route) — do not add this filter to those,
    // it would throw a SQL error against a column that doesn't exist.
    supabaseAdmin.from('credit_sales').select('*, creditors(name)').gte('sale_date', laggedStart).lte('sale_date', laggedEnd).is('deleted_at', null).order('sale_date', { ascending: true }),
    supabaseAdmin.from('expenses').select('*').gte('expense_date', startDate).lte('expense_date', endDate).is('deleted_at', null).order('expense_date', { ascending: true }),
    // ORDER BY here is not cosmetic — summarizeStockMovement() below reads
    // rows[0] as "opening stock" and rows[length-1] as "closing stock".
    // Without a guaranteed date order, both are whatever the DB happened to
    // return first/last (insertion order), not actually day-1 and day-N.
    // This was already true before consolidation — moving it here just
    // means it's now wrong (or right) in exactly one place instead of two.
    supabaseAdmin.from('tank_stock').select('*').gte('stock_date', startDate).lte('stock_date', endDate).order('stock_date', { ascending: true }),
  ]);

  // Relabel the lagged tables' rows back onto business dates now that the
  // query window has done its job — everything downstream (totals, section
  // payloads, flags) reads these dates and must see Aug 1..Aug 31, not the
  // stored Aug 2..Sep 1. sort() after mapping because shifting can put a
  // trailing Sep-1-turned-Aug-31 row out of the date order the query
  // guaranteed on the original (stored) dates.
  const meterReadings = (meterRes.data || [])
    .map(r => ({ ...r, reading_date: shiftDateBack(r.reading_date) }))
    .sort((a, b) => a.reading_date.localeCompare(b.reading_date) || a.pump_id.localeCompare(b.pump_id) || a.fuel_type.localeCompare(b.fuel_type));
  const salesBook = (salesRes.data || [])
    .map(r => ({ ...r, entry_date: shiftDateBack(r.entry_date) }))
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  const banking = bankingRes.data || [];
  const creditSales = (creditRes.data || [])
    .map(r => ({ ...r, sale_date: shiftDateBack(r.sale_date) }))
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date));
  const expenses = expensesRes.data || [];
  const tankStock = tankRes.data || [];

  const totalSxpLitres = meterReadings.filter(r => r.fuel_type === 'SXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0);
  const totalDxpLitres = meterReadings.filter(r => r.fuel_type === 'DXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0);
  const totalLitres = totalSxpLitres + totalDxpLitres;
  const totalRevenue = salesBook.reduce((s, r) => s + parseFloat(r.total_sales_ghs || 0), 0);
  const dealerEarnings = totalLitres * margin;
  const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount_ghs || 0), 0);
  const netDealerProfit = dealerEarnings - totalExpenses;
  // Previously only computed client-side inside handleExportPDF — moved
  // here so Section 5 is the one place total_banked/total_credit live,
  // instead of being re-derived wherever a KPI needs them.
  const totalBanked = banking.reduce((s, b) => s + parseFloat(b.total_banked_ghs || 0), 0);
  const totalCredit = creditSales.reduce((s, c) => s + parseFloat(c.total_amount_ghs || 0), 0);

  const hasData = meterReadings.length > 0 || salesBook.length > 0 || banking.length > 0 ||
                  creditSales.length > 0 || expenses.length > 0 || tankStock.length > 0;

  return {
    month,
    has_data: hasData,
    setup: setup || null,
    station_name: setup?.station_name,
    dealer_margin_per_litre: margin,
    section1_fuel_sales: meterReadings,
    section2_sales_book: salesBook,
    section3_banking: banking,
    section4_credit_sales: creditSales,
    section5_consolidated: {
      total_revenue: totalRevenue,
      total_sxp_litres: totalSxpLitres,
      total_dxp_litres: totalDxpLitres,
      total_litres: totalLitres,
      dealer_earnings: dealerEarnings,
      total_expenses: totalExpenses,
      net_dealer_profit: netDealerProfit,
      total_banked: totalBanked,
      total_credit: totalCredit,
    },
    section6_stock_movement: tankStock,
    section6_summary: summarizeStockMovement(tankStock),
    section7_dealer_margin: {
      daily: meterReadings,
      total_litres: totalLitres,
      margin_per_litre: margin,
      total_earnings: dealerEarnings,
    },
  };
}

// GET /api/reports
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('generated_reports')
      .select('*')
      .order('report_month', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// GET /api/reports/:month
// Serves both the in-app Reports screen and the PDF export (Reports.jsx
// no longer calls a separate /pdf/:month — that route re-ran identical
// queries and computed nothing; retired). Includes a trimmed
// previous_month block for month-over-month deltas — live re-query, not
// a stored snapshot (see assembleReport comment above for why) — plus a
// deterministic `flags` array and a 6-month `revenue_trend`, the data
// behind the PDF's Executive Summary section.
router.get('/:month', authenticate, adminOrManager, async (req, res) => {
  try {
    const { month } = req.params;
    const prevMonth = previousMonthKey(month);
    const trendMonths = lastNMonths(month, 6);

    const [current, previous, creditorsRes, complianceRes, ...trendResults] = await Promise.all([
      assembleReport(req.supabaseAdmin, month),
      assembleReport(req.supabaseAdmin, prevMonth),
      req.supabaseAdmin.from('creditors').select('name, current_balance_ghs, credit_limit_ghs').eq('is_active', true),
      req.supabaseAdmin.from('compliance_certificates').select('certificate_name, expiry_date, alert_days_before, status'),
      ...trendMonths.map(m => getMonthlyFuelRevenue(req.supabaseAdmin, m)),
    ]);

    const { endDate } = monthDateRange(month);
    const flags = computeFlags({
      current,
      previousSection5: previous.has_data ? previous.section5_consolidated : null,
      creditors: creditorsRes.data || [],
      compliance: complianceRes.data || [],
      endDate,
    });

    res.json({
      ...current,
      previous_month: {
        month: prevMonth,
        has_data: previous.has_data,
        section5_consolidated: previous.section5_consolidated,
      },
      flags,
      revenue_trend: trendResults,
    });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to assemble report' });
  }
});

module.exports = router;