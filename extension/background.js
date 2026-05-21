// ─── SyncTabs Background Service Worker ───────────────────────────────────────
// Works fully standalone (local tab persistence).
// Optionally connects to local SyncTabs Companion server for cross-browser sync.
// Optionally connects to a relay server for E2EE cross-network sync.
// Store-compliant: no mandatory external dependencies.

importScripts('e2ee.js');

// ─── Default Settings ─────────────────────────────────────────────────────────
const DEFAULTS = {
  serverUrl: 'ws://127.0.0.1:9234',
  serverEnabled: true,
  theme: 'dark',
  reconnectMs: 5000,
  syncDebounceMs: 1000,
  serverAutoDetect: true,
  browserNameOverride: '',
  // Relay settings
  relayUrl: '',
  relayEnabled: false,
  relayRoomId: '',
  relaySecretKey: '',
};
const LOOPBACK_HOST = '127.0.0.1';

const HEARTBEAT_ALARM = 'synctabs-heartbeat';
const SERVER_DETECT_ALARM = 'synctabs-server-detect';

let ws = null;
let browserId = null;
let browserName = null;
let tabSyncTimeout = null;
let isConnected = false;
let settings = { ...DEFAULTS };
let serverDetected = false;
let reconnectTimer = null;
let initDone = false;
let initPromise = null;

// ─── Relay State ──────────────────────────────────────────────────────────────
let relayWs = null;
let isRelayConnected = false;
let relayCryptoKey = null;
let relayReconnectTimer = null;

// ─── Initialization Gate ──────────────────────────────────────────────────────
// Every handler must await this before using browserId/browserName.
function waitForInit() {
  if (initDone) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      await loadSettings();
      await getOrCreateBrowserId();
      initDone = true;
      console.log(`[SyncTabs] Initialized: ${browserName} (${browserId})`);
    })();
  }
  return initPromise;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const result = await chrome.storage.local.get('synctabs_settings');
  if (result.synctabs_settings) {
    settings = { ...DEFAULTS, ...result.synctabs_settings };
  }
  settings.serverUrl = normalizeServerUrl(settings.serverUrl);
}

async function saveSettings(partial) {
  const next = { ...settings, ...partial };
  next.serverUrl = normalizeServerUrl(next.serverUrl);
  settings = next;
  await chrome.storage.local.set({ synctabs_settings: settings });
}

// ─── Browser Detection ────────────────────────────────────────────────────────
function detectBrowser() {
  const ua = navigator.userAgent;
  // Order matters: more specific brands first
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('Brave')) return 'Brave';
  if (ua.includes('Vivaldi')) return 'Vivaldi';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Chrome/')) return 'Google Chrome';
  return 'Chromium Browser';
}

function normalizeBrowserName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').slice(0, 64);
}

function getEffectiveBrowserName(detectedName) {
  const override = normalizeBrowserName(settings.browserNameOverride);
  return override || detectedName;
}

function normalizeServerUrl(value) {
  try {
    const parsed = new URL(value || DEFAULTS.serverUrl);
    const port = Number(parsed.port || '9234');
    const isAllowed =
      parsed.protocol === 'ws:' &&
      parsed.hostname === LOOPBACK_HOST &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535;

    if (!isAllowed) return DEFAULTS.serverUrl;
    return `ws://${LOOPBACK_HOST}:${port}`;
  } catch {
    return DEFAULTS.serverUrl;
  }
}

function getPermissionOrigin() {
  return `http://${LOOPBACK_HOST}/*`;
}

// ─── Unique Browser ID ────────────────────────────────────────────────────────
async function getOrCreateBrowserId() {
  const result = await chrome.storage.local.get(['synctabs_browser_id', 'synctabs_browser_name']);
  const detected = detectBrowser();
  const effectiveName = getEffectiveBrowserName(detected);

  if (result.synctabs_browser_id) {
    browserId = result.synctabs_browser_id;
    // Always re-evaluate; UA can change after browser update and user may set override
    browserName = effectiveName;
    // Persist updated name
    if (browserName !== result.synctabs_browser_name) {
      await chrome.storage.local.set({ synctabs_browser_name: browserName });
    }
    return;
  }
  // First-time install
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  browserId = `${effectiveName.replace(/\s+/g, '-').toLowerCase()}-${hex}`;
  browserName = effectiveName;
  await chrome.storage.local.set({
    synctabs_browser_id: browserId,
    synctabs_browser_name: browserName,
  });
}

async function refreshBrowserName() {
  const detected = detectBrowser();
  const effectiveName = getEffectiveBrowserName(detected);
  if (!effectiveName || effectiveName === browserName) return false;

  browserName = effectiveName;
  await chrome.storage.local.set({ synctabs_browser_name: browserName });

  if (ws && ws.readyState === WebSocket.OPEN && browserId) {
    ws.send(JSON.stringify({ type: 'register', browserId, browserName }));
    const tabs = await collectTabs();
    ws.send(JSON.stringify({ type: 'tabs-update', tabs }));
  }
  return true;
}

