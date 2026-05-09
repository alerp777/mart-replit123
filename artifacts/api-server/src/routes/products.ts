import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { productsTable, productVariantsTable, flashDealsTable, reviewsTable, stockSubscriptionsTable, searchLogsTable } from "@workspace/db/schema";
import { eq, ilike, and, SQL, gte, lte, gt, desc, asc, sql, isNotNull, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { generateId } from "../lib/id.js";
import { sendSuccess, sendCreated, sendNotFound, sendError, sendInternalError } from "../lib/response.js";
import { validateBody } from "../middleware/validate.js";
import { adminAuth, getCachedSettings } from "./admin.js";
import { customerAuth, JWT_SECRET } from "../middleware/security.js";
import jwt from "jsonwebtoken";

const router: IRouter = Router();

function mapProduct(p: typeof productsTable.$inferSelect) {
  return {
    ...p,
    price: parseFloat(p.price),
    originalPrice: p.originalPrice ? parseFloat(p.originalPrice) : undefined,
    rating: p.rating ? parseFloat(p.rating) : null,
  };
}

function mapSlimProduct(p: typeof productsTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    price: parseFloat(p.price),
    originalPrice: p.originalPrice ? parseFloat(p.originalPrice) : undefined,
    image: p.image,
    category: p.category,
    type: p.type,
    rating: p.rating ? parseFloat(p.rating) : null,
    inStock: p.inStock,
    vendorId: p.vendorId,
  };
}

/* ── GET /products/flash-deals ──────────────────────────────────────────── */
router.get("/flash-deals", async (req, res) => {
  const s = await getCachedSettings();
  const flashDefault = parseInt(s["pagination_flash_deals"] ?? "20") || 20;
  const flashMax = Math.max(flashDefault, parseInt(s["pagination_products_max"] ?? "50") || 50);
  const limit = Math.min(parseInt(req.query.limit as string) || flashDefault, flashMax);
  const now = new Date();

  try {
    const activeDeals = await db.select({
      productId: flashDealsTable.productId,
      dealStock: flashDealsTable.dealStock,
      soldCount: flashDealsTable.soldCount,
      endTime: flashDealsTable.endTime,
    }).from(flashDealsTable).where(
      and(
        eq(flashDealsTable.isActive, true),
        lte(flashDealsTable.startTime, now),
        gte(flashDealsTable.endTime, now),
        gt(flashDealsTable.dealStock, flashDealsTable.soldCount),
      )
    ).limit(limit);

    if (activeDeals.length === 0) {
      sendSuccess(res, { products: [], total: 0 });
      return;
    }

    const dealProductIds = activeDeals.map(d => d.productId);
    const dealMap = new Map(activeDeals.map(d => [d.productId, d]));

    const products = await db.select().from(productsTable)
      .where(and(
        inArray(productsTable.id, dealProductIds),
        eq(productsTable.approvalStatus, "approved"),
        eq(productsTable.inStock, true),
        isNull(productsTable.deletedAt),
      ))
      .orderBy(asc(productsTable.createdAt));

    sendSuccess(res, {
      products: products.map(p => {
        const price = parseFloat(p.price);
        const origPrice = p.originalPrice ? parseFloat(p.originalPrice) : price;
        const discount = origPrice > price ? Math.round(((origPrice - price) / origPrice) * 100) : 0;
        const dealInfo = dealMap.get(p.id);
        return {
          ...p,
          price,
          originalPrice: origPrice,
          rating: p.rating ? parseFloat(p.rating) : null,
          discountPercent: discount,
          dealStock: dealInfo?.dealStock ?? null,
          soldCount: dealInfo?.soldCount ?? 0,
          dealExpiresAt: dealInfo?.endTime?.toISOString() ?? null,
        };
      }),
      total: products.length,
    });
  } catch (e: unknown) {
    logger.error("[products GET /flash-deals] DB error:", e);
    sendInternalError(res);
  }
});

/* ── GET /products/trending-searches — top search terms from real search logs ── */
router.get("/trending-searches", async (req, res) => {
  const s2 = await getCachedSettings();
  const trendingDefault = parseInt(s2["pagination_trending_limit"] ?? "12") || 12;
  const trendingMax = parseInt(s2["pagination_products_max"] ?? "50") || 50;
  const limit = Math.min(parseInt(req.query.limit as string) || trendingDefault, trendingMax);

  // Pull real search terms from the log — top queries by frequency in the past 30 days
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const logRows = await db
    .select({
      query: searchLogsTable.query,
      count: sql<number>`count(*)::int`,
    })
    .from(searchLogsTable)
    .where(gte(searchLogsTable.createdAt, since))
    .groupBy(searchLogsTable.query)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  const searches: string[] = logRows.map(r => r.query);

  // Fallback to product-name inference when insufficient real data
  if (searches.length < 5) {
    const topProducts = await db
      .select({ name: productsTable.name })
      .from(productsTable)
      .where(and(
        eq(productsTable.approvalStatus, "approved"),
        eq(productsTable.inStock, true),
        isNull(productsTable.deletedAt),
      ))
      .orderBy(desc(productsTable.reviewCount))
      .limit(limit * 3);

    const seen = new Set<string>(searches.map(s => s.toLowerCase()));

    for (const p of topProducts) {
      const words = p.name.trim().split(/\s+/);
      const term = words.length > 2 ? words.slice(0, 2).join(" ") : p.name.trim();
      const key = term.toLowerCase();
      if (!seen.has(key) && term.length >= 3) {
        seen.add(key);
        searches.push(term);
      }
      if (searches.length >= limit) break;
    }

    const FALLBACK_TERMS = [
      "Fruits", "Vegetables", "Meat", "Dairy", "Bread",
      "Beverages", "Snacks", "Rice", "Chicken", "Eggs",
      "Biryani", "Pizza", "Burger",
    ];
    if (searches.length < 5) {
      const seen2 = new Set<string>(searches.map(s => s.toLowerCase()));
      for (const t of FALLBACK_TERMS) {
        const key = t.toLowerCase();
        if (!seen2.has(key)) {
          seen2.add(key);
          searches.push(t);
        }
        if (searches.length >= limit) break;
      }
    }
  }

  sendSuccess(res, { searches });
});

