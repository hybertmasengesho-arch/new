const express = require('express');
const { insertSearchMiss } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// POST /api/search-log/miss  { query, app }
// Fire-and-forget from the client whenever a search comes back with zero
// results (see public/public-files.html). Never fails loudly — a missed
// log entry just means one fewer data point for the content-gap
// recommendation, not something worth showing the user an error over.
router.post('/miss', async (req, res) => {
  try {
    const app = req.body.app === 'notes' ? 'notes' : 'files';
    await insertSearchMiss(req.user.id, req.body.query, app);
  } catch (e) {
    console.error('[search-log] failed:', e);
  }
  res.json({ ok: true }); // always 200 — this is telemetry, not a user-facing action
});

module.exports = router;
