// KirinNet Platform — Content Indexer API Server
// REST API matching api_contract.md

const express = require('express');
const cors = require('cors');
const path = require('path');

const database = require('../models/database');

const authRoutes      = require('./routes/auth');
const publishRoutes = require('./routes/publish');
const searchRoutes = require('./routes/search');
const profileRoutes = require('./routes/profile');
const contentRoutes   = require('./routes/content');
const ingestionRoutes = require('./routes/ingestion');
const marketplaceRoutes = require('./routes/marketplace');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware: global
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static files (frontend pages)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check (unauthenticated)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.2.0', uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// API v1 routes
// ---------------------------------------------------------------------------

// Auth: register, login, refresh (rate-limited)
app.use ('/api/v1/auth',  authRoutes);

app.use ('/api/v1',       publishRoutes);

// Search: content discovery (global rate only)
app.use ('/api/v1',       searchRoutes);

// Profile: user profiles (global rate only)
app.use ('/api/v1',       profileRoutes);

// Content: individual content CRUD (global rate only)
app.use ('/api/v1',       contentRoutes);

app.use ('/api/v1',       ingestionRoutes);

// Marketplace: product listings
app.use ('/api/v1',       marketplaceRoutes);

// ---------------------------------------------------------------------------
// API v2: DNS management (for user nodes)
// ---------------------------------------------------------------------------
app.post('/api/v2/dns/update', (req, res) => {
  const { srv_records, txt_record, domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'missing_domain', message: 'domain is required' });
  }

  if (!srv_records || !Array.isArray(srv_records)) {
    return res.status(400).json({ error: 'missing_srv', message: 'srv_records[] is required' });
  }

  console.log(`[DNS v2] Update for ${domain}: ${srv_records.length} SRV records`);

  res.json({
    status: 'ok',
    domain,
    ttl: parseInt(process.env.KIRINDNS_TTL, 10) || 300,
    propagation_estimate_sec: 60,
    updated_at: new Date().toISOString(),
    srv_count: srv_records.length,
    has_txt: !!txt_record,
  });
});

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// Initialize database
database.init(app);

app.listen(PORT, () => {
  console.log('========================================================');
  console.log('  KirinNet Platform API');
  console.log(`  Port: ${PORT}`);
  console.log(`  Env:  ${process.env.NODE_ENV || 'development'}`);
  console.log();
  console.log('  Routes:');
  console.log('    GET    /health');
  console.log('    POST   /api/v1/auth/register | login | refresh');
  console.log('    POST   /api/v1/publish');
  console.log('    GET    /api/v1/search | /search/trending | /suggest');
  console.log('    GET    /api/v1/profile/:domain | /profile/:domain/content');
  console.log('    PUT    /api/v1/profile/:domain');
  console.log('    GET    /api/v1/content/:id');
  console.log('    DELETE /api/v1/content/:id');
  console.log('    PUT    /api/v1/content/:id/status');
  console.log('    GET    /api/v1/search/related/:id');
  console.log('    GET    /api/v1/swipe');
  console.log('    GET    /api/v1/ingestion');
    console.log('    GET    /api/v1/ingestion/stats');
    console.log('    POST   /api/v1/marketplace/index');
    console.log('    GET    /api/v1/marketplace');
    console.log('    GET    /api/v1/marketplace/trending');
    console.log('    GET    /api/v1/marketplace/by-domain/:domain');
    console.log('    GET    /api/v1/marketplace/:id');
    console.log('    PUT    /api/v1/marketplace/:id/status');
  console.log('    POST   /api/v2/dns/update');
  console.log('========================================================');
});

module.exports = app;
