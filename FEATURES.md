# Cortex / Reasoning Hub — Feature Map

A map of what exists, organized by feature, so it's clear what each file is
for and how the pieces connect. Read `README.md` first for setup; this
document is the "where does X live" reference.

---

## 1. Accounts & Authentication

The foundation everything else builds on — every feature below assumes a
signed-in user.

| Piece | File |
|---|---|
| Register / log in / log out pages | `public/register.html`, `public/login.html`, `public/logout.html` |
| Auth API (register, login, JWT issuing) | `routes/auth.js` |
| Auth middleware (`requireAuth`, `requireAdmin`, `requireFacilitator`, `blockIfSuspended`) | `middleware/auth.js` |
| Profile & account settings | `public/account.html`, `public/profile-view.html`, `routes/profile.js` |
| "Share my whole account" with another user | `routes/account-share.js` |

---

## 2. File Sharing & Management

The primary purpose of the site — upload, store, share, and control access
to documents.

| Piece | File |
|---|---|
| My Files (upload, organize, share) | `public/files.html`, `routes/files.js` |
| Public Files (browse what others shared) | `public/public-files.html` |
| Share by code / QR / bundle | `routes/files.js` (`createFileShareCode`, `createBundleShareCode`, etc. in `db.js`) |
| "Restricted" files — request-to-view flow | `routes/files.js` (`/request-access`, `/access-requests`) |
| Document reader (view without storing) | `public/reader.html` |
| **Share Target** — receive a file shared from another app on your phone (via the native Share sheet) | `routes/share-target.js` (receives the file, unauthenticated), `routes/files.js` (`/claim-pending`, finishes filing it under your account) |

---

## 3. Notes (text editor + file attachments)

Open to every signed-in user — write notes directly, or attach a
downloadable document to one.

| Piece | File |
|---|---|
| Notes page (browse + write/manage) | `public/notes.html` |
| Notes API — create/edit/delete, ownership-checked | `routes/notes.js` |
| Attach a document or cover photo to a note | `routes/notes.js` (`/:id/document`, `/:id/cover`) |
| Request-to-view flow for restricted notes | `routes/notes.js` (`/access-requests/*`) — scoped per-owner, not just to admins |

---

## 4. Team Collaboration

| Piece | File |
|---|---|
| Teams (create, invite, join) | `public/teams.html`, `routes/teams.js` |
| Direct messages between users | `public/messages.html`, `routes/messages.js` |
| Screen sharing (WebRTC signaling) | `routes/screenshare.js` |
| Team-scoped files & notes | handled inside `routes/files.js` / `routes/notes.js` via `teamId` |

---

## 5. Study Tracks (optional add-on, not the primary focus)

| Piece | File |
|---|---|
| Matrix Accuracy / Reasoning Lab / 30-Day Prep | `public/matrix.html`, `public/reasoning.html`, `public/prep30.html` |
| Courses hub | `public/courses.html`, `routes/tracks.js` |
| Long-form content (books/exercises) | `public/content.html`, `public/exercises.html`, `routes/content.js` |
| Generic key/value progress storage | `routes/kv.js` |
| AI study-helper chat | `routes/assistant.js` |

---

## 6. Notifications — "predict your next move"

Two complementary systems: one **reacts** to things that just happened,
the other **predicts** what you'd want based on a rule-based read of your
activity. Both land in the same bell icon and can both push to your
phone's actual notification tray.

| Piece | File | What it's for |
|---|---|---|
| Real-time event notifications | `lib/notify.js` | Fired the moment something happens — a file/note access request, a decision on your request, revoked access, a teammate's upload. Called directly from `routes/files.js`, `routes/notes.js`, `routes/account-share.js`. |
| Recommendation engine | `lib/recommend.js` | Rule-based scoring across files, notes, track progress, and team activity — surfaces things like "you're 2 days from finishing X" or "you've gone quiet for a week." Not machine learning — deliberately lightweight for Netlify's free tier. |
| Push notification sending | `lib/push.js` | Thin wrapper around the `web-push` library — used by both of the above. |
| Notifications API | `routes/notifications.js` | List, mark read, and on-demand `/refresh` (computes fresh recommendations immediately rather than waiting for the daily job). |
| Push subscription API | `routes/push.js` | Subscribe/unsubscribe a device, plus the public VAPID key endpoint. |
| Daily scheduled job | `netlify/functions/generate-recommendations.js` | Runs once a day automatically (Netlify Scheduled Function) — checks every user, not just whoever happens to open the app. |
| Bell icon UI | `public/js/notifications.js` | Always-visible dropdown in the nav (see below), push opt-in flow. |
| Push display + click handling | `public/sw.js` | Service worker — shows the OS notification, handles tapping it. |
| Content-gap recommendations (admin-only) | `lib/recommend.js` (`checkContentGaps`), `routes/search-log.js`, `public/public-files.html` (logs zero-result searches) | Tells admins/facilitators what people search for and don't find. |
| Database tables | `supabase/notifications_migration.sql` | `notifications`, `push_subscriptions`, `search_misses` |

**One-time setup required** — see "Personalized notifications" section in
`README.md`: run the SQL migration, and set `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` as Netlify environment variables.

---

## 7. Navigation & Cross-Cutting UI

| Piece | File |
|---|---|
| Shared nav bar (all pages) | `public/js/nav.js` — renders the bar, injects the notification bell container, handles mobile collapse |
| Theme (light/dark) | `public/css/theme.css` |
| Toast messages | `public/js/toast.js` |
| Offline caching / push display | `public/sw.js` |
| PWA manifest (icons, Share Target declaration) | `public/site.webmanifest` |

---

## 8. Admin

| Piece | File |
|---|---|
| Admin dashboard (stats, user management, site settings) | `public/admin.html`, `routes/admin.js` |

---

## 9. Native Android App (separate project, separate repo)

Not part of this repo — see the `CortexApp` project shared earlier in this
conversation. It's a thin WebView wrapper around this site, plus a Quick
Settings tile (`ShareTileService.kt`) that Android itself doesn't allow a
website to provide on its own.

---

## Request flow reference (who gets notified, and how)

```
File/note access requested  → owner gets: in-app message + bell + push
Access request decided      → requester gets: in-app message + bell + push
Account access revoked      → affected viewer gets: bell + push
Teammate uploads a file     → other team members get: bell + push
Study track nearly done /
  stalled / unread messages /
  new shared file / gone quiet → bell + push (daily job + on-demand refresh)
Search comes up empty       → logged silently; surfaces to admins as a
                               "consider uploading this" recommendation
```
