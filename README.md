# storytovideo

Automated pipeline that converts text stories into fully produced short videos with AI-generated visuals, cinematic shot planning, and assembled final output with subtitles and transitions.

## Prerequisites

- **Node.js 20+**
- **npm**
- **ffmpeg** and **ffprobe** installed and on PATH
- API keys for at least some of the supported AI services (see [Environment Variables](#environment-variables))

## Setup

1. Clone the repository:

```bash
git clone https://github.com/spullara/storytovideo.git
cd storytovideo
```

2. Install dependencies for both the backend and the web UI:

```bash
npm install
cd web-ui && npm install && cd ..
```

3. Create a `.env` file in the project root with your API keys:

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...
XAI_API_KEY=xai-...
REVE_API_KEY=...
```

See [Environment Variables](#environment-variables) for the full list.

## Building

Compile the TypeScript backend:

```bash
npm run build        # runs tsc, outputs to dist/
```

Build the React web UI for production:

```bash
cd web-ui
npm run build        # type-checks then runs vite build, outputs to web-ui/dist/
```

Type-check without emitting files:

```bash
npm run typecheck              # backend
cd web-ui && npm run typecheck # web UI
```

## Running

Start the queue server (runs the backend and serves the web UI):

```bash
npm run dev
# or equivalently:
npx tsx src/queue/queue-server.ts
```

The server starts on port 3000 by default. Open http://localhost:3000 to access the web UI.

For web UI development with hot reload, run the Vite dev server in a second terminal:

```bash
cd web-ui
npm run dev          # starts on port 5173, proxies API calls to port 3000
```

## How It Works

The application takes a text story as input and produces a video through a multi-stage pipeline. Each stage runs as a work item in a queue-based system with three parallel processing lanes (LLM, Image, Video).

```
Story Text
    ↓
[1] Story to Script (optional) — Rewrites prose into filmable scenes
    ↓
[2] Story Analysis — Extracts characters, locations, objects, scenes
    ↓
[3] Asset Generation — Creates reference images for characters/locations/objects
    ↓
[4] Shot Planning — Plans cinematic shots for each scene
    ↓
[5] Frame Generation — Generates keyframe images for each shot
    ↓
[6] Video Generation — Produces video clips from keyframes
    ↓
[7] Assembly — Concatenates clips with transitions, subtitles, and audio
    ↓
Final MP4 Video
```

### Pipeline Stages

**Story to Script** (optional) converts narration-heavy prose into visual, filmable scenes using Claude. It adds dialogue, action, and sensory details.

**Story Analysis** uses Claude with Zod-validated structured output to extract a title, art style, characters (with physical descriptions), locations, objects, and numbered scenes. Real celebrity names are automatically replaced with fictional names.

**Asset Generation** creates reference images for each character (front-facing, 1:1 aspect ratio), location (at the run's aspect ratio), and object using Reve or Grok image generation.

**Shot Planning** produces detailed cinematic shot descriptions for each scene — composition type, start/end frame prompts, action prompt, dialogue, camera direction, duration, and transitions. Enforces cinematic rules: one camera setup per shot, dialogue paced at ~2.5 words/sec.

**Frame Generation** creates keyframe images for each shot using reference images from the asset library plus continuity references from adjacent shots.

**Video Generation** turns keyframes into video clips using one of three backends:
- **Veo 3.1** (Google) — First+last frame interpolation, fixed 8s duration
- **ComfyUI** — Custom workflow via remote API, arbitrary durations
- **Grok** (xAI) — Start frame + action prompt, 1–15s duration, 720p

**Assembly** concatenates clips using ffmpeg with resolution normalization, scene transitions (cuts or fade-to-black), soft subtitles (SRT), and optional audio overlay.

### Import Pipeline

An alternative entry point that works backwards from an existing video: split the video into clips using ffmpeg scene detection, analyze each clip's frames with Gemini Flash, then reconstruct the full story metadata with Claude.

### Queue System

Three parallel processing lanes with two priority levels each:
- **LLM queue** — Story analysis, shot planning, assembly
- **Image queue** — Asset generation, frame generation
- **Video queue** — Video clip generation

Work items form a dependency graph (DAG). The system supports redo with automatic cascade to downstream items, retry of failed items, cancel via AbortController, pause/resume with state persistence, and automatic seeding of downstream items as upstream items complete.

### Web UI

A React + Vite + Zustand single-page app with these views:
- **Queues** — Work items grouped by queue with status indicators
- **Graph** — Dependency graph visualization
- **Story** — Story analysis and shot plan viewer
- **Video** — Final assembled video player
- **Analyze** — Human-in-the-loop video review with Gemini analysis

Supports creating runs, play/pause, redo/retry/cancel on individual items, and real-time SSE updates.

### REST API

The server exposes a REST API for programmatic access:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/runs` | Create a new run (story text + options) |
| `GET` | `/api/runs` | List all runs |
| `GET` | `/api/runs/:id` | Run details with queue state |
| `GET` | `/api/runs/:id/queues` | Queue snapshots by status |
| `GET` | `/api/runs/:id/graph` | Dependency graph (nodes + edges) |
| `GET` | `/api/runs/:id/events` | SSE stream with event replay |
| `GET` | `/api/runs/:id/media/**` | Serve generated files (range requests supported) |
| `POST` | `/api/runs/:id/items/:itemId/redo` | Redo item (cascades to dependents) |
| `POST` | `/api/runs/:id/items/:itemId/retry` | Retry failed item |
| `POST` | `/api/runs/:id/items/:itemId/cancel` | Cancel in-progress item |
| `POST` | `/api/runs/:id/stop` | Pause the run |
| `POST` | `/api/runs/:id/resume` | Resume a paused run |
| `DELETE` | `/api/runs/:id` | Delete a run |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `GOOGLE_API_KEY` | Yes | Google API key for Gemini and Veo |
| `XAI_API_KEY` | For Grok backend | xAI API key for Grok image/video |
| `REVE_API_KEY` | For Reve backend | Reve API key for image generation |
| `VIDEO_BACKEND` | No | Default video backend: `veo`, `comfy`, or `grok` |
| `COMFY_API_BASE` | For ComfyUI | ComfyUI server URL |
| `COMFY_API_KEY` | For ComfyUI | ComfyUI API key |
| `QUEUE_SERVER_PORT` | No | HTTP server port (default: `3000`) |
| `STORYTOVIDEO_RUN_DB_DIR` | No | Run database directory (default: `./output/api-server`) |
| `STORYTOVIDEO_RUN_OUTPUT_ROOT` | No | Run output root (default: `./output/runs`) |

## Project Structure

```
src/
├── types.ts                       Core type definitions (Shot, Scene, StoryAnalysis)
├── google-client.ts               Google GenAI SDK client singleton
├── grok-client.ts                 xAI Grok video generation client
├── grok-image-client.ts           xAI Grok image generation/remix client
├── reve-client.ts                 Reve image generation/remix client
├── comfy-client.ts                ComfyUI workflow client
├── import-orchestrator.ts         Reverse pipeline (video → metadata)
├── tools/
│   ├── story-to-script.ts         Raw story → visual script conversion
│   ├── analyze-story.ts           Story → structured StoryAnalysis
│   ├── plan-shots.ts              Scene → cinematic shot plan
│   ├── generate-asset.ts          Character/location/object reference images
│   ├── generate-frame.ts          Shot keyframe generation with references
│   ├── generate-video.ts          Video clip generation (Veo/ComfyUI/Grok)
│   ├── assemble-video.ts          Final video assembly with transitions/subtitles
│   ├── analyze-video-pacing.ts    Post-generation pacing optimization
│   ├── analyze-shots.ts           Vision-based shot analysis (import pipeline)
│   ├── reverse-engineer-metadata.ts  Reconstruct StoryAnalysis from shots
│   ├── split-video.ts             Scene detection and video splitting
│   └── state.ts                   Pipeline state persistence
└── queue/
    ├── types.ts                   Queue system types (WorkItem, RunState)
    ├── queue-manager.ts           Work item management, dependencies, redo/versioning
    ├── queue-server.ts            HTTP server with REST API and SSE
    ├── processors.ts              Queue processors with downstream seeding logic
    └── run-manager.ts             Multi-run lifecycle management

web-ui/
├── src/
│   ├── App.tsx                    Router and layout
│   ├── stores/                    Zustand stores (pipeline, run, UI state)
│   ├── components/                Shared components (TopBar, DetailPanel, etc.)
│   └── views/                     Page views (Queue, Graph, Story, Video, Analyze)
├── vite.config.ts                 Vite config with API proxy
└── package.json
```

## Key npm Dependencies

| Package | Purpose |
|---------|---------|
| `ai` + `@ai-sdk/anthropic` | Vercel AI SDK for structured Claude output |
| `@google/genai` | Google GenAI SDK (Gemini + Veo) |
| `zod` | Schema validation for structured AI output |
| `sharp` | Image processing and aspect ratio padding |
| `dotenv` | Environment variable management |
| `react` + `react-dom` | Web UI framework |
| `zustand` | State management for the web UI |
| `vite` | Web UI bundler and dev server |

## Troubleshooting

**"ffmpeg not found"** — Install ffmpeg: `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Linux).

**API rate limits (429)** — The pipeline retries automatically with backoff. Veo has a 30-second cooldown between calls.

**Blank or failing video generation** — Check that the appropriate `VIDEO_BACKEND` environment variable is set and the corresponding API key is configured.

**Web UI not loading** — Make sure you've built the web UI (`cd web-ui && npm run build`) or are running the Vite dev server (`cd web-ui && npm run dev`).

## License

MIT
