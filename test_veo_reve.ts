import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const keyFile = process.env.VEO_REVE_CREDENTIALS;
if (!keyFile) {
  console.error('❌ VEO_REVE_CREDENTIALS not set');
  process.exit(1);
}

const client = new GoogleGenAI({
  vertexai: true,
  project: 'training-422222',
  location: 'us-central1',
  googleAuthOptions: { keyFile },
});

// Create output directory
const outputDir = 'test_output';
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testTextToVideo() {
  console.log('\n=== TEST: Vertex AI (veo-reve) Text-to-Video ===');
  try {
    const prompt = 'A slow cinematic pan across a beautiful mountain landscape at sunset, golden light, peaceful atmosphere';

    console.log(`[veo-reve] Calling generateVideos with prompt: "${prompt}"`);
    let operation = await client.models.generateVideos({
      model: 'veo-3.1-generate-001',
      prompt,
      config: {
        numberOfVideos: 1,
        durationSeconds: 4,
        aspectRatio: '16:9',
      },
    });

    console.log(`[veo-reve] Operation name: ${operation.name}`);
    console.log(`[veo-reve] Initial done status: ${operation.done}`);

    // Poll for completion
    while (!operation.done) {
      console.log('[veo-reve] Waiting 10s...');
      await sleep(10000);
      operation = await client.operations.getVideosOperation({ operation });
      console.log(`[veo-reve] Poll status: done=${operation.done}`);
    }

    console.log('[veo-reve] Full response:', JSON.stringify(operation.response, null, 2));

    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (generatedVideo?.video) {
      console.log(`[veo-reve] Video URI: ${generatedVideo.video.uri}`);
      console.log('[veo-reve] Full generatedVideo:', JSON.stringify(generatedVideo, null, 2));
      const downloadPath = join(outputDir, 'test_veo_reve_text_to_video.mp4');
      await client.files.download({
        file: generatedVideo.video,
        downloadPath,
      });
      console.log(`[veo-reve] ✅ Downloaded to ${downloadPath}`);
    } else {
      console.error('[veo-reve] ❌ No video in response:', JSON.stringify(operation.response, null, 2));
    }
  } catch (err: any) {
    console.error('[veo-reve] ❌ Error:', err.message);
    if (err.response) {
      console.error('[veo-reve] Response body:', JSON.stringify(err.response, null, 2));
    }
  }
}

async function main() {
  console.log('Usage: npx tsx test_veo_reve.ts');
  console.log('Generates a 4s text-to-video clip via Vertex AI (veo-reve backend)\n');
  await testTextToVideo();
}

main().catch(console.error);
