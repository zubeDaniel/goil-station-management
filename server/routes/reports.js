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
    .select('reading_date, fuel_type, amount_ghs, litres_sold')
    .gte('reading_date', shiftDateForward(startDate))
    .lte('reading_date', shiftDateForward(endDate));
  const rows = data || [];
  const sum = (fuel, field) => rows.filter(r => r.fuel_type === fuel).reduce((s, r) => s + parseFloat(r[field] || 0), 0);
  // sxp/dxp stay revenue (the existing chart reads them); litres and the
  // count of reported business days were added for the volume-trend callout —
  // revenue alone is distorted by NPA price changes, and `days` lets a
  // partial (in-progress) month be compared per reported day, not per month.
  const days = new Set(rows.map(r => shiftDateBack(r.reading_date))).size;
  return { month, sxp: sum('SXP', 'amount_ghs'), dxp: sum('DXP', 'amount_ghs'), sxp_litres: sum('SXP', 'litres_sold'), dxp_litres: sum('DXP', 'litres_sold'), days };
}

// Flag thresholds — defaults, not yet exposed as configuration anywhere.
// Same status as dealer_margin_per_litre before it got a station_setup
// field: reasonable starting values, worth tuning after real usage, not
// worth blocking this feature on building a settings UI for them first.
const FLAG_THRESHOLDS = {
  revenueSwingPct: 0.10,     // ±10% MoM revenue change
  tankVarianceLitres: 50,    // |actual_variance| on any single tank_stock day
  creditorExposurePct: 0.80, // balance / credit_limit
  unexplainedVariancePct: 0.005, // |monthly unexplained tank residue| / litres sold
};

// Deterministic, rule-based — no AI narration (matches what was agreed:
// deterministic only, PDF only). Every flag here traces to a specific
// number already computed elsewhere in this file; nothing is generated.
function computeFlags({ current, previousSection5, creditors, compliance, today, isCurrentMonth }) {
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

  // creditors.current_balance_ghs is TODAY's balance, so a credit-limit flag
  // is only truthful on the current month's report; on a past month it would
  // present today's balance as that month's.
  (isCurrentMonth ? (creditors || []) : []).forEach(c => {
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
    // Measured from the generation date, not month-end: the report is read
    // to act on, and "expires in 12 days" must mean from today.
    const daysLeft = daysBetween(today, cert.expiry_date);
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

// Section 8 rollup: week-of-month litres buckets (days 1–7, 8–14, 15–21,
// 22–28, 29–end — the last bucket is short by design, not a bug, since
// months don't divide evenly by 7), each with a total and a daily average
// (total / days actually in that bucket), split by fuel type and combined.
// The monthly weekly average is SUM(week totals) / number of buckets —
// the short trailing bucket is included as-is, which is a deliberate
// choice (agreed 2026-09-17): it pulls the monthly average down rather
// than being excluded or padded out to a fake 7-day week.
//
// Takes the already-lag-corrected `meterReadings` array assembleReport()
// already fetched for Section 1/7 — reading_date here is the business
// date (see shiftDateBack above), so no separate date handling is needed;
// bucketing purely on day-of-month is correct as-is.
function computeVolumeAverages(meterReadings, month) {
  const daysInMonth = new Date(
    parseInt(month.slice(0, 4), 10),
    parseInt(month.slice(5, 7), 10),
    0
  ).getDate();

  // bucketCount adapts to month length — a non-leap February (28 days)
  // has exactly 4 buckets and no short 5th one at all.
  const bucketCount = Math.ceil(daysInMonth / 7);
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const startDay = i * 7 + 1;
    const endDay = Math.min(startDay + 6, daysInMonth);
    return {
      week: i + 1, startDay, endDay, daysInBucket: endDay - startDay + 1,
      sxp: 0, dxp: 0, sxpRev: 0, dxpRev: 0, reportedDays: new Set(),
    };
  });

  meterReadings.forEach(r => {
    const day = parseInt(r.reading_date.slice(8, 10), 10);
    const bucket = buckets[Math.floor((day - 1) / 7)];
    if (!bucket) return;
    bucket.reportedDays.add(day);
    if (r.fuel_type === 'SXP') {
      bucket.sxp += parseFloat(r.litres_sold || 0);
      bucket.sxpRev += parseFloat(r.amount_ghs || 0);
    } else if (r.fuel_type === 'DXP') {
      bucket.dxp += parseFloat(r.litres_sold || 0);
      bucket.dxpRev += parseFloat(r.amount_ghs || 0);
    }
  });

  // Fields up to combined_daily_avg are the original Section 8 contract
  // (calendar-day basis) and are unchanged. Everything after is additive:
  // revenue totals/averages on the same basis, plus *_per_reported_day
  // figures that divide by days that actually have a meter entry — those
  // feed the weekly chart and the pace callout, where a short trailing
  // bucket or an in-progress month would otherwise read as a false slowdown.
  const weeks = buckets.map(b => {
    const reported = b.reportedDays.size;
    return {
      week: b.week,
      label: `Days ${b.startDay}–${b.endDay}`,
      days_in_bucket: b.daysInBucket,
      sxp_total: b.sxp,
      dxp_total: b.dxp,
      combined_total: b.sxp + b.dxp,
      sxp_daily_avg: b.sxp / b.daysInBucket,
      dxp_daily_avg: b.dxp / b.daysInBucket,
      combined_daily_avg: (b.sxp + b.dxp) / b.daysInBucket,
      sxp_rev_total: b.sxpRev,
      dxp_rev_total: b.dxpRev,
      combined_rev_total: b.sxpRev + b.dxpRev,
      sxp_rev_daily_avg: b.sxpRev / b.daysInBucket,
      dxp_rev_daily_avg: b.dxpRev / b.daysInBucket,
      combined_rev_daily_avg: (b.sxpRev + b.dxpRev) / b.daysInBucket,
      days_with_data: reported,
      sxp_litres_per_reported_day: reported ? b.sxp / reported : 0,
      dxp_litres_per_reported_day: reported ? b.dxp / reported : 0,
      combined_litres_per_reported_day: reported ? (b.sxp + b.dxp) / reported : 0,
    };
  });

  const monthSxpTotal = weeks.reduce((s, w) => s + w.sxp_total, 0);
  const monthDxpTotal = weeks.reduce((s, w) => s + w.dxp_total, 0);
  const monthSxpRev = weeks.reduce((s, w) => s + w.sxp_rev_total, 0);
  const monthDxpRev = weeks.reduce((s, w) => s + w.dxp_rev_total, 0);

  return {
    weeks,
    monthly: {
      number_of_weeks: weeks.length,
      sxp_weekly_avg: monthSxpTotal / weeks.length,
      dxp_weekly_avg: monthDxpTotal / weeks.length,
      combined_weekly_avg: (monthSxpTotal + monthDxpTotal) / weeks.length,
      sxp_rev_weekly_avg: monthSxpRev / weeks.length,
      dxp_rev_weekly_avg: monthDxpRev / weeks.length,
      combined_rev_weekly_avg: (monthSxpRev + monthDxpRev) / weeks.length,
    },
  };
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
    section8_volume_averages: computeVolumeAverages(meterReadings, month),
  };
}

