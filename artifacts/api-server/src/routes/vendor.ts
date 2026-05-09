import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { usersTable, ordersTable, productsTable, promoCodesTable, walletTransactionsTable, notificationsTable, reviewsTable, liveLocationsTable, deliveryWhitelistTable, deliveryAccessRequestsTable, riderProfilesTable, vendorProfilesTable, vendorSchedulesTable, stockSubscriptionsTable, orderAuditLogTable, productStockHistoryTable } from "@workspace/db/schema";
import { eq, desc, and, sql, count, sum, gte, or, ilike, isNull, avg, lte } from "drizzle-orm";
import { generateId } from "../lib/id.js";
import { getCachedSettings } from "./admin.js";
import { requireRole } from "../middleware/security.js";
import { validateBody } from "../middleware/validate.js";
import { t } from "@workspace/i18n";
import { getUserLanguage } from "../lib/getUserLanguage.js";
import { getIO, emitRiderNewRequest } from "../lib/socketio.js";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendForbidden, sendValidationError } from "../lib/response.js";
import { sendPushToUsers, sendPushToUser } from "../lib/webpush.js";

const router: IRouter = Router();

/* ── Auth: replaced duplicated vendorAuth with the shared requireRole factory ── */
router.use(requireRole("vendor", { vendorApprovalCheck: true }));

/* ── Vendor PATCH schemas ── */
const patchProfileSchema = z.object({
  name:             z.string().min(1).max(100).optional(),
  email:            z.string().email().optional(),
  cnic:             z.string().max(20).optional(),
  address:          z.string().max(300).optional(),
  city:             z.string().max(100).optional(),
  bankName:         z.string().max(100).optional(),
  bankAccount:      z.string().max(50).optional(),
  bankAccountTitle: z.string().max(100).optional(),
  businessType:     z.string().max(50).optional(),
}).strict();

const patchStoreSchema = z.object({
  storeName:         z.string().min(1).max(100).optional(),
  storeCategory:     z.string().max(50).optional(),
  storeBanner:       z.string().url().optional().nullable(),
  storeDescription:  z.string().max(1000).optional(),
  storeAnnouncement: z.string().max(500).optional(),
  storeDeliveryTime: z.string().max(50).optional(),
  storeIsOpen:       z.boolean().optional(),
  storeMinOrder:     z.number().min(0).optional(),
  storeAddress:      z.string().max(300).optional(),
  storeHours:        z.any().optional(),
  storeLat:          z.union([z.string(), z.number()]).optional().nullable(),
  storeLng:          z.union([z.string(), z.number()]).optional().nullable(),
});

function safeNum(v: any, def = 0) { return parseFloat(String(v ?? def)) || def; }
function formatUser(user: any) {
  return {
    id: user.id, phone: user.phone, name: user.name, email: user.email,
    username: user.username,
    avatar: user.avatar,
    storeName: user.storeName, storeCategory: user.storeCategory,
    storeBanner: user.storeBanner, storeDescription: user.storeDescription,
    storeHours: user.storeHours ? (typeof user.storeHours === "string" ? (() => { try { return JSON.parse(user.storeHours); } catch { return null; } })() : user.storeHours) : null,
    storeAnnouncement: user.storeAnnouncement,
    storeMinOrder: safeNum(user.storeMinOrder),
    storeDeliveryTime: user.storeDeliveryTime,
    storeIsOpen: user.storeIsOpen ?? true,
    storeLat: user.storeLat, storeLng: user.storeLng,
    walletBalance: safeNum(user.walletBalance),
    cnic: user.cnic, address: user.address, city: user.city, area: user.area,
    bankName: user.bankName, bankAccount: user.bankAccount, bankAccountTitle: user.bankAccountTitle,
    businessType: user.businessType,
    accountLevel: user.accountLevel, kycStatus: user.kycStatus,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/* ── GET /vendor/me ── */
router.get("/me", async (req, res) => {
  const user = req.vendorUser!;
  const vendorId = user.id;
  const today = new Date(); today.setHours(0,0,0,0);

  const s = await getCachedSettings();
  const vendorShare = 1 - (parseFloat(s["vendor_commission_pct"] ?? "15") / 100);

  const [todayOrders, todayRev, totalOrders, totalRev] = await Promise.all([
    db.select({ c: count() }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), gte(ordersTable.createdAt, today))),
    db.select({ s: sum(ordersTable.total) }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), gte(ordersTable.createdAt, today), or(eq(ordersTable.status, "delivered"), eq(ordersTable.status, "completed")))),
    db.select({ c: count() }).from(ordersTable).where(eq(ordersTable.vendorId, vendorId)),
    db.select({ s: sum(ordersTable.total) }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), or(eq(ordersTable.status, "delivered"), eq(ordersTable.status, "completed")))),
  ]);
  sendSuccess(res, {
    ...formatUser(user),
    stats: {
      todayOrders:  todayOrders[0]?.c ?? 0,
      todayRevenue: parseFloat((safeNum(todayRev[0]?.s) * vendorShare).toFixed(2)),
      totalOrders:  totalOrders[0]?.c ?? 0,
      totalRevenue: parseFloat((safeNum(totalRev[0]?.s) * vendorShare).toFixed(2)),
    },
  });
});

/* ── PATCH /vendor/profile ── */
router.patch("/profile", validateBody(patchProfileSchema), async (req, res) => {
  const vendorId = req.vendorId!;
  const { name, email, cnic, address, city, bankName, bankAccount, bankAccountTitle, businessType } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name             !== undefined) updates.name             = name;
  if (email            !== undefined) updates.email            = email;
  if (cnic             !== undefined) updates.cnic             = cnic;
  if (address          !== undefined) updates.address          = address;
  if (city             !== undefined) updates.city             = city;
  if (bankName         !== undefined) updates.bankName         = bankName;
  if (bankAccount      !== undefined) updates.bankAccount      = bankAccount;
  if (bankAccountTitle !== undefined) updates.bankAccountTitle = bankAccountTitle;
  if (businessType     !== undefined) updates.businessType     = businessType;
  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, vendorId)).returning();
  sendSuccess(res, formatUser(user));
});

/* ── GET /vendor/profile/quick-replies ── */
router.get("/profile/quick-replies", async (req, res) => {
  const vendorId = req.vendorId!;
  const [profile] = await db
    .select({ quickReplies: vendorProfilesTable.quickReplies })
    .from(vendorProfilesTable)
    .where(eq(vendorProfilesTable.userId, vendorId));
  let shortcuts: string[] = [];
  if (profile?.quickReplies) {
    try {
      const parsed = JSON.parse(profile.quickReplies);
      if (Array.isArray(parsed) && parsed.every(s => typeof s === "string")) {
        shortcuts = parsed;
      }
    } catch {}
  }
  sendSuccess(res, { quickReplies: shortcuts });
});

/* ── PATCH /vendor/profile/quick-replies ── */
const patchQuickRepliesSchema = z.object({
  quickReplies: z.array(z.string().max(120)).max(8),
});

router.patch("/profile/quick-replies", validateBody(patchQuickRepliesSchema), async (req, res) => {
  const vendorId = req.vendorId!;
  const { quickReplies } = req.body as { quickReplies: string[] };
  const serialized = JSON.stringify(quickReplies.slice(0, 8));
  await db
    .insert(vendorProfilesTable)
    .values({ userId: vendorId, quickReplies: serialized })
    .onConflictDoUpdate({
      target: vendorProfilesTable.userId,
      set: { quickReplies: serialized, updatedAt: new Date() },
    });
  sendSuccess(res, { quickReplies });
});

/* ── GET /vendor/store ── */
router.get("/store", async (req, res) => {
  const user = req.vendorUser!;
  sendSuccess(res, formatUser(user));
});

/* ── PATCH /vendor/store ── */
router.patch("/store", validateBody(patchStoreSchema), async (req, res) => {
  const vendorId = req.vendorId!;
  const body = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fields = ["storeName","storeCategory","storeBanner","storeDescription","storeAnnouncement","storeDeliveryTime","storeIsOpen","storeMinOrder","storeAddress"];
  for (const f of fields) {
    if (body[f] !== undefined) updates[f] = body[f];
  }
  if (body.storeHours !== undefined) updates.storeHours = typeof body.storeHours === "string" ? body.storeHours : JSON.stringify(body.storeHours);
  if (body.storeLat !== undefined && body.storeLat !== null) updates.storeLat = String(body.storeLat);
  if (body.storeLng !== undefined && body.storeLng !== null) updates.storeLng = String(body.storeLng);
  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, vendorId)).returning();
  sendSuccess(res, formatUser(user));
});

/* ── GET /vendor/stats ── */
router.get("/stats", async (req, res) => {
  const vendorId = req.vendorId!;
  const today = new Date(); today.setHours(0,0,0,0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);

  const s = await getCachedSettings();
  const vendorShare = 1 - (parseFloat(s["vendor_commission_pct"] ?? "15") / 100);

  const [tData, wData, mData, pending, lowStock] = await Promise.all([
    db.select({ c: count(), s: sum(ordersTable.total) }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), gte(ordersTable.createdAt, today))),
    db.select({ c: count(), s: sum(ordersTable.total) }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), gte(ordersTable.createdAt, weekAgo))),
    db.select({ c: count(), s: sum(ordersTable.total) }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), gte(ordersTable.createdAt, monthAgo))),
    db.select({ c: count() }).from(ordersTable).where(and(eq(ordersTable.vendorId, vendorId), eq(ordersTable.status, "pending"))),
    getCachedSettings().then(cfg => {
      const threshold = parseInt(cfg["low_stock_threshold"] ?? "10", 10) || 10;
      return db.select({ c: count() }).from(productsTable).where(and(eq(productsTable.vendorId, vendorId), isNull(productsTable.deletedAt), sql`stock IS NOT NULL AND stock < ${threshold} AND stock > 0`));
    }),
  ]);
  sendSuccess(res, {
    today:    { orders: tData[0]?.c??0, revenue: parseFloat((safeNum(tData[0]?.s)*vendorShare).toFixed(2)) },
    week:     { orders: wData[0]?.c??0, revenue: parseFloat((safeNum(wData[0]?.s)*vendorShare).toFixed(2)) },
    month:    { orders: mData[0]?.c??0, revenue: parseFloat((safeNum(mData[0]?.s)*vendorShare).toFixed(2)) },
    pending:  pending[0]?.c ?? 0,
    lowStock: lowStock[0]?.c ?? 0,
  });
});

