// KirinNet Node — Single image, all capabilities built in.
// First run → /init.html | Otherwise → /settings.html
// All controls in settings table, runtime switches, restart support.
const express = require('express');
const path = require('path');
const database = require('./models/database');

const { router: kirinRouter, set_db: setKirinDb, requireAuth, isNodeInit } = require('./routes/kirin');
const { router: contentRouter, set_db: setContentDb } = require('./routes/content');
const { router: imRouter, set_db: setImDb } = require('./routes/im');
const { router: addressRouter, set_db: setAddrDb } = require('./routes/addresses');
const { router: pushRouter, set_db: setPushDb } = require('./routes/push');
const { router: followersRouter, set_db: setFollowersDb } = require('./routes/followers');
const { router: monetizeRouter, set_db: setMonetizeDb } = require('./routes/monetize');
const { router: adAuctionRouter, set_db: setAdAuctionDb } = require('./routes/ad-auction');
const indexer = require('./routes/indexer');
const { router: settingsRouter, set_db: setSettingsDb } = require('./routes/settings');
const { router: dnsRouter, set_db: setDnsDb } = require('./routes/dns');
const { router: cartRouter, set_db: setCartDb } = require('./routes/cart');
const { router: favoritesRouter, set_db: setFavoritesDb } = require('./routes/favorites');
const { router: historyRouter, set_db: setHistoryDb } = require('./routes/history');
const { router: draftsRouter, set_db: setDraftsDb } = require('./routes/drafts');
const { router: notificationsRouter, set_db: setNotificationsDb } = require('./routes/notifications');
const { router: ordersRouter, set_db: setOrdersDb } = require('./routes/orders');
const { router: couponsRouter, set_db: setCouponsDb } = require('./routes/coupons');
const { router: paymentMethodsRouter, set_db: setPaymentMethodsDb } = require('./routes/payment_methods');
const { router: contactsRouter, set_db: setContactsDb } = require('./routes/contacts');
const { router: imMessagesRouter, set_db: setImMessagesDb } = require('./routes/im_messages');
const { router: exploreRouter, set_db: setExploreDb } = require('./routes/explore');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/media', express.static(path.join(database.DATA_DIR, 'media')));

// Root: uninitialized → init.html, else → login page
app.get('/', async (_req, res) => {
  try {
    const ready = await isNodeInit();
    if (!ready) return res.redirect('/init.html');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  } catch { res.redirect('/init.html'); }
});

// /app — main SPA (client-side auth check via sessionStorage)
app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static files (after /media and root to avoid conflicts)
app.use(express.static(path.join(__dirname, 'public')));

// Wire all modules
setKirinDb(database);
setContentDb(database, requireAuth);
setImDb(database, requireAuth);
setAddrDb(database, requireAuth);
setPushDb(database, requireAuth);
setFollowersDb(database, requireAuth);
setMonetizeDb(database, requireAuth);
setAdAuctionDb(database, requireAuth);
indexer.set_db(database);
indexer.setRequireAuth(requireAuth);
setSettingsDb(database, requireAuth);
setDnsDb(database, requireAuth);
setCartDb(database, requireAuth);
setFavoritesDb(database, requireAuth);
setHistoryDb(database, requireAuth);
setDraftsDb(database, requireAuth);
setNotificationsDb(database, requireAuth);
setOrdersDb(database, requireAuth);
setCouponsDb(database, requireAuth);
setPaymentMethodsDb(database, requireAuth);
setContactsDb(database, requireAuth);
setImMessagesDb(database, requireAuth);
setExploreDb(database, requireAuth);

// Routes
app.use('/kirin', kirinRouter);
app.use('/api', kirinRouter); // /api/init, /api/restart, /api/ca-cert live on kirin router
app.use('/api', contentRouter);
app.use('/api', imRouter);
app.use('/api', addressRouter);
app.use('/api', pushRouter);
app.use('/api', followersRouter);
app.use('/api', monetizeRouter);
app.use('/api', adAuctionRouter);
app.use('/api', settingsRouter);
app.use('/api', indexer.router);
app.use('/api', dnsRouter);
app.use('/api', cartRouter);
app.use('/api', favoritesRouter);
app.use('/api', historyRouter);
app.use('/api', draftsRouter);
app.use('/api', notificationsRouter);
app.use('/api', ordersRouter);
app.use('/api', couponsRouter);
app.use('/api', paymentMethodsRouter);
app.use('/api', contactsRouter);
app.use('/api', imMessagesRouter);
app.use('/api', exploreRouter);

// Health
app.get('/health', async (_req, res) => {
  const indexing = await database.getSetting('public_indexing');
  const ready = await isNodeInit();
  res.json({
    status: 'ok', version: '2.6.0', storage: 'DuckDB+FS',
    initialized: ready,
    public_indexing: indexing === 'true',
    identity: (await database.getSetting('node_domain')) || process.env.DOMAIN || 'localhost',
    features: 'init,settings,content,comments,im,trade,addresses,followers,points,vip,ad-auction,indexer,admin_moderation,blacklist,dns,restart',
    timestamp: new Date().toISOString()
  });
});

// ---- Start -------------------------------------------------------------------
async function start() {
  await database.init();
  await indexer.initIndexer();

  // Read indexing toggle from DB
  let indexing = await database.getSetting('public_indexing');
  if (indexing === null) {
    const envVal = process.env.ENABLE_INDEXING || 'true';
    await database.setSetting('public_indexing', envVal);
    indexing = envVal;
  }
  const enabled = indexing === 'true';
  indexer.setIndexEnabled(enabled);

  const ready = await isNodeInit();

  app.listen(PORT, () => {
    console.log('========================================================');
    console.log('  KirinNet Node v2.6.0');
    console.log(`  Port:          ${PORT}`);
    console.log(`  Initialized:   ${ready ? 'YES' : 'NO → /init.html'}`);
    console.log(`  Public Index:  ${enabled ? 'ON' : 'OFF'}`);
    console.log(`  Storage:       DuckDB + FS`);
    console.log(`  Data:          ${database.DATA_DIR}`);
    console.log('========================================================');
  });

  process.on('SIGTERM', async () => { await database.close(); process.exit(0); });
  process.on('SIGINT',  async () => { await database.close(); process.exit(0); });
}

start().catch(err => { console.error('[Fatal]', err); process.exit(1); });

module.exports = { app };
