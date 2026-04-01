#!/bin/bash
set -euo pipefail

# Load env
source .env

RUN_DIR="output/runs/c37ca1a8-cd54-4041-b806-2d4034de1757"
INPUT_VIDEO="$RUN_DIR/final.mp4"
MUSIC_OUTPUT="$RUN_DIR/generated-music.mp3"
FINAL_OUTPUT="$RUN_DIR/final-music.mp4"

if [ ! -f "$INPUT_VIDEO" ]; then
  echo "ERROR: $INPUT_VIDEO not found"
  exit 1
fi

echo "=== Step 1: Uploading video to ElevenLabs Video-to-Music API ==="
echo "Video: $INPUT_VIDEO ($(du -h "$INPUT_VIDEO" | cut -f1))"

# Call ElevenLabs Video-to-Music API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://api.elevenlabs.io/v1/music/video-to-music" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Accept: audio/mpeg" \
  -F "videos=@$INPUT_VIDEO" \
  -o "$MUSIC_OUTPUT")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "ERROR: API returned HTTP $HTTP_CODE"
  # If the output file contains JSON error, show it
  if file "$MUSIC_OUTPUT" | grep -q "text\|ASCII\|JSON"; then
    cat "$MUSIC_OUTPUT"
    rm -f "$MUSIC_OUTPUT"
  fi
  exit 1
fi

echo "Music generated: $MUSIC_OUTPUT ($(du -h "$MUSIC_OUTPUT" | cut -f1))"

echo ""
echo "=== Step 2: Mixing music with original video audio using ffmpeg ==="

# Get video duration
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT_VIDEO")
echo "Video duration: ${DURATION}s"

# Get music duration
MUSIC_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MUSIC_OUTPUT")
echo "Music duration: ${MUSIC_DURATION}s"

# Mix: keep original audio (dialogue/SFX) at full volume, add music underneath at lower volume
# -filter_complex: 
#   [1:a] = music track, reduced volume to sit under dialogue
#   [0:a] = original video audio at full volume
#   amix: combine both, normalize off so we control levels manually
ffmpeg -y -i "$INPUT_VIDEO" -i "$MUSIC_OUTPUT" \
  -filter_complex "[1:a]volume=0.3,aloop=loop=-1:size=2e+09,atrim=duration=$DURATION[music];[0:a][music]amix=inputs=2:duration=first:normalize=0[out]" \
  -map 0:v -map "[out]" \
  -c:v copy -c:a aac -b:a 192k \
  "$FINAL_OUTPUT"

echo ""
echo "=== Done ==="
echo "Original:    $INPUT_VIDEO"
echo "Music track: $MUSIC_OUTPUT"
echo "Final:       $FINAL_OUTPUT ($(du -h "$FINAL_OUTPUT" | cut -f1))"
echo ""
echo "Play it:  open $FINAL_OUTPUT"
