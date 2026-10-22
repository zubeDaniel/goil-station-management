import { useState, useEffect } from 'react'
import { useRole } from '../hooks/useRole'
import api from '../lib/api'
import { addDays } from '../lib/dates'
import { useToast } from '../components/Toast'

const TANKS = [
  { tankId: 'TANK_A', fuel: 'SXP', label: 'Tank A', sub: 'SXP — Super XP 91', dotColor: 'var(--orange)' },
  { tankId: 'TANK_B', fuel: 'DXP', label: 'Tank B', sub: 'DXP — Diesel XP',   dotColor: 'var(--amber)' },
]

const emptyTank = () => ({
  opening_stock:     '',
  litres_sold:       '',
  closing_stock_dip: '',
})

const emptyDelivery = () => ({
  checked:         false,
  fetching:        false,
  actual_litres:   0,   // from tanker_deliveries.actual_litres
  expected_litres: 0,   // from tanker_deliveries.expected_litres (waybill)
  record:          null,
})

export default function TankStock() {
  const { showToast } = useToast()
  const { isAdmin } = useRole()
  const [stocks, setStocks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  // Maps tank id -> id of the existing tank_stock row for the currently
  // selected stock_date, if one was already saved. The per-row pencil-icon
  // edit modal below (openEdit/handleUpdateRow) already handles corrections
  // correctly via PUT — this is a separate gap: the daily-entry form above
  // it always POSTed regardless of whether today's date already had an
  // entry, so re-opening an already-saved day and using the top form (the
  // obvious first thing to try) hit the (stock_date, tank_id) unique
  // constraint instead of editing. This tracks the same detection for that
  // top form, so it can PUT instead.
  const [existingStockIds, setExistingStockIds] = useState({})

  const [form, setForm] = useState({
    stock_date: new Date().toISOString().split('T')[0],
    TANK_A: emptyTank(),
    TANK_B: emptyTank(),
  })

  // Per-tank delivery state — kept separate so each tank is independent
  const [delivery, setDelivery] = useState({
    TANK_A: emptyDelivery(),
    TANK_B: emptyDelivery(),
  })

  // Editing a historical row is deliberately separate from the main
  // dual-tank daily-entry form above — that form always submits both
  // tanks together for "today". Correcting a past entry is a single-row
  // operation, scoped to exactly the two fields the backend allows
  // editing (closing_stock_dip, delivery_litres) — opening_stock stays as
  // the historical snapshot it was, litres_sold/expected_variance are
  // re-derived server-side, not edited directly. See tankstock.js PUT.
  const [editingRow, setEditingRow] = useState(null)
  const [editForm, setEditForm] = useState({ closing_stock_dip: '', delivery_litres: '' })
  const [editDeliveryRecord, setEditDeliveryRecord] = useState(null)
  const [editDeliveryLoading, setEditDeliveryLoading] = useState(false)
  const [editSaving, setEditSaving] = useState(false)

  const openEdit = async (row) => {
    setEditingRow(row)
    setEditForm({ closing_stock_dip: String(row.closing_stock_dip || 0), delivery_litres: '' })
    setEditDeliveryLoading(true)
    try {
      // delivery_litres is derived from the actual tanker_deliveries
      // record for this tank+date, same as the create form — not
      // free-typed. A manually-entered number here, disconnected from
      // what was actually logged in Deliveries, is exactly how a wrong
      // figure ends up saved with no real record of where it came from.
      // A tank stock entry dated D closes physical day D-1, and deliveries are
      // logged on the day the truck arrived — so this entry's delivery is the
      // one dated the day BEFORE stock_date (same rule the server applies).
      const res = await api.get(`/deliveries?date=${addDays(row.stock_date, -1)}&tank_id=${row.tank_id}`)
      const record = res.data?.[0] || null
      setEditDeliveryRecord(record)
      setEditForm(p => ({ ...p, delivery_litres: String(record ? record.actual_litres : 0) }))
    } catch (err) {
      console.error('Failed to load delivery record for edit', err)
      setEditDeliveryRecord(null)
      setEditForm(p => ({ ...p, delivery_litres: String(row.delivery_litres || 0) }))
    } finally {
      setEditDeliveryLoading(false)
    }
  }

  const handleDeleteRow = async (row) => {
    if (!confirm(`Delete this entry — ${row.tank_id} on ${row.stock_date}? This cannot be undone.`)) return
    try {
      await api.delete(`/tank-stock/${row.id}`)
      showToast('success', 'Tank stock entry deleted', `${row.tank_id} — ${row.stock_date}`)
      setEditingRow(null)
      const res = await api.get('/tank-stock')
      setStocks(res.data)
    } catch (err) {
      showToast('error', 'Delete failed', err.response?.data?.error)
    }
  }

  const handleUpdateRow = async () => {
    setEditSaving(true)
    try {
      await api.put(`/tank-stock/${editingRow.id}`, editForm)
      showToast('success', 'Tank stock entry updated', `${editingRow.tank_id} — ${editingRow.stock_date}`)
      setEditingRow(null)
      const res = await api.get('/tank-stock')
      setStocks(res.data)
    } catch (err) {
      showToast('error', 'Update failed', err.response?.data?.error)
    } finally {
      setEditSaving(false)
    }
  }

  useEffect(() => {
    api.get('/tank-stock')
      .then(res => setStocks(res.data))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // ── Auto-fill opening stock (from previous closing dip) and litres sold
  //    (from actual pump meter readings for this date) — stays editable so
  //    a supervisor can correct it if Meter Book wasn't entered yet that day.
  // Tracks whether a prior tank_stock row was actually found for each
  // tank — when none exists (the very first entry ever for that tank),
  // opening_stock needs to stay editable so the real dip-measured
  // baseline can be entered, matching what the backend already allows
  // (server-side derivation falls back to the client's value in exactly
  // this case — see tankstock.js). Previously the field was locked
  // unconditionally, so when no prior entry existed the field was both
  // empty AND uneditable, silently sending 0 as the opening stock and
  // showing a wildly wrong live variance preview.
  const [hasNoPrior, setHasNoPrior] = useState({ TANK_A: false, TANK_B: false })

  useEffect(() => {
    if (loading) return

    setForm(prev => {
      const updated = { ...prev }
      const noPrior = {}
      TANKS.forEach(({ tankId }) => {
        const prior = stocks
          .filter(s => s.tank_id === tankId && s.stock_date < prev.stock_date)
          .sort((a, b) => b.stock_date.localeCompare(a.stock_date))[0]
        if (prior) {
          updated[tankId] = { ...updated[tankId], opening_stock: parseFloat(prior.closing_stock_dip).toFixed(2) }
          noPrior[tankId] = false
        } else {
          updated[tankId] = { ...updated[tankId], opening_stock: '' }
          noPrior[tankId] = true
        }
      })
      setHasNoPrior(noPrior)
      return updated
    })

    // Detect any entry that already exists for the selected date — same
    // gap this file's pencil-icon edit modal already covers for corrections
    // made from the history table below, but the top form itself never
    // checked before blind-POSTing. Only closing_stock_dip is loaded back
    // in (the one genuinely manual field); opening_stock and litres_sold
    // keep using the live auto-fill above/below rather than the stored
    // snapshot, since the backend re-derives both fresh on every save too.
    const idsForDate = {}
    const existingByTank = {}
    TANKS.forEach(({ tankId }) => {
      const existing = stocks.find(s => s.tank_id === tankId && s.stock_date === form.stock_date)
      if (existing) {
        idsForDate[tankId] = existing.id
        existingByTank[tankId] = existing
      }
    })
    setExistingStockIds(idsForDate)
    if (Object.keys(idsForDate).length > 0) {
      setForm(prev => {
        const updated = { ...prev }
        TANKS.forEach(({ tankId }) => {
          if (existingByTank[tankId]) {
            updated[tankId] = { ...updated[tankId], closing_stock_dip: String(existingByTank[tankId].closing_stock_dip) }
          }
        })
        return updated
      })
      // Restore the delivery checkbox/figures for any tank whose existing
      // row recorded a delivery — otherwise re-saving with the checkbox
      // unchecked would silently zero out a real delivery_litres value.
      TANKS.forEach(({ tankId }) => {
        const existing = existingByTank[tankId]
        if (existing && parseFloat(existing.delivery_litres) > 0) {
          handleDeliveryToggle(tankId, true)
        }
      })
    }

    api.get(`/meter?start_date=${form.stock_date}&end_date=${form.stock_date}`)
      .then(res => {
        const readings = res.data || []
        const sxpTotal = readings.filter(r => r.fuel_type === 'SXP').reduce((s, r) => s + (parseFloat(r.litres_sold) || 0), 0)
        const dxpTotal = readings.filter(r => r.fuel_type === 'DXP').reduce((s, r) => s + (parseFloat(r.litres_sold) || 0), 0)
        setForm(prev => ({
          ...prev,
          TANK_A: { ...prev.TANK_A, litres_sold: sxpTotal.toFixed(2) },
          TANK_B: { ...prev.TANK_B, litres_sold: dxpTotal.toFixed(2) },
        }))
      })
      .catch(console.error)
  }, [stocks, form.stock_date, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Variance calculations ──────────────────────────────────
  // actual_variance  = closing_dip − (opening + actual_delivery  − sold)
  // expected_variance = closing_dip − (opening + waybill_expected − sold)
  // On non-delivery days both are identical (delivery = 0 for both)

  const calcActualVariance = (tankId) => {
    const t = form[tankId]
    const d = delivery[tankId]
    const closing  = parseFloat(t.closing_stock_dip) || 0
    const opening  = parseFloat(t.opening_stock)     || 0
    const sold     = parseFloat(t.litres_sold)        || 0
    const actual   = d.checked ? d.actual_litres      : 0
    return (closing - (opening + actual - sold)).toFixed(2)
  }

  const calcExpectedVariance = (tankId) => {
    const t = form[tankId]
    const d = delivery[tankId]
    const closing   = parseFloat(t.closing_stock_dip) || 0
    const opening   = parseFloat(t.opening_stock)     || 0
    const sold      = parseFloat(t.litres_sold)        || 0
    const expected  = d.checked ? d.expected_litres    : 0
    return (closing - (opening + expected - sold)).toFixed(2)
  }

  // ── Delivery toggle per tank — Option A ───────────────────
  const handleDeliveryToggle = async (tankId, checked) => {
    // Optimistically update checked state
    setDelivery(prev => ({
      ...prev,
      [tankId]: { ...prev[tankId], checked, fetching: checked },
    }))

    if (!checked) {
      // Uncheck — reset delivery figures
      setDelivery(prev => ({ ...prev, [tankId]: emptyDelivery() }))
      return
    }

    try {
      // This closing is for the PREVIOUS day, so look for the delivery logged on
      // that day (its real arrival date) — not on the date of this entry.
      const deliveryDate = addDays(form.stock_date, -1)
      const res = await api.get(`/deliveries?date=${deliveryDate}&tank_id=${tankId}`)
      const records = res.data

      if (!records || records.length === 0) {
        showToast(
          'warning',
          'No delivery record found',
          `No tanker delivery logged for ${tankId} on ${deliveryDate} (the day this entry closes). Log it in Deliveries first.`
        )
        setDelivery(prev => ({ ...prev, [tankId]: emptyDelivery() }))
        return
      }

      // Use the first matching record (one delivery per tank per day is the norm)
      const rec = records[0]
      const actualLitres   = parseFloat(rec.actual_litres)   || 0
      const expectedLitres = parseFloat(rec.expected_litres) || 0

      setDelivery(prev => ({
        ...prev,
        [tankId]: {
          checked:         true,
          fetching:        false,
          actual_litres:   actualLitres,
          expected_litres: expectedLitres,
          record:          rec,
        },
      }))

      showToast(
        'info',
        `Delivery found — ${tankId}`,
        `Expected: ${expectedLitres.toFixed(0)} L · Actual: ${actualLitres.toFixed(0)} L · BOL: ${rec.bol_number}`
      )
    } catch (err) {
      showToast('error', 'Could not fetch deliveries', err.response?.data?.error || 'Check your connection')
      setDelivery(prev => ({ ...prev, [tankId]: emptyDelivery() }))
    }
  }

  // Reset delivery state when date changes
  const handleDateChange = (newDate) => {
    setExistingStockIds({})
    setForm(prev => ({ ...prev, stock_date: newDate, TANK_A: emptyTank(), TANK_B: emptyTank() }))
    setDelivery({ TANK_A: emptyDelivery(), TANK_B: emptyDelivery() })
  }

  // ── Save ───────────────────────────────────────────────────
  // Branches per tank: existingStockIds[tankId] set -> PUT (correcting an
  // already-saved entry for this date), unset -> POST (first entry for
  // this tank on this date). Previously always POSTed, so reusing this
  // form on an already-saved day collided with the (stock_date, tank_id)
  // unique constraint — the pencil-icon edit in the history table below
  // already worked, but this top form had no equivalent check.
  const handleSave = async () => {
    setSaving(true)
    try {
      let updated = 0, created = 0
      for (const { tankId, fuel } of TANKS) {
        const tank = form[tankId]
        if (!tank.closing_stock_dip) continue

        const d = delivery[tankId]
        const existingId = existingStockIds[tankId]

        if (existingId) {
          // PUT only accepts closing_stock_dip/delivery_litres — see
          // server/routes/tankstock.js. opening_stock, litres_sold, and
          // expected_variance are re-derived server-side either way.
          await api.put(`/tank-stock/${existingId}`, {
            closing_stock_dip: parseFloat(tank.closing_stock_dip),
            delivery_litres:   d.checked ? d.actual_litres : 0,
          })
          updated++
        } else {
          const actualVariance   = parseFloat(calcActualVariance(tankId))
          const expectedVariance = parseFloat(calcExpectedVariance(tankId))

          await api.post('/tank-stock', {
            stock_date:        form.stock_date,
            tank_id:           tankId,
            fuel_type:         fuel,
            opening_stock:     parseFloat(tank.opening_stock)     || 0,
            litres_sold:       parseFloat(tank.litres_sold)        || 0,
            delivery_litres:   d.checked ? d.actual_litres         : 0,
            closing_stock_dip: parseFloat(tank.closing_stock_dip),
            actual_variance:   actualVariance,
            expected_variance: expectedVariance,
          })
          created++
        }
      }

      const summary = updated && created
        ? `${created} new, ${updated} updated`
        : updated
          ? `${updated} tank${updated > 1 ? 's' : ''} updated`
          : `${created} tank${created > 1 ? 's' : ''} saved`

      showToast('success', 'Tank stock saved', `${form.stock_date} — ${summary}`)
      const res = await api.get('/tank-stock')
      setStocks(res.data)
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error || 'Check your connection')
    } finally {
      setSaving(false)
    }
  }

  const updateTank = (tankId, field, value) => {
    setForm(prev => ({ ...prev, [tankId]: { ...prev[tankId], [field]: value } }))
  }

  if (loading) return <div className="loading-screen">Loading tank stock…</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Tank Stock</h2>
          <p>Daily supervisor dip readings · Tank A (SXP → P1+P2) · Tank B (DXP → P1+P2+P3)</p>
        </div>
      </div>

      {/* Shared date picker */}
      <div style={{ marginBottom:16, maxWidth:220 }}>
        <div className="form-group">
          <label className="form-label">Date</label>
          <input
            className="form-input"
            type="date"
            value={form.stock_date}
            onChange={e => handleDateChange(e.target.value)}
          />
        </div>
      </div>

      <div className="grid-2 mb-16">
        {TANKS.map(({ tankId, fuel, label, sub, dotColor }) => {
          const tank          = form[tankId]
          const del           = delivery[tankId]
          const actualVar     = calcActualVariance(tankId)
          const expectedVar   = calcExpectedVariance(tankId)
          const actualNeg     = parseFloat(actualVar) < 0
          const expectedNeg   = parseFloat(expectedVar) < 0
          const varsDiffer    = del.checked && actualVar !== expectedVar

          return (
            <div key={tankId} className="card">
              {/* Tank header */}
              <div className="card-header">
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:10, height:10, background:dotColor, borderRadius:'50%' }}></div>
                    <div className="card-title">{label} — {sub}</div>
                  </div>
                  <div className="card-subtitle">Capacity: 10,000 L</div>
                </div>
                {existingStockIds[tankId] && (
                  <span className="badge badge-amber">Already saved — editing</span>
                )}
              </div>

              {/* Delivery checkbox */}
              <div
                style={{
                  display:'flex', alignItems:'center', gap:10,
                  padding:'8px 14px',
                  background: del.checked ? 'var(--amber-subtle)' : 'var(--surface-2)',
                  border:`1px solid ${del.checked ? 'var(--amber-border)' : 'var(--border)'}`,
                  borderRadius:'var(--r-md)',
                  cursor: del.fetching ? 'wait' : 'pointer',
                  marginBottom:14,
                  transition:'all 0.12s',
                  userSelect:'none',
                }}
                onClick={() => !del.fetching && handleDeliveryToggle(tankId, !del.checked)}
              >
                <div style={{
                  width:16, height:16,
                  border:`2px solid ${del.checked ? 'var(--amber)' : 'var(--border-strong)'}`,
                  borderRadius:3,
                  background: del.checked ? 'var(--amber)' : 'transparent',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  flexShrink:0,
                  transition:'all 0.12s',
                }}>
                  {del.checked && (
                    <svg viewBox="0 0 10 8" fill="none" width={10} height={10}>
                      <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <span style={{ fontSize:13, fontWeight:500, color: del.checked ? 'var(--amber)' : 'var(--text-2)' }}>
                  {del.fetching ? 'Checking deliveries…' : `Delivery received on ${addDays(form.stock_date, -1)}`}
                </span>
                {del.checked && del.record && (
                  <span style={{ marginLeft:'auto', fontSize:11, color:'var(--amber)', fontFamily:'var(--font-mono)' }}>
                    {del.actual_litres.toFixed(0)} L actual · {del.expected_litres.toFixed(0)} L waybill
                  </span>
                )}
              </div>

              {/* Shortage note — shown when delivery has shortage */}
              {del.checked && del.record && parseFloat(del.record.shortage_litres) > 0 && (
                <div style={{
                  padding:'8px 12px',
                  background:'var(--red-subtle)',
                  border:'1px solid var(--red-border)',
                  borderRadius:'var(--r-md)',
                  marginBottom:14,
                  fontSize:12,
                  color:'var(--red)',
                  display:'flex', alignItems:'center', gap:8,
                }}>
                  <i className="ph ph-warning"></i>
                  Tanker shortage: {parseFloat(del.record.shortage_litres).toFixed(0)} L — this causes actual and expected variances to differ
                </div>
              )}

              {/* Form fields */}
              <div className="form-row" style={{ marginBottom:12 }}>
                <div className="form-group">
                  <label className="form-label">Opening stock (L)</label>
                  <input
                    className={hasNoPrior[tankId] ? "form-input" : "form-input is-auto"}
                    type="number"
                    value={tank.opening_stock}
                    readOnly={!hasNoPrior[tankId]}
                    onChange={hasNoPrior[tankId] ? (e => updateTank(tankId, 'opening_stock', e.target.value)) : undefined}
                    placeholder={hasNoPrior[tankId] ? "No prior entry — enter the physically measured baseline" : "From previous dip"}
                  />
                  <span className="form-hint">
                    {hasNoPrior[tankId]
                      ? "No previous entry for this tank — enter today's dip reading as the starting baseline"
                      : "Locked — always the previous day's actual closing dip for this tank"}
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label">Litres sold (L)</label>
                  <input
                    className="form-input is-auto"
                    type="number"
                    value={tank.litres_sold}
                    readOnly
                    placeholder="From pump meters"
                  />
                  <span className="form-hint">Locked — always the true sum from pump meters, the reconciliation check this screen exists for</span>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom:14 }}>
                <label className="form-label">Closing stock — dip reading (L)</label>
                <input
                  className="form-input"
                  type="number"
                  value={tank.closing_stock_dip}
                  onChange={e => updateTank(tankId, 'closing_stock_dip', e.target.value)}
                  placeholder="Physically measured by supervisor"
                />
              </div>

              {/* Variance pair */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {/* Actual variance */}
                <div style={{
                  background: actualNeg ? 'var(--red-subtle)' : 'var(--green-subtle)',
                  border:`1px solid ${actualNeg ? 'var(--red-border)' : 'var(--green-border)'}`,
                  borderRadius:'var(--r-md)',
                  padding:'12px 14px',
                }}>
                  <div style={{ fontSize:10, fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:0.4, marginBottom:4 }}>
                    Actual variance
                  </div>
                  <div style={{ fontSize:20, fontWeight:700, fontFamily:'var(--font-mono)', color: actualNeg ? 'var(--red)' : 'var(--green)' }}>
                    {actualVar} L
                  </div>
                  {del.checked && (
                    <div style={{ fontSize:10, color:'var(--text-3)', marginTop:4 }}>
                      Uses actual delivery: {del.actual_litres.toFixed(0)} L
                    </div>
                  )}
                </div>

                {/* Expected variance */}
                <div style={{
                  background: expectedNeg ? 'var(--red-subtle)' : 'var(--green-subtle)',
                  border:`1px solid ${expectedNeg ? 'var(--red-border)' : 'var(--green-border)'}`,
                  borderRadius:'var(--r-md)',
                  padding:'12px 14px',
                }}>
                  <div style={{ fontSize:10, fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:0.4, marginBottom:4 }}>
                    Expected variance
                  </div>
                  <div style={{ fontSize:20, fontWeight:700, fontFamily:'var(--font-mono)', color: expectedNeg ? 'var(--red)' : 'var(--green)' }}>
                    {expectedVar} L
                  </div>
                  {del.checked && (
                    <div style={{ fontSize:10, color:'var(--text-3)', marginTop:4 }}>
                      Uses waybill: {del.expected_litres.toFixed(0)} L
                    </div>
                  )}
                </div>
              </div>

              {/* Explain the difference when variances diverge */}
              {varsDiffer && (
                <div style={{ marginTop:8, fontSize:11, color:'var(--amber)', fontWeight:500 }}>
                  Difference of {Math.abs(parseFloat(actualVar) - parseFloat(expectedVar)).toFixed(2)} L = tanker shortage on waybill
                </div>
              )}
              {!del.checked && (
                <div style={{ marginTop:8, fontSize:11, color:'var(--text-3)' }}>
                  No delivery on {addDays(form.stock_date, -1)} — both variances are identical
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:20 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          <i className="ph ph-floppy-disk"></i>
          {saving ? 'Saving…' : Object.keys(existingStockIds).length > 0 ? 'Update tank stock' : 'Save tank stock'}
        </button>
      </div>

      {/* History table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent stock entries</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Tank</th><th>Fuel</th>
                <th>Opening</th><th>Sold</th><th>Delivery</th>
                <th>Closing (dip)</th><th>Actual var.</th><th>Expected var.</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {stocks.slice(0, 20).map(s => (
                <tr key={s.id}>
                  <td>{s.stock_date}</td>
                  <td><span className="badge badge-navy">{s.tank_id}</span></td>
                  <td><span className={`badge ${s.fuel_type === 'SXP' ? 'badge-blue' : 'badge-amber'}`}>{s.fuel_type}</span></td>
                  <td className="td-calc">{parseFloat(s.opening_stock).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(s.litres_sold).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(s.delivery_litres).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(s.closing_stock_dip).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${parseFloat(s.actual_variance) < 0 ? 'badge-red' : 'badge-green'}`}>
                      {parseFloat(s.actual_variance).toFixed(2)} L
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${parseFloat(s.expected_variance) < 0 ? 'badge-red' : 'badge-green'}`}>
                      {parseFloat(s.expected_variance).toFixed(2)} L
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(s)}><i className="ph ph-pencil-simple"></i></button>
                  </td>
                </tr>
              ))}
              {stocks.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign:'center', color:'var(--text-3)', padding:24 }}>
                    No entries yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit modal — deliberately minimal: only the two fields the
          backend allows editing on a historical row. */}
      {editingRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,28,68,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 420 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Edit entry — {editingRow.tank_id}</div>
                <div className="card-subtitle">{editingRow.stock_date}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingRow(null)}><i className="ph ph-x"></i></button>
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Closing stock — dip reading (L)</label>
              <input className="form-input" type="number" value={editForm.closing_stock_dip}
                onChange={e => setEditForm(p => ({ ...p, closing_stock_dip: e.target.value }))} />
            </div>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label">Delivery received (L)</label>
              <input className="form-input is-auto" type="number" value={editForm.delivery_litres}
                readOnly placeholder={editDeliveryLoading ? 'Loading...' : '0'} />
              <span className="form-hint">
                {editDeliveryLoading
                  ? 'Checking Deliveries for this date...'
                  : editDeliveryRecord
                    ? `Locked — from the logged delivery (BOL ${editDeliveryRecord.bol_number}). To correct this figure, edit it in Deliveries instead.`
                    : 'Locked — no delivery logged for this tank on this date, so this is 0. Log it in Deliveries first if one is missing.'}
              </span>
            </div>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label">Opening stock, litres sold, expected variance</label>
              <div className="form-hint">Re-derived automatically from the previous dip, pump readings, and delivery waybill — not editable here or anywhere else. If any of those source records are wrong, correct them at the source (Meter Book, Deliveries, or the previous day's Tank Stock entry) and this entry will reflect it once re-saved.</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              {isAdmin ? (
                <button className="btn btn-danger" onClick={() => handleDeleteRow(editingRow)}>
                  <i className="ph ph-trash"></i> Delete entry
                </button>
              ) : <div />}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => setEditingRow(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleUpdateRow} disabled={editSaving || editDeliveryLoading}>
                  <i className="ph ph-check"></i> {editSaving ? 'Saving...' : 'Update entry'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}