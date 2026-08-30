// netlify/functions/generate-recommendations.js
//
// A Netlify SCHEDULED function — Netlify itself calls this on a cron
// schedule (see exports.config below), no incoming HTTP request needed.
// This is what makes the feature proactive: without this, a user would
// only ever get a fresh recommendation when they happened to open the app
// (via POST /api/notifications/refresh in routes/notifications.js, which
// this file deliberately shares logic with).
//
// Netlify Scheduled Functions run within the same free-tier function
// limits as everything else — this one is intentionally light (rule-based
// scoring, not ML) to stay well inside them.

const { listUsers, insertNotification, hasRecentNotification, listPushSubscriptionsForUser } = require('../../db');
const { computeRecommendationsForUser } = require('../../lib/recommend');
const { sendPushToSubscriptions } = require('../../lib/push');

exports.handler = async function () {
  const users = await listUsers();
  let notified = 0;

  for (const user of users) {
    if (user.suspended) continue;
    try {
      const recs = await computeRecommendationsForUser(user.id, { role: user.role });
      const created = [];
      for (const rec of recs) {
        const alreadySent = await hasRecentNotification(user.id, rec.type, 20);
        if (alreadySent) continue;
        const row = await insertNotification({
          userId: user.id, type: rec.type, title: rec.title, body: rec.body, actionUrl: rec.actionUrl
        });
        created.push(row);
      }
      if (created.length) {
        notified++;
        const subs = await listPushSubscriptionsForUser(user.id);
        if (subs.length) {
          await sendPushToSubscriptions(subs, created[0]);
        }
      }
    } catch (e) {
      // one user's failure (malformed kv row, etc.) shouldn't stop everyone
      // else's recommendations from being generated
      console.error(`[generate-recommendations] failed for user ${user.id}:`, e.message || e);
    }
  }

  console.log(`[generate-recommendations] done — ${notified}/${users.length} users got a new notification.`);
  return { statusCode: 200, body: JSON.stringify({ usersChecked: users.length, usersNotified: notified }) };
};

// Runs once a day. Cron syntax: minute hour day month weekday — this is
// 08:00 UTC daily. Change the schedule string to adjust timing.
exports.config = {
  schedule: '0 8 * * *'
};