/* ── GET /vendor/orders ── */
router.get("/orders", async (req, res) => {
  const vendorId = req.vendorId!;
  const status = req.query["status"] as string | undefined;
  const conditions: any[] = [eq(ordersTable.vendorId, vendorId)];
  if (status && status !== "all") {
    if (status === "new") conditions.push(or(eq(ordersTable.status, "pending"), eq(ordersTable.status, "confirmed")));
    else if (status === "active") conditions.push(or(eq(ordersTable.status, "preparing"), eq(ordersTable.status, "ready"), eq(ordersTable.status, "picked_up"), eq(ordersTable.status, "out_for_delivery")));
    else conditions.push(eq(ordersTable.status, status));
  }
  const orders = await db.select({
    order: ordersTable,
    riderName: usersTable.name,
    riderPhone: usersTable.phone,
  }).from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.riderId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(ordersTable.createdAt))
    .limit(100);
  sendSuccess(res, { orders: orders.map(row => ({ ...row.order, total: safeNum(row.order.total), riderName: row.riderName ?? undefined, riderPhone: row.riderPhone ?? undefined })) });
});

/* ── PATCH /vendor/orders/:id/status ── */
router.patch("/orders/:id/status", async (req, res) => {
  const vendorId = req.vendorId!;
  /* Strict: only status and note accepted — reject price/total etc. explicitly */
  const allowedKeys = new Set(["status", "note"]);
  const extraKeys = Object.keys(req.body).filter(k => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    sendValidationError(res, `Unexpected fields: ${extraKeys.join(", ")}. Only "status" and "note" are accepted.`);
    return;
  }
  const { status, note } = req.body as { status?: string; note?: string };
  const validStatuses = ["confirmed","preparing","ready","cancelled"];
  if (!status || !validStatuses.includes(status)) { sendValidationError(res, "Invalid status"); return; }
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.id, req.params["id"]!), eq(ordersTable.vendorId, vendorId))).limit(1);
  if (!order) { sendNotFound(res, "Order not found"); return; }

  /* ── Cancellation time window: vendor can only cancel within 5 minutes ── */
  if (status === "cancelled") {
    const msSincePlaced = Date.now() - new Date(order.createdAt).getTime();
    if (msSincePlaced > 5 * 60 * 1000) {
      sendForbidden(res, "Cancellation window has passed. Orders can only be cancelled within 5 minutes of being placed.");
      return;
    }
  }

  const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    pending:   ["confirmed", "cancelled"],
    confirmed: ["preparing", "cancelled"],
    preparing: ["ready", "cancelled"],
    ready:     [],
    delivered: [],
    cancelled: [],
    completed: [],
  };
  const allowed = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    sendValidationError(res, `Cannot change order from "${order.status}" to "${status}". Allowed: ${allowed.join(", ") || "none"}.`);
    return;
  }

  const orderId = req.params["id"]!;
  const custLang = await getUserLanguage(order.userId);
  const msgs: Record<string, { title: string; body: string }> = {
    confirmed: { title: t("notifOrderConfirmed", custLang) + " ✅", body: t("notifOrderConfirmedBody", custLang) },
    preparing: { title: t("notifOrderPreparing", custLang) + " 🍳",  body: t("notifOrderPreparingBody", custLang) },
    ready:     { title: t("notifOrderReady", custLang) + " 📦",    body: t("notifOrderReadyBody", custLang) },
    cancelled: { title: t("notifOrderCancelled", custLang) + " ❌", body: t("notifOrderCancelledBody", custLang) },
  };

  let updated: typeof order;

  if (status === "confirmed") {
    /*
     * SINGLE-DECREMENT DESIGN — DO NOT RE-INTRODUCE STOCK DECREMENT HERE.
     *
     * Stock was already decremented atomically at order placement time inside
     * the `decrementStock()` call in orders.ts (within the placement db.transaction).
     * That path uses SELECT FOR UPDATE row-locking and writes a full audit record
     * to product_stock_history with quantityDelta and orderId.
     *
     * Adding a second decrement here would silently halve vendor stock on every
     * confirmed order, causing vendors to run out of inventory at double the real
     * rate. The confirmation step only needs to advance the order status.
     *
     * If you need to guard against oversell at confirmation time, add a
     * stock-check READ (no UPDATE) here and return 409 if stock has somehow
     * gone negative — but do NOT decrement again.
     */

    /* Write an informational (zero-delta) audit record so the history trail
       shows that this order was confirmed, without touching the stock count. */
    const confirmItems = Array.isArray(order.items) ? (order.items as Array<{ productId?: string; quantity?: number }>) : [];
    const confirmItemsWithProducts = confirmItems.filter(it => it.productId);

    try {
      const [result] = await db.update(ordersTable)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(ordersTable.id, orderId), eq(ordersTable.vendorId, vendorId)))
        .returning();
      if (!result) { sendNotFound(res, "Order not found"); return; }
      updated = result;

      /* Informational audit entries — quantityDelta is 0 to make clear no stock moved */
      for (const item of confirmItemsWithProducts) {
        const [prod] = await db.select({ id: productsTable.id, stock: productsTable.stock })
          .from(productsTable)
          .where(and(eq(productsTable.id, item.productId!), eq(productsTable.vendorId, vendorId)))
          .limit(1);
        if (!prod) continue;
        await db.insert(productStockHistoryTable).values({
          id: generateId(), productId: prod.id, vendorId,
          previousStock: prod.stock,
          newStock: prod.stock,
          quantityDelta: 0,
          reason: "order_confirmed",
          orderId,
          source: `confirm:${orderId}`,
        }).catch(() => {});
      }
    } catch (e: unknown) {
      const err = e as Error;
      sendNotFound(res, err.message || "Failed to confirm order");
      return;
    }
  } else if (status === "cancelled" && order.paymentMethod === "wallet") {
    /* Atomic: status update + wallet credit + refund stamp in one tx.
       WHERE refunded_at IS NULL guard prevents double-credit under concurrent requests. */
    const refundAmt = safeNum(order.total);
    const now = new Date();
    const txResult = await db.transaction(async (tx) => {
      const result = await tx.update(ordersTable)
        .set({ status, refundedAt: now, refundedAmount: refundAmt.toFixed(2), paymentStatus: "refunded", updatedAt: now })
        .where(and(eq(ordersTable.id, orderId), eq(ordersTable.vendorId, vendorId), isNull(ordersTable.refundedAt)))
        .returning();
      if (result.length === 0) throw new Error("ALREADY_REFUNDED");
      await tx.update(usersTable)
        .set({ walletBalance: sql`wallet_balance + ${refundAmt}`, updatedAt: now })
        .where(eq(usersTable.id, order.userId));
      await tx.insert(walletTransactionsTable).values({
        id: generateId(), userId: order.userId, type: "credit",
        amount: refundAmt.toFixed(2),
        description: `Refund — Order #${orderId.slice(-6).toUpperCase()} cancelled by store`,
      });
      return result[0];
    }).catch((err: Error) => {
      if (err.message === "ALREADY_REFUNDED") return null;
      throw err;
    });
    if (!txResult) { sendError(res, "Order has already been refunded", 409); return; }
    updated = txResult;
    await db.insert(notificationsTable).values({ id: generateId(), userId: order.userId, title: t("notifRefundProcessed", custLang) + " 💰", body: t("notifRefundProcessedBody", custLang).replace("{amount}", safeNum(order.total).toFixed(0)), type: "wallet", icon: "wallet-outline" }).catch((e: Error) => logger.warn({ orderId, userId: order.userId, err: e.message }, "[vendor/order-status] refund notification insert failed"));
  } else {
    /* Non-wallet or non-cancel: plain status update — vendorId in WHERE closes TOCTOU window */
    const [result] = await db.update(ordersTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.vendorId, vendorId)))
      .returning();
    if (!result) { sendNotFound(res, "Order not found"); return; }
    updated = result;
  }

  /* ── Audit trail: record every status transition ── */
  await db.insert(orderAuditLogTable).values({
    id: generateId(), orderId, vendorId,
    fromStatus: order.status, toStatus: status,
    note: note || null,
  }).catch((e: Error) => logger.warn({ orderId, vendorId, err: e.message }, "[vendor/order-status] audit log insert failed"));

  if (msgs[status]) {
    await db.insert(notificationsTable).values({ id: generateId(), userId: order.userId, title: msgs[status]!.title, body: msgs[status]!.body, type: "order", icon: "bag-outline" }).catch((e: Error) => logger.warn({ orderId, userId: order.userId, status, err: e.message }, "[vendor/order-status] status notification insert failed"));
  }

  /* ── Push notification to customer ── */
  (async () => {
    try {
      const { sendPushToUsers } = await import("../lib/webpush.js");
      if (msgs[status]) {
        await sendPushToUsers([order.userId], {
          title: msgs[status]!.title,
          body: msgs[status]!.body,
          tag: `order-${orderId}-${status}`,
          data: { orderId, type: status === "cancelled" ? "order_cancelled" : "order_status", status },
        });
      }
    } catch (e) {
      logger.warn({ orderId, err: (e as Error).message }, "[vendor/order-status] push notification failed");
    }
  })();

  const io = getIO();
  if (io) {
    const mapped = { ...updated, total: safeNum(updated.total) };
    io.to("admin-fleet").emit("order:update", mapped);
    io.to(`vendor:${vendorId}`).emit("order:update", mapped);
    if (updated.riderId) io.to(`rider:${updated.riderId}`).emit("order:update", mapped);
  }

  if (status === "ready" && !updated.riderId) {
    (async () => {
      try {
        const onlineRiders = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(and(
            ilike(usersTable.roles, "%rider%"),
            eq(usersTable.isOnline, true),
          ));
        for (const { id: riderId } of onlineRiders) {
          emitRiderNewRequest(riderId, { type: "order_ready", requestId: orderId, summary: `Order ready for pickup` });
        }
      } catch (err) {
        logger.warn({ orderId, err: err instanceof Error ? err.message : String(err) }, "[vendor] Failed to notify riders about ready order");
      }
    })();
  }

  sendSuccess(res, { ...updated, total: safeNum(updated.total) });
});

