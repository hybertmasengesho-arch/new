// lib/notify.js — fire a single, real-time notification for one user: an
// in-app row (shows in the bell dropdown next page load) plus an immediate
// push if they've opted in. This is the "event happened right now" sibling
// to lib/recommend.js, which is the "predict what they'd want" sibling —
// use this one for concrete things that just occurred (a file was shared
// with them, their access was revoked, a teammate uploaded something),
// and recommend.js for inferred nudges.
//
// Deliberately never throws — a notification failing should never break
// the action that triggered it (an upload, a share, etc.).

const { insertNotification, listPushSubscriptionsForUser } = require('../db');
const { sendPushToSubscriptions } = require('./push');

async function notifyUser(userId, { type, title, body, actionUrl }) {
  try {
    const row = await insertNotification({ userId, type, title, body, actionUrl });
    const subs = await listPushSubscriptionsForUser(userId);
    if (subs.length) {
      sendPushToSubscriptions(subs, row).catch(err => console.error('[notify] push failed:', err));
    }
    return row;
  } catch (e) {
    console.error('[notify] failed for user', userId, e);
    return null;
  }
}

async function notifyUsers(userIds, payload) {
  await Promise.all([...new Set(userIds)].map(id => notifyUser(id, payload)));
}

module.exports = { notifyUser, notifyUsers };
