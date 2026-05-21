// ─── SyncTabs Options Page Logic ──────────────────────────────────────────────

const COMPANION_URL = 'https://github.com/harshvasudeva/sync-it-up/releases';
const AUTHOR_GITHUB = 'https://github.com/harshvasudeva';
const LOOPBACK_HOST = '127.0.0.1';

// DOM elements
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const browserIdEl = document.getElementById('browser-id');
const toggleServer = document.getElementById('toggle-server');
const inputServerUrl = document.getElementById('input-server-url');
const toggleAutoDetect = document.getElementById('toggle-auto-detect');
const inputBrowserName = document.getElementById('input-browser-name');
const selectTheme = document.getElementById('select-theme');
const btnSave = document.getElementById('btn-save');
const btnTest = document.getElementById('btn-test');
const savedMsg = document.getElementById('saved-msg');
const btnGrantPerm = document.getElementById('btn-grant-permission');
const permStatus = document.getElementById('perm-status');
const btnClearRemote = document.getElementById('btn-clear-remote');
const linkCompanion = document.getElementById('link-companion');
const btnCreateSnapshot = document.getElementById('btn-create-snapshot');
const snapshotSavedMsg = document.getElementById('snapshot-saved-msg');
const snapshotList = document.getElementById('snapshot-list');

SyncTabsTheme.initFromStorage().catch(() => {});

function normalizeServerUrl(value) {
  try {
    const parsed = new URL(value || `ws://${LOOPBACK_HOST}:9234`);
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

    if (!isAllowed) return null;
    return `ws://${LOOPBACK_HOST}:${port}`;
  } catch {
    return null;
  }
}

function getPermissionOrigin(serverUrl) {
  return `http://${LOOPBACK_HOST}/*`;
}

// Initialize
async function init() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'get-state' });
    if (state) {
      // Connection status
      if (state.connected) {
        statusDot.className = 'status-dot online';
        statusText.textContent = `Connected to server — syncing as ${state.browserName}`;
      } else if (state.serverDetected) {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Server detected but not connected';
      } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Running in local-only mode';
      }

      browserIdEl.textContent = state.browserId || '—';

      // Settings
      const settings = state.settings || {};
      toggleServer.checked = settings.serverEnabled !== false;
      inputServerUrl.value = settings.serverUrl || 'ws://127.0.0.1:9234';
      toggleAutoDetect.checked = settings.serverAutoDetect !== false;
      if (inputBrowserName) {
        inputBrowserName.value = settings.browserNameOverride || '';
      }
      if (selectTheme) {
        const theme = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark';
        selectTheme.value = theme;
        SyncTabsTheme.setPreference(theme);
      }

      // Permission status
      if (state.hasHostPermission) {
        permStatus.textContent = '✅ Localhost permission granted';
        btnGrantPerm.style.display = 'none';
      } else {
        permStatus.textContent = '⚠️ Localhost permission not granted';
        btnGrantPerm.style.display = 'inline-block';
      }
    }
    // Load snapshot history
    await loadSnapshotHistory();
  } catch (err) {
    statusText.textContent = 'Error communicating with extension';
  }
}

// Save settings
btnSave.addEventListener('click', async () => {
  const normalizedServerUrl = normalizeServerUrl(inputServerUrl.value.trim());
  if (!normalizedServerUrl) {
    savedMsg.textContent = 'Use ws://127.0.0.1:<port> only';
    savedMsg.classList.add('show');
    setTimeout(() => {
      savedMsg.textContent = 'Saved!';
      savedMsg.classList.remove('show');
    }, 2500);
    return;
  }

  const newSettings = {
    serverEnabled: toggleServer.checked,
    serverUrl: normalizedServerUrl,
    serverAutoDetect: toggleAutoDetect.checked,
    browserNameOverride: inputBrowserName ? inputBrowserName.value.trim() : '',
    theme: selectTheme ? selectTheme.value : 'dark',
  };

  try {
    await chrome.runtime.sendMessage({ type: 'update-settings', settings: newSettings });
    savedMsg.classList.add('show');
    setTimeout(() => savedMsg.classList.remove('show'), 2000);
    // Refresh status after save
    setTimeout(init, 1000);
  } catch (err) {
    savedMsg.textContent = 'Error saving';
    savedMsg.classList.add('show');
    setTimeout(() => {
      savedMsg.textContent = 'Saved!';
      savedMsg.classList.remove('show');
    }, 2000);
  }
});

