import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { logger } from "./logger.js";
import { verifyUserJwt, verifyAdminJwt } from "../middleware/security.js";
import { verifyAccessToken } from "../utils/admin-jwt.js";
import { db } from "@workspace/db";
import { ridesTable, ordersTable, parcelBookingsTable, pharmacyOrdersTable, liveLocationsTable, usersTable, locationHistoryTable, callLogsTable, conversationsTable, chatMessagesTable, vanBookingsTable, vanSchedulesTable } from "@workspace/db/schema";
import { eq, or, and, sql, lt, lte } from "drizzle-orm";

/* ── Server-side GPS broadcast throttle: max 1 emit per rider per 1500ms ── */
const RIDER_LOC_THROTTLE_MS = 1500;
const _riderLocLastEmit = new Map<string, number>();

let _io: SocketIOServer | null = null;

/* ── Per-connection verified-session cache ────────────────────────────────
   JWT verification is CPU-expensive (HMAC-SHA256).  Within a single socket
   connection the token never changes, so we cache the decoded payload keyed
   by socket ID and clear the entry on disconnect.
   Value shape: { payload: JwtPayload | null } — null means the token was
   invalid; we store that too so we never retry a known-bad token.          */
type CachedSession = { userId: string; role?: string; roles?: string } | null;
const _sessionCache = new Map<string, CachedSession>();

function getCachedSession(socketId: string, token: string | null): CachedSession {
  if (_sessionCache.has(socketId)) return _sessionCache.get(socketId)!;
  if (!token) {
    _sessionCache.set(socketId, null);
    return null;
  }
  const payload = verifyUserJwt(token);
  const session: CachedSession = payload?.userId
    ? { userId: payload.userId, role: payload.role, roles: payload.roles }
    : null;
  _sessionCache.set(socketId, session);
  return session;
}

/**
 * Pending ride-room buffers: while a socket is in the async authorization
 * window for a ride room, outbound rider:location payloads destined for that
 * room are buffered here so they are not silently dropped.
 * Key: `${socketId}::${roomName}` → array of payloads to replay.
 */
const _pendingRideJoins = new Map<string, unknown[]>();

function bufferKey(socketId: string, room: string): string {
  return `${socketId}::${room}`;
}

/* ── JWT helpers ── */
function extractBearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function getTokenFromHandshake(
  headers: Record<string, string | string[] | undefined>,
  auth: Record<string, unknown>,
): string | null {
  return (
    extractBearerToken(headers["authorization"]) ??
    (typeof auth["token"] === "string" ? auth["token"] : null)
  );
}

/* ── Room authorization ── */

function isAuthorizedForAdminFleet(
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>,
  auth: Record<string, unknown>,
): boolean {
  const candidates: Array<string | undefined> = [
    query["adminToken"] as string | undefined,
    auth["adminToken"] as string | undefined,
    auth["token"] as string | undefined,
    Array.isArray(headers["x-admin-token"]) ? headers["x-admin-token"][0] : headers["x-admin-token"] as string | undefined,
  ];
  for (const token of candidates) {
    if (!token) continue;
    if (verifyAdminJwt(token)) return true;
    try {
      const payload = verifyAccessToken(token);
      if (payload && (payload.role === "super" || payload.role === "manager" || payload.role === "support")) return true;
    } catch { /* not a v2 token */ }
  }
  const bearer = extractBearerToken(headers["authorization"]);
  if (bearer) {
    const payload = verifyUserJwt(bearer);
    if (payload && (payload.role === "admin" || payload.roles?.includes("admin"))) return true;
    try {
      const v2 = verifyAccessToken(bearer);
      if (v2 && (v2.role === "super" || v2.role === "manager" || v2.role === "support")) return true;
    } catch { /* not a v2 token */ }
  }
  return false;
}

function isAuthorizedForVendorRoom(
  vendorId: string,
  socketId: string,
  headers: Record<string, string | string[] | undefined>,
  auth: Record<string, unknown>,
): boolean {
  const bearer = getTokenFromHandshake(headers, auth);
  const session = getCachedSession(socketId, bearer);
  if (!session) return false;
  return session.userId === vendorId && session.role === "vendor";
}

