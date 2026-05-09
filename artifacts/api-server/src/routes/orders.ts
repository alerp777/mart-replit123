import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { ordersTable, usersTable, walletTransactionsTable, promoCodesTable, productsTable, productVariantsTable, liveLocationsTable, notificationsTable, offersTable, offerRedemptionsTable, idempotencyKeysTable, parcelBookingsTable, ridesTable, pharmacyOrdersTable, productStockHistoryTable, orderAuditLogTable } from "@workspace/db/schema";
import { eq, and, gte, count, sum, desc, SQL, sql, inArray, ilike, isNull } from "drizzle-orm";
import { generateId } from "../lib/id.js";
import { getPlatformSettings } from "./admin.js";
import { addSecurityEvent, addAuditEntry, getClientIp, getCachedSettings, customerAuth, idorGuard } from "../middleware/security.js";
import { adminAuth, type AdminRequest } from "./admin-shared.js";
import { verifyOwnership } from "../middleware/verifyOwnership.js";
import { getIO, emitRiderNewRequest } from "../lib/socketio.js";
import { calcDeliveryFee, calcGst, calcCodFee } from "../lib/fees.js";
import { isInServiceZone } from "../lib/geofence.js";
import { checkDeliveryEligibility } from "../lib/delivery-access.js";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendForbidden, sendValidationError, sendErrorWithData } from "../lib/response.js";
import { emitWebhookEvent } from "../lib/webhook-emitter.js";
import { sendPushToUser } from "../lib/webpush.js";
import { IDEMPOTENCY_TTL_MS } from "../lib/cleanupIdempotencyKeys.js";

const router: IRouter = Router();

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/* ── Decrement stock for all items in an order (inside a transaction) ── */
async function decrementStock(
  tx: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0],
  items: Array<{ productId?: string; variantId?: string; quantity: number }>,
  orderId: string,
): Promise<void> {
  for (const item of items) {
    const qty = Number(item.quantity) || 1;
    if (item.variantId) {
      /* Variants: lock row, check stock, decrement — no silent floor */
      const locked = await tx.execute(sql`
        SELECT id, stock FROM product_variants WHERE id = ${item.variantId} FOR UPDATE
      `);
      const variantRow = (locked.rows ?? [])[0] as { id: string; stock: number | null } | undefined;
      if (variantRow && variantRow.stock !== null) {
        if (variantRow.stock < qty) {
          throw Object.assign(
            new Error(`Insufficient stock for variant. Available: ${variantRow.stock}, Required: ${qty}`),
            { code: "INSUFFICIENT_STOCK", outOfStockItems: [{ variantId: item.variantId }] },
          );
        }
        await tx.execute(sql`
          UPDATE product_variants
          SET stock = stock - ${qty},
              in_stock = CASE WHEN stock - ${qty} <= 0 THEN false ELSE in_stock END
          WHERE id = ${item.variantId}
        `);
      }
    }
    if (item.productId) {
      /* Lock the row at DB level — concurrent transactions queue behind this lock */
      const locked = await tx.execute(sql`
        SELECT id, stock, name, vendor_id FROM products WHERE id = ${item.productId} FOR UPDATE
      `);
      const row = (locked.rows ?? [])[0] as { id: string; stock: number | null; name: string; vendor_id: string } | undefined;

      if (row && row.stock !== null) {
        if (row.stock < qty) {
          /* Reject — do NOT silently floor to 0 for order placement */
          throw Object.assign(
            new Error(`Insufficient stock for "${row.name}". Available: ${row.stock}, Required: ${qty}`),
            { code: "INSUFFICIENT_STOCK", outOfStockItems: [{ productId: item.productId, name: row.name, available: row.stock, required: qty }] },
          );
        }
        const newStock = row.stock - qty;
        await tx.execute(sql`
          UPDATE products
          SET stock = ${newStock},
              in_stock = CASE WHEN ${newStock} <= 0 THEN false ELSE in_stock END,
              updated_at = NOW()
          WHERE id = ${item.productId}
        `);
        await tx.insert(productStockHistoryTable).values({
          id: generateId(),
          productId: item.productId,
          vendorId: row.vendor_id,
          previousStock: row.stock,
          newStock,
          quantityDelta: -(qty),
          reason: "order",
          orderId,
          source: `order:${orderId}`,
        }).catch(() => {});
      }
    }
  }
}

const MAX_ITEM_QUANTITY = 99;

function broadcastNewOrder(order: ReturnType<typeof mapOrder>, vendorId?: string | null) {
  /* Socket broadcast — only when socket.io is initialised. */
  const io = getIO();
  if (io) {
    io.to("admin-fleet").emit("order:new", order);
    if (vendorId) {
      io.to(`vendor:${vendorId}`).emit("order:new", order);
    }
  }

  /* FCM / VAPID push — decoupled from socket availability so vendor push
     remains reliable even if the socket layer hasn't started yet.
     data.orderId lets the vendor app deep-link to /orders on tap.
     Stats are awaited asynchronously (fire-and-forget from the caller's
     perspective) so stale tokens are explicitly purged and logged on failure. */
  if (vendorId) {
    const itemCount = Array.isArray(order.items) ? order.items.length : 0;
    sendPushToUser(vendorId, {
      title: "📦 New Order",
      body: `New order · Rs. ${Number(order.total).toFixed(0)} · ${itemCount} item${itemCount !== 1 ? "s" : ""}`,
      tag: `new-order-${order.id}`,
      data: { orderId: order.id },
    }).then((stats) => {
      if (stats.noSubscriptions) {
        logger.info({ orderId: order.id, vendorId }, "[broadcast] vendor has no push subscriptions — push skipped");
      } else if (stats.stalePurged > 0) {
        logger.warn(
          { orderId: order.id, vendorId, attempted: stats.attempted, delivered: stats.delivered, stalePurged: stats.stalePurged },
          "[broadcast] stale vendor push tokens purged after new-order broadcast",
        );
      } else {
        logger.debug(
          { orderId: order.id, vendorId, attempted: stats.attempted, delivered: stats.delivered },
          "[broadcast] vendor push notification sent",
        );
      }
    }).catch((err: Error) =>
      logger.warn({ orderId: order.id, vendorId, err: err.message }, "[broadcast] vendor push notification failed — DB error fetching subscriptions"),
    );
  }
}

function broadcastOrderUpdate(order: ReturnType<typeof mapOrder>, vendorId?: string | null) {
  const io = getIO();
  if (!io) return;
  io.to("admin-fleet").emit("order:update", order);
  if (vendorId) {
    io.to(`vendor:${vendorId}`).emit("order:update", order);
  }
  if (order.riderId) {
    io.to(`rider:${order.riderId}`).emit("order:update", order);
  }
  /* Push status change to the customer in real-time so the app reflects
     admin/vendor updates instantly without waiting for the 10-second poll. */
  if (order.userId) {
    io.to(`user:${order.userId}`).emit("order:update", order);
  }
  /* Also emit to the order-specific room so open order-detail screens
     that joined order:{id} receive live status updates. */
  io.to(`order:${order.id}`).emit("order:update", order);
}

function broadcastWalletUpdate(userId: string, newBalance: number) {
  const io = getIO();
  if (!io) return;
  io.to(`user:${userId}`).emit("wallet:update", { balance: newBalance });
}

/**
 * After a new order is created, find all online riders (recently active within 10 min)
 * and push a socket event so their Home screen invalidates the requests query immediately.
 * This is fire-and-forget — never throws, never blocks the response.
 */
async function notifyOnlineRidersOfOrder(orderId: string, orderType: string): Promise<void> {
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const onlineRiders = await db
      .select({ userId: liveLocationsTable.userId })
      .from(liveLocationsTable)
      .innerJoin(usersTable, eq(liveLocationsTable.userId, usersTable.id))
      .where(and(
        eq(liveLocationsTable.role, "rider"),
        ilike(usersTable.roles, "%rider%"),
        eq(usersTable.isOnline, true),
        gte(liveLocationsTable.updatedAt, tenMinAgo),
      ));
    const failedRiderIds: string[] = [];
    for (const { userId } of onlineRiders) {
      try {
        emitRiderNewRequest(userId, { type: "order", requestId: orderId, summary: orderType });
      } catch (emitErr) {
        failedRiderIds.push(userId);
        logger.warn({ orderId, riderId: userId, err: (emitErr as Error).message }, "[notifyRiders] emit failed for rider on first attempt");
      }
    }
    if (failedRiderIds.length > 0) {
      logger.warn({ orderId, orderType, totalRiders: onlineRiders.length, failures: failedRiderIds.length }, "[notifyRiders] retrying failed rider notifications");
      await new Promise((r) => setTimeout(r, 500));
      let retryFailures = 0;
      for (const riderId of failedRiderIds) {
        try {
          emitRiderNewRequest(riderId, { type: "order", requestId: orderId, summary: orderType });
        } catch (retryErr) {
          retryFailures++;
          logger.error({ orderId, riderId, err: (retryErr as Error).message }, "[notifyRiders] retry also failed for rider — giving up");
        }
      }
      if (retryFailures > 0) {
        logger.error({ orderId, orderType, failedRiders: retryFailures, totalAttempted: failedRiderIds.length }, "[notifyRiders] some rider notifications failed after retry");
      }
    }
  } catch (err) {
    logger.error({ orderId, orderType, err: (err as Error).message, stack: (err as Error).stack }, "[notifyRiders] query-level failure, retrying entire broadcast");
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const onlineRiders = await db
        .select({ userId: liveLocationsTable.userId })
        .from(liveLocationsTable)
        .innerJoin(usersTable, eq(liveLocationsTable.userId, usersTable.id))
        .where(and(
          eq(liveLocationsTable.role, "rider"),
          ilike(usersTable.roles, "%rider%"),
          eq(usersTable.isOnline, true),
          gte(liveLocationsTable.updatedAt, tenMinAgo),
        ));
      for (const { userId } of onlineRiders) {
        try {
          emitRiderNewRequest(userId, { type: "order", requestId: orderId, summary: orderType });
        } catch (emitErr) {
          logger.error({ orderId, riderId: userId, err: (emitErr as Error).message }, "[notifyRiders] emit failed on full retry — giving up for rider");
        }
      }
    } catch (retryErr) {
      logger.error({ orderId, orderType, err: (retryErr as Error).message, stack: (retryErr as Error).stack }, "[notifyRiders] full retry also failed — giving up");
    }
  }
}


