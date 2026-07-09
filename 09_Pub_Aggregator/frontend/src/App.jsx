// App.jsx — Main application with hash-based routing
// Content-only aggregator: no IM, no friends, no social graph

// --- Router ---

function useRouter() {
  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const handler = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return route;
}

// --- Header ---

function Header() {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="logo" onClick={() => { window.location.hash = '#/'; }} style={{ cursor: 'pointer' }}>
          KirinNet
        </h1>
      </div>

      <div className="header-center">
        <div className="header-search">
          <input
            type="text"
            placeholder="Search..."
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const q = e.target.value.trim();
                if (q) {
                  window.location.hash = `#/search?q=${encodeURIComponent(q)}`;
                }
              }
            }}
          />
        </div>
      </div>

      <nav className="header-nav">
        <a href="#/" className={window.location.hash === '#/' || !window.location.hash ? 'active' : ''}>Home</a>
        <a href="#/search" className={window.location.hash.startsWith('#/search') ? 'active' : ''}>Search</a>
      </nav>
    </header>
  );
}

// --- App Router ---

function App() {
  const route = useRouter();

  // Parse route
  if (route.startsWith('#/user/')) {
    const domain = route.replace('#/user/', '').split('?')[0];
    return <ProfilePage domain={domain} />;
  }
  if (route.startsWith('#/content/')) {
    const contentId = route.replace('#/content/', '').split('?')[0];
    return <PlayerPage contentId={contentId} />;
  }
  if (route.startsWith('#/search')) {
    return <SearchPage />;
  }

  // Default: home
  return <HomePage />;
}

// --- Render ---

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <>
    <Header />
    <App />
  </>
);

window.App = App;

