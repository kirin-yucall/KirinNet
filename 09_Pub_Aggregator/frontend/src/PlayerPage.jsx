// PlayerPage.jsx — Content player page
// Sources media directly from User Nodes (no proxying through aggregator)
// No subscribe/follow — just a link to the user's profile

function PlayerPage({ contentId }) {
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/api/content/${contentId}`)
      .then((res) => {
        if (!res.ok) throw new Error('Content not found');
        return res.json();
      })
      .then((data) => {
        setItem(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Content fetch error:', err);
        setError('Content not found or failed to load');
        setLoading(false);
      });
  }, [contentId]);

  if (loading) return <div className="container"><LoadingSpinner /></div>;
  if (error) return <div className="container"><ErrorState message={error} /></div>;

  return (
    <div className="container player-container">
      {/* Media Player */}
      <div className="media-player">
        {item.type === 'video' && (
          <video
            controls
            src={item.direct_url}
            poster={item.thumbnail_url || undefined}
            preload="metadata"
          >
            Your browser does not support video playback.
          </video>
        )}
        {item.type === 'audio' && (
          <div className="audio-player">
            {item.thumbnail_url && (
              <img src={item.thumbnail_url} alt={item.title} className="audio-artwork" />
            )}
            <audio controls src={item.direct_url} preload="metadata">
              Your browser does not support audio playback.
            </audio>
          </div>
        )}
        {item.type === 'image' && (
          <img
            src={item.direct_url}
            alt={item.title}
            className="image-player"
          />
        )}
        {item.type === 'article' && (
          <div className="article-player">
            <p>The article is hosted on the User Node.</p>
            <a href={item.direct_url} target="_blank" rel="noopener noreferrer" className="article-link">
              Open article on User Node &rarr;
            </a>
          </div>
        )}
      </div>

      {/* Content Info */}
      <div className="content-meta-card">
        <h2>{item.title}</h2>

        {item.description && (
          <p className="description" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
            {item.description}
          </p>
        )}

        <div className="meta-row">
          {/* Author — just a link, no subscribe button */}
          <span className="meta-author">
            <a
              href={`#/user/${item.domain}`}
              className="author-link"
            >
              {item.nickname || item.domain}
            </a>
          </span>
          <span className="meta-type content-type">{item.type}</span>
          <span className="meta-views">{item.views || 0} views</span>
          <span className="meta-date">
            {item.created_at
              ? new Date(item.created_at).toLocaleDateString()
              : ''
            }
          </span>
        </div>

        {/* Direct link to source */}
        <div className="meta-row" style={{ marginTop: 8 }}>
          <a
            href={item.direct_url}
            target="_blank"
            rel="noopener noreferrer"
            className="direct-link"
          >
            Direct link to source &rarr;
          </a>
        </div>

        {/* File info */}
        {(item.mime_type || item.file_size) && (
          <div className="meta-row" style={{ marginTop: 8, fontSize: 12 }}>
            {item.mime_type && <span>{item.mime_type}</span>}
            {item.file_size && (
              <span>
                {' | '}
                {item.file_size > 1048576
                  ? `${(item.file_size / 1048576).toFixed(1)} MB`
                  : `${(item.file_size / 1024).toFixed(0)} KB`
                }
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

window.PlayerPage = PlayerPage;