function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mapOrder(o: typeof ordersTable.$inferSelect, deliveryFee?: number, gstAmount?: number, codFee?: number) {
  return {
    id: o.id,
    userId: o.userId,
    type: o.type,
    items: o.items as object[],
    status: o.status,
    total: parseFloat(o.total),
    deliveryFee: deliveryFee ?? 0,
    gstAmount: gstAmount ?? 0,
    codFee: codFee ?? 0,
    deliveryAddress: o.deliveryAddress,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus ?? "pending",
    refundStatus: o.refundedAt ? "refunded"
      : o.paymentStatus === "refund_approved" ? "approved"
      : o.paymentStatus === "refund_requested" ? "requested"
      : null,
    riderId: o.riderId,
    riderName: o.riderName ?? null,
    riderPhone: o.riderPhone ?? null,
    vendorId: o.vendorId ?? null,
    estimatedTime: o.estimatedTime,
    proofPhotoUrl: o.proofPhotoUrl ?? null,
    txnRef: o.txnRef ?? null,
    customerLat: o.customerLat ? parseFloat(o.customerLat) : null,
    customerLng: o.customerLng ? parseFloat(o.customerLng) : null,
    gpsAccuracy: o.gpsAccuracy ?? null,
    gpsMismatch: o.gpsMismatch ?? false,
    deliveryLat: o.deliveryLat ? parseFloat(o.deliveryLat) : null,
    deliveryLng: o.deliveryLng ? parseFloat(o.deliveryLng) : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/* ── Promo code helper ─────────────────────────────────────────────────────── */
type ValidatePromoResult = {
  valid: boolean;
  discount: number;
  discountType: "pct" | "flat" | null;
  freeDelivery?: boolean;
  error?: string;
  promoId?: string;
  offerId?: string;
  maxDiscount?: number | null;
};

async function validatePromoCode(
  code: string,
  orderTotal: number,
  orderType: string,
  userId?: string,
): Promise<ValidatePromoResult> {
  const upperCode = code.toUpperCase().trim();
  const now = new Date();

  /* ── 1. Check new unified offers engine first ── */
  const [offer] = await db.select().from(offersTable)
    .where(and(eq(offersTable.code, upperCode), eq(offersTable.status, "live")))
    .limit(1);

  if (offer) {
    if (now < offer.startDate || now > offer.endDate) {
      return { valid: false, discount: 0, discountType: null, error: "This offer has expired." };
    }
    if (offer.usageLimit !== null && offer.usedCount >= offer.usageLimit) {
      return { valid: false, discount: 0, discountType: null, error: "This offer has reached its usage limit." };
    }
    const minAmt = parseFloat(String(offer.minOrderAmount ?? "0"));
    if (orderTotal < minAmt) {
      return { valid: false, discount: 0, discountType: null, error: `Minimum order Rs. ${minAmt} required for this offer.` };
    }
    const appliesTo = (offer.appliesTo ?? "all").toLowerCase().trim();
    if (appliesTo !== "all" && appliesTo !== orderType.toLowerCase().trim()) {
      return { valid: false, discount: 0, discountType: null, error: `This offer is valid only for ${appliesTo} orders.` };
    }

    /* ── Targeting rules enforcement ── */
    const rules = (offer.targetingRules ?? {}) as Record<string, unknown>;
    if (userId) {
      const [userRow] = await db.select({ createdAt: usersTable.createdAt }).from(usersTable)
        .where(eq(usersTable.id, userId)).limit(1);
      const isNewUser = userRow ? (Date.now() - userRow.createdAt.getTime()) < 30 * 24 * 60 * 60 * 1000 : false;
      if (rules.newUsersOnly && !isNewUser) {
        return { valid: false, discount: 0, discountType: null, error: "This offer is for new users only." };
      }
      const [orderCountRow] = await db.select({ c: count() }).from(ordersTable)
        .where(eq(ordersTable.userId, userId));
      const totalOrders = Number(orderCountRow?.c ?? 0);
      if (rules.returningUsersOnly && totalOrders === 0) {
        return { valid: false, discount: 0, discountType: null, error: "This offer is for returning customers only." };
      }
      if (rules.highValueUser) {
        const [spendRow] = await db.select({ s: sum(ordersTable.total) }).from(ordersTable)
          .where(eq(ordersTable.userId, userId));
        const totalSpend = parseFloat(String(spendRow?.s ?? "0"));
        if (totalSpend < 5000) {
          return { valid: false, discount: 0, discountType: null, error: "This offer is for high-value customers only." };
        }
      }

      /* ── Per-user usage limit enforcement (exclude bookmark records) ── */
      const usagePerUser = offer.usagePerUser ? Number(offer.usagePerUser) : null;
      if (usagePerUser !== null && usagePerUser > 0) {
        const [redemptionRow] = await db.select({ c: count() }).from(offerRedemptionsTable)
          .where(and(
            eq(offerRedemptionsTable.offerId, offer.id),
            eq(offerRedemptionsTable.userId, userId),
            sql`${offerRedemptionsTable.orderId} IS NOT NULL`,
          ));
        const userRedemptions = Number(redemptionRow?.c ?? 0);
        if (userRedemptions >= usagePerUser) {
          return { valid: false, discount: 0, discountType: null, error: `You have already used this offer the maximum allowed times (${usagePerUser}).` };
        }
      }
    }

    let discount = 0;
    let discountType: "pct" | "flat" = "flat";
    const freeDelivery = offer.freeDelivery ?? false;
    if (offer.discountPct) {
      discountType = "pct";
      discount = Math.round(orderTotal * parseFloat(String(offer.discountPct)) / 100);
      if (offer.maxDiscount) discount = Math.min(discount, parseFloat(String(offer.maxDiscount)));
    } else if (offer.discountFlat) {
      discount = parseFloat(String(offer.discountFlat));
    }
    discount = Math.min(discount, orderTotal);
    return { valid: true, discount, discountType, freeDelivery, offerId: offer.id, maxDiscount: offer.maxDiscount ? parseFloat(String(offer.maxDiscount)) : null };
  }

  /* ── 2. Fall back to legacy promo_codes ── */
  const [promo] = await db.select().from(promoCodesTable)
    .where(eq(promoCodesTable.code, upperCode)).limit(1);

  if (!promo)                                          return { valid: false, discount: 0, discountType: null, error: "Yeh promo code exist nahi karta." };
  if (!promo.isActive)                                 return { valid: false, discount: 0, discountType: null, error: "Yeh promo code active nahi hai." };
  if (promo.expiresAt && now > promo.expiresAt)        return { valid: false, discount: 0, discountType: null, error: "Yeh promo code expire ho gaya hai." };
  if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit)
    return { valid: false, discount: 0, discountType: null, error: "Yeh promo code apni limit reach kar chuka hai." };
  if (promo.minOrderAmount && orderTotal < parseFloat(String(promo.minOrderAmount)))
    return { valid: false, discount: 0, discountType: null, error: `Minimum order Rs. ${promo.minOrderAmount} hona chahiye is code ke liye.` };
  const ORDER_TYPE_ALIASES: Record<string, string[]> = {
    mart: ["mart", "grocery", "ajkmart"],
    grocery: ["grocery", "mart", "ajkmart"],
    ride: ["ride", "rides", "taxi"],
    school: ["school", "school_bus", "schoolbus"],
    parcel: ["parcel", "delivery", "courier"],
  };
  const normalizedType = orderType.toLowerCase().trim();
  const normalizedAppliesTo = (promo.appliesTo ?? "all").toLowerCase().trim();
  const typeAliases = ORDER_TYPE_ALIASES[normalizedType] ?? [normalizedType];
  const appliesToAliases = ORDER_TYPE_ALIASES[normalizedAppliesTo] ?? [normalizedAppliesTo];
  const typeMatches = normalizedAppliesTo === "all"
    || typeAliases.includes(normalizedAppliesTo)
    || appliesToAliases.includes(normalizedType);
  if (!typeMatches)
    return { valid: false, discount: 0, discountType: null, error: `Yeh code sirf ${promo.appliesTo} orders ke liye hai.` };

  let discount = 0;
  let discountType: "pct" | "flat" = "flat";
  if (promo.discountPct) {
    discountType = "pct";
    discount = Math.round(orderTotal * parseFloat(String(promo.discountPct)) / 100);
    if (promo.maxDiscount) discount = Math.min(discount, parseFloat(String(promo.maxDiscount)));
  } else if (promo.discountFlat) {
    discount = parseFloat(String(promo.discountFlat));
  }
  discount = Math.min(discount, orderTotal);
  return { valid: true, discount, discountType, promoId: promo.id, maxDiscount: promo.maxDiscount ? parseFloat(String(promo.maxDiscount)) : null };
}

/* ── POST /orders/validate-cart — Validate cart items against DB ── */
router.post("/validate-cart", async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    sendSuccess(res, { valid: true, items: [], removed: [], priceChanges: [] });
    return;
  }

  const productIds = items.map((it: Record<string, unknown>) => it.productId).filter(Boolean) as string[];
  if (productIds.length === 0) {
    sendSuccess(res, { valid: true, items, removed: [], priceChanges: [] });
    return;
  }

  const dbProducts = await db.select({
    id: productsTable.id,
    price: productsTable.price,
    inStock: productsTable.inStock,
    name: productsTable.name,
  }).from(productsTable).where(and(inArray(productsTable.id, productIds), isNull(productsTable.deletedAt)));

  const productMap = new Map(dbProducts.map(p => [p.id, p]));
  const removed: string[] = [];
  const priceChanges: { productId: string; name: string; oldPrice: number; newPrice: number }[] = [];
  const validItems: unknown[] = [];

  for (const item of items) {
    const dbProduct = productMap.get(item.productId);
    if (!dbProduct || dbProduct.inStock === false) {
      removed.push(item.name || item.productId);
      continue;
    }
    const dbPrice = parseFloat(dbProduct.price);
    if (Math.abs(dbPrice - Number(item.price)) > 0.01) {
      priceChanges.push({ productId: item.productId, name: dbProduct.name || item.name, oldPrice: item.price, newPrice: dbPrice });
      validItems.push({ ...item, price: dbPrice });
    } else {
      validItems.push(item);
    }
  }

  sendSuccess(res, {
    valid: removed.length === 0 && priceChanges.length === 0,
    items: validItems,
    removed,
    priceChanges,
  });
});