/* ── GET /vendor/products ── */
router.get("/products", async (req, res) => {
  const vendorId = req.vendorId!;
  const q = req.query["q"] as string | undefined;
  const cat = req.query["category"] as string | undefined;
  const conditions: any[] = [eq(productsTable.vendorId, vendorId), isNull(productsTable.deletedAt)];
  if (q) conditions.push(ilike(productsTable.name, `%${q}%`));
  if (cat && cat !== "all") conditions.push(eq(productsTable.category, cat));
  const products = await db.select().from(productsTable).where(and(...conditions)).orderBy(desc(productsTable.createdAt));
  sendSuccess(res, { products: products.map(p => ({ ...p, price: safeNum(p.price), originalPrice: p.originalPrice ? safeNum(p.originalPrice) : null, rating: safeNum(p.rating, 4.0) })) });
});

/* ── POST /vendor/products ── Add single product ── */
router.post("/products", async (req, res) => {
  const vendorId = req.vendorId!;
  const user = req.vendorUser!;
  const body = req.body;
  if (!body.name || !body.price) { sendValidationError(res, "name and price required"); return; }
  if (!isFinite(Number(body.price)) || Number(body.price) <= 0) {
    sendValidationError(res, "Price must be a positive number"); return;
  }
  if (body.stock !== undefined && body.stock !== null && body.stock !== "") {
    const stockVal = Number(body.stock);
    if (!isFinite(stockVal) || stockVal < 0) {
      sendValidationError(res, "Stock cannot be negative"); return;
    }
  }

  const s = await getCachedSettings();
  const maxItems = parseInt(s["vendor_max_items"] ?? "100");
  const [countRow] = await db.select({ c: count() }).from(productsTable).where(and(eq(productsTable.vendorId, vendorId), isNull(productsTable.deletedAt)));
  if ((countRow?.c ?? 0) >= maxItems) {
    sendValidationError(res, `Product limit reached. Maximum ${maxItems} items allowed per vendor.`); return;
  }

  const [product] = await db.insert(productsTable).values({
    id: generateId(), vendorId, vendorName: user.storeName || user.name,
    name: body.name, description: body.description || null,
    price: String(body.price), originalPrice: body.originalPrice ? String(body.originalPrice) : null,
    category: body.category || "general", type: body.type || "mart",
    image: body.image || null, videoUrl: body.videoUrl || null, inStock: false,
    stock: body.stock ? Number(body.stock) : null,
    unit: body.unit || null, deliveryTime: body.deliveryTime || null,
    approvalStatus: "pending",
  }).returning();
  sendCreated(res, { ...product, price: safeNum(product.price) });
});

/* ── POST /vendor/products/bulk ── Bulk add products ── */
router.post("/products/bulk", async (req, res) => {
  const vendorId = req.vendorId!;
  const user = req.vendorUser!;
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) { sendValidationError(res, "products array required"); return; }
  if (products.length > 50) { sendValidationError(res, "Max 50 products at a time"); return; }

  const s2 = await getCachedSettings();
  const maxItems2 = parseInt(s2["vendor_max_items"] ?? "100");
  const [countRow2] = await db.select({ c: count() }).from(productsTable).where(and(eq(productsTable.vendorId, vendorId), isNull(productsTable.deletedAt)));
  const currentCount = countRow2?.c ?? 0;
  if (currentCount + products.length > maxItems2) {
    sendValidationError(res, `Product limit exceeded. You have ${currentCount}/${maxItems2} items. Can only add ${Math.max(0, maxItems2 - currentCount)} more.`); return;
  }
  const invalid = products.filter(p => !p.name || !p.price || !isFinite(Number(p.price)) || Number(p.price) <= 0);
  if (invalid.length > 0) { sendValidationError(res, `${invalid.length} product(s) missing name, or have an invalid/non-positive price`); return; }
  const negativeStock = products.filter(p => p.stock !== undefined && p.stock !== null && p.stock !== "" && Number(p.stock) < 0);
  if (negativeStock.length > 0) { sendValidationError(res, `${negativeStock.length} product(s) have negative stock values. Stock must be 0 or greater.`); return; }
  const inserted = await db.insert(productsTable).values(
    products.map(p => ({
      id: generateId(), vendorId, vendorName: user.storeName || user.name,
      name: p.name, description: p.description || null,
      price: String(p.price), originalPrice: p.originalPrice ? String(p.originalPrice) : null,
      category: p.category || "general", type: p.type || "mart",
      image: p.image || null, videoUrl: p.videoUrl || null, inStock: false,
      stock: p.stock ? Number(p.stock) : null, unit: p.unit || null,
      approvalStatus: "pending",
    }))
  ).returning();

  /* ── Bulk stock history: record initial stock for products with stock values ── */
  const withStock = inserted.filter(p => p.stock !== null);
  if (withStock.length > 0) {
    await db.insert(productStockHistoryTable).values(
      withStock.map(p => ({
        id: generateId(), productId: p.id, vendorId,
        previousStock: null,
        newStock: p.stock,
        source: "bulk_add",
      }))
    ).catch((e: Error) => logger.warn({ err: e.message }, "[vendor/products/bulk] stock history insert failed"));
  }

  sendCreated(res, { inserted: inserted.length, products: inserted.map(p => ({ ...p, price: safeNum(p.price) })) });
});

/* ── PATCH /vendor/products/bulk ── Bulk update price/stock for existing products ── */
router.patch("/products/bulk", async (req, res) => {
  const vendorId = req.vendorId!;
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) { sendValidationError(res, "products array required"); return; }
  if (products.length > 200) { sendValidationError(res, "Max 200 products per bulk update"); return; }

  const ids: string[] = products.map((p: any) => p.id).filter(Boolean);
  if (ids.length !== products.length) { sendValidationError(res, "Each product must have an id"); return; }

  for (const p of products) {
    if (p.price !== undefined && (!isFinite(Number(p.price)) || Number(p.price) <= 0)) {
      sendValidationError(res, `Invalid price for product ${p.id}`); return;
    }
    if (p.stock !== undefined && p.stock !== null && Number(p.stock) < 0) {
      sendValidationError(res, `Negative stock not allowed for product ${p.id}`); return;
    }
  }

  let updatedCount = 0;
  for (const p of products) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (p.price !== undefined) patch.price = String(p.price);
    if (p.stock !== undefined) patch.stock = p.stock !== null ? Number(p.stock) : null;
    if (Object.keys(patch).length === 1) continue;
    const [row] = await db.update(productsTable).set(patch)
      .where(and(eq(productsTable.id, p.id), eq(productsTable.vendorId, vendorId)))
      .returning({ id: productsTable.id });
    if (row) updatedCount++;
  }

  sendSuccess(res, { updated: updatedCount });
});

