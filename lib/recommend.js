// lib/recommend.js — the "analyze preference, predict next move" engine.
//
// Deliberately rule-based rather than machine-learning: it scores a small,
// readable set of signals pulled straight from tables the app already has
// (files, notes, kv progress, team_members, messages), and turns the
// strongest signals into plain-language nudges. This keeps it fast and
// cheap enough to run on Netlify's free tier — a real ML pipeline would
// likely hit the same function-timeout wall the AI study-helper did.
//
// To add a new kind of nudge: write a small function that returns either
// null (nothing to say) or { type, title, body, actionUrl, score }, then
// add it to the CHECKS list at the bottom. Higher score = more likely to
// win the "top 3" cut in computeRecommendationsForUser.

const {
  listFilesForOwner, listNotesForLearner, listFilesSharedWithUser,
  listUnreadMessagesForUser, listTeamsForUser,
  kvList, kvGet, listTopSearchMisses
} = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / DAY_MS;
}

/* ---------------- individual signal checks ---------------- */

// Track progress: matrix (30 per-day keys), reasoning (one 'progress' blob),
// prep30 (one 'prep30-progress' blob) — mirrors the exact shapes
// public/dashboard.html already reads, so "done" counts line up with what
// the user sees on their dashboard.
async function checkTrackProgress(userId) {
  const results = [];

  // Matrix: 30 keys named day-progress:1..30
  const matrixKeys = await kvList(userId, 'matrix', 'day-progress:');
  let matrixDone = 0, matrixLastTs = null;
  for (const key of matrixKeys) {
    const raw = await kvGet(userId, 'matrix', key);
    if (!raw) continue;
    try {
      const v = JSON.parse(raw);
      if (v && v.completed) {
        matrixDone++;
        if (v.timestamp && (!matrixLastTs || v.timestamp > matrixLastTs)) matrixLastTs = v.timestamp;
      }
    } catch (e) { /* skip malformed row */ }
  }
  results.push({ track: 'matrix', label: 'Matrix Accuracy', done: matrixDone, total: 30, lastTs: matrixLastTs, url: '/courses.html' });

  // Reasoning Lab: one blob keyed by day
  const reasoningRaw = await kvGet(userId, 'reasoning', 'progress');
  let reasoningDone = 0, reasoningLastTs = null;
  if (reasoningRaw) {
    try {
      const v = JSON.parse(reasoningRaw);
      Object.keys(v || {}).forEach(day => {
        const d = v[day];
        if (d && d.done) {
          reasoningDone++;
          if (d.ts && (!reasoningLastTs || d.ts > reasoningLastTs)) reasoningLastTs = d.ts;
        }
      });
    } catch (e) { /* skip malformed row */ }
  }
  results.push({ track: 'reasoning', label: 'the Reasoning Lab', done: reasoningDone, total: 20, lastTs: reasoningLastTs, url: '/courses.html' });

  // 30-Day Prep: one blob with a completed array + completedAt map
  const prep30Raw = await kvGet(userId, 'prep30', 'prep30-progress');
  let prep30Done = 0, prep30LastTs = null;
  if (prep30Raw) {
    try {
      const v = JSON.parse(prep30Raw);
      if (Array.isArray(v.completed)) prep30Done = v.completed.length;
      if (v.completedAt) {
        Object.values(v.completedAt).forEach(ts => { if (!prep30LastTs || ts > prep30LastTs) prep30LastTs = ts; });
      }
    } catch (e) { /* skip malformed row */ }
  }
  results.push({ track: 'prep30', label: 'the 30-Day Prep Track', done: prep30Done, total: 30, lastTs: prep30LastTs, url: '/courses.html' });

  return results;
}

// "You're close to finishing X" — only fires when genuinely close (within
// 3 days of the finish line) and there's real progress already banked.
function checkAlmostDone(tracks) {
  for (const t of tracks) {
    if (t.done > 0 && t.total - t.done > 0 && t.total - t.done <= 3) {
      return {
        type: 'track_almost_done',
        title: `${t.total - t.done} day${t.total - t.done === 1 ? '' : 's'} left on ${t.label}`,
        body: `You're ${t.done}/${t.total} through ${t.label} — finish strong.`,
        actionUrl: t.url,
        score: 90
      };
    }
  }
  return null;
}