/* ── GET /orders/validate-promo?code=&total=&type= ───────────────────────── */
router.get("/validate-promo", customerAuth, async (req, res) => {
  const code  = String(req.query["code"]  || "").trim();
  const total = parseFloat(String(req.query["total"] || "0"));
  const type  = String(req.query["type"]  || "mart");
  if (!code) { sendValidationError(res, "code required"); return; }
  const result = await validatePromoCode(code, total, type, req.customerId);
  sendSuccess(res, result);
});

/* ── GET /orders ──────────────────────────────────────────────────────────
   Cursor-paginated. Accepts ?after=<cursor>&limit=<n>&status=<s>&slim=true.
   Legacy callers that send ?page= still work (page/offset path) so no
   existing clients break during the transition.
─────────────────────────────────────────────────────────────────────────── */
router.get("/", customerAuth, async (req, res) => {
  const userId = req.customerId!;
  const status = req.query["status"] as string;
  const slim   = req.query["slim"] === "true";
  const limit  = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] || "20"), 10)));

  /* Legacy offset mode — keep for backward compatibility */
  if (req.query["page"]) {
    const page   = Math.max(1, parseInt(String(req.query["page"]), 10));
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [eq(ordersTable.userId, userId)];
    if (status) conditions.push(eq(ordersTable.status, status));
    const [countRow] = await db.select({ total: count() }).from(ordersTable).where(and(...conditions));
    const total = countRow?.total ?? 0;
    const orders = await db.select().from(ordersTable)
      .where(and(...conditions))
      .orderBy(desc(ordersTable.createdAt))
      .limit(limit).offset(offset);
    sendSuccess(res, {
      orders: orders.map(o => slim ? {
        id: o.id, type: o.type, status: o.status, total: parseFloat(o.total),
        paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus ?? "pending",
        createdAt: o.createdAt.toISOString(),
        itemCount: Array.isArray(o.items) ? (o.items as unknown[]).length : 0,
      } : mapOrder(o)),
      total, page, limit, hasMore: offset + orders.length < total,
    });
    return;
  }

  /* Cursor mode */
  const { buildCursorPage, decodeCursor } = await import("../lib/pagination/cursor.js");
  const after  = req.query["after"] as string | undefined;
  const cursor = after ? decodeCursor(after) : null;

  const conditions: SQL[] = [eq(ordersTable.userId, userId)];
  if (status) conditions.push(eq(ordersTable.status, status));
  if (cursor) conditions.push(sql`${ordersTable.createdAt} < ${cursor}::timestamptz`);

  const rows = await db.select().from(ordersTable)
    .where(and(...conditions))
    .orderBy(desc(ordersTable.createdAt))
    .limit(limit + 1);

  const page = buildCursorPage({
    data: rows,
    limit,
    getCursorValue: (o) => o.createdAt.toISOString(),
  });

  sendSuccess(res, {
    orders: page.data.map(o => slim ? {
      id: o.id, type: o.type, status: o.status, total: parseFloat(o.total),
      paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus ?? "pending",
      createdAt: o.createdAt.toISOString(),
      itemCount: Array.isArray(o.items) ? (o.items as unknown[]).length : 0,
    } : mapOrder(o)),
    total: page.data.length,
    count: page.data.length,
    limit,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
});

/* ── GET /orders/lookup/:id — Unified order lookup across all order types ──── */
router.get("/lookup/:id", customerAuth, async (req, res) => {
  const userId = req.customerId!;
  const id = String(req.params["id"]);

  /* Search all order tables in parallel to find the record by ID */
  const [orderRow, parcelRow, rideRow, pharmacyRow] = await Promise.all([
    db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1),
    db.select().from(parcelBookingsTable).where(eq(parcelBookingsTable.id, id)).limit(1),
    db.select().from(ridesTable).where(eq(ridesTable.id, id)).limit(1),
    db.select().from(pharmacyOrdersTable).where(eq(pharmacyOrdersTable.id, id)).limit(1),
  ]);

  const order = orderRow[0];
  const parcel = parcelRow[0];
  const ride = rideRow[0];
  const pharmacy = pharmacyRow[0];

  if (order) {
    if (idorGuard(res, order.userId, userId)) return;
    const s = await getCachedSettings();
    const orderItems = (order.items ?? []) as { price: number; quantity: number }[];
    const itemsTotal = orderItems.reduce((sum, it) => sum + (Number(it.price) * Number(it.quantity)), 0);
    const deliveryFee = calcDeliveryFee(s, order.type, itemsTotal);
    const gstAmount   = calcGst(s, itemsTotal);
    const codFee      = calcCodFee(s, order.paymentMethod, itemsTotal + deliveryFee + gstAmount);
    let vendorName: string | null = null;
    if (order.vendorId) {
      const [vendor] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, order.vendorId)).limit(1);
      vendorName = vendor?.name ?? null;
    }
    sendSuccess(res, { ...mapOrder(order, deliveryFee, gstAmount, codFee), vendorName });
    return;
  }

  if (parcel) {
    if (idorGuard(res, parcel.userId, userId)) return;
    let parcelRiderName: string | null = null;
    let parcelRiderPhone: string | null = null;
    if (parcel.riderId) {
      const [riderUser] = await db.select({ name: usersTable.name, phone: usersTable.phone })
        .from(usersTable).where(eq(usersTable.id, parcel.riderId)).limit(1);
      parcelRiderName  = riderUser?.name  ?? null;
      parcelRiderPhone = riderUser?.phone ?? null;
    }
    sendSuccess(res, {
      id: parcel.id,
      type: "parcel",
      status: parcel.status,
      userId: parcel.userId,
      fare: parseFloat(parcel.fare),
      paymentMethod: parcel.paymentMethod,
      estimatedTime: parcel.estimatedTime,
      riderId: parcel.riderId,
      riderName: parcelRiderName,
      riderPhone: parcelRiderPhone,
      createdAt: parcel.createdAt.toISOString(),
      updatedAt: parcel.updatedAt.toISOString(),
      pickupAddress: parcel.pickupAddress,
      dropAddress: parcel.dropAddress,
      senderName: parcel.senderName,
      senderPhone: parcel.senderPhone,
      receiverName: parcel.receiverName,
      receiverPhone: parcel.receiverPhone,
      parcelType: parcel.parcelType,
      weight: parcel.weight ? parseFloat(parcel.weight) : null,
      description: parcel.description,
    });
    return;
  }

  if (ride) {
    const isCustomer = ride.userId === userId;
    const isRider    = ride.riderId === userId;
    if (!isCustomer && !isRider) { sendForbidden(res, "Access denied — not your ride"); return; }
    sendSuccess(res, {
      id: ride.id,
      type: "ride",
      status: ride.status,
      userId: ride.userId,
      fare: parseFloat(ride.fare),
      distance: parseFloat(ride.distance),
      paymentMethod: ride.paymentMethod,
      riderId: ride.riderId,
      riderName: ride.riderName,
      riderPhone: ride.riderPhone,
      pickupAddress: ride.pickupAddress,
      dropAddress: ride.dropAddress,
      dropLat: ride.dropLat ? parseFloat(ride.dropLat) : null,
      dropLng: ride.dropLng ? parseFloat(ride.dropLng) : null,
      isParcel: ride.isParcel,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    });
    return;
  }

  if (pharmacy) {
    if (idorGuard(res, pharmacy.userId, userId)) return;
    let pharmRiderName: string | null = null;
    let pharmRiderPhone: string | null = null;
    if (pharmacy.riderId) {
      const [riderUser] = await db.select({ name: usersTable.name, phone: usersTable.phone })
        .from(usersTable).where(eq(usersTable.id, pharmacy.riderId)).limit(1);
      pharmRiderName  = riderUser?.name  ?? null;
      pharmRiderPhone = riderUser?.phone ?? null;
    }
    sendSuccess(res, {
      id: pharmacy.id,
      type: "pharmacy",
      status: pharmacy.status,
      userId: pharmacy.userId,
      total: pharmacy.total ? parseFloat(pharmacy.total) : null,
      paymentMethod: pharmacy.paymentMethod,
      riderId: pharmacy.riderId,
      riderName: pharmRiderName,
      riderPhone: pharmRiderPhone,
      deliveryAddress: pharmacy.deliveryAddress,
      estimatedTime: pharmacy.estimatedTime,
      items: pharmacy.items,
      prescriptionNote: pharmacy.prescriptionNote,
      createdAt: pharmacy.createdAt.toISOString(),
      updatedAt: pharmacy.updatedAt.toISOString(),
    });
    return;
  }

  sendNotFound(res, "Order not found");
});

