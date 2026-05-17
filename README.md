# Intelligent Media Processing Pipeline

A production-quality asynchronous image analysis backend built with **Node.js + TypeScript**, **PostgreSQL**, **BullMQ (Redis)**, and **Sharp / Tesseract.js**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLIENT (curl / frontend app)                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │  POST /api/v1/upload (multipart)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API SERVER (Express + TypeScript)                    │
│                                                                              │
│  ┌─────────────────────────┐    ┌──────────────────────────────────────┐    │
│  │  Upload Handler         │    │  Results / Status Handlers           │    │
│  │  • Magic byte check     │    │  • GET /jobs/:id/status              │    │
│  │  • Sharp decode check   │    │  • GET /jobs/:id/results             │    │
│  │  • Save to Storage      │    │  • GET /jobs/:id/failure             │    │
│  │  • Insert DB record     │    │  • GET /jobs (paginated)             │    │
│  └────────────┬────────────┘    └──────────────────────────────────────┘    │
└───────────────┼─────────────────────────────────────────────────────────────┘
                │  enqueue({ jobId, filePath, ... })
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BullMQ Queue — "image-analysis"                        │
│                    (Redis-backed, persistent, retryable)                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │  consume (concurrency: 3)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       WORKER PROCESS (separate Node.js process)              │
│                                                                              │
│  status = 'processing'                                                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │             Promise.allSettled (all 6 checks concurrent)            │    │
│  │                                                                      │    │
│  │  ① Blur Detection    ② Brightness     ③ Duplicate Detection         │    │
│  │    (Laplacian var)     (Mean lum.)      (dHash + Hamming)           │    │
│  │                                                                      │    │
│  │  ④ Screenshot Det.   ⑤ OCR Plate      ⑥ Dimension Check            │    │
│  │    (EXIF+ratio+Sobel) (Tesseract)       (metadata only)             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  INSERT analysis_results (one row per check)                                 │
│  UPDATE image_jobs SET status='completed', quality_score=…                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PostgreSQL Database                                  │
│                                                                              │
│   image_jobs ──────────────────────────────────────────────────────────     │
│   │ id (UUID PK)  │ status (ENUM)  │ quality_score │ perceptual_hash │      │
│                                                                              │
│   analysis_results ──────────────────────────────────────────────────────   │
│   │ id (UUID PK)  │ job_id (FK)  │ check_name │ passed │ confidence │       │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────┐   ┌───────────────────────┐
│  Local Storage       │   │  (swap-in: S3/GCS)    │
│  /uploads/{uuid}.ext │   │  StorageProvider API  │
└──────────────────────┘   └───────────────────────┘
```

### Component Responsibilities

| Component | Why it exists |
|---|---|
| **API Server** | Accepts uploads, validates synchronously, returns immediately (async design). Keeps the upload latency to <100ms regardless of analysis time. |
| **PostgreSQL** | Authoritative record of job state and results. Chosen over MongoDB because the schema is well-defined, joins are needed (jobs ↔ results), and ACID guarantees prevent partial-result confusion. |
| **BullMQ + Redis** | Decouples upload acceptance from analysis work. Provides durable job persistence (survives worker restarts), backpressure control, and a retry mechanism with exponential backoff. |
| **Worker** | Separate process to avoid blocking the API event loop with CPU-bound Sharp and Tesseract operations. |
| **Storage Provider** | Abstraction layer that hides whether files live on local disk or S3. Zero call-site changes needed to switch. |
| **Analysis Modules** | Each check is a single-responsibility function. New checks can be added without touching the orchestrator beyond registering them in `index.ts`. |

### Vehicle Image Trust Engine Core Upgrades

To support production-grade field-uploaded vehicle verification, we transitioned from basic metric comparisons to a calibrated **Multi-Dimensional Vehicle Image Trust Engine**:

1. **Multi-Dimensional Trust Scoring Model**:
   Fuses independent visual and integrity signals into five distinct evaluation dimensions to isolate visual quality failures from workflow risk, preventing visually pristine images with unreadable plates from being marked as malicious or invalid:
   * **Visual Quality (0-100)**: Evaluates sharpness, focus, and illumination levels.
   * **OCR Reliability (0-100)**: Reflects algorithmic character extraction confidence and pattern matching strength.
   * **Authenticity Confidence (0-100)**: Detects capture anomalies, screenshot heuristics, and editing tampering signatures.
   * **Workflow Integrity (0-100)**: Pinpoints duplicate submissions and content reuse patterns.
   * **Operational Usability (0-100)**: Employs a visual-focused weighted average to represent real-world human auditing potential.

2. **Position-Aware Multi-Pass OCR Engine**:
   Tackles low-resolution, angled, and dirty vehicle plates using a localized parallel OCR mechanism:
   * **Aspect-Filtered ROI Finder**: Performs sliding-window grid scanning focusing on horizontal aspect ratios (2.5–6.5) aligned with the bottom-center axis.
   * **Parallel Multi-Pass Preprocessing**: Runs five separate image contrast pipelines (`grayscale`, `adaptive`, `high_contrast`, `inverted`, and `sharpened`) on candidate crops to optimize character contour extraction.
   * **Dynamic PSM Strategy**: Runs Tesseract using `PSM.SINGLE_LINE` on localized ROIs for high-speed precision, falling back to `PSM.SINGLE_BLOCK` if initial readings are sparse.
   * **Fuzzy Alphanumeric Correction**: Performs layout-aware positional swaps (e.g. `O` ➔ `0`, `I` ➔ `1` inside digit blocks) and relaxed pattern matches to catch standard and BH formats even when characters are partially obscured.

3. **Structured Metadata & EXIF Visual Profiling**:
   Parses raw binary image streams to extract full encoding profiles (Color Space, Bit Depth, Channels, and DPI) along with acquisition hardware data (Device Manufacturer, Model, Processing Software, and GPS Coordinates).
   * **Platform Optimization Summarization**: Displays stripped metadata as standard platform-optimized outputs rather than suspicious tampering indicators.

---

## Processing Flow

**Step-by-step from upload to completed result:**

1. **Client** sends `POST /api/v1/upload` with a multipart form containing an `image` field.

2. **Multer** buffers the file in memory (max 10MB). Files exceeding the limit are rejected immediately with `413 FILE_TOO_LARGE`.

3. **MIME Type Pre-filter**: Multer's `fileFilter` rejects declared types not in `[image/jpeg, image/png, image/webp]`.

4. **Magic Byte Check**: `file-type` reads the buffer's first bytes to detect the actual format. A `.php` file renamed to `.jpg` is caught here (`415 UNSUPPORTED_FILE_TYPE`).

5. **Integrity Check**: `sharp(buffer).stats()` attempts a full decode. Corrupt or truncated files throw, returning `422 CORRUPT_IMAGE`.

6. **Persist**: File buffer written to `/uploads/{uuid}.{ext}` via `StorageProvider.save()`.

7. **DB Insert**: `image_jobs` row created with `status='pending'`.

8. **Enqueue**: BullMQ job pushed to `"image-analysis"` queue with `{ jobId, filePath, originalName, mimeType, fileSize }`.

9. **API Returns** `202 Accepted` with `{ jobId, status: "pending", message }`.

10. **Worker Picks Up Job**: BullMQ worker consumes the job (concurrency: 3).

11. **Status → 'processing'**: `image_jobs.status` updated immediately.

12. **File Existence Check**: If the file was deleted between upload and pickup, the job is marked `failed` immediately (no retry — file won't come back).

13. **6 Checks Run Concurrently** via `Promise.allSettled`:
    - `blur_detection` — Laplacian variance on grayscale pixels
    - `brightness_analysis` — Mean luminance, thresholds at 40 and 220
    - `duplicate_detection` — dHash computed, compared against last 1000 hashes
    - `screenshot_detection` — EXIF + aspect ratio + Sobel edge density (2/3 vote)
    - `ocr_plate_detection` — Tesseract PSM 11, regex matched against Indian plate patterns
    - `dimension_validation` — Width/height/aspect from image metadata header

14. **Results Saved**: One `analysis_results` row inserted per check.

15. **Quality Score Computed**: `Σ(check.confidence × weight)` for passed checks only.

16. **Status → 'completed'**: `image_jobs` updated with `quality_score`, `processed_at`.

17. **Client Polls**: `GET /api/v1/jobs/{jobId}/results` returns the full result when status is `completed`.

---

## Queue Strategy

### Why BullMQ over alternatives?

| Feature | BullMQ | AWS SQS | RabbitMQ | In-memory |
|---|---|---|---|---|
| **Local dev** | ✓ Redis only | ✗ AWS account needed | ✓ but heavy | ✓ |
| **Persistence** | ✓ Redis AOF | ✓ | ✓ | ✗ lost on crash |
| **Job state inspection** | ✓ Bull Board UI | ✗ limited | ✓ management UI | ✗ |
| **Delayed/scheduled jobs** | ✓ native | ✓ | ✓ plugin | ✗ |
| **Retry + backoff** | ✓ built-in | ✓ | ✓ | manual |
| **TypeScript types** | ✓ first-class | partial | partial | manual |
| **Priority queues** | ✓ | ✗ | ✓ | ✗ |

BullMQ's tight Redis integration also means zero additional infrastructure beyond what the app already uses. SQS would require AWS credentials and network round-trips; RabbitMQ adds operational complexity; in-memory queues lose jobs on restart.

### How Retries Work

```
Job fails (throws Error)
        │
        ├── AppError.isFatal = true (corrupt file, missing file)
        │         └── BullMQ marks as FAILED immediately
        │             DB status → 'failed', failureReason set
        │             No retry consumed
        │
        └── Any other Error (DB unavailable, network blip)
                  └── BullMQ waits exponential backoff:
                      Attempt 1 failed → wait 2s
                      Attempt 2 failed → wait 4s
                      Attempt 3 failed → wait 8s → FAILED
                                         DB status → 'failed'
