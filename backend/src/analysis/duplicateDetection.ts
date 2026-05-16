import sharp from 'sharp';
import crypto from 'crypto';
import fs from 'fs';
import { CheckResult } from './types';
import { query } from '../db/pool';

/**
 * Duplicate Detection — Two-Stage Identification
 * 
 * Stage 1: Exact MD5 Hash Fast-Path
 * Stage 2: Perceptual dHash (Difference Hash) comparison
 */

/** Helper to count differing bits between two hex-encoded 64-bit hashes */
function getHammingDistance(a: string, b: string): number {
  const diff = BigInt('0x' + a) ^ BigInt('0x' + b);
  return diff.toString(2).split('').filter(c => c === '1').length;
}

export async function analyzeDuplicates(
  filePath: string,
  jobId: string
): Promise<CheckResult> {
  const fileBuffer = fs.readFileSync(filePath);

  // --- STAGE 1: Exact duplicate (MD5 fast-path) ---
  const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
  
  const { rows: exactMatches } = await query<{ job_id: string }>(
    'SELECT job_id FROM image_hashes WHERE md5_hash = $1 AND job_id != $2 LIMIT 1',
    [md5Hash, jobId]
  );

  if (exactMatches.length > 0) {
    // Record this job's hash before returning
    await query(
      'INSERT INTO image_hashes (job_id, md5_hash, d_hash, created_at) VALUES ($1, $2, $3, now())',
      [jobId, md5Hash, '0000000000000000'] // dummy dHash for exact match
    );

    return {
      checkName: 'duplicate_detection',
      passed: false,
      confidence: 1.0,
      details: {
        md5Hash,
        dHash: null,
        nearestMatchJobId: exactMatches[0].job_id,
        hammingDistance: 0,
        duplicateType: 'exact',
        stage: 'md5_fast_path'
      }
    };
  }

  // --- STAGE 2: Perceptual hash (dHash) ---
  // Resize to 9x8 grayscale, compare adjacent pixels -> 64-bit hash
  const { data } = await sharp(filePath)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let dHashBinary = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      dHashBinary += data[idx] > data[idx + 1] ? '1' : '0';
    }
  }
  const dHashHex = BigInt('0b' + dHashBinary).toString(16).padStart(16, '0');

  // Fetch up to 500 most recent hashes
  const { rows: recentHashes } = await query<{ job_id: string, d_hash: string }>(
    'SELECT job_id, d_hash FROM image_hashes WHERE job_id != $1 ORDER BY created_at DESC LIMIT 500',
    [jobId]
  );

  let nearestMatchJobId: string | null = null;
  let minDistance: number | null = null;

  for (const row of recentHashes) {
    const dist = getHammingDistance(dHashHex, row.d_hash);
    if (minDistance === null || dist < minDistance) {
      minDistance = dist;
      nearestMatchJobId = row.job_id;
    }
  }

  // TIERED SIMILARITY THRESHOLDS
  let passed = true;
  let confidence = 1.0;
  let duplicateType: 'exact_perceptual' | 'near_identical' | 'likely_duplicate' | 'similar_scene' | 'unique' = 'unique';

  if (minDistance !== null) {
    if (minDistance === 0) {
      passed = false;
      confidence = 0.98;
      duplicateType = 'exact_perceptual';
    } else if (minDistance <= 5) {
      passed = false;
      confidence = 0.90;
      duplicateType = 'near_identical';
    } else if (minDistance <= 12) {
      passed = false;
      confidence = 0.70;
      duplicateType = 'likely_duplicate';
    } else if (minDistance <= 20) {
      passed = true;
      confidence = 0.60;
      duplicateType = 'similar_scene';
    }
  }

  // WRITE BACK AFTER CHECK
  await query(
    'INSERT INTO image_hashes (job_id, md5_hash, d_hash, created_at) VALUES ($1, $2, $3, now())',
    [jobId, md5Hash, dHashHex]
  );

  return {
    checkName: 'duplicate_detection',
    passed,
    confidence,
    details: {
      md5Hash,
      dHash: dHashHex,
      nearestMatchJobId,
      hammingDistance: minDistance,
      duplicateType,
      stage: 'perceptual_hash'
    }
  };
}