selectTheme?.addEventListener('change', () => {
  SyncTabsTheme.setPreference(selectTheme.value);
});

// Test connection
btnTest.addEventListener('click', async () => {
  btnTest.textContent = 'Testing...';
  btnTest.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'reconnect' });
    if (result && result.found) {
      btnTest.textContent = '✓ Server found!';
      btnTest.style.color = 'var(--green)';
    } else {
      btnTest.textContent = '✗ Server not found';
      btnTest.style.color = 'var(--red)';
    }
  } catch {
    btnTest.textContent = '✗ Error';
    btnTest.style.color = 'var(--red)';
  }

  setTimeout(() => {
    btnTest.textContent = 'Test Connection';
    btnTest.style.color = '';
    btnTest.disabled = false;
    init(); // Refresh status
  }, 2500);
});

// Grant permission
btnGrantPerm.addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({
      origins: [getPermissionOrigin(inputServerUrl.value.trim())]
    });
    if (granted) {
      permStatus.textContent = '✅ Permission granted!';
      btnGrantPerm.style.display = 'none';
      // Tell background to try connecting
      await chrome.runtime.sendMessage({ type: 'reconnect' });
      setTimeout(init, 2000);
    } else {
      permStatus.textContent = '❌ Permission denied';
    }
  } catch (err) {
    permStatus.textContent = '❌ Permission request failed';
  }
});

// Clear remote data
btnClearRemote.addEventListener('click', async () => {
  if (confirm('Clear all cached remote browser tabs? They will re-sync when the server is connected.')) {
    await chrome.runtime.sendMessage({ type: 'clear-remote-browsers' });
    btnClearRemote.textContent = 'Cleared!';
    setTimeout(() => {
      btnClearRemote.textContent = 'Clear Remote Browser Data';
    }, 2000);
  }
});

// Companion link
linkCompanion.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: COMPANION_URL });
});

init();

// Footer credit
document.getElementById('footer-credit')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: AUTHOR_GITHUB });
});

// ─── Companion App Control Panel ───────────────────────────────────────────────

const companionStatusDot    = document.getElementById('companion-status-dot');
const companionStatusText   = document.getElementById('companion-status-text');
const companionControls     = document.getElementById('companion-controls');
const companionUnavailable  = document.getElementById('companion-unavailable');
const companionPort         = document.getElementById('companion-port');
const companionDataFolder   = document.getElementById('companion-data-folder');
const companionLogLevel     = document.getElementById('companion-log-level');
const companionMaxTabs      = document.getElementById('companion-max-tabs');
const companionAutoStart    = document.getElementById('companion-auto-start');
const btnSaveCompanion      = document.getElementById('btn-save-companion');
const btnApplyPort          = document.getElementById('btn-apply-port');
const btnRestartCompanion   = document.getElementById('btn-restart-companion');
const btnCompanionLogs      = document.getElementById('btn-companion-logs');
const companionSavedMsg     = document.getElementById('companion-saved-msg');

let companionPollInterval = null;

async function loadCompanionStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get-companion-status' });
    if (result && result.ok && result.status) {
      const s = result.status;
      const upMin = Math.floor((s.uptimeSeconds || 0) / 60);
      companionStatusDot.className = 'status-dot online';
      companionStatusText.textContent =
        `Running v${s.version} · ${s.connections} browser(s) connected · uptime ${upMin}m`;
      companionControls.style.display = 'block';
      companionUnavailable.style.display = 'none';
      await loadCompanionConfig();
    } else {
      setCompanionOffline();
    }
  } catch {
    setCompanionOffline();
  }
}

function setCompanionOffline() {
  companionStatusDot.className = 'status-dot offline';
  companionStatusText.textContent = 'Companion not running';
  companionControls.style.display = 'none';
  companionUnavailable.style.display = 'block';
}

async function loadCompanionConfig() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get-companion-config' });
    if (result && result.ok && result.config) {
      const cfg = result.config;
      companionPort.value         = cfg.port              || 9234;
      companionDataFolder.value   = cfg.dataFolder        || '';
      companionLogLevel.value     = cfg.logLevel          || 'info';
      companionMaxTabs.value      = cfg.maxTabsPerBrowser || 500;
      companionAutoStart.checked  = !!cfg.autoStart;
    }
  } catch (err) {
    console.error('[SyncTabs] Failed to load companion config:', err);
  }
}