/** Verify user is a participant of an order (customer or assigned rider) */
async function isAuthorizedForOrderRoom(
  orderId: string,
  headers: Record<string, string | string[] | undefined>,
  auth: Record<string, unknown>,
): Promise<boolean> {
  const bearer = getTokenFromHandshake(headers, auth);
  if (!bearer) return false;
  const payload = verifyUserJwt(bearer);
  if (!payload) return false;
  const userId = payload.userId;

  try {
    /* Check mart/food orders */
    const [order] = await db
      .select({ userId: ordersTable.userId, riderId: ordersTable.riderId })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (order && (order.userId === userId || order.riderId === userId)) return true;

    /* Check parcel bookings */
    const [parcel] = await db
      .select({ userId: parcelBookingsTable.userId, riderId: parcelBookingsTable.riderId })
      .from(parcelBookingsTable)
      .where(eq(parcelBookingsTable.id, orderId))
      .limit(1);
    if (parcel && (parcel.userId === userId || parcel.riderId === userId)) return true;

    /* Check pharmacy orders */
    const [pharmacy] = await db
      .select({ userId: pharmacyOrdersTable.userId, riderId: pharmacyOrdersTable.riderId })
      .from(pharmacyOrdersTable)
      .where(eq(pharmacyOrdersTable.id, orderId))
      .limit(1);
    if (pharmacy && (pharmacy.userId === userId || pharmacy.riderId === userId)) return true;
  } catch {
    /* DB failure → deny */
  }

  return false;
}

/** Verify user is a participant of the ride (customer, assigned rider, or active order rider/vendor) */
async function isAuthorizedForRideRoom(
  rideId: string,
  headers: Record<string, string | string[] | undefined>,
  auth: Record<string, unknown>,
): Promise<boolean> {
  const bearer = getTokenFromHandshake(headers, auth);
  if (!bearer) return false;
  const payload = verifyUserJwt(bearer);
  if (!payload) return false;
  const userId = payload.userId;

  try {
    /* Check ride table: booking customer (userId) or assigned rider */
    const [ride] = await db
      .select({ userId: ridesTable.userId, riderId: ridesTable.riderId })
      .from(ridesTable)
      .where(eq(ridesTable.id, rideId))
      .limit(1);

    if (ride) {
      if (ride.userId === userId || ride.riderId === userId) return true;
    }

    /* Check orders table: rider or vendor for delivery orders that share this ride context */
    const [order] = await db
      .select({ riderId: ordersTable.riderId, vendorId: ordersTable.vendorId })
      .from(ordersTable)
      .where(and(
        eq(ordersTable.id, rideId),
        or(
          eq(ordersTable.riderId, userId),
          eq(ordersTable.vendorId, userId),
        ),
      ))
      .limit(1);

    if (order) return true;
  } catch {
    /* DB failure → deny */
  }

  return false;
}

async function isAuthorizedForVanRoom(room: string, userId: string): Promise<boolean> {
  try {
    const parts = room.split(":");
    if (parts.length < 3) return false;
    const scheduleId = parts[1]!;
    const date = parts[2]!;

    const [driverMatch] = await db
      .select({ id: vanSchedulesTable.id })
      .from(vanSchedulesTable)
      .where(and(eq(vanSchedulesTable.id, scheduleId), eq(vanSchedulesTable.driverId, userId)))
      .limit(1);
    if (driverMatch) return true;

    const [bookingMatch] = await db
      .select({ id: vanBookingsTable.id })
      .from(vanBookingsTable)
      .where(and(
        eq(vanBookingsTable.scheduleId, scheduleId),
        eq(vanBookingsTable.travelDate, date),
        eq(vanBookingsTable.userId, userId),
        sql`${vanBookingsTable.status} NOT IN ('cancelled')`,
      ))
      .limit(1);
    return !!bookingMatch;
  } catch {
    return false;
  }
}

