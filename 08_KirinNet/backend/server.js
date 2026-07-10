// KirinNet Platform — Open Content Indexer
// Storage: DuckDB (columnar) + FS
//
// Philosophy:
//   - Domain = identity. No server-side domain validation.
//   - Index by domain, resolve by DNS. DNS security = client DOH.
//   - Anyone can publish. Spoofed domains → DNS points to real node.
//   - This is a search engine, not a gatekeeper.

const express = require('express');
const cors = require('cors');
const path = require('path');

const database = require('../models/database');

const authRoutes       = require('./routes/auth');
const publishRoutes    = require('./routes/publish');
const searchRoutes     = require('./routes/search');
const profileRoutes    = require('./routes/profile');
const contentRoutes    = require('./routes/content');
const ingestionRoutes  = require('./routes/ingestion');
const marketplaceRoutes = require('./routes/marketplace');
const commentRoutes    = require('./routes/comments');
const adRoutes         = require('./routes/ads');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok', version: '0.5.0', storage: 'DuckDB+FS',
    role: 'open-indexer',
    philosophy: 'domain=identity, trust DNS, no server-side auth required',
    uptime: process.uptime()
  });
});

// API v1 — content indexing & display only, user management lives on nodes
app.use('/api/v1/auth',        authRoutes);
app.use('/api/v1',             publishRoutes);
app.use('/api/v1',             searchRoutes);
app.use('/api/v1',             profileRoutes);
app.use('/api/v1',             contentRoutes);
app.use('/api/v1',             ingestionRoutes);
app.use('/api/v1',             marketplaceRoutes);
app.use('/api/v1',             commentRoutes);
app.use('/api/v1',             adRoutes);

// API v2: DNS management
app.post('/api/v2/dns/update', (req, res) => {
  const { srv_records, txt_record, domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  if (!srv_records || !Array.isArray(srv_records)) return res.status(400).json({ error: 'missing_srv' });
  console.log(`[DNS v2] Update for ${domain}: ${srv_records.length} SRV records`);
  res.json({ status: 'ok', domain, ttl: parseInt(process.env.KIRINDNS_TTL, 10) || 300, propagation_estimate_sec: 60, updated_at: new Date().toISOString(), srv_count: srv_records.length, has_txt: !!txt_record });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
});

async function start() {
  await database.init(app);
  app.listen(PORT, () => {
    console.log('========================================================');
    console.log('  KirinNet Platform v0.5.0 — Open Indexer');
    console.log(`  Port:     ${PORT}`);
    console.log(`  Storage:  DuckDB + FS`);
    console.log(`  Policy:   domain=identity, no auth required`);
    console.log('========================================================');
  });

  process.on('SIGTERM', async () => { await database.close(); process.exit(0); });
  process.on('SIGINT',  async () => { await database.close(); process.exit(0); });
}

start().catch(err => { console.error('[Server] Fatal startup error:', err); process.exit(1); });

module.exports = { app };