// Save non-port settings
btnSaveCompanion.addEventListener('click', async () => {
  const partial = {
    dataFolder:        companionDataFolder.value.trim(),
    logLevel:          companionLogLevel.value,
    maxTabsPerBrowser: parseInt(companionMaxTabs.value, 10) || 500,
    autoStart:         companionAutoStart.checked,
  };

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'set-companion-config',
      config: partial,
    });
    if (result && result.ok) {
      companionSavedMsg.classList.add('show');
      setTimeout(() => companionSavedMsg.classList.remove('show'), 2000);
    } else {
      alert('Failed to save: ' + (result?.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// Port change (separate Apply button — requires restart + re-grant permission)
btnApplyPort.addEventListener('click', async () => {
  const newPort = parseInt(companionPort.value, 10);
  if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
    alert('Invalid port. Must be between 1 and 65535.');
    return;
  }

  const confirmed = confirm(
    `Change companion port to ${newPort}?\n\n` +
    `This will restart the companion server briefly.\n\n` +
    `You will also need to:\n` +
    `  1. Update "Server URL" above to ws://127.0.0.1:${newPort}\n` +
    `  2. Re-grant localhost permission for the new port`
  );
  if (!confirmed) return;

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'set-companion-config',
      config: { port: newPort },
    });
    if (result && result.ok) {
      if (result.result && result.result.restartNeeded) {
        companionStatusText.textContent = 'Restarting on new port...';
        // Poll status after restart delay
        setTimeout(loadCompanionStatus, 3000);
      }
    } else {
      alert('Failed to change port: ' + (result?.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// Restart companion
btnRestartCompanion.addEventListener('click', async () => {
  if (!confirm('Restart the SyncTabs Companion? Browsers will briefly disconnect.')) return;
  btnRestartCompanion.disabled = true;
  btnRestartCompanion.textContent = 'Restarting...';
  try {
    await chrome.runtime.sendMessage({
      type: 'set-companion-config',
      config: { _restart: true },
    });
    setTimeout(loadCompanionStatus, 2500);
  } catch {}
  setTimeout(() => {
    btnRestartCompanion.disabled = false;
    btnRestartCompanion.textContent = 'Restart Companion';
  }, 3000);
});

// Logs — must use tray
btnCompanionLogs.addEventListener('click', () => {
  alert('To view logs, right-click the SyncTabs icon in your system tray and select "View Logs".');
});

// Select styling for log level dropdown
if (companionLogLevel) {
  companionLogLevel.style.cssText =
    'padding:8px 10px;background:var(--bg);border:1px solid var(--border);' +
    'border-radius:6px;color:var(--text);font-size:13px;width:100%;cursor:pointer';
}

// Initial load + polling
loadCompanionStatus();
companionPollInterval = setInterval(loadCompanionStatus, 5000);
window.addEventListener('unload', () => {
  if (companionPollInterval) clearInterval(companionPollInterval);
});

// ─── E2EE Relay Sync Panel ─────────────────────────────────────────────────

const toggleRelay       = document.getElementById('toggle-relay');
const relayConfig       = document.getElementById('relay-config');
const inputRelayUrl     = document.getElementById('input-relay-url');
const relayStatusDot    = document.getElementById('relay-status-dot');
const relayStatusText   = document.getElementById('relay-status-text');
const btnGeneratePairing = document.getElementById('btn-generate-pairing');
const btnSaveRelay      = document.getElementById('btn-save-relay');
const relaySavedMsg     = document.getElementById('relay-saved-msg');
const relayQrArea       = document.getElementById('relay-qr-area');
const relayQrCanvas     = document.getElementById('relay-qr-canvas');
const relayQrPayload    = document.getElementById('relay-qr-payload');

// Load relay settings on page open
async function loadRelaySettings() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get-relay-settings' });
    if (result) {
      toggleRelay.checked = !!result.relayEnabled;
      inputRelayUrl.value = result.relayUrl || '';
      relayConfig.style.display = toggleRelay.checked ? 'block' : 'none';
      updateRelayStatusUI(result.isRelayConnected);

      // If credentials exist, render the pairing QR code immediately
      if (result.relayRoomId && result.relaySecretKey) {
        const relayUrl = result.relayUrl || '';
        const pairingPayload = `relayUrl=${encodeURIComponent(relayUrl)}&roomId=${encodeURIComponent(result.relayRoomId)}&secretKey=${encodeURIComponent(result.relaySecretKey)}`;

        // Convert wss:// or ws:// to https:// or http:// for the portal base
        let portalBase = relayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
        const pairingUrl = `${portalBase}/#${pairingPayload}`;

        // Render QR code
        renderQRCode(relayQrCanvas, pairingUrl);
        relayQrPayload.textContent = pairingUrl;
        relayQrArea.style.display = 'block';
      } else {
        relayQrArea.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('[SyncTabs] Failed to load relay settings:', err);
  }
}

function updateRelayStatusUI(connected) {
  if (connected) {
    relayStatusDot.className = 'status-dot online';
    relayStatusText.textContent = 'Connected to relay server';
  } else if (toggleRelay.checked) {
    relayStatusDot.className = 'status-dot offline';
    relayStatusText.textContent = 'Not connected';
  } else {
    relayStatusDot.className = 'status-dot offline';
    relayStatusText.textContent = 'Relay disabled';
  }
}

// Toggle show/hide relay config
toggleRelay.addEventListener('change', () => {
  relayConfig.style.display = toggleRelay.checked ? 'block' : 'none';
  updateRelayStatusUI(false);
});

// Save relay settings
btnSaveRelay.addEventListener('click', async () => {
  const settings = {
    relayEnabled: toggleRelay.checked,
    relayUrl: inputRelayUrl.value.trim(),
  };
  try {
    const result = await chrome.runtime.sendMessage({ type: 'update-relay-settings', settings });
    if (result && result.ok) {
      relaySavedMsg.classList.add('show');
      setTimeout(() => relaySavedMsg.classList.remove('show'), 2000);
      // Refresh status after a moment
      setTimeout(loadRelaySettings, 1500);
    } else {
      relaySavedMsg.textContent = 'Error saving';
      relaySavedMsg.classList.add('show');
      setTimeout(() => {
        relaySavedMsg.textContent = 'Saved!';
        relaySavedMsg.classList.remove('show');
      }, 2000);
    }
  } catch (err) {
    relaySavedMsg.textContent = 'Error';
    relaySavedMsg.classList.add('show');
    setTimeout(() => {
      relaySavedMsg.textContent = 'Saved!';
      relaySavedMsg.classList.remove('show');
    }, 2000);
  }
});

// Generate pairing
btnGeneratePairing.addEventListener('click', async () => {
  btnGeneratePairing.disabled = true;
  btnGeneratePairing.textContent = 'Generating...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'generate-relay-pairing' });
    if (result && result.roomId && result.secretKey) {
      // Update URL field if background returned one
      if (result.relayUrl) {
        inputRelayUrl.value = result.relayUrl;
      }
      // Build pairing URL
      const relayUrl = inputRelayUrl.value.trim() || result.relayUrl || '';
      const pairingPayload = `relayUrl=${encodeURIComponent(relayUrl)}&roomId=${encodeURIComponent(result.roomId)}&secretKey=${encodeURIComponent(result.secretKey)}`;

      // Convert wss:// or ws:// to https:// or http:// for the portal base
      let portalBase = relayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
      const pairingUrl = `${portalBase}/#${pairingPayload}`;

      // Render QR code
      renderQRCode(relayQrCanvas, pairingUrl);
      relayQrPayload.textContent = pairingUrl;
      relayQrArea.style.display = 'block';

      // Auto-save settings with the new keys
      await chrome.runtime.sendMessage({
        type: 'update-relay-settings',
        settings: {
          relayEnabled: true,
          relayUrl: relayUrl,
        },
      });
      toggleRelay.checked = true;
      relayConfig.style.display = 'block';
      setTimeout(loadRelaySettings, 1500);
    }
  } catch (err) {
    console.error('[SyncTabs] Generate pairing failed:', err);
  } finally {
    btnGeneratePairing.disabled = false;
    btnGeneratePairing.textContent = 'Generate Pairing';
  }
});

// Poll relay status
let relayPollInterval = setInterval(async () => {
  if (!toggleRelay.checked) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get-relay-settings' });
    if (result) updateRelayStatusUI(result.isRelayConnected);
  } catch {}
}, 5000);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'settings-synced') {
    console.log('[SyncTabs] Settings synced from companion — refreshing options UI');
    loadRelaySettings();
  }
});