```

**What triggers retry:** DB connection errors, file I/O errors, network timeouts.

**What does NOT retry:** Corrupt files, missing files, validation failures — retrying would never succeed and just wastes queue capacity.

### Concurrency Settings

- **`concurrency: 3`**: Each job takes 5–30s (OCR is the bottleneck). Three concurrent jobs keeps CPU busy without starving the API process on a 4-core server. At 10k uploads/day (~7/minute average), 3 workers comfortably handle bursts up to ~18/minute.
- **`attempts: 3`**: One attempt + two retries. Three total attempts balances reliability vs. queue-clog from permanently broken jobs.
- **`removeOnComplete/Fail: false`**: Job metadata retained in Redis for 7 days, enabling the Bull Board dashboard and post-mortem analysis.

---

## Design Decisions

### 1. dHash over MD5/SHA256 for duplicate detection
Cryptographic hashes change entirely with any re-encoding. The same photo saved at JPEG quality 95 vs 90 produces completely different SHA256 values. `dHash` (difference hash) generates a 64-bit fingerprint based on pixel gradients in a 9×8 downscaled version — similar images have similar hashes. Hamming distance < 10 bits (of 64) reliably catches re-saves, slight crops, and compression at different quality levels.

### 2. Promise.allSettled over Promise.all in the worker
`Promise.all` short-circuits on the first rejection. One crashing check (e.g., Tesseract failing on a malformed font) would silently discard all other check results. `Promise.allSettled` waits for all promises regardless of individual failures, allowing partial results to be saved and the specific failing check to be flagged.

### 3. Memory storage in Multer, not disk storage
Multer's disk storage writes the file before validation. Saving a corrupt 10MB file to disk only to delete it immediately is wasteful and creates a TOCTOU window. Memory storage lets us validate (magic bytes + Sharp decode) then atomically write only valid files.

### 4. Separate API and Worker processes
Node.js is single-threaded. CPU-intensive Sharp convolutions and Tesseract OCR block the event loop. Running the worker as a separate process (separate `npm run dev:worker` or separate Docker container) ensures the API remains responsive during analysis. It also enables independent scaling: deploy 1 API replica and 5 worker replicas under load.

### 5. StorageProvider abstraction from day 1
The local filesystem works for a single server but breaks with horizontal scaling (multiple API instances can't share `/uploads`). By implementing a `StorageProvider` interface immediately, swapping to S3 requires only a new class — no call-site changes. The interface is simple: `save`, `read`, `delete`, `exists`.

### 6. PostgreSQL ENUM over VARCHAR + CHECK constraint for status
A real Postgres ENUM (`job_status`) is stored as an OID internally — smaller than VARCHAR. More importantly, it's self-documenting in `pg_type` and generates better error messages on constraint violations. The trade-off is that adding a new status value requires `ALTER TYPE`, but statuses are stable by design.

### 7. Tesseract PSM 11 (sparse text) over PSM 6 (uniform block)
PSM 6 assumes a single uniform block of text (like a document). Number plates appear at arbitrary positions and sizes within vehicle photos. PSM 11 (sparse text) tells Tesseract to find text anywhere without assuming reading order — far better recall for plates at the cost of more false-positive OCR tokens, which are filtered by the regex.

### 8. Heuristic voting (2/3) for screenshot detection, not a single signal
No single heuristic is reliable alone. EXIF Software tags can be stripped by editors. 16:9 aspect ratios appear in some camera photos. Edge density varies by scene. Requiring 2 of 3 independent signals significantly reduces both false positives (a 16:9 photo not flagged as screenshot) and false negatives (screenshot without EXIF that has high edge density).


## Trade-offs & Future Improvements

### Intentionally simplified for MVP
- **No auth**: The upload and status endpoints are unauthenticated. Production needs API keys or JWT.
- **No rate limiting**: A user could DDoS the upload endpoint. Add `express-rate-limit`.
- **Tesseract runs on CPU**: OCR takes 10–30s per image. Production should use dedicated OCR service or GPU-accelerated Tesseract.
- **Duplicate detection looks at only 1000 recent images**: Linear scan. At scale, use a vector database or LSH index.
- **Local storage only**: Shared volume in Docker Compose works locally but not across multi-host deployments.

### What would be added with 2 more days
1. **API key authentication** with per-key rate limits
2. **Webhook support**: `POST /api/v1/upload?webhook=https://…` — notify clients when job completes
3. **S3 storage provider** implementation
4. **Job priority**: Premium users get `priority: 1`, free tier `priority: 10`
5. **Metrics**: Prometheus endpoint at `/metrics` for job throughput, check pass rates, queue depth
6. **Integration tests**: Supertest-based tests with a real PostgreSQL test database
7. **OWASP file upload hardening**: Strip EXIF from uploaded files, randomise paths further

