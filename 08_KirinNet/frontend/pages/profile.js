import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { resolveAllServices, resolveIdentity } from '../../utils/mock_aura_dns';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export default function Profile() {
  const router = useRouter();
  const { domain } = router.query;

  const [profile, setProfile] = useState(null);
  const [kirindns, setKirindns] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!domain) return;

    async function loadProfile() {
      try {
        // Resolve KirinDNS SRV records + TXT identity (mock in dev, real DoH in prod)
        const [srv, identity] = await Promise.all([
          resolveAllServices(domain),
          resolveIdentity(domain),
        ]);

        setKirindns({
          ws: srv.ws,
          http: srv.http,
          https: srv.https || null,
          identity,
        });

        // Fetch profile from API
        const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(domain)}`);
        if (res.ok) {
          const data = await res.json();
          setProfile(data);
        } else if (res.status === 404) {
          // No profile endpoint yet — fall back to search
          const searchRes = await fetch(`${API_BASE}/search?q=&limit=50`);
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            const authorContent = (searchData.results || []).filter(
              (item) => item.creator_domain === domain
            );
            setProfile({
              domain,
              content_count: authorContent.length,
              content: authorContent,
              total_views: 0,
            });
          } else {
            throw new Error('Failed to fetch profile');
          }
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [domain]);

  if (!domain) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-gray-400">No domain specified</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-gray-500">Loading profile...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <a href="/" className="text-2xl font-bold text-amber-400">KirinNet</a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto mt-8 px-4 pb-16">
        {/* Profile Card */}
        <div className="rounded-xl bg-gray-900 border border-gray-800 p-6 mb-8">
          <div className="flex items-start gap-4">
            {/* Avatar placeholder */}
            <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center text-2xl">
              {(kirindns?.identity?.nick || domain)[0].toUpperCase()}
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-bold">
                {kirindns?.identity?.nick || domain}
              </h1>
              <p className="text-gray-400 text-sm">{domain}</p>
              <p className="text-gray-500 text-sm mt-1">
                {profile?.content_count || 0} published items
                {profile?.total_views ? ` · ${profile.total_views.toLocaleString()} views` : ''}
              </p>
            </div>
          </div>

          {/* KirinDNS Info (SRV Records) */}
          {kirindns && (
            <div className="mt-4 p-4 rounded-lg bg-gray-800 border border-gray-700">
              <h3 className="text-sm font-semibold text-amber-400 mb-2">
                KirinDNS Resolution (SRV)
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <span className="text-gray-500">WS Port:</span>
                  <span className="ml-2 text-white">{kirindns.ws}</span>
                </div>
                <div>
                  <span className="text-gray-500">HTTP Port:</span>
                  <span className="ml-2 text-white">{kirindns.http}</span>
                </div>
                {kirindns.https && (
                  <div>
                    <span className="text-gray-500">HTTPS Port:</span>
                    <span className="ml-2 text-white">{kirindns.https}</span>
                  </div>
                )}
              </div>
              {kirindns.identity && (
                <div className="mt-3 text-xs text-gray-500">
                  <span>Node ID: {kirindns.identity.id}</span>
                  {kirindns.identity.ipfs && (
                    <span className="ml-3 text-amber-400">IPFS Gateway</span>
                  )}
                </div>
              )}
              {kirindns.http !== 80 && (
                <a
                  href={`http://${domain}:${kirindns.http}`}
                  className="text-xs text-amber-400 hover:underline mt-2 block"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Direct: http://{domain}:{kirindns.http}
                </a>
              )}
            </div>
          )}
        </div>

        {/* Content List */}
        <h2 className="text-lg font-semibold mb-4">Published Content</h2>

        {profile?.content && profile.content.length === 0 && (
          <p className="text-gray-500">No content published yet.</p>
        )}

        <div className="space-y-4">
          {profile?.content?.map((item) => (
            <div
              key={item.content_id}
              className="rounded-lg bg-gray-900 border border-gray-800 p-4
                         hover:border-amber-500 transition"
            >
              <div className="flex items-start gap-3">
                <span className="text-xl mt-1">
                  {item.category === 'video' && '🎬'}
                  {item.category === 'article' && '📄'}
                  {item.category === 'audio' && '🎵'}
                  {item.category === 'image' && '🖼️'}
                  {!['video','article','audio','image'].includes(item.category) && '📦'}
                </span>
                <div className="flex-1">
                  <h3 className="font-medium">{item.title}</h3>
                  {item.description && (
                    <p className="text-sm text-gray-400 mt-1">{item.description}</p>
                  )}
                  <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                    <span className="px-2 py-0.5 rounded-full bg-gray-800">
                      {item.category}
                    </span>
                    {item.tags && item.tags.length > 0 && item.tags.map(tag => (
                      <span key={tag} className="text-gray-600">#{tag}</span>
                    ))}
                    <span>{new Date(item.created_at).toLocaleDateString()}</span>
                    {item.view_count > 0 && (
                      <span>{item.view_count.toLocaleString()} views</span>
                    )}
                    <a
                      href={item.direct_url || `https://gateway.kirinnet.org/ipfs/${item.cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 hover:underline ml-auto"
                    >
                      View
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
