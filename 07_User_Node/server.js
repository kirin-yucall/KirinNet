const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/app/data';

// Ensure directories exist
['media', 'db'].forEach((subdir) => {
  const dirPath = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend from public/
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files
app.use('/media', express.static(path.join(DATA_DIR, 'media')));

// Mount API routes
const auraRoutes = require('./routes/aura');
const contentRoutes = require('./routes/content');

app.use('/aura', auraRoutes);
app.use('/api', contentRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`User Node running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

module.exports = { app };