### Scalability concerns at 10k uploads/day
- **OCR is the bottleneck**: Tesseract on CPU takes 10–30s. Need to either run more worker replicas or switch to cloud OCR (Google Vision API: ~200ms).
- **Redis memory**: With `removeOnComplete: false` and job history retained 7 days, Redis holds ~10k × 7 = 70k job records. At ~1KB each, that's 70MB — fine. At 10× scale, set `removeOnComplete: { count: 1000, age: 86400 }`.
- **PostgreSQL**: 10k jobs/day = ~60k `analysis_results` rows/day. With proper indexes, PostgreSQL handles this easily up to ~100M rows. Add read replicas for status polling at high fan-out.
- **Storage**: 10k × avg 3MB = 30GB/day. Local disk fills in days. S3 is required.
- **Worker crashes leave jobs in 'processing'**: Need a stuck-job reaper cron that resets jobs stuck in `processing` for > 5 minutes back to `pending`.

### Failure handling gaps
- **No dead-letter alerting**: Failed jobs currently sit in Redis. Need Slack/PagerDuty notification on job failure threshold.
- **No circuit breaker**: If the database is down, every job fails immediately without backoff at the DB call level.
- **File orphan risk**: If the API crashes after `storage.save()` but before `insertImageJob()`, an orphaned file stays in `/uploads`. A periodic cleanup job comparing DB records to filesystem would fix this.

