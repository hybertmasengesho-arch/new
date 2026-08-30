// routes/notes.js — facilitator-authored long-form notes (book-style
// content, as opposed to the MCQ "questions" in routes/content.js).
// Visibility works exactly like files: private by default, or public with
// either 'open' access (anyone signed in can read) or 'restricted' access
// (listed publicly, but a learner must request approval — the "reader"
// tier) — plus an optional team_id to scope a note to one team.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const {
  createNote, getNoteById, listNotes, listNotesForLearner, updateNote, updateNoteVisibility, deleteNote,
  updateNoteCover, clearNoteCover, updateNoteDocument, clearNoteDocument,
  requestNoteAccess, hasApprovedNoteAccess, listIncomingNoteAccessRequests, decideNoteAccessRequest,
  isAcceptedTeamMember, insertMessage, uploadFileToStorage, getFileSignedUrl
} = require('../db');
const { requireAuth, requireFacilitator, blockIfSuspended } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

function isManager(user) { return user.role === 'admin' || user.role === 'facilitator'; }

// Same read-access rule the GET /:id route below applies, pulled out so
// the cover-photo and document routes can share it (mirrors
// assertLearnerCanOpenBook in routes/content.js).
async function assertUserCanOpenNote(note, user) {
  if (isManager(user) || note.created_by === user.id) return true;
  if (note.team_id) {
    const member = await isAcceptedTeamMember(note.team_id, user.id);
    if (!member) throw Object.assign(new Error('This note is limited to a team you are not a member of.'), { status: 403 });
    return true;
  }
  if (!note.is_public) throw Object.assign(new Error('This note is private.'), { status: 403 });
  if (note.access_mode === 'restricted') {
    const approved = await hasApprovedNoteAccess(note.id, user.id);
    if (!approved) throw Object.assign(new Error('This note requires approval — request access first.'), { status: 403 });
  }
  return true;
}

/* ---------------- note photo + attached document ---------------- */

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_COVER_SIZE = 5 * 1024 * 1024;

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_MIME.has(file.mimetype) || IMAGE_EXT.has(ext)) return cb(null, true);
    cb(new Error('Photo must be a JPG, PNG, WEBP, or GIF image.'));
  }
});

const DOC_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text', 'text/plain', 'text/markdown', 'text/csv', 'application/rtf'
]);
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.odt', '.txt', '.md', '.csv', '.rtf']);
const MAX_DOC_SIZE = 5 * 1024 * 1024;

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DOC_MIME.has(file.mimetype) || DOC_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF, Word, ODT, RTF, TXT, MD, or CSV files are allowed.'));
  }
});

// POST /api/notes/:id/cover  (multipart, field "cover") — the note's
// owner, or a manager, same rule as everything else on a note now that
// note-taking is open to every signed-in user (not facilitator-only).
router.post('/:id/cover', blockIfSuspended, (req, res) => {
  coverUpload.single('cover')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image received' });
    try {
      const note = await getNoteById(req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      if (note.created_by !== req.user.id && !isManager(req.user)) {
        return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can change its photo.' });
      }
      const random = crypto.randomBytes(16).toString('hex');
      const storagePath = `note-covers/${note.id}-${random}${path.extname(req.file.originalname).toLowerCase()}`;
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'image/jpeg');
      await updateNoteCover(note.id, storagePath);
      res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || 'Could not save photo' });
    }
  });
});

// GET /api/notes/:id/cover — anyone who can open the note; redirects to a
// short-lived signed Storage URL (same pattern as book covers).
router.get('/:id/cover', async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!note.cover_storage_path) return res.status(404).json({ error: 'This note has no photo.' });
    await assertUserCanOpenNote(note, req.user);
    const url = await getFileSignedUrl(note.cover_storage_path);
    res.redirect(url);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not load photo' });
  }
});

// DELETE /api/notes/:id/cover — the note's owner, or a manager
router.delete('/:id/cover', blockIfSuspended, async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.created_by !== req.user.id && !isManager(req.user)) {
      return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can remove its photo.' });
    }
    await clearNoteCover(note.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove photo' });
  }
});