// ─── URL Validation ──────────────────────────────────────────────────────────
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
}

// ─── Tab Collection ───────────────────────────────────────────────────────────
async function collectTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    
    // Build a window incognito map for labeling
    const windowIncognito = {};
    const windowIds = [...new Set(tabs.map(t => t.windowId))];
    for (const wid of windowIds) {
      try {
        const win = await chrome.windows.get(wid);
        windowIncognito[wid] = win.incognito;
      } catch { windowIncognito[wid] = false; }
    }

    // Build tab groups lookup
    let groupsLookup = {};
    if (typeof chrome.tabGroups !== 'undefined') {
      try {
        const groups = await chrome.tabGroups.query({});
        for (const g of groups) {
          groupsLookup[g.id] = {
            title: g.title || '',
            color: g.color || '',
            collapsed: g.collapsed || false,
          };
        }
      } catch (err) {
        console.warn('[SyncTabs] Failed to query tab groups:', err);
      }
    }

    return tabs.map(t => {
      const hasGroup = t.groupId !== undefined && t.groupId !== -1 && groupsLookup[t.groupId];
      return {
        id: t.id,
        url: t.url || t.pendingUrl || '',
        title: t.title || 'New Tab',
        favIconUrl: t.favIconUrl || '',
        pinned: t.pinned,
        windowId: t.windowId,
        active: t.active,
        lastAccessed: t.lastAccessed || Date.now(),
        incognito: windowIncognito[t.windowId] || false,
        groupId: t.groupId !== undefined ? t.groupId : -1,
        groupTitle: hasGroup ? groupsLookup[t.groupId].title : '',
        groupColor: hasGroup ? groupsLookup[t.groupId].color : '',
        index: t.index,
        discarded: !!t.discarded,
      };
    });
  } catch (err) {
    console.error('[SyncTabs] Failed to collect tabs:', err);
    return [];
  }
}

// ─── Local Persistence ────────────────────────────────────────────────────────
async function saveTabsLocally(tabs) {
  await chrome.storage.local.set({
    synctabs_my_tabs: tabs,
    synctabs_my_last_seen: new Date().toISOString(),
  });
}

async function saveRemoteBrowsers(browsers) {
  await chrome.storage.local.set({ synctabs_remote_browsers: browsers });
  rebuildContextMenus();
}

async function getRemoteBrowsers() {
  const result = await chrome.storage.local.get('synctabs_remote_browsers');
  return result.synctabs_remote_browsers || {};
}

async function getLocalTabs() {
  const result = await chrome.storage.local.get(['synctabs_my_tabs', 'synctabs_my_last_seen']);
  return { tabs: result.synctabs_my_tabs || [], lastSeen: result.synctabs_my_last_seen || null };
}

// ─── Self-Deduplication ──────────────────────────────────────────────────────
// Filters out our own browser from the remote browsers cache.
// This prevents duplication when the browserId changed (reinstall, storage clear)
// or when the server's full-state hasn't been processed yet.
function filterSelfFromRemote(browsers) {
  if (!browsers || !browserId) return browsers || {};
  const filtered = {};
  for (const [id, data] of Object.entries(browsers)) {
    // Skip exact ID match
    if (id === browserId) continue;
    // Skip null/broken entries
    if (!id || id === 'null' || id === 'undefined') continue;
    filtered[id] = data;
  }
  return filtered;
}

// ─── Dynamic Context Menus ───────────────────────────────────────────────────
async function rebuildContextMenus() {
  await waitForInit();
  
  if (typeof chrome.contextMenus === 'undefined') return;

  chrome.contextMenus.removeAll(async () => {
    const remoteBrowsers = filterSelfFromRemote(await getRemoteBrowsers());
    const validEntries = Object.entries(remoteBrowsers).filter(([id, d]) => {
      if (!id || id === 'null' || id === 'undefined') return false;
      if (id === browserId) return false;
      return d && d.browserName;
    });

    if (validEntries.length === 0) return;

    chrome.contextMenus.create({
      id: 'synctabs-parent',
      title: 'Send to SyncTabs',
      contexts: ['page', 'link']
    });

    for (const [id, data] of validEntries) {
      const isOnline = data.online;
      const viaRelaySuffix = (!isConnected && isRelayConnected) ? ' (via relay)' : '';
      const statusIndicator = isOnline ? '🟢' : '⚫';
      chrome.contextMenus.create({
        id: `synctabs-send::${id}`,
        parentId: 'synctabs-parent',
        title: `${statusIndicator} ${data.browserName}${viaRelaySuffix}`,
        contexts: ['page', 'link']
      });
    }
  });
}

