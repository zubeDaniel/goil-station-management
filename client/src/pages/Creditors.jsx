import { useState, useEffect } from 'react'
import api from '../lib/api'
import { useToast } from '../components/Toast'

export default function Creditors() {
  const { showToast } = useToast()
  const [creditors, setCreditors] = useState([])
  const [creditSales, setCreditSales] = useState([])
  const [prices, setPrices] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showAddCreditor, setShowAddCreditor] = useState(false)
  const [showPayment, setShowPayment] = useState(false)
  const [showStatement, setShowStatement] = useState(false)
  const [statementPayments, setStatementPayments] = useState([])
  const [statementLoading, setStatementLoading] = useState(false)
  const [selectedCreditor, setSelectedCreditor] = useState(null)
  const [editingSaleId, setEditingSaleId] = useState(null)
  const [editingPaymentId, setEditingPaymentId] = useState(null)

  const [saleForm, setSaleForm] = useState({
    sale_date: new Date().toISOString().split('T')[0],
    creditor_id: '',
    sxp_litres: '0',
    dxp_litres: '',
    sxp_amount_ghs: '0',
    dxp_amount_ghs: ''
  })

  const [creditorForm, setCreditorForm] = useState({
    name: '', contact_name: '', contact_phone: '', credit_limit_ghs: ''
  })

  const [paymentForm, setPaymentForm] = useState({
    payment_date: new Date().toISOString().split('T')[0],
    amount_ghs: '', payment_method: '', reference: ''
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [cRes, csRes, pRes] = await Promise.all([
        api.get('/creditors'),
        api.get('/creditors/credit-sales'),
        api.get('/prices/current')
      ])
      setCreditors(cRes.data)
      setCreditSales(csRes.data)
      setPrices(pRes.data)
      // Keep whichever creditor the user already had selected. This used to
      // reset to the first creditor on every reload — including right after
      // saving a sale — so with two creditors the next sale quietly defaulted
      // to whoever sorts first, and was easy to record against the wrong one.
      // The selected object is re-resolved from the fresh list so its balance
      // updates too.
      const active = cRes.data.filter(c => c.is_active !== false)
      setSelectedCreditor(prev => cRes.data.find(c => c.id === prev?.id) || active[0] || null)
      setSaleForm(p => ({
        ...p,
        creditor_id: active.some(c => c.id === p.creditor_id) ? p.creditor_id : (active[0]?.id || '')
      }))
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveSale = async () => {
    setSaving(true)
    try {
      if (editingSaleId) {
        await api.put(`/creditors/credit-sales/${editingSaleId}`, saleForm)
        showToast('success', 'Credit sale updated', saleForm.sale_date)
        setEditingSaleId(null)
      } else {
        await api.post('/creditors/credit-sales', saleForm)
        showToast('success', 'Credit sale saved', saleForm.sale_date)
      }
      await loadData()
      setSaleForm(p => ({ ...p, sxp_litres: '0', dxp_litres: '', sxp_amount_ghs: '0', dxp_amount_ghs: '' }))
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error)
    } finally {
      setSaving(false)
    }
  }

  const handleEditSale = (row) => {
    setEditingSaleId(row.id)
    setSaleForm({
      sale_date: row.sale_date,
      creditor_id: row.creditor_id,
      sxp_litres: String(row.sxp_litres || 0),
      dxp_litres: String(row.dxp_litres || 0),
      sxp_amount_ghs: String(row.sxp_amount_ghs || 0),
      dxp_amount_ghs: String(row.dxp_amount_ghs || 0)
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleCancelEditSale = () => {
    setEditingSaleId(null)
    setSaleForm(p => ({ ...p, sxp_litres: '0', dxp_litres: '', sxp_amount_ghs: '0', dxp_amount_ghs: '' }))
  }

  // Only the creditor's single most recent transaction (sale or payment,
  // across both tables) can be reversed — enforced server-side in
  // reverse_credit_sale(). An older transaction is rejected with a clear
  // message rather than silently corrupting balance effects from anything
  // that happened after it. Surfaced here as a toast, not pre-computed
  // client-side, since that would need the full payment history loaded
  // for every creditor up front just to grey out a button.
  const handleDeleteSale = async (id, date) => {
    if (!confirm(`Reverse this credit sale (${date})? This will also reverse its effect on the creditor's balance. This cannot be undone.`)) return
    try {
      await api.delete(`/creditors/credit-sales/${id}`)
      showToast('success', 'Credit sale reversed', date)
      if (editingSaleId === id) handleCancelEditSale()
      await loadData()
    } catch (err) {
      showToast('error', 'Reversal failed', err.response?.data?.error)
    }
  }

  const handleSaveCreditor = async () => {
    setSaving(true)
    try {
      await api.post('/creditors', creditorForm)
      showToast('success', 'Creditor added', creditorForm.name)
      setShowAddCreditor(false)
      setCreditorForm({ name: '', contact_name: '', contact_phone: '', credit_limit_ghs: '' })
      await loadData()
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error)
    } finally {
      setSaving(false)
    }
  }

  const handleDeactivateCreditor = async (c) => {
    if (!confirm(`Deactivate ${c.name}? They will no longer appear when recording credit sales. Their history stays, and you can reactivate them later.`)) return
    try {
      await api.put(`/creditors/${c.id}/deactivate`)
      showToast('success', 'Creditor deactivated', c.name)
      // loadData() keeps the current selection if it still exists, and an
      // inactive creditor still "exists" — so clear it first, otherwise the
      // credit-history panel keeps showing the creditor who just left.
      setSelectedCreditor(prev => (prev?.id === c.id ? null : prev))
      await loadData()
    } catch (err) {
      showToast('error', 'Could not deactivate', err.response?.data?.error)
    }
  }

  const handleReactivateCreditor = async (c) => {
    try {
      await api.put(`/creditors/${c.id}/reactivate`)
      showToast('success', 'Creditor reactivated', c.name)
      await loadData()
    } catch (err) {
      showToast('error', 'Could not reactivate', err.response?.data?.error)
    }
  }

  const handleSavePayment = async () => {
    setSaving(true)
    try {
      if (editingPaymentId) {
        await api.put(`/creditors/payments/${editingPaymentId}`, paymentForm)
        showToast('success', 'Payment updated', `GHS ${paymentForm.amount_ghs}`)
        setEditingPaymentId(null)
      } else {
        await api.post('/creditors/payments', { ...paymentForm, creditor_id: selectedCreditor.id })
        showToast('success', 'Payment recorded', `GHS ${paymentForm.amount_ghs}`)
      }
      setShowPayment(false)
      setPaymentForm({ payment_date: new Date().toISOString().split('T')[0], amount_ghs: '', payment_method: '', reference: '' })
      await loadData()
      await refreshStatementIfOpen()
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error)
    } finally {
      setSaving(false)
    }
  }

  // Statement is a separately-loaded snapshot (statementPayments), not
  // derived live from the same state the main tables use — refresh it
  // explicitly after any payment mutation so it doesn't show stale data
  // if it's currently open for the creditor being edited.
  const refreshStatementIfOpen = async () => {
    if (!showStatement || !selectedCreditor) return
    try {
      const res = await api.get(`/creditors/payments?creditor_id=${selectedCreditor.id}`)
      setStatementPayments(res.data)
    } catch (err) {
      console.error(err)
    }
  }

  const handleEditPayment = (payment) => {
    setEditingPaymentId(payment.id)
    setPaymentForm({
      payment_date: payment.payment_date,
      amount_ghs: String(payment.amount_ghs || 0),
      payment_method: payment.payment_method || '',
      reference: payment.reference || ''
    })
    setShowStatement(false)
    setShowPayment(true)
  }

  const handleCancelEditPayment = () => {
    setEditingPaymentId(null)
    setPaymentForm({ payment_date: new Date().toISOString().split('T')[0], amount_ghs: '', payment_method: '', reference: '' })
    setShowPayment(false)
  }

  const handleDeletePayment = async (id, amount) => {
    if (!confirm(`Reverse this payment (GHS ${amount})? This will restore the creditor's exact prior balance. This cannot be undone.`)) return
    try {
      await api.delete(`/creditors/payments/${id}`)
      showToast('success', 'Payment reversed', `GHS ${amount}`)
      if (editingPaymentId === id) handleCancelEditPayment()
      await loadData()
      await refreshStatementIfOpen()
    } catch (err) {
      showToast('error', 'Reversal failed', err.response?.data?.error)
    }
  }

  const updateDXP = (litres) => {
    const price = parseFloat(prices.DXP?.price_per_litre || 0)
    const amount = (parseFloat(litres) || 0) * price
    setSaleForm(p => ({ ...p, dxp_litres: litres, dxp_amount_ghs: amount.toFixed(2) }))
  }

  const openStatement = async (creditor) => {
    setSelectedCreditor(creditor)
    setShowStatement(true)
    setStatementLoading(true)
    try {
      const res = await api.get(`/creditors/payments?creditor_id=${creditor.id}`)
      setStatementPayments(res.data)
    } catch (err) {
      showToast('error', 'Failed to load payment history', err.response?.data?.error)
      setStatementPayments([])
    } finally {
      setStatementLoading(false)
    }
  }

  // Combine credit sales (debits, increase balance owed) and payments
  // (credits, reduce balance owed) into one chronological list with a
  // running balance — this is the actual "statement" a creditor would
  // expect: everything that happened, in order, with a running total.
  const buildStatement = (creditor) => {
    const sales = creditSales
      .filter(s => s.creditor_id === creditor.id)
      .map(s => ({
        id: s.id,
        date: s.sale_date,
        type: 'sale',
        description: `Credit sale — ${parseFloat(s.sxp_litres || 0).toFixed(0)}L SXP, ${parseFloat(s.dxp_litres || 0).toFixed(0)}L DXP`,
        amount: parseFloat(s.total_amount_ghs || 0)
      }))
    const payments = statementPayments.map(p => ({
      id: p.id,
      date: p.payment_date,
      type: 'payment',
      description: `Payment${p.payment_method ? ' — ' + p.payment_method : ''}${p.reference ? ' (' + p.reference + ')' : ''}`,
      amount: -parseFloat(p.amount_ghs || 0),
      raw: p
    }))
    const combined = [...sales, ...payments].sort((a, b) => a.date.localeCompare(b.date))
    let running = 0
    return combined.map(entry => {
      running += entry.amount
      return { ...entry, balance: running }
    })
  }

  const updateSXP = (litres) => {
    const price = parseFloat(prices.SXP?.price_per_litre || 0)
    const amount = (parseFloat(litres) || 0) * price
    setSaleForm(p => ({ ...p, sxp_litres: litres, sxp_amount_ghs: amount.toFixed(2) }))
  }

  const totalSale = (parseFloat(saleForm.sxp_amount_ghs) || 0) + (parseFloat(saleForm.dxp_amount_ghs) || 0)

  // Filter credit sales for selected creditor
  const filteredSales = selectedCreditor
    ? creditSales.filter(s => s.creditor_id === selectedCreditor.id)
    : creditSales

  const monthTotal = filteredSales.reduce((s, cs) => s + parseFloat(cs.total_amount_ghs || 0), 0)

  const activeCreditors = creditors.filter(c => c.is_active !== false)
  const inactiveCreditors = creditors.filter(c => c.is_active === false)
  // A sale being edited can belong to a creditor who has since been
  // deactivated; keep them in the dropdown for that edit only.
  const saleCreditorOptions = [
    ...activeCreditors,
    ...inactiveCreditors.filter(c => c.id === saleForm.creditor_id)
  ]
  const saleCreditorName = creditors.find(c => c.id === saleForm.creditor_id)?.name

  if (loading) return <div className="loading-screen">Loading creditors...</div>

  return (
    <div>
      <div className="page-header">
        <div><h2>Creditors</h2><p>Credit sales management and payment tracking</p></div>
        <div className="page-header-actions">
          <button className="btn btn-primary" onClick={() => setShowAddCreditor(true)}>
            <i className="ph ph-plus"></i> Add creditor
          </button>
        </div>
      </div>

      {/* Add creditor modal */}
      {showAddCreditor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,28,68,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 480, boxShadow: 'var(--shadow-md)' }}>
            <div className="card-header">
              <div className="card-title">Add new creditor</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAddCreditor(false)}><i className="ph ph-x"></i></button>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Company name</label>
                <input className="form-input" value={creditorForm.name} onChange={e => setCreditorForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Merka Wood Company Ltd" />
              </div>
              <div className="form-group">
                <label className="form-label">Credit limit (GHS)</label>
                <input className="form-input" type="number" value={creditorForm.credit_limit_ghs} onChange={e => setCreditorForm(p => ({ ...p, credit_limit_ghs: e.target.value }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Contact name</label>
                <input className="form-input" value={creditorForm.contact_name} onChange={e => setCreditorForm(p => ({ ...p, contact_name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Contact phone</label>
                <input className="form-input" value={creditorForm.contact_phone} onChange={e => setCreditorForm(p => ({ ...p, contact_phone: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={() => setShowAddCreditor(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveCreditor} disabled={saving}>
                <i className="ph ph-floppy-disk"></i> {saving ? 'Saving...' : 'Save creditor'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record payment modal */}
      {showPayment && selectedCreditor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,28,68,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 440, boxShadow: 'var(--shadow-md)' }}>
            <div className="card-header">
              <div className="card-title">{editingPaymentId ? 'Editing payment' : 'Record payment'} — {selectedCreditor.name}</div>
              <button className="btn btn-ghost btn-sm" onClick={handleCancelEditPayment}><i className="ph ph-x"></i></button>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Date</label>
                <input className="form-input" type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm(p => ({ ...p, payment_date: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Amount (GHS)</label>
                <input className="form-input" type="number" value={paymentForm.amount_ghs} onChange={e => setPaymentForm(p => ({ ...p, amount_ghs: e.target.value }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Payment method</label>
                <select className="form-select" value={paymentForm.payment_method} onChange={e => setPaymentForm(p => ({ ...p, payment_method: e.target.value }))}>
                  <option value="">Select</option>
                  <option>Cash</option>
                  <option>Bank transfer</option>
                  <option>Cheque</option>
                  <option>MoMo</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Reference</label>
                <input className="form-input" value={paymentForm.reference} onChange={e => setPaymentForm(p => ({ ...p, reference: e.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={handleCancelEditPayment}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSavePayment} disabled={saving}>
                <i className="ph ph-check"></i> {saving ? 'Saving...' : editingPaymentId ? 'Update payment' : 'Record payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Statement modal */}
      {showStatement && selectedCreditor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,28,68,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 640, maxHeight: '85vh', overflowY: 'auto', boxShadow: 'var(--shadow-md)' }}>
            <div className="card-header">
              <div>
                <div className="card-title">{selectedCreditor.name} — statement</div>
                <div className="card-subtitle">{selectedCreditor.contact_name} · {selectedCreditor.contact_phone}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => window.print()}><i className="ph ph-printer"></i> Print</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowStatement(false)}><i className="ph ph-x"></i></button>
              </div>
            </div>
            {statementLoading ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-3)' }}>Loading statement...</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Description</th><th>Amount (GHS)</th><th>Balance (GHS)</th><th></th></tr>
                  </thead>
                  <tbody>
                    {buildStatement(selectedCreditor).map((entry, i) => (
                      <tr key={i}>
                        <td>{entry.date}</td>
                        <td>{entry.description}</td>
                        <td className="td-calc" style={{ color: entry.amount < 0 ? 'var(--green)' : 'var(--text-1)' }}>
                          {entry.amount < 0 ? '−' : ''}{Math.abs(entry.amount).toFixed(2)}
                        </td>
                        <td className="td-calc" style={{ fontWeight: 600 }}>{entry.balance.toFixed(2)}</td>
                        <td style={{ display: 'flex', gap: 4 }}>
                          {entry.type === 'payment' && (
                            <>
                              <button className="btn btn-ghost btn-sm" onClick={() => handleEditPayment(entry.raw)}><i className="ph ph-pencil-simple"></i></button>
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => handleDeletePayment(entry.id, entry.raw.amount_ghs)}><i className="ph ph-trash"></i></button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {buildStatement(selectedCreditor).length === 0 && (
                      <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No transactions yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid-2 mb-16">
        {/* Creditor cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {activeCreditors.map(c => (
            <div key={c.id} className="card" style={{ cursor: 'pointer', borderColor: selectedCreditor?.id === c.id ? 'var(--navy-border)' : 'var(--border)' }}
              onClick={() => { setSelectedCreditor(c); setSaleForm(p => ({ ...p, creditor_id: c.id })) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--navy)' }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{c.contact_name} · {c.contact_phone}</div>
                </div>
                <span className={`badge ${parseFloat(c.current_balance_ghs) > 0 ? 'badge-red' : 'badge-green'}`}>
                  {parseFloat(c.current_balance_ghs) > 0 ? 'Overdue' : 'Clear'}
                </span>
              </div>
              <div className="grid-3" style={{ marginBottom: 12 }}>
                <div style={{ textAlign: 'center', padding: 10, background: 'var(--red-subtle)', border: '1px solid var(--red-border)', borderRadius: 'var(--r-md)' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--red)', textTransform: 'uppercase', marginBottom: 4 }}>Balance owed</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{parseFloat(c.current_balance_ghs).toLocaleString()}</div>
                </div>
                <div style={{ textAlign: 'center', padding: 10, background: 'var(--navy-light)', border: '1px solid var(--navy-border)', borderRadius: 'var(--r-md)' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--navy)', textTransform: 'uppercase', marginBottom: 4 }}>Credit limit</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)', fontFamily: 'var(--font-mono)' }}>{parseFloat(c.credit_limit_ghs).toLocaleString()}</div>
                </div>
                <div style={{ textAlign: 'center', padding: 10, background: 'var(--amber-subtle)', border: '1px solid var(--amber-border)', borderRadius: 'var(--r-md)' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 4 }}>Available</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--amber)', fontFamily: 'var(--font-mono)' }}>{(parseFloat(c.credit_limit_ghs) - parseFloat(c.current_balance_ghs)).toLocaleString()}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); setSelectedCreditor(c); setShowPayment(true) }}>
                  <i className="ph ph-check"></i> Record payment
                </button>
                <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); openStatement(c) }}><i className="ph ph-file-text"></i> Statement</button>
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: parseFloat(c.current_balance_ghs) > 0 ? 'var(--text-3)' : 'var(--red)' }}
                  disabled={parseFloat(c.current_balance_ghs) > 0}
                  title={parseFloat(c.current_balance_ghs) > 0 ? 'Clear the balance first — record the payment, then deactivate' : 'Deactivate — for a creditor who has left'}
                  onClick={e => { e.stopPropagation(); handleDeactivateCreditor(c) }}>
                  <i className="ph ph-user-minus"></i> Deactivate
                </button>
              </div>
            </div>
          ))}
          {activeCreditors.length === 0 && (
            <div className="card" style={{ textAlign: 'center', padding: 32 }}>
              <i className="ph ph-users-three" style={{ fontSize: 32, color: 'var(--text-3)', display: 'block', marginBottom: 12 }}></i>
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No active creditors. Add one above.</div>
            </div>
          )}
          {inactiveCreditors.length > 0 && (
            <div className="card">
              <div className="card-header"><div className="card-title">Inactive creditors</div><span className="badge badge-neutral">{inactiveCreditors.length}</span></div>
              {inactiveCreditors.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--text-2)' }}>{c.name}</span>
                  {parseFloat(c.current_balance_ghs) > 0 && (
                    <>
                      <span className="badge badge-red">Owes GHS {parseFloat(c.current_balance_ghs).toLocaleString()}</span>
                      <button className="btn btn-primary btn-sm" onClick={() => { setSelectedCreditor(c); setShowPayment(true) }}><i className="ph ph-check"></i> Record payment</button>
                    </>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => openStatement(c)}><i className="ph ph-file-text"></i> Statement</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleReactivateCreditor(c)}><i className="ph ph-user-plus"></i> Reactivate</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* New credit sale form */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">{editingSaleId ? `Editing credit sale — ${saleForm.sale_date}` : 'New credit sale'}</div>
            {editingSaleId && <span className="badge badge-amber">Editing</span>}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Date</label>
              <input className="form-input" type="date" value={saleForm.sale_date} onChange={e => setSaleForm(p => ({ ...p, sale_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Creditor</label>
              <select className="form-select" value={saleForm.creditor_id} disabled={!!editingSaleId} onChange={e => setSaleForm(p => ({ ...p, creditor_id: e.target.value }))}>
                {saleCreditorOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {editingSaleId && <span className="form-hint">A sale can't be moved to another creditor by editing. To fix the creditor: reverse it, then enter it again.</span>}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">SXP litres</label>
              <input className="form-input" type="number" placeholder="0.00" value={saleForm.sxp_litres} onChange={e => updateSXP(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">DXP litres</label>
              <input className="form-input" type="number" placeholder="0.00" value={saleForm.dxp_litres} onChange={e => updateDXP(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">SXP amount (GHS)</label>
              <input className="form-input is-calc" value={saleForm.sxp_amount_ghs} readOnly />
            </div>
            <div className="form-group">
              <label className="form-label">DXP amount (GHS)</label>
              <input className="form-input is-calc" value={saleForm.dxp_amount_ghs} readOnly />
            </div>
          </div>
          <div style={{ background: 'var(--navy-light)', border: '1px solid var(--navy-border)', borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>
            <span>Total amount{saleCreditorName ? ` — ${saleCreditorName}` : ''}</span>
            <span className="td-calc">GHS {totalSale.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {editingSaleId && <button className="btn btn-ghost" onClick={handleCancelEditSale}>Cancel</button>}
            <button className="btn btn-primary" style={{ flex: editingSaleId ? 'none' : 1, justifyContent: 'center' }} onClick={handleSaveSale} disabled={saving}>
              <i className="ph ph-floppy-disk"></i> {saving ? 'Saving...' : editingSaleId ? 'Update credit sale' : 'Save credit sale'}
            </button>
          </div>
        </div>
      </div>

      {/* Credit history table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">{selectedCreditor?.name || 'All creditors'} — credit history</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>SXP (L)</th><th>DXP (L)</th><th>SXP amt</th><th>DXP amt</th><th>Total</th><th></th></tr>
            </thead>
            <tbody>
              {filteredSales.slice(0, 20).map(s => (
                <tr key={s.id}>
                  <td>{s.sale_date}</td>
                  <td className="td-calc">{parseFloat(s.sxp_litres).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(s.dxp_litres).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(s.sxp_amount_ghs) > 0 ? parseFloat(s.sxp_amount_ghs).toFixed(2) : '—'}</td>
                  <td className="td-calc">{parseFloat(s.dxp_amount_ghs).toFixed(2)}</td>
                  <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(s.total_amount_ghs).toFixed(2)}</td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleEditSale(s)}><i className="ph ph-pencil-simple"></i></button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => handleDeleteSale(s.id, s.sale_date)}><i className="ph ph-trash"></i></button>
                  </td>
                </tr>
              ))}
              {filteredSales.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No credit sales yet</td></tr>
              )}
              {filteredSales.length > 0 && (
                <tr className="tr-total">
                  <td><strong>Total</strong></td>
                  <td className="td-calc"><strong>{filteredSales.reduce((s, cs) => s + parseFloat(cs.sxp_litres || 0), 0).toFixed(2)}</strong></td>
                  <td className="td-calc"><strong>{filteredSales.reduce((s, cs) => s + parseFloat(cs.dxp_litres || 0), 0).toFixed(2)}</strong></td>
                  <td className="td-calc"><strong>{filteredSales.reduce((s, cs) => s + parseFloat(cs.sxp_amount_ghs || 0), 0).toFixed(2)}</strong></td>
                  <td className="td-calc"><strong>{filteredSales.reduce((s, cs) => s + parseFloat(cs.dxp_amount_ghs || 0), 0).toFixed(2)}</strong></td>
                  <td className="td-calc" style={{ fontWeight: 700 }}>GHS {monthTotal.toFixed(2)}</td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}