// POST /api/notes/:id/document  (multipart, field "document") — lets a
// note carry an attached file (PDF/Word/etc.) alongside its text body —
// the "note as a file, like downloadable analogue notes" feature. The
// note's owner, or a manager.
router.post('/:id/document', blockIfSuspended, (req, res) => {
  docUpload.single('document')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No document received' });
    try {
      const note = await getNoteById(req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      if (note.created_by !== req.user.id && !isManager(req.user)) {
        return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can attach a document.' });
      }
      const random = crypto.randomBytes(16).toString('hex');
      const storagePath = `note-documents/${note.id}-${random}${path.extname(req.file.originalname).toLowerCase()}`;
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'application/octet-stream');
      await updateNoteDocument(note.id, {
        storagePath, originalName: req.file.originalname,
        mimeType: req.file.mimetype || 'application/octet-stream', sizeBytes: req.file.size
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || 'Could not save document' });
    }
  });
});

// GET /api/notes/:id/document — anyone who can open the note
router.get('/:id/document', async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!note.document_storage_path) return res.status(404).json({ error: 'This note has no attached document.' });
    await assertUserCanOpenNote(note, req.user);
    const url = await getFileSignedUrl(note.document_storage_path);
    res.redirect(url);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not load document' });
  }
});

// DELETE /api/notes/:id/document — the note's owner, or a manager
router.delete('/:id/document', blockIfSuspended, async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.created_by !== req.user.id && !isManager(req.user)) {
      return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can remove its document.' });
    }
    await clearNoteDocument(note.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove document' });
  }
});

// GET /api/notes — facilitator/admin sees every note (for managing);
// a learner sees only what they're allowed to read (own/team/public).
router.get('/', async (req, res) => {
  try {
    const notes = isManager(req.user) ? await listNotes() : await listNotesForLearner(req.user.id);
    res.json({ notes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notes' });
  }
});

// GET /api/notes/:id — full note body, enforcing the same access rules as
// file downloads: owner/manager always; team member if team-scoped; open
// public always; restricted public only with an approved request.
router.get('/:id', async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const isOwner = note.created_by === req.user.id;
    if (!isOwner && !isManager(req.user)) {
      if (note.team_id) {
        const member = await isAcceptedTeamMember(note.team_id, req.user.id);
        if (!member) return res.status(403).json({ error: 'This note is limited to a team you are not a member of.' });
      } else if (!note.is_public) {
        return res.status(403).json({ error: 'This note is private.' });
      } else if (note.access_mode === 'restricted') {
        const approved = await hasApprovedNoteAccess(note.id, req.user.id);
        if (!approved) return res.status(403).json({ error: 'This note requires approval — request access first.' });
      }
    }
    res.json({ note });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load note' });
  }
});

// POST /api/notes  { title, body, isPublic?, accessMode?, teamId? } — every
// signed-in user can create their own notes now (previously
// facilitator/admin-only) — this is the "write and save notes" feature,
// with an optional attached document via POST /:id/document above.
router.post('/', blockIfSuspended, async (req, res) => {
  const title = (req.body && req.body.title ? String(req.body.title).trim() : '').slice(0, 200);
  const body = (req.body && req.body.body ? String(req.body.body) : '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (!body) return res.status(400).json({ error: 'Note body is required.' });
  if (body.length > 50000) return res.status(400).json({ error: 'Note is too long (50,000 characters max).' });
  const teamId = req.body.teamId ? Number(req.body.teamId) : null;
  if (teamId) {
    const member = await isAcceptedTeamMember(teamId, req.user.id);
    if (!member) return res.status(403).json({ error: 'You are not an accepted member of that team.' });
  }
  try {
    const note = await createNote({
      title, body, createdBy: req.user.id,
      isPublic: !!req.body.isPublic, accessMode: req.body.accessMode, teamId
    });
    res.status(201).json({ note });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create note' });
  }
});

// PATCH /api/notes/:id  { title?, body?, isPublic?, accessMode?, teamId? }
// — the note's author, or a manager. (Previously this only checked
// requireFacilitator with no per-note ownership check at all — meaning
// any facilitator could silently edit any other facilitator's note. Now
// that regular users can own notes too, that gap had to be closed.)
router.patch('/:id', blockIfSuspended, async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.created_by !== req.user.id && !isManager(req.user)) {
      return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can edit it.' });
    }
    if (req.body.title !== undefined && !String(req.body.title).trim()) return res.status(400).json({ error: 'Title is required.' });
    if (req.body.body !== undefined && String(req.body.body).length > 50000) return res.status(400).json({ error: 'Note is too long (50,000 characters max).' });
    if (req.body.title !== undefined || req.body.body !== undefined) {
      await updateNote(note.id, {
        title: req.body.title !== undefined ? String(req.body.title).trim().slice(0, 200) : undefined,
        body: req.body.body !== undefined ? String(req.body.body).trim() : undefined
      });
    }
    if (req.body.isPublic !== undefined || req.body.accessMode !== undefined || req.body.teamId !== undefined) {
      if (req.body.teamId) {
        const member = await isAcceptedTeamMember(req.body.teamId, req.user.id);
        if (!member) return res.status(403).json({ error: 'You are not an accepted member of that team.' });
      }
      await updateNoteVisibility(note.id, { isPublic: req.body.isPublic, accessMode: req.body.accessMode, teamId: req.body.teamId });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update note' });
  }
});