/* ── GET /products/search ─────────────────────────────────────────────────
   Supports full-text ranking (ts_rank) for the default "relevance" sort.
   Falls back to ilike for very short queries (<3 chars).
   ─────────────────────────────────────────────────────────────────────── */
router.get("/search", async (req, res) => {
  const { q, type, sort, minPrice, maxPrice, minRating, category } = req.query;
  const ps = await getCachedSettings();
  const defaultPP = parseInt(ps["pagination_products_default"] ?? "20") || 20;
  const maxPP = parseInt(ps["pagination_products_max"] ?? "50") || 50;
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage as string) || defaultPP, 1), maxPP);
  const offset = (page - 1) * perPage;

  if (!q || typeof q !== "string" || !q.trim()) {
    sendSuccess(res, { products: [], total: 0, page, perPage, totalPages: 0 });
    return;
  }

  const trimmed = q.trim();

  const tokens = trimmed
    .replace(/[^a-zA-Z0-9\s\u0600-\u06FF]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
  const tsQueryStr = tokens.join(" & ");
  const useFullText = tokens.length > 0 && trimmed.length >= 3;

  const baseConditions: SQL[] = [
    eq(productsTable.approvalStatus, "approved"),
    eq(productsTable.inStock, true),
    isNull(productsTable.deletedAt),
  ];
  if (type && typeof type === "string") baseConditions.push(eq(productsTable.type, type));
  if (category && typeof category === "string") baseConditions.push(eq(productsTable.category, category));
  if (minPrice) baseConditions.push(gte(productsTable.price, String(minPrice)));
  if (maxPrice) baseConditions.push(lte(productsTable.price, String(maxPrice)));
  if (minRating) baseConditions.push(gte(productsTable.rating, String(minRating)));

  let conditions: SQL[];
  if (useFullText) {
    const ftCondition = sql`to_tsvector('english', coalesce(${productsTable.name}, '') || ' ' || coalesce(${productsTable.description}, '')) @@ to_tsquery('english', ${tsQueryStr + ":*"})`;
    conditions = [...baseConditions, ftCondition];
  } else {
    conditions = [...baseConditions, ilike(productsTable.name, `%${trimmed}%`)];
  }

  let orderBy: SQL;
  if (sort === "price_asc") {
    orderBy = asc(productsTable.price);
  } else if (sort === "price_desc") {
    orderBy = desc(productsTable.price);
  } else if (sort === "rating") {
    orderBy = desc(productsTable.rating);
  } else if (sort === "newest") {
    orderBy = desc(productsTable.createdAt);
  } else if (useFullText) {
    orderBy = desc(
      sql`ts_rank(to_tsvector('english', coalesce(${productsTable.name}, '') || ' ' || coalesce(${productsTable.description}, '')), to_tsquery('english', ${tsQueryStr + ":*"}))`
    );
  } else {
    orderBy = desc(productsTable.reviewCount);
  }

  const [allProducts, countResult] = await Promise.all([
    db.select().from(productsTable).where(and(...conditions)).orderBy(orderBy).limit(perPage).offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(productsTable).where(and(...conditions)),
  ]);

  const total = countResult[0]?.total ?? 0;

  // Non-blocking search event logging — never delays the response
  // Optionally extract user ID from auth token if present (search endpoint is public, so this may be null)
  let searchUserId: string | null = null;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (payload?.sub) searchUserId = payload.sub;
    }
  } catch { /* ignore invalid/missing tokens */ }
  // Normalize query to lowercase for consistent aggregation (e.g. "Milk" == "milk")
  const normalizedQuery = trimmed.toLowerCase().replace(/\s+/g, " ");
  db.insert(searchLogsTable).values({ query: normalizedQuery, resultCount: total, userId: searchUserId }).catch(() => {});

  const slimSearch = req.query.slim === "true";

  sendSuccess(res, {
    products: allProducts.map(slimSearch ? mapSlimProduct : mapProduct),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
});

export default router;
