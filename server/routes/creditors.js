const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOrManager } = require('../middleware/auth');

// GET /api/creditors
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('creditors')
      .select('*')
      .is('deleted_at', null)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch creditors' });
  }
});

// POST /api/creditors
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { name, contact_name, contact_phone, credit_limit_ghs } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { data, error } = await req.supabaseAdmin
      .from('creditors')
      .insert({ name, contact_name, contact_phone, credit_limit_ghs: credit_limit_ghs || 0 })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create creditor' });
  }
});

// PUT /api/creditors/:id/credit-limit
// A creditor's limit could only be set when the creditor was created, so a
// creditor added with no limit (the default 0) had no way to be given one
// afterwards, and the report's credit-limit warning could never fire for them.
// Only the limit is editable here — name/contact changes are out of scope.
// 0 is allowed and means "no limit set" (the report flags a balance with no limit).
router.put('/:id/credit-limit', authenticate, adminOrManager, async (req, res) => {
  try {
    const raw = req.body.credit_limit_ghs;
    const limit = typeof raw === 'string' ? raw.trim() : raw;
    if ((typeof limit !== 'number' && typeof limit !== 'string') || limit === '' || !Number.isFinite(Number(limit)) || Number(limit) < 0) {
      return res.status(400).json({ error: 'credit_limit_ghs must be a non-negative number' });
    }
    if (Number(limit) > 9999999999) {
      return res.status(400).json({ error: 'credit_limit_ghs is too large' });
    }

    const { data, error } = await req.supabaseAdmin
      .from('creditors')
      .update({ credit_limit_ghs: Number(limit) })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Creditor not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update credit limit' });
  }
});

// PUT /api/creditors/:id/deactivate
// For a creditor who has left. Deliberately refuses while a balance is
// still owed: Reports' creditor-exposure section and the credit-limit
// flags are built from creditors, so hiding someone who still owes money
// would quietly take a real receivable out of view. Clear the balance
// first (record the payment), then deactivate. History is untouched —
// this only flips is_active; past credit sales and payments stay exactly
// where they are, and the creditor can be reactivated.
router.put('/:id/deactivate', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data: creditor, error: fetchError } = await req.supabaseAdmin
      .from('creditors')
      .select('id, name, is_active, current_balance_ghs')
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    if (!creditor) return res.status(404).json({ error: 'Creditor not found' });
    if (creditor.is_active === false) {
      return res.status(409).json({ error: `${creditor.name} is already inactive` });
    }
    const balance = parseFloat(creditor.current_balance_ghs) || 0;
    if (balance > 0.005) {
      return res.status(400).json({
        error: `${creditor.name} still owes GHS ${balance.toFixed(2)}. Record the payment first, then deactivate.`
      });
    }

    // The balance condition is repeated on the UPDATE itself so a credit
    // sale landing between the check above and this write can't slip a
    // non-zero balance past it.
    const { data, error } = await req.supabaseAdmin
      .from('creditors')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .lte('current_balance_ghs', 0.005)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) {
      return res.status(409).json({ error: `${creditor.name}'s balance changed while deactivating — refresh and try again.` });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate creditor' });
  }
});

// PUT /api/creditors/:id/reactivate
router.put('/:id/reactivate', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('creditors')
      .update({ is_active: true })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Creditor not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reactivate creditor' });
  }
});

