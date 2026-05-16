import sharp from 'sharp';
import { CheckResult, clamp } from './types';
import { 
  BLUR_THRESHOLD, 
  BLUR_TENENGRAD_THRESHOLD, 
  BLUR_MEDIAN_BLOCK_THRESHOLD,
  BLUR_ORIENTATION_ENTROPY_THRESHOLD,
  BLUR_MIN_ENTROPY_FOR_ROI,
  BLUR_HIGH_LAPLACIAN_THRESHOLD
} from '../utils/constants';

/**
 * Blur Detection — Advanced Multi-Metric Ensemble
 * 
 * We combine three categories of independent signals:
 * A. Edge Energy: Laplacian Variance & Tenengrad
 * B. Spatial Distribution: Median Block Sharpness (Robust to noise spikes)
 * C. Directional Consistency: Orientation Entropy (Detects motion streaks)
 * 
 * Why Entropy?
 * Sharp images have gradients in all directions (High entropy).
 * Motion/Shake blur causes gradients to align in one direction (Low entropy).
 */

/** Helper to compute Laplacian variance for a specific pixel buffer and region */
function computeLaplacianVariance(
  pixels: Uint8Array, 
  width: number, 
  height: number,
  startX: number = 1,
  startY: number = 1,
  endX: number = width - 1,
  endY: number = height - 1
): number {
  const laplacian: number[] = [];
  
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const center = pixels[y * width + x];
      const top = pixels[(y - 1) * width + x];
      const bottom = pixels[(y + 1) * width + x];
      const left = pixels[y * width + (x - 1)];
      const right = pixels[y * width + (x + 1)];

      const value = top + bottom + left + right - 4 * center;
      laplacian.push(value);
    }
  }

  if (laplacian.length === 0) return 0;
  
  const n = laplacian.length;
  const mean = laplacian.reduce((sum, v) => sum + v, 0) / n;
  const variance = laplacian.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return variance;
}

/** 
 * Combined Helper: Computes Tenengrad variance AND Gradient Orientation Entropy.
 * Using a single pass over pixels for optimal performance.
 */
function computeGradientsAndEntropy(pixels: Uint8Array, width: number, height: number): { 
  tenengrad: number; 
  entropy: number;
} {
  const magnitudes: number[] = [];
  const bins = new Float32Array(36); // 10 degree bins
  const MAGNITUDE_THRESHOLD = 20;    // Ignore noise for orientation signal

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Sobel-X: [-1 0 1; -2 0 2; -1 0 1]
      const gx = (
        -1 * pixels[(y - 1) * width + (x - 1)] + 1 * pixels[(y - 1) * width + (x + 1)] +
        -2 * pixels[y * width + (x - 1)] + 2 * pixels[y * width + (x + 1)] +
        -1 * pixels[(y + 1) * width + (x - 1)] + 1 * pixels[(y + 1) * width + (x + 1)]
      );

      // Sobel-Y: [-1 -2 -1; 0 0 0; 1 2 1]
      const gy = (
        -1 * pixels[(y - 1) * width + (x - 1)] + -2 * pixels[(y - 1) * width + x] + -1 * pixels[(y - 1) * width + (x + 1)] +
         1 * pixels[(y + 1) * width + (x - 1)] +  2 * pixels[(y + 1) * width + x] +  1 * pixels[(y + 1) * width + (x + 1)]
      );

      const mag = Math.sqrt(gx * gx + gy * gy);
      magnitudes.push(mag);

      if (mag > MAGNITUDE_THRESHOLD) {
        let angle = Math.atan2(gy, gx);
        if (angle < 0) angle += 2 * Math.PI;
        const bin = Math.floor((angle / (2 * Math.PI)) * 36) % 36;
        bins[bin]++; 
      }
    }
  }

  // 1. Tenengrad (Edge Energy)
  const n = magnitudes.length;
  const mean = magnitudes.reduce((sum, v) => sum + v, 0) / n;
  const tenengrad = magnitudes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;

  // 2. Orientation Entropy (Directional Consistency)
  const totalCounts = bins.reduce((a, b) => a + b, 0);
  let entropy = 0;
  if (totalCounts > 0) {
    for (let i = 0; i < 36; i++) {
      const p = bins[i] / totalCounts;
      if (p > 0) entropy -= p * Math.log(p);
    }
  }

  return { tenengrad, entropy };
}