---

## Crucial Architectural Assumptions Made

To deliver a system optimized for **real-world, messy field uploads** rather than generic metric baselines, the following assumptions were made:

1. **Non-Punitive EXIF Metadata Headers**:
   * *Assumption*: Platform-processed uploads (WhatsApp, CDN compressions, browser downloads) frequently strip EXIF headers.
   * *Design choice*: Treated missing EXIF as neutral evidence rather than absolute proof of tampering. The authenticity score depends strictly on screenshot heuristics, edge anomalies, and software signature parsing, protecting compression-optimized images.

2. **Positional Character Misread Swaps**:
   * *Assumption*: Standard characters on Indian vehicle plates commonly result in consistent OCR swaps (`O` ➔ `0`, `I` ➔ `1`) depending strictly on their position in the sequence.
   * *Design choice*: Implemented layout-aware position correction blocks before evaluating regex patterns, securing extremely high recall for visually clear but character-confused plates.

3. **Visual Quality vs. Regex Accuracy Isolation**:
   * *Assumption*: Visually perfect plates might contain dirt or perspective angles that result in incomplete regex string extraction (e.g., 9 digits instead of 10).
   * *Design choice*: Separated *OCR Reliability* from *Visual Quality* and *Human Auditing Usability*. Partial registration strings are labeled `mostly_readable` or `extraction_uncertain` with a recommendation of `manual_review_recommended` instead of failing the verification score.

