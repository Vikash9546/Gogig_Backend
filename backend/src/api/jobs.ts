import { Request, Response } from 'express';
import {
  getImageJob,
  getAnalysisResultsByJobId,
  listImageJobs,
} from '../db/models';
import { JobNotFoundError, JobNotCompletedError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * GET /api/v1/jobs/:jobId/status
 *
 * Returns the current processing status of a job.
 * Safe to poll repeatedly — read-only, no side effects.
 */
export async function getJobStatus(req: Request, res: Response): Promise<void> {
  const { jobId } = req.params;

  const job = await getImageJob(jobId);
  if (!job) throw new JobNotFoundError(jobId);

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  res.status(200).json({
    job: {
      id: job.id,
      status: job.status,
      originalFilename: job.original_name,
      qualityScore: job.quality_score,
      createdAt: job.created_at,
      processedAt: job.processed_at,
      retryCount: job.retry_count,
      failureReason: job.failure_reason,
    }
  });
}

/**
 * GET /api/v1/jobs/:jobId/results
 *
 * Returns full analysis results. Only available when status = 'completed'.
 * Returns 409 Conflict for in-progress jobs so callers know to retry later.
 *
 * WHY 409 CONFLICT (not 200 with empty results)?
 * Returning 200 with empty data would look like a bug to API consumers.
 * 409 signals "the request is valid but cannot be fulfilled in the current
 * server state" — exactly right for a job still processing.
 */
export async function getJobResults(req: Request, res: Response): Promise<void> {
  const { jobId } = req.params;

  const job = await getImageJob(jobId);
  if (!job) throw new JobNotFoundError(jobId);

  if (job.status !== 'completed') {
    throw new JobNotCompletedError(jobId, job.status);
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  const analysisRows = await getAnalysisResultsByJobId(jobId);

  // Map analysis results by check name, preserving all details and confidence values
  const results: Record<string, any> = {};
  analysisRows.forEach(row => {
    // Map internal check names to camelCase keys for frontend convenience
    const keyMap: Record<string, string> = {
      'blur_detection': 'blur',
      'brightness_analysis': 'brightness',
      'duplicate_detection': 'duplicate',
      'screenshot_detection': 'screenshot',
      'ocr_plate_detection': 'ocr',
      'dimension_validation': 'dimensions'
    };
    
    const key = keyMap[row.check_name] || row.check_name;
    results[key] = {
      passed: row.passed,
      confidence: row.confidence,
      details: row.details || {}
    };
  });

  res.status(200).json({
    id: job.id,
    status: job.status,
    originalFilename: job.original_name,
    qualityScore: job.quality_score,
    processedAt: job.processed_at,
    createdAt: job.created_at,
    results // Nest under results key for better structure
  });
}

/**
 * GET /api/v1/jobs/:jobId/failure
 *
 * Returns failure details for a failed job.
 * Returns 200 even if not failed (status reflects in the body) — callers
 * can check status first or call this speculatively.
 */
export async function getJobFailure(req: Request, res: Response): Promise<void> {
  const { jobId } = req.params;

  const job = await getImageJob(jobId);
  if (!job) throw new JobNotFoundError(jobId);

  res.status(200).json({
    jobId: job.id,
    status: job.status,
    failureReason: job.failure_reason,
    retryCount: job.retry_count,
    createdAt: job.created_at,
    processedAt: job.processed_at,
  });
}

/**
 * GET /api/v1/jobs
 *
 * List jobs with pagination and optional status filter.
 * ?page=1&limit=20&status=completed
 */
export async function listJobs(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed'];
  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
    return;
  }

  const { rows, total } = await listImageJobs({ page, limit, status });

  const jobs = rows.map((job) => ({
    id: job.id,
    originalFilename: job.original_name,
    status: job.status,
    qualityScore: job.quality_score,
    mimeType: job.mime_type,
    fileSizeBytes: job.file_size_bytes,
    retryCount: job.retry_count,
    createdAt: job.created_at,
    processedAt: job.processed_at,
  }));

  res.status(200).json({
    jobs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}
