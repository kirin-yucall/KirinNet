// HomePage.jsx — Main discovery page with trending/featured content and feed
// Content-only: no friend lists, no chat, no social graph

function HomePage() {
  const [feed, setFeed] = useState([]);
  const [trending, setTrending] = useState([]);
  const [stats, setStats] = useState(null);
  const [type, setType] = useState('');
  const [sort, setSort] = useState('recent');
  const [limit] = useState(24);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Fetch feed
  async function fetchFeed() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, limit, offset });
      if (type) params.set('type', type);
      const res = await fetch(`/api/feed?${params}`);
      const data = await res.json();
      setFeed(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Feed fetch error:', err);
    } finally {
      setLoading(false);
    }
  }

  // Fetch trending (for hero section)
  async function fetchTrending() {
    try {
      const res = await fetch('/api/feed?sort=trending&limit=6');
      const data = await res.json();
      setTrending(data.items || []);
    } catch (err) {
      console.error('Trending fetch error:', err);
    }
  }

  // Fetch stats
  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Stats fetch error:', err);
    }
  }

  useEffect(() => {
    fetchFeed();
    fetchTrending();
    fetchStats();
  }, [type, sort, offset]);

  function handleContentClick(item) {
    window.location.hash = `#/content/${item.id}`;
  }

  return (
    <div className="container">
      {/* Hero: Trending Content */}
      {trending.length > 0 && (
        <section className="hero-section">
          <h2 className="section-title">
            <span style={{ marginRight: 8 }}>🔥</span> Trending Now
          </h2>
          <div className="trending-grid">
            {trending.map((item) => (
              <div
                key={item.id}
                className="trending-card"
                onClick={() => handleContentClick(item)}
                style={{ cursor: 'pointer' }}
              >
                <div className="trending-thumb">
                  {item.thumbnail_url
                    ? <img src={item.thumbnail_url} alt={item.title} loading="lazy" />
                    : <span style={{ fontSize: 32, color: '#484f58' }}>{item.type.toUpperCase()}</span>
                  }
                  <div className="views-badge">{item.views || 0} views</div>
                </div>
                <div className="trending-info">
                  <h3>{item.title}</h3>
                  <span className="author-link" onClick={(e) => {
                    e.stopPropagation();
                    window.location.hash = `#/user/${item.domain}`;
                  }}>
                    {item.nickname || item.domain}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Feed Controls */}
      <div className="feed-controls">
        <div className="feed-tabs">
          <span className={`feed-tab ${sort === 'recent' ? 'active' : ''}`} onClick={() => { setSort('recent'); setOffset(0); }}>Recent</span>
          <span className={`feed-tab ${sort === 'trending' ? 'active' : ''}`} onClick={() => { setSort('trending'); setOffset(0); }}>Trending</span>
          <span className={`feed-tab ${sort === 'popular' ? 'active' : ''}`} onClick={() => { setSort('popular'); setOffset(0); }}>Popular</span>
        </div>
        <div className="feed-filters">
          <select value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }}>
            <option value="">All Types</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="image">Image</option>
            <option value="article">Article</option>
          </select>
        </div>
      </div>

      {/* Content Feed */}
      {loading && <LoadingSpinner />}
      {!loading && <ContentGrid items={feed} onItem={handleContentClick} />}

      {/* Pagination */}
      {!loading && <Pagination total={total} limit={limit} offset={offset} onOffset={setOffset} />}

      {/* Quick Stats */}
      {stats && (
        <section className="stats-section">
          <h3 className="section-title" style={{ fontSize: 16 }}>Network Stats</h3>
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
        </section>
      )}
    </div>
  );
}

window.HomePage = HomePage;

