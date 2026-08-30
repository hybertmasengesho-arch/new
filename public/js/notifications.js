// public/js/notifications.js — the "predict your next move" feature's
// front end: a bell icon in the nav with a dropdown of recent nudges, plus
// the plumbing to opt into browser push notifications.
//
// Loaded by nav.js on every signed-in page (see the bottom of nav.js).
(function () {
  function getToken() { return localStorage.getItem('rh_token'); }
  function authHeaders(extra) { return Object.assign({ Authorization: 'Bearer ' + getToken() }, extra || {}); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  var panelOpen = false;
  var lastItems = [];

  function renderPanel(items, unreadCount) {
    var panel = document.getElementById('hubNotifPanel');
    if (!panel) return;
    lastItems = items || [];

    var headHtml =
      '<div class="hub-notif-panel-head">' +
        '<span>Notifications</span>' +
        (unreadCount > 0 ? '<button class="hub-notif-mark-all" id="hubNotifMarkAll">Mark all read</button>' : '') +
      '</div>';

    if (!items || !items.length) {
      panel.innerHTML = headHtml + '<div class="hub-notif-empty">Nothing yet — check back after you\'ve used Cortex a bit.</div>';
      return;
    }

    panel.innerHTML = headHtml + items.map(function (n) {
      return '<a class="hub-notif-item' + (n.read_at ? '' : ' unread') + '" data-id="' + n.id + '" data-url="' + escapeHtml(n.action_url || '/dashboard.html') + '">' +
        '<div class="hub-notif-item-title">' + escapeHtml(n.title) + '</div>' +
        '<div class="hub-notif-item-body">' + escapeHtml(n.body) + '</div>' +
        '<div class="hub-notif-item-time">' + timeAgo(n.created_at) + '</div>' +
      '</a>';
    }).join('');

    var markAllBtn = document.getElementById('hubNotifMarkAll');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        markAllRead();
      });
    }
    panel.querySelectorAll('.hub-notif-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var url = el.getAttribute('data-url');
        markOneRead(id);
        location.href = url;
      });
    });
  }

  function updateDot(unreadCount) {
    var dot = document.getElementById('hubNotifDot');
    if (!dot) return;
    if (unreadCount > 0) {
      dot.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      dot.style.display = 'inline-block';
    } else {
      dot.style.display = 'none';
    }
  }

  async function loadNotifications() {
    var token = getToken();
    if (!token) return;
    try {
      var res = await fetch('/api/notifications', { headers: authHeaders() });
      if (!res.ok) return;
      var data = await res.json();
      renderPanel(data.items, data.unreadCount);
      updateDot(data.unreadCount);
    } catch (e) { /* silent — the bell just stays as-is */ }
  }

  // Asks the server to compute fresh recommendations right now, instead of
  // waiting for the once-a-day scheduled job. Called once per page load
  // (see init below) so the feature feels responsive immediately.
  async function refreshNotifications() {
    var token = getToken();
    if (!token) return;
    try {
      var res = await fetch('/api/notifications/refresh', { method: 'POST', headers: authHeaders() });
      if (!res.ok) return;
      var data = await res.json();
      renderPanel(data.items, data.unreadCount);
      updateDot(data.unreadCount);
    } catch (e) { /* silent */ }
  }

  async function markOneRead(id) {
    try {
      await fetch('/api/notifications/' + id + '/read', { method: 'POST', headers: authHeaders() });
      var item = lastItems.find(function (n) { return String(n.id) === String(id); });
      if (item) item.read_at = new Date().toISOString();
      var unread = lastItems.filter(function (n) { return !n.read_at; }).length;
      updateDot(unread);
    } catch (e) { /* silent */ }
  }

  async function markAllRead() {
    try {
      await fetch('/api/notifications/read-all', { method: 'POST', headers: authHeaders() });
      lastItems.forEach(function (n) { n.read_at = n.read_at || new Date().toISOString(); });
      renderPanel(lastItems, 0);
      updateDot(0);
    } catch (e) { /* silent */ }
  }

  /* ---------------- browser push opt-in ---------------- */

  function base64UrlToUint8Array(base64Url) {
    var padding = '='.repeat((4 - base64Url.length % 4) % 4);
    var base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      var permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      var reg = await navigator.serviceWorker.ready;
      var existing = await reg.pushManager.getSubscription();
      if (existing) return; // already subscribed on this device

      var keyRes = await fetch('/api/push/public-key');
      if (!keyRes.ok) return; // push not configured server-side yet — fail quietly
      var keyData = await keyRes.json();

      var sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(keyData.publicKey)
      });

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(sub.toJSON())
      });
    } catch (e) {
      console.error('[notifications] push opt-in failed:', e);
    }
  }

  /* ---------------- bell UI injection ---------------- */

  function injectBell() {
    var wrap = document.getElementById('hubNotifWrap');
    if (!wrap || wrap.dataset.built) return; // built once per page load; nav.js re-renders this container fresh on navigation
    wrap.dataset.built = '1';
    wrap.innerHTML =
      '<button class="hub-notif-btn" id="hubNotifBtn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">' +
        '🔔<span class="hub-notif-dot" id="hubNotifDot" style="display:none;"></span>' +
      '</button>' +
      '<div class="hub-notif-panel" id="hubNotifPanel"></div>';

    var btn = document.getElementById('hubNotifBtn');
    var panel = document.getElementById('hubNotifPanel');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panelOpen = !panelOpen;
      panel.classList.toggle('open', panelOpen);
      btn.setAttribute('aria-expanded', String(panelOpen));
      if (panelOpen) {
        loadNotifications();
        enablePush(); // first genuine interaction — good moment to ask for push permission
      }
    });
    document.addEventListener('click', function () {
      if (panelOpen) { panelOpen = false; panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    // Esc closes it too — a keyboard-ergonomics nicety free-riding on the
    // same handlers, since the panel has no other keyboard trap.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelOpen) { panelOpen = false; panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    });
  }

  window.HubNotifications = {
    init: function () {
      injectBell();
      loadNotifications();
      refreshNotifications();
    }
  };
})();
