import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

// ---------------------------------------------------------------------------
// Category icons
// ---------------------------------------------------------------------------
const CATEGORY_ICONS = {
  video: '🎬',
  article: '📄',
  audio: '🎵',
  image: '🖼️',
};

function ContentCard({ item }) {
  return (
    <div className="rounded-lg bg-gray-900 border border-gray-800 hover:border-amber-500 transition cursor-pointer">
      {/* Thumbnail */}
      <div className="w-full h-44 bg-gray-800 rounded-t-lg flex items-center justify-center">
        <span className="text-3xl">
          {CATEGORY_ICONS[item.category] || '📦'}
        </span>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
            {item.category}
          </span>
          <Link href={`/profile/${item.creator_domain}`} className="text-sm text-amber-400 hover:underline">
            @{item.creator_domain}
          </Link>
        </div>
        <h3 className="font-medium text-white truncate">{item.title}</h3>
        {item.description && (
          <p className="text-sm text-gray-400 mt-1 line-clamp-2">{item.description}</p>
        )}
        <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
          <span>{new Date(item.created_at).toLocaleDateString()}</span>
          {item.view_count > 0 && (
            <span>{item.view_count.toLocaleString()} views</span>
          )}
          <a
            href={item.direct_url || `https://gateway.kirinnet.org/ipfs/${item.cid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-400 hover:underline"
          >
            View
          </a>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('');

  // Fetch content
  const fetchContent = useCallback(async (query = '', cat = '') => {
    setLoading(true);
    setError(null);

    try {
      let url;
      if (query || cat) {
        // Search
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (cat) params.set('category', cat);
        params.set('limit', '24');
        url = `${API_BASE}/search?${params.toString()}`;
      } else {
        // Homepage: trending
        url = `${API_BASE}/search/trending`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch content');

      const data = await res.json();
      setResults(data.results || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: trending
  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  // Search handler
  const handleSearch = (e) => {
    e.preventDefault();
    fetchContent(searchQuery.trim(), category);
  };

  // Category filter change
  const handleCategoryChange = (newCat) => {
    const nextCat = category === newCat ? '' : newCat;
    setCategory(nextCat);
    fetchContent(searchQuery.trim(), nextCat);
  };

  const categories = ['video', 'article', 'audio', 'image'];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-amber-400">KirinNet</h1>
          <nav className="space-x-6">
            <a href="/" className="hover:text-amber-400 transition">Home</a>
            <a href="/upload" className="hover:text-amber-400 transition">Upload</a>
          </nav>
        </div>
      </header>

      {/* Search + Filters */}
      <div className="max-w-2xl mx-auto mt-8 px-4">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search KirinNet..."
            className="flex-1 px-4 py-3 rounded-lg bg-gray-900 border border-gray-700
                       focus:border-amber-500 focus:outline-none text-white
                       placeholder-gray-500"
          />
          <button
            type="submit"
            className="px-6 py-3 rounded-lg bg-amber-500 hover:bg-amber-600
                       text-gray-950 font-bold transition"
          >
            Search
          </button>
        </form>

        {/* Category filters */}
        <div className="flex gap-2 mt-4 flex-wrap">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className={`px-3 py-1.5 rounded-full text-sm transition border
                ${category === cat
                  ? 'bg-amber-500/20 border-amber-500 text-amber-400'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                }`}
            >
              {CATEGORY_ICONS[cat]} {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Content Grid */}
      <main className="max-w-6xl mx-auto mt-8 px-4 pb-16">
        <h2 className="text-xl font-semibold mb-6">
          {searchQuery ? `Results for "${searchQuery}"` : category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Trending'}
        </h2>

        {loading && (
          <div className="text-center py-16 text-gray-500">Loading...</div>
        )}

        {error && (
          <div className="text-center py-16 text-red-400">Error: {error}</div>
        )}

        {!loading && !error && results.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            {searchQuery ? 'No results found.' : 'No content yet. Be the first to publish!'}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {results.map((item) => (
            <ContentCard key={item.content_id} item={item} />
          ))}
        </div>
      </main>
    </div>
  );
}