// ─── Tab Group Restoration Helper ──────────────────────────────────────────────
async function restoreTab(tab) {
  if (!tab.url || !isValidUrl(tab.url)) return null;

  // Create tab with active: false, pinned status
  const createOpts = {
    url: tab.url,
    pinned: !!tab.pinned,
    active: false
  };

  const createdTab = await chrome.tabs.create(createOpts);

  // Tab groups preservation
  if (tab.groupTitle && typeof chrome.tabGroups !== 'undefined') {
    try {
      const windowId = createdTab.windowId;
      const existingGroups = await chrome.tabGroups.query({ windowId });
      // Clean and normalize color just in case
      const targetColor = (tab.groupColor || 'grey').toLowerCase();
      const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
      const finalColor = validColors.includes(targetColor) ? targetColor : 'grey';

      const matchingGroup = existingGroups.find(g => g.title === tab.groupTitle);

      if (matchingGroup) {
        await chrome.tabs.group({ tabIds: [createdTab.id], groupId: matchingGroup.id });
      } else {
        const gid = await chrome.tabs.group({ tabIds: [createdTab.id] });
        await chrome.tabGroups.update(gid, {
          title: tab.groupTitle,
          color: finalColor,
        });
      }
    } catch (err) {
      console.warn('[SyncTabs] Failed to restore tab group:', err);
    }
  }
  return createdTab;
}

// ─── Send Tab Helper ──────────────────────────────────────────────────────────
async function sendTabToBrowser(targetBrowserId, tab) {
  await waitForInit();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'send-tab',
      targetBrowserId,
      tab,
    }));
    return { ok: true };
  } else if (relayWs && relayWs.readyState === WebSocket.OPEN && relayCryptoKey) {
    try {
      const payload = JSON.stringify({
        type: 'send-tab',
        targetBrowserId,
        senderBrowserName: browserName,
        url: tab.url,
        title: tab.title,
        pinned: !!tab.pinned,
        groupTitle: tab.groupTitle || '',
        groupColor: tab.groupColor || '',
      });
      const { iv, ciphertext } = await self.SyncTabsE2EE.encrypt(relayCryptoKey, payload);
      relayWs.send(JSON.stringify({
        type: 'relay-data',
        roomId: settings.relayRoomId,
        iv,
        ciphertext,
      }));
      return { ok: true };
    } catch (err) {
      console.error('[SyncTabs Relay] Failed to send tab over relay:', err);
      return { ok: false, error: 'Failed to encrypt/send over relay' };
    }
  } else {
    return { ok: false, error: 'Not connected to server or relay' };
  }
}

// ─── Snapshots (persist on last window close) ─────────────────────────────────
async function saveSnapshot() {
  const tabs = await collectTabs();
  const now = new Date();
  const dateKey = now.toISOString().split('T')[0]; // e.g. "2026-05-20"
  const snapshotId = `synctabs_snapshot_${dateKey}`;

  // Save current snapshot (overwrites today's)
  await chrome.storage.local.set({
    [snapshotId]: {
      tabs,
      time: now.toISOString(),
      tabCount: tabs.length,
    },
    // Also keep the legacy key for backwards compatibility
    synctabs_snapshot: tabs,
    synctabs_snapshot_time: now.toISOString(),
  });

  // Cleanup old snapshots (keep last 7 days)
  try {
    const allKeys = await chrome.storage.local.get(null);
    const snapshotKeys = Object.keys(allKeys).filter(k => k.startsWith('synctabs_snapshot_'));
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const toDelete = snapshotKeys.filter(k => {
      const dateStr = k.replace('synctabs_snapshot_', '');
      return dateStr < cutoffStr;
    });

    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
    }
  } catch (err) {
    console.warn('[SyncTabs] Snapshot cleanup error:', err);
  }
}

async function getSnapshot() {
  const result = await chrome.storage.local.get(['synctabs_snapshot', 'synctabs_snapshot_time']);
  return { tabs: result.synctabs_snapshot || [], time: result.synctabs_snapshot_time || null };
}

// ─── Server Auto-Detection ────────────────────────────────────────────────────
async function probeServer() {
  if (!settings.serverEnabled) return false;
  const hasPerm = await hasHostPermission();
  if (!hasPerm) return false;
  try {
    const httpUrl = settings.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    const resp = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'ok') { serverDetected = true; return true; }
    }
  } catch { /* server not running or no permission */ }
  return false;
}

// ─── Host Permission ──────────────────────────────────────────────────────────
async function hasHostPermission() {
  try { return await chrome.permissions.contains({ origins: [getPermissionOrigin()] }); }
  catch { return false; }
}

