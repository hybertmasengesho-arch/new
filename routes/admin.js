const express = require('express');
const bcrypt = require('bcryptjs');
const {
  listUsers, updateUserRole, setUserSuspended, updateUserPassword, deleteUser, updateUserMaxFiles,
  kvCountByPrefix, kvRowsForAppKey, kvDeleteAllForUser, listAllFiles, deleteFileRecord, getFileById,
  insertMessage, getOverallRanking, listAllTeams, deleteTeam, getTeamById,
  getAdminStats, getSiteSettings, updateSiteSettings, logAdminAction, listAdminActions
} = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Every mutating admin action below calls this after the change succeeds.
// Logging never fails the request — an audit-log write hiccup shouldn't
// undo or block the actual action.
function audit(req, { action, targetType, targetId, details }) {
  logAdminAction({ adminId: req.user.id, adminEmail: req.user.email, action, targetType, targetId, details })
    .catch(e => console.error('[admin audit] failed to log action:', e));
}

// GET /api/admin/stats — quick counts for the Overview tab.
router.get('/stats', async (req, res) => {
  try {
    res.json({ stats: await getAdminStats() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// GET /api/admin/audit-log?limit=100 — recent admin activity.
router.get('/audit-log', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    res.json({ entries: await listAdminActions(limit) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load the audit log' });
  }
});

// GET /api/admin/settings — site-wide settings (registration toggle, banner).
router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await getSiteSettings() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

// POST /api/admin/settings  { registrationOpen?, announcement?: { active, text, tone } }
router.post('/settings', async (req, res) => {
  try {
    const settings = await updateSiteSettings(req.body || {});
    audit(req, { action: 'settings.update', targetType: 'site', targetId: null, details: JSON.stringify(settings) });
    res.json({ ok: true, settings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

// GET /api/admin/users — every account, plus "days completed per tracker."
router.get('/users', async (req, res) => {
  try {
    const users = await listUsers();
    const matrixByUser = await kvCountByPrefix('matrix', 'day-progress:');

    const reasoningRows = await kvRowsForAppKey('reasoning', 'progress');
    const reasoningByUser = {};
    reasoningRows.forEach(r => {
      try { reasoningByUser[r.scope_user_id] = Object.values(JSON.parse(r.value)).filter(d => d && d.done).length; }
      catch (e) { reasoningByUser[r.scope_user_id] = 0; }
    });

    const prep30Rows = await kvRowsForAppKey('prep30', 'prep30-progress');
    const prep30ByUser = {};
    prep30Rows.forEach(r => {
      try { const p = JSON.parse(r.value); prep30ByUser[r.scope_user_id] = Array.isArray(p.completed) ? p.completed.length : 0; }
      catch (e) { prep30ByUser[r.scope_user_id] = 0; }
    });

    res.json({
      users: users.map(u => ({
        ...u,
        activity: { matrix: matrixByUser[u.id] || 0, reasoning: reasoningByUser[u.id] || 0, prep30: prep30ByUser[u.id] || 0 }
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load users' });
  }
});

// POST /api/admin/users/:id/role  { role: 'admin' | 'facilitator' | 'user' }
router.post('/users/:id/role', async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'facilitator', 'user'].includes(role)) return res.status(400).json({ error: "role must be 'admin', 'facilitator', or 'user'" });
  const id = Number(req.params.id);
  if (id === req.user.id && role === 'user') {
    return res.status(400).json({ error: "You can't demote your own account — have another admin do it." });
  }
  try {
    const updated = await updateUserRole(id, role);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    audit(req, { action: 'user.role', targetType: 'user', targetId: id, details: `role -> ${role}` });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update role' });
  }
});

// POST /api/admin/users/:id/suspend  { suspended: true|false }
// Pauses an account: they can still log in and see their existing data, but
// can't save progress or upload/post files until un-suspended.
router.post('/users/:id/suspend', async (req, res) => {
  const id = Number(req.params.id);
  const suspended = !!(req.body && req.body.suspended);
  if (id === req.user.id) return res.status(400).json({ error: "You can't suspend your own account." });
  try {
    const updated = await setUserSuspended(id, suspended);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    audit(req, { action: suspended ? 'user.pause' : 'user.unpause', targetType: 'user', targetId: id });
    res.json({ ok: true, suspended });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update suspension status' });
  }
});

// POST /api/admin/users/:id/password  { newPassword: string }
// Admin directly sets a user's password — no email/reset-link flow exists,
// this is the "I forgot my password, an admin fixes it" path.
router.post('/users/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    const updated = await updateUserPassword(id, passwordHash);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    audit(req, { action: 'user.password_reset', targetType: 'user', targetId: id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not change password' });
  }
});

// DELETE /api/admin/users/:id — removes the account, their progress, and
// their uploaded files (both database rows and the actual Storage files).
router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  try {
    await deleteUser(id);
    audit(req, { action: 'user.delete', targetType: 'user', targetId: id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete user' });
  }
});

// POST /api/admin/users/:id/max-files  { maxFiles: number }
// Caps how many documents this user can save at once. Lowering it never
// deletes their existing files — it only blocks new uploads past the cap.
router.post('/users/:id/max-files', async (req, res) => {
  const id = Number(req.params.id);
  const maxFiles = Number(req.body && req.body.maxFiles);
  if (!Number.isInteger(maxFiles) || maxFiles < 0) {
    return res.status(400).json({ error: 'maxFiles must be a whole number, 0 or greater.' });
  }
  try {
    const updated = await updateUserMaxFiles(id, maxFiles);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    audit(req, { action: 'user.max_files', targetType: 'user', targetId: id, details: `limit -> ${maxFiles}` });
    res.json({ ok: true, maxFiles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update file limit' });
  }
});

// DELETE /api/admin/users/:id/documents?app=matrix — clears saved progress
// for one user (optionally scoped to one tracker app). Doesn't touch the
// account itself, only their data.
router.delete('/users/:id/documents', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await kvDeleteAllForUser(id, req.query.app || null);
    audit(req, { action: 'user.clear_progress', targetType: 'user', targetId: id, details: req.query.app ? `app=${req.query.app}` : 'all apps' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not clear user data' });
  }
});

// POST /api/admin/ranks/share — sends every user a private message telling
// them their current overall rank (the same number/order shown on the
// Ranking tab), so they don't have to be told individually. Each user's
// position also shows up as a yellow badge on their own Courses page —
// this just pushes it to them proactively as well, the same way any other
// admin message pops a toast.
router.post('/ranks/share', async (req, res) => {
  try {
    const ranking = await getOverallRanking();
    const total = ranking.length;
    await Promise.all(ranking.map(r => insertMessage({
      recipientId: r.id,
      senderId: req.user.id,
      body: `Your current rank is #${r.rank} of ${total}, based on combined progress across Matrix (${r.matrix}/30 days), the Reasoning Lab (${r.reasoning}/20 days), and the 30-Day Prep track (${r.prep30}/30 days). Keep going!`
    }).catch(() => {})));
    audit(req, { action: 'ranks.share', targetType: 'broadcast', targetId: null, details: `${total} users notified` });
    res.json({ ok: true, count: total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not share ranks' });
  }
});

// GET /api/admin/files — every uploaded file, across all users, with owner info.
router.get('/files', async (req, res) => {
  try {
    res.json({ files: await listAllFiles() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load files' });
  }
});

// DELETE /api/admin/files/:id — remove any user's uploaded document.
router.delete('/files/:id', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await deleteFileRecord(file.id, file.storage_path);
    audit(req, { action: 'file.delete', targetType: 'file', targetId: file.id, details: file.original_name });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

// POST /api/admin/users/:id/message  { body: string }
// Sends a message that pops up as a toast the next time that user loads
// any page (see GET /api/messages/unread, polled by nav.js).
router.post('/users/:id/message', async (req, res) => {
  const id = Number(req.params.id);
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  if (body.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters)' });
  try {
    await insertMessage({ recipientId: id, senderId: req.user.id, body });
    audit(req, { action: 'user.message', targetType: 'user', targetId: id });
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send message' });
  }
});

// GET /api/admin/teams — every team on the platform, with owner + member count.
router.get('/teams', async (req, res) => {
  try {
    res.json({ teams: await listAllTeams() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load teams' });
  }
});

// DELETE /api/admin/teams/:id — disband any team (members keep their own
// files; only the team-sharing link is removed, same as an owner deleting
// their own team from /teams.html).
router.delete('/teams/:id', async (req, res) => {
  try {
    const team = await getTeamById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    await deleteTeam(team.id);
    audit(req, { action: 'team.delete', targetType: 'team', targetId: team.id, details: team.name });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete team' });
  }
});

module.exports = router;
