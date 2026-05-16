import sharp from 'sharp';
import { CheckResult, clamp } from './types';
import {
  SCREENSHOT_EDGE_DENSITY_THRESHOLD,
  SCREENSHOT_COMMON_RESOLUTIONS,
  SCREENSHOT_EXIF_KEYWORDS,
  SCREENSHOT_PALETTE_THRESHOLD,
  SCREENSHOT_FLAT_RATIO_THRESHOLD,
  SCREENSHOT_SCORE_THRESHOLD,
} from '../utils/constants';

/**
 * Screenshot Detection — 5-Heuristic Weighted Scoring System
 */

/** Check EXIF metadata for screen-capture software signatures */
async function checkExifFlag(filePath: string): Promise<boolean> {
  try {
    const metadata = await sharp(filePath).metadata();
    if (!metadata.exif) return false;
    const exifText = metadata.exif.toString('latin1').toLowerCase();
    return SCREENSHOT_EXIF_KEYWORDS.some((keyword) => exifText.includes(keyword));
  } catch {
    return false;
  }
}

/** Stricter Aspect Ratio: ratio AND known resolution match */
function checkAspectRatioFlag(width: number, height: number): boolean {
  const ratio = width / height;
  const commonRatios = [16 / 9, 16 / 10, 4 / 3, 21 / 9];
  const isCommonRatio = commonRatios.some(r => Math.abs(ratio - r) < 0.005 || Math.abs((1/ratio) - r) < 0.005);
  
  if (!isCommonRatio) return false;

  const matchesResolution = SCREENSHOT_COMMON_RESOLUTIONS.some(res => 
    (width === res.width && height === res.height) || 
    (width === res.height && height === res.width)
  );
  
  return matchesResolution;
}

/** Adjusted Edge Density: Normalize by megapixels */
async function checkEdgeDensity(filePath: string, megapixels: number): Promise<{ flagged: boolean; ratio: number }> {
  const { data: sobelXData } = await sharp(filePath).grayscale().convolve({ width: 3, height: 3, kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1] }).raw().toBuffer({ resolveWithObject: true });
  const { data: sobelYData, info } = await sharp(filePath).grayscale().convolve({ width: 3, height: 3, kernel: [-1, -2, -1, 0, 0, 0, 1, 2, 1] }).raw().toBuffer({ resolveWithObject: true });

  let edgePixels = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (Math.abs(sobelXData[i]) + Math.abs(sobelYData[i]) > 30) edgePixels++;
  }

  const rawRatio = edgePixels / (info.width * info.height);
  const adjustedRatio = rawRatio / clamp(megapixels / 2, 0.5, 3);
  return { flagged: adjustedRatio > SCREENSHOT_EDGE_DENSITY_THRESHOLD, ratio: adjustedRatio };
}

/** Color Palette Entropy: Unique quantized colors */
async function checkColorPalette(filePath: string): Promise<{ flagged: boolean; count: number; entropy: number }> {
  const { data } = await sharp(filePath).resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 3) {
    const r4 = data[i] >> 4;
    const g4 = data[i + 1] >> 4;
    const b4 = data[i + 2] >> 4;
    colors.add((r4 << 8) | (g4 << 4) | b4);
  }
  const count = colors.size;
  const entropy = count / 4096;
  return { flagged: count < SCREENSHOT_PALETTE_THRESHOLD, count, entropy };
}

/** Flat Region Ratio: Large uniform-color areas */
async function checkFlatRegions(filePath: string): Promise<{ flagged: boolean; ratio: number }> {
  const { data, info } = await sharp(filePath).resize(100, 100, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let flatPixels = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = data[y * width + x];
      const diff = Math.max(
        Math.abs(c - data[(y - 1) * width + x]),
        Math.abs(c - data[(y + 1) * width + x]),
        Math.abs(c - data[y * width + (x - 1)]),
        Math.abs(c - data[y * width + (x + 1)])
      );
      if (diff < 8) flatPixels++;
    }
  }
  const ratio = flatPixels / (width * height);
  return { flagged: ratio > SCREENSHOT_FLAT_RATIO_THRESHOLD, ratio };
}

export async function analyzeScreenshot(filePath: string): Promise<CheckResult> {
  const metadata = await sharp(filePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const megapixels = (width * height) / 1_000_000;

  const [exifFlag, edge, palette, flat] = await Promise.all([
    checkExifFlag(filePath),
    checkEdgeDensity(filePath, megapixels),
    checkColorPalette(filePath),
    checkFlatRegions(filePath)
  ]);
  const aspectRatioFlag = checkAspectRatioFlag(width, height);

  const scores = {
    exif: exifFlag ? 1 : 0,
    aspectRatio: aspectRatioFlag ? 2 : 0,
    edgeDensity: edge.flagged ? 1 : 0,
    colorPalette: palette.flagged ? 2 : 0,
    flatRegion: flat.flagged ? 2 : 0
  };

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const maxPossible = 8;
  const passed = totalScore < SCREENSHOT_SCORE_THRESHOLD;
  const confidence = totalScore / maxPossible;

  return {
    checkName: 'screenshot_detection',
    passed,
    confidence,
    details: {
      exifFlag,
      aspectRatioFlag,
      edgeDensityFlag: edge.flagged,
      edgeDensityRatio: Math.round(edge.ratio * 1000) / 1000,
      colorPaletteFlag: palette.flagged,
      uniqueColorCount: palette.count,
      colorEntropy: Math.round(palette.entropy * 1000) / 1000,
      flatRegionFlag: flat.flagged,
      flatRatio: Math.round(flat.ratio * 1000) / 1000,
      totalScore,
      maxPossibleScore: maxPossible,
      scoreBreakdown: scores
    }
  };
}
