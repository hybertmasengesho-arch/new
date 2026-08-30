const express = require('express');
const {
  createTrack, listAllTracks, listTracksForLearner, getTrackById, updateTrack, deleteTrack,
  getTrackProgress, updateTrackDay,
  getTeamById, isAcceptedTeamMember, broadcastToTeam
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isManager(user) { return user.role === 'admin' || user.role === 'facilitator'; }

// Who can create/edit/delete this track: any admin/facilitator, or — for a
// team-scoped track — that team's creator (the "group creator" who owns it;
// they count as an accepted member of their own team, see createTeam).
async function canManageTrack(user, track) {
  if (isManager(user)) return true;
  if (track.team_id) {
    const team = await getTeamById(track.team_id);
    return !!team && team.owner_id === user.id;
  }
  return false;
}

// Who can see/use this track: everyone if it's global (no team); otherwise
// only that team's accepted members (plus any admin/facilitator).
async function canViewTrack(user, track) {
  if (!track.team_id) return true;
  if (isManager(user)) return true;
  return isAcceptedTeamMember(track.team_id, user.id);
}

function teamInfo(track) {
  return track.teams ? { id: track.teams.id, name: track.teams.name } : (track.team_id ? { id: track.team_id, name: null } : null);
}

function summarize(track, progress) {
  let done = 0, scoreSum = 0, scoreCount = 0;
  for (let d = 1; d <= track.total_days; d++) {
    const entry = progress[d];
    if (entry && entry.completed) {
      done++;
      if (entry.score != null) { scoreSum += entry.score; scoreCount++; }
    }
  }
  return {
    id: track.id, name: track.name, description: track.description,
    themeColor: track.theme_color, totalDays: track.total_days,
    done, avgScore: scoreCount ? Math.round(scoreSum / scoreCount) : null,
    createdAt: track.created_at, team: teamInfo(track)
  };
}

function validateTrackFields(body, { partial } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = (body && body.name ? String(body.name).trim() : '').slice(0, 150);
    if (!name) throw Object.assign(new Error('Give the track a name.'), { status: 400 });
    out.name = name;
  }
  if (!partial || body.totalDays !== undefined) {
    const totalDays = Number(body && body.totalDays);
    if (!Number.isInteger(totalDays) || totalDays < 1 || totalDays > 100) {
      throw Object.assign(new Error('Number of days must be a whole number between 1 and 100.'), { status: 400 });
    }
    out.totalDays = totalDays;
  }
  if (!partial || body.themeColor !== undefined) {
    const themeColor = body && body.themeColor;
    if (themeColor && !/^#[0-9a-f]{6}$/i.test(themeColor)) {
      throw Object.assign(new Error('themeColor must be a hex value like #2F6F4F.'), { status: 400 });
    }
    if (themeColor !== undefined) out.themeColor = themeColor || undefined;
  }
  if (!partial || body.description !== undefined) {
    out.description = body.description ? String(body.description).trim().slice(0, 1000) : null;
  }
  return out;
}

