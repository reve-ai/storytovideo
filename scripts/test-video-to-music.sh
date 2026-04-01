#!/bin/bash
set -euo pipefail

# Load env
source .env

RUN_DIR="${1:-output/runs/c37ca1a8-cd54-4041-b806-2d4034de1757}"
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

# Step 2a: Decode music mp3 to wav first to eliminate mp3 frame padding/delay drift
MUSIC_WAV="$RUN_DIR/generated-music.wav"
ffmpeg -y -i "$MUSIC_OUTPUT" -ar 44100 -ac 2 -sample_fmt s16 "$MUSIC_WAV"
echo "Converted music to WAV: $(du -h "$MUSIC_WAV" | cut -f1)"

# Step 2b: Mix original audio with music.
# Both streams forced to exact same sample rate/format to prevent drift.
# Using amerge for sample-accurate interleaving instead of amix (which can drift).
ffmpeg -y -i "$INPUT_VIDEO" -i "$MUSIC_WAV" \
  -filter_complex "\
    [0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[orig];\
    [1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.3,apad[music];\
    [orig][music]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[out]" \
  -map 0:v -map "[out]" \
  -c:v copy -c:a aac -b:a 192k \
  -shortest \
  "$FINAL_OUTPUT"

rm -f "$MUSIC_WAV"

echo ""
echo "=== Done ==="
echo "Original:    $INPUT_VIDEO"
echo "Music track: $MUSIC_OUTPUT"
echo "Final:       $FINAL_OUTPUT ($(du -h "$FINAL_OUTPUT" | cut -f1))"
echo ""
echo "Play it:  open $FINAL_OUTPUT"
