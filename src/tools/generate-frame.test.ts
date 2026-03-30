import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import type { AssetLibrary, Shot } from "../types.js";
import { buildFramePrompt, buildFrameReferencePlan, buildReferenceLeadIn } from "./generate-frame.js";

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    shotNumber: 2,
    sceneNumber: 1,
    shotInScene: 2,
    durationSeconds: 4,
    shotType: "first_last_frame",
    composition: "medium_shot",
    startFramePrompt: "Alice and Bob study the table.",
    actionPrompt: "They examine the clues.",
    dialogue: "",
    speaker: "",
    soundEffects: "",
    cameraDirection: "static camera",
    charactersPresent: ["Alice", "Bob"],
    objectsPresent: ["Lantern", "Map", "Compass"],
    location: "Archive",
    continuousFromPrevious: false,
    ...overrides,
  };
}

async function writePng(filePath: string, color: { r: number; g: number; b: number }): Promise<void> {
  await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background: color,
    },
  }).png().toFile(filePath);
}

async function testReferencePlanPrioritizesAndCollagesOverflow(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "generate-frame-"));
  const alice = join(dir, "alice.png");
  const bob = join(dir, "bob.png");
  const archive = join(dir, "archive.png");
  const lantern = join(dir, "lantern.png");
  const map = join(dir, "map.png");
  const compass = join(dir, "compass.png");
  const collage = join(dir, "collage.png");

  await Promise.all([
    writePng(alice, { r: 255, g: 0, b: 0 }),
    writePng(bob, { r: 0, g: 255, b: 0 }),
    writePng(archive, { r: 255, g: 255, b: 0 }),
    writePng(lantern, { r: 255, g: 0, b: 255 }),
    writePng(map, { r: 0, g: 255, b: 255 }),
    writePng(compass, { r: 120, g: 120, b: 120 }),
  ]);

  const assetLibrary: AssetLibrary = {
    characterImages: {
      Alice: { front: alice, angle: alice },
      Bob: { front: bob, angle: bob },
    },
    locationImages: {
      Archive: archive,
    },
    objectImages: {
      Lantern: lantern,
      Map: map,
      Compass: compass,
    },
  };

  const plan = await buildFrameReferencePlan({
    shot: makeShot(),
    assetLibrary,
    imageBackend: "grok",
    collageOutputPath: collage,
  });

  assert.deepEqual(plan.referencesUsed.map(reference => reference.type), ["character", "character", "location", "object", "collage"]);
  assert.deepEqual(plan.mergedReferences.map(reference => reference.name), ["Map", "Compass"]);
  assert.equal(plan.droppedReferences.length, 0);
  assert.ok(existsSync(collage));

  const leadIn = buildReferenceLeadIn(plan.referencesUsed);
  const legacyTag = ["<", "img", ">"].join("");
  assert.equal(leadIn.includes(legacyTag), false);
  assert.match(leadIn, /Image 1: Alice\./);
  assert.match(leadIn, /Image 5: props collage\./);
  // No composition directive in terse format
  assert.equal(leadIn.includes("Compose the scene"), false);
  console.log("  ✓ reference plan prioritizes characters and collage overflow");
}

async function testPreviousFrameRequiresEligibleShot(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "generate-frame-"));
  const alice = join(dir, "alice.png");
  const collage = join(dir, "collage.png");

  await Promise.all([
    writePng(alice, { r: 255, g: 0, b: 0 }),
  ]);

  const plan = await buildFrameReferencePlan({
    shot: makeShot({ shotNumber: 1, shotInScene: 1, charactersPresent: ["Alice"], objectsPresent: [] }),
    assetLibrary: {
      characterImages: { Alice: { front: alice, angle: alice } },
      locationImages: {},
      objectImages: {},
    },
    imageBackend: "grok",
    collageOutputPath: collage,
  });

  assert.equal(plan.referencesUsed.some(reference => reference.type === "continuity"), false);
  console.log("  ✓ no continuity references are produced (feature removed)");
}

function testReferenceAwarePromptOmitsLocationLine(): void {
  const prompt = buildFramePrompt({
    artStyle: "photorealistic",
    composition: "wide_establishing",
    locationDescription: "Restaurant entrance",
    charactersPresent: ["Liam"],
    objectsPresent: ["tables"],
    framePrompt: "Liam stands alone near the restaurant entrance, slightly off-center right, one hand adjusting his shirt cuff.",
    cameraDirection: "static camera",
    hasCharacterDialogue: false,
    hasReferenceImages: true,
  });

  const leadIn = buildReferenceLeadIn([
    { type: "character", name: "Liam", path: "/tmp/liam.png" },
    { type: "location", name: "Restaurant", path: "/tmp/restaurant.png" },
  ]);
  const samplePrompt = `${leadIn} ${prompt}`;

  assert.equal(prompt.includes("Location:"), false);
  assert.match(leadIn, /Image 1: Liam\./);
  assert.match(leadIn, /Image 2: Restaurant location\./);
  assert.equal(leadIn.includes("Compose the scene"), false);
  console.log("  sample prompt:", samplePrompt);
  console.log("  ✓ reference-aware prompts omit redundant location lines");
}

async function main(): Promise<void> {
  console.log("Generate frame tests:");
  await testReferencePlanPrioritizesAndCollagesOverflow();
  await testPreviousFrameRequiresEligibleShot();
  testReferenceAwarePromptOmitsLocationLine();
  console.log("\nAll tests passed ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});