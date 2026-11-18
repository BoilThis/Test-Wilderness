#!/usr/bin/env node
/**
 * Automated Verification Harness for:
 *  1. JS syntax validation across index.html inline scripts, caldera_castaway.js & Water.js
 *  2. AdaptiveGovernor early particle/shadow trimming, p95 tracking, & consumer wiring
 *  3. Natural cave darkness + Torch & Flare subterranean atmosphere/visibility transitions
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/index.html');
const CALDERA_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/js/caldera_castaway.js');
const WATER_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/js/Water.js');
const THREE_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/js/three.min.js');

const html = fs.readFileSync(INDEX_PATH, 'utf8');
const lines = html.split('\n');

// ---------------------------------------------------------------------------
// 1. Syntax Verification of all JS bundles & inline scripts
// ---------------------------------------------------------------------------
console.log('[1/3] Syntax-checking inline scripts, caldera_castaway.js & Water.js...');
const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let inlineIdx = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  inlineIdx++;
  new vm.Script(match[1], { filename: `index.html#inline-${inlineIdx}` });
}
assert(inlineIdx >= 1, 'Expected at least 1 inline script in index.html');
new vm.Script(fs.readFileSync(CALDERA_PATH, 'utf8'), { filename: 'caldera_castaway.js' });
new vm.Script(fs.readFileSync(WATER_PATH, 'utf8'), { filename: 'Water.js' });
console.log(`  PASS: ${inlineIdx} inline script(s), caldera_castaway.js, and Water.js parsed cleanly.`);

// ---------------------------------------------------------------------------
// 2. AdaptiveGovernor Early-Trim & Consumer Wiring Test
// ---------------------------------------------------------------------------
console.log('[2/3] Profiling AdaptiveGovernor early-trim curves & dead-knob wiring...');
const govStart = lines.findIndex(l => l.includes('window.AdaptiveGovernor = {'));
const govEnd = lines.findIndex((l, i) => i > govStart && l.includes('window.setQualityTier = function'));
assert(govStart !== -1 && govEnd !== -1, 'Could not locate AdaptiveGovernor block in index.html');
const govSrc = lines.slice(govStart - 1, govEnd).join('\n');

let mockPixelRatio = 1.5;
const govSandbox = {
  console, Math, Float32Array,
  window: {},
  renderer: {
    getPixelRatio: () => mockPixelRatio,
    setPixelRatio: (v) => { mockPixelRatio = v; }
  }
};
govSandbox.window = govSandbox;
govSandbox._tierBaseGrassCount = 52000;
govSandbox.maxGrassCount = 58000;
govSandbox.instancedGrass = { count: 52000, visible: true };
govSandbox.grassUniforms = { uLodBias: { value: 1.0 } };

vm.createContext(govSandbox);
vm.runInContext(govSrc, govSandbox);

const gov = govSandbox.window.AdaptiveGovernor;
gov.applyPreset('medium');

// Boot warmup immunity (t < 2.5s should never degrade quality)
for (let i = 0; i < 40; i++) {
  gov.update(0.050, 0.5 + i * 0.05);
}
assert.strictEqual(gov.tierLabel, 'Balanced', 'Boot warmup must shield initial shader-compile spikes');
assert.strictEqual(gov.particleBudgetScale, 0.85, 'Boot warmup must keep particleBudgetScale untouched');

// Simulate mild mobile pressure (20.2ms -> ~49.5 FPS) — BEFORE old 24.5ms threshold!
let t = 3.0;
for (let i = 0; i < 60; i++) {
  t += 0.0202;
  gov.update(0.0202, t);
}
assert.strictEqual(gov.tierLabel, 'Gov:Trim', `Expected Gov:Trim at 20.2ms, got ${gov.tierLabel}`);
assert(gov.particleBudgetScale < 0.70, `Expected particleBudgetScale < 0.70 under early trim, got ${gov.particleBudgetScale}`);
assert(gov.shadowStride > 14, `Expected shadowStride > 14 under early trim, got ${gov.shadowStride}`);
assert(gov.shadowSnapStep > 1.5, `Expected shadowSnapStep > 1.5 under early trim, got ${gov.shadowSnapStep}`);
assert(gov.shadowRadiusSq < 1444.0, `Expected shadowRadiusSq < 1444 under early trim, got ${gov.shadowRadiusSq}`);
assert.strictEqual(gov.shadowEnabledGov, true, 'Shadows should still stay enabled during soft Stage 1 trim');

// Simulate harder pressure (24.5ms -> ~41 FPS)
for (let i = 0; i < 80; i++) {
  t += 0.0245;
  gov.update(0.0245, t);
}
assert.strictEqual(gov.tierLabel, 'Gov:Throttle', `Expected Gov:Throttle at 24.5ms, got ${gov.tierLabel}`);
assert(gov.grassRatio < 0.9, `Expected grassRatio < 0.9, got ${gov.grassRatio}`);
assert(govSandbox.instancedGrass.count < 52000, `Expected instancedGrass.count trimmed below 52000, got ${govSandbox.instancedGrass.count}`);
assert(mockPixelRatio < 1.5, `Expected pixelRatio stepped down from 1.5, got ${mockPixelRatio}`);

const throttledGrassCount = govSandbox.instancedGrass.count;
const throttledDpr = mockPixelRatio;

// Simulate heavy GPU overload (28.0ms -> ~35.7 FPS) -> Guard disables shadows & reflection pass
for (let i = 0; i < 90; i++) {
  t += 0.0280;
  gov.update(0.0280, t);
}
assert.strictEqual(gov.tierLabel, 'Gov:Guard', `Expected Gov:Guard at 28ms, got ${gov.tierLabel}`);
assert.strictEqual(gov.shadowEnabledGov, false, 'Heavy overload must pause directional shadows cleanly');
assert.strictEqual(govSandbox.window._skipWaterReflectionPass, true, 'Heavy overload must gate planar water reflections');

// Simulate headroom recovery (15.0ms -> 60+ FPS)
for (let i = 0; i < 220; i++) {
  t += 0.0150;
  gov.update(0.0150, t);
}
assert.strictEqual(gov.tierLabel, 'Gov:Optimal', `Expected recovery to Gov:Optimal, got ${gov.tierLabel}`);
assert.strictEqual(gov.shadowEnabledGov, true, 'Expected shadows re-enabled after recovery');
assert.strictEqual(govSandbox.window._skipWaterReflectionPass, false, 'Expected water reflection pass restored after recovery');
assert(govSandbox.instancedGrass.count >= 48000, `Expected grass count recovered >= 48000, got ${govSandbox.instancedGrass.count}`);

console.log(`  PASS: Warmup guarded, Stage 1 Trim @ 20.2ms, Stage 2 Throttle @ 24.5ms (grass=${throttledGrassCount}, dpr=${throttledDpr}), Guard @ 28ms, & Clean Recovery (grass=${govSandbox.instancedGrass.count}).`);

// ---------------------------------------------------------------------------
// 3. Natural Cave Darkness + Torch & Flare Illumination Check
// ---------------------------------------------------------------------------
console.log('[3/3] Verifying natural cave darkness + Pitch Torch & Flare visibility across caves...');
const threeCode = fs.readFileSync(THREE_PATH, 'utf8');
const smoothStart = lines.findIndex(l => l.includes('function smoothstep(edge0, edge1, x)'));
const smoothEnd = lines.findIndex((l, i) => i > smoothStart && l.trim() === '}');
const noiseStart = lines.findIndex(l => l.includes('function hash2(ix, iz)'));
const ridgedEnd = lines.findIndex(l => l.includes('function getEstuaryCenter(z)'));
const caveStart = lines.findIndex(l => l.includes('function passageFloor(cave, x, z, s)'));
const caveEnd = lines.findIndex((l, i) => i > caveStart && l.includes('window.getCaveNavigationInfo = getCaveNavigationInfo;'));
const syncStart = lines.findIndex(l => l.includes('function syncCaveAtmosphere(dt, snap = false'));
const syncEnd = lines.findIndex((l, i) => i > syncStart && l.includes('window.syncCaveAtmosphere = syncCaveAtmosphere;'));
assert(syncStart !== -1 && syncEnd !== -1, 'Could not locate syncCaveAtmosphere');

const caveSandbox = {
  console, Math, Number, Array, Object,
  window: {},
  performance: { now: () => 5000 },
  getWaterInfo: () => ({ isWater: false, surfaceY: 0 }),
  MOUNT_CALDERA: { x: -302.0, z: 64.0, baseR: 112.0, rimR: 36.0, poolEdgeR: 26.5, rimY: 168.0, floorY: 146.5, lavaY: 155.5, footY: 12.0 },
  MOUNT_SPINE: { x: 0, z: 0 }
};
caveSandbox.window = caveSandbox;
vm.createContext(caveSandbox);
vm.runInContext(threeCode, caveSandbox);

const THREE = caveSandbox.THREE;
caveSandbox.scene = new THREE.Scene();
caveSandbox.scene.fog = new THREE.FogExp2(0x88bbee, 0.00145);
caveSandbox.camera = new THREE.PerspectiveCamera();
caveSandbox.camera.position.set(0, 15, 0);
caveSandbox.player = { pos: new THREE.Vector3(0, 15, 0) };
caveSandbox.sunLight = new THREE.DirectionalLight(0xffffff, 1.45);
caveSandbox.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.96);
caveSandbox._surfFogFallback = new THREE.Color(0x88bbee);
caveSandbox._surfaceFogColor = new THREE.Color(0x88bbee);
caveSandbox._caveFogColor = new THREE.Color(0x050608);
caveSandbox._surfaceSunInt = 1.45;
caveSandbox._surfaceHemiInt = 0.96;
caveSandbox.skyUniforms = { nightMix: { value: 0.0 }, stormMix: { value: 0.0 } };
caveSandbox.sky = { visible: true };
caveSandbox.cloudDome = { visible: true };
caveSandbox.starDome = { visible: false };
caveSandbox.starMat = { opacity: 0.0 };
caveSandbox.uCaveDarkness = { value: 0.0 };
caveSandbox.calderaCampaign = { activeFlares: [] };

vm.runInContext([
  lines.slice(smoothStart, smoothEnd + 1).join('\n'),
  lines.slice(noiseStart, ridgedEnd).join('\n'),
  lines.slice(caveStart, caveEnd + 1).join('\n'),
  lines.slice(syncStart, syncEnd + 1).join('\n'),
  'buildCaveBranchGraphs();'
].join('\n'), caveSandbox);

// Check surface baseline
caveSandbox.player.pos.set(0, 18, 0);
caveSandbox.camera.position.set(0, 19.6, 0);
caveSandbox._calderaActiveTool = 'hatchet';
caveSandbox.syncCaveAtmosphere(0.016, true);
assert.strictEqual(caveSandbox._caveLightingMode, 'Surface');
assert(caveSandbox.sunLight.intensity > 1.3, 'Surface sunlight should remain full');

// Test deep points of each cave system under Dark, Torch, and Flare modes
for (const cv of caveSandbox.CAVE_SYSTEMS) {
  const deepPoint = cv.getPoint(0.65);
  const nav = caveSandbox.getCaveNavigationInfo(deepPoint.x, deepPoint.z, deepPoint.floorY + 1.0);
  assert(nav && nav.isInside, `Expected (${deepPoint.x.toFixed(1)}, ${deepPoint.z.toFixed(1)}) inside cave ${cv.id}`);
  caveSandbox.player.pos.set(deepPoint.x, nav.floorY + 1.0, deepPoint.z);
  caveSandbox.camera.position.set(deepPoint.x, nav.floorY + 2.5, deepPoint.z);

  // A) Unlit Natural Darkness
  caveSandbox._calderaActiveTool = 'hatchet';
  caveSandbox.calderaCampaign.activeFlares = [];
  caveSandbox.syncCaveAtmosphere(0.016, true, null, nav);
  assert.strictEqual(caveSandbox._caveLightingMode, 'Dark', `${cv.id} unlit mode mismatch`);
  assert(caveSandbox.scene.fog.density >= 0.050, `${cv.id} dark fog too thin (${caveSandbox.scene.fog.density})`);
  assert(caveSandbox.hemiLight.intensity <= 0.02, `${cv.id} dark hemiLight too bright (${caveSandbox.hemiLight.intensity})`);
  assert(caveSandbox.sunLight.intensity <= 0.02, `${cv.id} dark sunLight too bright`);

  // B) Pitch Torch Equipped
  caveSandbox._calderaActiveTool = 'torch';
  caveSandbox.syncCaveAtmosphere(0.016, true, null, nav);
  assert.strictEqual(caveSandbox._caveLightingMode, 'Torch', `${cv.id} torch mode mismatch`);
  assert(caveSandbox.scene.fog.density <= 0.018, `${cv.id} torch fog should open visibility`);
  assert(caveSandbox.hemiLight.intensity >= 0.30, `${cv.id} torch bounce fill expected`);

  // C) Active Fired Cave Flare (even with hatchet equipped!)
  caveSandbox._calderaActiveTool = 'hatchet';
  caveSandbox.calderaCampaign.activeFlares = [{ isCaveFlare: true, age: 1.0, maxLife: 28.0 }];
  caveSandbox.syncCaveAtmosphere(0.016, true, null, nav);
  assert.strictEqual(caveSandbox._caveLightingMode, 'Flare', `${cv.id} flare mode mismatch`);
  assert(caveSandbox.scene.fog.density <= 0.015, `${cv.id} flare fog should open visibility further`);
  assert(caveSandbox.hemiLight.intensity >= 0.38, `${cv.id} flare bounce fill expected`);
}

console.log(`  PASS: Verified Dark / Torch / Flare illumination across all ${caveSandbox.CAVE_SYSTEMS.length} caves & interconnects.`);
