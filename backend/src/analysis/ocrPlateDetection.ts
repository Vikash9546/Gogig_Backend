import Tesseract, { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { CheckResult, clamp } from './types';
import { PLATE_REGEX_STANDARD, PLATE_REGEX_BH } from '../utils/constants';
import logger from '../utils/logger';

/**
 * Production-Grade Perceptual Vehicle Plate Extraction
 * 
 * Pipeline:
 * 1. ROI Localization (Lightweight grid energy search for horizontal rectangular geometries)
 * 2. Targeted Multi-Pass Preprocessing (Normal grayscale, adaptive, high-contrast, inverted, sharpened)
 * 3. Multi-PSM Multi-Region OCR (SINGLE_LINE with SINGLE_BLOCK fallback)
 * 4. Structural Position-Aware Character Corrections
 * 5. Relaxed Fuzzy Validation (Pattern matching allowing missing digits and minor swaps)
 * 6. Calibrated Dynamic Confidence Fusion (Prevents early confidence collapse)
 */

const OCR_TIMEOUT_MS = 15000;

interface RoiCandidate {
  left: number;
  top: number;
  width: number;
  height: number;
  score: number;
}

/** Correct common OCR character misreads using positional Indian plate formatting */
function fixOcrMisreads(text: string): string {
  // Normalize string by cleaning non-alphanumeric characters
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  let result = '';
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    // If we have standard 10-character standard plate structure, apply strict positional swaps
    if (cleaned.length === 10) {
      const isLetterPos = (i < 2) || (i === 4) || (i === 5);
      const isDigitPos = (i >= 2 && i <= 3) || (i >= 6 && i <= 9);
      if (isLetterPos) {
        if (char === '0') result += 'O';
        else if (char === '1') result += 'I';
        else if (char === '2') result += 'Z';
        else if (char === '5') result += 'S';
        else if (char === '8') result += 'B';
        else result += char;
      } else if (isDigitPos) {
        if (char === 'O') result += '0';
        else if (char === 'I') result += '1';
        else if (char === 'Z') result += '2';
        else if (char === 'S') result += '5';
        else if (char === 'B') result += '8';
        else result += char;
      } else {
        result += char;
      }
    } else {
      // General general/fuzzy positional swaps:
      const distToEnd = cleaned.length - i;
      if (distToEnd <= 4) {
        // Last 4 characters are highly likely digits
        if (char === 'O') result += '0';
        else if (char === 'I') result += '1';
        else if (char === 'Z') result += '2';
        else if (char === 'S') result += '5';
        else if (char === 'B') result += '8';
        else result += char;
      } else if (i < 2) {
        // First 2 characters are highly likely letters (State Code)
        if (char === '0') result += 'O';
        else if (char === '1') result += 'I';
        else if (char === '2') result += 'Z';
        else if (char === '5') result += 'S';
        else if (char === '8') result += 'B';
        else result += char;
      } else {
        result += char;
      }
    }
  }
  return result;
}

/** 
 * Fuzzy Plate Validation
 * Accepts partial formats, spacings, and missing digits to separate quality from extraction constraints.
 */