// ══════════════════════════════════════════════════════════════════
// Report enhancements (Oct 2026) — revenue split, averages, headline
// callouts, variance reconciliation, creditor exposure, banking health,
// nozzle/meter checks, compliance pull-forward.
//
// Everything below is pure computation over rows already fetched (plus
// three small extra queries made in the route handler). Dates on meter /
// sales / credit rows are already BUSINESS dates (one-day lag corrected in
// assembleReport); banking, tank_stock, deliveries and creditor payments
// are on their raw dates, deliberately — see the lag note near the top.
// ══════════════════════════════════════════════════════════════════

// Guard rails. Defaults, same status as FLAG_THRESHOLDS: starting values to
// tune after real usage, not yet configuration.
const METER_LITRES_CEILING = 10000;   // litres on ONE nozzle row (a day, or a day-session) above this is implausible
const ZERO_LITRES_TOLERANCE = 0.5;     // net litres at or under this count as no sales
const METER_CONTINUITY_TOLERANCE = 0.05; // metres of drift allowed between a closing and the next opening
const BANKING_GAP_DAYS = 1;           // tolerated banking lag, in days of average sales
const BANKING_MIN_RUN_DAYS = 2;       // gap must persist MORE than this many consecutive days to be flagged
const VOLUME_TREND_BAND = 0.05;       // ±5% vs trailing average = growing/declining, else coasting
const WEEKLY_PACE_BAND = 0.03;        // ±3%/week slope (relative to the mean) = accelerating/slowing, else steady
const MIN_DAYS_FOR_WEEK_TREND = 3;    // a week bucket with fewer reported days is too thin to judge a trend by
const COMPLIANCE_HORIZON_DAYS = 60;

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sumBy = (rows, field) => rows.reduce((s, r) => s + num(r[field]), 0);
const nf = (n, d = 2) => num(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const signedNf = (n, d = 2) => {
  const v = Math.round(num(n) * 10 ** d) / 10 ** d;
  return `${v >= 0 ? '+' : '-'}${nf(Math.abs(v), d)}`;
};
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
// Meter amount_ghs = litres x price, and the meter counts litres that were
// returned to the tank (RTT). On the real September data every day where the
// Sales Book total sits below the meter total is an RTT day, by exactly
// RTT litres x price. RTT is never revenue, so every NEW revenue figure uses
// this net amount. (Litres stay "dispensed", as everywhere else in the report.)
const netOfRtt = (r) => {
  const litres = num(r.litres_sold);
  const amount = num(r.amount_ghs);
  const rtt = Math.min(Math.max(num(r.rtt_litres), 0), Math.max(litres, 0));
  return litres > 0 ? amount - rtt * (amount / litres) : amount;
};
const isImplausibleMeterRow = (r) => num(r.litres_sold) > METER_LITRES_CEILING || num(r.litres_sold) < 0;

function daysInMonthOf(month) {
  return new Date(Date.UTC(parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10), 0)).getUTCDate();
}

