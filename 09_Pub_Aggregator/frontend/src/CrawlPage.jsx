// CrawlPage.jsx — Admin page to manually trigger a crawl of a User Node

function CrawlPage() {
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState('');
  const [stats, setStats] = useState(null);

  async function crawl() {
    if (!domain.trim()) return;
    setStatus(`Crawling ${domain}...`);
    try {
      const res = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Success: ${data.message}`);
        setDomain('');
        // Refresh stats
        fetchStats();
      } else {
        setStatus(`Error: ${data.error || 'Crawl failed'}`);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Stats error:', err);
    }
  }

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div className="container">
      <h2 style={{ marginBottom: 16 }}>Crawl a User Node</h2>
      <div className="crawl-form">
        <input
          type="text"
          placeholder="Enter domain (e.g., alice.kirinnet.org)"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && crawl()}
        />
        <button onClick={crawl}>Crawl</button>
      </div>
      {status && (
        <div className={`status ${status.includes('Error') || status.includes('Failed') ? 'error' : 'success'}`}>
          {status}
        </div>
      )}

      {stats && (
        <div className="crawl-stats">
          <h3 style={{ marginBottom: 12 }}>Network Stats</h3>
          <div className="stats-row">
            <span className="stat-item">
              <span className="stat-value">{stats.users}</span>
              <span className="stat-label">User Nodes</span>
            </span>
            <span className="stat-item">
              <span className="stat-value">{stats.content}</span>
              <span className="stat-label">Content Items</span>
            </span>
          </div>
          {stats.content_by_type && stats.content_by_type.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginBottom: 8, fontSize: 14, color: '#8b949e' }}>By Type</h4>
              {stats.content_by_type.map((item) => (
                <div key={item.type} style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '6px 0' }}>
                  <span className="content-type" style={{ width: 70, textAlign: 'center' }}>{item.type}</span>
                  <div style={{ flex: 1, height: 8, background: '#21262d', borderRadius: 4 }}>
                    <div style={{
                      width: stats.content > 0 ? `${(item.count / stats.content * 100)}%` : '0',
                      height: '100%', background: '#1f6feb', borderRadius: 4,
                    }} />
                  </div>
                  <span style={{ color: '#8b949e', minWidth: 40, textAlign: 'right' }}>{item.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

window.CrawlPage = CrawlPage;

