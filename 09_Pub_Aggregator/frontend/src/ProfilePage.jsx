// ProfilePage.jsx — User profile page (content-only, no social features)
// Displays user's nickname/avatar from KirinDNS, their content with tabs
// No "Subscribe" or "Follow" — that's handled by local IM clients

function ProfilePage({ domain }) {
  const [user, setUser] = useState(null);
  const [content, setContent] = useState([]);
  const [activeTab, setActiveTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/api/user/${domain}/content`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setUser(data.user);
        setContent(data.content || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Profile fetch error:', err);
        setError('User not found or failed to load');
        setLoading(false);
      });
  }, [domain]);

  // Filter content by active tab
  const filteredContent = activeTab === 'all'
    ? content
    : content.filter((item) => item.type === activeTab);

  // Tab definitions
  const tabs = [
    { key: 'all', label: 'All', count: content.length },
    { key: 'video', label: 'Videos', count: content.filter((c) => c.type === 'video').length },
    { key: 'article', label: 'Articles', count: content.filter((c) => c.type === 'article').length },
    { key: 'short', label: 'Shorts', count: content.filter((c) => c.type === 'video').length }, // shorts are short videos
    { key: 'audio', label: 'Audio', count: content.filter((c) => c.type === 'audio').length },
    { key: 'image', label: 'Images', count: content.filter((c) => c.type === 'image').length },
  ].filter((tab) => tab.count > 0 || tab.key === 'all');

  function handleContentClick(item) {
    window.location.hash = `#/content/${item.id}`;
  }

  if (loading) return <div className="container"><LoadingSpinner /></div>;
  if (error) return <div className="container"><ErrorState message={error} /></div>;

  return (
    <div className="container">
      {/* Profile Header */}
      <div className="profile-header">
        <div className="profile-avatar">
          {user.avatar
            ? <img src={user.avatar} alt={user.nickname} />
            : user.nickname ? user.nickname[0].toUpperCase() : '?'
          }
        </div>
        <div className="profile-details">
          <h2>{user.nickname || domain}</h2>
          <p className="bio">{user.bio || 'No bio'}</p>
          <p className="meta">
            {domain}
            {user.content_count !== undefined && ` &middot; ${user.content_count} items`}
            {user.last_crawled && ` &middot; Last seen: ${user.last_crawled}`}
          </p>
          <a
            href={`http://${domain}:${user.port || 80}`}
            target="_blank"
            rel="noopener noreferrer"
            className="node-link"
          >
            Visit User Node &rarr;
          </a>
        </div>
      </div>

      {/* Content Tabs */}
      <div className="profile-tabs">
        {tabs.map((tab) => (
          <span
            key={tab.key}
            className={`profile-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label} ({tab.count})
          </span>
        ))}
      </div>

      {/* Content Grid */}
      <ContentGrid items={filteredContent} onItem={handleContentClick} />
    </div>
  );
}

window.ProfilePage = ProfilePage;