window.addEventListener('unload', () => {
  if (relayPollInterval) clearInterval(relayPollInterval);
});

loadRelaySettings();

// ─── Minimal QR Code Generator (self-contained) ───────────────────────────
// Implements QR Code Model 2 with error correction level L.
// Supports byte-mode encoding, auto version selection (1–40).

function renderQRCode(canvas, text) {
  const modules = generateQR(text);
  const size = modules.length;
  const scale = Math.max(2, Math.floor(200 / size));
  const totalSize = size * scale + 16; // 8px quiet zone each side
  canvas.width = totalSize;
  canvas.height = totalSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalSize, totalSize);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        ctx.fillRect(8 + c * scale, 8 + r * scale, scale, scale);
      }
    }
  }
}

function generateQR(text) {
  const data = new TextEncoder().encode(text);
  const dataLen = data.length;

  // Error correction level L capacity table (byte mode) for versions 1-40
  const capacityL = [
    17,32,53,78,106,134,154,192,230,271,321,367,425,458,520,586,644,718,792,
    858,929,1003,1091,1171,1273,1367,1465,1528,1628,1732,1840,1952,2068,2188,
    2303,2431,2563,2699,2809,2953
  ];

  let version = 1;
  for (let v = 0; v < capacityL.length; v++) {
    if (capacityL[v] >= dataLen) { version = v + 1; break; }
    if (v === capacityL.length - 1) version = 40;
  }

  const size = version * 4 + 17;
  // Create module grid: null = not yet set
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  function setModule(r, c, val) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      grid[r][c] = val ? 1 : 0;
      reserved[r][c] = true;
    }
  }

  // Finder patterns
  function placeFinderPattern(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inBorder = r === -1 || r === 7 || c === -1 || c === 7;
        setModule(rr, cc, (inOuter || inInner) && !inBorder);
      }
    }
  }
  placeFinderPattern(0, 0);
  placeFinderPattern(0, size - 7);
  placeFinderPattern(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const alignPos = getAlignmentPositions(version);
  for (const r of alignPos) {
    for (const c of alignPos) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          setModule(r + dr, c + dc, isEdge || isCenter);
        }
      }
    }
  }

  // Format info area (reserve)
  for (let i = 0; i < 8; i++) {
    setModule(8, i, 0); setModule(i, 8, 0);
    setModule(8, size - 1 - i, 0);
    setModule(size - 1 - i, 8, 0);
  }
  setModule(8, 8, 0);
  // Dark module
  setModule(size - 8, 8, 1);

  // Version info (version >= 7)
  if (version >= 7) {
    const versionBits = getVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (versionBits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setModule(r, c, bit);
      setModule(c, r, bit);
    }
  }

  // Encode data
  const ecInfo = getECInfo(version);
  const codewords = encodeData(data, version, ecInfo);

  // Place data bits
  placeDataBits(grid, reserved, size, codewords);

  // Apply best mask
  applyBestMask(grid, reserved, size);

  return grid;
}