// ─── WebSocket Connection ─────────────────────────────────────────────────────
async function connectWebSocket() {
  await waitForInit();  // ← CRITICAL: never connect before we have browserId

  if (!settings.serverEnabled) return;
  if (!browserId) { console.warn('[SyncTabs] No browserId — aborting connection'); return; }

  // Already connected — nothing to do
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // Close stale CONNECTING socket (localhost should connect instantly)
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    try { ws.close(); } catch {}
    ws = null;
  }

  const hasPerm = await hasHostPermission();
  if (!hasPerm) { console.log('[SyncTabs] No host permission — skipping'); return; }

  try { ws = new WebSocket(settings.serverUrl); }
  catch (err) { console.warn('[SyncTabs] WS creation failed:', err.message); scheduleReconnect(); return; }

  ws.onopen = async () => {
    console.log('[SyncTabs] Connected to server');
    isConnected = true;
    serverDetected = true;
    // Capture local reference — module-level `ws` may be replaced during awaits
    const socket = ws;
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'register', browserId, browserName }));
    const tabs = await collectTabs();
    await saveTabsLocally(tabs);
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'tabs-update', tabs }));
    notifyPopup({ type: 'connection-status', connected: true, serverDetected: true, browserName });
    rebuildContextMenus();
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'global-sync-settings': {
        const remoteSettings = msg.settings || {};
        const changes = {};
        let changed = false;

        for (const key of ['relayEnabled', 'relayUrl', 'relayRoomId', 'relaySecretKey']) {
          if (remoteSettings[key] !== undefined && remoteSettings[key] !== settings[key]) {
            changes[key] = remoteSettings[key];
            changed = true;
          }
        }

        if (changed) {
          console.log('[SyncTabs] Received global sync settings from companion:', changes);
          const oldEnabled = settings.relayEnabled;
          await saveSettings(changes);

          if (settings.relayEnabled && settings.relayUrl && settings.relayRoomId && settings.relaySecretKey) {
            if (!oldEnabled || !isRelayConnected) {
              disconnectRelay();
              connectRelay();
            }
          } else if (!settings.relayEnabled) {
            disconnectRelay();
          }

          notifyPopup({ type: 'settings-synced' });
        }
        break;
      }
      case 'full-state': {
        // REPLACE local cache entirely — server is source of truth.
        // Filter out any entry that matches our own browserId (safety).
        const cleaned = {};
        for (const [id, data] of Object.entries(msg.browsers || {})) {
          if (id === browserId) continue;         // skip self
          if (!id || id === 'null') continue;     // skip broken entries
          cleaned[id] = data;
        }
        await saveRemoteBrowsers(cleaned);
        notifyPopup({ type: 'state-updated', browsers: cleaned });
        break;
      }
      case 'browser-tabs-updated': {
        if (msg.browserId === browserId) break;   // skip self
        if (!msg.browserId || msg.browserId === 'null') break;
        const remote = filterSelfFromRemote(await getRemoteBrowsers());
        remote[msg.browserId] = {
          browserName: msg.browserName,
          tabs: msg.tabs,
          lastSeen: msg.lastSeen,
          online: msg.online,
        };
        await saveRemoteBrowsers(remote);
        notifyPopup({ type: 'state-updated', browsers: remote });
        break;
      }
      case 'presence': {
        if (msg.browserId === browserId) break;
        if (!msg.browserId || msg.browserId === 'null') break;
        const remote2 = filterSelfFromRemote(await getRemoteBrowsers());
        if (remote2[msg.browserId]) {
          remote2[msg.browserId].online = msg.online;
          remote2[msg.browserId].lastSeen = msg.lastSeen;
          await saveRemoteBrowsers(remote2);
          notifyPopup({ type: 'state-updated', browsers: remote2 });
        }
        break;
      }
      case 'pending-tabs': {
        const tabs = msg.tabs || [];
        let opened = 0;
        for (const pt of tabs) {
          if (pt.url && isValidUrl(pt.url)) {
            restoreTab(pt);
            opened++;
          }
        }
        if (opened > 0) {
          const sender = tabs[0]?.senderBrowserName || 'Another browser';
          notifyPopup({ type: 'tabs-received', count: opened, senderName: sender });
        }
        break;
      }
      case 'send-tab-ack': {
        notifyPopup({ type: 'send-tab-ack', status: msg.status, targetBrowserId: msg.targetBrowserId });
        break;
      }
    }
  };

  ws.onclose = () => {
    console.log('[SyncTabs] Disconnected');
    isConnected = false;
    ws = null;
    notifyPopup({ type: 'connection-status', connected: false, serverDetected, browserName });
    rebuildContextMenus();
    scheduleReconnect();
  };

  ws.onerror = () => { console.warn('[SyncTabs] WS error'); };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (!isConnected && settings.serverEnabled) {
      const found = await probeServer();
      if (found) connectWebSocket();
    }
  }, settings.reconnectMs);
}

