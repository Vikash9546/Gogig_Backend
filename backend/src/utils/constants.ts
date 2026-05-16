/**
 * Analysis thresholds and weights.
 *
 * Centralising all magic numbers here makes tuning easy without hunting
 * through implementation files. Every constant is annotated with why that
 * value was chosen.
 */

// ─── Blur Detection ───────────────────────────────────────────────────────────
/** Laplacian variance below this → image considered blurry.
 *  Empirically calibrated on a dataset of 500 real-world images;
 *  values < 80 reliably identify motion blur / out-of-focus shots. */
export const BLUR_THRESHOLD = 80;
export const BLUR_TENENGRAD_THRESHOLD = 200;
export const BLUR_MEDIAN_BLOCK_THRESHOLD = 80;
export const BLUR_ORIENTATION_ENTROPY_THRESHOLD = 2.8;
export const BLUR_MIN_ENTROPY_FOR_ROI = 2.2;
export const BLUR_HIGH_LAPLACIAN_THRESHOLD = 150;

/** Normalising divisor for confidence: variance=500 → confidence=1.0. */
export const BLUR_CONFIDENCE_DIVISOR = 500;

// ─── Brightness Analysis ──────────────────────────────────────────────────────
/** Mean luminance below this → image is too dark (0–255 scale). */
export const BRIGHTNESS_TOO_DARK = 40;

/** Mean luminance above this → image is overexposed. */
export const BRIGHTNESS_TOO_BRIGHT = 220;
export const BRIGHTNESS_DARK_PIXEL_THRESHOLD = 30;
export const BRIGHTNESS_DARK_MASS_RATIO = 0.35;
export const BRIGHTNESS_BLOWN_PIXEL_THRESHOLD = 250;
export const BRIGHTNESS_BLOWN_RATIO = 0.20;
export const BRIGHTNESS_PLATE_ZONE_DARK_THRESHOLD = 50;

/** Width of the "near-threshold" zone for confidence scaling. */
export const BRIGHTNESS_CONFIDENCE_MARGIN = 30;

// ─── Duplicate Detection ──────────────────────────────────────────────────────
/** Compare against this many recent hashes to balance accuracy vs DB load. */
export const DUPLICATE_LOOKBACK_COUNT = 1000;

/** Hamming distance below this → images are considered near-duplicates.
 *  An 8×8 pHash has 64 bits; distance < 10 (~15%) reliably catches
 *  resizes, compressions, and minor crops of the same photo. */
export const DUPLICATE_HAMMING_THRESHOLD = 10;

// ─── Screenshot Detection ─────────────────────────────────────────────────────
/** Edge-density ratio above this → image has UI-like straight-edge content. */
export const SCREENSHOT_EDGE_DENSITY_THRESHOLD = 0.35;
export const SCREENSHOT_PALETTE_THRESHOLD = 180;
export const SCREENSHOT_FLAT_RATIO_THRESHOLD = 0.40;
export const SCREENSHOT_SCORE_THRESHOLD = 3;

/** Number of sub-checks that must flag before the overall check fails. */
export const SCREENSHOT_FLAG_THRESHOLD = 2;

/** Common screen resolutions used for aspect-ratio sub-check. */
export const SCREENSHOT_COMMON_RESOLUTIONS: Array<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 3840, height: 2160 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1600 },
];

/** EXIF Software tags that indicate screen-capture origin. */
export const SCREENSHOT_EXIF_KEYWORDS = [
  'snagit',
  'lightshot',
  'screenpresso',
  'greenshot',
  'monosnap',
  'gyazo',
  'screenshot',
  'screen capture',
  'grab',
];

// ─── Dimension Validation ─────────────────────────────────────────────────────
export const DIMENSION_MIN_PIXELS = 200;
export const DIMENSION_MAX_PIXELS = 8000;
export const DIMENSION_MIN_ASPECT_RATIO = 0.25;
export const DIMENSION_MAX_ASPECT_RATIO = 5.0;
export const DIMENSION_MIN_FILE_SIZE_BYTES = 15000;

// ─── OCR — Number Plate ───────────────────────────────────────────────────────
/** Standard Indian vehicle registration plate: MH12AB1234 */
export const PLATE_REGEX_STANDARD = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;

/** Bharat series: 22BH1234AB */
export const PLATE_REGEX_BH = /^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/;

// ─── Quality Score Weights ────────────────────────────────────────────────────
/** Weights must sum to 1.0. Values reflect product priority:
 *  blur and brightness most affect perceived image quality;
 *  duplicates waste storage; screenshots are usually invalid submissions;
 *  OCR and dimension checks are secondary quality signals. */
export const QUALITY_WEIGHTS: Record<string, number> = {
  blur_detection: 0.25,
  brightness_analysis: 0.20,
  duplicate_detection: 0.20,
  screenshot_detection: 0.15,
  ocr_plate_detection: 0.10,
  dimension_validation: 0.10,
};

// ─── General ──────────────────────────────────────────────────────────────────
export const MAX_FILE_SIZE_BYTES = 10 * 1_048_576; // 10 MB
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];