function getAlignmentPositions(version) {
  if (version === 1) return [];
  const table = [
    [],[], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58],
    [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
    [6,30,56,82], [6,30,58,86], [6,34,62,90], [6,28,50,72,94],
    [6,26,50,74,98], [6,30,54,78,102], [6,28,54,80,106], [6,32,58,84,110],
    [6,30,58,86,114], [6,34,62,90,118], [6,26,50,74,98,122],
    [6,30,54,78,102,126], [6,26,52,78,104,130], [6,30,56,82,108,134],
    [6,34,60,86,112,138], [6,30,58,86,114,142], [6,34,62,90,118,146],
    [6,30,54,78,102,126,150], [6,24,50,76,102,128,154],
    [6,28,54,80,106,132,158], [6,32,58,84,110,136,162],
    [6,26,54,82,110,138,166], [6,30,58,86,114,142,170]
  ];
  return table[version] || [];
}

function getVersionBits(version) {
  const versionBitsTable = [
    0,0,0,0,0,0,0,
    0x07C94,0x085BC,0x09A99,0x0A4D3,0x0BBF6,0x0C762,0x0D847,
    0x0E60D,0x0F928,0x10B78,0x1145D,0x12A17,0x13532,0x149A6,
    0x15683,0x168C9,0x177EC,0x18EC4,0x191E1,0x1AFAB,0x1B08E,
    0x1CC1A,0x1D33F,0x1ED75,0x1F250,0x209D5,0x216F0,0x228BA,
    0x2379F,0x24B0B,0x2542E,0x26A64,0x27541
  ];
  return versionBitsTable[version] || 0;
}