/* ── GET /orders/:id ──────────────────────────────────────────────────────── */
router.get("/:id", customerAuth, verifyOwnership("order"), async (req, res) => {
  const userId = req.customerId!;
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params["id"]))).limit(1);
  if (!order) { sendNotFound(res, "Order not found"); return; }
  if (idorGuard(res, order.userId, userId)) return;
  const s = await getCachedSettings();
  const orderItems = (order.items ?? []) as { price: number; quantity: number }[];
  const itemsTotal = orderItems.reduce((sum, it) => sum + (Number(it.price) * Number(it.quantity)), 0);
  const deliveryFee = calcDeliveryFee(s, order.type, itemsTotal);
  const gstAmount   = calcGst(s, itemsTotal);
  const codFee      = calcCodFee(s, order.paymentMethod, itemsTotal + deliveryFee + gstAmount);

  /* Fetch vendor display name so the order detail screen can show it */
  let vendorName: string | null = null;
  if (order.vendorId) {
    const [vendor] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, order.vendorId))
      .limit(1);
    vendorName = vendor?.name ?? null;
  }

  sendSuccess(res, { ...mapOrder(order, deliveryFee, gstAmount, codFee), vendorName });
});

/* ── GET /orders/:id/track — Live rider location for active food/mart orders ── */
router.get("/:id/track", customerAuth, async (req, res) => {
  const userId = req.customerId!;
  const [order] = await db
    .select({
      id: ordersTable.id,
      userId: ordersTable.userId,
      riderId: ordersTable.riderId,
      riderName: ordersTable.riderName,
      riderPhone: ordersTable.riderPhone,
      status: ordersTable.status,
    })
    .from(ordersTable)
    .where(eq(ordersTable.id, String(req.params["id"])))
    .limit(1);

  if (!order) { sendNotFound(res, "Order not found"); return; }
  if (order.userId !== userId) { sendForbidden(res, "Access denied"); return; }

  /* Include all statuses where a rider may be en-route so parcel/ride
     orders in "accepted"/"arrived" state also return live coordinates. */
  const TRACKABLE = ["picked_up", "out_for_delivery", "in_transit", "accepted", "arrived"];
  let riderLat: number | null = null;
  let riderLng: number | null = null;
  let riderLocAge: number | null = null;

  let riderName = order.riderName ?? null;
  let riderPhone = order.riderPhone ?? null;

  if (order.riderId && TRACKABLE.includes(order.status)) {
    const [loc] = await db
      .select()
      .from(liveLocationsTable)
      .where(eq(liveLocationsTable.userId, order.riderId))
      .limit(1);
    if (loc) {
      riderLat     = parseFloat(String(loc.latitude));
      riderLng     = parseFloat(String(loc.longitude));
      riderLocAge  = Math.floor((Date.now() - new Date(loc.updatedAt).getTime()) / 1000);
    }

    /* Fall back to users table if riderName/riderPhone not stored directly on order */
    if (!riderName || !riderPhone) {
      const [riderUser] = await db
        .select({ name: usersTable.name, phone: usersTable.phone })
        .from(usersTable)
        .where(eq(usersTable.id, order.riderId))
        .limit(1);
      riderName  = riderName  ?? riderUser?.name  ?? null;
      riderPhone = riderPhone ?? riderUser?.phone ?? null;
    }
  }

  sendSuccess(res, {
    id: order.id,
    status: order.status,
    riderId: order.riderId,
    riderName,
    riderPhone,
    riderLat,
    riderLng,
    riderLocAge,
    trackable: TRACKABLE.includes(order.status),
  });
});

