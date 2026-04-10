# Adobe Premiere Pro UXP API — Reference for Agents

**Premiere Pro version:** 25.3+ (2025+)
**API entry point:** `const app = require('premierepro');`
**All Premiere DOM calls are async** — use `await`. Constants: `app.Constants`.

---

## Architecture: How External Apps Talk to Premiere

UXP plugins run **inside** Premiere Pro. External apps (like storytovideo) cannot call UXP APIs directly. Communication requires a **bridge plugin** running inside Premiere that relays commands.

### Recommended Bridge Pattern (file-based polling)

Based on [premiere-pro-mcp](https://github.com/nepfaff/premiere-pro-mcp):

```
storytovideo ──HTTP/file──▶ Bridge UXP Plugin ──eval()──▶ Premiere Pro
                            (polls ~/Documents/ppro-mcp-bridge/)    (UXP API)
```

1. External app writes JS code to `~/Documents/ppro-mcp-bridge/ppro_command.json`
2. UXP plugin polls the file, `eval()`s the script in Premiere context
3. Results written to `~/Documents/ppro-mcp-bridge/ppro_result.json`
4. External app polls for and reads the result

The plugin manifest must include `"allowCodeGenerationFromStrings": true` to enable `eval()`.

### Alternative: WebSocket Bridge

UXP plugins support WebSocket. The plugin can connect to a WebSocket server run by storytovideo:

```javascript
// In UXP plugin:
const ws = new WebSocket("ws://localhost:9876");
ws.onmessage = async (event) => {
  const { id, script } = JSON.parse(event.data);
  try {
    const result = await eval(`(async () => { ${script} })()`);
    ws.send(JSON.stringify({ id, result }));
  } catch (err) {
    ws.send(JSON.stringify({ id, error: err.message }));
  }
};
```

Manifest permissions required:
```json
{
  "requiredPermissions": {
    "network": { "domains": ["ws://localhost", "wss://localhost"] }
  }
}
```

---

## Plugin Manifest (manifest.json)

```json
{
  "manifestVersion": 5,
  "id": "com.storytovideo.premiere-bridge",
  "name": "StoryToVideo Bridge",
  "version": "1.0.0",
  "main": "index.html",
  "host": { "app": "premierepro", "minVersion": "25.3.0" },
  "entrypoints": [
    { "type": "panel", "id": "mainPanel", "label": { "default": "StoryToVideo" } }
  ],
  "requiredPermissions": {
    "localFileSystem": "fullAccess",
    "network": { "domains": "all" },
    "allowCodeGenerationFromStrings": true
  }
}
```

**Loading the plugin:**
1. Install **UXP Developer Tool** (free, from Creative Cloud)
2. Open Premiere Pro
3. In UDT → Add Plugin → select `manifest.json` → Load
4. Panel appears in Premiere Pro

---

## Core API Reference

### Getting Started

```javascript
const app = require('premierepro');
const project = await app.Project.getActiveProject();
const sequence = await project.getActiveSequence();
```

### The Action/Transaction Pattern (CRITICAL)

**All mutations in Premiere UXP use Actions.** You do NOT call methods that directly mutate state. Instead:

1. Create an Action object from a `create*Action()` method
2. Execute it inside `project.lockedAccess()` + `project.executeTransaction()`

```javascript
function executeAction(project, action, undoLabel) {
  project.lockedAccess(() => {
    project.executeTransaction((compoundAction) => {
      compoundAction.addAction(action);
    }, undoLabel || "Script Action");
  });
}

// Multiple actions in one transaction:
function executeActions(project, actions, undoLabel) {
  project.lockedAccess(() => {
    project.executeTransaction((compoundAction) => {
      for (const action of actions) {
        compoundAction.addAction(action);
      }
    }, undoLabel || "Script Actions");
  });
}
```

---

## Project API

```javascript
// Static methods
const project = await app.Project.getActiveProject();
const project = await app.Project.createProject("/path/to/project.prproj");
const project = await app.Project.openProject("/path/to/project.prproj");

// Instance methods
const rootItem = await project.getRootItem();             // FolderItem (root bin)
const sequences = await project.getSequences();           // Sequence[]
const activeSeq = await project.getActiveSequence();      // Sequence | null
```

### Import Files

```javascript
const project = await app.Project.getActiveProject();
const rootBin = await app.FolderItem.cast(await project.getRootItem());

// Import files into root bin (suppressUI=true hides dialogs)
await project.importFiles(
  ["/path/to/video1.mp4", "/path/to/video2.mp4", "/path/to/audio.wav"],
  true,       // suppressUI

---

## SequenceEditor — Inserting Clips into Timeline

The `SequenceEditor` is the main API for placing clips on the timeline.

```javascript
const seq = await project.getActiveSequence();
const editor = app.SequenceEditor.getEditor(seq);

// Insert a clip (ripple edit — pushes existing clips forward)
// If videoTrackIndex > existing track count, a new track is created
const insertAction = editor.createInsertProjectItemAction(
  projectItem,        // ProjectItem to insert
  tickTime,           // TickTime — position on timeline
  0,                  // videoTrackIndex (0-based)
  0,                  // audioTrackIndex (0-based)
  false               // limitShift
);
executeAction(project, insertAction, "Insert Clip");

// Overwrite (replaces content at the target position)
const overwriteAction = editor.createOverwriteItemAction(
  projectItem, tickTime, 0, 0
);
executeAction(project, overwriteAction, "Overwrite Clip");
```

### Insert Motion Graphics Template (MOGRT)

```javascript
const trackItems = editor.insertMogrtFromPath(
  "/path/to/template.mogrt",
  app.TickTime.createWithSeconds(5.0),
  0,  // videoTrackIndex
  0   // audioTrackIndex
);
```

---

## TickTime — Time Values

All time positions use `TickTime`. Premiere uses "ticks" internally (254016000000 ticks = 1 second).

```javascript
// Construction
const t1 = app.TickTime.createWithSeconds(5.0);
const t2 = app.TickTime.createWithFrameAndFrameRate(120, app.FrameRate.createWithValue(24));
const t3 = app.TickTime.createWithTicks("1270080000000"); // string!

// Constants
app.TickTime.TIME_ZERO;
app.TickTime.TIME_ONE_SECOND;

// Properties
t1.seconds;      // number
t1.ticks;        // string
t1.ticksNumber;  // number

// Arithmetic (returns NEW TickTime, does not mutate)
const sum = t1.add(t2);
const diff = t1.subtract(t2);
const scaled = t1.multiply(2);
const half = t1.divide(2);

// Frame alignment
const aligned = t1.alignToFrame(app.FrameRate.createWithValue(24));
```

---

## Tracks & Track Items

### Video/Audio Tracks

```javascript
const videoTracks = await seq.getVideoTracks();  // VideoTrack[]
const audioTracks = await seq.getAudioTracks();  // AudioTrack[]

const track = videoTracks[0];
track.name;                      // string (readonly)
track.id;                        // number (readonly)
await track.setMute(true);
await track.isMuted();

// Get clips on a track
const clips = track.getTrackItems(
  app.Constants.TrackItemType.CLIP,  // EMPTY=0, CLIP=1, TRANSITION=2
  false                               // includeEmptyTrackItems
);
```

### Track Items (Clips on Timeline)

```javascript
const clip = clips[0]; // VideoClipTrackItem or AudioClipTrackItem

await clip.getName();                // display name
await clip.getStartTime();           // TickTime (position on sequence timeline)
await clip.getEndTime();             // TickTime
await clip.getDuration();            // TickTime
await clip.getInPoint();             // TickTime (source media in-point)
await clip.getOutPoint();            // TickTime (source media out-point)
await clip.getSpeed();               // number
await clip.isDisabled();             // boolean
await clip.getProjectItem();         // ProjectItem (source media)
await clip.getTrackIndex();          // number

// Moving/trimming clips (returns Action — must executeTransaction)
const moveAction = clip.createMoveAction(app.TickTime.createWithSeconds(2)); // shift by 2s
const setStartAction = clip.createSetStartAction(app.TickTime.createWithSeconds(10));
const setInAction = clip.createSetInPointAction(app.TickTime.createWithSeconds(1));
const setOutAction = clip.createSetOutPointAction(app.TickTime.createWithSeconds(5));
const disableAction = clip.createSetDisabledAction(true);
const renameAction = clip.createSetNameAction("New Name");
```

---

## ProjectItem & ClipProjectItem

```javascript
// Navigate bins
const rootBin = await app.FolderItem.cast(await project.getRootItem());
const children = await rootBin.getItems();  // ProjectItem[]

// Cast to ClipProjectItem for media-specific methods
const clip = app.ClipProjectItem.cast(children[0]);
clip.name;                            // string (readonly)
clip.type;                            // number (readonly)
await clip.getMediaFilePath();        // "/path/to/original/file.mp4"
await clip.isSequence();              // boolean
await clip.isOffline();               // boolean
await clip.getContentType();          // Constants.ContentType
await clip.getInPoint(app.Constants.MediaType.VIDEO);   // TickTime
await clip.getOutPoint(app.Constants.MediaType.VIDEO);  // TickTime
```

---

## Export / Encode

### EncoderManager — Full Sequence Export

```javascript
const manager = app.EncoderManager.getManager();

// Export immediately to file
await manager.exportSequence(
  sequence,                              // Sequence object
  app.Constants.ExportType.IMMEDIATELY,  // or QUEUE_TO_AME, QUEUE_TO_APP
  "/output/path/video.mp4",             // output file path
  "/path/to/preset.epr",                // Adobe Media Encoder preset file
  true                                   // exportFull (entire sequence vs. in/out range)
);

// Check if Adobe Media Encoder is installed
manager.isAMEInstalled;  // boolean
```

### Export Types
- `Constants.ExportType.IMMEDIATELY` — export now, blocking
- `Constants.ExportType.QUEUE_TO_AME` — send to Adobe Media Encoder queue
- `Constants.ExportType.QUEUE_TO_APP` — queue in Premiere's export queue

### Export Events

```javascript
app.EventManager.addEventListener(
  manager,
  app.EncoderManager.EVENT_RENDER_COMPLETE,
  (event) => { console.log("Export complete"); }
);
// Also: EVENT_RENDER_ERROR, EVENT_RENDER_CANCEL, EVENT_RENDER_PROGRESS
```

### Exporter — Single Frame Export

```javascript
await app.Exporter.exportSequenceFrame(
  sequence,
  app.TickTime.createWithSeconds(5.0),
  "frame_005.png",           // filename
  "/output/frames/",         // directory
  1920,                      // width
  1080                       // height
);
// Supports: bmp, dpx, gif, jpg, exr, png, tga, tif
```

---

## Complete Workflow: storytovideo → Premiere Pro

Here is the end-to-end workflow for importing a storytovideo movie into Premiere:

### Step 1: Generate all assets with storytovideo

storytovideo produces per-shot video files (`shot_001.mp4`, `shot_002.mp4`, ...) plus audio files and a final assembled video. The output directory structure:

```
output/
├── videos/shot_001.mp4
├── videos/shot_002.mp4
├── audio/shot_001_voiceover.wav
├── frames/shot_001_start.png
└── final_movie.mp4
```

### Step 2: UXP Bridge Plugin receives import command

The storytovideo server sends a command to the bridge plugin (via file or WebSocket) containing the import script.

### Step 3: Import Script Executed Inside Premiere

```javascript
// === FULL IMPORT SCRIPT ===
const app = require('premierepro');
const project = await app.Project.getActiveProject();
const rootBin = await app.FolderItem.cast(await project.getRootItem());

// 1. Create bins for organization
project.lockedAccess(() => {
  project.executeTransaction((ca) => {
    ca.addAction(rootBin.createBinAction("Video Clips", true));
    ca.addAction(rootBin.createBinAction("Audio", true));
  }, "Create Bins");
});

// 2. Import all media files
const videoFiles = [
  "/absolute/path/to/output/videos/shot_001.mp4",
  "/absolute/path/to/output/videos/shot_002.mp4",
  "/absolute/path/to/output/videos/shot_003.mp4",
];
const audioFiles = [
  "/absolute/path/to/output/audio/shot_001_voiceover.wav",
  "/absolute/path/to/output/audio/shot_002_voiceover.wav",
];

// Find the bins we just created
const children = await rootBin.getItems();
let videoBin, audioBin;
for (const child of children) {
  if (child.name === "Video Clips") videoBin = await app.FolderItem.cast(child);
  if (child.name === "Audio") audioBin = await app.FolderItem.cast(child);
}

await project.importFiles(videoFiles, true, videoBin, false);
await project.importFiles(audioFiles, true, audioBin, false);

// 3. Create sequence from first clip (inherits resolution/framerate)
const videoItems = await videoBin.getItems();
const seq = await project.createSequenceFromMedia("StoryToVideo Movie", [videoItems[0]]);

// 4. Add remaining clips sequentially on the timeline
const editor = app.SequenceEditor.getEditor(seq);
let currentTime = (await videoItems[0].getOutPoint(app.Constants.MediaType.VIDEO));

for (let i = 1; i < videoItems.length; i++) {
  const insertAction = editor.createInsertProjectItemAction(
    videoItems[i],
    currentTime,
    0,  // video track 0
    0,  // audio track 0
    false
  );
  project.lockedAccess(() => {
    project.executeTransaction((ca) => {
      ca.addAction(insertAction);
    }, `Insert shot ${i + 1}`);
  });
  // Advance time by the clip's duration
  const clipDuration = await app.ClipProjectItem.cast(videoItems[i])
    .getOutPoint(app.Constants.MediaType.VIDEO);
  currentTime = currentTime.add(clipDuration);
}

// 5. Add voiceover audio on a separate audio track
const audioItems = await audioBin.getItems();
let audioTime = app.TickTime.TIME_ZERO;
for (const audioItem of audioItems) {
  const insertAudioAction = editor.createInsertProjectItemAction(
    audioItem,
    audioTime,
    -1,  // skip video track
    1,   // audio track 1 (separate from video's audio)
    false
  );
  project.lockedAccess(() => {
    project.executeTransaction((ca) => {
      ca.addAction(insertAudioAction);
    }, "Insert audio");
  });
  const dur = await app.ClipProjectItem.cast(audioItem)
    .getOutPoint(app.Constants.MediaType.AUDIO);
  audioTime = audioTime.add(dur);
}

return { success: true, sequenceName: seq.name };
```

---

## Markers API

```javascript
const seq = await project.getActiveSequence();
const markers = await seq.getMarkers();

// Add a marker
project.lockedAccess(() => {
  project.executeTransaction((ca) => {
    ca.addAction(markers.createAddMarkerAction(
      "Scene 2 Start",                         // name
      app.Marker.MARKER_TYPE_COMMENT,          // type
      app.TickTime.createWithSeconds(30.0),     // time
      app.TickTime.TIME_ZERO,                   // duration (0 = point marker)
      app.Constants.MarkerColor.GREEN           // color
    ));
  }, "Add Marker");
});
```

---

## Video Effects & Transitions

### Apply a Video Effect

```javascript
const matchNames = await app.VideoFilterFactory.getMatchNames();
// e.g. "AE.ADBE Mosaic", "PR.ADBE Solarize", etc.

const effect = await app.VideoFilterFactory.createComponent("PR.ADBE Solarize");
const chain = await trackItem.getComponentChain(); // VideoComponentChain

project.lockedAccess(() => {
  project.executeTransaction((ca) => {
    ca.addAction(chain.createAppendComponentAction(effect));
  }, "Add Effect");
});
```

### Apply a Video Transition

```javascript
const transitionNames = await app.TransitionFactory.getVideoTransitionMatchNames();
const transition = app.TransitionFactory.createVideoTransition("PR.ADBE Cross Dissolve");

const options = app.AddTransitionOptions();
options.setDuration(app.TickTime.createWithSeconds(1.0));
options.setApplyToStart(false); // apply to end of clip

const addTransAction = trackItem.createAddVideoTransitionAction(transition, options);
executeAction(project, addTransAction, "Add Transition");
```

---

## Sequence Settings

```javascript
const settings = await seq.getSettings();

// Read
const frameRate = settings.getVideoFrameRate();        // FrameRate
const frameRect = await settings.getVideoFrameRect();  // RectF {left, top, right, bottom}
const audioRate = await settings.getAudioSampleRate();  // FrameRate

// Write
settings.setVideoFrameRate(app.FrameRate.createWithValue(24));
await settings.setVideoFrameRect({ left: 0, top: 0, right: 1920, bottom: 1080 });
await settings.setAudioSampleRate(app.FrameRate.createWithValue(48000));
```

---

## Events

```javascript
// Project events
app.EventManager.addEventListener(project, app.Project.EVENT_PROJECT_DIRTY, handler);
// Constants.ProjectEvent: OPENED, CLOSED, DIRTY, ACTIVATED, PROJECT_ITEM_SELECTION_CHANGED

// Sequence events
app.EventManager.addEventListener(seq, app.Sequence.EVENT_SEQUENCE_ACTIVATED, handler);
// Constants.SequenceEvent: ACTIVATED, CLOSED, SELECTION_CHANGED

// Global events (no target)
app.EventManager.addGlobalEventListener("operationComplete", handler);
// Constants.OperationCompleteEvent: IMPORT_MEDIA_COMPLETE, EXPORT_MEDIA_COMPLETE, etc.
```

---

## Constants Reference

| Enum | Values |
|------|--------|
| `ExportType` | `QUEUE_TO_AME`, `QUEUE_TO_APP`, `IMMEDIATELY` |
| `MediaType` | `ANY`, `DATA`, `VIDEO`, `AUDIO` |
| `TrackItemType` | `EMPTY(0)`, `CLIP(1)`, `TRANSITION(2)`, `PREVIEW(3)`, `FEEDBACK(4)` |
| `ContentType` | `ANY`, `SEQUENCE`, `MEDIA` |
| `MarkerColor` | `GREEN`, `RED`, `MAGNETA`, `ORANGE`, `YELLOW`, `BLUE`, `CYAN` |
| `InterpolationMode` | `BEZIER`, `HOLD`, `LINEAR`, `TIME`, `TIME_TRANSITION_END`, `TIME_TRANSITION_START` |
| `VideoFieldType` | `PROGRESSIVE`, `UPPER_FIRST`, `LOWER_FIRST` |

---

## Key Gotchas

1. **All mutations require `lockedAccess` + `executeTransaction`** — Direct property sets won't work for most operations. Always create an Action, then execute it in a transaction.

2. **Paths must be absolute** — When importing files via `project.importFiles()`, use absolute file paths. Relative paths will fail.

3. **UXP plugin must be loaded** — The UXP Developer Tool must stay open during development. Closing it unloads the plugin. For production, package the plugin as a `.ccx` file.

4. **Async everywhere** — Unlike old ExtendScript, all UXP DOM calls return Promises. Always `await`.

5. **TickTime arithmetic returns new objects** — `t1.add(t2)` returns a new TickTime; `t1` is unchanged.

6. **Track indices are 0-based** — Video track 0 is the first video track, audio track 0 is the first audio track.

7. **`importFiles` is async but doesn't wait for media to be fully available** — After importing, you may need to listen for `IMPORT_MEDIA_COMPLETE` event before accessing imported items.

8. **Preset files (.epr)** — For export, you need an Adobe Media Encoder preset file. These are typically found in `~/Documents/Adobe/Adobe Media Encoder/...` or can be exported from AME's preset browser.

---

## Plugin Development & Deployment

### Development (UDT)
1. Install UXP Developer Tool from Creative Cloud
2. Create plugin folder with `manifest.json` + `index.html` + `index.js`
3. In UDT: Add Plugin → Load → Debug (opens DevTools)

### Production (.ccx package)
1. In UDT: select plugin → Package
2. Distribute `.ccx` file to users
3. Users double-click `.ccx` to install

### File System Access

```javascript
// UXP filesystem for reading/writing plugin-local files
const fs = require('uxp').storage.localFileSystem;
const folder = await fs.getFolder();
const file = await folder.createFile("output.json");
await file.write(JSON.stringify(data));

// Or using the fs module for temp files
const fs2 = require('fs');
// Only plugin-temp:/ is available in scripts
```

---

## Reference Links

- [Premiere UXP API Reference](https://developer.adobe.com/premiere-pro/uxp/ppro_reference/)
- [UXP Plugin Concepts](https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/)
- [Official Samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Premiere Pro MCP Bridge](https://github.com/nepfaff/premiere-pro-mcp)
- [TypeScript Definitions](https://github.com/AdobeDocs/uxp-premiere-pro-samples/blob/main/sample-panels/premiere-api/html/types.d.ts)
