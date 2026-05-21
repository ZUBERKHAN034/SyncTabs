// ═══════════════════════════════════════════════════════════════════════════════
// SyncTabs Mobile Portal — JavaScript
// E2EE relay connection, decryption, tab display, and send-tab
// ═══════════════════════════════════════════════════════════════════════════════

(() => {
  'use strict';

  // ─── DOM References ─────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const pairingScreen     = $('#pairingScreen');
  const mainScreen        = $('#mainScreen');
  const statusDot         = $('#statusDot');
  const statusText        = $('#statusText');
  const summaryText       = $('#summaryText');
  const browsersContainer = $('#browsersContainer');
  const emptyState        = $('#emptyState');
  const sendTabInput      = $('#sendTabInput');
  const sendTabBtn        = $('#sendTabBtn');
  const sendTabFeedback   = $('#sendTabFeedback');
  const manualConnectBtn  = $('#manualConnectBtn');
  const toast             = $('#toast');
  const toastText         = $('#toastText');
  const searchInput       = $('#search-input');
  const searchClear       = $('#search-clear');

  // ─── State ──────────────────────────────────────────────────────────────────
  let ws = null;
  let cryptoKey = null;
  let connectionParams = null;
  let browsers = {};            // { browserId: { browserName, tabs[], lastSeen, online } }
  let expandedCards = new Set();
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isConnected = false;
  let searchQuery = '';

  const MAX_RECONNECT_DELAY = 30000;
  const BASE_RECONNECT_DELAY = 1000;
  const PORTAL_BROWSER_ID = 'mobile-portal-' + randomHex(8);

  // ─── Initialization ────────────────────────────────────────────────────────
  function init() {
    connectionParams = parseHashParams();

    if (connectionParams) {
      showMainScreen();
      startConnection();
    } else {
      showPairingScreen();
    }

    // Event listeners
    sendTabBtn.addEventListener('click', handleSendTab);
    sendTabInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendTab();
    });
    manualConnectBtn.addEventListener('click', showManualConnectDialog);

    // Search listeners
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      searchClear.style.display = searchQuery.trim().length > 0 ? 'block' : 'none';
      renderBrowsers();
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      searchClear.style.display = 'none';
      searchInput.focus();
      renderBrowsers();
    });

    // Listen for hash changes (in case user pastes a new URL)
    window.addEventListener('hashchange', () => {
      const newParams = parseHashParams();
      if (newParams) {
        connectionParams = newParams;
        showMainScreen();
        startConnection();
      }
    });
  }


  // ─── URL Hash Parsing ──────────────────────────────────────────────────────
  function parseHashParams() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;

    const params = new URLSearchParams(hash);
    const relayUrl  = params.get('relayUrl')  || params.get('serverUrl') || params.get('url');
    const roomId    = params.get('roomId')    || params.get('room');
    const secretKey = params.get('secretKey') || params.get('key') || params.get('secret');

    if (!relayUrl) return null;

    return { relayUrl, roomId, secretKey };
  }


  // ─── Screen Management ────────────────────────────────────────────────────
  function showPairingScreen() {
    pairingScreen.style.display = '';
    mainScreen.style.display = 'none';
  }

  function showMainScreen() {
    pairingScreen.style.display = 'none';
    mainScreen.style.display = '';
  }


  // ─── AES-GCM-256 Crypto ────────────────────────────────────────────────────
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function importKey(hexString) {
    const keyData = hexToBytes(hexString);
    return crypto.subtle.importKey(
      'raw', keyData, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function decrypt(key, ivHex, ciphertextHex) {
    const iv = hexToBytes(ivHex);
    const ciphertext = hexToBytes(ciphertextHex);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ciphertext
    );
    return new TextDecoder().decode(plainBuffer);
  }

  async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, encoded
    );
    return {
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(new Uint8Array(cipherBuffer)),
    };
  }


  // ─── WebSocket Connection ──────────────────────────────────────────────────
  async function startConnection() {
    if (!connectionParams) return;

    // Import crypto key if available
    if (connectionParams.secretKey) {
      try {
        cryptoKey = await importKey(connectionParams.secretKey);
      } catch (err) {
        console.error('[Portal] Failed to import secret key:', err);
        cryptoKey = null;
      }
    }

    connectWebSocket();
  }

  function connectWebSocket() {
    if (!connectionParams?.relayUrl) return;

    // Cleanup previous
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    setConnectionStatus('connecting');

    try {
      ws = new WebSocket(connectionParams.relayUrl);
    } catch (err) {
      console.error('[Portal] WS creation failed:', err);
      setConnectionStatus('disconnected');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[Portal] Connected to server');
      isConnected = true;
      reconnectAttempts = 0;
      setConnectionStatus('connected');

      // If E2EE relay mode (has roomId), join the room
      if (connectionParams.roomId) {
        wsSend({ type: 'join', roomId: connectionParams.roomId });
      }

      // Register as a mobile portal client
      wsSend({
        type: 'register',
        browserId: PORTAL_BROWSER_ID,
        browserName: 'Mobile Portal',
      });

      // Request full state
      wsSend({ type: 'request-state' });
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      await handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('[Portal] Disconnected');
      isConnected = false;
      ws = null;
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      console.warn('[Portal] WS error');
    };
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
      MAX_RECONNECT_DELAY
    );
    reconnectAttempts++;
    console.log(`[Portal] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(connectWebSocket, delay);
  }


  // ─── Message Handling ──────────────────────────────────────────────────────
  async function handleMessage(msg) {
    switch (msg.type) {
      // ── E2EE relay mode ──
      case 'relay-data': {
        if (!cryptoKey || !msg.iv || !msg.ciphertext) break;
        try {
          const plaintext = await decrypt(cryptoKey, msg.iv, msg.ciphertext);
          const payload = JSON.parse(plaintext);
          await handleDecryptedPayload(payload);
        } catch (err) {
          console.error('[Portal] Decrypt/parse failed:', err);
        }
        break;
      }

      // ── Direct server mode ──
      case 'full-state': {
        if (msg.browsers) {
          browsers = {};
          for (const [id, data] of Object.entries(msg.browsers)) {
            if (!id || id === 'null' || id === 'undefined') continue;
            if (id === PORTAL_BROWSER_ID) continue;
            browsers[id] = {
              browserName: data.browserName || 'Unknown',
              tabs: data.tabs || [],
              lastSeen: data.lastSeen || new Date().toISOString(),
              online: !!data.online,
            };
          }
          renderBrowsers();
        }
        break;
      }

      case 'browser-tabs-updated': {
        if (!msg.browserId || msg.browserId === PORTAL_BROWSER_ID) break;
        browsers[msg.browserId] = {
          browserName: msg.browserName || 'Unknown',
          tabs: msg.tabs || [],
          lastSeen: msg.lastSeen || new Date().toISOString(),
          online: msg.online !== undefined ? msg.online : true,
        };
        renderBrowsers();
        break;
      }

      case 'presence': {
        if (!msg.browserId || msg.browserId === PORTAL_BROWSER_ID) break;
        if (browsers[msg.browserId]) {
          browsers[msg.browserId].online = !!msg.online;
          browsers[msg.browserId].lastSeen = msg.lastSeen || new Date().toISOString();
          renderBrowsers();
        }
        break;
      }

      case 'send-tab-ack': {
        const status = msg.status === 'delivered' ? 'Delivered!' : 'Queued for delivery';
        showSendFeedback(status, 'success');
        break;
      }

      case 'pending-tabs': {
        // Tabs sent TO the mobile portal — open them
        const tabs = msg.tabs || [];
        for (const pt of tabs) {
          if (pt.url) window.open(pt.url, '_blank');
        }
        if (tabs.length > 0) {
          showToast(`📂 Received ${tabs.length} tab${tabs.length > 1 ? 's' : ''}`);
        }
        break;
      }

      case 'error': {
        console.warn('[Portal] Server error:', msg.message);
        break;
      }
    }
  }

  // Handle decrypted E2EE payloads
  async function handleDecryptedPayload(payload) {
    if (!payload) return;

    // Could be tab data from a browser
    if (payload.browserId && payload.tabs) {
      browsers[payload.browserId] = {
        browserName: payload.browserName || 'Unknown',
        tabs: payload.tabs || [],
        lastSeen: payload.lastSeen || new Date().toISOString(),
        online: payload.online !== undefined ? payload.online : true,
      };
      renderBrowsers();
    }

    // Could be a send-tab command from another device
    if (payload.type === 'send-tab' && payload.tab?.url) {
      window.open(payload.tab.url, '_blank');
      showToast(`📂 Tab received from ${payload.senderName || 'desktop'}`);
    }
  }


  // ─── Connection Status UI ──────────────────────────────────────────────────
  function setConnectionStatus(status) {
    statusDot.className = 'status-dot';

    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        break;
      case 'connecting':
        statusText.textContent = 'Connecting…';
        break;
      case 'disconnected':
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
        break;
    }
  }


  // ─── Render Browsers & Tabs ────────────────────────────────────────────────
  function renderBrowsers() {
    const entries = Object.entries(browsers);

    // Update summary
    const totalTabs = entries.reduce((sum, [, b]) => sum + (b.tabs?.length || 0), 0);
    if (entries.length === 0) {
      summaryText.textContent = 'No browsers connected';
    } else {
      const browserWord = entries.length === 1 ? 'browser' : 'browsers';
      const tabWord = totalTabs === 1 ? 'tab' : 'tabs';
      summaryText.textContent = `${entries.length} ${browserWord} · ${totalTabs} ${tabWord}`;
    }

    // Toggle empty state
    if (entries.length === 0) {
      emptyState.classList.remove('hidden');
      browsersContainer.innerHTML = '';
      return;
    }
    emptyState.classList.add('hidden');

    // Global Search override
    if (searchQuery.trim().length > 0) {
      renderSearchResults();
      return;
    }

    // Sort: online first, then by name
    entries.sort((a, b) => {
      if (a[1].online !== b[1].online) return b[1].online ? 1 : -1;
      return (a[1].browserName || '').localeCompare(b[1].browserName || '');
    });

    // Build cards
    const fragment = document.createDocumentFragment();

    for (const [browserId, browser] of entries) {
      const card = document.createElement('div');
      card.className = 'browser-card';
      if (expandedCards.has(browserId)) card.classList.add('expanded');
      card.dataset.browserId = browserId;

      const tabs = browser.tabs || [];
      const isOnline = browser.online;
      const lastSeenStr = timeAgo(browser.lastSeen);

      card.innerHTML = `
        <div class="card-header" data-action="toggle" data-browser-id="${esc(browserId)}">
          <div class="card-header-left">
            <div class="browser-icon">
              ${getBrowserIcon(browser.browserName)}
            </div>
            <div class="card-title-group">
              <div class="card-title">${esc(browser.browserName)}</div>
              <div class="card-meta">
                <span class="online-badge ${isOnline ? 'online' : 'offline'}">${isOnline ? '● Online' : '○ Offline'}</span>
                ${!isOnline ? `<span>· ${esc(lastSeenStr)}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="card-header-right">
            <span class="tab-count-badge">${tabs.length} tab${tabs.length !== 1 ? 's' : ''}</span>
            <svg class="expand-icon" viewBox="0 0 20 20" fill="none">
              <path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
        <div class="tab-list">
          <div class="tab-list-inner">
            ${renderTabItems(tabs, browserId)}
          </div>
        </div>
      `;

      // Toggle expand/collapse
      const header = card.querySelector('.card-header');
      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
        if (card.classList.contains('expanded')) {
          expandedCards.add(browserId);
        } else {
          expandedCards.delete(browserId);
        }
      });

      fragment.appendChild(card);
    }

    browsersContainer.innerHTML = '';
    browsersContainer.appendChild(fragment);
  }

  function renderSearchResults() {
    const query = searchQuery.trim().toLowerCase();
    const matchedTabs = [];

    for (const [browserId, browser] of Object.entries(browsers)) {
      const name = browser.browserName || 'Remote Browser';
      for (const tab of (browser.tabs || [])) {
        if ((tab.title && tab.title.toLowerCase().includes(query)) || (tab.url && tab.url.toLowerCase().includes(query))) {
          matchedTabs.push({ ...tab, deviceName: name, browserId });
        }
      }
    }

    if (matchedTabs.length === 0) {
      browsersContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="32" cy="32" r="20" stroke="currentColor" stroke-width="2" opacity="0.3"/>
              <line x1="46" y1="46" x2="56" y2="56" stroke="currentColor" stroke-width="2" opacity="0.3"/>
            </svg>
          </div>
          <p class="empty-title">No Results Found</p>
          <p class="empty-subtitle">No tabs match "${esc(searchQuery)}"</p>
        </div>
      `;
      return;
    }

    // Render search results card
    const card = document.createElement('div');
    card.className = 'browser-card expanded search-results-card';
    card.innerHTML = `
      <div class="card-header" style="cursor: default;">
        <div class="card-header-left">
          <div class="browser-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <div class="card-title-group">
            <div class="card-title">Search Results</div>
            <div class="card-meta">
              <span>Found ${matchedTabs.length} matching tab${matchedTabs.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="tab-list" style="display: block;">
        <div class="tab-list-inner">
          ${renderMatchedTabItems(matchedTabs, query)}
        </div>
      </div>
    `;

    browsersContainer.innerHTML = '';
    browsersContainer.appendChild(card);
  }

  function renderMatchedTabItems(matchedTabs, query) {
    return matchedTabs.map(tab => {
      const faviconHtml = tab.favIconUrl
        ? `<img class="tab-favicon" src="${esc(tab.favIconUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'tab-favicon-placeholder\\'>${esc(getInitial(tab.title))}</div>'">`
        : `<div class="tab-favicon-placeholder">${esc(getInitial(tab.title))}</div>`;

      const pinnedIcon = tab.pinned
        ? `<svg class="tab-pinned-indicator" viewBox="0 0 16 16" fill="none"><path d="M8 1v6M5 7h6l-1 4H6L5 7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="11" x2="8" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`
        : '';

      const zzzIcon = tab.discarded
        ? `<span class="tab-discarded-icon" title="Lazy loaded tab" style="margin-left: 4px; font-size: 11px;">💤</span>`
        : '';

      const displayUrl = prettifyUrl(tab.url);

      const highlightedTitle = highlightMatch(tab.title || 'Untitled', query);
      const highlightedUrl = highlightMatch(displayUrl, query);

      return `
        <a class="tab-item ${tab.discarded ? 'tab-discarded' : ''}" href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tab.title)}">
          ${faviconHtml}
          <div class="tab-info">
            <div class="tab-title">${highlightedTitle}</div>
            <div class="tab-url">${highlightedUrl}</div>
            <div class="tab-device-badge" style="font-size: 9px; color: var(--accent); margin-top: 2px;">💻 ${esc(tab.deviceName)}</div>
          </div>
          ${pinnedIcon}
          ${zzzIcon}
          <svg class="tab-open-icon" viewBox="0 0 16 16" fill="none">
            <path d="M6 3h7v7M13 3L6 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </a>
      `;
    }).join('');
  }

  function highlightMatch(text, query) {
    if (!query) return esc(text);
    const index = text.toLowerCase().indexOf(query);
    if (index === -1) return esc(text);
    const originalMatch = text.slice(index, index + query.length);
    return esc(text.slice(0, index)) + `<mark>${esc(originalMatch)}</mark>` + highlightMatch(text.slice(index + query.length), query);
  }

  function renderTabItems(tabs, browserId) {
    if (!tabs || tabs.length === 0) {
      return '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">No open tabs</div>';
    }

    const MAX_VISIBLE = 15;
    const visibleTabs = tabs.slice(0, MAX_VISIBLE);
    const remaining = tabs.length - MAX_VISIBLE;

    let html = visibleTabs.map(tab => {
      const faviconHtml = tab.favIconUrl
        ? `<img class="tab-favicon" src="${esc(tab.favIconUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'tab-favicon-placeholder\\'>${esc(getInitial(tab.title))}</div>'">`
        : `<div class="tab-favicon-placeholder">${esc(getInitial(tab.title))}</div>`;

      const pinnedIcon = tab.pinned
        ? `<svg class="tab-pinned-indicator" viewBox="0 0 16 16" fill="none"><path d="M8 1v6M5 7h6l-1 4H6L5 7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="11" x2="8" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`
        : '';

      const zzzIcon = tab.discarded
        ? `<span class="tab-discarded-icon" title="Lazy loaded tab" style="margin-left: 4px; font-size: 11px;">💤</span>`
        : '';

      const displayUrl = prettifyUrl(tab.url);

      return `
        <a class="tab-item ${tab.discarded ? 'tab-discarded' : ''}" href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tab.title)}">
          ${faviconHtml}
          <div class="tab-info">
            <div class="tab-title">${esc(tab.title || 'Untitled')}</div>
            <div class="tab-url">${esc(displayUrl)}</div>
          </div>
          ${pinnedIcon}
          ${zzzIcon}
          <svg class="tab-open-icon" viewBox="0 0 16 16" fill="none">
            <path d="M6 3h7v7M13 3L6 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </a>
      `;
    }).join('');

    if (remaining > 0) {
      html += `<button class="show-more-btn" onclick="this.parentNode.innerHTML = window.__portalRenderAllTabs('${esc(browserId)}')">Show ${remaining} more tab${remaining > 1 ? 's' : ''}</button>`;
    }

    return html;
  }

  // Expose for inline onclick
  window.__portalRenderAllTabs = function(browserId) {
    const browser = browsers[browserId];
    if (!browser) return '';
    return renderTabItems_all(browser.tabs);
  };

  function renderTabItems_all(tabs) {
    if (!tabs) return '';
    return tabs.map(tab => {
      const faviconHtml = tab.favIconUrl
        ? `<img class="tab-favicon" src="${esc(tab.favIconUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'tab-favicon-placeholder\\'>${esc(getInitial(tab.title))}</div>'">`
        : `<div class="tab-favicon-placeholder">${esc(getInitial(tab.title))}</div>`;

      const pinnedIcon = tab.pinned
        ? `<svg class="tab-pinned-indicator" viewBox="0 0 16 16" fill="none"><path d="M8 1v6M5 7h6l-1 4H6L5 7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="11" x2="8" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`
        : '';

      const zzzIcon = tab.discarded
        ? `<span class="tab-discarded-icon" title="Lazy loaded tab" style="margin-right: 4px; font-size: 11px;">💤</span>`
        : '';

      const displayUrl = prettifyUrl(tab.url);

      return `
        <a class="tab-item ${tab.discarded ? 'tab-discarded' : ''}" href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tab.title)}">
          ${faviconHtml}
          <div class="tab-info">
            <div class="tab-title">${esc(tab.title || 'Untitled')}</div>
            <div class="tab-url">${esc(displayUrl)}</div>
          </div>
          ${pinnedIcon}
          ${zzzIcon}
          <svg class="tab-open-icon" viewBox="0 0 16 16" fill="none">
            <path d="M6 3h7v7M13 3L6 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </a>
      `;
    }).join('');
  }


  // ─── Send Tab ──────────────────────────────────────────────────────────────
  async function handleSendTab() {
    const url = sendTabInput.value.trim();
    if (!url) {
      showSendFeedback('Enter a URL to send', 'error');
      return;
    }

    if (!isValidUrl(url)) {
      showSendFeedback('Please enter a valid URL (http/https)', 'error');
      return;
    }

    if (!isConnected) {
      showSendFeedback('Not connected to server', 'error');
      return;
    }

    const browserEntries = Object.entries(browsers);
    if (browserEntries.length === 0) {
      showSendFeedback('No browsers to send to', 'error');
      return;
    }

    // Send to each connected browser
    let sentCount = 0;
    for (const [targetId, browser] of browserEntries) {
      const tab = { url, title: url, favIconUrl: '' };

      if (cryptoKey && connectionParams.roomId) {
        // E2EE relay mode
        try {
          const payload = JSON.stringify({
            type: 'send-tab',
            tab,
            senderName: 'Mobile Portal',
          });
          const { iv, ciphertext } = await encrypt(cryptoKey, payload);
          wsSend({
            type: 'relay-data',
            roomId: connectionParams.roomId,
            iv,
            ciphertext,
          });
          sentCount++;
        } catch (err) {
          console.error('[Portal] Encrypt failed:', err);
        }
      } else {
        // Direct server mode
        wsSend({
          type: 'send-tab',
          targetBrowserId: targetId,
          tab,
        });
        sentCount++;
      }
    }

    if (sentCount > 0) {
      sendTabInput.value = '';
      showSendFeedback(`Sent to ${sentCount} browser${sentCount > 1 ? 's' : ''}`, 'success');
    } else {
      showSendFeedback('Failed to send', 'error');
    }
  }

  function showSendFeedback(message, type) {
    sendTabFeedback.textContent = message;
    sendTabFeedback.className = 'send-tab-feedback ' + type;
    setTimeout(() => {
      sendTabFeedback.textContent = '';
      sendTabFeedback.className = 'send-tab-feedback';
    }, 3000);
  }


  // ─── Manual Connect Dialog ─────────────────────────────────────────────────
  function showManualConnectDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <h2>Connect Manually</h2>
        <div class="dialog-field">
          <label>Server URL</label>
          <input type="url" id="dialogServerUrl" placeholder="ws://127.0.0.1:9234" value="ws://127.0.0.1:9234">
        </div>
        <div class="dialog-field">
          <label>Room ID <span style="color:var(--text-muted);font-weight:400;text-transform:none">(optional)</span></label>
          <input type="text" id="dialogRoomId" placeholder="Leave empty for direct mode">
        </div>
        <div class="dialog-field">
          <label>Secret Key <span style="color:var(--text-muted);font-weight:400;text-transform:none">(optional)</span></label>
          <input type="text" id="dialogSecretKey" placeholder="Hex-encoded AES-256 key">
        </div>
        <div class="dialog-actions">
          <button class="btn-glass" id="dialogCancel">Cancel</button>
          <button class="btn-glass btn-primary" id="dialogConnect">Connect</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#dialogCancel').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#dialogConnect').addEventListener('click', () => {
      const serverUrl = overlay.querySelector('#dialogServerUrl').value.trim();
      const roomId = overlay.querySelector('#dialogRoomId').value.trim();
      const secretKey = overlay.querySelector('#dialogSecretKey').value.trim();

      if (!serverUrl) return;

      connectionParams = {
        relayUrl: serverUrl,
        roomId: roomId || null,
        secretKey: secretKey || null,
      };

      // Update URL hash
      const hashParts = [`relayUrl=${encodeURIComponent(serverUrl)}`];
      if (roomId) hashParts.push(`roomId=${encodeURIComponent(roomId)}`);
      if (secretKey) hashParts.push(`secretKey=${encodeURIComponent(secretKey)}`);
      window.location.hash = hashParts.join('&');

      overlay.remove();
      showMainScreen();
      startConnection();
    });
  }


  // ─── Toast ─────────────────────────────────────────────────────────────────
  function showToast(message, duration = 3000) {
    toastText.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => {
      toast.classList.remove('visible');
    }, duration);
  }


  // ─── Utility Functions ─────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch { return false; }
  }

  function prettifyUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      let display = parsed.hostname.replace(/^www\./, '');
      if (parsed.pathname && parsed.pathname !== '/') {
        display += parsed.pathname;
      }
      if (display.length > 60) display = display.slice(0, 57) + '…';
      return display;
    } catch {
      return url.length > 60 ? url.slice(0, 57) + '…' : url;
    }
  }

  function getInitial(title) {
    if (!title) return '?';
    const cleaned = title.replace(/[^a-zA-Z0-9]/g, '');
    return cleaned.charAt(0) || '?';
  }

  function timeAgo(isoString) {
    if (!isoString) return 'unknown';
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diff = Math.max(0, now - then);

    const seconds = Math.floor(diff / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function getBrowserIcon(name) {
    const n = (name || '').toLowerCase();

    if (n.includes('chrome')) {
      return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M12 8l6 10M12 8l-6 10M20 12H12" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>`;
    }
    if (n.includes('edge')) {
      return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10" stroke="currentColor" stroke-width="1.5"/><path d="M22 12c0-2-1.5-5-5-5s-5 3-5 5 2 4 5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    }
    if (n.includes('firefox')) {
      return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M8 7c1-2 3-3 5-3 4 0 7 3 7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="14" cy="10" r="2" fill="currentColor" opacity="0.5"/></svg>`;
    }
    if (n.includes('brave')) {
      return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v8l-8 8-8-8V6l8-4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 7v10M9 10l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (n.includes('safari')) {
      return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M8 16l2.5-5.5L16 8l-2.5 5.5L8 16z" stroke="currentColor" stroke-width="1.2" fill="currentColor" opacity="0.2"/></svg>`;
    }
    if (n.includes('opera')) {
      return `<svg viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="12" rx="10" ry="10" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="8" stroke="currentColor" stroke-width="1.5"/></svg>`;
    }
    if (n.includes('vivaldi')) {
      return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v12M8 10l4 4 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }

    // Default browser icon
    return `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6.5" r="0.8" fill="currentColor"/><circle cx="8.5" cy="6.5" r="0.8" fill="currentColor"/><circle cx="11" cy="6.5" r="0.8" fill="currentColor"/></svg>`;
  }


  // ─── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