/* ── POST /orders ─────────────────────────────────────────────────────────── */
router.post("/", customerAuth, async (req, res) => {
  const userId = req.customerId!;
  const { type, items, paymentMethod, deliveryLat, deliveryLng, customerLat: rawCustLat, customerLng: rawCustLng, gpsAccuracy: rawGpsAcc } = req.body;
  const proofPhotoUrlRaw = typeof req.body.proofPhotoUrl === "string" ? req.body.proofPhotoUrl.trim() : null;
  const proofPhotoUrl = (() => {
    if (!proofPhotoUrlRaw) return null;
    if (/^\/api\/uploads\/[\w.\-]+$/.test(proofPhotoUrlRaw)) return proofPhotoUrlRaw;
    if (/^\/uploads\/[\w.\-]+$/.test(proofPhotoUrlRaw)) return proofPhotoUrlRaw;
    try {
      const u = new URL(proofPhotoUrlRaw);
      if ((u.protocol === "http:" || u.protocol === "https:") && (u.pathname.startsWith("/api/uploads/") || u.pathname.startsWith("/uploads/"))) return proofPhotoUrlRaw;
    } catch { /* ignore */ }
    return null;
  })();
  const txnRef = typeof req.body.txnRef === "string" ? req.body.txnRef.trim().slice(0, 100) : null;
  const deliveryAddress = typeof req.body.deliveryAddress === "string" ? stripHtml(req.body.deliveryAddress) : req.body.deliveryAddress;
  const ip = getClientIp(req);

  const idempotencyKey = typeof req.headers["x-idempotency-key"] === "string"
    ? req.headers["x-idempotency-key"].trim()
    : typeof req.body?.idempotencyKey === "string"
    ? req.body.idempotencyKey.trim() : null;
  if (idempotencyKey) {
    const ttlCutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS);
    const [existing] = await db.select()
      .from(idempotencyKeysTable)
      .where(and(
        eq(idempotencyKeysTable.userId, userId),
        eq(idempotencyKeysTable.idempotencyKey, idempotencyKey),
        gte(idempotencyKeysTable.createdAt, ttlCutoff),
      ))
      .limit(1);
    if (existing) {
      const parsed = (() => { try { return JSON.parse(existing.responseData); } catch { return null; } })();
      if (parsed && parsed.id) {
        sendSuccess(res, parsed);
        return;
      }
      if (existing.responseData === "{}") {
        sendError(res, "Your previous order request is still being processed. Please wait a moment and try again.", 409);
        return;
      }
      logger.warn({ userId, idempotencyKey }, "[orders/create] corrupt idempotency record — proceeding with new order");
    }
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    sendValidationError(res, "items (array) required"); return;
  }

  /* Per-item validation — prevents negative-price injection that could
     reduce the order total below what the customer is actually owed */
  const badItem = (items as Array<Record<string, unknown>>).find(
    (it) => !Number.isFinite(Number(it.price)) || Number(it.price) <= 0 ||
            !Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0,
  );
  if (badItem) {
    sendValidationError(res, "Each item must have a valid positive price and quantity"); return;
  }

  /* ── Server-side price verification — every item must have a productId ── */
  const missingProductId = (items as Array<Record<string, unknown>>).find((it: Record<string, unknown>) => !it.productId);
  if (missingProductId) {
    sendValidationError(res, "Each item must include a valid productId"); return;
  }

  const productIds = (items as Array<Record<string, unknown>>).map((it: Record<string, unknown>) => it.productId) as string[];
  {
    const dbProducts = await db.select({
      id: productsTable.id,
      price: productsTable.price,
      inStock: productsTable.inStock,
      name: productsTable.name,
      type: productsTable.type,
      vendorId: productsTable.vendorId,
    }).from(productsTable).where(and(inArray(productsTable.id, productIds), isNull(productsTable.deletedAt)));

    const productMap = new Map(dbProducts.map(p => [p.id, p]));

    const unavailable: string[] = [];
    const priceChanges: string[] = [];

    for (const item of items as Array<{ productId: string; name?: string; quantity: number; price?: number }>) {
      const dbProduct = productMap.get(item.productId);
      if (!dbProduct) {
        unavailable.push(item.name || item.productId);
        continue;
      }
      if (dbProduct.inStock === false) {
        unavailable.push(dbProduct.name || item.productId);
        continue;
      }
      const dbPrice = parseFloat(dbProduct.price);
      if (Math.abs(dbPrice - Number(item.price)) > 0.01) {
        priceChanges.push(`${dbProduct.name}: Rs.${item.price} → Rs.${dbPrice}`);
        item.price = dbPrice;
      }
    }

    if (unavailable.length > 0) {
      sendErrorWithData(res, `The following items are no longer available: ${unavailable.join(", ")}. Please remove them from your cart.`, { unavailableItems: unavailable }, 400);
      return;
    }

    if (priceChanges.length > 0) {
      sendErrorWithData(res, `Prices have changed for some items: ${priceChanges.join("; ")}. Please review your cart.`, { priceChanges }, 409);
      return;
    }

    /* Mixed-cart enforcement (#22) — validate against DB product types, not client-provided data */
    const resolvedProductTypes = new Set(
      (items as Array<Record<string, unknown>>)
        .map((it) => productMap.get(it.productId as string)?.type)
        .filter(Boolean)
    );
    if (resolvedProductTypes.size > 1) {
      sendValidationError(res, `Cart cannot mix item types: found ${[...resolvedProductTypes].join(", ")}. All items must be from the same category (mart, food, or pharmacy).`); return;
    }

    /* Multi-vendor cart enforcement — all items must belong to the same vendor.
       vendorId is resolved from the DB record, not from client-supplied data,
       so a malicious payload cannot spoof this check.
       If the cart has items from two vendors, only the first vendor would receive
       the order (silent fulfillment failure). Reject early with a clear error. */
    const resolvedVendorIds = new Set(
      (items as Array<Record<string, unknown>>)
        .map((it) => productMap.get(it.productId as string)?.vendorId)
        .filter(Boolean)
    );
    if (resolvedVendorIds.size > 1) {
      res.status(400).json({
        success: false,
        error: "All items must be from the same vendor. Please place separate orders for items from different stores.",
        code: "MULTI_VENDOR_CART_NOT_ALLOWED",
      });
      return;
    }
  }  /* end price verification block */

  const itemsTotal = items.reduce(
    (sum: number, item: { price: number; quantity: number }) => sum + (item.price * item.quantity),
    0
  );

  if (itemsTotal <= 0) {
    sendValidationError(res, "Order total must be greater than 0"); return;
  }

  /* ── Load platform settings once ── */
  const s = await getCachedSettings();

  /* Max quantity enforcement (#23) — configurable via platform settings, default 99 */
  const maxItemQty = parseInt(String(s["order_max_item_quantity"] ?? MAX_ITEM_QUANTITY)) || MAX_ITEM_QUANTITY;
  const overQuantityItem = (items as Array<Record<string, unknown>>).find(
    (it) => Number(it.quantity) > maxItemQty,
  );
  if (overQuantityItem) {
    sendValidationError(res, `Item quantity cannot exceed ${maxItemQty} per item (item: ${overQuantityItem.name ?? overQuantityItem.productId ?? "unknown"})`); return;
  }

  /* ── Geofence: check delivery coordinates if provided ── */
  if ((s["security_geo_fence"] ?? "off") === "on" && deliveryLat != null && deliveryLng != null) {
    const dLat = parseFloat(String(deliveryLat));
    const dLng = parseFloat(String(deliveryLng));
    if (Number.isFinite(dLat) && Number.isFinite(dLng)) {
      const zoneCheck = await isInServiceZone(dLat, dLng, "orders");
      if (!zoneCheck.allowed) {
        sendError(res, "Delivery address is outside our service area. We currently only operate in configured service zones.", 422); return;
      }
    }
  }

  /* ── 1st gate: service feature flags (fail-fast before any calculation) ── */
  if (type === "mart" && (s["feature_mart"] ?? "on") === "off") {
    sendError(res, "Mart grocery service is currently unavailable. Please try again later.", 503); return;
  }
  if (type === "food" && (s["feature_food"] ?? "on") === "off") {
    sendError(res, "Food delivery service is currently unavailable. Please try again later.", 503); return;
  }
  /* app_status maintenance gate */
  if ((s["app_status"] ?? "active") === "maintenance") {
    const mainKey = (s["security_maintenance_key"] ?? "").trim();
    const bypass  = ((req.headers["x-maintenance-key"] as string) ?? "").trim();
    if (!mainKey || bypass !== mainKey) {
      sendError(res, s["content_maintenance_msg"] ?? "We're performing scheduled maintenance. Back soon!", 503); return;
    }
  }

  /* ── Resolve vendorId from first product if not provided ── */
  let resolvedVendorId = (req.body.vendorId as string | undefined) || null;
  if (!resolvedVendorId && items.length > 0) {
    try {
      const firstProductId = items[0].productId;
      if (firstProductId) {
        const [prod] = await db.select({ vendorId: productsTable.vendorId })
          .from(productsTable)
          .where(eq(productsTable.id, firstProductId))
          .limit(1);
        resolvedVendorId = prod?.vendorId ?? null;
      }
    } catch {}
  }

  /* ── Delivery access eligibility ── */
  if (paymentMethod !== "pickup") {
    const eligibility = await checkDeliveryEligibility(userId, resolvedVendorId, type ?? "mart");
    if (!eligibility.eligible) {
      const reason = eligibility.reason === "store_not_whitelisted"
        ? "Delivery is not available for this store. Please choose self-pickup."
        : eligibility.reason === "user_not_whitelisted"
        ? "Delivery is not available for your account. Please choose self-pickup."
        : "Delivery is not available. Please choose self-pickup.";
      res.status(403).json({
        success: false,
        error: reason,
        reasonCode: "delivery_not_eligible",
        detailCode: eligibility.reason,
      });
      return;
    }
  }

  /* ── Order rule checks ── */
  const minOrder = parseFloat(s["min_order_amount"] ?? "100");
  const vendorMinOrder = parseFloat(s["vendor_min_order"] ?? "100");
  const effectiveMinOrder = Math.max(minOrder, vendorMinOrder);
  if (itemsTotal < effectiveMinOrder) {
    sendValidationError(res, `Minimum order amount is Rs. ${effectiveMinOrder}`); return;
  }

  const maxCart = parseFloat(s["order_max_cart_value"] ?? "50000");
  if (itemsTotal > maxCart) {
    sendValidationError(res, `Cart value cannot exceed Rs. ${maxCart}. Please split into multiple orders.`); return;
  }

  /* ── Scheduled order gate ── */
  const scheduleEnabled = (s["order_schedule_enabled"] ?? "off") === "on";
  if (req.body.scheduledAt && !scheduleEnabled) {
    sendValidationError(res, "Scheduled orders are not available at this time."); return;
  }

  /* ── Delivery fee, GST, COD fee — via shared utility (see lib/fees.ts) ── */
  const itemWeight = type === "parcel"
    ? (() => {
        const bodyWeight = parseFloat(String(req.body.weightKg ?? "0"));
        return bodyWeight > 0
          ? bodyWeight
          : items.reduce((sum: number, it: any) => sum + parseFloat(it.weightKg ?? "0"), 0);
      })()
    : 0;
  const deliveryFee = calcDeliveryFee(s, type, itemsTotal, itemWeight);
  const gstAmount   = calcGst(s, itemsTotal);

  let promoDiscount = 0;
  let promoId: string | null = null;
  let promoOfferId: string | null = null;
  let promoFreeDelivery = false;
  const promoCode = req.body.promoCode as string | undefined;
  const incomingAutoOfferId = req.body.autoApplyOfferId as string | undefined;

  if (promoCode) {
    const promoResult = await validatePromoCode(promoCode, itemsTotal, type ?? "mart", userId);
    if (!promoResult.valid) {
      sendValidationError(res, promoResult.error ?? "Invalid promo code"); return;
    }
    promoDiscount = promoResult.discount;
    promoId = promoResult.promoId ?? null;
    promoOfferId = promoResult.offerId ?? null;
    promoFreeDelivery = promoResult.freeDelivery ?? false;
  } else if (incomingAutoOfferId) {
    /* Auto-apply (codeless) offer: validate directly by ID with full targeting/usage checks */
    const [autoOffer] = await db.select().from(offersTable).where(eq(offersTable.id, incomingAutoOfferId)).limit(1);
    if (autoOffer) {
      /* Security: reject code-gated offers from auto-apply path to prevent abuse */
      if (autoOffer.code) {
        sendValidationError(res, "This offer requires a promo code. Please enter the code manually."); return;
      }

      const now = new Date();
      const isLive = autoOffer.status === "live" && now >= autoOffer.startDate && now <= autoOffer.endDate;
      const minAmt = parseFloat(String(autoOffer.minOrderAmount ?? "0"));
      const appliesTo = (autoOffer.appliesTo ?? "all").toLowerCase().trim();
      const typeMatch = appliesTo === "all" || appliesTo === (type ?? "mart").toLowerCase();

      /* Global usage exhaustion check (fix #3) */
      const globalExhausted = autoOffer.usageLimit !== null
        && autoOffer.usedCount >= (autoOffer.usageLimit ?? Infinity);

      if (isLive && itemsTotal >= minAmt && typeMatch && !globalExhausted) {
        /* Targeting rules */
        const rules = (autoOffer.targetingRules ?? {}) as Record<string, unknown>;
        const [userRow] = await db.select({ createdAt: usersTable.createdAt }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
        const isNewUser = userRow ? (Date.now() - userRow.createdAt.getTime()) < 30 * 24 * 60 * 60 * 1000 : false;
        const [cntRow] = await db.select({ c: count() }).from(ordersTable).where(eq(ordersTable.userId, userId));
        const totalOrders = Number(cntRow?.c ?? 0);
        const [spendRow2] = await db.select({ s: sum(ordersTable.total) }).from(ordersTable).where(eq(ordersTable.userId, userId));
        const totalSpend = parseFloat(String(spendRow2?.s ?? "0"));

        const targetingOk = !(rules.newUsersOnly && !isNewUser)
          && !(rules.returningUsersOnly && totalOrders === 0)
          && !(rules.highValueUser && totalSpend < 5000);

        /* Per-user usage (exclude bookmark records) */
        const usagePerUser = autoOffer.usagePerUser ? Number(autoOffer.usagePerUser) : null;
        let usageOk = true;
        if (usagePerUser !== null && usagePerUser > 0) {
          const [rRow] = await db.select({ c: count() }).from(offerRedemptionsTable)
            .where(and(
              eq(offerRedemptionsTable.offerId, autoOffer.id),
              eq(offerRedemptionsTable.userId, userId),
              sql`${offerRedemptionsTable.orderId} IS NOT NULL`,
            ));
          usageOk = Number(rRow?.c ?? 0) < usagePerUser;
        }

        if (targetingOk && usageOk) {
          let disc = 0;
          if (autoOffer.discountPct) {
            disc = Math.round(itemsTotal * parseFloat(String(autoOffer.discountPct)) / 100);
            if (autoOffer.maxDiscount) disc = Math.min(disc, parseFloat(String(autoOffer.maxDiscount)));
          } else if (autoOffer.discountFlat) {
            disc = parseFloat(String(autoOffer.discountFlat));
          }
          promoDiscount = Math.min(disc, itemsTotal);
          promoOfferId = autoOffer.id;
          promoFreeDelivery = autoOffer.freeDelivery ?? false;
        }
      }
    }
  }

  /* Apply free delivery from promo offer — waive the delivery fee entirely */
  const effectiveDeliveryFee = promoFreeDelivery ? 0 : deliveryFee;
  const codFee = calcCodFee(s, paymentMethod, itemsTotal + effectiveDeliveryFee + gstAmount);

  const total = Math.max(0, itemsTotal + effectiveDeliveryFee + gstAmount + codFee - promoDiscount);

  const rawClientTotal = req.body.total;
  const clientTotal = (typeof rawClientTotal === "number" || typeof rawClientTotal === "string")
    ? parseFloat(String(rawClientTotal)) : NaN;
  if (!Number.isFinite(clientTotal)) {
    sendValidationError(res, "A valid order total is required. Please update your app and try again.");
    return;
  }
  const totalDiff = Math.abs(clientTotal - total);
  if (totalDiff > 0.01) {
    logger.warn({
      userId, clientTotal, serverTotal: total,
      deliveryFee: effectiveDeliveryFee, gstAmount, codFee, promoDiscount, itemsTotal,
    }, "[orders/create] client total mismatch — rejecting");
    sendErrorWithData(
      res,
      `Order total mismatch: you submitted Rs. ${clientTotal.toFixed(2)} but the server calculated Rs. ${total.toFixed(2)}. Please refresh your cart and try again.`,
      { clientTotal, serverTotal: total, deliveryFee: effectiveDeliveryFee, gstAmount, codFee, promoDiscount },
      400,
    );
    return;
  }

  /* ── Prep time from admin Order settings ── */
  const preptimeMin = parseInt(s["order_preptime_min"] ?? "15", 10);
  const estimatedTime = `${preptimeMin}–${preptimeMin + 20} min`;

  /* ── Fetch user for fraud checks ── */
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  /* ── Banned/inactive check ── */
  if (user.isBanned) {
    sendForbidden(res, "Your account has been suspended. You cannot place orders."); return;
  }
  if (!user.isActive) {
    sendForbidden(res, "Your account is inactive. Please contact support."); return;
  }

  /* ── Customer daily order cap (always enforced from Customer Settings) ── */
  const custMaxPerDay = parseInt(s["customer_max_orders_day"] ?? "20", 10);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [custDailyResult] = await db
    .select({ c: count() })
    .from(ordersTable)
    .where(and(eq(ordersTable.userId, userId), gte(ordersTable.createdAt, todayStart)));
  const custDailyCount = Number(custDailyResult?.c ?? 0);
  if (custDailyCount >= custMaxPerDay) {
    sendError(res, `Aaj ke liye order limit (${custMaxPerDay} orders) reach ho gayi. Kal dobara try karein.`, 429); return;
  }

  /* ── Fake order / fraud detection ── */
  if (s["security_fake_order_detect"] === "on") {
    /* Max daily orders — security override (uses security_max_daily_orders) */
    const maxDailyOrders = parseInt(s["security_max_daily_orders"] ?? "20", 10);
    if (custDailyCount >= maxDailyOrders) {
      addSecurityEvent({ type: "daily_order_limit", ip, userId, details: `User ${userId} hit daily order limit: ${custDailyCount}/${maxDailyOrders}`, severity: "medium" });
      sendError(res, `Daily order limit reached (${maxDailyOrders} orders per day). Please try again tomorrow.`, 429); return;
    }

    /* New account order limit (first 7 days) */
    const newAcctLimit = parseInt(s["security_new_acct_limit"] ?? "3", 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (user.createdAt > sevenDaysAgo) {
      const [totalOrdersResult] = await db
        .select({ c: count() })
        .from(ordersTable)
        .where(eq(ordersTable.userId, userId));
      const totalOrders = Number(totalOrdersResult?.c ?? 0);
      if (totalOrders >= newAcctLimit) {
        addSecurityEvent({ type: "new_account_limit", ip, userId, details: `New account ${userId} hit order limit: ${totalOrders}/${newAcctLimit}`, severity: "medium" });
        sendError(res, `New accounts are limited to ${newAcctLimit} orders in the first 7 days. Please contact support if you need assistance.`, 429); return;
      }
    }

    /* Same address hourly limit */
    if (deliveryAddress) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const sameAddrLimit = parseInt(s["security_same_addr_limit"] ?? "5", 10);
      const sameAddrOrders = await db
        .select()
        .from(ordersTable)
        .where(and(eq(ordersTable.deliveryAddress, deliveryAddress), gte(ordersTable.createdAt, oneHourAgo)));
      if (sameAddrOrders.length >= sameAddrLimit) {
        addSecurityEvent({ type: "same_address_limit", ip, userId, details: `Same address limit hit: ${deliveryAddress} (${sameAddrOrders.length} orders/hr)`, severity: "high" });
        sendError(res, `Too many orders to the same address. Please try again later.`, 429); return;
      }
    }
  }

  /* ── GPS fraud-stamp: compare device GPS to selected delivery address coords ── */
  const gpsEnabled = (s["order_gps_capture_enabled"] ?? "off") === "on";
  const custLat = gpsEnabled && rawCustLat != null ? parseFloat(String(rawCustLat)) : NaN;
  const custLng = gpsEnabled && rawCustLng != null ? parseFloat(String(rawCustLng)) : NaN;
  const custAcc = rawGpsAcc != null ? parseFloat(String(rawGpsAcc)) : null;
  const hasCustGps = Number.isFinite(custLat) && Number.isFinite(custLng)
    && custLat >= -90 && custLat <= 90 && custLng >= -180 && custLng <= 180;

  let resolvedDeliveryLat = deliveryLat != null ? parseFloat(String(deliveryLat)) : NaN;
  let resolvedDeliveryLng = deliveryLng != null ? parseFloat(String(deliveryLng)) : NaN;
  if ((!Number.isFinite(resolvedDeliveryLat) || !Number.isFinite(resolvedDeliveryLng)) && deliveryAddress && hasCustGps) {
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(deliveryAddress)}&format=json&limit=1`,
        { headers: { "User-Agent": "AJKMart/1.0" }, signal: AbortSignal.timeout(3000) },
      );
      const geoData = await geoRes.json();
      if (Array.isArray(geoData) && geoData.length > 0) {
        const gLat = parseFloat(geoData[0].lat);
        const gLng = parseFloat(geoData[0].lon);
        if (Number.isFinite(gLat) && Number.isFinite(gLng)) {
          resolvedDeliveryLat = gLat;
          resolvedDeliveryLng = gLng;
        }
      }
    } catch {}
  }

  const hasResolvedDelivery = Number.isFinite(resolvedDeliveryLat) && Number.isFinite(resolvedDeliveryLng)
    && resolvedDeliveryLat >= -90 && resolvedDeliveryLat <= 90
    && resolvedDeliveryLng >= -180 && resolvedDeliveryLng <= 180;

  let gpsMismatch = false;
  if (hasCustGps && hasResolvedDelivery) {
    const thresholdM = Math.max(100, parseFloat(s["gps_mismatch_threshold_m"] ?? "500") || 500);
    const dist = haversineMetres(custLat, custLng, resolvedDeliveryLat, resolvedDeliveryLng);
    if (dist > thresholdM) gpsMismatch = true;
  }
  const gpsInsert = {
    ...(hasCustGps ? { customerLat: custLat.toFixed(7), customerLng: custLng.toFixed(7), gpsAccuracy: custAcc, gpsMismatch } : {}),
    ...(hasResolvedDelivery ? { deliveryLat: resolvedDeliveryLat.toFixed(7), deliveryLng: resolvedDeliveryLng.toFixed(7) } : {}),
  };

  /* ── COD validation ── */
  if (paymentMethod === "cash") {
    const codEnabled = (s["cod_enabled"] ?? "on") === "on";
    if (!codEnabled) {
      sendValidationError(res, "Cash on Delivery is currently not available"); return;
    }

    /* ── Per-service COD flag ── */
    const serviceKey = `cod_allowed_${type}` as const;
    const codAllowedForService = (s[serviceKey] ?? "on") !== "off";
    if (!codAllowedForService) {
      const label = type === "mart" ? "Mart" : type === "food" ? "Food" : type === "pharmacy" ? "Pharmacy" : "Parcel";
      sendValidationError(res, `Cash on Delivery is not available for ${label} orders. Please choose another payment method.`); return;
    }

    const codMax = parseFloat(s["cod_max_amount"] ?? "5000");
    if (total > codMax) {
      sendValidationError(res, `Maximum Cash on Delivery order is Rs. ${codMax}. Please pay online for larger orders.`); return;
    }

    /* ── COD verification threshold ── */
    const verifyThreshold = parseFloat(s["cod_verification_threshold"] ?? "0");
    if (verifyThreshold > 0 && total > verifyThreshold) {
      /* Mark order as requiring COD verification — stored in notes field or status;
         for now we allow the order but flag it (could block in future). */
    }
  }

  /* ── Manual payment proof validation ── */
  const MANUAL_METHODS = ["jazzcash", "easypaisa"];
  if (MANUAL_METHODS.includes(paymentMethod)) {
    const jazzProofReq  = (s["jazzcash_proof_required"]   ?? "off") === "on";
    const receiptProofReq = (s["payment_receipt_required"] ?? "off") === "on";
    const proofRequired = jazzProofReq || receiptProofReq;
    if (proofRequired && !proofPhotoUrl) {
      sendValidationError(res, "Payment receipt/proof image is required for this payment method. Please upload a screenshot of your payment."); return;
    }
  }

  /* ── Online payment min/max limits (JazzCash, EasyPaisa, Bank Transfer) ── */
  const onlineMethods = ["jazzcash", "easypaisa", "bank"];
  if (onlineMethods.includes(paymentMethod)) {
    const payMinOnline = parseFloat(s["payment_min_online"] ?? "50");
    const payMaxOnline = parseFloat(s["payment_max_online"] ?? "100000");
    if (total < payMinOnline) {
      sendValidationError(res, `Minimum online payment is Rs. ${payMinOnline}`); return;
    }
    if (total > payMaxOnline) {
      sendValidationError(res, `Maximum online payment is Rs. ${payMaxOnline}. Please split your order or use another method.`); return;
    }
  }

  /* ── Wallet payment: deduct on placement ── */
  if (paymentMethod === "wallet") {
    const walletEnabled = (s["feature_wallet"] ?? "on") === "on";
    if (!walletEnabled) {
      sendValidationError(res, "Wallet payments are currently disabled"); return;
    }

    const [walletUser] = await db.select({ blockedServices: usersTable.blockedServices }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (walletUser && (walletUser.blockedServices || "").split(",").map(s2 => s2.trim()).includes("wallet")) {
      sendForbidden(res, "wallet_frozen", "Your wallet has been temporarily frozen. Contact support."); return;
    }

    try {
      const order = await db.transaction(async (tx) => {
        /* Serialize concurrent wallet-deduction requests at the DB level.
           SELECT ... FOR UPDATE acquires a row-level lock so that only one
           transaction at a time can read-then-deduct this user's balance.
           All other concurrent requests queue behind this lock. */
        if (idempotencyKey) {
          await tx.insert(idempotencyKeysTable).values({
            id: generateId(),
            userId,
            idempotencyKey,
            responseData: "{}",
          });
        }

        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`);

        const [freshUser] = await tx.select({ walletBalance: usersTable.walletBalance }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
        if (!freshUser) throw new Error("User not found");

        const balance = parseFloat(freshUser.walletBalance ?? "0");
        if (balance < total) throw new Error(`Insufficient wallet balance. Balance: Rs. ${balance.toFixed(0)}, Required: Rs. ${total.toFixed(0)}`);

        const [deducted] = await tx.update(usersTable)
          .set({ walletBalance: sql`wallet_balance - ${total.toFixed(2)}` })
          .where(and(eq(usersTable.id, userId), gte(usersTable.walletBalance, total.toFixed(2))))
          .returning({ id: usersTable.id });
        if (!deducted) throw new Error(`Insufficient wallet balance. Required: Rs. ${total.toFixed(0)}`);
        await tx.insert(walletTransactionsTable).values({
          id: generateId(), userId, type: "debit",
          amount: total.toFixed(2),
          description: `Order payment (${type || "mart"}) — Rs. ${total.toFixed(0)}`,
        });

        const [newOrder] = await tx.insert(ordersTable).values({
          id: generateId(), userId, type, items,
          status: "pending", total: total.toFixed(2),
          deliveryAddress, paymentMethod,
          estimatedTime,
          ...(proofPhotoUrl ? { proofPhotoUrl } : {}),
          ...(txnRef ? { txnRef } : {}),
          ...gpsInsert,
        }).returning();
        if (promoId) {
          await tx.update(promoCodesTable)
            .set({ usedCount: sql`${promoCodesTable.usedCount} + 1` })
            .where(eq(promoCodesTable.id, promoId));
        }
        if (promoOfferId && newOrder) {
          await tx.update(offersTable)
            .set({ usedCount: sql`${offersTable.usedCount} + 1` })
            .where(eq(offersTable.id, promoOfferId));
          await tx.insert(offerRedemptionsTable).values({
            id: generateId(),
            offerId: promoOfferId,
            userId,
            orderId: newOrder.id,
            discount: promoDiscount.toFixed(2),
          });
        }
        /* ── Decrement stock for all ordered items ── */
        await decrementStock(tx, items as Array<{ productId?: string; variantId?: string; quantity: number }>, newOrder!.id);
        return newOrder!;
      });
      const mapped = { ...mapOrder(order, effectiveDeliveryFee, gstAmount, codFee), promoDiscount };

      /* ── Emit new-order to admin/vendor IMMEDIATELY after DB commit ── */
      broadcastNewOrder(mapped, (order as any).vendorId);

      /* ── Two-Way ACK: confirm order receipt back to the customer ── */
      const io = getIO();
      if (io) io.to(`user:${userId}`).emit("order:ack", { orderId: order.id, status: "pending", createdAt: order.createdAt.toISOString() });

      /* ── Broadcast updated wallet balance to all customer devices ── */
      const [updatedUser] = await db.select({ walletBalance: usersTable.walletBalance }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (updatedUser) {
        const newBalance = parseFloat(updatedUser.walletBalance ?? "0");
        broadcastWalletUpdate(userId, newBalance);
        if (io) io.to(`user:${userId}`).emit("wallet:balance", { balance: newBalance });
      }

      if (idempotencyKey) {
        await db.update(idempotencyKeysTable)
          .set({ responseData: JSON.stringify(mapped) })
          .where(and(eq(idempotencyKeysTable.userId, userId), eq(idempotencyKeysTable.idempotencyKey, idempotencyKey)))
          .catch((e: Error) => logger.warn({ userId, idempotencyKey, err: e.message }, "[orders/create] wallet idempotency response update failed"));
      }
      sendCreated(res, mapped);
      notifyOnlineRidersOfOrder(order.id, type || "mart").catch((e: Error) => logger.warn({ orderId: order.id, err: e.message }, "[orders/create] wallet notifyOnlineRiders failed"));
    } catch (e: unknown) {
      const err = e as Error & { code?: string; outOfStockItems?: unknown[] };
      const errMsg = err.message ?? "";
      logger.error({ err: e, userId }, "[orders/create] wallet payment transaction failed");
      if (idempotencyKey && (errMsg.includes("idempotency_keys_user_key_uniq") || errMsg.includes("duplicate key"))) {
        sendError(res, "Duplicate order request detected. Please wait a moment and try again.", 409);
        return;
      }
      if (err.code === "INSUFFICIENT_STOCK") {
        sendErrorWithData(res, errMsg, { outOfStockItems: err.outOfStockItems ?? [] }, 409);
        return;
      }
      if (errMsg.includes("Insufficient wallet balance")) {
        sendValidationError(res, errMsg);
        return;
      }
      sendError(res, "An internal error occurred while processing your order. Please try again.", 500);
    }
    return;
  }

  /* ── Cash / JazzCash / EasyPaisa / Bank — wrapped in try/catch to prevent unhandled rejections ── */
  try {
    const [order] = await db.transaction(async (tx) => {
      if (idempotencyKey) {
        await tx.insert(idempotencyKeysTable).values({
          id: generateId(),
          userId,
          idempotencyKey,
          responseData: "{}",
        });
      }
      const [newOrder] = await tx.insert(ordersTable).values({
        id: generateId(), userId, type, items,
        status: "pending", total: total.toFixed(2),
        deliveryAddress, paymentMethod,
        estimatedTime,
        ...(proofPhotoUrl ? { proofPhotoUrl } : {}),
        ...(txnRef ? { txnRef } : {}),
        ...gpsInsert,
      }).returning();
      if (promoId) {
        await tx.update(promoCodesTable)
          .set({ usedCount: sql`${promoCodesTable.usedCount} + 1` })
          .where(eq(promoCodesTable.id, promoId));
      }
      if (promoOfferId && newOrder) {
        await tx.update(offersTable)
          .set({ usedCount: sql`${offersTable.usedCount} + 1` })
          .where(eq(offersTable.id, promoOfferId));
        await tx.insert(offerRedemptionsTable).values({
          id: generateId(),
          offerId: promoOfferId,
          userId,
          orderId: newOrder.id,
          discount: promoDiscount.toFixed(2),
        });
      }
      /* ── Decrement stock for all ordered items ── */
      await decrementStock(tx, items as Array<{ productId?: string; variantId?: string; quantity: number }>, newOrder!.id);
      return [newOrder];
    });
    const mapped = { ...mapOrder(order!, effectiveDeliveryFee, gstAmount, codFee), promoDiscount };

    if (idempotencyKey) {
      await db.update(idempotencyKeysTable)
        .set({ responseData: JSON.stringify(mapped) })
        .where(and(eq(idempotencyKeysTable.userId, userId), eq(idempotencyKeysTable.idempotencyKey, idempotencyKey)))
        .catch((e: Error) => logger.warn({ userId, idempotencyKey, err: e.message }, "[orders/create] idempotency response update failed"));
    }

    /* ── Emit to admin IMMEDIATELY after DB commit (Task 7: <500ms latency) ── */
    broadcastNewOrder(mapped, (order as any)?.vendorId);

    /* ── Two-Way ACK for non-wallet orders ── */
    const io = getIO();
    if (io) io.to(`user:${userId}`).emit("order:ack", { orderId: order!.id, status: "pending", createdAt: order!.createdAt.toISOString() });

    sendCreated(res, mapped);
    emitWebhookEvent("order_placed", { orderId: order!.id, userId, type: type || "mart", total: total.toFixed(2), paymentMethod, status: "pending" }).catch(() => {});
    notifyOnlineRidersOfOrder(order!.id, type || "mart").catch((e: Error) => logger.warn({ orderId: order!.id, err: e.message }, "[orders/create] cash notifyOnlineRiders failed"));
  } catch (e: unknown) {
    const err = e as Error & { code?: string; outOfStockItems?: unknown[] };
    const errMsg = err.message ?? "";
    if (idempotencyKey && (errMsg.includes("idempotency_keys_user_key_uniq") || errMsg.includes("duplicate key"))) {
      sendError(res, "Duplicate order request detected. Please wait a moment and try again.", 409);
      return;
    }
    if (err.code === "INSUFFICIENT_STOCK") {
      sendErrorWithData(res, errMsg, { outOfStockItems: err.outOfStockItems ?? [] }, 409);
      return;
    }
    sendError(res, "Order could not be created. Please try again.", 500);
  }
});