function getFuzzyPlateScore(token: string): { score: number, type: 'standard' | 'bh' | 'partial' | 'none' } {
  const cleaned = token.replace(/[^A-Z0-9]/g, '');
  
  if (PLATE_REGEX_STANDARD.test(cleaned)) return { score: 1.0, type: 'standard' };
  if (PLATE_REGEX_BH.test(cleaned)) return { score: 1.0, type: 'bh' };

  // 1. Missing final digit or slightly shorter standard (e.g. RJ19UC703)
  if (cleaned.length === 9) {
    const isShortStandard = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{3}$/.test(cleaned);
    if (isShortStandard) return { score: 0.9, type: 'partial' };
  }

  // 2. State code (2 letters) + District (2 digits) + Series (1-2 letters) + Number (1-4 digits)
  const isRelaxedStandard = /^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{1,4}$/.test(cleaned);
  if (isRelaxedStandard) {
    if (cleaned.length >= 8) return { score: 0.85, type: 'partial' };
    return { score: 0.65, type: 'partial' };
  }

  // 3. BH relaxed series (e.g. 22 BH 1234 A)
  const isRelaxedBh = /^[0-9]{2}BH[0-9]{1,4}[A-Z]{1,2}$/.test(cleaned);
  if (isRelaxedBh) return { score: 0.85, type: 'partial' };

  // 4. Loose alphanumeric balance for messy uploads
  if (cleaned.length >= 7) {
    const digitCount = (cleaned.match(/\d/g) || []).length;
    const letterCount = (cleaned.match(/[A-Z]/g) || []).length;
    if (digitCount >= 3 && letterCount >= 3) {
      return { score: 0.5, type: 'partial' };
    }
  }

  return { score: 0, type: 'none' };
}

/** 
 * Lightweight Plate ROI Detection
 * Uses horizontal rectangular geometry window matching (aspect ratios between 2.5–6.5) and bottom-center density.
 */
