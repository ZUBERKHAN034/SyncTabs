"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 8765;
const MAX_PAYLOAD = 512 * 1024; // 512 KB
const RATE_WINDOW_MS = 10_000; // 10 seconds
const RATE_MAX_MESSAGES = 50; // per window per connection

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

// ─── MIME types for static file serving ──────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain",
};

const PORTAL_DIR = path.join(__dirname, "portal");

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.method === "GET" && req.url === "/health") {
    let connectionCount = 0;
    for (const members of rooms.values()) {
      connectionCount += members.size;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        connections: connectionCount,
      })
    );
    return;
  }

  // Static file serving from portal/
  if (req.method === "GET") {
    let urlPath = req.url.split("?")[0]; // strip query string
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(PORTAL_DIR, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(PORTAL_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
});

/**
 * Per-connection state attached via a WeakMap-style approach.
 * We store it directly on the ws object for simplicity.
 *
 * ws._relay = {
 *   roomId: string | null,
 *   rateWindow: { start: number, count: number }
 * }
 */

wss.on("connection", (ws, req) => {
  const remoteAddr =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  log(`Client connected from ${remoteAddr}`);

  // Attach per-connection state
  ws._relay = {
    roomId: null,
    rateWindow: { start: Date.now(), count: 0 },
  };

  ws.on("message", (raw) => {
    // ── Rate limiting ──────────────────────────────────────────────────
    const now = Date.now();
    const rw = ws._relay.rateWindow;

    if (now - rw.start > RATE_WINDOW_MS) {
      // Reset window
      rw.start = now;
      rw.count = 1;
    } else {
      rw.count++;
      if (rw.count > RATE_MAX_MESSAGES) {
        sendError(ws, "Rate limit exceeded. Max 50 messages per 10 seconds.");
        return;
      }
    }

    // ── Parse message ──────────────────────────────────────────────────
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendError(ws, "Invalid JSON");
      return;
    }

    if (!msg || typeof msg.type !== "string") {
      sendError(ws, 'Missing "type" field');
      return;
    }

    switch (msg.type) {
      case "join":
        handleJoin(ws, msg);
        break;
      case "relay-data":
        handleRelayData(ws, msg);
        break;
      default:
        sendError(ws, `Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    log(`Client disconnected (${remoteAddr})`);
  });

  ws.on("error", (err) => {
    log(`WebSocket error (${remoteAddr}): ${err.message}`);
    leaveRoom(ws);
  });
});

// ─── Message Handlers ────────────────────────────────────────────────────────

function handleJoin(ws, msg) {
  const { roomId } = msg;

  if (!roomId || typeof roomId !== "string" || roomId.length > 128) {
    sendError(ws, "Invalid roomId");
    return;
  }

  // Leave previous room if any
  leaveRoom(ws);

  // Join new room
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId).add(ws);
  ws._relay.roomId = roomId;

  const roomSize = rooms.get(roomId).size;
  log(`Client joined room "${roomId}" (${roomSize} member${roomSize !== 1 ? "s" : ""})`);

  ws.send(
    JSON.stringify({
      type: "joined",
      roomId,
      members: roomSize,
    })
  );

  // Notify other members about the new peer
  broadcast(roomId, ws, {
    type: "peer-joined",
    roomId,
    members: roomSize,
  });
}

function handleRelayData(ws, msg) {
  const { roomId } = ws._relay;

  if (!roomId) {
    sendError(ws, "Not in a room. Send a join message first.");
    return;
  }

  if (msg.roomId && msg.roomId !== roomId) {
    sendError(ws, "roomId mismatch with joined room");
    return;
  }

  // Forward the entire message as-is to all other members
  const payload = JSON.stringify(msg);
  const members = rooms.get(roomId);
  if (!members) return;

  let forwarded = 0;
  for (const peer of members) {
    if (peer !== ws && peer.readyState === 1 /* WebSocket.OPEN */) {
      peer.send(payload);
      forwarded++;
    }
  }

  // Optional: log high-volume rooms sparingly
  if (members.size > 1) {
    log(`Relayed message in room "${roomId}" to ${forwarded} peer${forwarded !== 1 ? "s" : ""}`);
  }
}

// ─── Room Management ─────────────────────────────────────────────────────────

function leaveRoom(ws) {
  const roomId = ws._relay?.roomId;
  if (!roomId) return;

  const members = rooms.get(roomId);
  if (members) {
    members.delete(ws);

    if (members.size === 0) {
      rooms.delete(roomId);
      log(`Room "${roomId}" destroyed (empty)`);
    } else {
      // Notify remaining members
      broadcast(roomId, null, {
        type: "peer-left",
        roomId,
        members: members.size,
      });
      log(`Client left room "${roomId}" (${members.size} member${members.size !== 1 ? "s" : ""} remaining)`);
    }
  }

  ws._relay.roomId = null;
}

function broadcast(roomId, excludeWs, message) {
  const members = rooms.get(roomId);
  if (!members) return;

  const payload = JSON.stringify(message);
  for (const peer of members) {
    if (peer !== excludeWs && peer.readyState === 1) {
      peer.send(payload);
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sendError(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
}

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(`SyncTabs relay server listening on port ${PORT}`);
  log(`Health check: http://localhost:${PORT}/health`);
  log(`Portal:       http://localhost:${PORT}/`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`);

  // Close all WebSocket connections
  for (const [roomId, members] of rooms) {
    for (const ws of members) {
      ws.close(1001, "Server shutting down");
    }
    members.clear();
  }
  rooms.clear();

  wss.close(() => {
    log("WebSocket server closed");
    server.close(() => {
      log("HTTP server closed");
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => {
    log("Forced shutdown after timeout");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