4. **Horizontal Geometry Aspect Ratio Filtering**:
   * *Assumption*: License plates have distinct horizontal rectangular shapes that can be localized without heavy machine learning.
   * *Design choice*: Scanning focused on regions with horizontal aspect ratios strictly between **2.5 and 6.5** within bottom-center coordinates, minimizing processing overhead while eliminating noisy background interference.

---

## Running Locally

### Prerequisites
- Node.js 20+
- PostgreSQL 14+ running locally
- Redis 7+ running locally
- `jq` (for test script)

### Step 1: Clone and Install

```bash
git clone https://github.com/Vikash9546/Intelligent_media.git
cd Intelligent_media
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
# Edit .env with your PostgreSQL and Redis credentials
```

### Step 3: Create the Database

```bash
psql -U postgres -c "CREATE DATABASE media_pipeline;"
```

### Step 4: Run Migrations

```bash
npm run migrate
```

### Step 5: Start Redis

```bash
redis-server
# or: brew services start redis
```

### Step 6: Start the API Server

```bash
npm run dev
# Server starts at http://localhost:3000
# Bull Board dashboard at http://localhost:3000/admin/queues
```

### Step 7: Start the Worker (separate terminal)

```bash
npm run dev:worker
```

### Step 8: Run the Test Suite

```bash
chmod +x test.sh
./test.sh
```

---

## Sample API Requests & Responses

### 1. Upload Vehicle Image
* **Request**:
  `POST /api/v1/upload` (Form-Data)
  * Header: `Content-Type: multipart/form-data`
  * Body Param: `image` (binary file buffer, max 10MB)
* **Sample curl**:
  ```bash
  curl -X POST http://localhost:3000/api/v1/upload \
    -F "image=@/path/to/vehicle.jpg"
  ```
* **Response (`202 Accepted`)**:
  ```json
  {
    "jobId": "87c4f4a3-7649-410a-b328-98e90ffba1cd",
    "status": "pending",
    "message": "Image accepted and queued for analysis."
  }
  ```
* **Error Response (`415 Unsupported Media Type` for non-images)**:
  ```json
  {
    "error": "Unsupported Media Type",
    "message": "Invalid file signature. Only JPEG, PNG, and WEBP image uploads are supported.",
    "statusCode": 415
  }
  ```

### 2. Check Job Status
* **Request**:
  `GET /api/v1/jobs/:jobId/status`
* **Sample curl**:
  ```bash
  curl http://localhost:3000/api/v1/jobs/87c4f4a3-7649-410a-b328-98e90ffba1cd/status
  ```
* **Response (`200 OK`)**:
  ```json
  {
    "id": "87c4f4a3-7649-410a-b328-98e90ffba1cd",
    "status": "completed",
    "processedAt": "2026-05-17T10:06:12.454Z"
  }
  ```

### 3. Retrieve Trust Results
* **Request**:
  `GET /api/v1/jobs/:jobId/results`
* **Sample curl**:
  ```bash
  curl http://localhost:3000/api/v1/jobs/87c4f4a3-7649-410a-b328-98e90ffba1cd/results
  ```
* **Response (`200 OK`)**:
  ```json
  {
    "id": "87c4f4a3-7649-410a-b328-98e90ffba1cd",
    "originalFilename": "vehicle.jpg",
    "qualityScore": 94,
    "status": "completed",
    "results": {
      "blur_detection": { "passed": true, "details": { "variance": 145.2, "isBlurry": false } },
      "exposure_analysis": { "passed": true, "details": { "meanLuminance": 112.4, "isOverexposed": false, "isUnderexposed": false } },
      "duplicate_detection": { "passed": true, "details": { "isDuplicate": false, "matchCount": 0 } },
      "screenshot_detection": { "passed": true, "details": { "score": 0, "isScreenshot": false } },
      "tampering_detection": { "passed": true, "details": { "hasTamperingSignatures": false } },
      "ocr_plate_detection": {
        "passed": true,
        "confidence": 0.94,
        "details": {
          "detectedPlates": ["RJ19UC7034"],
          "partialMatches": ["RJ19UC7034"],
          "bestOcrConfidence": 0.96,
          "perceptualLabels": {
            "readability": "clearly_readable",
            "extractionQuality": "High",
            "humanPerceptionScore": 0.95
          }
        }
      }
    },
    "trustAssessment": {
      "trustScore": 95,
      "trustLevel": "Highly Trusted",
      "recommendation": "Verification Approved",
      "summary": ["High focus quality", "Authentic mobile capture"],
      "uncertaintyFlags": [],
      "isAuthentic": true,
      "dimensions": {
        "visualQuality": 96,
        "ocrReliability": 94,
        "authenticityConfidence": 95,
        "workflowIntegrity": 100,
        "operationalUsability": 96
      }
    }
  }
  ```