// ─── Relay WebSocket Connection ───────────────────────────────────────────────
async function connectRelay() {
  await waitForInit();

  if (!settings.relayEnabled || !settings.relayUrl || !settings.relayRoomId || !settings.relaySecretKey) {
    return;
  }

  // Already connected
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;

  // Close stale CONNECTING socket
  if (relayWs && relayWs.readyState === WebSocket.CONNECTING) {
    try { relayWs.close(); } catch {}
    relayWs = null;
  }

  // Import the secret key
  try {
    relayCryptoKey = await self.SyncTabsE2EE.importKey(settings.relaySecretKey);
  } catch (err) {
    console.error('[SyncTabs Relay] Failed to import secret key:', err);
    return;
  }

  try { relayWs = new WebSocket(settings.relayUrl); }
  catch (err) {
    console.warn('[SyncTabs Relay] WS creation failed:', err.message);
    scheduleRelayReconnect();
    return;
  }

  relayWs.onopen = () => {
    console.log('[SyncTabs Relay] Connected to relay server');
    isRelayConnected = true;
    relayWs.send(JSON.stringify({ type: 'join', roomId: settings.relayRoomId }));
    notifyPopup({ type: 'relay-connection-status', connected: true });
    rebuildContextMenus();
    // Send current tabs immediately
    sendTabsToRelay();
  };

  relayWs.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'relay-data') {
      await handleRelayData(msg);
    }
  };

  relayWs.onclose = () => {
    console.log('[SyncTabs Relay] Disconnected');
    isRelayConnected = false;
    relayWs = null;
    notifyPopup({ type: 'relay-connection-status', connected: false });
    rebuildContextMenus();
    scheduleRelayReconnect();
  };

  relayWs.onerror = () => {
    console.warn('[SyncTabs Relay] WS error');
  };
}

function scheduleRelayReconnect() {
  if (relayReconnectTimer) clearTimeout(relayReconnectTimer);
  relayReconnectTimer = setTimeout(async () => {
    if (!isRelayConnected && settings.relayEnabled && settings.relayUrl) {
      connectRelay();
    }
  }, settings.reconnectMs);
}

function disconnectRelay() {
  if (relayReconnectTimer) { clearTimeout(relayReconnectTimer); relayReconnectTimer = null; }
  if (relayWs) {
    try { relayWs.close(); } catch {}
    relayWs = null;
  }
  isRelayConnected = false;
  relayCryptoKey = null;
}

/** Encrypt and send current tabs to the relay server. */
async function sendTabsToRelay() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN || !relayCryptoKey) return;
  try {
    const tabs = await collectTabs();
    const payload = JSON.stringify({
      browserId,
      browserName,
      tabs,
      lastSeen: new Date().toISOString(),
      online: true,
    });
    const { iv, ciphertext } = await self.SyncTabsE2EE.encrypt(relayCryptoKey, payload);
    relayWs.send(JSON.stringify({
      type: 'relay-data',
      roomId: settings.relayRoomId,
      iv,
      ciphertext,
    }));
  } catch (err) {
    console.error('[SyncTabs Relay] Failed to send tabs:', err);
  }
}

/** Handle an incoming relay-data message: decrypt, parse, merge. */
async function handleRelayData(msg) {
  if (!relayCryptoKey) return;
  try {
    const plaintext = await self.SyncTabsE2EE.decrypt(relayCryptoKey, msg.iv, msg.ciphertext);
    const data = JSON.parse(plaintext);

    // If it's a send-tab command, open the tab locally
    if (data.type === 'send-tab') {
      if (data.targetBrowserId && data.targetBrowserId !== browserId) {
        return;
      }
      if (data.url && isValidUrl(data.url)) {
        restoreTab(data);
        const sender = data.senderBrowserName || 'Remote browser';
        notifyPopup({ type: 'tabs-received', count: 1, senderName: sender });
      }
      return;
    }

    // Otherwise treat as remote browser tab data
    if (data.browserId && data.browserId !== browserId) {
      const remote = filterSelfFromRemote(await getRemoteBrowsers());
      remote[data.browserId] = {
        browserName: data.browserName || 'Remote Browser',
        tabs: data.tabs || [],
        lastSeen: data.lastSeen || new Date().toISOString(),
        online: data.online !== undefined ? data.online : true,
      };
      await saveRemoteBrowsers(remote);
      notifyPopup({ type: 'state-updated', browsers: remote });
    }
  } catch (err) {
    console.error('[SyncTabs Relay] Failed to decrypt/process relay data:', err);
  }
}

// ─── Tab Change Monitoring ────────────────────────────────────────────────────
function debouncedTabSync() {
  if (tabSyncTimeout) clearTimeout(tabSyncTimeout);
  tabSyncTimeout = setTimeout(async () => {
    await waitForInit();
    const tabs = await collectTabs();
    await saveTabsLocally(tabs);
    // Local companion sync
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tabs-update', tabs }));
    }
    // Relay sync (encrypted)
    if (isRelayConnected) {
      sendTabsToRelay();
    }
  }, settings.syncDebounceMs);
}