/* ── PATCH /vendor/products/:id ── Update product ── */
router.patch("/products/:id", async (req, res) => {
  const vendorId = req.vendorId!;
  const body = req.body;

  /* Snapshot previous state for back-in-stock detection and stock history */
  const [prevProduct] = await db.select({ inStock: productsTable.inStock, stock: productsTable.stock, name: productsTable.name })
    .from(productsTable)
    .where(and(eq(productsTable.id, req.params["id"]!), eq(productsTable.vendorId, vendorId)))
    .limit(1);
  if (!prevProduct) { sendNotFound(res, "Product not found"); return; }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fields = ["name","description","category","type","unit","deliveryTime"];
  for (const f of fields) if (body[f] !== undefined) updates[f] = body[f];
  if (body.price !== undefined) {
    if (!isFinite(Number(body.price)) || Number(body.price) <= 0) {
      sendValidationError(res, "Price must be a positive number"); return;
    }
    updates.price = String(body.price);
  }
  if (body.originalPrice !== undefined) updates.originalPrice = body.originalPrice ? String(body.originalPrice) : null;
  if (body.inStock     !== undefined) updates.inStock      = body.inStock;
  if (body.stock       !== undefined) {
    const newStockVal = body.stock !== null ? Number(body.stock) : null;
    /* Block negative stock at backend validation layer */
    if (newStockVal !== null && newStockVal < 0) {
      sendValidationError(res, "Stock cannot be negative"); return;
    }
    updates.stock = newStockVal;
  }
  if (body.image              !== undefined) updates.image             = body.image;
  if (body.videoUrl           !== undefined) updates.videoUrl          = body.videoUrl || null;
  if (body.lowStockThreshold !== undefined) {
    if (body.lowStockThreshold !== null) {
      const lst = Number(body.lowStockThreshold);
      if (!isFinite(lst) || lst < 0 || !Number.isInteger(lst)) {
        sendValidationError(res, "lowStockThreshold must be a non-negative integer"); return;
      }
      updates.lowStockThreshold = lst;
    } else {
      updates.lowStockThreshold = null;
    }
  }
  const [product] = await db.update(productsTable).set(updates).where(and(eq(productsTable.id, req.params["id"]!), eq(productsTable.vendorId, vendorId))).returning();
  if (!product) { sendNotFound(res, "Product not found"); return; }

  /* ── Stock history: record changes to stock field ── */
  if (body.stock !== undefined && body.stock !== null && prevProduct.stock !== product.stock) {
    await db.insert(productStockHistoryTable).values({
      id: generateId(), productId: product.id, vendorId,
      previousStock: prevProduct.stock,
      newStock: product.stock,
      source: "manual",
    }).catch((e: Error) => logger.warn({ productId: product.id, err: e.message }, "[vendor/products] stock history insert failed"));
  }

  /* ── Back-in-stock: notify subscribers if product just became available ── */
  /* Trigger when: (a) inStock flipped to true, OR (b) stock transitioned from <=0 to >0 */
  const wasOutOfStock = !prevProduct.inStock || (prevProduct.stock !== null && prevProduct.stock <= 0);
  const isNowAvailable = product.inStock || (product.stock !== null && product.stock > 0);
  if (wasOutOfStock && isNowAvailable) {
    try {
      const subs = await db.select({ userId: stockSubscriptionsTable.userId })
        .from(stockSubscriptionsTable)
        .where(eq(stockSubscriptionsTable.productId, product.id));
      if (subs.length > 0) {
        const userIds = subs.map(s => s.userId);
        await sendPushToUsers(userIds, {
          title: "Back in Stock!",
          body: `${product.name} is available again. Order now before it sells out!`,
          tag: `back-in-stock-${product.id}`,
          data: { productId: product.id, type: "back_in_stock" },
        });
        await db.delete(stockSubscriptionsTable).where(eq(stockSubscriptionsTable.productId, product.id));
      }
    } catch (e) {
      logger.warn({ productId: product.id, err: (e as Error).message }, "[vendor] back-in-stock notification failed");
    }
  }

  /* ── Real-time broadcast: push stock update to vendor room and admin fleet ── */
  const io = getIO();
  if (io && (body.stock !== undefined || body.inStock !== undefined)) {
    const payload = { productId: product.id, vendorId, stock: product.stock, inStock: product.inStock };
    io.to(`vendor:${vendorId}`).emit("product:stock_updated", payload);
    io.to("admin-fleet").emit("product:stock_updated", payload);
  }

  sendSuccess(res, { ...product, price: safeNum(product.price) });
});

/* ── GET /vendor/products/:id/stock-history ── */
router.get("/products/:id/stock-history", async (req, res) => {
  const vendorId = req.vendorId!;
  const productId = req.params["id"]!;
  /* Verify ownership */
  const [prod] = await db.select({ id: productsTable.id }).from(productsTable)
    .where(and(eq(productsTable.id, productId), eq(productsTable.vendorId, vendorId))).limit(1);
  if (!prod) { sendNotFound(res, "Product not found"); return; }
  const rows = await db.select().from(productStockHistoryTable)
    .where(eq(productStockHistoryTable.productId, productId))
    .orderBy(desc(productStockHistoryTable.changedAt))
    .limit(50);
  /* Transform to client-friendly shape: delta, reason, stockAfter */
  const history = rows.map(r => ({
    id: r.id,
    delta: (r.newStock ?? 0) - (r.previousStock ?? 0),
    reason: r.source,
    stockAfter: r.newStock,
    orderId: null,
    createdAt: r.changedAt,
  }));
  sendSuccess(res, { history });
});

/* ── DELETE /vendor/products/:id ── */
router.delete("/products/:id", async (req, res) => {
  const vendorId = req.vendorId!;
  const [del] = await db
    .update(productsTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(productsTable.id, req.params["id"]!), eq(productsTable.vendorId, vendorId), isNull(productsTable.deletedAt)))
    .returning({ id: productsTable.id });
  if (!del) { sendNotFound(res, "Product not found"); return; }
  sendSuccess(res);
});

/* ── GET /vendor/promos ── Vendor promo codes ── */
router.get("/promos", async (req, res) => {
  const vendorId = req.vendorId!;
  const promos = await db.select().from(promoCodesTable).where(eq(promoCodesTable.vendorId, vendorId)).orderBy(desc(promoCodesTable.createdAt));
  sendSuccess(res, { promos: promos.map(p => ({ ...p, discountPct: safeNum(p.discountPct), discountFlat: safeNum(p.discountFlat), minOrderAmount: safeNum(p.minOrderAmount) })) });
});

/* ── POST /vendor/promos ── Create promo ── */
router.post("/promos", async (req, res) => {
  const vendorId = req.vendorId!;
  const body = req.body;
  if (!body.code || (!body.discountPct && !body.discountFlat)) {
    sendValidationError(res, "code + discount (% or flat) required"); return;
  }
  const sp = await getCachedSettings();
  if ((sp["vendor_promo_enabled"] ?? "on") !== "on") {
    sendForbidden(res, "Promo code creation is currently disabled by admin."); return;
  }
  const [existing] = await db.select({ id: promoCodesTable.id }).from(promoCodesTable).where(eq(promoCodesTable.code, body.code.toUpperCase())).limit(1);
  if (existing) { sendValidationError(res, "Promo code already exists"); return; }
  const [promo] = await db.insert(promoCodesTable).values({
    id: generateId(), code: body.code.toUpperCase().trim(),
    description: body.description || null,
    discountPct: body.discountPct ? String(body.discountPct) : null,
    discountFlat: body.discountFlat ? String(body.discountFlat) : null,
    minOrderAmount: String(body.minOrderAmount || 0),
    maxDiscount: body.maxDiscount ? String(body.maxDiscount) : null,
    usageLimit: body.usageLimit ? Number(body.usageLimit) : null,
    appliesTo: body.appliesTo || "all",
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    vendorId, isActive: true,
  }).returning();
  sendCreated(res, { ...promo, discountPct: safeNum(promo.discountPct), discountFlat: safeNum(promo.discountFlat) });
});

/* ── PATCH /vendor/promos/:id/toggle ── */
router.patch("/promos/:id/toggle", async (req, res) => {
  const vendorId = req.vendorId!;
  const [promo] = await db.select().from(promoCodesTable).where(and(eq(promoCodesTable.id, req.params["id"]!), eq(promoCodesTable.vendorId, vendorId))).limit(1);
  if (!promo) { sendNotFound(res, "Promo not found"); return; }
  const [updated] = await db.update(promoCodesTable).set({ isActive: !promo.isActive }).where(eq(promoCodesTable.id, promo.id)).returning();
  sendSuccess(res, updated);
});

/* ── DELETE /vendor/promos/:id ── */
router.delete("/promos/:id", async (req, res) => {
  const vendorId = req.vendorId!;
  await db.delete(promoCodesTable).where(and(eq(promoCodesTable.id, req.params["id"]!), eq(promoCodesTable.vendorId, vendorId)));
  sendSuccess(res);
});

/* ── GET /vendor/wallet/transactions ── Cursor-paginated ── */
router.get("/wallet/transactions", async (req, res) => {
  const vendorId = req.vendorId!;
  const { buildCursorPage, decodeCursor } = await import("../lib/pagination/cursor.js");
  const limit  = Math.min(parseInt(String(req.query["limit"] || "50")), 100);
  const after  = req.query["after"] as string | undefined;
  const cursor = after ? decodeCursor(after) : null;

  const txns = await db.select().from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, vendorId),
      ...(cursor ? [sql`${walletTransactionsTable.createdAt} < ${cursor}::timestamptz`] : []),
    ))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(limit + 1);

  const page = buildCursorPage({
    data: txns,
    limit,
    getCursorValue: (t) => t.createdAt.toISOString(),
  });
  const user = req.vendorUser!;

  /* ── Commission / platform-fee breakdown per transaction ── */
  const s = await getCachedSettings();
  const commissionPct = parseFloat(s["vendor_commission_pct"] ?? "15");
  const vendorKeepPct = 100 - commissionPct;

  const enriched = page.data.map(t => {
    const amt = safeNum(t.amount);
    /* Only credit transactions from orders carry commission info */
    const isOrderCredit = t.type === "credit" && t.description && (t.description.includes("Order") || t.description.includes("order"));
    if (isOrderCredit && amt > 0) {
      const grossOrderValue = parseFloat((amt / (vendorKeepPct / 100)).toFixed(2));
      const commissionDeducted = parseFloat((grossOrderValue * commissionPct / 100).toFixed(2));
      return { ...t, amount: amt, commissionDeducted, platformFee: commissionDeducted, netPayout: amt, grossAmount: grossOrderValue };
    }
    return { ...t, amount: amt, commissionDeducted: 0, platformFee: 0, netPayout: amt };
  });

  /* ── Daily settlement summary ── */
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTxns = page.data.filter(t => new Date(t.createdAt) >= today);
  const dailyCredits = todayTxns.filter(t => t.type === "credit" || t.type === "bonus").reduce((s, t) => s + safeNum(t.amount), 0);
  const dailyDebits  = todayTxns.filter(t => t.type === "debit").reduce((s, t) => s + safeNum(t.amount), 0);
  const dailyCommission = parseFloat((dailyCredits * commissionPct / 100).toFixed(2));
  const dailyNetPayout  = parseFloat((dailyCredits - dailyCommission).toFixed(2));

  sendSuccess(res, {
    balance: safeNum(user.walletBalance),
    transactions: enriched,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    commissionPct,
    vendorKeepPct,
    dailySettlement: {
      date: today.toISOString().slice(0, 10),
      grossCredits: parseFloat(dailyCredits.toFixed(2)),
      commissionDeducted: dailyCommission,
      netPayout: dailyNetPayout,
      debits: parseFloat(dailyDebits.toFixed(2)),
      transactionCount: todayTxns.length,
    },
  });
});

