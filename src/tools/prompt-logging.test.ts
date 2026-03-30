import { strict as assert } from "node:assert";
import { buildAnalyzeStoryPrompt } from "./analyze-story.js";
import { buildAnalyzeVideoPrompt } from "./analyze-video-pacing.js";
import { buildFinalFramePrompt } from "./generate-frame.js";
import { generateAsset } from "./generate-asset.js";
import { generateVideo } from "./generate-video.js";
import { buildStoryToScriptPrompt } from "./story-to-script.js";

function testFrameFinalPromptIncludesReferenceLeadIn(): void {
  const finalPrompt = buildFinalFramePrompt({
    artStyle: "photorealistic",
    composition: "medium_shot",
    locationDescription: "Archive",
    charactersPresent: ["Alice"],
    objectsPresent: ["Lantern"],
    framePrompt: "Alice studies the lantern on the table.",
    cameraDirection: "static camera",
    hasCharacterDialogue: false,
    referencesUsed: [
      { type: "character", name: "Alice", path: "/tmp/alice.png" },
      { type: "location", name: "Archive", path: "/tmp/archive.png" },
    ],
  });

  assert.match(finalPrompt, /The first image is Alice's appearance reference\./);
  assert.match(finalPrompt, /The second image is the location setting for Archive\./);
  assert.match(finalPrompt, /Alice studies the lantern on the table\./);
  console.log("  ✓ frame final prompt includes the assembled reference lead-in");
}

async function testVideoDryRunReturnsSanitizedFinalPrompt(): Promise<void> {
  const result = await generateVideo({
    shotNumber: 1,
    sceneNumber: 1,
    shotInScene: 1,
    shotType: "first_last_frame",
    actionPrompt: "Alice runs toward Bob.",
    dialogue: "We need to go.",
    speaker: "Alice",
    charactersPresent: ["Alice", "Bob"],
    soundEffects: "footsteps",
    cameraDirection: "slow push in",
    durationSeconds: 4,
    startFramePath: "/tmp/fake-start.png",
    outputDir: "/tmp",
    dryRun: true,
    videoBackend: "veo",
    characterNames: ["Alice", "Bob"],
  });

  assert.equal(result.finalPrompt.includes("Alice"), false);
  assert.equal(result.finalPrompt.includes("Bob"), false);
  assert.match(result.finalPrompt, /the first person runs toward the second person\./i);
  assert.match(result.finalPrompt, /The first person looks at the second person and says: "We need to go\."/);
  console.log("  ✓ video dry-run returns the exact sanitized Veo prompt");
}

async function testAssetDryRunReturnsFinalPrompt(): Promise<void> {
  const result = await generateAsset({
    objectName: "Lantern",
    description: "A brass lantern with etched glass panels",
    artStyle: "photorealistic",
    outputDir: "/tmp",
    dryRun: true,
  });

  assert.equal(result.finalPrompt, "Generate a photorealistic style reference image of an object/product: A brass lantern with etched glass panels. Show the object clearly against a neutral background for reference.");
  console.log("  ✓ asset dry-run returns the final prompt text");
}

function testPromptBuildersMatchLoggedText(): void {
  const storyPrompt = buildStoryToScriptPrompt("A quiet reunion in a train station.");
  const analysisPrompt = buildAnalyzeStoryPrompt("A quiet reunion in a train station.");
  const videoAnalysisPrompt = buildAnalyzeVideoPrompt({
    shotNumber: 7,
    dialogue: "Hello again.",
    actionPrompt: "They hesitate, then embrace.",
    durationSeconds: 6,
    cameraDirection: "static camera",
    startFramePrompt: "Both characters face each other across the platform.",
    referenceImagePaths: ["/tmp/ref.png"],
  });

  assert.match(storyPrompt, /^You are a screenwriter adapting a story into a visual script\./);
  assert.match(analysisPrompt, /^Analyze the following story and extract:/);
  assert.match(videoAnalysisPrompt, /The first image after the video is the start frame that was used as input to generate this clip\./);
  console.log("  ✓ shared prompt builders expose the exact logged text");
}

async function main(): Promise<void> {
  console.log("Prompt logging tests:");
  testFrameFinalPromptIncludesReferenceLeadIn();
  await testVideoDryRunReturnsSanitizedFinalPrompt();
  await testAssetDryRunReturnsFinalPrompt();
  testPromptBuildersMatchLoggedText();
  console.log("\nAll tests passed ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});