async function isAuthorizedForConversationRoom(convId: string, userId: string): Promise<boolean> {
  try {
    const [conv] = await db
      .select({ p1: conversationsTable.participant1Id, p2: conversationsTable.participant2Id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .limit(1);
    if (!conv) return false;
    return conv.p1 === userId || conv.p2 === userId;
  } catch {
    return false;
  }
}

function buildAllowedOrigins(): string | string[] {
  if (process.env.NODE_ENV !== "production") return "*";
  const explicit = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
  if (explicit.length > 0) return explicit;
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").filter(Boolean);
  const origins = replitDomains.flatMap(d => [`https://${d.trim()}`, `http://${d.trim()}`]);
  return origins.length > 0 ? origins : "*";
}

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  const isDev = process.env.NODE_ENV !== "production";
  const allowedOrigins = buildAllowedOrigins();
  _io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: !isDev,
    },
    path: "/api/socket.io",
    transports: ["polling", "websocket"],
  });

  _io.on("connection", (socket) => {
    const headers = socket.handshake.headers as Record<string, string | string[] | undefined>;
    const query = socket.handshake.query as Record<string, unknown>;
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;

    /* Auto-join non-ride rooms from the connection query string (synchronous auth) */
    const rooms = query["rooms"] as string | undefined;
    if (rooms) {
      const roomList = rooms.split(",").map(r => r.trim()).filter(Boolean);
      for (const room of roomList) {
        if (room === "admin-fleet") {
          if (isAuthorizedForAdminFleet(headers, query, auth)) {
            socket.join(room);
          } else {
            logger.debug({ socketId: socket.id, room }, "Socket denied admin-fleet (unauthorized)");
          }
        } else if (room.startsWith("vendor:")) {
          const vendorId = room.slice("vendor:".length);
          if (isAuthorizedForVendorRoom(vendorId, socket.id, headers, auth)) {
            socket.join(room);
          } else {
            logger.debug({ socketId: socket.id, room }, "Socket denied vendor room (unauthorized)");
          }
        } else if (room.startsWith("ride:")) {
          /* Ride rooms require async DB lookup — buffer outbound emits during authorization */
          const rideId = room.slice("ride:".length);
          const key = bufferKey(socket.id, room);
          _pendingRideJoins.set(key, []);
          isAuthorizedForRideRoom(rideId, headers, auth).then(ok => {
            const buffered = _pendingRideJoins.get(key) ?? [];
            _pendingRideJoins.delete(key);
            if (ok) {
              socket.join(room);
              for (const payload of buffered) {
                socket.emit("rider:location", payload);
              }
            } else {
              logger.debug({ socketId: socket.id, room }, "Socket denied ride room (not a participant)");
            }
          }).catch((e: Error) => { _pendingRideJoins.delete(key); logger.warn({ socketId: socket.id, room, err: e.message }, "[socketio] handshake ride room auth check failed"); });
        } else if (room.startsWith("order:")) {
          const orderId = room.slice("order:".length);
          isAuthorizedForOrderRoom(orderId, headers, auth).then(ok => {
            if (ok) {
              socket.join(room);
            } else {
              logger.debug({ socketId: socket.id, room }, "Socket denied order room (not a participant)");
            }
          }).catch((e: Error) => logger.warn({ socketId: socket.id, room, err: e.message }, "[socketio] order room auth check failed"));
        } else if (room.startsWith("conversation:")) {
          const convId = room.slice("conversation:".length);
          const bearer2 = getTokenFromHandshake(headers, auth);
          const sess2 = getCachedSession(socket.id, bearer2);
          if (sess2?.userId) {
            isAuthorizedForConversationRoom(convId, sess2.userId).then(ok => {
              if (ok) socket.join(room);
            }).catch(() => {});
          }
        } else if (room.startsWith("van:")) {
          const vanBearer = getTokenFromHandshake(headers, auth);
          const vanSess = getCachedSession(socket.id, vanBearer);
          if (vanSess?.userId) {
            isAuthorizedForVanRoom(room, vanSess.userId).then(ok => {
              if (ok) {
                socket.join(room);
                logger.debug({ socketId: socket.id, room }, "Socket joined van room");
              }
            }).catch(() => {});
          }
        }
      }
    }

    /* Auto-join personal rooms for all authenticated users.
       Also primes the session cache for this connection. */
    const userToken = getTokenFromHandshake(headers, auth);
    const cachedSession = getCachedSession(socket.id, userToken);
    if (cachedSession?.userId) {
      socket.join(`rider:${cachedSession.userId}`);
      socket.join(`user:${cachedSession.userId}`);
    }

    /* Heartbeat: rider sends rider:heartbeat with batteryLevel, coordinates, isOnline status.
       Server relays the heartbeat to admin-fleet AND persists batteryLevel, lastSeen, lastActive,
       coordinates, and isOnline to DB — all fire-and-forget so the socket never blocks. */
    socket.on("rider:heartbeat", (payload: { batteryLevel?: number; isOnline?: boolean; latitude?: number; longitude?: number }) => {
      const riderPay = cachedSession;
      if (!riderPay?.userId || riderPay.role !== "rider") return;
      const batteryLevel = typeof payload?.batteryLevel === "number" ? payload.batteryLevel : null;
      const isOnline = payload?.isOnline !== false;
      const now = new Date();

      const hasCoords = typeof payload?.latitude === "number" && typeof payload?.longitude === "number"
        && isFinite(payload.latitude) && isFinite(payload.longitude);

      /* 1. Update live_locations: battery level + lastSeen timestamp + coordinates when available */
      const liveLocationUpdate: Record<string, unknown> = {
        batteryLevel: batteryLevel ?? undefined,
        lastSeen: now,
        updatedAt: now,
      };
      if (hasCoords) {
        liveLocationUpdate.latitude = String(payload!.latitude);
        liveLocationUpdate.longitude = String(payload!.longitude);
      }
      db.update(liveLocationsTable)
        .set(liveLocationUpdate)
        .where(eq(liveLocationsTable.userId, riderPay.userId))
        .catch((e: Error) => logger.warn({ riderId: riderPay.userId, err: e.message }, "[socketio/heartbeat] live_locations update failed"));

      /* 2. Update users: isOnline flag + lastActive timestamp so the ghost-rider
            cleanup timer correctly uses lastActive as the freshness signal. */
      db.update(usersTable)
        .set({ isOnline, lastActive: now, updatedAt: now })
        .where(eq(usersTable.id, riderPay.userId))
        .catch((e: Error) => logger.warn({ riderId: riderPay.userId, err: e.message }, "[socketio/heartbeat] users isOnline update failed"));

      _io!.to("admin-fleet").emit("rider:heartbeat", {
        userId: riderPay.userId,
        batteryLevel,
        isOnline,
        sentAt: now.toISOString(),
        ...(hasCoords ? { latitude: payload!.latitude, longitude: payload!.longitude } : {}),
      });
    });

    /* SOS relay: rider sends rider:sos event, server broadcasts to admin-fleet */
    socket.on("rider:sos", (payload: { latitude?: number; longitude?: number; rideId?: string | null }) => {
      /* Use cached session — no redundant JWT verification */
      if (!cachedSession?.userId || cachedSession.role !== "rider") return;
      if (typeof payload?.latitude !== "number" || typeof payload?.longitude !== "number") return;
      /* Rebroadcast to admin-fleet with enriched payload */
      _io!.to("admin-fleet").emit("rider:sos", {
        userId: cachedSession.userId,
        name: "Rider",
        phone: null,
        latitude: payload.latitude,
        longitude: payload.longitude,
        rideId: payload.rideId ?? null,
        sentAt: new Date().toISOString(),
      });
    });

    /* Admin chat relay: admin sends message to specific rider */
    socket.on("admin:chat", (payload: { riderId: string; message: string }) => {
      if (!payload?.riderId || typeof payload.message !== "string") return;
      /* Only allow admins to send chat messages */
      if (!isAuthorizedForAdminFleet(headers, query, auth)) return;
      _io!.to(`rider:${payload.riderId}`).emit("admin:chat", {
        message: payload.message,
        sentAt: new Date().toISOString(),
        from: "admin",
      });
    });

    /* Rider reply chat relay: rider sends message back to admin */
    socket.on("rider:chat", (payload: { message: string }) => {
      /* Use cached session — no redundant JWT verification */
      if (!cachedSession?.userId || cachedSession.role !== "rider") return;
      if (typeof payload?.message !== "string" || !payload.message.trim()) return;
      /* Broadcast the rider's reply to all admin-fleet clients */
      _io!.to("admin-fleet").emit("rider:chat", {
        userId: cachedSession.userId,
        message: payload.message.trim(),
        sentAt: new Date().toISOString(),
        from: "rider",
      });
    });


    /* Join event: client can request additional rooms after connect */
    socket.on("join", (room: string) => {
      if (typeof room !== "string") return;

      if (room === "admin-fleet") {
        if (isAuthorizedForAdminFleet(headers, query, auth)) {
          socket.join(room);
          logger.debug({ socketId: socket.id, room }, "Socket joined admin-fleet");
        } else {
          logger.debug({ socketId: socket.id, room }, "Socket join denied admin-fleet (unauthorized)");
        }
      } else if (room.startsWith("vendor:")) {
        const vendorId = room.slice("vendor:".length);
        if (isAuthorizedForVendorRoom(vendorId, socket.id, headers, auth)) {
          socket.join(room);
          logger.debug({ socketId: socket.id, room }, "Socket joined vendor room");
        } else {
          logger.debug({ socketId: socket.id, room }, "Socket join denied vendor room (unauthorized)");
        }
      } else if (room.startsWith("ride:")) {
        const rideId = room.slice("ride:".length);
        const key = bufferKey(socket.id, room);
        _pendingRideJoins.set(key, []);
        isAuthorizedForRideRoom(rideId, headers, auth).then(ok => {
          const buffered = _pendingRideJoins.get(key) ?? [];
          _pendingRideJoins.delete(key);
          if (ok) {
            socket.join(room);
            for (const payload of buffered) {
              socket.emit("rider:location", payload);
            }
            logger.debug({ socketId: socket.id, room }, "Socket joined ride room");
          } else {
            logger.debug({ socketId: socket.id, room }, "Socket join denied ride room (not a participant)");
          }
        }).catch((e: Error) => { _pendingRideJoins.delete(key); logger.warn({ socketId: socket.id, room, err: e.message }, "[socketio] ride room auth check failed"); });
      } else if (room.startsWith("order:")) {
        const orderId = room.slice("order:".length);
        isAuthorizedForOrderRoom(orderId, headers, auth).then(ok => {
          if (ok) {
            socket.join(room);
            logger.debug({ socketId: socket.id, room }, "Socket joined order room");
          } else {
            logger.debug({ socketId: socket.id, room }, "Socket join denied order room (not a participant)");
          }
        }).catch((e: Error) => logger.warn({ socketId: socket.id, room, err: e.message }, "[socketio] order room join auth check failed"));
      } else if (room.startsWith("conversation:")) {
        const convId = room.slice("conversation:".length);
        if (cachedSession?.userId) {
          isAuthorizedForConversationRoom(convId, cachedSession.userId).then(ok => {
            if (ok) socket.join(room);
          }).catch(() => {});
        }
      }
    });

    /* ── Communication system events ── */
    socket.on("comm:typing:start", async (payload: { conversationId: string; userId: string }) => {
      if (!cachedSession?.userId || cachedSession.userId !== payload?.userId || !payload?.conversationId) return;
      const ok = await isAuthorizedForConversationRoom(payload.conversationId, cachedSession.userId).catch(() => false);
      if (!ok) return;
      socket.to(`conversation:${payload.conversationId}`).emit("comm:typing:start", { userId: payload.userId, conversationId: payload.conversationId });
    });

    socket.on("comm:typing:stop", async (payload: { conversationId: string; userId: string }) => {
      if (!cachedSession?.userId || cachedSession.userId !== payload?.userId || !payload?.conversationId) return;
      const ok = await isAuthorizedForConversationRoom(payload.conversationId, cachedSession.userId).catch(() => false);
      if (!ok) return;
      socket.to(`conversation:${payload.conversationId}`).emit("comm:typing:stop", { userId: payload.userId, conversationId: payload.conversationId });
    });

    socket.on("comm:call:offer", async (payload: { callId: string; targetUserId: string; sdp: unknown }) => {
      if (!cachedSession?.userId || !payload?.callId || !payload?.targetUserId) return;
      try {
        const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.id, payload.callId), or(eq(callLogsTable.callerId, cachedSession.userId), eq(callLogsTable.calleeId, cachedSession.userId)))).limit(1);
        if (!call) return;
      } catch { return; }
      _io!.to(`user:${payload.targetUserId}`).emit("comm:call:offer", { callId: payload.callId, sdp: payload.sdp, callerId: cachedSession.userId });
    });

    socket.on("comm:call:answer", async (payload: { callId: string; targetUserId: string; sdp: unknown }) => {
      if (!cachedSession?.userId || !payload?.callId || !payload?.targetUserId) return;
      try {
        const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.id, payload.callId), or(eq(callLogsTable.callerId, cachedSession.userId), eq(callLogsTable.calleeId, cachedSession.userId)))).limit(1);
        if (!call) return;
      } catch { return; }
      _io!.to(`user:${payload.targetUserId}`).emit("comm:call:answer", { callId: payload.callId, sdp: payload.sdp });
    });

    socket.on("comm:call:ice-candidate", async (payload: { callId: string; targetUserId: string; candidate: unknown }) => {
      if (!cachedSession?.userId || !payload?.callId || !payload?.targetUserId) return;
      try {
        const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.id, payload.callId), or(eq(callLogsTable.callerId, cachedSession.userId), eq(callLogsTable.calleeId, cachedSession.userId)))).limit(1);
        if (!call) return;
      } catch { return; }
      _io!.to(`user:${payload.targetUserId}`).emit("comm:call:ice-candidate", { callId: payload.callId, candidate: payload.candidate });
    });

    socket.on("comm:call:end", async (payload: { callId: string; targetUserId: string }) => {
      if (!cachedSession?.userId || !payload?.callId || !payload?.targetUserId) return;
      try {
        const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.id, payload.callId), or(eq(callLogsTable.callerId, cachedSession.userId), eq(callLogsTable.calleeId, cachedSession.userId)))).limit(1);
        if (!call) return;
      } catch { return; }
      _io!.to(`user:${payload.targetUserId}`).emit("comm:call:ended", { callId: payload.callId });
    });

    socket.on("comm:message:delivered", async (payload: { messageId: string; senderId: string }) => {
      if (!cachedSession?.userId || !payload?.messageId || !payload?.senderId) return;
      try {
        const [msg] = await db.select({ senderId: chatMessagesTable.senderId, conversationId: chatMessagesTable.conversationId }).from(chatMessagesTable).where(eq(chatMessagesTable.id, payload.messageId)).limit(1);
        if (!msg || msg.senderId !== payload.senderId) return;
        const ok = await isAuthorizedForConversationRoom(msg.conversationId, cachedSession.userId);
        if (!ok) return;
        if (msg.senderId === cachedSession.userId) return;
        await db.update(chatMessagesTable)
          .set({ deliveryStatus: "delivered", updatedAt: new Date() })
          .where(and(eq(chatMessagesTable.id, payload.messageId), sql`${chatMessagesTable.deliveryStatus} = 'sent'`));
        _io!.to(`user:${payload.senderId}`).emit("comm:message:delivered", { messageId: payload.messageId });
      } catch {}
    });

    socket.on("leave", (room: string) => {
      socket.leave(room);
    });

    socket.on("disconnect", () => {
      /* Clean up any pending ride-room buffers for this socket */
      const prefix = `${socket.id}::`;
      for (const key of _pendingRideJoins.keys()) {
        if (key.startsWith(prefix)) _pendingRideJoins.delete(key);
      }

      /* Evict session cache entry — no longer needed after disconnect */
      _sessionCache.delete(socket.id);

      /* Use the already-resolved session (cached from connection handshake) */
      if (cachedSession?.userId && cachedSession.role === "rider") {
        const riderId = cachedSession.userId;
        const deleteWithRetry = (attempt: number) => {
          db.delete(liveLocationsTable)
            .where(eq(liveLocationsTable.userId, riderId))
            .catch((err: unknown) => {
              if (attempt < 3) {
                setTimeout(() => deleteWithRetry(attempt + 1), 1000 * attempt);
              } else {
                logger.warn({ err, riderId }, "Failed to clean up stale live_location on disconnect after retries");
              }
            });
        };
        deleteWithRetry(1);
        _riderLocLastEmit.delete(riderId);
      }

      logger.debug({ socketId: socket.id }, "Socket disconnected");
    });
  });

  /* ── Ghost Rider Expiry: runs every 5 minutes ─────────────────────────────
     1. Finds riders whose last heartbeat/location update is older than 5 min.
     2. Emits rider:offline to admin-fleet for each (before deleting from DB).
     3. Sets users.is_online = false so the DB stays consistent.
     4. Deletes from live_locations to remove ghost markers from the map.
  ── */
  const STALE_LOC_TTL_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_LOC_TTL_MS);

      /* Step 1: Find stale rider entries before deleting */
      const staleRiders = await db
        .select({ userId: liveLocationsTable.userId, batteryLevel: liveLocationsTable.batteryLevel })
        .from(liveLocationsTable)
        .where(lt(liveLocationsTable.updatedAt, cutoff));

      if (staleRiders.length === 0) return;

      const now = new Date().toISOString();

      /* Step 2: Emit rider:offline for each stale rider to admin-fleet */
      for (const rider of staleRiders) {
        _io?.to("admin-fleet").emit("rider:offline", {
          userId: rider.userId,
          isOnline: false,
          reason: "heartbeat_timeout",
          updatedAt: now,
        });
        /* Clean per-rider throttle map to release memory */
        _riderLocLastEmit.delete(rider.userId);
      }

      /* Step 3: Mark users.is_online = false AND clear lastActive in DB for all stale riders.
         Clearing lastActive prevents stale timestamps from causing false "recently active"
         readings in the Admin Panel after a rider drops off without a clean disconnect. */
      const staleIds = staleRiders.map(r => r.userId);
      await db
        .update(usersTable)
        .set({ isOnline: false, lastActive: null, updatedAt: new Date() })
        .where(sql`${usersTable.id} = ANY(ARRAY[${sql.join(staleIds.map(id => sql`${id}`), sql`, `)}]::text[])`);

      /* Step 4: Delete stale rows from live_locations */
      const result = await db
        .delete(liveLocationsTable)
        .where(lt(liveLocationsTable.updatedAt, cutoff));

      if (result.rowCount && result.rowCount > 0) {
        logger.info({ cleaned: result.rowCount, riders: staleIds }, "Ghost rider cleanup: removed stale live_locations and emitted rider:offline");
      }
    } catch (err) {
      logger.warn({ err }, "Ghost rider cleanup failed");
    }
  }, STALE_LOC_TTL_MS);

  /* ── Weekly location_history cleanup: runs every Sunday at midnight (server local time) ──
     Uses a 1-hour polling interval that checks day-of-week (0=Sunday) and hour (0 = midnight).
     Deletes all location_history rows older than 60 days to keep the table lightweight.
     A _lastCleanupRun guard ensures it fires at most once per Sunday even if the interval
     drifts slightly across the midnight boundary. */
  let _lastHistoryCleanup = 0;
  const HISTORY_RETENTION_DAYS = 60;

  setInterval(async () => {
    const now = new Date();
    const isSundayMidnight = now.getDay() === 0 && now.getHours() === 0;
    if (!isSundayMidnight) return;

    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (_lastHistoryCleanup >= todayMidnight) return;
    _lastHistoryCleanup = todayMidnight;

    try {
      const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const result = await db
        .delete(locationHistoryTable)
        .where(lte(locationHistoryTable.createdAt, cutoff));
      logger.info(
        { deleted: result.rowCount ?? 0, olderThanDays: HISTORY_RETENTION_DAYS },
        "[cron] location_history weekly cleanup complete",
      );
    } catch (err) {
      logger.warn({ err }, "[cron] location_history weekly cleanup failed");
    }
  }, 60 * 60 * 1000);

  logger.info("Socket.io initialized");
  return _io;
}

