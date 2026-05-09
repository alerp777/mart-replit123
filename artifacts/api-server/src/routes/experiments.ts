import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { abExperimentsTable, abAssignmentsTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { generateId } from "../lib/id.js";
import { sendSuccess, sendNotFound, sendValidationError } from "../lib/response.js";
import { logger } from "../lib/logger.js";

const router = Router();

const paginationSchema = z.object({
  page:   z.coerce.number().int().min(1).optional().default(1),
  limit:  z.coerce.number().int().min(1).max(100).optional().default(50),
  status: z.string().optional(),
});

router.get("/", async (req, res) => {
  const p = paginationSchema.safeParse(req.query);
  if (!p.success) {
    sendValidationError(res, p.error.errors.map(e => e.message).join("; "));
    return;
  }

  try {
    const { page, limit, status } = p.data;
    const offset = (page - 1) * limit;

    let countQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(abExperimentsTable)
      .$dynamic();

    let dataQuery = db
      .select()
      .from(abExperimentsTable)
      .orderBy(desc(abExperimentsTable.createdAt))
      .limit(limit)
      .offset(offset)
      .$dynamic();

    if (status) {
      countQuery = countQuery.where(eq(abExperimentsTable.status, status));
      dataQuery  = dataQuery.where(eq(abExperimentsTable.status, status));
    }

    const [countRow, experiments] = await Promise.all([countQuery, dataQuery]);
    const total = countRow[0]?.count ?? 0;

    sendSuccess(res, { experiments, total, page, limit });
  } catch (err) {
    logger.error({ err }, "[experiments] list error");
    sendSuccess(res, { experiments: [], total: 0, page: 1, limit: 50 });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [experiment] = await db
      .select()
      .from(abExperimentsTable)
      .where(eq(abExperimentsTable.id, id))
      .limit(1);

    if (!experiment) {
      sendNotFound(res, "Experiment not found");
      return;
    }

    sendSuccess(res, { experiment });
  } catch (err) {
    logger.error({ err }, "[experiments] get error");
    sendNotFound(res, "Experiment not found");
  }
});

router.post("/assign", async (req, res) => {
  const { userId, experimentId } = req.body ?? {};
  if (!userId || !experimentId) {
    sendValidationError(res, "userId and experimentId are required");
    return;
  }

  try {
    const [experiment] = await db
      .select()
      .from(abExperimentsTable)
      .where(and(eq(abExperimentsTable.id, experimentId), eq(abExperimentsTable.status, "active")))
      .limit(1);

    if (!experiment) {
      sendNotFound(res, "Experiment not found or not active");
      return;
    }

    const [existing] = await db
      .select()
      .from(abAssignmentsTable)
      .where(and(eq(abAssignmentsTable.experimentId, experimentId), eq(abAssignmentsTable.userId, userId)))
      .limit(1);

    if (existing) {
      sendSuccess(res, { assignment: existing, isNew: false });
      return;
    }

    const variants = experiment.variants as Array<{ name: string; weight: number }>;
    const totalWeight = variants.reduce((s, v) => s + (v.weight ?? 1), 0);
    let rand = Math.random() * totalWeight;
    let assignedVariant = variants[0]?.name ?? "control";
    for (const v of variants) {
      rand -= v.weight ?? 1;
      if (rand <= 0) { assignedVariant = v.name; break; }
    }

    const [created] = await db.insert(abAssignmentsTable).values({
      id: generateId(),
      experimentId,
      userId,
      variant: assignedVariant,
      converted: false,
    }).returning();

    sendSuccess(res, { assignment: created, isNew: true });
  } catch (err) {
    logger.error({ err }, "[experiments] assign error");
    sendSuccess(res, { assignment: null, isNew: false });
  }
});

export default router;
