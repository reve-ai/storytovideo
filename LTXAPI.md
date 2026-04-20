# LTX Video 2.3 API

**Base URL:** `http://api.revemovies.com:8080`

All endpoints except `/health` and `/test` require authentication via one of:

```
Authorization: Bearer <LTX_API_KEY>
```

or as a query parameter (for contexts like `sendBeacon` that can't set headers):

```
?key=<LTX_API_KEY>
```

## Endpoints

### POST /generate

Submit a video generation job. Jobs are queued and processed one at a time.

Accepts `application/json` or `multipart/form-data` (required when uploading an image).

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| prompt | string | yes | — | Text description of the video |
| image | file | no | — | Start frame image for image-to-video (multipart only) |
| end_image | file | no | — | End frame image — model interpolates between start and end (multipart only) |
| mode | string | no | "full" | "full" (30 steps, guided) or "distilled" (8 steps, fast) |
| seconds | float | no | 5.0 | Video duration in seconds |
| width | int | no | 768 | Video width (rounded to nearest multiple of 32) |
| height | int | no | 512 | Video height (rounded to nearest multiple of 32) |
| seed | int | no | 42 | Random seed for reproducibility |
| negative_prompt | string | no | built-in | Negative prompt (full mode only) |
| frame_rate | float | no | 24.0 | Frames per second |
| priority | string | no | "normal" | "high" or "normal" — high priority jobs run before normal ones |

**Notes:**

- When a start image is provided, its dimensions are used unless `width`/`height` are explicitly set.
- When both `image` and `end_image` are provided, the model generates a video that transitions from the start frame to the end frame.
- Resolution is capped by aspect ratio: landscape up to 1408×768, portrait up to 768×1408, square up to 1024×1024. Larger inputs are scaled down proportionally.
- Frame count is rounded up to satisfy the model constraint of `8k + 1` frames (e.g. 9, 17, 25, ..., 121).
- Distilled mode is ~3-4x faster than full mode with comparable quality.
- High priority jobs are processed before normal priority jobs. Within the same priority, jobs are processed FIFO.

#### Examples

**Text-to-video (JSON):**

```bash
curl -X POST http://api.revemovies.com:8080/generate \
  -H "Authorization: Bearer $LTX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A golden retriever running through a sunny meadow",
    "mode": "distilled",
    "seconds": 5
  }'
```

**Image-to-video (multipart):**

```bash
curl -X POST http://api.revemovies.com:8080/generate \
  -H "Authorization: Bearer $LTX_API_KEY" \
  -F "prompt=A woman smiles and waves at the camera" \
  -F "image=@portrait.png" \
  -F "mode=distilled" \
  -F "seconds=6"
```

**Start + end frame interpolation (multipart):**

```bash
curl -X POST http://api.revemovies.com:8080/generate \
  -H "Authorization: Bearer $LTX_API_KEY" \
  -F "prompt=A sunrise timelapse over the mountains" \
  -F "image=@dawn.png" \
  -F "end_image=@daylight.png" \
  -F "mode=distilled" \
  -F "seconds=5"
```

#### Response (202 Accepted)

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "pending",
  "queue_position": 1,
  "params": {
    "mode": "distilled",
    "width": 768,
    "height": 1408,
    "num_frames": 113,
    "seconds": 4.71,
    "frame_rate": 24.0,
    "has_image": false
  }
}
```

### GET /status/:job_id

Poll for job status.

```bash
curl http://api.revemovies.com:8080/status/1b8adfaf-2bad-4c7a-a062-22deb0936496 \
  -H "Authorization: Bearer $LTX_API_KEY"
```

#### Responses

**Pending (waiting in queue):**

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "pending",
  "queue_position": 2,
  "queue_size": 3
}
```

**Running (with progress):**

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "running",
  "elapsed": 45.2,
  "progress": {
    "stage": "denoising",
    "step": 15,
    "total_steps": 30
  }
}
```

Progress stages: `encoding` → `denoising` (with step/total_steps) → `decoding`

**Completed:**

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "completed",
  "generation_time": 72.8,
  "video_url": "/video/1b8adfaf-2bad-4c7a-a062-22deb0936496"
}
```

**Failed:**

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "failed",
  "error": "CUDA out of memory"
}
```

**Status values:** `pending` → `running` → `completed`, `failed`, or `cancelled`

### GET /video/:job_id

Download the generated MP4 video. Only available after the job status is `completed`.

```bash
curl -o output.mp4 http://api.revemovies.com:8080/video/1b8adfaf-2bad-4c7a-a062-22deb0936496 \
  -H "Authorization: Bearer $LTX_API_KEY"
```

Returns `video/mp4` with `Content-Disposition: attachment`.

### POST /cancel/:job_id

Cancel a pending or running job.

```bash
curl -X POST http://api.revemovies.com:8080/cancel/1b8adfaf-2bad-4c7a-a062-22deb0936496 \
  -H "Authorization: Bearer $LTX_API_KEY"
```

#### Response

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "cancelled"
}
```

**Notes:**

- Pending jobs are skipped when they reach the front of the queue.
- Running jobs abort at the next denoising step boundary (typically within 2-8 seconds).
- Already completed, failed, or cancelled jobs cannot be cancelled (returns 400).

### GET /queue

View all jobs with their status and progress. Returns JSON for API clients or an auto-refreshing HTML dashboard for browsers.

**API usage:**

```bash
curl http://api.revemovies.com:8080/queue \
  -H "Authorization: Bearer $LTX_API_KEY"
```

**Browser usage:**

```
http://api.revemovies.com:8080/queue?key=<LTX_API_KEY>
```

#### JSON Response

```json
{
  "total": 3,
  "jobs": [
    {
      "job_id": "...",
      "status": "running",
      "priority": "normal",
      "mode": "distilled",
      "prompt": "A golden retriever...",
      "width": 768,
      "height": 1408,
      "num_frames": 121,
      "stage": "denoising",
      "step": 5,
      "total_steps": 8,
      "elapsed": 32.1
    },
    {
      "job_id": "...",
      "status": "pending",
      "priority": "high",
      "mode": "full",
      "prompt": "..."
    },
    {
      "job_id": "...",
      "status": "completed",
      "video_url": "/video/...",
      "generation_time": 72.8
    }
  ]
}
```

Jobs are sorted: running first, then pending (high priority before normal), then completed/failed/cancelled by recency. The HTML view auto-refreshes every 3 seconds and includes progress bars, download links, and status badges.

### GET /health

Health check. **No authentication required.**

```bash
curl http://api.revemovies.com:8080/health
```

#### Response

```json
{
  "status": "ok",
  "pipeline_loaded": true,
  "active_jobs": 1,
  "queued_jobs": 0
}
```

### GET /test

Interactive HTML test page for the API. **No authentication required** to load the page (API key is entered in the UI and stored in browser localStorage).

```
http://api.revemovies.com:8080/test
```

Features:

- Text-to-video and image-to-video generation
- Real-time progress bar with denoising step tracking
- Live queue status indicator (polls `/health` every 5s)
- Queue position display when waiting
- Cancel button to abort pending or running jobs
- Auto-cancels active job on page close/refresh
- Inline video playback on completion
- API key persisted in browser localStorage

## Error Responses

| Status | Meaning |
| --- | --- |
| 401 | Missing Authorization header |
| 403 | Invalid API key |
| 400 | Bad request (missing prompt, invalid mode, video not ready) |
| 404 | Job not found |
| 503 | Server not initialized yet |