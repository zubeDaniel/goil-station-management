// Shared by routes/banking.js and routes/reports.js so the Banking screen and
// report Section 3 can never disagree about what a day's deposits were.
//
// Every returned banking row carries two extra arrays:
//   nib_deposits / umb_deposits = [{ amount_ghs: number, slip_ref: string|null }]
// in the order they were entered. banking.nib_ghs / umb_momo_ghs are still the
// stored daily totals (the sum of these arrays) — every other consumer
// (Dashboard KPI, report Section 5 / 12) keeps reading those unchanged.

const MAX_DEPOSITS_PER_BANK = 20; // sanity cap; real days are 1-4
// Far above any real deposit, and low enough that 20 deposits can never overflow
// the numeric(12,2) daily total (20 x 1e8 = 2e9 < 1e10) — so a typo like an extra
// five zeros is a clear 400 instead of a raw database overflow error.
const MAX_AMOUNT_GHS = 100000000;
const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)$/;

// number, or a plain decimal string ("7000", " 7000.50 "). Anything else — hex
// ("0x10"), exponent ("1e3"), booleans, objects — is NaN, not a silent guess.
function parseAmount(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) return Number(value.trim());
  return NaN;
}

function shapeRow(row) {
  const { bank_deposits: rawDeposits, ...rest } = row;
  const deposits = (rawDeposits || []).slice().sort((a, b) => a.seq - b.seq);

  const toList = (bank, storedTotal) => {
    const list = deposits
      .filter(d => d.bank === bank)
      .map(d => ({ amount_ghs: parseFloat(d.amount_ghs), slip_ref: d.slip_ref || null }));
    // A day with a stored total but no deposit rows is a day saved before the
    // bank_deposits migration (or while it wasn't applied yet): present its
    // total as a single deposit so screens and reports never show a gap.
    if (list.length === 0 && parseFloat(storedTotal) > 0) {
      return [{ amount_ghs: parseFloat(storedTotal), slip_ref: null }];
    }
    return list;
  };

  return {
    ...rest,
    nib_deposits: toList('NIB', rest.nib_ghs),
    umb_deposits: toList('UMB', rest.umb_momo_ghs),
  };
}

// Returns { data, error } shaped like a supabase-js response, so callers that
// previously did `await supabase.from('banking').select('*')...` can swap this
// in with no other change.
async function fetchBanking(client, { start_date, end_date, ascending = false } = {}) {
  const build = (columns) => {
    let q = client.from('banking').select(columns).order('entry_date', { ascending });
    if (start_date) q = q.gte('entry_date', start_date);
    if (end_date) q = q.lte('entry_date', end_date);
    return q;
  };

  const withDeposits = await build('*, bank_deposits(bank, seq, amount_ghs, slip_ref)');
  if (!withDeposits.error) {
    return { data: (withDeposits.data || []).map(shapeRow), error: null };
  }

  // Fall back ONLY when the failure is "bank_deposits isn't there / isn't
  // related yet" (migration not applied, or PostgREST's schema cache hasn't
  // reloaded): plain banking rows, each stored total shown as one deposit, so
  // the Banking screen and every report stay up. Any other error (network blip,
  // permissions, timeout) is returned as-is — silently degrading then would
  // show a multi-deposit day as one lump sum with no warning.
  const err = withDeposits.error;
  const depositsMissing = ['PGRST200', 'PGRST205', '42P01'].includes(err.code) || /bank_deposits/i.test(err.message || '');
  if (!depositsMissing) return { data: null, error: err };

  const plain = await build('*');
  if (plain.error) return { data: null, error: plain.error };
  console.warn('bank_deposits not readable — falling back to stored banking totals:', withDeposits.error.message);
  return { data: (plain.data || []).map(shapeRow), error: null };
}

// Request body -> [{ amount_ghs, slip_ref }] for one bank.
//   body.nib_deposits = [{ amount_ghs | amount, slip_ref }]   (new clients)
//   body.nib_ghs      = 15000                                  (old callers, e.g. the Excel import)
// Blank and zero amounts are dropped — an unfilled "add another" row is not an
// error. Returns { error } for anything malformed, never a silent drop of data
// the caller actually sent.
function parseDeposits(body, listField, legacyField) {
  const label = listField.replace('_deposits', '').toUpperCase();
  let raw;
  let legacy = false;

  const listValue = body[listField];
  if (listValue !== undefined && listValue !== null && !Array.isArray(listValue)) {
    return { error: `${listField} must be an array` };
  }

  if (Array.isArray(listValue)) {
    raw = listValue;
  } else if (body[legacyField] !== undefined && body[legacyField] !== null && body[legacyField] !== '') {
    raw = [{ amount_ghs: body[legacyField] }];
    legacy = true;
  } else {
    raw = [];
  }

  if (raw.length > MAX_DEPOSITS_PER_BANK) {
    return { error: `${label}: at most ${MAX_DEPOSITS_PER_BANK} deposits per day` };
  }

  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${label} deposit ${i + 1}: expected an object with amount_ghs` };
    }
    const value = item.amount_ghs !== undefined ? item.amount_ghs : item.amount;
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) continue;

    // Legacy callers keep the exact message they always got.
    const where = legacy ? legacyField : `${label} deposit ${i + 1}: amount`;
    const n = parseAmount(value);
    if (!Number.isFinite(n) || n < 0) return { error: `${where} must be a non-negative number` };
    if (n > MAX_AMOUNT_GHS) return { error: `${where} is too large (maximum ${MAX_AMOUNT_GHS})` };
    if (n === 0) continue;

    let slip = '';
    if (item.slip_ref !== undefined && item.slip_ref !== null) {
      if (typeof item.slip_ref !== 'string' && typeof item.slip_ref !== 'number') {
        return { error: `${label} deposit ${i + 1}: slip reference must be text` };
      }
      slip = String(item.slip_ref).trim();
    }
    if (slip.length > 60) {
      return { error: `${label} deposit ${i + 1}: slip reference is too long (max 60 characters)` };
    }
    out.push({ amount_ghs: Math.round(n * 100) / 100, slip_ref: slip || null });
  }
  return { deposits: out };
}

module.exports = { fetchBanking, parseDeposits, shapeRow, MAX_DEPOSITS_PER_BANK, MAX_AMOUNT_GHS };