/* ── POST /vendor/wallet/withdraw ── Atomic Withdrawal Request ── */
router.post("/wallet/withdraw", async (req, res) => {
  const vendorId = req.vendorId!;
  const { amount, accountTitle, accountNumber, bankName, note } = req.body;
  const amt = safeNum(amount);

  const sw = await getCachedSettings();
  if ((sw["vendor_withdrawal_enabled"] ?? "on") !== "on") {
    sendForbidden(res, "Withdrawal requests are temporarily disabled by admin. Please try again later."); return;
  }
  const minPayout = parseFloat(sw["vendor_min_payout"] ?? "500");
  const maxPayout = parseFloat(sw["vendor_max_payout"] ?? "50000");

  if (!amt || amt <= 0) { sendValidationError(res, "Valid amount required"); return; }
  if (amt < minPayout) { sendValidationError(res, `Minimum withdrawal is Rs. ${minPayout}`); return; }
  if (amt > maxPayout) { sendValidationError(res, `Maximum single withdrawal is Rs. ${maxPayout}`); return; }
  if (!accountTitle || !accountNumber || !bankName) {
    sendValidationError(res, "Account title, number, and bank name are required"); return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, vendorId)).limit(1);
      if (!user) throw new Error("User not found");

      const balance = safeNum(user.walletBalance);
      if (amt > balance) throw new Error(`Insufficient balance. Available: Rs. ${balance}`);

      /* DB-level floor guard in WHERE — prevents negative balance even when two
         concurrent withdrawal requests both pass the pre-flight check above.
         Same pattern applied to all other deduction sites in Pass 17. */
      const [debited] = await tx.update(usersTable)
        .set({ walletBalance: sql`wallet_balance - ${amt}`, updatedAt: new Date() })
        .where(and(eq(usersTable.id, vendorId), gte(usersTable.walletBalance, String(amt))))
        .returning({ id: usersTable.id });
      if (!debited) throw new Error("Insufficient balance — please refresh and try again.");

      const [txRow] = await tx.insert(walletTransactionsTable).values({
        id: generateId(), userId: vendorId, type: "debit",
        amount: amt.toFixed(2),
        description: `Withdrawal request — ${bankName} · ${accountNumber} · ${accountTitle}${note ? ` · Note: ${note}` : ""}`,
      }).returning({ id: walletTransactionsTable.id });
      return { newBalance: balance - amt, transactionId: txRow?.id ?? null };
    });

    const wdLang = await getUserLanguage(vendorId);
    await db.insert(notificationsTable).values({
      id: generateId(), userId: vendorId,
      title: t("notifVendorWithdrawal", wdLang),
      body: t("notifVendorWithdrawalBody", wdLang).replace("{amount}", String(amt)),
      type: "wallet", icon: "cash-outline",
    }).catch((e: Error) => logger.warn({ vendorId, err: e.message }, "[vendor/withdraw] withdrawal notification insert failed"));

    sendSuccess(res, { newBalance: parseFloat(result.newBalance.toFixed(2)), amount: amt, transactionId: result.transactionId });
  } catch (e: unknown) {
    sendValidationError(res, (e as Error).message);
  }
});

/* ── POST /vendor/wallet/deposit ── Deposit Request (manual payment verification) ── */
router.post("/wallet/deposit", async (req, res) => {
  const vendorId = req.vendorId!;
  const { amount, paymentMethod, paymentReference, note } = req.body;
  const amt = safeNum(amount);

  if (!amt || amt <= 0) { sendValidationError(res, "Valid amount required"); return; }
  if (amt > 100000) { sendValidationError(res, "Maximum single deposit is Rs. 100,000"); return; }
  if (!paymentMethod || typeof paymentMethod !== "string") { sendValidationError(res, "Payment method is required"); return; }
  if (!paymentReference || typeof paymentReference !== "string" || !paymentReference.trim()) {
    sendValidationError(res, "Payment reference / transaction ID is required"); return;
  }

  try {
    await db.insert(walletTransactionsTable).values({
      id: generateId(), userId: vendorId, type: "credit",
      amount: "0.00",
      description: `Deposit request pending admin verification — ${paymentMethod} · Ref: ${paymentReference.trim()}${note ? ` · Note: ${note}` : ""}`,
    });

    const dpLang = await getUserLanguage(vendorId);
    await db.insert(notificationsTable).values({
      id: generateId(), userId: vendorId,
      title: "Deposit Request Submitted",
      body: `Your deposit of Rs. ${amt.toFixed(0)} via ${paymentMethod} is pending admin verification.`,
      type: "wallet", icon: "wallet-outline",
    }).catch((e: Error) => logger.warn({ vendorId, err: e.message }, "[vendor/deposit] deposit notification insert failed"));

    sendSuccess(res, { amount: amt, paymentMethod, paymentReference: paymentReference.trim(), message: "Deposit request submitted successfully. Admin will verify and credit your wallet within 24–48 hours." });
  } catch (e: unknown) {
    sendValidationError(res, (e as Error).message);
  }
});

/* ── GET /vendor/notifications ── */
router.get("/notifications", async (req, res) => {
  const vendorId = req.vendorId!;
  const notifs = await db.select().from(notificationsTable)
    .where(eq(notificationsTable.userId, vendorId))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(30);
  sendSuccess(res, { notifications: notifs, unread: notifs.filter((n: Record<string, unknown>) => !n.isRead).length });
});

/* ── PATCH /vendor/notifications/read-all ── */
router.patch("/notifications/read-all", async (req, res) => {
  const vendorId = req.vendorId!;
  await db.update(notificationsTable).set({ isRead: true }).where(eq(notificationsTable.userId, vendorId));
  sendSuccess(res);
});

/* ── PATCH /vendor/notifications/:id/read ── */
router.patch("/notifications/:id/read", async (req, res) => {
  const vendorId = req.vendorId!;
  await db.update(notificationsTable).set({ isRead: true }).where(and(eq(notificationsTable.id, req.params.id), eq(notificationsTable.userId, vendorId)));
  sendSuccess(res);
});