export async function analyzeBlur(filePath: string): Promise<CheckResult> {
  const { data, info } = await sharp(filePath)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixels = new Uint8Array(data);

  // METRIC 1 & 2: Edge Energy & Directional Consistency
  const laplacianVar = computeLaplacianVariance(pixels, width, height);
  const { tenengrad, entropy: orientationEntropy } = computeGradientsAndEntropy(pixels, width, height);

  // METRIC 3: Spatial distribution via Median Block Sharpness (4x4 grid)
  const blockVariances: number[] = [];
  const blockW = Math.floor(width / 4);
  const blockH = Math.floor(height / 4);

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      blockVariances.push(computeLaplacianVariance(
        pixels, width, height,
        Math.max(1, col * blockW), 
        Math.max(1, row * blockH),
        Math.min(width - 1, (col + 1) * blockW),
        Math.min(height - 1, (row + 1) * blockH)
      ));
    }
  }
  const sortedBlocks = [...blockVariances].sort((a, b) => a - b);
  const medianBlockSharpness = sortedBlocks[Math.floor(sortedBlocks.length / 2)];

  // MOTION BLUR DETECTION LOGIC
  // If we have high edge energy but low entropy, it's a directional streak (Motion Blur)
  const motionBlurDetected = laplacianVar > BLUR_HIGH_LAPLACIAN_THRESHOLD && 
                             orientationEntropy < BLUR_ORIENTATION_ENTROPY_THRESHOLD;

  // IMPROVED CENTER ROI OVERRIDE
  // Portrait/Bokeh photos must have high center sharpness AND non-directional detail
  const centerRoiVar = computeLaplacianVariance(
    pixels, width, height,
    Math.floor(width * 0.25), Math.floor(height * 0.20),
    Math.floor(width * 0.75), Math.floor(height * 0.80)
  );
  const centerRoiOverride = centerRoiVar >= (BLUR_THRESHOLD * 1.5) && 
                            orientationEntropy > BLUR_MIN_ENTROPY_FOR_ROI;

  // ENSEMBLE VOTING
  let blurryVotes = 0;
  if (laplacianVar < BLUR_THRESHOLD) blurryVotes++;
  if (tenengrad < BLUR_TENENGRAD_THRESHOLD) blurryVotes++;
  if (medianBlockSharpness < BLUR_MEDIAN_BLOCK_THRESHOLD) blurryVotes++;

  // Final Decision: 2 of 3 votes required, or Motion Blur flag, or ROI override
  let passed = (blurryVotes <= 1) && !motionBlurDetected;
  if (centerRoiOverride) passed = true;

  // REFINED CONFIDENCE SCORING
  // Penalize motion blur signatures even if they have high edge energy
  const laplacianNorm = clamp(laplacianVar / 500, 0, 1);
  const tenengradNorm = clamp(tenengrad / 2000, 0, 1);
  const blockNorm     = clamp(medianBlockSharpness / 400, 0, 1);
  const entropyNorm   = clamp(orientationEntropy / 3.0, 0, 1);
  
  const rawConfidence = (0.3 * laplacianNorm) + (0.3 * tenengradNorm) + (0.4 * blockNorm);
  const confidence = clamp(rawConfidence * entropyNorm, 0, 1);

  return {
    checkName: 'blur_detection',
    passed,
    confidence,
    details: {
      laplacianVariance: Math.round(laplacianVar * 100) / 100,
      tenegradScore: Math.round(tenengrad * 100) / 100,
      orientationEntropy: Math.round(orientationEntropy * 100) / 100,
      medianBlockSharpness: Math.round(medianBlockSharpness * 100) / 100,
      centerRoiVariance: Math.round(centerRoiVar * 100) / 100,
      centerRoiOverride,
      motionBlurDetected,
      blurryVoteCount: blurryVotes,
      thresholds: { 
        laplacian: BLUR_THRESHOLD, 
        tenengrad: BLUR_TENENGRAD_THRESHOLD, 
        medianBlock: BLUR_MEDIAN_BLOCK_THRESHOLD,
        entropy: BLUR_ORIENTATION_ENTROPY_THRESHOLD
      }
    }
  };
}