export function getIO(): SocketIOServer | null {
  return _io;
}

export function emitRiderLocation(payload: {
  userId: string;
  name?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  batteryLevel?: number;
  action?: string | null;
  rideId?: string | null;
  vendorId?: string | null;
  orderId?: string | null;
  vehicleType?: string | null;
  currentTripId?: string | null;
  updatedAt: string;
}) {
  if (!_io) return;

  /* ── Server-side broadcast throttle: max 1 emit per rider per RIDER_LOC_THROTTLE_MS ──
     Prevents downstream clients (Admin Panel, Rider App) from receiving
     rapid-fire updates that cause map flicker. */
  const now = Date.now();
  const last = _riderLocLastEmit.get(payload.userId) ?? 0;
  if (now - last < RIDER_LOC_THROTTLE_MS) return;
  _riderLocLastEmit.set(payload.userId, now);

  _io.to("admin-fleet").emit("rider:location", payload);
  if (payload.rideId) {
    const room = `ride:${payload.rideId}`;
    _io.to(room).emit("rider:location", payload);
    /* Feed any sockets still pending authorization for this ride room */
    for (const [key, buf] of _pendingRideJoins) {
      if (key.endsWith(`::${room}`)) {
        buf.push(payload);
      }
    }
  }
  if (payload.vendorId) {
    _io.to(`vendor:${payload.vendorId}`).emit("rider:location", payload);
  }
  if (payload.orderId) {
    _io.to(`order:${payload.orderId}`).emit("rider:location", payload);
  }
}

