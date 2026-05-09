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

/**
 * After a transaction that decrements stock commits, read the authoritative
 * stock values from the DB and broadcast them to the affected vendor rooms.
 * This is always called OUTSIDE the transaction so the data is committed before
 * the emit fires — preventing phantom reads on the client side.
 */
async function broadcastStockUpdates(
  items: Array<{ productId?: string; variantId?: string; quantity: number }>,
): Promise<void> {
  const io = getIO();
  if (!io) return;
  const productIds = items.map(i => i.productId).filter(Boolean) as string[];
  if (productIds.length === 0) return;
  try {
    const rows = await db
      .select({
        id: productsTable.id,
        vendorId: productsTable.vendorId,
        stock: productsTable.stock,
        inStock: productsTable.inStock,
      })
      .from(productsTable)
      .where(inArray(productsTable.id, productIds));
    for (const row of rows) {
      const payload = { productId: row.id, vendorId: row.vendorId, stock: row.stock, inStock: row.inStock };
      io.to(`vendor:${row.vendorId}`).emit("product:stock_updated", payload);
      io.to("admin-fleet").emit("product:stock_updated", payload);
    }
  } catch (err) {
    logger.warn({ productIds, err: (err as Error).message }, "[orders] post-commit stock broadcast failed — vendors will see update on next poll");
  }
}

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

export default router;