// GET /api/creditors/credit-sales
router.get('/credit-sales', authenticate, adminOrManager, async (req, res) => {
  try {
    const { start_date, end_date, creditor_id } = req.query;
    let query = req.supabaseAdmin
      .from('credit_sales')
      .select('*, creditors(name)')
      .is('deleted_at', null)
      .order('sale_date', { ascending: false });

    if (start_date) query = query.gte('sale_date', start_date);
    if (end_date) query = query.lte('sale_date', end_date);
    if (creditor_id) query = query.eq('creditor_id', creditor_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch credit sales' });
  }
});

// POST /api/creditors/credit-sales
router.post('/credit-sales', authenticate, adminOrManager, async (req, res) => {
  try {
    const {
      sale_date, creditor_id,
      sxp_litres, dxp_litres,
      sxp_amount_ghs, dxp_amount_ghs
    } = req.body;

    if (!sale_date || !creditor_id) {
      return res.status(400).json({ error: 'sale_date and creditor_id are required' });
    }
    // Both litres fields are optional (a sale can be one fuel type only),
    // so 0 must stay valid — only reject non-numeric or negative values.
    // These drive the server-computed amount below, so a negative value
    // here would otherwise produce negative revenue on a credit sale.
    if (sxp_litres !== undefined && (!Number.isFinite(Number(sxp_litres)) || Number(sxp_litres) < 0)) {
      return res.status(400).json({ error: 'sxp_litres must be a non-negative number' });
    }
    if (dxp_litres !== undefined && (!Number.isFinite(Number(dxp_litres)) || Number(dxp_litres) < 0)) {
      return res.status(400).json({ error: 'dxp_litres must be a non-negative number' });
    }

    // A deactivated creditor has left — a new sale to them is almost
    // certainly the wrong creditor picked in the dropdown. Editing or
    // reversing their OLD sales still works (separate routes below).
    const { data: targetCreditor, error: creditorError } = await req.supabaseAdmin
      .from('creditors')
      .select('name, is_active')
      .eq('id', creditor_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (creditorError) return res.status(500).json({ error: creditorError.message });
    if (!targetCreditor) return res.status(404).json({ error: 'Creditor not found' });
    if (targetCreditor.is_active === false) {
      return res.status(400).json({ error: `${targetCreditor.name} is inactive. Reactivate them first, or pick a different creditor.` });
    }

    // Recompute amounts server-side using the price effective on sale_date —
    // not whatever the client sent, which uses "current" price regardless of
    // which date was actually selected (wrong when backfilling a past date)
    //
    // effective_time tie-break: since 20260918120000_intraday_price_sessions.sql
    // widened fuel_prices to (fuel_type, effective_date, effective_time),
    // two rows can share one effective_date — without this secondary sort
    // the tie resolves arbitrarily (see sales.js's identical fix for the
    // full explanation). Credit sales, like RTT, are day-level, not
    // session-split, so "latest price in effect that day" is correct.
    const getEffectivePrice = async (fuelType) => {
      const { data: priceRow } = await req.supabaseAdmin
        .from('fuel_prices')
        .select('price_per_litre')
        .eq('fuel_type', fuelType)
        .lte('effective_date', sale_date)
        .order('effective_date', { ascending: false })
        .order('effective_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      return parseFloat(priceRow?.price_per_litre) || 0;
    };

    const sxpPrice = await getEffectivePrice('SXP');
    const dxpPrice = await getEffectivePrice('DXP');
    const computedSxpAmount = (parseFloat(sxp_litres) || 0) * sxpPrice;
    const computedDxpAmount = (parseFloat(dxp_litres) || 0) * dxpPrice;

    // The insert and the balance update happen together, atomically, inside
    // one Postgres function — see migrations/006_creditor_balance_functions.sql.
    // Previously these were two separate app-layer steps (read balance,
    // compute, write back), which had a race condition under concurrent use
    // and silently swallowed balance-update failures while still returning
    // 201. Now either both succeed or neither does, and a failure here is a
    // real error returned to the client, not a console.error nobody sees.
    const { data, error } = await req.supabaseAdmin.rpc('record_credit_sale', {
      p_sale_date: sale_date,
      p_creditor_id: creditor_id,
      p_sxp_litres: sxp_litres || 0,
      p_dxp_litres: dxp_litres || 0,
      p_sxp_amount_ghs: computedSxpAmount,
      p_dxp_amount_ghs: computedDxpAmount,
      p_created_by: req.user.id
    }).single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save credit sale' });
  }
});

// GET /api/creditors/payments
router.get('/payments', authenticate, adminOrManager, async (req, res) => {
  try {
    const { start_date, end_date, creditor_id } = req.query;
    let query = req.supabaseAdmin
      .from('creditor_payments')
      .select('*, creditors(name)')
      .is('deleted_at', null)
      .order('payment_date', { ascending: false });

    if (start_date) query = query.gte('payment_date', start_date);
    if (end_date) query = query.lte('payment_date', end_date);
    if (creditor_id) query = query.eq('creditor_id', creditor_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// POST /api/creditors/payments
router.post('/payments', authenticate, adminOrManager, async (req, res) => {
  try {
    const { payment_date, creditor_id, amount_ghs, payment_method, reference } = req.body;

    if (!payment_date || !creditor_id || !amount_ghs) {
      return res.status(400).json({ error: 'payment_date, creditor_id, and amount_ghs are required' });
    }
    if (!Number.isFinite(Number(amount_ghs)) || Number(amount_ghs) <= 0) {
      return res.status(400).json({ error: 'amount_ghs must be a positive number' });
    }

    // Atomic — see migrations/006_creditor_balance_functions.sql. The
    // previous version didn't even check for an error on the balance
    // update at all; a failed update here would leave the payment
    // recorded but the balance permanently overstated, with no error
    // anywhere. Now it's one transaction: both happen or neither does.
    const { data, error } = await req.supabaseAdmin.rpc('record_creditor_payment', {
      p_payment_date: payment_date,
      p_creditor_id: creditor_id,
      p_amount_ghs: amount_ghs,
      p_payment_method: payment_method,
      p_reference: reference,
      p_created_by: req.user.id
    }).single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save payment' });
  }
});

// DELETE /api/creditors/credit-sales/:id
// Soft-deletes the row and reverses its exact effect on the
// creditor's balance — see migrations/008_creditor_reversal_functions.sql.
// Only the creditor's single most recent transaction (sale or
// payment) can be reversed this way; anything older is rejected
// by the RPC with a clear error rather than silently corrupting
// balances affected by later transactions.
router.delete('/credit-sales/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { error } = await req.supabaseAdmin.rpc('reverse_credit_sale', {
      p_id: req.params.id
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reverse credit sale' });
  }
});

// PUT /api/creditors/credit-sales/:id
// Implemented as reverse-then-reinsert inside a single Postgres
// function (one transaction) — not two separate API calls, which
// would reopen the exact race/partial-failure window migration 006
// was written to close.
router.put('/credit-sales/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { sale_date, sxp_litres, dxp_litres } = req.body;
    if (!sale_date) return res.status(400).json({ error: 'sale_date is required' });

    // Same guard as POST /credit-sales — missed here originally even
    // though this is the exact same field, edited via a different route.
    if (sxp_litres !== undefined && (!Number.isFinite(Number(sxp_litres)) || Number(sxp_litres) < 0)) {
      return res.status(400).json({ error: 'sxp_litres must be a non-negative number' });
    }
    if (dxp_litres !== undefined && (!Number.isFinite(Number(dxp_litres)) || Number(dxp_litres) < 0)) {
      return res.status(400).json({ error: 'dxp_litres must be a non-negative number' });
    }

    // edit_credit_sale() cannot change a sale's creditor (reassigning is
    // reverse-and-re-enter, by design). If a caller sends a different
    // creditor_id, silently ignoring it would answer "updated" while the sale
    // stays with the old creditor — so refuse it instead.
    if (req.body.creditor_id) {
      const { data: existingSale, error: lookupError } = await req.supabaseAdmin
        .from('credit_sales')
        .select('creditor_id')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .maybeSingle();
      if (lookupError) return res.status(500).json({ error: lookupError.message });
      if (!existingSale) return res.status(404).json({ error: 'Credit sale not found' });
      if (existingSale.creditor_id !== req.body.creditor_id) {
        return res.status(400).json({ error: "A credit sale can't be moved to a different creditor by editing it. Reverse it, then enter a new sale for the right creditor." });
      }
    }

    // Same server-side effective-price recomputation as POST — never
    // trust a client-sent amount, since it may reflect "current" price
    // rather than the price effective on the selected date. Same
    // effective_time tie-break fix as POST above, and for the same reason.
    const getEffectivePrice = async (fuelType) => {
      const { data: priceRow } = await req.supabaseAdmin
        .from('fuel_prices')
        .select('price_per_litre')
        .eq('fuel_type', fuelType)
        .lte('effective_date', sale_date)
        .order('effective_date', { ascending: false })
        .order('effective_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      return parseFloat(priceRow?.price_per_litre) || 0;
    };

    const sxpPrice = await getEffectivePrice('SXP');
    const dxpPrice = await getEffectivePrice('DXP');
    const computedSxpAmount = (parseFloat(sxp_litres) || 0) * sxpPrice;
    const computedDxpAmount = (parseFloat(dxp_litres) || 0) * dxpPrice;

    const { data, error } = await req.supabaseAdmin.rpc('edit_credit_sale', {
      p_id: req.params.id,
      p_sale_date: sale_date,
      p_sxp_litres: sxp_litres || 0,
      p_dxp_litres: dxp_litres || 0,
      p_sxp_amount_ghs: computedSxpAmount,
      p_dxp_amount_ghs: computedDxpAmount,
      p_actor_id: req.user.id
    }).single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to edit credit sale' });
  }
});

// DELETE /api/creditors/payments/:id
// Restores the creditor's exact pre-payment balance via the stored
// balance_before_ghs snapshot — correct even if this payment
// clamped the balance at zero on the way in (e.g. an overpayment).
// See migrations/008_creditor_reversal_functions.sql for why a
// naive "add the amount back" would be wrong in that case.
router.delete('/payments/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { error } = await req.supabaseAdmin.rpc('reverse_creditor_payment', {
      p_id: req.params.id
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reverse payment' });
  }
});

// PUT /api/creditors/payments/:id
router.put('/payments/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { payment_date, amount_ghs, payment_method, reference } = req.body;
    if (!payment_date || !amount_ghs) {
      return res.status(400).json({ error: 'payment_date and amount_ghs are required' });
    }
    // Same guard as POST /payments — missed here originally.
    if (!Number.isFinite(Number(amount_ghs)) || Number(amount_ghs) <= 0) {
      return res.status(400).json({ error: 'amount_ghs must be a positive number' });
    }

    const { data, error } = await req.supabaseAdmin.rpc('edit_creditor_payment', {
      p_id: req.params.id,
      p_payment_date: payment_date,
      p_amount_ghs: amount_ghs,
      p_payment_method: payment_method,
      p_reference: reference,
      p_actor_id: req.user.id
    }).single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to edit payment' });
  }
});

module.exports = router;