* **Error Response (`409 Conflict` before completion)**:
  ```json
  {
    "error": "Conflict",
    "message": "Job analysis is still in progress. Please check back later.",
    "statusCode": 409
  }
  ```

### 4. Retrieve Failure Details
* **Request**:
  `GET /api/v1/jobs/:jobId/failure`
* **Sample curl**:
  ```bash
  curl http://localhost:3000/api/v1/jobs/87c4f4a3-7649-410a-b328-98e90ffba1cd/failure
  ```
* **Response (`200 OK` for failed job)**:
  ```json
  {
    "id": "87c4f4a3-7649-410a-b328-98e90ffba1cd",
    "failedAt": "2026-05-17T10:06:14.124Z",
    "errorType": "FATAL_ANALYSIS_ERROR",
    "message": "Image dimension check failed: Uploaded image exceeds supported 4:3 or 16:9 operational aspect parameters."
  }
  ```

### 5. Health Check
* **Request**:
  `GET /health`
* **Sample curl**:
  ```bash
  curl http://localhost:3000/health
  ```
* **Response (`200 OK`)**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-05-17T10:06:15.824Z"
  }
  ```

---

## Docker Setup

Follow these simple steps to download, install, and run the entire application stack:

### Step 1: Download & Install Docker
Make sure Docker Desktop is installed and running on your system:
* **[Download Docker Desktop](https://www.docker.com/products/docker-desktop/)**

### Step 2: Clone the Repository
Clone the project repository to your local machine:
```bash
git clone https://github.com/Vikash9546/Intelligent_media.git
```

### Step 3: Change to the Root Directory
Navigate into the root directory of the cloned project:
```bash
cd Intelligent_media
```

### Step 4: Run the Application Stack
Build and spin up the complete local full-stack environment (Frontend, API Server, Worker, PostgreSQL, and Redis):
```bash
docker compose up --build
```

---

### Localhost Access URLs

Once all containers are successfully started, you can access the application at the following local URLs:

* **Frontend Dashboard (Web App UI):** [http://localhost:5173](http://localhost:5173)
* **API Server Health Endpoint:** [http://localhost:3000/health](http://localhost:3000/health)
* **BullMQ Admin Dashboard:** [http://localhost:3000/admin/queues](http://localhost:3000/admin/queues)

---

## Project Structure

This monorepo is cleanly separated into two primary independent directories for the verification service backend and visual frontend:

### 🖥️ 1. Verification Service Backend (`backend/`)

```
backend/
├── src/
│   ├── server.ts              ← API entry point (starts Express, runs migrations)
│   ├── worker.ts              ← Worker entry point (starts BullMQ worker)
│   ├── api/
│   │   ├── app.ts             ← Express app factory
│   │   ├── upload.ts          ← POST /api/v1/upload handler
│   │   ├── jobs.ts            ← Status, results, failure, list handlers
│   │   └── errorHandler.ts    ← Global error middleware
│   ├── queue/
│   │   ├── producer.ts        ← BullMQ queue + enqueue function
│   │   └── consumer.ts        ← BullMQ worker + job processor
│   ├── analysis/
│   │   ├── types.ts           ← CheckResult interface
│   │   ├── index.ts           ← Orchestrator (runs all checks concurrently)
│   │   ├── blurDetection.ts   ← Laplacian variance focus checker
│   │   ├── brightnessAnalysis.ts  ← Mean luminance and over/under exposure limits
│   │   ├── duplicateDetection.ts  ← dHash + Hamming distance matching
│   │   ├── screenshotDetection.ts ← EXIF + aspect ratio + Sobel edges heuristics
│   │   ├── ocrPlateDetection.ts   ← 5-pass aspect-filtered localized OCR engine
│   │   ├── tamperingDetection.ts  ← Image manipulation and compression variance signatures
│   │   ├── trustEngine.ts     ← 5-dimensional trust calibration scoring framework
│   │   └── dimensionValidation.ts ← Metadata read, dimension/ratio validations
│   ├── db/
│   │   ├── pool.ts            ← PostgreSQL connection pool singleton
│   │   ├── migrate.ts         ← Sequential migration runner
│   │   └── models.ts          ← Typed query model layer
│   ├── storage/
│   │   └── provider.ts        ← StorageProvider interface + LocalStorageProvider
│   └── utils/
│       ├── logger.ts          ← Pino structured logger
│       ├── errors.ts          ← AppError hierarchy (fatal vs transient)
│       └── constants.ts       ← All thresholds + weights (documented)
├── tsconfig.json              ← Backend TypeScript configuration
├── package.json               ← Dependencies & scripts
└── Dockerfile                 ← API & Worker multi-stage builder
```

### 2. Visual Operational Frontend (`frontend/`)

```
frontend/
├── src/
│   ├── main.jsx               ← Vite Client entry point (React JSX)
│   ├── App.jsx                ← UI page routing & providers
│   ├── index.css              ← Color Tokens, Material design utilities
│   ├── components/            ← Shared custom UI building blocks
│   ├── pages/                 ← Functional application pages
│   │   ├── Upload.jsx         ← Dynamic drag-drop visual upload portal
│   │   ├── Jobs.jsx           ← Historical list of verification audits
│   │   └── JobResults.jsx     ← Multi-dimensional trust calibration dashboard
│   └── utils/                 ← Client side utility helpers
│       ├── analysisAdapter.js ← Dynamic model parsing and DTO formatting
│       ├── analysisHelpers.js ← Interpretation wordings & score maps
│       └── renderHelpers.jsx  ← Icon mappings & Tailwind/Material styles
├── index.html                 ← Application index layout
├── vite.config.js             ← Vite dev server & bundling rules (React ES Modules)
├── tailwind.config.js         ← Custom Tailwind / CSS definitions
└── Dockerfile                 ← Production Nginx build pipeline
```

---

## AI Usage Disclosure

### 1. Where AI Was Used
AI assistance was utilized globally across both the backend analysis modules and the frontend visual indicators in this repository. Specifically:
* **Backend OCR Pipeline**: Refactoring Tesseract processing into a 5-pass localized pipeline with aspect-ratio window grid calculations.
* **Calibrated Trust Scoring**: Fusing multi-dimensional visual and integrity scoring parameters (`trustEngine.ts`).
* **Frontend UI Adapter**: Constructing standard mapping adapter schemas to cleanly translate and interpret backend signals (`analysisAdapter.ts`).
* **EXIF Metadata Parsing**: Extracting camera-specific GPS/device parameters and presenting them inside custom visual indicators.

### 2. What AI Helped With
* **Algorithmic Optimizations**: Designing the sliding-window rectangular block search in `findPlateCandidates` matching localized aspects (2.5–6.5).
* **Positional Layout Scanners**: Crafting the positional swap normalization filters (e.g., `O` ➔ `0` in Indian plate districts and sequence codes).
* **Strict Type Safety**: Formatting complex Express/TypeScript type signatures across the queue worker and model queries.

### 3. Where AI Output Was Wrong
* **Aggressive Hard Constraints**: AI initially generated strict `isProgressive` and `DPI` properties on the generic DTO models, which triggered TypeScript compilation errors as they weren't matched in the backend types. We resolved this by dynamically targeting `hasProfile` and encapsulating secondary features exclusively in the diagnostics panel.
* **Uncertain Authenticity Scoring**: Initial AI logic attempted to lower authenticity scores when camera EXIF properties were missing, causing visually clear and secure compressed uploads to fail trust checks. This was corrected to keep missing EXIF neutral, shifting the focus of the authenticity engine onto edge anomalies, screenshots, and manipulation heuristics.

### 4. How We Validated AI-Generated Code
* **Local Sandbox Compilation**: Continuous verification using local TypeScript syntax checking (`npm run build` / `npm run typecheck`).
* **Docker Multi-Container Verification**: Run active end-to-end recreation tasks (`docker-compose up -d --build`) to verify inter-service database migration stability, BullMQ concurrency, and Nginx rendering.
* **Fuzzy Assertions**: Running simulated mock extractions representing complex blurred registration digits (e.g., `RJ19UC7O34` spacing variants) to confirm character recall.