// GET /api/tracks — admins/facilitators see every track (including every
// team's); everyone else sees global tracks plus any track scoped to a
// team they're an accepted member of. Each comes back with the caller's
// own progress summary against it.
router.get('/', async (req, res) => {
  try {
    const tracks = isManager(req.user) ? await listAllTracks() : await listTracksForLearner(req.user.id);
    const out = [];
    for (const t of tracks) {
      const progress = await getTrackProgress(t.id, req.user.id);
      out.push(summarize(t, progress));
    }
    res.json({ tracks: out, canManage: isManager(req.user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load tracks' });
  }
});

// POST /api/tracks  { name, description?, themeColor?, totalDays, teamId? }
// — admin/facilitator can create a global track (no teamId) or one for any
// team; a team creator (without admin/facilitator rights) can only create
// one scoped to a team they themselves created.
router.post('/', blockIfSuspended, async (req, res) => {
  try {
    let team = null;
    const teamIdRaw = req.body && req.body.teamId;
    if (teamIdRaw) {
      team = await getTeamById(teamIdRaw);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      if (!isManager(req.user) && team.owner_id !== req.user.id) {
        return res.status(403).json({ error: "Only that team's creator (or an admin/facilitator) can add a track for it." });
      }
    } else if (!isManager(req.user)) {
      return res.status(403).json({ error: 'Only an admin, facilitator, or a team creator (for their own team) can add a track.' });
    }
    const fields = validateTrackFields(req.body || {});
    const track = await createTrack({ createdBy: req.user.id, teamId: team ? team.id : null, ...fields });
    res.status(201).json({ track: summarize(track, {}) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not create track' });
  }
});

// Shared lookup — every route below acts on one specific track.
async function loadTrack(req, res, next) {
  try {
    const track = await getTrackById(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    req.track = track;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load track' });
  }
}

// GET /api/tracks/:id — full detail including the caller's own per-day
// progress, for the track's detail/day-grid view.
router.get('/:id', loadTrack, async (req, res) => {
  try {
    if (!(await canViewTrack(req.user, req.track))) {
      return res.status(403).json({ error: 'This track is limited to a team you are not a member of.' });
    }
    const progress = await getTrackProgress(req.track.id, req.user.id);
    res.json({
      track: {
        id: req.track.id, name: req.track.name, description: req.track.description,
        themeColor: req.track.theme_color, totalDays: req.track.total_days,
        progress, createdAt: req.track.created_at, team: teamInfo(req.track)
      },
      canManage: await canManageTrack(req.user, req.track)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load track' });
  }
});

// PATCH /api/tracks/:id  { name?, description?, themeColor?, totalDays? } —
// admin/facilitator, or that team's creator for a team-scoped track. Edits
// the track itself, not anyone's progress.
router.patch('/:id', blockIfSuspended, loadTrack, async (req, res) => {
  try {
    if (!(await canManageTrack(req.user, req.track))) {
      return res.status(403).json({ error: 'Only an admin, facilitator, or (for a team track) that team\'s creator can edit this.' });
    }
    const fields = validateTrackFields(req.body || {}, { partial: true });
    const updated = await updateTrack(req.track.id, fields);
    const progress = await getTrackProgress(updated.id, req.user.id);
    res.json({ track: summarize(updated, progress) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not update track' });
  }
});

// DELETE /api/tracks/:id — admin/facilitator, or that team's creator for a
// team-scoped track.
router.delete('/:id', blockIfSuspended, loadTrack, async (req, res) => {
  try {
    if (!(await canManageTrack(req.user, req.track))) {
      return res.status(403).json({ error: 'Only an admin, facilitator, or (for a team track) that team\'s creator can delete this.' });
    }
    await deleteTrack(req.track.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete track' });
  }
});

// PATCH /api/tracks/:id/day/:day  { completed?, note?, score? } — anyone
// who can see the track (see canViewTrack) and isn't suspended. The track
// itself is admin/facilitator (or team-creator) managed, but everyone
// checks off their own days independently.
router.patch('/:id/day/:day', blockIfSuspended, loadTrack, async (req, res) => {
  if (!(await canViewTrack(req.user, req.track))) {
    return res.status(403).json({ error: 'This track is limited to a team you are not a member of.' });
  }
  const day = Number(req.params.day);
  if (!Number.isInteger(day) || day < 1 || day > req.track.total_days) {
    return res.status(400).json({ error: 'Invalid day number for this track.' });
  }
  if (req.body && req.body.score !== undefined && req.body.score !== null) {
    const score = Number(req.body.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return res.status(400).json({ error: 'score must be a number between 0 and 100.' });
    }
  }
  try {
    const progress = await updateTrackDay(req.track.id, req.user.id, day, req.body || {});
    res.json({ ok: true, progress });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update that day' });
  }
});

// POST /api/tracks/:id/share  { teamId? } — post the caller's own progress
// on this track as a message to a team, so the rest of the group can see
// how they're doing without opening the tracker themselves. If the track
// itself is team-scoped that's the default target; otherwise (a global
// track) the caller must say which of their own teams to share it with.
router.post('/:id/share', blockIfSuspended, loadTrack, async (req, res) => {
  try {
    if (!(await canViewTrack(req.user, req.track))) {
      return res.status(403).json({ error: 'This track is limited to a team you are not a member of.' });
    }
    let teamId = req.track.team_id || (req.body && req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'Pick a team to share your results with.' });
    const isMember = isManager(req.user) || await isAcceptedTeamMember(teamId, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'You are not an accepted member of that team.' });

    const progress = await getTrackProgress(req.track.id, req.user.id);
    const s = summarize(req.track, progress);
    const body = `📊 ${req.user.name || req.user.email} shared their progress on "${req.track.name}": ${s.done}/${s.totalDays} days done`
      + (s.avgScore != null ? `, avg score ${s.avgScore}%.` : '.');
    const result = await broadcastToTeam(teamId, req.user.id, body);
    res.json({ ok: true, sentCount: result.sentCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not share your results' });
  }
});

module.exports = router;