// EC info: total codewords, ec codewords per block, number of blocks (group1, group2)
function getECInfo(version) {
  // Simplified Level L EC table for all 40 versions
  const table = [
    null,
    { totalDC: 19, ecPerBlock: 7, g1Blocks: 1, g1DataCW: 19, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 34, ecPerBlock: 10, g1Blocks: 1, g1DataCW: 34, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 55, ecPerBlock: 15, g1Blocks: 1, g1DataCW: 55, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 80, ecPerBlock: 20, g1Blocks: 1, g1DataCW: 80, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 108, ecPerBlock: 26, g1Blocks: 1, g1DataCW: 108, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 136, ecPerBlock: 18, g1Blocks: 2, g1DataCW: 68, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 156, ecPerBlock: 20, g1Blocks: 2, g1DataCW: 78, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 194, ecPerBlock: 24, g1Blocks: 2, g1DataCW: 97, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 232, ecPerBlock: 30, g1Blocks: 2, g1DataCW: 116, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 274, ecPerBlock: 18, g1Blocks: 2, g1DataCW: 68, g2Blocks: 2, g2DataCW: 69 },
    { totalDC: 324, ecPerBlock: 20, g1Blocks: 4, g1DataCW: 81, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 370, ecPerBlock: 24, g1Blocks: 2, g1DataCW: 92, g2Blocks: 2, g2DataCW: 93 },
    { totalDC: 428, ecPerBlock: 26, g1Blocks: 4, g1DataCW: 107, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 461, ecPerBlock: 30, g1Blocks: 3, g1DataCW: 115, g2Blocks: 1, g2DataCW: 116 },
    { totalDC: 523, ecPerBlock: 22, g1Blocks: 5, g1DataCW: 87, g2Blocks: 1, g2DataCW: 88 },
    { totalDC: 589, ecPerBlock: 24, g1Blocks: 5, g1DataCW: 98, g2Blocks: 1, g2DataCW: 99 },
    { totalDC: 647, ecPerBlock: 28, g1Blocks: 1, g1DataCW: 107, g2Blocks: 5, g2DataCW: 108 },
    { totalDC: 721, ecPerBlock: 30, g1Blocks: 5, g1DataCW: 120, g2Blocks: 1, g2DataCW: 121 },
    { totalDC: 795, ecPerBlock: 28, g1Blocks: 3, g1DataCW: 113, g2Blocks: 4, g2DataCW: 114 },
    { totalDC: 861, ecPerBlock: 28, g1Blocks: 3, g1DataCW: 107, g2Blocks: 5, g2DataCW: 108 },
    { totalDC: 932, ecPerBlock: 28, g1Blocks: 4, g1DataCW: 116, g2Blocks: 4, g2DataCW: 117 },
    { totalDC: 1006, ecPerBlock: 28, g1Blocks: 2, g1DataCW: 111, g2Blocks: 7, g2DataCW: 112 },
    { totalDC: 1094, ecPerBlock: 30, g1Blocks: 4, g1DataCW: 121, g2Blocks: 5, g2DataCW: 122 },
    { totalDC: 1174, ecPerBlock: 30, g1Blocks: 6, g1DataCW: 117, g2Blocks: 4, g2DataCW: 118 },
    { totalDC: 1276, ecPerBlock: 26, g1Blocks: 8, g1DataCW: 106, g2Blocks: 4, g2DataCW: 107 },
    { totalDC: 1370, ecPerBlock: 28, g1Blocks: 10, g1DataCW: 114, g2Blocks: 2, g2DataCW: 115 },
    { totalDC: 1468, ecPerBlock: 30, g1Blocks: 8, g1DataCW: 122, g2Blocks: 4, g2DataCW: 123 },
    { totalDC: 1531, ecPerBlock: 30, g1Blocks: 3, g1DataCW: 117, g2Blocks: 10, g2DataCW: 118 },
    { totalDC: 1631, ecPerBlock: 30, g1Blocks: 7, g1DataCW: 116, g2Blocks: 7, g2DataCW: 117 },
    { totalDC: 1735, ecPerBlock: 30, g1Blocks: 5, g1DataCW: 115, g2Blocks: 10, g2DataCW: 116 },
    { totalDC: 1843, ecPerBlock: 30, g1Blocks: 13, g1DataCW: 115, g2Blocks: 3, g2DataCW: 116 },
    { totalDC: 1955, ecPerBlock: 30, g1Blocks: 17, g1DataCW: 115, g2Blocks: 0, g2DataCW: 0 },
    { totalDC: 2071, ecPerBlock: 30, g1Blocks: 17, g1DataCW: 115, g2Blocks: 1, g2DataCW: 116 },
    { totalDC: 2191, ecPerBlock: 30, g1Blocks: 13, g1DataCW: 115, g2Blocks: 6, g2DataCW: 116 },
    { totalDC: 2306, ecPerBlock: 30, g1Blocks: 12, g1DataCW: 121, g2Blocks: 7, g2DataCW: 122 },
    { totalDC: 2434, ecPerBlock: 30, g1Blocks: 6, g1DataCW: 121, g2Blocks: 14, g2DataCW: 122 },
    { totalDC: 2566, ecPerBlock: 30, g1Blocks: 17, g1DataCW: 122, g2Blocks: 4, g2DataCW: 123 },
    { totalDC: 2702, ecPerBlock: 30, g1Blocks: 4, g1DataCW: 122, g2Blocks: 18, g2DataCW: 123 },
    { totalDC: 2812, ecPerBlock: 30, g1Blocks: 20, g1DataCW: 117, g2Blocks: 4, g2DataCW: 118 },
    { totalDC: 2956, ecPerBlock: 30, g1Blocks: 19, g1DataCW: 118, g2Blocks: 6, g2DataCW: 119 },
  ];
  return table[version];
}

