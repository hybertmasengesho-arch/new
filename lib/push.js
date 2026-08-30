// lib/push.js — thin wrapper around the web-push library, shared by the
// on-demand /api/notifications/refresh route and the daily scheduled
// function (netlify/functions/generate-recommendations.js).
//
// Requires three env vars set in Netlify (Site settings → Environment
// variables): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// (a mailto: address or site URL — required by the push spec, contact info
// for push services if something's wrong with your usage).

const webpush = require('web-push');
const { deletePushSubscription } = require('../db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — push notifications are disabled.');
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

// subs: [{ endpoint, p256dh, auth }], notification: { title, body, actionUrl }
async function sendPushToSubscriptions(subs, notification) {
  ensureConfigured();
  if (!configured || !subs || !subs.length) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.action_url || notification.actionUrl || '/dashboard.html'
  });

  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(pushSubscription, payload);
    } catch (err) {
      // 404/410 = the browser unsubscribed or the subscription expired —
      // clean it up so future sends don't keep retrying a dead endpoint.
      if (err.statusCode === 404 || err.statusCode === 410) {
        deletePushSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error('[push] send failed:', err.statusCode || err.message);
      }
    }
  }));
}

module.exports = { sendPushToSubscriptions, VAPID_PUBLIC_KEY };