function daysBetween(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// ── A1/A2: fuel revenue split + averages ─────────────────────────
// Revenue here is meter-book revenue (litres x price, pump_meter_readings
// .amount_ghs) — NOT sales_book.total_sales_ghs, which also carries Merka
// Wood credit, genset, lubricant and till cash. The two are different
// numbers on purpose; the PDF labels them differently.
function computeRevenueSplit(meter, volumeAverages, month, rtt) {
  const sum = (fuel, field) => sumBy(meter.filter(r => r.fuel_type === fuel), field);
  const sxpL = sum('SXP', 'litres_sold'), dxpL = sum('DXP', 'litres_sold');
  const sxpR = sum('SXP', 'amount_ghs'), dxpR = sum('DXP', 'amount_ghs');
  const totL = sxpL + dxpL, totR = sxpR + dxpR;
  const daysReported = new Set(meter.map(r => r.reading_date)).size;
  const perDay = (v) => (daysReported > 0 ? v / daysReported : 0);
  const m = volumeAverages.monthly;
  return {
    days_reported: daysReported,
    days_in_month: daysInMonthOf(month),
    rtt_litres: rtt.litres,
    rtt_revenue_excluded: rtt.value,
    sxp: { litres: sxpL, revenue: sxpR, litres_pct: pct(sxpL, totL), revenue_pct: pct(sxpR, totR) },
    dxp: { litres: dxpL, revenue: dxpR, litres_pct: pct(dxpL, totL), revenue_pct: pct(dxpR, totR) },
    total: { litres: totL, revenue: totR },
    per_day: {
      sxp_litres: perDay(sxpL), sxp_revenue: perDay(sxpR),
      dxp_litres: perDay(dxpL), dxp_revenue: perDay(dxpR),
      combined_litres: perDay(totL), combined_revenue: perDay(totR),
    },
    per_week: {
      number_of_weeks: m.number_of_weeks,
      sxp_litres: m.sxp_weekly_avg, sxp_revenue: m.sxp_rev_weekly_avg,
      dxp_litres: m.dxp_weekly_avg, dxp_revenue: m.dxp_rev_weekly_avg,
      combined_litres: m.combined_weekly_avg, combined_revenue: m.combined_rev_weekly_avg,
    },
  };
}

// ── B3: headline callouts — plain sentences ──────────────────────
function computeHeadlines({ meter, volumeAverages, trend, month }) {
  const out = [];
  if (meter.length === 0) return out;

  // Best / worst day by revenue. Only days with revenue > 0 compete: a day
  // with rows but zero sales is a closed/unrecorded day, not "the worst day".
  const byDate = new Map();
  meter.forEach(r => {
    const d = byDate.get(r.reading_date) || { revenue: 0, litres: 0 };
    d.revenue += num(r.amount_ghs);
    d.litres += num(r.litres_sold);
    byDate.set(r.reading_date, d);
  });
  const days = Array.from(byDate, ([date, v]) => ({ date, ...v }));
  const live = days.filter(d => d.revenue > 0);
  const zeroDays = days.length - live.length;
  if (live.length > 0) {
    const best = live.reduce((a, b) => (b.revenue > a.revenue ? b : a));
    const worst = live.reduce((a, b) => (b.revenue < a.revenue ? b : a));
    out.push({ key: 'best_day', tone: 'positive', text: `Best day by revenue: ${best.date} - GHS ${nf(best.revenue)} (${nf(best.litres)} L).` });
    out.push({
      key: 'worst_day', tone: 'neutral',
      text: `Weakest day by revenue: ${worst.date} - GHS ${nf(worst.revenue)} (${nf(worst.litres)} L).` +
        (zeroDays > 0 ? ` ${zeroDays} reported day(s) with zero sales on every nozzle are excluded from this comparison.` : ''),
    });
  }

  // Busiest / quietest pump by litres.
  const pumps = new Map();
  meter.forEach(r => {
    const p = pumps.get(r.pump_id) || { litres: 0, fuels: new Set() };
    p.litres += num(r.litres_sold);
    p.fuels.add(r.fuel_type);
    pumps.set(r.pump_id, p);
  });
  const pumpList = Array.from(pumps, ([pump_id, v]) => ({ pump_id, ...v })).sort((a, b) => b.litres - a.litres);
  const totalLitres = pumpList.reduce((s, p) => s + p.litres, 0);
  const pumpLabel = (p) => `${p.pump_id} (${nf(p.litres)} L, ${nf(pct(p.litres, totalLitres) || 0, 1)}% of volume${p.fuels.size === 1 ? `; ${Array.from(p.fuels)[0]} only` : ''})`;
  if (pumpList.length >= 2) {
    out.push({ key: 'busiest_pump', tone: 'neutral', text: `Busiest pump: ${pumpLabel(pumpList[0])}.` });
    out.push({ key: 'quietest_pump', tone: 'neutral', text: `Quietest pump: ${pumpLabel(pumpList[pumpList.length - 1])}.` });
  }

  // Volume vs trailing average — litres, not revenue (NPA price changes
  // distort revenue), and per reported day so an in-progress month compares
  // fairly with complete ones.
  const cur = (trend || []).find(t => t.month === month);
  const prior = (trend || []).filter(t => t.month !== month && t.days > 0);
  if (cur && cur.days > 0) {
    const perDay = (t) => (t.sxp_litres + t.dxp_litres) / t.days;
    if (prior.length === 0) {
      out.push({ key: 'volume_vs_trailing', tone: 'neutral', text: 'Volume trend: no earlier months on record to compare against.' });
    } else {
      const avgPrior = prior.reduce((s, t) => s + perDay(t), 0) / prior.length;
      const delta = avgPrior > 0 ? (perDay(cur) - avgPrior) / avgPrior : 0;
      const verdict = delta >= VOLUME_TREND_BAND ? 'growing' : delta <= -VOLUME_TREND_BAND ? 'declining' : 'coasting';
      out.push({
        key: 'volume_vs_trailing',
        tone: verdict === 'growing' ? 'positive' : verdict === 'declining' ? 'warning' : 'neutral',
        text: `Volume trend: ${nf(perDay(cur))} L per reported day this month vs ${nf(avgPrior)} L over the previous ${prior.length} month(s) on record (${signedNf(delta * 100, 1)}%) - ${verdict}.`,
      });
    }
  }

  // Week-over-week direction: least-squares slope over week buckets with
  // enough reported days, in litres per reported day (so the short trailing
  // bucket can't fake a slowdown).
  const usable = (volumeAverages.weeks || []).filter(w => w.days_with_data >= MIN_DAYS_FOR_WEEK_TREND);
  if (usable.length >= 3) {
    const ys = usable.map(w => w.combined_litres_per_reported_day);
    const n = ys.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    const meanX = (n - 1) / 2;
    let sxy = 0, sxx = 0;
    ys.forEach((y, i) => { sxy += (i - meanX) * (y - meanY); sxx += (i - meanX) ** 2; });
    const slopePct = meanY > 0 ? (sxy / sxx) / meanY : 0;
    const verdict = slopePct >= WEEKLY_PACE_BAND ? 'accelerating' : slopePct <= -WEEKLY_PACE_BAND ? 'slowing' : 'steady';
    out.push({
      key: 'weekly_pace',
      tone: verdict === 'accelerating' ? 'positive' : verdict === 'slowing' ? 'warning' : 'neutral',
      text: `Weekly pace: daily volume went from ${nf(ys[0])} L (W${usable[0].week}) to ${nf(ys[n - 1])} L (W${usable[n - 1].week}) across the month - ${verdict}.`,
    });
  } else {
    out.push({ key: 'weekly_pace', tone: 'neutral', text: `Weekly pace: fewer than 3 week buckets have ${MIN_DAYS_FOR_WEEK_TREND}+ reported days, too little to judge a direction.` });
  }
  return out;
}

// ── B4: variance reconciliation ──────────────────────────────────
// actual_variance is generated from delivery_litres, the MEASURED receipt,
// so a tanker shortage is already out of it — subtracting shortage again
// would double-count. Shortage only explains the gap between expected and
// actual variance. RTT is the real explainable component: tank_stock
// .litres_sold sums meter litres with no RTT netting, so fuel returned to
// the tank shows up as a positive variance of exactly that size.
//   unexplained = net tank variance - RTT litres
function computeVarianceReconciliation({ stockSummary, tankRowCount, meter, deliveries, deliveriesOk }) {
  if (tankRowCount === 0) return { available: false, reason: 'No tank stock readings recorded for this month.' };
  const rtt = (fuel) => sumBy(meter.filter(r => r.fuel_type === fuel), 'rtt_litres');
  const shortage = (fuel) => (deliveriesOk ? sumBy(deliveries.filter(d => d.fuel_type === fuel), 'shortage_litres') : null);
  const line = (fuel, s) => {
    const variance = s.variance;
    const r = rtt(fuel);
    return { variance, rtt: r, unexplained: variance - r, shortage: shortage(fuel), sold: s.sold };
  };
  const sxp = line('SXP', stockSummary.sxp);
  const dxp = line('DXP', stockSummary.dxp);
  const combined = {
    variance: sxp.variance + dxp.variance,
    rtt: sxp.rtt + dxp.rtt,
    unexplained: sxp.unexplained + dxp.unexplained,
    shortage: deliveriesOk ? sxp.shortage + dxp.shortage : null,
    sold: sxp.sold + dxp.sold,
  };
  const tolerance = FLAG_THRESHOLDS.unexplainedVariancePct * combined.sold;
  const review = Math.abs(combined.unexplained) > tolerance;
  const text = `Of the ${signedNf(combined.variance)} L net tank variance, ${nf(combined.rtt)} L is explained by RTT, leaving ${signedNf(combined.unexplained)} L unexplained` +
    (tolerance > 0 ? ` (${review ? 'above' : 'within'} the ${nf(tolerance, 0)} L tolerance, ${nf(FLAG_THRESHOLDS.unexplainedVariancePct * 100, 1)}% of litres sold).` : '.');
  return {
    available: true, sxp, dxp, combined, tolerance_litres: tolerance, needs_review: review,
    shortage_available: deliveriesOk, text,
  };
}

// ── B5: creditor exposure ────────────────────────────────────────
// Flow-based. creditors.current_balance_ghs holds only today's balance, so
// opening/closing balances are shown ONLY when the report month is the
// current one (opening is then closing - net change, an estimate: the
// payment RPC clamps at zero, so an overpayment makes it slightly off).
function computeCreditorExposure({ creditors, creditSales, payments, paymentsOk, postCredits, postPayments, postOk, salesBookMerka, totalRevenue, isCurrentMonth }) {
  const rows = [];
  (creditors || []).forEach(c => {
    const credits = sumBy(creditSales.filter(s => s.creditor_id === c.id), 'total_amount_ghs');
    const paid = paymentsOk ? sumBy(payments.filter(p => p.creditor_id === c.id), 'amount_ghs') : null;
    const balance = num(c.current_balance_ghs);
    const net = paymentsOk ? credits - paid : null;
    // Month-end balance, rebuilt from today's balance by undoing everything
    // recorded AFTER the month: closing = today - later credit + later payments.
    // This is what makes a just-closed month (the usual case: the report is
    // read in the first days of the next month) show real balances.
    let closing = null;
    if (postOk) {
      const later = sumBy(postCredits.filter(s => s.creditor_id === c.id), 'total_amount_ghs');
      const laterPaid = sumBy(postPayments.filter(p => p.creditor_id === c.id), 'amount_ghs');
      closing = Math.max(0, balance - later + laterPaid);
    } else if (isCurrentMonth) closing = balance;
    if (credits === 0 && !(paid > 0) && !(closing > 0)) return;
    const limit = num(c.credit_limit_ghs);
    rows.push({
      name: c.name,
      credit_sales: credits,
      payments: paid,
      net_change: net,
      direction: net === null ? 'unknown' : net > 0.005 ? 'growing' : net < -0.005 ? 'shrinking' : 'flat',
      collection_rate_pct: paymentsOk ? pct(paid, credits) : null,
      closing_balance: closing,
      opening_balance_est: closing !== null && paymentsOk ? Math.max(0, closing - net) : null,
      credit_limit: limit,
      utilisation_pct: closing !== null ? pct(closing, limit) : null,
    });
  });
  const totalCredit = sumBy(creditSales, 'total_amount_ghs');
  return {
    payments_available: paymentsOk,
    balances_available: postOk || isCurrentMonth,
    is_current_month: isCurrentMonth,
    creditors: rows,
    total_credit_sales: totalCredit,
    sales_book_merka: salesBookMerka,
    // Sales Book "Merka" column vs the credit_sales table. They should match;
    // a gap means one of the two was keyed wrong, and the creditor balance
    // follows credit_sales, not the Sales Book.
    credit_source_gap: salesBookMerka - totalCredit,
    credit_share_of_revenue_pct: pct(totalCredit, totalRevenue),
    revenue_basis: 'Sales Book total (all channels)',
  };
}

// ── B6: banking health ───────────────────────────────────────────
// Deliberately NOT banking.variance_vs_sales: that column is computed once
// at write time against the same raw entry_date, so it goes stale when sales
// are entered or edited later and ignores the one-day lag on sales dates.
// Recomputed here on business dates. Merka Wood credit is removed from the
// sales side first — it is credit, never deposited.
//
// Method: a running gap, cumulative (sales - Merka) minus cumulative banked,
// day by day. A single late deposit self-corrects within a day or two and is
// not flagged; a gap above BANKING_GAP_DAYS of average daily sales that
// persists for more than BANKING_MIN_RUN_DAYS consecutive days is.
function computeBankingHealth({ salesBook, banking, month, payments, paymentsOk }) {
  if (salesBook.length === 0 && banking.length === 0) return { available: false, reason: 'No Sales Book or banking entries for this month.' };
  const grossSales = sumBy(salesBook, 'total_sales_ghs');
  const merka = sumBy(salesBook, 'merka_wood_ghs');
  // Merka Wood pays its credit through the same bank/MoMo accounts, so those
  // payments are deposits that no sale explains. On the real September data
  // banked exceeded (sales - Merka credit) by ~GHS 532k before this was added.
  const merkaPaid = paymentsOk ? sumBy(payments, 'amount_ghs') : 0;
  const expected = grossSales - merka + merkaPaid;
  const banked = sumBy(banking, 'total_banked_ghs');

  const salesByDate = {}; const bankedByDate = {};
  salesBook.forEach(s => { salesByDate[s.entry_date] = (salesByDate[s.entry_date] || 0) + num(s.total_sales_ghs) - num(s.merka_wood_ghs); });
  if (paymentsOk) payments.forEach(p => { salesByDate[p.payment_date] = (salesByDate[p.payment_date] || 0) + num(p.amount_ghs); });
  banking.forEach(b => { bankedByDate[b.entry_date] = (bankedByDate[b.entry_date] || 0) + num(b.total_banked_ghs); });

  const salesDays = new Set(salesBook.map(s => s.entry_date)).size;
  const avgDaily = salesDays > 0 ? (grossSales - merka) / salesDays : 0;
  const threshold = avgDaily * BANKING_GAP_DAYS;
  const lastDate = [...Object.keys(salesByDate), ...Object.keys(bankedByDate)].sort().pop();
  const lastDay = lastDate ? parseInt(lastDate.slice(8, 10), 10) : 0;

  const windows = [];
  let cumSales = 0, cumBanked = 0, run = null;
  const closeRun = () => {
    if (run && run.days > BANKING_MIN_RUN_DAYS) windows.push({ from: run.from, to: run.to, days: run.days, peak_gap_ghs: run.peak });
    run = null;
  };
  if (threshold > 0) {
    for (let d = 1; d <= lastDay; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      cumSales += salesByDate[date] || 0;
      cumBanked += bankedByDate[date] || 0;
      const gap = cumSales - cumBanked;
      if (gap > threshold) {
        if (!run) run = { from: date, to: date, days: 0, peak: 0 };
        run.to = date; run.days += 1; run.peak = Math.max(run.peak, gap);
      } else closeRun();
    }
    closeRun();
  }

  return {
    available: true,
    payments_available: paymentsOk,
    gross_sales: grossSales,
    merka_credit: merka,
    merka_payments: merkaPaid,
    expected_banked: expected,
    total_banked: banked,
    gap: expected - banked,
    avg_daily_sales: avgDaily,
    threshold_ghs: threshold,
    flagged_windows: windows,
    note: 'Deposits made early next month for the last days of this month are not in this month, and early-month deposits may belong to last month. Every Merka Wood payment is assumed to be deposited; a payment kept as cash would show as a shortfall.',
  };
}

// ── B7 + guardrails: nozzle checks and meter data quality ────────
function computeMeterChecks(meter) {
  // "No sales" means NET of RTT: on 3 Sep P3 DXP dispensed 10.22 L and returned
  // 10.22 L — a nozzle test, not a sale — so it counts as a no-sales day.
  const net = (r) => num(r.litres_sold) - num(r.rtt_litres);
  // <= not |x| <=: RTT recorded against a nozzle that sold nothing nets NEGATIVE, and that is still no sales.
  const isZero = (v) => v <= ZERO_LITRES_TOLERANCE;
  const stationDates = Array.from(new Set(meter.map(r => r.reading_date))).sort();
  const dayTotal = {};
  meter.forEach(r => { dayTotal[r.reading_date] = (dayTotal[r.reading_date] || 0) + net(r); });
  const closedDates = stationDates.filter(d => isZero(dayTotal[d]));
  const closed = new Set(closedDates);
  const live = stationDates.filter(d => !closed.has(d));

  const nozzles = new Map();
  meter.forEach(r => {
    const key = `${r.pump_id}|${r.fuel_type}`;
    if (!nozzles.has(key)) nozzles.set(key, { pump_id: r.pump_id, fuel_type: r.fuel_type, byDate: new Map(), rows: [] });
    const n = nozzles.get(key);
    n.byDate.set(r.reading_date, (n.byDate.get(r.reading_date) || 0) + net(r));
    n.rows.push(r);
  });
  const ordered = Array.from(nozzles.values()).sort((a, b) => a.pump_id.localeCompare(b.pump_id) || a.fuel_type.localeCompare(b.fuel_type));

  // Fuel-level: every nozzle of a fuel at zero/absent on a trading day is not
  // a nozzle problem, it is that fuel not being sold at all (e.g. 13-14 Sep:
  // SXP on both P1 and P2 while DXP traded) — most likely the tank ran dry.
  // Reported once per fuel and removed from the per-nozzle lists.
  const fuelZeroDays = [];
  const TANK_OF = { SXP: 'Tank A', DXP: 'Tank B' };
  ['SXP', 'DXP'].forEach(fuel => {
    const group = ordered.filter(n => n.fuel_type === fuel);
    if (group.length < 2) return;
    const dates = live.filter(d => group.every(n => !n.byDate.has(d) || isZero(n.byDate.get(d))) && group.some(n => n.byDate.has(d)));
    if (dates.length) fuelZeroDays.push({ fuel_type: fuel, tank: TANK_OF[fuel] || null, dates });
  });
  const coveredBy = (fuel) => new Set((fuelZeroDays.find(f => f.fuel_type === fuel) || { dates: [] }).dates);

  const zeroNozzles = []; const continuityBreaks = [];
  ordered.forEach(n => {
    const covered = coveredBy(n.fuel_type);
    const zero_dates = live.filter(d => !covered.has(d) && n.byDate.has(d) && isZero(n.byDate.get(d)));
    const missing_dates = live.filter(d => !n.byDate.has(d) && !covered.has(d));
    if (zero_dates.length || missing_dates.length) zeroNozzles.push({ pump_id: n.pump_id, fuel_type: n.fuel_type, zero_dates, missing_dates });

    // Meter continuity: each reading's opening must equal the previous
    // reading's closing on the same nozzle. A genuine replacement/reset
    // WILL show here — it is reported, not suppressed; the reader decides.
    const rowsSorted = [...n.rows].sort((a, b) => a.reading_date.localeCompare(b.reading_date) || num(a.session_number || 1) - num(b.session_number || 1));
    for (let i = 1; i < rowsSorted.length; i++) {
      const prevClose = num(rowsSorted[i - 1].closing_meter);
      const open = num(rowsSorted[i].opening_meter);
      if (Math.abs(open - prevClose) > METER_CONTINUITY_TOLERANCE) {
        continuityBreaks.push({ date: rowsSorted[i].reading_date, pump_id: n.pump_id, fuel_type: n.fuel_type, previous_closing: prevClose, opening: open, jump: open - prevClose });
      }
    }
  });

  // Implausible single-row litres. Flagged, NOT silently dropped and NOT
  // silently included: totals are left as recorded and the reader is told
  // exactly which rows to distrust.
  const implausible = meter
    .filter(isImplausibleMeterRow)
    .map(r => ({
      date: r.reading_date, pump_id: r.pump_id, fuel_type: r.fuel_type, litres: num(r.litres_sold),
      opening_meter: num(r.opening_meter), closing_meter: num(r.closing_meter),
      issue: num(r.litres_sold) < 0 ? 'negative' : 'above_ceiling',
    }));

  return {
    ceiling_litres: METER_LITRES_CEILING,
    fuel_zero_days: fuelZeroDays,
    zero_nozzles: zeroNozzles,
    closed_dates: closedDates,
    reported_days: stationDates.length,
    implausible_rows: implausible,
    continuity_breaks: continuityBreaks,
  };
}

// ── B8: compliance pull-forward ──────────────────────────────────
function computeComplianceExpiry({ compliance, today }) {
  const items = (compliance || [])
    .filter(c => c.status !== 'archived' && c.expiry_date)
    .map(c => {
      const days_left = daysBetween(today, c.expiry_date);
      return {
        certificate_name: c.certificate_name, issuing_authority: c.issuing_authority || null,
        expiry_date: c.expiry_date, days_left,
        severity: days_left < 0 ? 'critical' : days_left <= 30 ? 'warning' : 'notice',
      };
    })
    .filter(c => c.days_left <= COMPLIANCE_HORIZON_DAYS)
    .sort((a, b) => a.days_left - b.days_left);
  return { as_of: today, horizon_days: COMPLIANCE_HORIZON_DAYS, items };
}

// Extra cover-page flags from the new analyses. Same shape as computeFlags.
function buildExtraFlags({ variance, creditorExposure, banking, meterChecks, isCurrentMonth }) {
  const flags = [];
  const d = (n) => Math.abs(n) >= 1000 ? nf(n, 0) : nf(n);

  if (meterChecks.implausible_rows.length > 0) {
    const first = meterChecks.implausible_rows[0];
    flags.push({
      severity: 'critical',
      message: `Meter data: ${meterChecks.implausible_rows.length} implausible reading(s) (first: ${first.pump_id} ${first.fuel_type} on ${first.date}, ${nf(first.litres)} L). Totals include them as recorded - see Section 13.`,
    });
  }
  if (meterChecks.continuity_breaks.length > 0) {
    const first = meterChecks.continuity_breaks[0];
    flags.push({
      severity: 'warning',
      message: `Meter continuity: ${meterChecks.continuity_breaks.length} break(s) where an opening reading differs from the prior closing (first: ${first.pump_id} ${first.fuel_type} on ${first.date}, jump ${signedNf(first.jump)}). A replaced meter would show here - see Section 13.`,
    });
  }
  if (variance && variance.available && variance.needs_review) {
    flags.push({ severity: 'warning', message: `Unexplained tank variance after RTT: ${signedNf(variance.combined.unexplained)} L this month (above tolerance) - see Section 10.` });
  }
  (creditorExposure.creditors || []).forEach(c => {
    if (c.direction === 'growing') {
      flags.push({ severity: 'warning', message: `${c.name} balance grew by GHS ${d(c.net_change)} this month (credit sales GHS ${d(c.credit_sales)}, payments GHS ${d(c.payments)}).` });
    }
    // The current month's limit check already comes from computeFlags;
    // for a past month this is the only place it is raised.
    if (!isCurrentMonth && c.utilisation_pct !== null && c.utilisation_pct >= FLAG_THRESHOLDS.creditorExposurePct * 100) {
      flags.push({ severity: 'warning', message: `${c.name} was at about ${nf(c.utilisation_pct, 0)}% of its credit limit at month end (estimated balance GHS ${d(c.closing_balance)}).` });
    }
  });
  if (Math.abs(creditorExposure.credit_source_gap) > 1) {
    flags.push({ severity: 'warning', message: `Sales Book Merka Wood column (GHS ${d(creditorExposure.sales_book_merka)}) differs from recorded credit sales (GHS ${d(creditorExposure.total_credit_sales)}) by GHS ${d(Math.abs(creditorExposure.credit_source_gap))} - one was keyed wrong. See Section 11.` });
  }
  if (banking && banking.available && banking.flagged_windows.length > 0) {
    const w = banking.flagged_windows[0];
    flags.push({ severity: 'warning', message: `Banking lagged sales: gap above one day of sales from ${w.from} to ${w.to} (peak GHS ${d(w.peak_gap_ghs)}) - see Section 12.` });
  }
  (meterChecks.fuel_zero_days || []).forEach(f => {
    flags.push({ severity: 'warning', message: `No ${f.fuel_type} sales on any nozzle on ${f.dates.length} day(s) while the station traded - check whether ${f.tank || 'the tank'} ran out. See Section 13.` });
  });
  const zeros = meterChecks.zero_nozzles.filter(n => n.zero_dates.length > 0);
  if (zeros.length > 0) {
    flags.push({ severity: 'warning', message: `${zeros.length} nozzle(s) had no net sales on days the station traded (${zeros.map(n => `${n.pump_id} ${n.fuel_type}`).join(', ')}) - see Section 13.` });
  }
  return flags;
}

// Assembles every new block for the current month's payload.
function buildEnhancements({ month, current, trend, creditors, payments, paymentsOk, postCredits, postPayments, postOk, deliveries, deliveriesOk, compliance, today }) {
  const meter = current.section1_fuel_sales;
  const isCurrentMonth = month === today.slice(0, 7);

  // Every NEW revenue figure is net of RTT (see netOfRtt). The report's
  // existing sections are untouched.
  const netMeter = meter.map(r => ({ ...r, amount_ghs: netOfRtt(r) }));
  const rtt = { litres: sumBy(meter, 'rtt_litres'), value: sumBy(meter, 'amount_ghs') - sumBy(netMeter, 'amount_ghs') };
  const revenueSplit = computeRevenueSplit(netMeter, computeVolumeAverages(netMeter, month), month, rtt);

  const variance = computeVarianceReconciliation({
    stockSummary: current.section6_summary,
    tankRowCount: current.section6_stock_movement.length,
    meter, deliveries, deliveriesOk,
  });
  const creditorExposure = computeCreditorExposure({
    creditors, creditSales: current.section4_credit_sales, payments, paymentsOk,
    postCredits, postPayments, postOk,
    salesBookMerka: sumBy(current.section2_sales_book, 'merka_wood_ghs'),
    totalRevenue: current.section5_consolidated.total_revenue, isCurrentMonth,
  });
  const banking = computeBankingHealth({ salesBook: current.section2_sales_book, banking: current.section3_banking, month, payments, paymentsOk });
  const meterChecks = computeMeterChecks(meter);

  // Headline callouts and the weekly chart are computed WITHOUT rows that
  // failed the plausibility check: a single corrupted reading would
  // otherwise become "best day of the month" and "busiest pump". Report
  // totals elsewhere stay as recorded (and are flagged) - only these
  // interpretive views drop the rows, and say so.
  const excluded = meter.filter(isImplausibleMeterRow).length;
  const cleanNet = excluded > 0 ? netMeter.filter(r => !isImplausibleMeterRow(r)) : netMeter;
  const cleanAverages = excluded > 0 ? computeVolumeAverages(cleanNet, month) : computeVolumeAverages(netMeter, month);
  const headlines = computeHeadlines({ meter: cleanNet, volumeAverages: cleanAverages, trend, month });
  if (excluded > 0) {
    headlines.unshift({ key: 'excluded_rows', tone: 'warning', text: `${excluded} implausible meter reading(s) were left out of the callouts below (see Section 13). Report totals still include them as recorded.` });
  }

  return {
    fuel_revenue_split: { ...revenueSplit, implausible_rows_included: excluded },
    weekly_chart: { weeks: cleanAverages.weeks, excluded_rows: excluded },
    section9_headlines: headlines,
    section10_variance_reconciliation: variance,
    section11_creditor_exposure: creditorExposure,
    section12_banking_health: banking,
    section13_meter_checks: meterChecks,
    section14_compliance_expiry: computeComplianceExpiry({ compliance, today }),
    generated_on: today,
    extra_flags: buildExtraFlags({ variance, creditorExposure, banking, meterChecks, isCurrentMonth }),
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
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const prevMonth = previousMonthKey(month);
    const trendMonths = lastNMonths(month, 6);
    const { startDate, endDate } = monthDateRange(month);
    const today = new Date().toISOString().slice(0, 10);

    const [current, previous, creditorsRes, complianceRes, deliveriesRes, paymentsRes, postCreditsRes, postPaymentsRes, ...trendResults] = await Promise.all([
      assembleReport(req.supabaseAdmin, month),
      assembleReport(req.supabaseAdmin, prevMonth),
      // creditors / compliance_certificates / creditor_payments all carry deleted_at — filtered.
      req.supabaseAdmin.from('creditors').select('id, name, current_balance_ghs, credit_limit_ghs').eq('is_active', true).is('deleted_at', null),
      req.supabaseAdmin.from('compliance_certificates').select('certificate_name, issuing_authority, expiry_date, alert_days_before, status').is('deleted_at', null),
      // tanker_deliveries has NO deleted_at column — do not add that filter.
      req.supabaseAdmin.from('tanker_deliveries').select('delivery_date, fuel_type, tank_id, expected_litres, actual_litres, shortage_litres').gte('delivery_date', startDate).lte('delivery_date', endDate),
      // Payments are not part of the one-day entry lag (only meter / sales / credit_sales are).
      req.supabaseAdmin.from('creditor_payments').select('creditor_id, payment_date, amount_ghs').gte('payment_date', startDate).lte('payment_date', endDate).is('deleted_at', null),
      // Everything recorded AFTER the month, to rebuild the month-end creditor balance
      // from today's balance. credit_sales rides the one-day lag, payments do not.
      req.supabaseAdmin.from('credit_sales').select('creditor_id, total_amount_ghs').gt('sale_date', shiftDateForward(endDate)).is('deleted_at', null),
      req.supabaseAdmin.from('creditor_payments').select('creditor_id, amount_ghs').gt('payment_date', endDate).is('deleted_at', null),
      ...trendMonths.map(m => getMonthlyFuelRevenue(req.supabaseAdmin, m)),
    ]);

    const isCurrentMonth = month === today.slice(0, 7);
    const enh = buildEnhancements({
      month, current, trend: trendResults,
      creditors: creditorsRes.data || [],
      payments: paymentsRes.data || [], paymentsOk: !paymentsRes.error,
      postCredits: postCreditsRes.data || [], postPayments: postPaymentsRes.data || [],
      postOk: !postCreditsRes.error && !postPaymentsRes.error,
      deliveries: deliveriesRes.data || [], deliveriesOk: !deliveriesRes.error,
      compliance: complianceRes.data || [],
      today,
    });
    const { extra_flags, ...enhSections } = enh;

    const severityRank = { critical: 0, warning: 1, positive: 2 };
    const flags = computeFlags({
      current,
      previousSection5: previous.has_data ? previous.section5_consolidated : null,
      creditors: creditorsRes.data || [],
      compliance: complianceRes.data || [],
      today, isCurrentMonth,
    }).concat(extra_flags).sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

    res.json({
      ...current,
      ...enhSections,
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