function encodeData(data, version, ecInfo) {
  const totalBlocks = ecInfo.g1Blocks + ecInfo.g2Blocks;
  const totalCodewords = ecInfo.totalDC + totalBlocks * ecInfo.ecPerBlock;

  // Build data stream: mode indicator (0100 = byte) + char count + data + terminator + padding
  const charCountBits = version <= 9 ? 8 : 16;
  const bits = [];

  function pushBits(val, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
  }

  pushBits(0b0100, 4); // Byte mode
  pushBits(data.length, charCountBits);
  for (const b of data) pushBits(b, 8);

  // Terminator
  const dataBits = ecInfo.totalDC * 8;
  const terminatorLen = Math.min(4, dataBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) bits.push(0);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad codewords
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < dataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to codewords
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | (bits[i + j] || 0);
    dataCodewords.push(val);
  }

  // Split into blocks
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < ecInfo.g1Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + ecInfo.g1DataCW));
    offset += ecInfo.g1DataCW;
  }
  for (let i = 0; i < ecInfo.g2Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + ecInfo.g2DataCW));
    offset += ecInfo.g2DataCW;
  }

  // Generate EC codewords for each block
  const ecBlocks = blocks.map(block => generateEC(block, ecInfo.ecPerBlock));

  // Interleave data codewords
  const result = [];
  const maxDataLen = Math.max(ecInfo.g1DataCW, ecInfo.g2DataCW || 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }

  // Interleave EC codewords
  for (let i = 0; i < ecInfo.ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      if (i < ec.length) result.push(ec[i]);
    }
  }

  return result;
}

// Reed-Solomon EC generation in GF(256)
function generateEC(data, ecCount) {
  // GF(256) log/exp tables
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let val = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = val;
    gfLog[val] = i;
    val <<= 1;
    if (val >= 256) val ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return gfExp[gfLog[a] + gfLog[b]];
  }

  // Generator polynomial
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = newGen;
  }

  // Polynomial division
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }

  return Array.from(msg.slice(data.length));
}

function placeDataBits(grid, reserved, size, codewords) {
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  // Traverse right-to-left in column pairs, bottom-to-top then top-to-bottom alternating
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // Skip timing column
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= size) continue;
        if (reserved[row][c]) continue;
        grid[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }
    upward = !upward;
  }
}

function applyBestMask(grid, reserved, size) {
  // For simplicity, apply mask 0 (checkerboard) and write format info
  const maskFn = (r, c) => (r + c) % 2 === 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && grid[r][c] !== null) {
        if (maskFn(r, c)) grid[r][c] ^= 1;
      }
    }
  }

  // Format info for EC level L (01) + mask 0 (000) = 01000
  // After BCH: 0x77C4 = 0111011111000100
  const formatBits = 0x77C4;
  writeFormatBits(grid, size, formatBits);
}