/* ── GET /vendor/analytics ── ── */
router.get("/analytics", async (req, res) => {
  const vendorId = req.vendorId!;
  const fromQ = req.query["from"] ? String(req.query["from"]) : "";
  const toQ   = req.query["to"]   ? String(req.query["to"])   : "";

  /* Resolve effective range. Custom from/to wins; otherwise fall back to ?days=N (default 7). */
  let fromDate: Date;
  let toDate: Date;
  if (fromQ && /^\d{4}-\d{2}-\d{2}$/.test(fromQ) && toQ && /^\d{4}-\d{2}-\d{2}$/.test(toQ)) {
    fromDate = new Date(`${fromQ}T00:00:00`);
    toDate   = new Date(`${toQ}T23:59:59.999`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      sendValidationError(res, "Invalid from/to date range");
      return;
    }
  } else {
    const days = Math.max(1, Math.min(365, parseInt(String(req.query["days"] || "7"))));
    toDate = new Date();
    fromDate = new Date(); fromDate.setDate(fromDate.getDate() - (days - 1)); fromDate.setHours(0,0,0,0);
  }
  const days = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1);

  const s = await getCachedSettings();
  const vendorShare = 1 - (parseFloat(s["vendor_commission_pct"] ?? "15") / 100);

  const baseWhere = and(
    eq(ordersTable.vendorId, vendorId),
    gte(ordersTable.createdAt, fromDate),
    sql`${ordersTable.createdAt} <= ${toDate}`,
  );

  const [
    revenueData,
    ordersByStatusRaw,
    inRangeOrders,
    customerCountsInRange,
  ] = await Promise.all([
    db.select({
      c: count(),
      s: sum(ordersTable.total),
      date: sql<string>`DATE(${ordersTable.createdAt})`,
    }).from(ordersTable).where(baseWhere)
      .groupBy(sql`DATE(${ordersTable.createdAt})`)
      .orderBy(sql`DATE(${ordersTable.createdAt})`),
    db.select({ status: ordersTable.status, c: count() }).from(ordersTable)
      .where(baseWhere).groupBy(ordersTable.status),
    /* fetch items + createdAt + userId for in-range orders to aggregate top products + peak hours + return rate in JS */
    db.select({
      id: ordersTable.id,
      userId: ordersTable.userId,
      items: ordersTable.items,
      total: ordersTable.total,
      createdAt: ordersTable.createdAt,
    }).from(ordersTable).where(baseWhere),
    /* in-range per-customer order counts → return rate = customers w/ ≥2 orders in range / unique customers in range */
    db.select({
      userId: ordersTable.userId,
      orderCount: count(),
    }).from(ordersTable).where(baseWhere).groupBy(ordersTable.userId),
  ]);

  /* daily series — fill gaps so charts show continuous x-axis */
  const dailyMap = new Map<string, { orders: number; revenue: number }>();
  for (const d of revenueData) {
    dailyMap.set(d.date, {
      orders: d.c ?? 0,
      revenue: parseFloat((safeNum(d.s) * vendorShare).toFixed(2)),
    });
  }
  const daily: Array<{ date: string; orders: number; revenue: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(fromDate); d.setDate(fromDate.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = dailyMap.get(key) ?? { orders: 0, revenue: 0 };
    daily.push({ date: key, orders: v.orders, revenue: v.revenue });
  }

  const totalOrders  = daily.reduce((acc, d) => acc + d.orders, 0);
  const totalRevenue = parseFloat(daily.reduce((acc, d) => acc + d.revenue, 0).toFixed(2));

  const byStatus: Record<string, number> = {};
  for (const row of ordersByStatusRaw) byStatus[row.status] = row.c ?? 0;

  /* top products — aggregate from items JSON */
  const productAgg = new Map<string, { orders: number; revenue: number; quantity: number; name?: string }>();
  /* peak hours — bucket by hour-of-day (local) */
  const hourBuckets: Array<{ hour: number; orders: number; revenue: number }> =
    Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));

  for (const o of inRangeOrders) {
    const orderRevenue = parseFloat((safeNum(o.total) * vendorShare).toFixed(2));
    /* hour bucket */
    const hr = new Date(o.createdAt as Date).getHours();
    if (hr >= 0 && hr < 24) {
      hourBuckets[hr]!.orders += 1;
      hourBuckets[hr]!.revenue = parseFloat((hourBuckets[hr]!.revenue + orderRevenue).toFixed(2));
    }
    /* products */
    const items = Array.isArray(o.items) ? (o.items as Array<Record<string, unknown>>) : [];
    for (const it of items) {
      const pid = typeof it["productId"] === "string" ? (it["productId"] as string) : "";
      if (!pid) continue;
      const qty = Number(it["quantity"]) || 1;
      const price = Number(it["price"]) || 0;
      const lineRev = parseFloat((qty * price * vendorShare).toFixed(2));
      const cur = productAgg.get(pid) ?? { orders: 0, revenue: 0, quantity: 0 };
      cur.orders   += 1;
      cur.quantity += qty;
      cur.revenue  = parseFloat((cur.revenue + lineRev).toFixed(2));
      if (typeof it["name"] === "string" && !cur.name) cur.name = it["name"] as string;
      productAgg.set(pid, cur);
    }
  }

  /* hydrate names for products without a snapshot name */
  const missingNameIds = [...productAgg.entries()].filter(([, v]) => !v.name).map(([k]) => k);
  if (missingNameIds.length > 0) {
    const rows = await db.select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable).where(sql`${productsTable.id} = ANY(${missingNameIds})`).catch(() => []);
    for (const r of rows) {
      const cur = productAgg.get(r.id);
      if (cur) cur.name = r.name ?? cur.name ?? r.id;
    }
  }

  const topProducts = [...productAgg.entries()]
    .map(([productId, v]) => ({
      productId,
      name: v.name ?? productId,
      orders: v.orders,
      quantity: v.quantity,
      revenue: v.revenue,
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);

  /* return rate — customers with ≥2 orders within the selected range / unique customers in range */
  const totalCustomers = customerCountsInRange.length;
  const returningCustomers = customerCountsInRange.filter((c: { orderCount: number | null }) => (c.orderCount ?? 0) >= 2).length;
  const returnRate = totalCustomers > 0
    ? parseFloat(((returningCustomers / totalCustomers) * 100).toFixed(1))
    : 0;

  /* ── customerRatings: avg rating + count for this vendor in range ── */
  const [ratingsRow] = await db.select({ avgRating: avg(reviewsTable.rating), cnt: count() })
    .from(reviewsTable)
    .where(and(
      eq(reviewsTable.vendorId, vendorId),
      gte(reviewsTable.createdAt, fromDate),
      sql`${reviewsTable.createdAt} <= ${toDate}`,
    ));
  const avgRatingVal = ratingsRow?.avgRating ? parseFloat(parseFloat(ratingsRow.avgRating).toFixed(1)) : null;
  const ratingCount  = ratingsRow?.cnt ?? 0;

  /* ── cancellationRate: % of orders cancelled in range ── */
  const cancelledCount = byStatus["cancelled"] ?? 0;
  const totalWithCancelled = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const cancellationRate = totalWithCancelled > 0
    ? parseFloat(((cancelledCount / totalWithCancelled) * 100).toFixed(1))
    : 0;

  /* ── responseTime: median minutes from order placed to first vendor action (confirmed/cancelled) ── */
  const auditRows = await db.select({
    orderId: orderAuditLogTable.orderId,
    toStatus: orderAuditLogTable.toStatus,
    changedAt: orderAuditLogTable.changedAt,
  }).from(orderAuditLogTable)
    .where(and(
      eq(orderAuditLogTable.vendorId, vendorId),
      gte(orderAuditLogTable.changedAt, fromDate),
      sql`${orderAuditLogTable.changedAt} <= ${toDate}`,
      or(eq(orderAuditLogTable.toStatus, "confirmed"), eq(orderAuditLogTable.toStatus, "cancelled")),
    ));

  /* Merge with order createdAt data to compute response times.
     Use EARLIEST qualifying audit event per order to avoid double-counting.
     Group by orderId, pick the minimum changedAt, then compute per-order median. */
  const orderCreatedMap = new Map(inRangeOrders.map(o => [o.id, o.createdAt as Date]));
  /* Collect earliest action time per order */
  const earliestActionMap = new Map<string, Date>();
  for (const row of auditRows) {
    const existing = earliestActionMap.get(row.orderId);
    const rowTime = new Date(row.changedAt);
    if (!existing || rowTime < existing) {
      earliestActionMap.set(row.orderId, rowTime);
    }
  }
  const responseTimes: number[] = [];
  for (const [orderId, actionTime] of earliestActionMap) {
    const created = orderCreatedMap.get(orderId);
    if (created) {
      const mins = (actionTime.getTime() - new Date(created).getTime()) / 60000;
      if (mins >= 0 && mins < 1440) responseTimes.push(mins);
    }
  }
  let medianResponseTime: number | null = null;
  if (responseTimes.length > 0) {
    const sorted = [...responseTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianResponseTime = sorted.length % 2 !== 0
      ? parseFloat(sorted[mid]!.toFixed(1))
      : parseFloat(((sorted[mid - 1]! + sorted[mid]!) / 2).toFixed(1));
  }

  sendSuccess(res, {
    summary: { totalOrders, totalRevenue },
    daily,
    topProducts,
    byStatus,
    peakHours: hourBuckets,
    returnRate: { totalCustomers, returningCustomers, rate: returnRate },
    customerRatings: { avgRating: avgRatingVal, count: ratingCount },
    cancellationRate,
    responseTime: medianResponseTime,
    period: {
      days,
      from: fromDate.toISOString().slice(0, 10),
      to:   toDate.toISOString().slice(0, 10),
    },
  });
});

/* ── GET /vendor/reviews — all reviews for this vendor (authenticated) ── */
router.get("/reviews", async (req, res) => {
  const vendorId = req.vendorId!;
  const page  = Math.max(1, parseInt(String(req.query["page"]  || "1")));
  const limit = Math.min(parseInt(String(req.query["limit"] || "20")), 100);
  const offset = (page - 1) * limit;
  const starsFilter = req.query["stars"] as string | undefined;
  const sort = req.query["sort"] as string || "newest";

  const conditions: any[] = [eq(reviewsTable.vendorId, vendorId), eq(reviewsTable.hidden, false), isNull(reviewsTable.deletedAt)];
  if (starsFilter) conditions.push(eq(reviewsTable.rating, parseInt(starsFilter)));

  const [statsRow] = await db
    .select({ total: count(), avgRating: avg(reviewsTable.rating) })
    .from(reviewsTable)
    .where(and(eq(reviewsTable.vendorId, vendorId), eq(reviewsTable.hidden, false), isNull(reviewsTable.deletedAt)));

  const totalCount = statsRow?.total ?? 0;
  const avgRating  = statsRow?.avgRating ? parseFloat(parseFloat(statsRow.avgRating).toFixed(1)) : null;

  /* Star breakdown */
  const breakdown = await db
    .select({ rating: reviewsTable.rating, cnt: count() })
    .from(reviewsTable)
    .where(and(eq(reviewsTable.vendorId, vendorId), eq(reviewsTable.hidden, false), isNull(reviewsTable.deletedAt)))
    .groupBy(reviewsTable.rating);
  const starBreakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of breakdown) starBreakdown[row.rating] = row.cnt;

  const rows = await db
    .select({
      id: reviewsTable.id,
      orderId: reviewsTable.orderId,
      rating: reviewsTable.rating,
      comment: reviewsTable.comment,
      orderType: reviewsTable.orderType,
      createdAt: reviewsTable.createdAt,
      status: reviewsTable.status,
      vendorReply: reviewsTable.vendorReply,
      vendorRepliedAt: reviewsTable.vendorRepliedAt,
      customerName: usersTable.name,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .where(and(...conditions))
    .orderBy(sort === "oldest" ? reviewsTable.createdAt : desc(reviewsTable.createdAt))
    .limit(limit)
    .offset(offset);

  /* Mask customer names: first name + last initial */
  const masked = rows.map(r => ({
    ...r,
    customerName: r.customerName
      ? (() => {
          const parts = r.customerName.trim().split(/\s+/);
          return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
        })()
      : "Customer",
  }));

  sendSuccess(res, {
    reviews: masked,
    total: totalCount,
    avgRating,
    starBreakdown,
    page,
    limit,
    pages: Math.ceil(totalCount / limit),
  });
});

/* ── Haversine distance helper ───────────────────────────────────────── */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── GET /vendor/orders/available-riders ─────────────────────────────────
   Returns online riders sorted by distance from a given lat/lng.
   Query: lat, lng, maxKm (default 10)
──────────────────────────────────────────────────────────────────────── */
router.get("/orders/available-riders", requireRole("vendor"), async (req, res) => {
  const lat = parseFloat(String(req.query["lat"] ?? ""));
  const lng = parseFloat(String(req.query["lng"] ?? ""));
  const maxKm = parseFloat(String(req.query["maxKm"] ?? "10"));

  const riders = await db
    .select({
      id: usersTable.id, name: usersTable.name, phone: usersTable.phone,
      vehicleType: riderProfilesTable.vehicleType, walletBalance: usersTable.walletBalance,
      lat: liveLocationsTable.latitude, lng: liveLocationsTable.longitude,
    })
    .from(usersTable)
    .innerJoin(liveLocationsTable, eq(usersTable.id, liveLocationsTable.userId))
    .leftJoin(riderProfilesTable, eq(usersTable.id, riderProfilesTable.userId))
    .where(and(ilike(usersTable.roles, "%rider%"), eq(usersTable.isOnline, true)));

  const hasLocation = !isNaN(lat) && !isNaN(lng);

  const withDist = riders
    .map(r => {
      const rLat = parseFloat(r.lat);
      const rLng = parseFloat(r.lng);
      const distKm = (hasLocation && !isNaN(rLat) && !isNaN(rLng))
        ? Math.round(haversineKm(lat, lng, rLat, rLng) * 10) / 10
        : null;
      return { ...r, distanceKm: distKm, lat: rLat, lng: rLng };
    })
    .filter(r => !hasLocation || r.distanceKm === null || r.distanceKm <= maxKm)
    .sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

  sendSuccess(res, { riders: withDist });
});

/* ── GET /vendor/orders/:id ── */
router.get("/orders/:id", async (req, res) => {
  const vendorId = req.vendorId!;
  const [row] = await db.select({
    order: ordersTable,
    riderName: usersTable.name,
    riderPhone: usersTable.phone,
  }).from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.riderId, usersTable.id))
    .where(and(eq(ordersTable.id, req.params["id"]!), eq(ordersTable.vendorId, vendorId)))
    .limit(1);
  if (!row) { sendNotFound(res, "Order not found"); return; }
  sendSuccess(res, { order: { ...row.order, total: safeNum(row.order.total), riderName: row.riderName ?? undefined, riderPhone: row.riderPhone ?? undefined } });
});