/* ── PATCH /orders/:id/cancel — customer cancel only ────────────────────── */
router.patch("/:id/cancel", customerAuth, async (req, res) => {
  const userId = req.customerId!;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null;

  const [existingOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params["id"]))).limit(1);
  if (!existingOrder) { sendNotFound(res, "Order not found"); return; }

  /* Only the order owner can cancel */
  if (existingOrder.userId !== userId) {
    sendForbidden(res, "You cannot cancel another user's order."); return;
  }

  /* Enforce cancel window */
  const s = await getCachedSettings();
  const cancelWindowMin = parseInt(s["order_cancel_window_min"] ?? "5", 10);
  const ageMs = Date.now() - new Date(existingOrder.createdAt).getTime();
  const ageMin = ageMs / 60_000;
  if (ageMin > cancelWindowMin) {
    sendValidationError(res, `Orders can only be cancelled within ${cancelWindowMin} minutes of placement. Please contact support.`); return;
  }

  /* Only pending/confirmed orders can be customer-cancelled */
  if (!["pending", "confirmed"].includes(existingOrder.status)) {
    sendValidationError(res, "This order can no longer be cancelled."); return;
  }

  const isWallet = existingOrder.paymentMethod === "wallet";
  const refundAmount = isWallet ? parseFloat(String(existingOrder.total)) : 0;

  try {
    const order = await db.transaction(async (tx) => {
      const [cancelled] = await tx.update(ordersTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(
          eq(ordersTable.id, String(req.params["id"])),
          eq(ordersTable.userId, userId),
          inArray(ordersTable.status, ["pending", "confirmed"]),
        ))
        .returning();
      if (!cancelled) throw new Error("Order already cancelled or no longer cancellable");

      if (isWallet && refundAmount > 0) {
        await tx.update(usersTable)
          .set({ walletBalance: sql`wallet_balance + ${refundAmount.toFixed(2)}` })
          .where(eq(usersTable.id, userId));
        await tx.insert(walletTransactionsTable).values({
          id: generateId(), userId, type: "credit",
          amount: refundAmount.toFixed(2),
          description: `Refund for cancelled order #${cancelled.id.slice(-6).toUpperCase()}`,
          reference: `refund:${cancelled.id}`,
        });
      }

      return cancelled;
    });

    if (isWallet && refundAmount > 0) {
      const [updatedUser] = await db.select({ walletBalance: usersTable.walletBalance }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (updatedUser) broadcastWalletUpdate(userId, parseFloat(updatedUser.walletBalance ?? "0"));
    }

    broadcastOrderUpdate(mapOrder(order), (order as any).vendorId);

    addAuditEntry({
      action: "order_cancel",
      ip: getClientIp(req),
      details: `Customer [${userId}] cancelled order ${order.id}${reason ? ` — reason: ${reason}` : ""}${isWallet && refundAmount > 0 ? ` (refunded Rs.${refundAmount.toFixed(0)})` : ""}`,
      result: "success",
    });

    if (reason) {
      req.log?.info({ orderId: order.id, reason }, "Order cancelled with reason");
    }

    sendSuccess(res, {
      ...mapOrder(order),
      refundAmount,
      refundMethod: isWallet ? "wallet" : null,
      cancelReason: reason,
    });
  } catch (e: unknown) {
    logger.error({ err: e, userId, orderId: String(req.params["id"]) }, "[orders/cancel] cancellation transaction failed");
    sendValidationError(res, "Could not cancel order. Please try again.");
  }
});

