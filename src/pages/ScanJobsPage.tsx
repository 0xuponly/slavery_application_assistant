import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ScanResult, WorkType } from '../types'

export default function ScanJobsPage() {
  const [keywords, setKeywords] = useState('')
  const [location, setLocation] = useState('')
  const [workType, setWorkType] = useState<WorkType>('any')
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [progress, setProgress] = useState<string[]>([])
  const progressRef = useRef<string[]>([])
  const unsubRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)

  // On mount, re-attach to an in-progress or completed scan
  useEffect(() => {
    mountedRef.current = true
    api.getScanStatus().then((status) => {
      if (!mountedRef.current) return
      if (status.scanning) {
        setScanning(true)
        setProgress(status.progress)
        progressRef.current = status.progress
        const unsub = api.onScanProgress((msg: string) => {
          if (!mountedRef.current) return
          progressRef.current = [...progressRef.current, msg]
          setProgress([...progressRef.current])
        })
        unsubRef.current = unsub
      } else if (status.result) {
        setResult(status.result)
        setProgress(status.progress)
        progressRef.current = status.progress
      }
    })
    return () => {
      mountedRef.current = false
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [])

  async function handleScan() {
    setScanning(true)
    setResult(null)
    setProgress([])
    progressRef.current = []
    await api.clearScanResult()
    // Remove any stale listener before creating a new one
    unsubRef.current?.()
    unsubRef.current = null

    const unsub = api.onScanProgress((msg: string) => {
      if (!mountedRef.current) return
      progressRef.current = [...progressRef.current, msg]
      setProgress([...progressRef.current])
    })
    unsubRef.current = unsub

    try {
      const r = await api.scanBoards({
        keywords: keywords || undefined,
        location: location || undefined,
        workType
      })
      if (mountedRef.current) setResult(r)
    } catch (err) {
      if (mountedRef.current) {
        alert(`Scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    } finally {
      unsubRef.current?.()
      unsubRef.current = null
      if (mountedRef.current) setScanning(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Scan Jobs</h1>
        <p>Search job boards for postings matching your profile</p>
      </div>

      <div className="card" style={{ maxWidth: 800 }}>
        <div className="form-row">
          <div className="form-group">
            <label>Keywords</label>
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="e.g. software engineer, react (leave blank to use saved preferences)"
            />
          </div>
          <div className="form-group">
            <label>Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. London, Remote (leave blank to use saved preferences)"
            />
          </div>
        </div>
        <div className="form-group">
          <label>Work type</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['any', 'remote', 'hybrid', 'in_office'] as WorkType[]).map((wt) => (
              <button
                key={wt}
                className={`btn btn-sm ${workType === wt ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setWorkType(wt)}
              >
                {wt === 'any' ? 'Any' : wt === 'in_office' ? 'In-office' : wt.charAt(0).toUpperCase() + wt.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning boards...' : 'Scan all boards'}
          </button>
        </div>
      </div>

      {(scanning || progress.length > 0) && (
        <div className="card" style={{ maxWidth: 800, marginTop: 16 }}>
          <p style={{ marginBottom: 8 }}>
            {scanning ? 'Fetching job listings from 8 boards. This may take a few minutes...' : 'Scan completed'}
          </p>
          <div style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 320, overflowY: 'auto' }}>
            {progress.slice(-20).map((msg, i) => (
              <div key={i} style={{ color: msg.startsWith('✓') ? '#22c55e' : msg.startsWith('Scanning') ? '#3b82f6' : 'var(--text-muted)' }}>
                {msg}
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ maxWidth: 800, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>
            Found {result.totalFound} postings — added {result.totalAdded}, skipped {result.totalSkipped}
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>Board</th>
                <th>Found</th>
                <th>Added</th>
                <th>Skipped</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.boards.map((b) => (
                <tr key={b.board}>
                  <td><strong>{b.board}</strong></td>
                  <td>{b.found}</td>
                  <td style={{ color: '#22c55e', fontWeight: 600 }}>{b.added}</td>
                  <td>{b.skipped}</td>
                  <td>
                    {b.error && <span style={{ color: '#ef4444', fontSize: 12 }}>{b.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>
              {result.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
          {result.totalAdded > 0 && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
              New jobs added. Go to <strong>Job Board</strong> to view and manage them.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
