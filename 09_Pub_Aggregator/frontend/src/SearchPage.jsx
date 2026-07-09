// SearchPage.jsx — Dedicated search page
// Search indexed content by title/description with type filter and pagination

function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [type, setType] = useState('');
  const [limit] = useState(24);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function performSearch() {
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: query, limit, offset });
      if (type) params.set('type', type);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setResults(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auto-search when query param is present in URL
    const hash = window.location.hash;
    const match = hash.match(/^#\/search\?q=([^&]*)/);
    if (match && match[1]) {
      setQuery(decodeURIComponent(match[1]));
    }
  }, []);

  useEffect(() => {
    if (query.trim()) {
      performSearch();
    }
  }, [offset]);

  function handleSubmit(e) {
    e.preventDefault();
    setOffset(0);
    // Update URL hash to include search query
    window.location.hash = `#/search?q=${encodeURIComponent(query)}`;
    performSearch();
  }

  function handleContentClick(item) {
    window.location.hash = `#/content/${item.id}`;
  }

  return (
    <div className="container">
      {/* Search Bar */}
      <form className="search-form" onSubmit={handleSubmit}>
        <div className="search-input-wrap">
          <input
            type="text"
            className="search-input"
            placeholder="Search content across all User Nodes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button type="submit" className="search-btn">
            Search
          </button>
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All Types</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="image">Image</option>
          <option value="article">Article</option>
        </select>
      </form>

      {/* Results */}
      {loading && <LoadingSpinner />}
      {!loading && searched && (
        <>
          <div className="results-header">
            <span>{total} results for "{query}"</span>
          </div>
          <ContentGrid items={results} onItem={handleContentClick} />
          <Pagination total={total} limit={limit} offset={offset} onOffset={setOffset} />
        </>
      )}
      {!loading && !searched && (
        <div className="search-hint">
          <p>Search across all KirinNet User Nodes</p>
          <p style={{ fontSize: 13, color: '#484f58', marginTop: 8 }}>
            Enter a keyword to discover videos, articles, images, and audio.
          </p>
        </div>
      )}
    </div>
  );
}

window.SearchPage = SearchPage;