/* ── GET /vendor/orders/:id/available-riders ─────────────────────────────
   Returns online riders within 5 km of the order's delivery address,
   with rating > 4.5 (unrated riders default to 5.0 and qualify).
   Sorted by distance ascending.
──────────────────────────────────────────────────────────────────────── */
router.get("/orders/:id/available-riders", requireRole("vendor"), async (req, res) => {
  const orderId  = req.params["id"]!;
  const vendorId = req.vendorId!;

  const [order] = await db
    .select({ id: ordersTable.id, vendorId: ordersTable.vendorId, deliveryLat: ordersTable.deliveryLat, deliveryLng: ordersTable.deliveryLng })
    .from(ordersTable)
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.vendorId, vendorId)))
    .limit(1);
  if (!order) { sendNotFound(res, "Order not found"); return; }

  const deliveryLat = order.deliveryLat ? parseFloat(order.deliveryLat) : null;
  const deliveryLng = order.deliveryLng ? parseFloat(order.deliveryLng) : null;
  const hasLocation = deliveryLat !== null && deliveryLng !== null && !isNaN(deliveryLat) && !isNaN(deliveryLng);

  if (!hasLocation) {
    /* Without delivery coordinates we cannot enforce the ≤5 km constraint. */
    sendSuccess(res, { riders: [] });
    return;
  }

  const riders = await db
    .select({
      id: usersTable.id, name: usersTable.name, phone: usersTable.phone,
      vehicleType: riderProfilesTable.vehicleType, walletBalance: usersTable.walletBalance,
      lat: liveLocationsTable.latitude, lng: liveLocationsTable.longitude,
      /* rating column pending migration on riderProfilesTable — null until added.
         COALESCE(rating, 5.0) > 4.5 means all unrated riders qualify. */
      rating: sql<number | null>`null`,
    })
    .from(usersTable)
    .innerJoin(liveLocationsTable, eq(usersTable.id, liveLocationsTable.userId))
    .leftJoin(riderProfilesTable, eq(usersTable.id, riderProfilesTable.userId))
    .where(and(ilike(usersTable.roles, "%rider%"), eq(usersTable.isOnline, true)));

  const MAX_KM = 5;
  const MIN_RATING = 4.5;
  const withDist = riders
    .map(r => {
      const ratingScore = (r.rating as number | null) ?? 5.0; // COALESCE(rating, 5.0)
      const rLat = parseFloat(r.lat);
      const rLng = parseFloat(r.lng);
      if (isNaN(rLat) || isNaN(rLng)) return null; // skip riders with invalid coords
      const distKm = Math.round(haversineKm(deliveryLat!, deliveryLng!, rLat, rLng) * 10) / 10;
      return { ...r, distanceKm: distKm, ratingScore };
    })
    .filter((r): r is NonNullable<typeof r> =>
      r !== null && r.ratingScore > MIN_RATING && r.distanceKm <= MAX_KM
    )
    .sort((a, b) => a.distanceKm - b.distanceKm);

  sendSuccess(res, { riders: withDist });
});

/* ── POST /vendor/orders/:id/assign-rider ────────────────────────────────
   Body: { riderId }
──────────────────────────────────────────────────────────────────────── */
router.post("/orders/:id/assign-rider", requireRole("vendor"), async (req, res) => {
  const orderId = req.params["id"]!;
  const vendorId = req.vendorId!;
  const { riderId } = req.body as { riderId?: string };
  if (!riderId) { sendValidationError(res, "riderId required"); return; }

  const [rider] = await db.select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone, isOnline: usersTable.isOnline })
    .from(usersTable).where(and(eq(usersTable.id, riderId), ilike(usersTable.roles, "%rider%"))).limit(1);
  if (!rider) { sendNotFound(res, "Rider not found"); return; }
  if (!rider.isOnline) { sendError(res, "Rider is currently offline", 400); return; }

  const [updated] = await db.update(ordersTable)
    .set({ riderId: rider.id, riderName: rider.name, riderPhone: rider.phone, assignedRiderId: rider.id, assignedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.vendorId, vendorId),
      isNull(ordersTable.riderId),
      or(eq(ordersTable.status, "confirmed"), eq(ordersTable.status, "preparing"), eq(ordersTable.status, "ready")),
    ))
    .returning();
  if (!updated) {
    const [order] = await db.select({ id: ordersTable.id, riderId: ordersTable.riderId, status: ordersTable.status, vendorId: ordersTable.vendorId })
      .from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    if (!order) { sendNotFound(res, "Order not found"); return; }
    if (order.vendorId !== vendorId) { sendForbidden(res, "This order does not belong to your store"); return; }
    if (order.riderId) { sendError(res, "Order already has a rider assigned", 409); return; }
    sendError(res, `Order cannot be assigned in '${order.status}' status`, 400); return;
  }

  await db.insert(notificationsTable).values({
    id: generateId(), userId: rider.id,
    title: "📦 New Delivery Assigned",
    body: `You have been assigned a delivery order #${String(orderId).slice(-6).toUpperCase()}. Head to the vendor.`,
    type: "order", icon: "bicycle-outline",
  }).catch((e: Error) => logger.warn({ orderId, riderId: rider.id, err: e.message }, "[vendor/assign-rider] notification insert failed"));

  const io = getIO();
  if (io) io.to(`user:${rider.id}`).emit("order:assigned", { orderId });

  sendSuccess(res, { riderId: rider.id, riderName: rider.name });
});

/* ── POST /vendor/orders/:id/auto-assign ─────────────────────────────────
   Finds the nearest online rider within 5 km of the order's delivery
   address with rating > 4.5 (unrated riders default to 5.0 and qualify).
   Returns HTTP 404 if no qualifying rider exists.
──────────────────────────────────────────────────────────────────────── */
router.post("/orders/:id/auto-assign", requireRole("vendor"), async (req, res) => {
  const orderId  = req.params["id"]!;
  const vendorId = req.vendorId!;

  const [order] = await db
    .select({ id: ordersTable.id, vendorId: ordersTable.vendorId, riderId: ordersTable.riderId, status: ordersTable.status, deliveryLat: ordersTable.deliveryLat, deliveryLng: ordersTable.deliveryLng })
    .from(ordersTable)
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.vendorId, vendorId)))
    .limit(1);
  if (!order) { sendNotFound(res, "Order not found"); return; }

  const deliveryLat = order.deliveryLat ? parseFloat(order.deliveryLat) : null;
  const deliveryLng = order.deliveryLng ? parseFloat(order.deliveryLng) : null;

  if (deliveryLat === null || deliveryLng === null || isNaN(deliveryLat) || isNaN(deliveryLng)) {
    sendNotFound(res, "Order has no valid delivery coordinates for distance filtering");
    return;
  }

  const riders = await db
    .select({
      id: usersTable.id, name: usersTable.name, phone: usersTable.phone,
      lat: liveLocationsTable.latitude, lng: liveLocationsTable.longitude,
      /* rating column pending migration on riderProfilesTable — null until added.
         COALESCE(rating, 5.0) > 4.5 means all unrated riders qualify. */
      rating: sql<number | null>`null`,
    })
    .from(usersTable)
    .innerJoin(liveLocationsTable, eq(usersTable.id, liveLocationsTable.userId))
    .leftJoin(riderProfilesTable, eq(usersTable.id, riderProfilesTable.userId))
    .where(and(ilike(usersTable.roles, "%rider%"), eq(usersTable.isOnline, true)));

  const MAX_KM = 5;
  const MIN_RATING = 4.5;

  const qualifying = riders
    .map(r => {
      const ratingScore = (r.rating as number | null) ?? 5.0; // COALESCE(rating, 5.0)
      const rLat = parseFloat(r.lat);
      const rLng = parseFloat(r.lng);
      if (isNaN(rLat) || isNaN(rLng)) return null; // skip riders with invalid coords
      const distKm = haversineKm(deliveryLat, deliveryLng, rLat, rLng);
      return { ...r, distKm, ratingScore };
    })
    .filter((r): r is NonNullable<typeof r> =>
      r !== null && r.ratingScore > MIN_RATING && r.distKm <= MAX_KM
    )
    .sort((a, b) => a.distKm - b.distKm);

  if (qualifying.length === 0) {
    sendNotFound(res, "No available riders within 5 km with rating > 4.5");
    return;
  }

  const nearest = qualifying[0]!;

  const [updated] = await db.update(ordersTable)
    .set({ riderId: nearest.id, riderName: nearest.name, riderPhone: nearest.phone, assignedRiderId: nearest.id, assignedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.vendorId, vendorId),
      isNull(ordersTable.riderId),
      or(eq(ordersTable.status, "confirmed"), eq(ordersTable.status, "preparing"), eq(ordersTable.status, "ready")),
    ))
    .returning();
  if (!updated) {
    if (order.riderId) { sendError(res, "Order already has a rider assigned", 409); return; }
    sendError(res, `Order cannot be auto-assigned in '${order.status}' status`, 400); return;
  }

  await db.insert(notificationsTable).values({
    id: generateId(), userId: nearest.id,
    title: "📦 New Delivery Assigned (Auto)",
    body: `Order #${String(orderId).slice(-6).toUpperCase()} has been auto-assigned to you. Head to the vendor!`,
    type: "order", icon: "bicycle-outline",
  }).catch((e: Error) => logger.warn({ orderId, riderId: nearest.id, err: e.message }, "[vendor/auto-assign] notification insert failed"));

  const io = getIO();
  if (io) io.to(`user:${nearest.id}`).emit("order:assigned", { orderId });

  sendSuccess(res, { riderId: nearest.id, riderName: nearest.name });
});

