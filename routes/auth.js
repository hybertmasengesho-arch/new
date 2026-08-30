const express = require('express');
const bcrypt = require('bcryptjs');
const { getUserByEmail, insertUser, updateUserRole, getSiteSettings } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

function adminEmailSet() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const willBeAdmin = adminEmailSet().includes(normalizedEmail);
  try {
    // Admin can close public registration from Admin → Settings. Emails in
    // ADMIN_EMAILS can still register even while closed, so the operator
    // is never locked out of creating the first admin account.
    if (!willBeAdmin) {
      const settings = await getSiteSettings();
      if (!settings.registrationOpen) {
        return res.status(403).json({ error: 'New sign-ups are currently closed. Contact an admin for an invite.' });
      }
    }

    const existing = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const role = willBeAdmin ? 'admin' : 'user';
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await insertUser({ email: normalizedEmail, passwordHash, name: name ? String(name).trim() : null, role });

    const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signToken(publicUser);
    res.status(201).json({ token, user: publicUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await getUserByEmail(normalizedEmail);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    // Suspended accounts are told clearly, rather than getting a confusing
    // generic error — but they ARE allowed to log in and see their data,
    // just not create/change anything (enforced by blockIfSuspended).
    if (user.suspended) {
      const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role, suspended: true };
      const token = signToken(publicUser);
      return res.json({ token, user: publicUser, notice: 'Your account has been paused by an admin.' });
    }

    const shouldBeAdmin = adminEmailSet().includes(normalizedEmail);
    if (shouldBeAdmin && user.role !== 'admin') {
      await updateUserRole(user.id, 'admin');
      user.role = 'admin';
    }

    const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signToken(publicUser);
    res.json({ token, user: publicUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not log in' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
