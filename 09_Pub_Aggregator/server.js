const express = require('express');
const path = require('path');

// Import shared crawler module (provides db connection and crawl functions)
const { crawlUserNode, crawlDomains, discoverDomains, db } = require('./crawler');

const app = express();
const PORT = process.env.PORT || 3000;

// Scheduled crawling configuration
const CRAWL_INTERVAL = parseInt(process.env.CRAWL_INTERVAL) || 3600000; // default: 1 hour
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, 'seeds.txt');
let crawlTimer = null;

// Middleware
app.use(express.json());

// API routes — content discovery and streaming only
const contentRoutes = require('./routes/content');
app.use('/api', contentRoutes);

// Scheduled crawling
async function startScheduledCrawl() {
  try {
    const domains = await discoverDomains(SEED_FILE);
    if (domains.length === 0) {
      console.log('[Scheduler] No seed domains configured. Edit seeds.txt to add domains.');
      return;
    }
    console.log(`[Scheduler] Starting scheduled crawl of ${domains.length} domains (interval: ${CRAWL_INTERVAL / 60000}m)`);
    const result = await crawlDomains(domains);
    console.log(`[Scheduler] Crawl complete: ${result.success}/${result.total} succeeded`);
  } catch (err) {
    console.error(`[Scheduler] Crawl error: ${err.message}`);
  }
}

function startCrawlScheduler() {
  startScheduledCrawl(); // Run immediately on start
  crawlTimer = setInterval(startScheduledCrawl, CRAWL_INTERVAL);
}

// Manual crawl endpoint (admin-only) — POST crawls single domain, GET crawls all
app.post('/api/crawl', async (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'domain is required' });
  }

  const success = await crawlUserNode(domain);
  if (success) {
    res.json({ message: `Crawled ${domain} successfully`, domain });
  } else {
    res.status(502).json({ error: `Failed to crawl ${domain}`, domain });
  }
});

// GET /api/crawl — crawl all seed domains (admin-only)
app.get('/api/crawl', async (_req, res) => {
  try {
    const domains = await discoverDomains(SEED_FILE);
    if (domains.length === 0) {
      return res.status(404).json({ error: 'No seed domains configured', hint: 'Edit seeds.txt' });
    }
    const result = await crawlDomains(domains);
    res.json({ ...result, domains: domains.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// SPA fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Error handling
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
});

// Start server
app.listen(PORT, () => {
  console.log(`KirinNet Aggregator running on port ${PORT}`);
  console.log(`Database: ${db.filename}`);
  startCrawlScheduler();
});

// Graceful shutdown
process.on('SIGINT', () => {
  if (crawlTimer) clearInterval(crawlTimer);
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (crawlTimer) clearInterval(crawlTimer);
  process.exit(0);
});

module.exports = { app, db };