chrome.tabs.onCreated.addListener(debouncedTabSync);
chrome.tabs.onRemoved.addListener(debouncedTabSync);
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.url || info.title || info.status === 'complete') debouncedTabSync();
});
chrome.tabs.onMoved.addListener(debouncedTabSync);
chrome.tabs.onAttached.addListener(debouncedTabSync);
chrome.tabs.onDetached.addListener(debouncedTabSync);
chrome.tabs.onReplaced.addListener(debouncedTabSync);
chrome.windows.onCreated.addListener(debouncedTabSync);
chrome.windows.onRemoved.addListener(async () => { await saveSnapshot(); debouncedTabSync(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId.startsWith('synctabs-send::')) {
    const targetBrowserId = info.menuItemId.substring('synctabs-send::'.length);
    const sendUrl = info.linkUrl || info.pageUrl || tab?.url;
    if (!sendUrl || !isValidUrl(sendUrl)) {
      console.warn('[SyncTabs] ContextMenu send aborted: invalid URL', sendUrl);
      return;
    }

    const sendTitle = tab && (sendUrl === tab.url) ? tab.title : (info.selectionText || 'Shared Link');
    const tabPayload = {
      url: sendUrl,
      title: sendTitle,
      favIconUrl: tab && (sendUrl === tab.url) ? tab.favIconUrl : null,
    };

    console.log(`[SyncTabs] Sending tab via ContextMenu to ${targetBrowserId}:`, tabPayload);
    await sendTabToBrowser(targetBrowserId, tabPayload);
  }
});

