const express = require('express');
const {
  listNotificationsForUser, countUnreadNotifications, markNotificationRead, markAllNotificationsRead,
  insertNotification, hasRecentNotification, listPushSubscriptionsForUser
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');
const { computeRecommendationsForUser } = require('../lib/recommend');
const { sendPushToSubscriptions } = require('../lib/push');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications — recent notifications + unread count for the bell.
router.get('/', async (req, res) => {
  try {
    const [items, unreadCount] = await Promise.all([
      listNotificationsForUser(req.user.id, 20),
      countUnreadNotifications(req.user.id)
    ]);
    res.json({ items, unreadCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notifications.' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    await markNotificationRead(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update notification.' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await markAllNotificationsRead(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update notifications.' });
  }
});

// POST /api/notifications/refresh — computes fresh recommendations for the
// CURRENT user right now (rather than waiting for the daily scheduled job),
// so the feature feels alive the very first time someone opens the app
// after it ships. Also pushes to any of their subscribed devices.
router.post('/refresh', blockIfSuspended, async (req, res) => {
  try {
    const recs = await computeRecommendationsForUser(req.user.id, { role: req.user.role });
    const created = [];
    for (const rec of recs) {
      const alreadySent = await hasRecentNotification(req.user.id, rec.type, 20);
      if (alreadySent) continue;
      const row = await insertNotification({
        userId: req.user.id, type: rec.type, title: rec.title, body: rec.body, actionUrl: rec.actionUrl
      });
      created.push(row);
    }
    if (created.length) {
      const subs = await listPushSubscriptionsForUser(req.user.id);
      if (subs.length) {
        // Fire-and-forget — a failed push shouldn't fail the whole request,
        // the in-app notification list already has it either way.
        sendPushToSubscriptions(subs, created[0]).catch(err => console.error('[notifications/refresh] push error:', err));
      }
    }
    const [items, unreadCount] = await Promise.all([
      listNotificationsForUser(req.user.id, 20),
      countUnreadNotifications(req.user.id)
    ]);
    res.json({ items, unreadCount, created: created.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not refresh notifications.' });
  }
});

module.exports = router;