export function emitRiderForVendor(vendorId: string, payload: {
  userId: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
}) {
  if (!_io) return;
  _io.to(`vendor:${vendorId}`).emit("rider:location", payload);
}

export function emitCustomerLocation(payload: {
  userId: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
}) {
  if (!_io) return;
  _io.to("admin-fleet").emit("customer:location", payload);
}

export function emitRiderSOS(payload: {
  userId: string;
  name: string;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  rideId?: string | null;
  sentAt: string;
}) {
  if (!_io) return;
  _io.to("admin-fleet").emit("rider:sos", payload);
}

export function emitAdminChatReply(riderId: string, payload: {
  message: string;
  sentAt: string;
  from: "admin";
}) {
  if (!_io) return;
  _io.to(`rider:${riderId}`).emit("admin:chat", payload);
}

export function emitRiderStatus(payload: {
  userId: string;
  isOnline: boolean;
  name?: string;
  batteryLevel?: number | null;
  updatedAt: string;
}) {
  if (!_io) return;
  _io.to("admin-fleet").emit("rider:status", payload);
}

/**
 * Push a `rider:new-request` event directly to a specific rider's socket room
 * so their Home screen refreshes instantly (no need to wait for polling interval).
 * Payload mirrors what the rider needs to surface the notification UI.
 */