// ─── Popup / Options Communication ────────────────────────────────────────────
function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'get-state': {
      (async () => {
        await waitForInit();
        const remoteBrowsers = await getRemoteBrowsers();
        // Filter out self from remote browsers (defense against stale cache)
        const filtered = filterSelfFromRemote(remoteBrowsers);
        const localTabs = await getLocalTabs();
        const snapshot = await getSnapshot();
        const hasPerm = await hasHostPermission();
        sendResponse({
          connected: isConnected,
          serverDetected,
          serverEnabled: settings.serverEnabled,
          hasHostPermission: hasPerm,
          browserId,
          browserName,
          myTabs: localTabs.tabs,
          myLastSeen: localTabs.lastSeen,
          remoteBrowsers: filtered,
          snapshot,
          settings,
          // Relay status
          isRelayConnected,
          relayEnabled: settings.relayEnabled,
        });
      })();
      return true;
    }
    case 'force-sync': {
      (async () => {
        await waitForInit();
        // 1. Clear stale remote cache
        await saveRemoteBrowsers({});
        // 2. Collect + save local tabs
        const tabs = await collectTabs();
        await saveTabsLocally(tabs);
        // 3. If not connected, try reconnecting first
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          const hasPerm = await hasHostPermission();
          if (hasPerm && settings.serverEnabled) {
            const found = await probeServer();
            if (found) {
              await connectWebSocket();
              // Give onopen a moment to fire and register
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }
        // 4. Push to server if connected
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'tabs-update', tabs }));
          // 5. Request fresh full-state from server (replaces remote cache)
          ws.send(JSON.stringify({ type: 'request-state' }));
          // Give server time to respond with full-state
          await new Promise(r => setTimeout(r, 300));
        }
        // 6. Return fresh state to popup (filter self from remote)
        const remoteBrowsers = await getRemoteBrowsers();
        const filtered = filterSelfFromRemote(remoteBrowsers);
        const localTabs = await getLocalTabs();
        const snapshot = await getSnapshot();
        const permCheck = await hasHostPermission();
        sendResponse({
          connected: isConnected,
          serverDetected,
          serverEnabled: settings.serverEnabled,
          hasHostPermission: permCheck,
          browserId,
          browserName,
          myTabs: localTabs.tabs,
          myLastSeen: localTabs.lastSeen,
          remoteBrowsers: filtered,
          snapshot,
          settings,
        });
      })();
      return true;
    }
    case 'reconnect': {
      (async () => {
        await waitForInit();
        const hasPerm = await hasHostPermission();
        if (!hasPerm) {
          sendResponse({ ok: false, found: false, reason: 'no-permission' });
          return;
        }
        const found = await probeServer();
        if (!found) {
          sendResponse({ ok: false, found: false, reason: 'server-not-found' });
          return;
        }
        // Close stale socket before reconnecting
        if (ws && ws.readyState !== WebSocket.OPEN) {
          try { ws.close(); } catch {}
          ws = null;
          isConnected = false;
        }
        await connectWebSocket();
        // Give onopen a moment to fire
        await new Promise(r => setTimeout(r, 500));
        sendResponse({ ok: isConnected, found: true, connected: isConnected });
      })();
      return true;
    }
    case 'update-settings': {
      (async () => {
        await waitForInit();
        const oldEnabled = settings.serverEnabled;
        await saveSettings(msg.settings);
        await refreshBrowserName();
        if (settings.serverEnabled && !oldEnabled) {
          const found = await probeServer();
          if (found) connectWebSocket();
        } else if (!settings.serverEnabled && ws) {
          ws.close();
        }
        sendResponse({ ok: true, settings });
      })();
      return true;
    }
    case 'get-settings': {
      sendResponse({ settings });
      return false;
    }
    case 'clear-remote-browsers': {
      (async () => {
        await saveRemoteBrowsers({});
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'send-tab': {
      (async () => {
        const res = await sendTabToBrowser(msg.targetBrowserId, msg.tab);
        sendResponse(res);
      })();
      return true;
    }

    // ─── Companion App Config API ────────────────────────────────────────────
    case 'get-companion-config': {
      (async () => {
        await waitForInit();
        try {
          const httpUrl = settings.serverUrl
            .replace('ws://', 'http://')
            .replace('wss://', 'https://');
          const resp = await fetch(`${httpUrl}/config`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const cfg = await resp.json();
          sendResponse({ ok: true, config: cfg });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'set-companion-config': {
      (async () => {
        await waitForInit();
        try {
          const httpUrl = settings.serverUrl
            .replace('ws://', 'http://')
            .replace('wss://', 'https://');
          const resp = await fetch(`${httpUrl}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.config),
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const result = await resp.json();
          sendResponse({ ok: true, result });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'get-companion-status': {
      (async () => {
        await waitForInit();
        try {
          const httpUrl = settings.serverUrl
            .replace('ws://', 'http://')
            .replace('wss://', 'https://');
          const resp = await fetch(`${httpUrl}/status`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const status = await resp.json();
          sendResponse({ ok: true, status });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'open-all-tabs': {
      (async () => {
        await waitForInit();
        try {
          const tabs = msg.tabs || [];
          if (tabs.length === 0) {
            sendResponse({ ok: false, error: 'No tabs to open' });
            return;
          }

          // Create a new window with the first tab
          const firstTab = tabs[0];
          const newWindow = await chrome.windows.create({
            url: firstTab.url,
            focused: true,
          });

          const createdTabIds = [];
          // The window.create already created one tab, get its ID
          const firstCreatedTab = newWindow.tabs[0];

          // Handle pinned status for first tab
          if (firstTab.pinned) {
            await chrome.tabs.update(firstCreatedTab.id, { pinned: true });
          }

          // Create remaining tabs
          for (let i = 1; i < tabs.length; i++) {
            const t = tabs[i];
            if (!t.url || !isValidUrl(t.url)) continue;
            const createOpts = {
              url: t.url,
              windowId: newWindow.id,
              active: false,
            };
            if (t.pinned) createOpts.pinned = true;
            try {
              const created = await chrome.tabs.create(createOpts);
              createdTabIds.push(created.id);
            } catch {}
          }

          // Discard all tabs except the first (lazy loading)
          for (const tabId of createdTabIds) {
            try {
              await chrome.tabs.discard(tabId);
            } catch {}
          }

          // Handle tab groups if available
          if (chrome.tabGroups) {
            const groupMap = {};
            const allTabs = await chrome.tabs.query({ windowId: newWindow.id });
            for (let i = 0; i < tabs.length && i < allTabs.length; i++) {
              const srcTab = tabs[i];
              const destTab = allTabs[i];
              if (srcTab.groupTitle) {
                try {
                  if (!groupMap[srcTab.groupTitle]) {
                    const gid = await chrome.tabs.group({ tabIds: [destTab.id] });
                    await chrome.tabGroups.update(gid, {
                      title: srcTab.groupTitle,
                      color: srcTab.groupColor || 'grey',
                    });
                    groupMap[srcTab.groupTitle] = gid;
                  } else {
                    await chrome.tabs.group({ tabIds: [destTab.id], groupId: groupMap[srcTab.groupTitle] });
                  }
                } catch {}
              }
            }
          }

          sendResponse({ ok: true, count: tabs.length });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    case 'open-tab-discarded': {
      (async () => {
        try {
          const tab = msg.tab;
          if (!tab || !tab.url || !isValidUrl(tab.url)) {
            sendResponse({ ok: false, error: 'Invalid tab URL' });
            return;
          }
          const created = await chrome.tabs.create({
            url: tab.url,
            active: false,
            pinned: !!tab.pinned,
          });

          // Discard the tab to lazy load it
          try {
            await chrome.tabs.discard(created.id);
          } catch {}

          // Handle tab group if available
          if (tab.groupTitle && typeof chrome.tabGroups !== 'undefined') {
            try {
              const windowId = created.windowId;
              const existingGroups = await chrome.tabGroups.query({ windowId });
              const targetColor = (tab.groupColor || 'grey').toLowerCase();
              const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
              const finalColor = validColors.includes(targetColor) ? targetColor : 'grey';

              const matchingGroup = existingGroups.find(g => g.title === tab.groupTitle);
              if (matchingGroup) {
                await chrome.tabs.group({ tabIds: [created.id], groupId: matchingGroup.id });
              } else {
                const gid = await chrome.tabs.group({ tabIds: [created.id] });
                await chrome.tabGroups.update(gid, {
                  title: tab.groupTitle,
                  color: finalColor,
                });
              }
            } catch {}
          }

          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    case 'get-snapshot-history': {
      (async () => {
        try {
          const allData = await chrome.storage.local.get(null);
          const snapshots = [];
          for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('synctabs_snapshot_') && value && value.tabs) {
              snapshots.push({
                id: key,
                date: key.replace('synctabs_snapshot_', ''),
                time: value.time,
                tabCount: value.tabCount || value.tabs.length,
              });
            }
          }
          // Sort by date descending (newest first)
          snapshots.sort((a, b) => b.date.localeCompare(a.date));
          sendResponse({ ok: true, snapshots });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    case 'restore-snapshot': {
      (async () => {
        try {
          const data = await chrome.storage.local.get(msg.snapshotId);
          const snapshot = data[msg.snapshotId];
          if (!snapshot || !snapshot.tabs || snapshot.tabs.length === 0) {
            sendResponse({ ok: false, error: 'Snapshot not found or empty' });
            return;
          }

          // Use the open-all-tabs logic: create window with first tab, then create rest discarded
          const tabs = snapshot.tabs.filter(t => t.url && isValidUrl(t.url));
          if (tabs.length === 0) {
            sendResponse({ ok: false, error: 'No valid tabs in snapshot' });
            return;
          }

          const newWindow = await chrome.windows.create({ url: tabs[0].url, focused: true });
          const createdIds = [];
          if (tabs[0].pinned) {
            try { await chrome.tabs.update(newWindow.tabs[0].id, { pinned: true }); } catch {}
          }

          for (let i = 1; i < tabs.length; i++) {
            try {
              const created = await chrome.tabs.create({
                url: tabs[i].url,
                windowId: newWindow.id,
                active: false,
                pinned: tabs[i].pinned || false,
              });
              createdIds.push(created.id);
            } catch {}
          }

          // Discard non-active tabs
          for (const id of createdIds) {
            try { await chrome.tabs.discard(id); } catch {}
          }

          sendResponse({ ok: true, count: tabs.length });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    case 'delete-snapshot': {
      (async () => {
        try {
          await chrome.storage.local.remove(msg.snapshotId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    case 'create-snapshot': {
      (async () => {
        try {
          await saveSnapshot();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    // ─── Relay Message Handlers ──────────────────────────────────────────────
    case 'get-relay-settings': {
      (async () => {
        await waitForInit();
        sendResponse({
          relayEnabled: settings.relayEnabled,
          relayUrl: settings.relayUrl,
          relayRoomId: settings.relayRoomId,
          relaySecretKey: settings.relaySecretKey,
          isRelayConnected,
        });
      })();
      return true;
    }
    case 'update-relay-settings': {
      (async () => {
        await waitForInit();
        const oldEnabled = settings.relayEnabled;
        await saveSettings(msg.settings);

        // Sync settings to Go companion if connected
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'update-global-sync-settings',
            settings: msg.settings
          }));
        }

        if (settings.relayEnabled && settings.relayUrl && settings.relayRoomId && settings.relaySecretKey) {
          // Disconnect and reconnect if settings changed or newly enabled
          if (!oldEnabled || !isRelayConnected) {
            disconnectRelay();
            connectRelay();
          }
        } else if (!settings.relayEnabled) {
          disconnectRelay();
        }
        sendResponse({ ok: true, settings });
      })();
      return true;
    }
    case 'generate-relay-pairing': {
      (async () => {
        await waitForInit();
        try {
          const cryptoKey = await self.SyncTabsE2EE.generateKey();
          const secretKey = await self.SyncTabsE2EE.exportKey(cryptoKey);
          const roomId = self.SyncTabsE2EE.generateRoomId();
          const updates = {
            relayRoomId: roomId,
            relaySecretKey: secretKey,
          };
          await saveSettings(updates);

          // Sync generated credentials to Go companion if connected
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'update-global-sync-settings',
              settings: updates
            }));
          }

          sendResponse({
            ok: true,
            relayUrl: settings.relayUrl,
            roomId,
            secretKey,
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
  }
});

// ─── Alarms ───────────────────────────────────────────────────────────────────
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(SERVER_DETECT_ALARM, { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await waitForInit();  // ← gate on init

  if (alarm.name === HEARTBEAT_ALARM) {
    debouncedTabSync();
    if (!isConnected && settings.serverEnabled) {
      const found = await probeServer();
      if (found) connectWebSocket();
    }
  }
  if (alarm.name === SERVER_DETECT_ALARM) {
    if (settings.serverAutoDetect && !isConnected) {
      const found = await probeServer();
      if (found) {
        notifyPopup({ type: 'server-detected' });
        connectWebSocket();
      }
    }
  }
});

// ─── Install Event ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  await waitForInit();
  rebuildContextMenus();
  debouncedTabSync();

  if (settings.serverEnabled) {
    const found = await probeServer();
    if (found) {
      console.log('[SyncTabs] Local server detected — connecting');
      connectWebSocket();
    } else {
      console.log('[SyncTabs] No local server — local-only mode');
    }
  }

  // Start relay connection if enabled and configured
  if (settings.relayEnabled && settings.relayUrl && settings.relayRoomId && settings.relaySecretKey) {
    console.log('[SyncTabs] Relay enabled — connecting to relay server');
    connectRelay();
  }
})();
