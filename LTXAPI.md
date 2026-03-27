# LTX Video 2.3 API

All endpoints except `/health` require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <LTX_API_KEY>
```

The API key is stored in `.env` as `LTX_API_KEY`.

## Endpoints

### POST /generate

Submit a video generation job. Jobs are queued and processed one at a time.

Accepts `application/json` or `multipart/form-data` (required when uploading an image).

#### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | **yes** | — | Text description of the video |
| `image` | file | no | — | Input image for image-to-video (multipart only) |
| `mode` | string | no | `"full"` | `"full"` (30 steps, guided) or `"distilled"` (8 steps, fast) |
| `seconds` | float | no | `5.0` | Video duration in seconds |
| `width` | int | no | `768` | Video width (rounded to nearest multiple of 32) |
| `height` | int | no | `512` | Video height (rounded to nearest multiple of 32) |
| `seed` | int | no | `42` | Random seed for reproducibility |
| `negative_prompt` | string | no | built-in | Negative prompt (full mode only) |
| `frame_rate` | float | no | `24.0` | Frames per second |

**Notes:**
- When an image is provided, its dimensions are used unless `width`/`height` are explicitly set.
- Resolution is capped at 768×1408 total pixels. Larger inputs are scaled down proportionally.
- Frame count is adjusted to satisfy the model constraint of `8k + 1` frames (e.g. 9, 17, 25, ..., 121).
- Distilled mode is ~3-4x faster than full mode with comparable quality.

#### Examples

**Text-to-video (JSON):**

```bash
curl -X POST http://localhost:8080/generate \
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
curl -X POST http://localhost:8080/generate \
  -H "Authorization: Bearer $LTX_API_KEY" \
  -F "prompt=A woman smiles and waves at the camera" \
  -F "image=@portrait.png" \
  -F "mode=distilled" \
  -F "seconds=6"
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

---

### GET /status/:job_id

Poll for job status.

```bash
curl http://localhost:8080/status/1b8adfaf-2bad-4c7a-a062-22deb0936496 \
  -H "Authorization: Bearer $LTX_API_KEY"
```

#### Response

```json
{
  "job_id": "1b8adfaf-2bad-4c7a-a062-22deb0936496",
  "status": "completed",
  "created_at": 1774630569.87,
  "started_at": 1774630569.87,
  "completed_at": 1774630642.65,
  "generation_time": 72.8,
  "params": "distilled",
  "video_url": "/video/1b8adfaf-2bad-4c7a-a062-22deb0936496"
}
```

**Status values:** `pending` → `running` → `completed` or `failed`

When status is `failed`, an `error` field is included with the error message.

---

### GET /video/:job_id

Download the generated MP4 video. Only available after the job status is `completed`.

```bash
curl -o output.mp4 http://localhost:8080/video/1b8adfaf-2bad-4c7a-a062-22deb0936496 \
  -H "Authorization: Bearer $LTX_API_KEY"
```

Returns `video/mp4` with `Content-Disposition: attachment`.

---

### GET /health

Health check. **No authentication required.**

```bash
curl http://localhost:8080/health
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

## Error Responses

| Status | Meaning |
|---|---|
| `401` | Missing `Authorization` header |
| `403` | Invalid API key |
| `400` | Bad request (missing prompt, invalid mode, video not ready) |
| `404` | Job not found |
| `503` | Server not initialized yet |