export function emitRiderNewRequest(riderId: string, payload: {
  type: "order" | "ride" | "parcel" | "order_ready";
  requestId: string;
  summary?: string;
}) {
  if (!_io) return;
  _io.to(`rider:${riderId}`).emit("rider:new-request", payload);
}

/* ── SOS lifecycle events ── broadcast to all admin-fleet sessions ── */

export type SosAlertPayload = {
  id: string;
  userId: string;
  title: string;
  body: string;
  link: string | null | undefined;
  sosStatus: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  createdAt: string;
};

export function emitSosNew(payload: SosAlertPayload) {
  if (!_io) return;
  _io.to("admin-fleet").emit("sos:new", payload);
}

export function emitSosAcknowledged(payload: SosAlertPayload) {
  if (!_io) return;
  _io.to("admin-fleet").emit("sos:acknowledged", payload);
}

export function emitSosResolved(payload: SosAlertPayload) {
  if (!_io) return;
  _io.to("admin-fleet").emit("sos:resolved", payload);
}

export function emitRideDispatchUpdate(payload: {
  rideId: string;
  action: string;
  status: string;
}) {
  if (!_io) return;
  _io.to("admin-fleet").emit("ride:dispatch-update", payload);
}

export function emitRideOtp(customerId: string, rideId: string, otp: string) {
  if (!_io) return;
  _io.to(`user:${customerId}`).to(`ride:${rideId}`).emit("ride:otp", { rideId, otp });
}

export function emitVanLocation(scheduleId: string, date: string, payload: {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  updatedAt: string;
}) {
  if (!_io) return;
  const room = `van:${scheduleId}:${date}`;
  _io.to(room).emit("van:location", payload);
}

export function emitVanTripUpdate(scheduleId: string, date: string, payload: {
  event: string;
  data?: unknown;
}) {
  if (!_io) return;
  const room = `van:${scheduleId}:${date}`;
  _io.to(room).emit("van:trip-update", payload);
}

export function getConnectedClientCount(): number {
  if (!_io) return 0;
  return _io.sockets.sockets.size;
}