router.get("/delivery-access/status", async (req, res) => {
  const vendorId = req.vendorId!;
  try {
    const s = await getCachedSettings();
    const mode = s["delivery_access_mode"] ?? "all";

    const SERVICE_TYPES = ["mart", "food", "pharmacy", "parcel"];
    const statuses: Record<string, { active: boolean; deliveryLabel?: string }> = {};

    if (mode === "all") {
      for (const st of SERVICE_TYPES) {
        statuses[st] = { active: true };
      }
    } else if (mode === "stores" || mode === "both") {
      const entries = await db
        .select()
        .from(deliveryWhitelistTable)
        .where(
          and(
            eq(deliveryWhitelistTable.type, "vendor"),
            eq(deliveryWhitelistTable.targetId, vendorId),
            eq(deliveryWhitelistTable.status, "active"),
          ),
        );

      for (const st of SERVICE_TYPES) {
        const match = entries.find(
          e =>
            (e.serviceType === st || e.serviceType === "all") &&
            (!e.validUntil || e.validUntil > new Date()),
        );
        statuses[st] = { active: !!match, deliveryLabel: match?.deliveryLabel ?? undefined };
      }
    } else {
      for (const st of SERVICE_TYPES) {
        statuses[st] = { active: true };
      }
    }

    const pendingRequests = await db
      .select()
      .from(deliveryAccessRequestsTable)
      .where(
        and(
          eq(deliveryAccessRequestsTable.vendorId, vendorId),
          eq(deliveryAccessRequestsTable.status, "pending"),
        ),
      );

    sendSuccess(res, { mode, statuses, pendingRequests });
  } catch (e: any) {
    sendError(res, e.message || "Failed to fetch delivery status", 500);
  }
});

router.post("/delivery-access/request", async (req, res) => {
  const vendorId = req.vendorId!;
  const { serviceType } = req.body;

  if (serviceType && !["mart", "food", "pharmacy", "parcel", "all"].includes(serviceType)) {
    sendValidationError(res, "Invalid serviceType");
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(deliveryAccessRequestsTable)
      .where(
        and(
          eq(deliveryAccessRequestsTable.vendorId, vendorId),
          eq(deliveryAccessRequestsTable.serviceType, serviceType || "all"),
          eq(deliveryAccessRequestsTable.status, "pending"),
        ),
      )
      .limit(1);

    if (existing) {
      sendError(res, "You already have a pending request for this service type", 409);
      return;
    }

    const id = generateId();
    await db.insert(deliveryAccessRequestsTable).values({
      id,
      vendorId,
      serviceType: serviceType || "all",
      status: "pending",
    });

    const [vendor] = await db
      .select({ name: usersTable.name, storeName: vendorProfilesTable.storeName })
      .from(usersTable)
      .leftJoin(vendorProfilesTable, eq(usersTable.id, vendorProfilesTable.userId))
      .where(eq(usersTable.id, vendorId))
      .limit(1);

    try {
      await db.insert(notificationsTable).values({
        id: generateId(),
        userId: "admin",
        title: "New Delivery Access Request",
        body: `${vendor?.storeName || vendor?.name || "Vendor"} has requested delivery access for ${serviceType || "all"} service.`,
        type: "system",
      });
    } catch (err) {
      logger.warn({ vendorId, serviceType, err: err instanceof Error ? err.message : String(err) }, "[vendor] Failed to create delivery access notification");
    }

    sendCreated(res, { id, status: "pending" });
  } catch (e: any) {
    sendError(res, e.message || "Failed to submit request", 500);
  }
});

/* ═══════════════════  Vendor Weekly Schedule  ═══════════════════ */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

router.get("/schedule", async (req, res) => {
  const vendorId = req.vendorUser!.id;
  const rows = await db.select().from(vendorSchedulesTable).where(eq(vendorSchedulesTable.vendorId, vendorId));
  const schedule = DAY_NAMES.map((name, i) => {
    const existing = rows.find(r => r.dayOfWeek === i);
    return existing
      ? { ...existing, dayName: name, createdAt: existing.createdAt.toISOString(), updatedAt: existing.updatedAt.toISOString() }
      : { id: null, vendorId, dayOfWeek: i, dayName: name, openTime: "09:00", closeTime: "21:00", isEnabled: false };
  });
  sendSuccess(res, { schedule });
});

const scheduleItemSchema = z.object({
  dayOfWeek: z.number().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/),
  isEnabled: z.boolean(),
});
const putScheduleSchema = z.object({
  schedule: z.array(scheduleItemSchema).min(1).max(7),
});

router.put("/schedule", validateBody(putScheduleSchema), async (req, res) => {
  const vendorId = req.vendorUser!.id;
  const { schedule } = req.body as { schedule: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isEnabled: boolean }> };

  for (const item of schedule) {
    const existing = await db.select().from(vendorSchedulesTable)
      .where(and(eq(vendorSchedulesTable.vendorId, vendorId), eq(vendorSchedulesTable.dayOfWeek, item.dayOfWeek)));

    if (existing.length > 0) {
      await db.update(vendorSchedulesTable)
        .set({ openTime: item.openTime, closeTime: item.closeTime, isEnabled: item.isEnabled, updatedAt: new Date() })
        .where(eq(vendorSchedulesTable.id, existing[0]!.id));
    } else {
      await db.insert(vendorSchedulesTable).values({
        id: generateId(),
        vendorId,
        dayOfWeek: item.dayOfWeek,
        openTime: item.openTime,
        closeTime: item.closeTime,
        isEnabled: item.isEnabled,
      });
    }
  }

  const rows = await db.select().from(vendorSchedulesTable).where(eq(vendorSchedulesTable.vendorId, vendorId));
  const result = DAY_NAMES.map((name, i) => {
    const r = rows.find(r => r.dayOfWeek === i);
    return r
      ? { ...r, dayName: name, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }
      : { id: null, vendorId, dayOfWeek: i, dayName: name, openTime: "09:00", closeTime: "21:00", isEnabled: false };
  });
  sendSuccess(res, { schedule: result });
});

/* ═══════════════════  Test Notification  ═══════════════════ */

router.post("/test-notification", async (req, res) => {
  const vendorId = req.vendorUser!.id;

  /* Emit a socket event to the vendor's room so the in-app sound fires immediately */
  const io = getIO();
  if (io) {
    io.to(`vendor:${vendorId}`).emit("order:new", { _isTest: true });
  }

  /* Send a real push notification and return actual delivery stats so the
     vendor knows whether the push path is genuinely working. */
  try {
    const stats = await sendPushToUser(vendorId, {
      title: "🔔 Test Notification",
      body: "Notifications are working! You will receive order alerts like this.",
      tag: `vendor-test-${Date.now()}`,
      data: { type: "test" },
    });

    if (stats.noSubscriptions) {
      sendSuccess(res, {
        sent: false,
        socketEmitted: !!io,
        noSubscriptions: true,
        error: "No push subscriptions found. Open the vendor app and allow notifications to register.",
      });
      return;
    }

    sendSuccess(res, {
      sent: stats.delivered > 0,
      socketEmitted: !!io,
      noSubscriptions: false,
      attempted: stats.attempted,
      delivered: stats.delivered,
      stalePurged: stats.stalePurged,
      ...(stats.stalePurged > 0 ? { warning: `${stats.stalePurged} stale token(s) purged — re-open the vendor app to re-register.` } : {}),
    });
  } catch (err) {
    logger.warn({ vendorId, err: err instanceof Error ? err.message : String(err) }, "[vendor] test notification push failed");
    sendSuccess(res, { sent: false, socketEmitted: !!io, noSubscriptions: false, error: "Push send failed — check VAPID/FCM configuration" });
  }
});

export default router;
