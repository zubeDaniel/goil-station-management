import { useState, useEffect } from 'react'
import api from '../lib/api'
import { useToast } from '../components/Toast'

export default function SalesBook() {
  const { showToast } = useToast()
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7))
  const [form, setForm] = useState({
    entry_date: new Date().toISOString().split('T')[0],
    physical_cash_ghs: '0',
    coupons_ghs: '0',
    gocard_ghs: '0',
    momo_ghs: '0',
    merka_wood_ghs: '0',
    genset_ghs: '0',
    lubricant_ghs: '0',
    meter_amount_ghs: ''
  })
  // Informational only — RTT litres for the selected date, so the form can
  // show *why* meter_amount_ghs (fetched from the server, already net of
  // RTT value) is lower than the raw meter total would suggest. The GHS
  // value of RTT is deliberately not recomputed here — that logic lives
  // once, server-side, in deriveMeterAmount() (server/routes/sales.js) —
  // duplicating a price lookup here risks it drifting out of sync.
  const [rttLitresToday, setRttLitresToday] = useState(0)

  const startDate = `${selectedMonth}-01`
  const endDate = new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth() + 1, 0)
    .toISOString().split('T')[0]

  useEffect(() => {
    loadData()
  }, [selectedMonth])

  const loadData = async () => {
    setLoading(true)
    try {
      const res = await api.get(`/sales?start_date=${startDate}&end_date=${endDate}`)
      setSales(res.data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Auto-fill Merka Wood from credit sales, and meter amount from pump readings,
  // for whichever date is selected — not just today
  useEffect(() => {
    api.get(`/creditors/credit-sales?start_date=${form.entry_date}&end_date=${form.entry_date}`)
      .then(res => {
        const total = res.data.reduce((s, cs) => s + parseFloat(cs.total_amount_ghs || 0), 0)
        setForm(p => ({ ...p, merka_wood_ghs: total.toFixed(2) }))
      }).catch(() => {})

    // meter_amount_ghs here is a client-side preview, recomputed
    // authoritatively server-side at save time — that server figure is
    // what's actually stored. To match the server's net-of-RTT figure
    // without a second fuel_prices lookup (one source of truth for price,
    // not two that could drift), each row's own effective price is derived
    // from data the row already carries: amount_ghs was computed server
    // side as litres_sold × price, so amount_ghs / litres_sold *is* that
    // exact price for that row's date and fuel type — the same value
    // deriveMeterAmount() would independently look up. Rows with
    // litres_sold of 0 can't yield a price this way; RTT on a zero-litres
    // row (rare) isn't deducted from this preview, so it can read slightly
    // high in that edge case — the saved figure is still correct either
    // way since the server does its own independent calculation.
    api.get(`/meter?start_date=${form.entry_date}&end_date=${form.entry_date}`)
      .then(res => {
        const rows = res.data || []
        const gross = rows.reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0)
        const rttLitres = rows.reduce((s, r) => s + parseFloat(r.rtt_litres || 0), 0)
        const rttValue = rows.reduce((s, r) => {
          const litres = parseFloat(r.litres_sold || 0)
          const rtt = parseFloat(r.rtt_litres || 0)
          if (rtt <= 0 || litres <= 0) return s
          const impliedPrice = parseFloat(r.amount_ghs || 0) / litres
          return s + rtt * impliedPrice
        }, 0)
        setForm(p => ({ ...p, meter_amount_ghs: (gross - rttValue).toFixed(2) }))
        setRttLitresToday(rttLitres)
      }).catch(() => {})
  }, [form.entry_date])

  const emptyForm = () => ({
    entry_date: new Date().toISOString().split('T')[0],
    physical_cash_ghs: '0',
    coupons_ghs: '0', gocard_ghs: '0', momo_ghs: '0',
    merka_wood_ghs: '0', genset_ghs: '0', lubricant_ghs: '0',
    meter_amount_ghs: ''
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      if (editingId) {
        await api.put(`/sales/${editingId}`, form)
        showToast('success', 'Sales entry updated', form.entry_date)
        setEditingId(null)
      } else {
        await api.post('/sales', form)
        showToast('success', 'Sales entry saved', form.entry_date)
      }
      setForm(emptyForm())
      await loadData()
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error)
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (row) => {
    setEditingId(row.id)
    setForm({
      entry_date: row.entry_date,
      physical_cash_ghs: String(row.physical_cash_ghs || 0),
      coupons_ghs: String(row.coupons_ghs || 0),
      gocard_ghs: String(row.gocard_ghs || 0),
      momo_ghs: String(row.momo_ghs || 0),
      merka_wood_ghs: String(row.merka_wood_ghs || 0),
      genset_ghs: String(row.genset_ghs || 0),
      lubricant_ghs: String(row.lubricant_ghs || 0),
      meter_amount_ghs: String(row.meter_amount_ghs || 0),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setForm(emptyForm())
  }

  const handleDelete = async (id, date) => {
    if (!confirm(`Delete the sales entry for ${date}? This cannot be undone.`)) return
    try {
      await api.delete(`/sales/${id}`)
      showToast('success', 'Sales entry deleted', date)
      if (editingId === id) handleCancelEdit()
      await loadData()
    } catch (err) {
      showToast('error', 'Delete failed', err.response?.data?.error)
    }
  }

  const channels = [
    { key: 'physical_cash_ghs', label: 'Physical cash', hint: 'Till-counted cash for the day — previously untracked here, which is why variance ran persistently negative' },
    { key: 'coupons_ghs', label: 'Coupons', hint: 'Revenue from coupon sales today — separate from Banking\'s coupon deposit, which reconciles against this' },
    { key: 'gocard_ghs', label: 'GoCard' },
    { key: 'momo_ghs', label: 'MoMo' },
    { key: 'merka_wood_ghs', label: 'Merka Wood', auto: true },
    { key: 'genset_ghs', label: 'Genset' },
    { key: 'lubricant_ghs', label: 'Lubricant' },
  ]

  const total = channels.reduce((s, ch) => s + (parseFloat(form[ch.key]) || 0), 0)
  const variance = total - (parseFloat(form.meter_amount_ghs) || 0)

  // Monthly totals
  const monthlyTotals = channels.reduce((acc, ch) => {
    acc[ch.key] = sales.reduce((s, row) => s + parseFloat(row[ch.key] || 0), 0)
    return acc
  }, {})
  const monthlyTotal = sales.reduce((s, row) => s + parseFloat(row.total_sales_ghs || 0), 0)

  // Available months
  const months = []
  for (let i = 0; i < 6; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    months.push(d.toISOString().slice(0, 7))
  }

  if (loading) return <div className="loading-screen">Loading sales book...</div>

  return (
    <div>
      <div className="page-header">
        <div><h2>Sales Book</h2><p>Daily revenue by channel · RTT excluded from all totals</p></div>
        <div className="page-header-actions">
          <div style={{ display: 'flex', gap: 4 }}>
            {months.map(m => (
              <button key={m} className={`btn btn-sm ${selectedMonth === m ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSelectedMonth(m)}>
                {new Date(m + '-01').toLocaleString('default', { month: 'short' })}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="alert alert-info mb-16">
        <div className="alert-body">
          <div className="alert-title">RTT is excluded from all revenue totals</div>
          <div className="alert-desc">Return to Tank is a stock event only. It never appears in any sales figure.</div>
        </div>
      </div>

      <div className="grid-2 mb-16">
        {/* Daily entry form */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">{editingId ? `Editing entry — ${form.entry_date}` : `Daily entry — ${form.entry_date}`}</div>
            {editingId && <span className="badge badge-amber">Editing</span>}
          </div>
          <div className="form-group" style={{ marginBottom: 14, maxWidth: 220 }}>
            <label className="form-label">Date</label>
            <input className="form-input" type="date" value={form.entry_date} disabled={!!editingId}
              onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))} />
            {editingId && <span className="form-hint">Date can't be changed while editing — delete and re-create instead</span>}
          </div>
          <div className="form-row">
            {channels.map(ch => (
              <div key={ch.key} className="form-group">
                <label className="form-label">{ch.label} (GHS)</label>
                <input
                  className={`form-input ${ch.auto ? 'is-auto' : ''}`}
                  type="number"
                  value={form[ch.key]}
                  onChange={e => !ch.auto && setForm(p => ({ ...p, [ch.key]: e.target.value }))}
                  readOnly={ch.auto}
                />
                {ch.auto && <span className="form-hint">Auto-filled from Creditors</span>}
                {ch.hint && <span className="form-hint">{ch.hint}</span>}
              </div>
            ))}
          </div>
          <div className="form-group" style={{ marginBottom: 14, maxWidth: 220 }}>
            <label className="form-label">Meter amount (GHS)</label>
            <input className="form-input is-auto" type="number" value={form.meter_amount_ghs}
              readOnly placeholder="From meter book" />
            <span className="form-hint">Locked — always the true sum from Meter Book for this date, not editable. This is the number the whole Sales Book cross-check exists to protect.</span>
          </div>

          {/* Totals summary */}
          <div style={{ background: 'var(--navy-light)', border: '1px solid var(--navy-border)', borderRadius: 'var(--r-md)', padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>Total sales</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)' }}>GHS {total.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>Meter amount</div>
                <div className="td-calc" style={{ fontSize: 18, fontWeight: 700 }}>GHS {parseFloat(form.meter_amount_ghs || 0).toFixed(2)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>Variance</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: variance >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {variance >= 0 ? '+' : ''}GHS {variance.toFixed(2)}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'center', padding: 8, background: variance >= 0 ? 'var(--green-subtle)' : 'var(--red-subtle)', border: `1px solid ${variance >= 0 ? 'var(--green-border)' : 'var(--red-border)'}`, borderRadius: 'var(--r-sm)' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: variance >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {Math.abs(variance) < 10 ? 'Within tolerance' : variance > 0 ? 'Sales exceed meter — verify' : 'Meter exceeds sales — verify'}
              </span>
            </div>
          </div>

          {/* RTT deduction line — real value, not a placeholder. RTT litres
              were metered (and so are already inside the gross meter total)
              but physically went back into the tank, not home with a
              customer — their value is subtracted from meter_amount_ghs
              server-side (deriveMeterAmount(), server/routes/sales.js)
              before this form's variance is computed. */}
          <div style={{ padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>RTT (Return to Tank) returned today — stock event, value already deducted from Meter amount above</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{rttLitresToday.toFixed(2)} L</span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {editingId && (
              <button className="btn btn-ghost" onClick={handleCancelEdit}>Cancel</button>
            )}
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}
              onClick={handleSave} disabled={saving}>
              <i className="ph ph-floppy-disk"></i> {saving ? 'Saving...' : editingId ? 'Update sales entry' : 'Save sales entry'}
            </button>
          </div>
        </div>

        {/* Monthly channel totals */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              {new Date(selectedMonth + '-01').toLocaleString('default', { month: 'long' })} {new Date(selectedMonth + '-01').getFullYear()} — Channel totals
            </div>
          </div>
          <table>
            <thead><tr><th>Channel</th><th>Month total (GHS)</th><th>%</th></tr></thead>
            <tbody>
              {channels.map(ch => (
                <tr key={ch.key}>
                  <td>{ch.label}</td>
                  <td className="td-calc">{monthlyTotals[ch.key].toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td>{monthlyTotal > 0 ? Math.round((monthlyTotals[ch.key] / monthlyTotal) * 100) : 0}%</td>
                </tr>
              ))}
              <tr className="tr-total">
                <td><strong>Grand total</strong></td>
                <td className="td-calc"><strong>{monthlyTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></td>
                <td><strong>100%</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Monthly history table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            {new Date(selectedMonth + '-01').toLocaleString('default', { month: 'long' })} {new Date(selectedMonth + '-01').getFullYear()} — Daily view
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Cash</th><th>Coupons</th><th>GoCard</th><th>MoMo</th>
                <th>Merka</th><th>Genset</th><th>Lubricant</th>
                <th>Total sales</th><th>Meter amt</th><th>Variance</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sales.map(s => (
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
                  <td className="td-calc">{parseFloat(s.meter_amount_ghs).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${parseFloat(s.variance_ghs) >= 0 ? 'badge-green' : 'badge-red'}`}>
                      {parseFloat(s.variance_ghs) >= 0 ? '+' : ''}{parseFloat(s.variance_ghs).toFixed(2)}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleEdit(s)}><i className="ph ph-pencil-simple"></i></button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => handleDelete(s.id, s.entry_date)}><i className="ph ph-trash"></i></button>
                    </div>
                  </td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No entries for this month</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}