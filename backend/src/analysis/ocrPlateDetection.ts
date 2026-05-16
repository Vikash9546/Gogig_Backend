import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { CheckResult } from './types';
import { PLATE_REGEX_STANDARD, PLATE_REGEX_BH } from '../utils/constants';
import logger from '../utils/logger';

/**
 * Indian Vehicle Number Plate OCR — 3-Stage Pipeline
 * 
 * Stage 1: Preprocessing (Sharpening, Normalization, Upscaling)
 * Stage 2: Multi-region, Multi-PSM concurrent OCR
 * Stage 3: Regex matching with common misread correction
 */

const OCR_TIMEOUT_MS = 15000;

/** Preprocess image to enhance plate character edges for OCR engine */
async function preprocessForOcr(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .grayscale()
    .normalize() // Stretch contrast
    .convolve({
      width: 3, height: 3,
      kernel: [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0] // Sharpening
    })
    .resize({ width: 1200, height: undefined, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
}

/** Correct common OCR character misreads in vehicle plates */
function fixOcrMisreads(text: string): string {
  return text
    .toUpperCase()
    .replace(/\bO\b(?=\d)/g, '0')    // O before digit -> 0
    .replace(/(?<=\d)\bO\b/g, '0')   // O after digit -> 0
    .replace(/\bI\b(?=[A-Z])/g, '1')  // I before letter in number context -> 1
    .replace(/\b5\b(?=[A-Z]{2,})/g, 'S') // 5 in letter cluster -> S
    .replace(/\bB\b(?=\d{4})/g, '8');  // B before 4 digits -> 8
}

/** Run Tesseract on a buffer with a timeout and specific PSM */
async function runOcrPass(
  buffer: Buffer, 
  psm: string, 
  regionName: string,
  crop?: { left: number, top: number, width: number, height: number }
): Promise<{ text: string; words: any[] }> {
  let source: string | Buffer = buffer;
  if (crop) {
    source = await sharp(buffer).extract(crop).toBuffer();
  }

  const ocrPromise = Tesseract.recognize(source, 'eng', {
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
  
  // STAGE 1: Preprocessing
  const enhancedBuffer = await preprocessForOcr(filePath);
  const metadata = await sharp(enhancedBuffer).metadata();
  const w = metadata.width!;
  const h = metadata.height!;

  const bottomStrip = { left: 0, top: Math.floor(h * 0.45), width: w, height: Math.floor(h * 0.55) };

  // STAGE 2: Multi-region OCR
  // Pass 1: Bottom Strip (PSM 11) and Full Image (PSM 11) in parallel
  const [passA, passB] = await Promise.all([
    runOcrPass(enhancedBuffer, Tesseract.PSM.SPARSE_TEXT as unknown as string, 'BottomStrip_PSM11', bottomStrip),
    runOcrPass(enhancedBuffer, Tesseract.PSM.SPARSE_TEXT as unknown as string, 'FullImage_PSM11')
  ]);

  let combinedText = passA.text + '\n' + passB.text;
  let allWords = [...passA.words, ...passB.words];
  let ocrRegionsRun = ['BottomStrip_PSM11', 'FullImage_PSM11'];

  // Check if we found a plate in Pass 1
  const checkPlates = (text: string) => {
    const fixed = fixOcrMisreads(text);
    const tokens = fixed.split(/\s+/).filter(t => t.length >= 4);
    const matches: string[] = [];
    for (const token of tokens) {
      if (PLATE_REGEX_STANDARD.test(token) || PLATE_REGEX_BH.test(token)) {
        matches.push(token);
      }
    }
    return matches;
  };

  let detectedPlates = checkPlates(combinedText);

  // Pass 2: Fallback to Bottom Strip (PSM 6) if no plate found
  if (detectedPlates.length === 0) {
    const passC = await runOcrPass(enhancedBuffer, Tesseract.PSM.SINGLE_BLOCK as unknown as string, 'BottomStrip_PSM6', bottomStrip);
    combinedText += '\n' + passC.text;
    allWords = [...allWords, ...passC.words];
    ocrRegionsRun.push('BottomStrip_PSM6');
    detectedPlates = checkPlates(combinedText);
  }

  // STAGE 3: Final Analysis & Confidence
  const fixedText = fixOcrMisreads(combinedText);
  const formatValid = detectedPlates.length > 0;
  
  // Partial matches: [A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{2,4}
  const partialRegex = /[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{2,4}/g;
  const partialMatches = fixedText.match(partialRegex) || [];

  // Confidence calculation
  const matchedWords = allWords.filter(w => detectedPlates.some(p => p.includes(w.text)));
  const ocrWordConfidence = matchedWords.length > 0 
    ? matchedWords.reduce((sum, w) => sum + w.confidence, 0) / matchedWords.length / 100
    : (allWords.length > 0 ? allWords.reduce((sum, w) => sum + w.confidence, 0) / allWords.length / 100 : 0);

  let confidence: number;
  if (formatValid) {
    confidence = ocrWordConfidence > 0.70 
      ? 0.85 + (ocrWordConfidence - 0.70) * 0.5 
      : 0.70;
  } else if (partialMatches.length > 0) {
    confidence = 0.45;
  } else if (combinedText.trim().length > 0) {
    confidence = 0.20;
  } else {
    confidence = 0.05;
  }

  return {
    checkName: 'ocr_plate_detection',
    passed: formatValid,
    confidence,
    details: {
      rawOcrText: combinedText.trim().slice(0, 500),
      correctedText: fixedText.trim().slice(0, 500),
      detectedPlates,
      partialMatches,
      formatValid,
      ocrRegionsRun,
      ocrWordConfidence: Math.round(ocrWordConfidence * 100) / 100,
      processingMs: Date.now() - startMs
    }
  };
}
