const express = require('express');
const { getSiteSettings } = require('../db');

const router = express.Router();

// GET /api/public/settings — no auth required. Exposes only what pages
// outside a login need: whether new signups are currently open, and the
// site-wide announcement banner (if the admin has turned one on). Never
// leaks anything else from the admin settings object.
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({ registrationOpen: settings.registrationOpen, announcement: settings.announcement });
  } catch (e) {
    console.error(e);
    // A failed read shouldn't lock anyone out — default to open, no banner.
    res.json({ registrationOpen: true, announcement: { active: false, text: '', tone: 'info' } });
  }
});

module.exports = router;