router.post("/:id/refund-request", customerAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.customerId!;

  try {
    const [order] = await db.select().from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.userId, userId)))
      .limit(1);

    if (!order) { sendNotFound(res, "Order not found"); return; }

    if (!["delivered", "completed"].includes(order.status)) {
      sendValidationError(res, "Refund can only be requested for delivered orders");
      return;
    }

    if (order.paymentMethod === "cod" || order.paymentMethod === "cash") {
      sendValidationError(res, "Cash orders are not eligible for refund");
      return;
    }

    if (order.paymentStatus === "refund_requested" || order.refundedAt) {
      sendValidationError(res, "Refund has already been requested for this order");
      return;
    }

    const now = new Date();
    await db.update(ordersTable)
      .set({ paymentStatus: "refund_requested", updatedAt: now })
      .where(eq(ordersTable.id, orderId));

    const updatedOrder = { ...order, paymentStatus: "refund_requested" as typeof order.paymentStatus };
    broadcastOrderUpdate(mapOrder(updatedOrder), order.vendorId);

    sendSuccess(res, { refundStatus: "requested" }, "Refund request submitted");
  } catch (e: unknown) {
    logger.error({ err: e, userId, orderId }, "[orders/refund-request] failed");
    sendError(res, "An internal error occurred. Please try again.", 500);
  }
});

