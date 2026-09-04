const express = require('express');
const { getSiteSettings } = require('../db');

const router = express.Router();

// GET /api/public/settings — no auth required. Exposes only what pages
// outside a login need: whether new signups are currently open, the
// site-wide announcement banner, and the app-download popup (each only if
// the admin has turned it on). Never leaks anything else from the admin
// settings object.
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({ registrationOpen: settings.registrationOpen, announcement: settings.announcement, appDownload: settings.appDownload });
  } catch (e) {
    console.error(e);
    // A failed read shouldn't lock anyone out — default to open, no banner.
    res.json({ registrationOpen: true, announcement: { active: false, text: '', tone: 'info' }, appDownload: { active: false, url: '' } });
  }
});

module.exports = router;
