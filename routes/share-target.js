const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { uploadFileToStorage } = require('../db');

const router = express.Router();

// Same allow-list as the normal upload endpoint (routes/files.js) — kept in
// sync manually since this route can't reuse that router (it must stay
// unauthenticated, see note below).
const ALLOWED_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text', 'text/plain', 'text/markdown', 'text/csv', 'application/rtf'
]);
const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.odt', '.txt', '.md', '.csv', '.rtf']);
const MAX_SIZE = 5 * 1024 * 1024; // matches routes/files.js

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF, Word, ODT, RTF, TXT, MD, or CSV files are allowed.'));
  }
});

// POST /api/share-target — this is the Web Share Target action declared in
// site.webmanifest. When someone uses their phone's native "Share" menu and
// picks Cortex, Android POSTs the file here directly. There is no Bearer
// token on this request — it's a plain browser form submit triggered by the
// OS, not a fetch() call from our own front-end JS — so this route is
// intentionally NOT behind requireAuth.
//
// Instead: the file is stashed in a short-lived "_pending-shares/" spot in
// Storage under a random token, and the browser is redirected to
// /files.html, where the signed-in user's own JS (which DOES have their
// token) calls POST /api/files/claim-pending to finish filing it under
// their account. See routes/files.js for that half of the flow.
router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.redirect(303, '/files.html?pendingError=' + encodeURIComponent(err.message || 'That file could not be shared.'));
    }
    if (!req.file) {
      return res.redirect(303, '/files.html');
    }
    try {
      const token = crypto.randomBytes(16).toString('hex');
      const storagePath = `_pending-shares/${token}`;
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'application/octet-stream');
      const params = new URLSearchParams({
        pending: token,
        name: req.file.originalname || 'shared-file'
      });
      res.redirect(303, '/files.html?' + params.toString());
    } catch (e) {
      console.error('[share-target] storage error:', e);
      res.redirect(303, '/files.html?pendingError=' + encodeURIComponent('Could not receive the shared file — please try again.'));
    }
  });
});

module.exports = router;
