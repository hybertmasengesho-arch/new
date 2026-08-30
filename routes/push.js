const express = require('express');
const { savePushSubscription, deletePushSubscription } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { VAPID_PUBLIC_KEY } = require('../lib/push');

const router = express.Router();

// GET /api/push/public-key — no auth needed, just a public value the
// client's PushManager.subscribe() call requires.
router.get('/public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push notifications are not configured yet.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

router.use(requireAuth);

// POST /api/push/subscribe  { endpoint, keys: { p256dh, auth } }
router.post('/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  try {
    await savePushSubscription(req.user.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save push subscription.' });
  }
});

// POST /api/push/unsubscribe  { endpoint }
router.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
  try {
    await deletePushSubscription(endpoint);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove push subscription.' });
  }
});

module.exports = router;