// DELETE /api/notes/:id — admin, or whoever created it
router.delete('/:id', blockIfSuspended, async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin or the note\u2019s author can delete it.' });
    }
    await deleteNote(note.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete note' });
  }
});

// POST /api/notes/:id/request-access — learner asks for approval on a
// restricted public note. Pops a message toast to every facilitator/admin
// isn't targeted (no single "owner" concept needed) — instead it notifies
// the note's author directly, same pattern as protected files.
router.post('/:id/request-access', blockIfSuspended, async (req, res) => {
  try {
    const note = await getNoteById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.created_by === req.user.id) return res.status(400).json({ error: 'It\u2019s your own note — just open it.' });
    if (!note.is_public || note.access_mode !== 'restricted') return res.status(400).json({ error: 'This note does not require a request.' });
    await requestNoteAccess(note.id, req.user.id);
    if (note.created_by) {
      insertMessage({
        recipientId: note.created_by, senderId: req.user.id,
        body: `${req.user.email} requested access to your note "${note.title}". Review it from Notes.`
      }).catch(() => {});
      notifyUser(note.created_by, {
        type: 'access_request',
        title: 'Someone requested a note',
        body: `${req.user.name || req.user.email} wants access to "${note.title}".`,
        actionUrl: '/notes.html'
      });
    }
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send request' });
  }
});

// GET /api/notes/access-requests/incoming — a manager sees requests
// against every note (collective content management); a regular user sees
// only requests against notes THEY created (their own restricted notes).
router.get('/access-requests/incoming', async (req, res) => {
  try {
    const requests = await listIncomingNoteAccessRequests(isManager(req.user) ? null : req.user.id);
    res.json({ requests });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load access requests' });
  }
});

// POST /api/notes/access-requests/:id/decide  { approve: boolean } — the
// note's author, or a manager. decideNoteAccessRequest returns the string
// 'forbidden' (rather than throwing) when a non-owner, non-manager tries
// to decide on someone else's note.
router.post('/access-requests/:id/decide', blockIfSuspended, async (req, res) => {
  try {
    const approve = !!(req.body && req.body.approve);
    const result = await decideNoteAccessRequest(req.params.id, approve, req.user);
    if (result === 'forbidden') return res.status(403).json({ error: 'Only the note\u2019s author (or an admin) can decide on this request.' });
    if (!result) return res.status(404).json({ error: 'Request not found' });
    insertMessage({
      recipientId: result.requesterId, senderId: req.user.id,
      body: approve ? 'Your request to view a note was approved — you can open it from Notes now.'
                    : 'Your request to view a note was declined.'
    }).catch(() => {});
    notifyUser(result.requesterId, {
      type: 'access_decision',
      title: approve ? 'Note access approved' : 'Note access declined',
      body: approve ? 'Your request to view a note was approved.' : 'Your request to view a note was declined.',
      actionUrl: '/notes.html'
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not decide on request' });
  }
});

module.exports = router;
