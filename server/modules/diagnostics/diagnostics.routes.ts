import express from 'express';
import type { Request, Response } from 'express';

import {
  clearRunOutcomes,
  readRunOutcomes,
} from '@/modules/diagnostics/services/run-outcome-log.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/** Reads the optional `limit` query without rejecting a malformed one. */
function readLimit(request: Request): number | undefined {
  const raw = request.query.limit;
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

const router = express.Router();

router.get(
  '/runs',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ runs: readRunOutcomes(readLimit(req)) }));
  }),
);

router.delete(
  '/runs',
  asyncHandler(async (_req: Request, res: Response) => {
    clearRunOutcomes();
    res.json(createApiSuccessResponse({ cleared: true }));
  }),
);

export default router;