/* ── POST /orders/:id/refund — admin-only: issue a full wallet refund ───────
   Access: adminAuth only. Customers cannot self-refund.
   Idempotency: blocked if order.refundedAt is already set.
   Audit: writes orderAuditLog row; admin ID used as the actor field. */
router.post("/:id/refund", adminAuth, async (req: AdminRequest, res) => {
  const orderId = String(req.params["id"]);
  const adminId = req.adminId!;
  const reason  = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "Admin refund";

  try {
    const [order] = await db.select().from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);

    if (!order) { sendNotFound(res, "Order not found"); return; }

    if (order.refundedAt) {
      sendValidationError(res, "This order has already been refunded"); return;
    }

    const REFUNDABLE = ["delivered", "completed", "cancelled", "pending", "confirmed"];
    if (!REFUNDABLE.includes(order.status)) {
      sendValidationError(res, `Orders in status '${order.status}' cannot be refunded`); return;
    }

    if (order.paymentMethod === "cash" || order.paymentMethod === "cod") {
      sendValidationError(res, "Cash on delivery orders are not eligible for wallet refund"); return;
    }

    const customerId = order.userId;
    const refundAmount = parseFloat(String(order.refundedAmount ?? order.total));
    const now = new Date();

    await db.transaction(async (tx) => {
      /* Lock the order row to prevent concurrent double-refund.
         The UPDATE uses WHERE refunded_at IS NULL and we check affected rows
         via RETURNING — if nothing came back, a concurrent request already won. */
      const [locked] = await tx.execute(
        sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`,
      ) as unknown as [{ id: string } | undefined];
      if (!locked) throw Object.assign(new Error("Order not found"), { code: 404 });

      const [updated] = await tx.update(ordersTable)
        .set({
          status: "refunded",
          paymentStatus: "refunded",
          refundedAt: now,
          refundedAmount: refundAmount.toFixed(2),
          updatedAt: now,
        })
        .where(and(eq(ordersTable.id, orderId), sql`${ordersTable.refundedAt} IS NULL`))
        .returning({ id: ordersTable.id });

      /* If no row was returned the order was already refunded by another concurrent request. */
      if (!updated) throw Object.assign(new Error("Order has already been refunded"), { code: 409 });

      await tx.update(usersTable)
        .set({ walletBalance: sql`wallet_balance + ${refundAmount.toFixed(2)}`, updatedAt: now })
        .where(eq(usersTable.id, customerId));

      await tx.insert(walletTransactionsTable).values({
        id: generateId(),
        userId: customerId,
        type: "credit",
        amount: refundAmount.toFixed(2),
        description: `Admin refund for order #${orderId.slice(-6).toUpperCase()} — ${reason}`,
        reference: `refund:${orderId}`,
      });

      /* Use adminId as the actor. orderAuditLogTable.vendorId references users —
         admin accounts live in admin_accounts (separate table), so we use the
         customer ID as the FK target (valid user row) and record the admin in the note. */
      await tx.insert(orderAuditLogTable).values({
        id: generateId(),
        orderId,
        vendorId: customerId,
        fromStatus: order.status,
        toStatus: "refunded",
        note: `[admin:${adminId}] ${reason}`,
        changedAt: now,
      });
    });

    const [updatedUser] = await db.select({ walletBalance: usersTable.walletBalance })
      .from(usersTable).where(eq(usersTable.id, customerId)).limit(1);
    if (updatedUser) broadcastWalletUpdate(customerId, parseFloat(updatedUser.walletBalance ?? "0"));

    addAuditEntry({
      action: "order_refund",
      ip: getClientIp(req),
      details: `[admin:${adminId}] Refund of Rs. ${refundAmount.toFixed(0)} for order ${orderId} — ${reason}`,
      result: "success",
    });

    sendSuccess(res, {
      orderId,
      refundAmount,
      customerId,
      refundedAt: now.toISOString(),
      walletBalance: updatedUser ? parseFloat(updatedUser.walletBalance ?? "0") : null,
    }, `Refund of Rs. ${refundAmount.toFixed(0)} processed successfully`);
  } catch (e: unknown) {
    const code = (e as { code?: number }).code;
    const msg  = (e as Error).message ?? "";
    if (code === 404) { sendNotFound(res, msg); return; }
    if (code === 409) { sendValidationError(res, msg); return; }
    logger.error({ err: e, adminId, orderId }, "[orders/refund] failed");
    sendError(res, "An internal error occurred. Please try again.", 500);
  }
});

/* ── GET /orders/:id/timeline — full audit trail for an order ─────────────── */
router.get("/:id/timeline", customerAuth, async (req, res) => {
  const orderId = String(req.params["id"]);
  const userId  = req.customerId!;

  const [order] = await db.select({ id: ordersTable.id, userId: ordersTable.userId })
    .from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);

  if (!order) { sendNotFound(res, "Order not found"); return; }
  if (idorGuard(res, order.userId, userId)) return;

  const auditRows = await db.select()
    .from(orderAuditLogTable)
    .where(eq(orderAuditLogTable.orderId, orderId))
    .orderBy(desc(orderAuditLogTable.changedAt));

  sendSuccess(res, {
    orderId,
    timeline: auditRows.map(r => ({
      id: r.id,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      note: r.note ?? null,
      changedAt: r.changedAt.toISOString(),
    })),
  });
});

export default router;