// "You stalled on X" — was actively progressing, then went quiet for 4+
// days without finishing. Skipped entirely for tracks never started, since
// "you haven't started" isn't a stall, it's just not-yet-interested.
function checkStalledTrack(tracks) {
  let best = null;
  for (const t of tracks) {
    if (t.done === 0 || t.done >= t.total) continue;
    const idle = daysSince(t.lastTs);
    if (idle >= 4 && idle < 30) {
      const candidate = {
        type: 'track_nudge',
        title: `Pick back up on ${t.label}`,
        body: `It's been ${Math.floor(idle)} days since you last worked on ${t.label} — you're ${t.done}/${t.total} in.`,
        actionUrl: t.url,
        score: 60 + Math.min(idle, 14) // longer idle = slightly higher priority, capped
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

// Unread team messages — a straightforward, high-value signal: if someone
// hasn't seen a message from their team, that's worth surfacing regardless
// of anything else going on.
async function checkUnreadMessages(userId) {
  const unread = await listUnreadMessagesForUser(userId);
  if (!unread.length) return null;
  const fromName = unread[0].sender_name || 'your team';
  return {
    type: 'unread_messages',
    title: unread.length === 1 ? 'You have a new message' : `You have ${unread.length} new messages`,
    body: `${fromName} sent you ${unread.length === 1 ? 'a message' : 'messages'} you haven't read yet.`,
    actionUrl: '/messages.html',
    score: 85
  };
}

// A file a teammate shared that this user hasn't been notified about yet —
// surfaced only when it's recent (last 3 days), so it stays a genuine
// "new" nudge rather than resurfacing the same old shared file forever.
async function checkNewSharedFile(userId) {
  const shared = await listFilesSharedWithUser(userId);
  if (!shared || !shared.length) return null;
  const recent = shared
    .filter(f => daysSince(f.shared_at) <= 3)
    .sort((a, b) => new Date(b.shared_at) - new Date(a.shared_at))[0];
  if (!recent) return null;
  return {
    type: 'shared_file',
    title: 'New file shared with you',
    body: `"${recent.title || recent.original_name}" was shared with you recently.`,
    actionUrl: '/files.html',
    score: 70
  };
}

// Gone quiet everywhere — no file, note, or track activity in 7+ days but
// has genuine history (so a brand-new account isn't nagged on day one).
async function checkOverallQuiet(userId, tracks) {
  const [files, notes] = await Promise.all([
    listFilesForOwner(userId).catch(() => []),
    listNotesForLearner(userId).catch(() => [])
  ]);
  const ownNotes = (notes || []).filter(n => n.created_by === userId);

  const lastFile = files && files.length ? files[0].created_at : null; // listFilesForOwner already orders by recency
  const lastNote = ownNotes.length ? ownNotes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at : null;
  const lastTrack = tracks.reduce((latest, t) => (t.lastTs && (!latest || t.lastTs > latest)) ? t.lastTs : latest, null);

  const hasAnyHistory = (files && files.length) || ownNotes.length || tracks.some(t => t.done > 0);
  if (!hasAnyHistory) return null;

  const mostRecent = [lastFile, lastNote, lastTrack].filter(Boolean).sort().pop();
  const idle = daysSince(mostRecent);
  if (idle >= 7 && idle < 45) {
    return {
      type: 'overall_quiet',
      title: 'Welcome back',
      body: `It's been ${Math.floor(idle)} days since your last activity — your files and notes are right where you left them.`,
      actionUrl: '/dashboard.html',
      score: 40
    };
  }
  return null;
}

// Admin/facilitator-only: surfaces what regular users have been searching
// for and NOT finding — the "recommend a file/note that should be
// uploaded" signal. Fed by search_misses (see public/public-files.html
// logging zero-result searches to POST /api/search-log/miss).
async function checkContentGaps() {
  const gaps = await listTopSearchMisses(7, 3);
  if (!gaps.length) return null;
  const top = gaps[0];
  const summary = gaps.length === 1
    ? `"${top.query}"`
    : gaps.slice(0, 3).map(g => `"${g.query}"`).join(', ');
  return {
    type: 'content_gap',
    title: 'Users are searching for content you don\'t have yet',
    body: `In the last week, people searched for ${summary} and found nothing. Consider uploading a file or note for ${gaps.length === 1 ? 'it' : 'these'}.`,
    actionUrl: '/files.html',
    score: 55
  };
}

/* ---------------- main entry point ---------------- */

async function computeRecommendationsForUser(userId, opts) {
  const role = opts && opts.role;
  const tracks = await checkTrackProgress(userId);

  const checks = [
    Promise.resolve(checkAlmostDone(tracks)),
    Promise.resolve(checkStalledTrack(tracks)),
    checkUnreadMessages(userId),
    checkNewSharedFile(userId),
    checkOverallQuiet(userId, tracks)
  ];
  if (role === 'admin' || role === 'facilitator') {
    checks.push(checkContentGaps());
  }

  const candidates = (await Promise.all(checks)).filter(Boolean);

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3).map(({ type, title, body, actionUrl }) => ({ type, title, body, actionUrl }));
}

module.exports = { computeRecommendationsForUser };
