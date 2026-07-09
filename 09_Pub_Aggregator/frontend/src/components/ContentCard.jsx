// ContentCard.jsx — Reusable content card component
// Displays a single content item with thumbnail, title, author, and type badge

function ContentCard({ item, onClick }) {
  const typeColors = {
    video: '#1f6feb',
    audio: '#238636',
    image: '#9e6a03',
    article: '#6e40aa',
  };

  const color = typeColors[item.type] || '#1f6feb';

  return (
    <div
      className="content-card"
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <div className="content-thumb">
        {item.thumbnail_url
          ? <img src={item.thumbnail_url} alt={item.title} loading="lazy" />
          : <span style={{ fontSize: 28, color: '#484f58' }}>{item.type.toUpperCase()}</span>
        }
      </div>
      <div className="content-info">
        <h3>{item.title}</h3>
        <p>{item.description || ''}</p>
        <div className="content-meta">
          <span className="author-link" onClick={(e) => {
            e.stopPropagation();
            window.location.hash = `#/user/${item.domain}`;
          }}>
            {item.nickname || item.domain}
          </span>
          <span className="content-type" style={{ background: color }}>
            {item.type}
          </span>
        </div>
      </div>
    </div>
  );
}

// ContentGrid.jsx — Grid layout for content cards
function ContentGrid({ items, onItem }) {
  if (items.length === 0) {
    return <div className="empty">No content found</div>;
  }

  return (
    <div className="content-grid">
      {items.map((item) => (
        <ContentCard
          key={item.id}
          item={item}
          onClick={() => onItem(item)}
        />
      ))}
    </div>
  );
}

// Pagination.jsx — Simple pagination controls
function Pagination({ total, limit, offset, onOffset }) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;

  return (
    <div className="pagination">
      {offset > 0 && (
        <button onClick={() => onOffset(offset - limit)}>&larr; Prev</button>
      )}
      <span style={{ padding: '0 12px', color: '#8b949e' }}>
        Page {Math.floor(offset / limit) + 1} / {totalPages}
      </span>
      {offset + limit < total && (
        <button onClick={() => onOffset(offset + limit)}>Next &rarr;</button>
      )}
    </div>
  );
}

// LoadingSpinner.jsx
function LoadingSpinner() {
  return <div className="loading">Loading...</div>;
}

// ErrorState.jsx
function ErrorState({ message }) {
  return <div className="error-state">{message || 'Something went wrong'}</div>;
}

// Export all
window.ContentCard = ContentCard;
window.ContentGrid = ContentGrid;
window.Pagination = Pagination;
window.LoadingSpinner = LoadingSpinner;
window.ErrorState = ErrorState;

