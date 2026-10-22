import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../lib/api'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [setup, setSetup] = useState(null)
  const [compliance, setCompliance] = useState([])
  const [todayMeter, setTodayMeter] = useState([])
  const [tankStock, setTankStock] = useState([])
  const [creditors, setCreditors] = useState([])
  const [banking, setBanking] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [today, setToday] = useState(() => new Date().toISOString().split('T')[0])

  const monthStart = today.slice(0, 7) + '-01'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const firstName = user?.name?.split(' ')[0]

  // Detect calendar day rollover while the dashboard stays mounted
  useEffect(() => {
    const syncToday = () => {
      const current = new Date().toISOString().split('T')[0]
      setToday(prev => (prev !== current ? current : prev))
    }
    syncToday()
    const id = setInterval(syncToday, 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncToday()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get('/setup'),
      api.get('/compliance'),
      api.get(`/meter?start_date=${today}&end_date=${today}`),
      api.get(`/tank-stock?start_date=${today}&end_date=${today}`),
      api.get('/creditors'),
      api.get(`/banking?start_date=${monthStart}&end_date=${today}`),
      user?.role === 'admin' ? api.get('/audit?limit=5&exclude_tables=bank_deposits') : Promise.resolve({ data: [] }),
    ]).then(([setupRes, compRes, meterRes, tankRes, credRes, bankRes, auditRes]) => {
      setSetup(setupRes.data)
      setCompliance(compRes.data)
      setTodayMeter(meterRes.data)
      setTankStock(tankRes.data)
      setCreditors(credRes.data)
      setBanking(bankRes.data)
      setAuditLog(auditRes.data)
    }).catch(console.error)
    .finally(() => setLoading(false))
  }, [today])

  // KPI calculations
  const todayRevenue = todayMeter.reduce((s, r) => s + parseFloat(r.amount_ghs || 0), 0)
  const todaySXP = todayMeter.filter(r => r.fuel_type === 'SXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
  const todayDXP = todayMeter.filter(r => r.fuel_type === 'DXP').reduce((s, r) => s + parseFloat(r.litres_sold || 0), 0)
  const todayLitres = todaySXP + todayDXP
  const margin = parseFloat(setup?.dealer_margin_per_litre || 0.30)
  const todayDealerEarnings = todayLitres * margin
  const totalCreditorBalance = creditors.reduce((s, c) => s + parseFloat(c.current_balance_ghs || 0), 0)
  const totalBanked = banking.reduce((s, b) => s + parseFloat(b.total_banked_ghs || 0), 0)

  // Tank stock
  const tankA = tankStock.find(t => t.tank_id === 'TANK_A')
  const tankB = tankStock.find(t => t.tank_id === 'TANK_B')
  const TANK_CAPACITY = 10000

  const tankBarColor = (pct) => pct > 30 ? 'var(--green)' : pct > 15 ? 'var(--amber)' : 'var(--red)'

  // Alerts
  const expiredCerts = compliance.filter(c => c.status === 'expired')
  const warningCerts = compliance.filter(c => c.status === 'warning')
  const lowTankA = tankA && (parseFloat(tankA.closing_stock_dip) / TANK_CAPACITY) < 0.20
  const lowTankB = tankB && (parseFloat(tankB.closing_stock_dip) / TANK_CAPACITY) < 0.20
  const overdueCreditors = creditors.filter(c => parseFloat(c.current_balance_ghs) > 0)

  // Activity dot color
  const activityColor = (table) => {
    if (table === 'pump_meter_readings') return 'var(--blue)'
    if (table === 'tank_stock') return 'var(--green)'
    if (table === 'credit_sales') return 'var(--amber)'
    if (table === 'compliance_certificates') return 'var(--red)'
    if (table === 'banking') return 'var(--navy-mid)'
    return 'var(--text-3)'
  }

  const activityLabel = (log) => {
    const labels = {
      pump_meter_readings: 'Meter readings updated',
      tank_stock: 'Tank stock dip entered',
      credit_sales: 'Credit sale recorded',
      banking: 'Banking entry recorded',
      expenses: 'Expense logged',
      compliance_certificates: 'Compliance certificate updated',
      shifts: 'Shift assigned',
      tanker_deliveries: 'Tanker delivery logged',
    }
    return `${labels[log.table_name] || log.table_name} — ${log.action}`
  }

  if (loading) return <div className="loading-screen">Loading dashboard...</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>{greeting}, {firstName}</h2>
          <p>{setup?.station_name} · {setup?.pump_count} pumps active · {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/meter')}>
            <i className="ph ph-plus"></i> New entry
          </button>
        </div>
      </div>

      {/* Alert strip */}
      {expiredCerts.map(cert => (
        <div key={cert.id} className="alert alert-critical" style={{ marginBottom: 6 }}>
          <div className="alert-icon"><i className="ph ph-warning"></i></div>
          <div className="alert-body">
            <div className="alert-title">{cert.certificate_name} has expired</div>
            <div className="alert-desc">Expired {cert.expiry_date}. Renew immediately to avoid operational suspension.</div>
          </div>
        </div>
      ))}
      {warningCerts.map(cert => (
        <div key={cert.id} className="alert alert-warning" style={{ marginBottom: 6 }}>
          <div className="alert-icon"><i className="ph ph-warning-circle"></i></div>
          <div className="alert-body">
            <div className="alert-title">{cert.certificate_name} expiring soon</div>
            <div className="alert-desc">Expires {cert.expiry_date}. Schedule renewal.</div>
          </div>
        </div>
      ))}
      {lowTankA && (
        <div className="alert alert-warning" style={{ marginBottom: 6 }}>
          <div className="alert-icon"><i className="ph ph-drop"></i></div>
          <div className="alert-body">
            <div className="alert-title">Tank A (SXP) low — {parseFloat(tankA.closing_stock_dip).toFixed(0)} L remaining</div>
            <div className="alert-desc">Schedule SXP delivery.</div>
          </div>
        </div>
      )}
      {lowTankB && (
        <div className="alert alert-warning" style={{ marginBottom: 6 }}>
          <div className="alert-icon"><i className="ph ph-drop"></i></div>
          <div className="alert-body">
            <div className="alert-title">Tank B (DXP) low — {parseFloat(tankB.closing_stock_dip).toFixed(0)} L remaining</div>
            <div className="alert-desc">Schedule DXP delivery.</div>
          </div>
        </div>
      )}
      {overdueCreditors.map(c => (
        <div key={c.id} className="alert alert-warning" style={{ marginBottom: 6 }}>
          <div className="alert-icon"><i className="ph ph-clock-countdown"></i></div>
          <div className="alert-body">
            <div className="alert-title">{c.name} balance GHS {parseFloat(c.current_balance_ghs).toLocaleString()} outstanding</div>
            <div className="alert-desc">Credit limit: GHS {parseFloat(c.credit_limit_ghs).toLocaleString()}</div>
          </div>
        </div>
      ))}

      {/* 5 KPI cards */}
      <div className="dash-kpi-5" style={{ gap: 16, marginBottom: 20, marginTop: 16 }}>
        <div className="kpi-card kpi-red">
          <div className="kpi-label">Today's total sales</div>
          <div className="kpi-value">GHS {todayRevenue.toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
          <div className="kpi-sub">{today}</div>
        </div>
        <div className="kpi-card kpi-blue">
          <div className="kpi-label">Litres sold today</div>
          <div className="kpi-value">{todayLitres.toFixed(2)} L</div>
          <div className="kpi-sub">SXP {todaySXP.toFixed(2)} · DXP {todayDXP.toFixed(2)}</div>
        </div>
        <div className="kpi-card kpi-amber">
          <div className="kpi-label">Creditor balance</div>
          <div className="kpi-value">GHS {totalCreditorBalance.toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
          <div className="kpi-sub warning">{overdueCreditors.length > 0 ? `${overdueCreditors[0].name}` : 'No outstanding balance'}</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-label">Banked this month</div>
          <div className="kpi-value">GHS {totalBanked.toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
          <div className="kpi-sub">{new Date().toLocaleString('default', { month: 'long' })} {new Date().getFullYear()}</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-label">Dealer earnings today ★</div>
          <div className="kpi-value">GHS {todayDealerEarnings.toFixed(2)}</div>
          <div className="kpi-sub">GHS {margin.toFixed(2)}/L · {todayLitres.toFixed(2)} L dispensed</div>
        </div>
      </div>

      <div className="grid-2 mb-16">
        {/* Tank stock card */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Tank stock levels</div>
              <div className="card-subtitle">Closing levels from last dip reading</div>
            </div>
            {(lowTankA || lowTankB) && <span className="badge badge-amber">{[lowTankA, lowTankB].filter(Boolean).length} low</span>}
          </div>

          {/* Tank A */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden', marginBottom: 10 }}>
            <div style={{ background: 'var(--navy)', color: '#fff', padding: '9px 14px', display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 500 }}>
              <span>Tank A — SXP (Super XP 91)</span><span>Feeds P1 & P2</span>
            </div>
            <div style={{ padding: 14 }}>
              {tankA ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
                    <span>Opening: {parseFloat(tankA.opening_stock).toFixed(0)} L</span>
                    <span>Sold: {parseFloat(tankA.litres_sold).toFixed(0)} L</span>
                    <span>Closing: {parseFloat(tankA.closing_stock_dip).toFixed(0)} L</span>
                  </div>
                  <div style={{ height: 10, background: 'var(--bg)', borderRadius: 10, overflow: 'hidden', marginBottom: 6 }}>
                    <div style={{ height: '100%', borderRadius: 10, width: `${Math.min(100, (parseFloat(tankA.closing_stock_dip) / TANK_CAPACITY) * 100)}%`, background: tankBarColor((parseFloat(tankA.closing_stock_dip) / TANK_CAPACITY) * 100) }}></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: tankBarColor((parseFloat(tankA.closing_stock_dip) / TANK_CAPACITY) * 100), fontWeight: 500 }}>
                      {parseFloat(tankA.closing_stock_dip).toFixed(0)} L ({Math.round((parseFloat(tankA.closing_stock_dip) / TANK_CAPACITY) * 100)}%)
                    </span>
                    <span style={{ color: 'var(--text-3)' }}>Variance: <span style={{ color: parseFloat(tankA.actual_variance) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>{parseFloat(tankA.actual_variance) >= 0 ? '+' : ''}{parseFloat(tankA.actual_variance).toFixed(2)} L</span></span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '12px 0' }}>No dip reading today — <a href="/tank-stock" style={{ color: 'var(--navy)' }}>enter now</a></div>
              )}
            </div>
          </div>

          {/* Tank B */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
            <div style={{ background: 'var(--navy)', color: '#fff', padding: '9px 14px', display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 500 }}>
              <span>Tank B — DXP (Diesel XP)</span><span>Feeds P1, P2 & P3</span>
            </div>
            <div style={{ padding: 14 }}>
              {tankB ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
                    <span>Opening: {parseFloat(tankB.opening_stock).toFixed(0)} L</span>
                    <span>Sold: {parseFloat(tankB.litres_sold).toFixed(0)} L</span>
                    <span>Closing: {parseFloat(tankB.closing_stock_dip).toFixed(0)} L</span>
                  </div>
                  <div style={{ height: 10, background: 'var(--bg)', borderRadius: 10, overflow: 'hidden', marginBottom: 6 }}>
                    <div style={{ height: '100%', borderRadius: 10, width: `${Math.min(100, (parseFloat(tankB.closing_stock_dip) / TANK_CAPACITY) * 100)}%`, background: tankBarColor((parseFloat(tankB.closing_stock_dip) / TANK_CAPACITY) * 100) }}></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: tankBarColor((parseFloat(tankB.closing_stock_dip) / TANK_CAPACITY) * 100), fontWeight: 500 }}>
                      {parseFloat(tankB.closing_stock_dip).toFixed(0)} L ({Math.round((parseFloat(tankB.closing_stock_dip) / TANK_CAPACITY) * 100)}%)
                    </span>
                    <span style={{ color: 'var(--text-3)' }}>Variance: <span style={{ color: parseFloat(tankB.actual_variance) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>{parseFloat(tankB.actual_variance) >= 0 ? '+' : ''}{parseFloat(tankB.actual_variance).toFixed(2)} L</span></span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '12px 0' }}>No dip reading today — <a href="/tank-stock" style={{ color: 'var(--navy)' }}>enter now</a></div>
              )}
            </div>
          </div>
        </div>

        {/* Recent activity */}
        <div className="card">
          <div className="card-header"><div className="card-title">Recent activity</div></div>
          {auditLog.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: 13 }}>No activity yet today</div>
          ) : (
            auditLog.map(log => (
              <div key={log.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: activityColor(log.table_name), flexShrink: 0, marginTop: 4 }}></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-1)' }}>{activityLabel(log)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                    {log.users?.name || 'System'} · {new Date(log.changed_at).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))
          )}
          {user?.role === 'admin' && (
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/audit')} style={{ fontSize: 11 }}>
                View full audit log <i className="ph ph-arrow-right"></i>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="card">
        <div className="card-header"><div className="card-title">Quick actions</div></div>
        <div className="dash-quick-actions" style={{ gap: 8 }}>
          {[
            { label: "Enter meter readings", path: '/meter', icon: 'ph-gauge', color: 'var(--blue)' },
            { label: "Record tank dip", path: '/tank-stock', icon: 'ph-cylinder', color: 'var(--navy)' },
            { label: "Enter today's sales", path: '/sales', icon: 'ph-receipt', color: 'var(--red)' },
            { label: "Record banking", path: '/banking', icon: 'ph-bank', color: 'var(--green)' },
          ].map(action => (
            <button key={action.path} className="btn btn-ghost"
              onClick={() => navigate(action.path)}
              style={{ flexDirection: 'column', gap: 6, padding: '12px 8px', height: 'auto', alignItems: 'center' }}>
              <i className={`ph ${action.icon}`} style={{ fontSize: 20, color: action.color }}></i>
              <span style={{ fontSize: 11, textAlign: 'center' }}>{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}