async function findPlateCandidates(filePath: string): Promise<RoiCandidate[]> {
  const metadata = await sharp(filePath).metadata();
  const W = metadata.width || 0;
  const H = metadata.height || 0;

  // Process small grayscale Laplacian representation to find high edge/contrast density
  const { data, info } = await sharp(filePath)
    .resize(300, 300, { fit: 'fill' })
    .grayscale()
    .convolve({
      width: 3, height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1]
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const grid = 12;
  const cellW = Math.floor(w / grid);
  const cellH = Math.floor(h / grid);
  
  // Calculate raw grid energy matrix
  const gridEnergy = Array(grid).fill(0).map(() => Array(grid).fill(0));
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let energy = 0;
      for (let y = gy * cellH; y < (gy + 1) * cellH; y++) {
        for (let x = gx * cellW; x < (gx + 1) * cellW; x++) {
          energy += data[y * w + x];
        }
      }
      gridEnergy[gy][gx] = energy;
    }
  }

  const candidates: RoiCandidate[] = [];

  // Focus on the bottom 60% where vehicle plates reside
  for (let gy = 4; gy < grid - 1; gy++) {
    for (let gx = 1; gx < grid - 2; gx++) {
      // Prioritize horizontal geometry matching typical license plate aspect ratios (2.5 - 6.5)
      for (const spanX of [3, 4]) {
        for (const spanY of [1, 2]) {
          const aspect = (spanX * cellW) / (spanY * cellH);
          if (aspect < 2.5 || aspect > 6.5) continue;
          
          let energy = 0;
          for (let dy = 0; dy < spanY; dy++) {
            for (let dx = 0; dx < spanX; dx++) {
              const cy = gy + dy;
              const cx = gx + dx;
              if (cy < grid && cx < grid) {
                energy += gridEnergy[cy][cx];
              }
            }
          }

          // Center-weighting: Prefer plates aligned to the center axis
          const centerX = gx + spanX / 2;
          const distToCenter = Math.abs(centerX - grid / 2);
          const posWeight = (gy / grid) * (1 - distToCenter / (grid / 2));
          const score = energy * posWeight;

          if (score > 1000) {
            // Apply generous padding parameters to avoid character clipping
            const cropLeft = Math.max(0, Math.floor(((gx - 0.5) / grid) * W));
            const cropTop = Math.max(0, Math.floor(((gy - 0.5) / grid) * H));
            const cropWidth = Math.min(W - cropLeft, Math.floor(((spanX + 1) / grid) * W));
            const cropHeight = Math.min(H - cropTop, Math.floor(((spanY + 1) / grid) * H));

            candidates.push({
              left: cropLeft,
              top: cropTop,
              width: cropWidth,
              height: cropHeight,
              score
            });
          }
        }
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

/** Preprocess specific ROI using targeted multi-pass variants to handle glare/contrast issues */
async function preprocessRoi(
  buffer: Buffer,
  crop: RoiCandidate,
  mode: 'grayscale' | 'adaptive' | 'high_contrast' | 'inverted' | 'sharpened'
): Promise<Buffer> {
  let pipeline = sharp(buffer)
    .extract({
      left: crop.left,
      top: crop.top,
      width: crop.width,
      height: crop.height
    })
    .resize(900)
    .grayscale()
    .normalize();

  if (mode === 'high_contrast') {
    // Boost contrast stretching manually
    pipeline = pipeline.linear(1.5, -0.2);
  }

  if (mode === 'sharpened') {
    pipeline = pipeline.sharpen(3);
  }

  if (mode === 'adaptive') {
    pipeline = pipeline.threshold(120);
  }

  if (mode === 'inverted') {
    pipeline = pipeline.negate().threshold(140);
  }

  return pipeline.png().toBuffer();
}

async function runOcrPass(
  buffer: Buffer, 
  psm: string, 
  regionName: string
): Promise<{ text: string; words: any[] }> {
  const ocrPromise = Tesseract.recognize(buffer, 'eng', {
    tessedit_pageseg_mode: psm,
    tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY as unknown as string,
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
  } as Record<string, string>);

  const timeoutPromise = new Promise<{ text: string; words: any[] }>((resolve) => {
    setTimeout(() => {
      logger.warn({ regionName }, 'OCR Pass timed out');
      resolve({ text: '', words: [] });
    }, OCR_TIMEOUT_MS);
  });

  const result = await Promise.race([ocrPromise, timeoutPromise]);
  return {
    text: (result as any).data?.text ?? '',
    words: (result as any).data?.words ?? []
  };
}

export async function analyzeOcrPlate(filePath: string): Promise<CheckResult> {
  const startMs = Date.now();
  const rawImage = await sharp(filePath).toBuffer();
  
  // 1. Locate ROI candidates
  const roiCandidates = await findPlateCandidates(filePath);
  const metadata = await sharp(filePath).metadata();
  const W = metadata.width || 0;
  const H = metadata.height || 0;

  // Use a sensible bottom-half fallback region if no candidate crops found
  const rois = roiCandidates.length > 0 ? roiCandidates : [{
    left: 0, top: Math.floor(H * 0.45), width: W, height: Math.floor(H * 0.55), score: 0
  }];

  // 2. Parallel Multi-Pass OCR across five visual formats
  const ocrPromises = rois.map(async (roi, idx) => {
    const variants = await Promise.all([
      preprocessRoi(rawImage, roi, 'grayscale'),
      preprocessRoi(rawImage, roi, 'adaptive'),
      preprocessRoi(rawImage, roi, 'high_contrast'),
      preprocessRoi(rawImage, roi, 'inverted'),
      preprocessRoi(rawImage, roi, 'sharpened')
    ]);

    const results = await Promise.all(
      variants.map(async (buf, i) => {
        // Cropped ROI focuses perfectly on single text lines, standard fallback benefits from single-block
        let ocrRes = await runOcrPass(
          buf,
          (roi.score > 0 ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.SINGLE_BLOCK) as unknown as string,
          `ROI_${idx}_VARIANT_${i}`
        );
        
        // Dynamic PSM Fallback: Try SINGLE_BLOCK if SINGLE_LINE misses completely
        if (roi.score > 0 && (!ocrRes.text || ocrRes.text.trim().length === 0)) {
          ocrRes = await runOcrPass(
            buf,
            Tesseract.PSM.SINGLE_BLOCK as unknown as string,
            `ROI_${idx}_VARIANT_${i}_FB`
          );
        }
        return ocrRes;
      })
    );

    return results;
  });

  const ocrResultsNested = await Promise.all(ocrPromises);
  const ocrResults = ocrResultsNested.flat();

  // 3. Token Scrubbing & Fuzzy Matching
  const allDetectedTokens: string[] = [];
  const validPlates: string[] = [];
  let bestOcrConfidence = 0;

  ocrResults.forEach(res => {
    const cleaned = res.text
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ' ');

    const tokens = cleaned
      .split(/\s+/)
      .filter(t => t.length >= 4);

    tokens.forEach(t => {
      const fixed = fixOcrMisreads(t);
      const { score } = getFuzzyPlateScore(fixed);
      if (score > 0.4) {
        allDetectedTokens.push(fixed);
        if (score >= 0.85) validPlates.push(fixed);
      }
    });

    if (res.words.length > 0) {
      const plateWords = res.words.filter(w => getFuzzyPlateScore(fixOcrMisreads(w.text)).score > 0.3);
      if (plateWords.length > 0) {
        const conf = plateWords.reduce((a, b) => a + b.confidence, 0) / plateWords.length / 100;
        bestOcrConfidence = Math.max(bestOcrConfidence, conf);
      }
    }
  });

  // 4. Human-Centric Interpretation & Separation of Failures
  const formatValid = validPlates.length > 0;
  const hasPartial = allDetectedTokens.length > 0;
  
  let readability: string = 'unreadable';
  let perceptualCertainty = 0;

  if (formatValid) {
    perceptualCertainty = bestOcrConfidence > 0.7 ? 0.95 : 0.80;
    readability = bestOcrConfidence > 0.75 ? 'clearly_readable' : 'mostly_readable';
  } else if (hasPartial) {
    perceptualCertainty = 0.65;
    readability = 'partially_readable';
  } else if (roiCandidates.length > 0) {
    // Found plate ROI candidates, but character recognition timed out or failed (likely readable by visual auditor)
    perceptualCertainty = 0.45;
    readability = 'low_confidence_extraction';
  } else {
    perceptualCertainty = 0.10;
    readability = 'unreadable_plate';
  }

  // 5. Dynamic Confidence Fusion (Protects against early collapse)
  const roiStrong = roiCandidates.length > 0 && roiCandidates[0].score > 3000;
  const roiStrength = roiCandidates.length > 0
    ? Math.min(roiCandidates[0].score / 5000, 1)
    : 0;

  let confidence = clamp(
    0.25 + (bestOcrConfidence * 0.5) + (roiStrength * 0.25),
    0.2,
    0.95
  );

  // Boost confidence if geometry is strong and partial matches exist, preventing regex penalties from causing visual failure
  if (roiStrong && allDetectedTokens.length > 0) {
    confidence = Math.max(confidence, 0.55);
  }

  return {
    checkName: 'ocr_plate_detection',
    passed: formatValid || hasPartial || roiCandidates.length > 0,
    confidence,
    details: {
      detectedPlates: [...new Set(validPlates)],
      partialMatches: [...new Set(allDetectedTokens)],
      roiCount: roiCandidates.length,
      bestOcrConfidence: Math.round(bestOcrConfidence * 100) / 100,
      processingMs: Date.now() - startMs,
      perceptualLabels: {
        readability,
        extractionQuality: bestOcrConfidence > 0.8 ? 'High' : bestOcrConfidence > 0.5 ? 'Medium' : 'Low',
        humanPerceptionScore: perceptualCertainty
      }
    }
  };
}

export class OCRService {
  async extractText(imagePath: string): Promise<string> {
    const worker = await createWorker('eng');
    try {
      const { data: { text } } = await worker.recognize(imagePath);
      return text.trim();
    } catch (error) {
      logger.error(error, 'OCR Extraction failed');
      return '';
    } finally {
      await worker.terminate();
    }
  }

  validateIndianPlate(text: string) {
    // Regex for Indian Plate formats: MH12AB1234, DL01C4321, etc.
    // Standard: 2 letters, 2 digits, 1 or 2 letters, 4 digits
    const plateRegex = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/g;
    const matches = text.toUpperCase().replace(/[^A-Z0-9]/g, '').match(plateRegex);
    
    return {
      isValid: !!matches && matches.length > 0,
      plates: matches || [],
    };
  }
}