function writeFormatBits(grid, size, formatBits) {
  // Positions around finder patterns
  const positions1 = [
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
    [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
  ];
  const positions2 = [
    [size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
    [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]
  ];

  for (let i = 0; i < 15; i++) {
    const bit = (formatBits >> (14 - i)) & 1;
    if (positions1[i]) {
      grid[positions1[i][0]][positions1[i][1]] = bit;
    }
    if (positions2[i]) {
      grid[positions2[i][0]][positions2[i][1]] = bit;
    }
  }
}

// ─── Session Snapshots UI Logic ───────────────────────────────────────────────

async function loadSnapshotHistory() {
  if (!snapshotList) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'get-snapshot-history' });
    if (res && res.ok && res.snapshots) {
      renderSnapshots(res.snapshots);
    } else {
      snapshotList.innerHTML = `<p class="text-muted">Error loading snapshots: ${res?.error || 'Unknown error'}</p>`;
    }
  } catch (err) {
    snapshotList.innerHTML = `<p class="text-muted">Error communicating with extension: ${err.message}</p>`;
  }
}

function renderSnapshots(snapshots) {
  if (!snapshotList) return;
  if (snapshots.length === 0) {
    snapshotList.innerHTML = `<p class="text-muted">No snapshots saved yet.</p>`;
    return;
  }

  snapshotList.innerHTML = '';
  snapshots.forEach(snap => {
    const item = document.createElement('div');
    item.className = 'snapshot-item';
    
    const formattedDate = formatSnapshotDate(snap.time, snap.date);
    
    item.innerHTML = `
      <div class="snapshot-info">
        <span class="snapshot-date">${formattedDate}</span>
        <span class="snapshot-meta">${snap.tabCount} tab${snap.tabCount === 1 ? '' : 's'}</span>
      </div>
      <div class="snapshot-actions">
        <button class="btn btn-ghost btn-restore" data-id="${snap.id}">Restore</button>
        <button class="btn btn-danger btn-delete" data-id="${snap.id}">Delete</button>
      </div>
    `;

    // Hook up restore event listener
    const btnRestore = item.querySelector('.btn-restore');
    btnRestore.addEventListener('click', async () => {
      if (confirm(`Are you sure you want to restore this snapshot from ${formattedDate}?\nThis will open all ${snap.tabCount} tabs in a new window (lazy-loaded).`)) {
        btnRestore.disabled = true;
        btnRestore.textContent = 'Restoring...';
        try {
          const res = await chrome.runtime.sendMessage({ type: 'restore-snapshot', snapshotId: snap.id });
          if (res && res.ok) {
            btnRestore.textContent = 'Restored!';
            setTimeout(() => {
              btnRestore.textContent = 'Restore';
              btnRestore.disabled = false;
            }, 2000);
          } else {
            alert('Failed to restore snapshot: ' + (res?.error || 'Unknown error'));
            btnRestore.textContent = 'Restore';
            btnRestore.disabled = false;
          }
        } catch (err) {
          alert('Error: ' + err.message);
          btnRestore.textContent = 'Restore';
          btnRestore.disabled = false;
        }
      }
    });

    // Hook up delete event listener
    const btnDelete = item.querySelector('.btn-delete');
    btnDelete.addEventListener('click', async () => {
      if (confirm(`Are you sure you want to delete this snapshot from ${formattedDate}?`)) {
        btnDelete.disabled = true;
        btnDelete.textContent = 'Deleting...';
        try {
          const res = await chrome.runtime.sendMessage({ type: 'delete-snapshot', snapshotId: snap.id });
          if (res && res.ok) {
            await loadSnapshotHistory();
          } else {
            alert('Failed to delete snapshot: ' + (res?.error || 'Unknown error'));
            btnDelete.textContent = 'Delete';
            btnDelete.disabled = false;
          }
        } catch (err) {
          alert('Error: ' + err.message);
          btnDelete.textContent = 'Delete';
          btnDelete.disabled = false;
        }
      }
    });

    snapshotList.appendChild(item);
  });
}

function formatSnapshotDate(isoString, dateStr) {
  try {
    const d = new Date(isoString || dateStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }) + ' ' + d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  } catch (e) {}
  return dateStr;
}

if (btnCreateSnapshot) {
  btnCreateSnapshot.addEventListener('click', async () => {
    btnCreateSnapshot.disabled = true;
    btnCreateSnapshot.textContent = 'Creating...';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'create-snapshot' });
      if (res && res.ok) {
        if (snapshotSavedMsg) {
          snapshotSavedMsg.classList.add('show');
          setTimeout(() => {
            snapshotSavedMsg.classList.remove('show');
          }, 2000);
        }
        await loadSnapshotHistory();
      } else {
        alert('Failed to create snapshot: ' + (res?.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error creating snapshot: ' + err.message);
    } finally {
      btnCreateSnapshot.disabled = false;
      btnCreateSnapshot.textContent = 'Create Snapshot Now';
    }
  });
}
