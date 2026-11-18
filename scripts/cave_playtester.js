#!/usr/bin/env node
/**
 * Automated 3D Cave Walkthrough & Junction Aperture Playtester for Caldera Castaway.
 * Uses fast spatial-grid 3D triangle raycasting across every generated cave wall,
 * branch/aqueduct mesh, instanced rock prop, entrance boulder, and collider!
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/index.html');
const THREE_PATH = path.join(ROOT, 'app/src/main/assets/wilderness/js/three.min.js');

const html = fs.readFileSync(INDEX_PATH, 'utf8');
const lines = html.split('\n');

const polyStart = lines.findIndex(l => l.includes('Polyfill THREE.InstancedMesh.prototype.computeBoundingSphere'));
const polyEnd = lines.findIndex((l, i) => i > polyStart && l === '    }');
const exactPolySrc = lines.slice(polyStart, polyEnd + 1).join('\n');

const smoothStart = lines.findIndex(l => l.includes('function smoothstep(edge0, edge1, x)'));
const smoothEnd = lines.findIndex((l, i) => i > smoothStart && l.trim() === '}');
const exactSmoothSrc = lines.slice(smoothStart, smoothEnd + 1).join('\n');

const noiseStart = lines.findIndex(l => l.includes('function hash2(ix, iz)'));
const ridgedEnd = lines.findIndex(l => l.includes('function getEstuaryCenter(z)'));
const exactNoiseSrc = lines.slice(noiseStart, ridgedEnd).join('\n');

const caveStart = lines.findIndex(l => l.includes('function passageFloor(cave, x, z, s)'));
const caveEnd = lines.findIndex((l, i) => i > caveStart && l.includes('window.getCaveNavigationInfo = getCaveNavigationInfo;'));
const exactCaveDefsSrc = lines.slice(caveStart, caveEnd + 1).join('\n');

const rockStart = lines.findIndex(l => l.includes('window.activeBoulders = window.activeBoulders || [];'));
const rockEnd = lines.findIndex((l, i) => i > rockStart && l.includes('function createGraniteBoulder('));
const rockFnEnd = lines.findIndex((l, i) => i > rockEnd && l === '    }');
const exactRockSrc = lines.slice(rockStart, rockFnEnd + 1).join('\n');

const caveSysStart = lines.findIndex(l => l.includes('async function createHillsideCaveSystems(yieldFn)'));
const caveSysClose = lines.findIndex((l, i) => i > caveSysStart && l === '    }');
const exactCaveSysSrc = lines.slice(caveSysStart, caveSysClose + 1).join('\n');

const threeCode = fs.readFileSync(THREE_PATH, 'utf8');
const sandbox = {
  console, Math, Number, String, Boolean, Array, Object, Map, Set,
  Float32Array, Uint16Array, Uint32Array, Int32Array, Promise,
  document: {
    createElement: () => ({
      width: 64, height: 64,
      getContext: () => ({
        fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
        putImageData() {}
      })
    })
  },
  window: {},
  performance: { now: () => Date.now() },
  getTerrainHeight: () => 12.0,
  applyAAARockShader: (m) => m,
  cliffTex: null, cliffNormTex: null, skyEnvCubeTex: null,
  sharedBoulderMat: null, waterfallMaterials: [], scene: null,
  MOUNT_CALDERA: { x: -302.0, z: 64.0, baseR: 112.0, rimR: 36.0, poolEdgeR: 26.5, rimY: 168.0, floorY: 146.5, lavaY: 155.5, footY: 12.0 },
  MOUNT_SPINE: { x: 0, z: 0 }
};
sandbox.window = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);
vm.runInContext(threeCode, sandbox);
sandbox.scene = new sandbox.THREE.Scene();
sandbox.window.wfTex = new sandbox.THREE.Texture();

vm.runInContext(`
${exactPolySrc}
${exactSmoothSrc}
${exactNoiseSrc}
${exactCaveDefsSrc}
${exactRockSrc}
${exactCaveSysSrc}
buildCaveBranchGraphs();
`, sandbox);

(async function main() {
  await sandbox.createHillsideCaveSystems(null);

  const THREE = sandbox.THREE;
  const CAVE_SYSTEMS = sandbox.CAVE_SYSTEMS;
  const getCaveNavigationInfo = sandbox.getCaveNavigationInfo;
  const instancedColliders = sandbox.window.instancedRockColliders || [];
  const activeBoulders = sandbox.window.activeBoulders || [];

  // Build spatial grid (4m XZ cells) of ALL solid cave triangles for <100ms total raycast execution
  const CELL = 4.0;
  const triGrid = new Map();
  const tris = []; // { ax, ay, az, bx, by, bz, cx, cy, cz, role }

  function addTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, role) {
    const idx = tris.length;
    tris.push({ ax, ay, az, bx, by, bz, cx, cy, cz, role });
    const minX = Math.floor(Math.min(ax, bx, cx) / CELL);
    const maxX = Math.floor(Math.max(ax, bx, cx) / CELL);
    const minZ = Math.floor(Math.min(az, bz, cz) / CELL);
    const maxZ = Math.floor(Math.max(az, bz, cz) / CELL);
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gz = minZ; gz <= maxZ; gz++) {
        const key = `${gx},${gz}`;
        let arr = triGrid.get(key);
        if (!arr) { arr = []; triGrid.set(key, arr); }
        arr.push(idx);
      }
    }
  }

  function addGeometryTriangles(geo, matrixWorld, role) {
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    const pos = geo.attributes.position;
    const index = geo.index;
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const triCount = index ? (index.count / 3) : (pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      vA.fromBufferAttribute(pos, i0);
      vB.fromBufferAttribute(pos, i1);
      vC.fromBufferAttribute(pos, i2);
      if (matrixWorld) {
        vA.applyMatrix4(matrixWorld);
        vB.applyMatrix4(matrixWorld);
        vC.applyMatrix4(matrixWorld);
      }
      addTriangle(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z, role);
    }
  }

  for (const entry of sandbox.window.caveInteriorEntries) {
    if (entry.tunnelMesh) {
      entry.tunnelMesh.updateMatrixWorld(true);
      addGeometryTriangles(entry.tunnelMesh.geometry, entry.tunnelMesh.matrixWorld, `${entry.cave.id}:mainWall`);
    }
    if (entry.branchMeshes) {
      let bIdx = 0;
      for (const bm of entry.branchMeshes) {
        if (bm.geometry && bm.geometry.attributes && bm.geometry.attributes.aRockCrevice) {
          bm.updateMatrixWorld(true);
          const tag = (bm.userData && bm.userData.branchId)
            ? `branch:${bm.userData.branchId}`
            : (bm.userData && bm.userData.isOasisRock ? `${entry.cave.id}:oasisRock` : `${entry.cave.id}:branchMesh#${bIdx}`);
          addGeometryTriangles(bm.geometry, bm.matrixWorld, tag);
          bIdx++;
        }
      }
    }
  }

  const instancedNamed = [
    ['speleoMesh', sandbox.window.caveSpeleoMesh],
    ['columnMesh', sandbox.window.caveColumnMesh],
    ['cragMesh', sandbox.window.caveCragMesh],
    ['boulderMesh', sandbox.window.caveBoulderMesh],
    ['rubbleMesh', sandbox.window.caveRubbleMesh],
    ['lavacicleMesh', sandbox.window.caveLavacicleMesh],
    ['draperyMesh', sandbox.window.caveDraperyMesh]
  ];
  const instMat = new THREE.Matrix4();
  for (const [role, m] of instancedNamed) {
    if (!m || m.count <= 0) continue;
    m.updateMatrixWorld(true);
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, instMat);
      addGeometryTriangles(m.geometry, instMat, role);
    }
  }
  for (const b of activeBoulders) {
    if (b.userData && b.userData.isCaveArch) continue;
    b.updateMatrixWorld(true);
    addGeometryTriangles(b.geometry, b.matrixWorld, 'entranceBoulder');
  }

  // Möller–Trumbore double-sided segment intersection against spatial grid
  function raycastSegment(p0, p1) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    const maxD = Math.hypot(dx, dy, dz);
    if (maxD < 1e-5) return null;
    const invD = 1.0 / maxD;
    const dirX = dx * invD, dirY = dy * invD, dirZ = dz * invD;

    const minGX = Math.floor(Math.min(p0.x, p1.x) / CELL);
    const maxGX = Math.floor(Math.max(p0.x, p1.x) / CELL);
    const minGZ = Math.floor(Math.min(p0.z, p1.z) / CELL);
    const maxGZ = Math.floor(Math.max(p0.z, p1.z) / CELL);

    let bestT = Infinity;
    let bestRole = null;
    const checked = new Set();

    for (let gx = minGX; gx <= maxGX; gx++) {
      for (let gz = minGZ; gz <= maxGZ; gz++) {
        const bucket = triGrid.get(`${gx},${gz}`);
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const tid = bucket[bi];
          if (checked.has(tid)) continue;
          checked.add(tid);
          const tr = tris[tid];

          const e1x = tr.bx - tr.ax, e1y = tr.by - tr.ay, e1z = tr.bz - tr.az;
          const e2x = tr.cx - tr.ax, e2y = tr.cy - tr.ay, e2z = tr.cz - tr.az;
          const hx = dirY * e2z - dirZ * e2y;
          const hy = dirZ * e2x - dirX * e2z;
          const hz = dirX * e2y - dirY * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          if (a > -1e-7 && a < 1e-7) continue;
          const f = 1.0 / a;
          const sx = p0.x - tr.ax, sy = p0.y - tr.ay, sz = p0.z - tr.az;
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < 0.0 || u > 1.0) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = f * (dirX * qx + dirY * qy + dirZ * qz);
          if (v < 0.0 || u + v > 1.0) continue;
          const t = f * (e2x * qx + e2y * qy + e2z * qz);
          if (t >= 0.005 && t <= maxD && t < bestT) {
            bestT = t;
            bestRole = tr.role;
          }
        }
      }
    }
    if (!bestRole) return null;
    return {
      role: bestRole,
      dist: bestT,
      point: { x: p0.x + dirX * bestT, y: p0.y + dirY * bestT, z: p0.z + dirZ * bestT }
    };
  }

  const PLAYER_R = 0.45;
  function testColliderClearance(x, y, z) {
    const hits = [];
    for (let i = 0; i < instancedColliders.length; i++) {
      const c = instancedColliders[i];
      if (y + 1.65 < c.minY || y >= c.maxY) continue;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.r + PLAYER_R) {
        hits.push({ idx: i, cx: c.x, cy: c.y, cz: c.z, r: c.r, pen: (c.r + PLAYER_R - d) });
      }
    }
    return hits;
  }

  const junctionReports = [];
  const pathFailures = [];

  for (let c = 0; c < CAVE_SYSTEMS.length; c++) {
    const cave = CAVE_SYSTEMS[c];

    // 1. Main spine walkthrough from entrance mouth s=0.01 to deep chamber s=0.91 in ~1.2m steps
    const mainSteps = Math.max(80, Math.round(cave.length / 1.2));
    let prevFloor = null;
    let prevEffPt = null;
    for (let ms = 0; ms <= mainSteps; ms++) {
      const s = (ms / mainSteps) * 0.91;
      const pt = cave.getPoint(s);
      const nav = getCaveNavigationInfo(pt.x, pt.z, pt.floorY);
      const effFloor = nav ? nav.floorY : pt.floorY;
      const head = nav ? (nav.ceilY - effFloor) : (pt.ceilY - pt.floorY);
      if (head < 1.95) pathFailures.push(`${cave.id} main s=${s.toFixed(3)}: low headroom ${head.toFixed(2)}m`);
      if (prevFloor !== null) {
        const segLen = Math.hypot(pt.x - prevEffPt.x, pt.z - prevEffPt.z);
        const stepPerHalfM = Math.abs(effFloor - prevFloor) / Math.max(1.0, segLen / 0.5);
        if (stepPerHalfM > 0.45) {
          pathFailures.push(`${cave.id} main s=${s.toFixed(3)}: steep step ${stepPerHalfM.toFixed(2)}m/0.5m`);
        }
      }
      const cols = testColliderClearance(pt.x, effFloor, pt.z);
      if (cols.length > 0) {
        pathFailures.push(`${cave.id} main s=${s.toFixed(3)}: collider overlap at spine (${pt.x.toFixed(1)}, ${pt.z.toFixed(1)}) pen=${cols[0].pen.toFixed(2)}m`);
      }
      if (prevEffPt && s > 0.015) {
        for (const latOff of [-0.40, 0.0, 0.40]) {
          for (const hOff of [0.38, 0.95, 1.55]) {
            const hit = raycastSegment(
              { x: prevEffPt.x + prevEffPt.perpX * latOff, y: prevFloor + hOff, z: prevEffPt.z + prevEffPt.perpZ * latOff },
              { x: pt.x + pt.perpX * latOff, y: effFloor + hOff, z: pt.z + pt.perpZ * latOff }
            );
            if (hit) {
              pathFailures.push(`${cave.id} main s=${s.toFixed(3)} (lat=${latOff}, h=${hOff}): MESH HIT ${hit.role} at (${hit.point.x.toFixed(1)}, ${hit.point.y.toFixed(1)}, ${hit.point.z.toFixed(1)})`);
            }
          }
        }
      }
      prevFloor = effFloor;
      prevEffPt = pt;
    }

    // 2. Branch, Squeeze, Loop & Inter-Cave Aqueduct walkthrough + Both-End Junction Aperture Audits
    for (const br of cave.branches) {
      const samp = br.samples;
      const endLim = br.isLoop ? samp.length - 1 : Math.floor(samp.length * 0.90);
      let bPrevY = null;
      let bPrevX = null, bPrevZ = null, bPrevPX = null, bPrevPZ = null;
      for (let i = 0; i <= endLim; i++) {
        const sp = samp[i];
        const nav = getCaveNavigationInfo(sp.x, sp.z, bPrevY !== null ? bPrevY : sp.floorY);
        const effFloor = nav ? nav.floorY : sp.floorY;
        const head = nav ? (nav.ceilY - effFloor) : sp.ceilH;
        if (head < 1.85) pathFailures.push(`${br.id} i=${i}: low headroom ${head.toFixed(2)}m`);
        if (bPrevY !== null) {
          const segDist = Math.hypot(sp.x - bPrevX, sp.z - bPrevZ);
          const stepHalfM = Math.abs(effFloor - bPrevY) / Math.max(1.0, segDist / 0.5);
          if (stepHalfM > 0.45) {
            pathFailures.push(`${br.id} i=${i}: steep step ${stepHalfM.toFixed(2)}m/0.5m (from ${bPrevY.toFixed(2)} to ${effFloor.toFixed(2)})`);
          }
          if (i >= 2 && i < endLim) {
            for (const latOff of [-0.38, 0.0, 0.38]) {
              for (const hOff of [0.38, 0.95, 1.50]) {
                const hit = raycastSegment(
                  { x: bPrevX + bPrevPX * latOff, y: bPrevY + hOff, z: bPrevZ + bPrevPZ * latOff },
                  { x: sp.x + sp.perpX * latOff, y: effFloor + hOff, z: sp.z + sp.perpZ * latOff }
                );
                if (hit) {
                  pathFailures.push(`${br.id} seg i=${i} (lat=${latOff}, h=${hOff}): MESH HIT ${hit.role} at (${hit.point.x.toFixed(1)}, ${hit.point.y.toFixed(1)}, ${hit.point.z.toFixed(1)})`);
                }
              }
            }
            const cols = testColliderClearance(sp.x, effFloor, sp.z);
            if (cols.length > 0) {
              pathFailures.push(`${br.id} i=${i}: collider overlap pen=${cols[0].pen.toFixed(2)}m at (${sp.x.toFixed(1)}, ${sp.z.toFixed(1)})`);
            }
          }
        }
        bPrevY = effFloor;
        bPrevX = sp.x; bPrevZ = sp.z; bPrevPX = sp.perpX; bPrevPZ = sp.perpZ;
      }

      const junctions = [
        { label: `${br.id} [START @ ${cave.id} s=${br.parentS}]`, idxStart: 0, stepDir: 1 }
      ];
      if (br.isLoop) {
        const hostC = br.isInterCave ? CAVE_SYSTEMS[br.targetCaveIdx] : cave;
        const hostS = br.isInterCave ? br.targetS : br.reconnectS;
        junctions.push({ label: `${br.id} [END @ ${hostC.id} s=${hostS}]`, idxStart: samp.length - 1, stepDir: -1 });
      }

      for (const jn of junctions) {
        const issues = [];
        let enteredBranchNav = false;
        let clampFail = null;
        let maxStepDelta = 0.0;
        let minHeadroom = Infinity;

        // Precompute center-lane walkable nav floor sequence across the junction throat (15 samples deep)
        const centerFloors = [];
        let trackY = samp[jn.idxStart].floorY;
        for (let step = 0; step <= 15; step++) {
          const idx = jn.idxStart + jn.stepDir * step;
          const pt = samp[idx];
          const nav = getCaveNavigationInfo(pt.x, pt.z, trackY);
          const fl = nav ? nav.floorY : pt.floorY;
          const hd = nav ? (nav.ceilY - fl) : pt.ceilH;
          if (hd < minHeadroom) minHeadroom = hd;
          if (step > 0) {
            const dXZ = Math.hypot(pt.x - samp[idx - jn.stepDir].x, pt.z - samp[idx - jn.stepDir].z);
            const perHalfM = Math.abs(fl - trackY) / Math.max(1.0, dXZ / 0.5);
            if (perHalfM > maxStepDelta) maxStepDelta = perHalfM;
          }
          if (nav && nav.branch && nav.branch.id === br.id) enteredBranchNav = true;
          if (nav && (nav.s > 0.020 || nav.branch) && !nav.inPortalMouth) {
            const maxWalkLat = Math.max(0.42, nav.halfW - 0.45);
            if (Math.abs(nav.lateral) > maxWalkLat) {
              clampFail = `step=${step} lat=${nav.lateral.toFixed(2)}>${maxWalkLat.toFixed(2)} (${nav.branch ? nav.branch.id : nav.cave.id})`;
            }
          }
          centerFloors.push(fl);
          trackY = fl;
        }
        if (maxStepDelta > 0.45) issues.push(`STEEP THRESHOLD STEP ${maxStepDelta.toFixed(2)}m/0.5m`);

        for (const latOff of [-0.85, -0.45, 0.0, 0.45, 0.85]) {
          let blockedMsg = null;
          for (let step = 0; step < 15; step++) {
            const i0 = jn.idxStart + jn.stepDir * step;
            const i1 = jn.idxStart + jn.stepDir * (step + 1);
            const a = samp[i0], b = samp[i1];
            const ax0 = a.x + a.perpX * latOff, az0 = a.z + a.perpZ * latOff;
            const ax1 = b.x + b.perpX * latOff, az1 = b.z + b.perpZ * latOff;
            const fl0 = centerFloors[step];
            const fl1 = centerFloors[step + 1];

            for (const hOff of [0.35, 0.72, 1.15, 1.60]) {
              const hit = raycastSegment(
                { x: ax0, y: fl0 + hOff, z: az0 },
                { x: ax1, y: fl1 + hOff, z: az1 }
              );
              if (hit) {
                blockedMsg = `MESH ${hit.role} @ step=${step},h=${hOff} (${hit.point.x.toFixed(1)},${hit.point.y.toFixed(1)},${hit.point.z.toFixed(1)})`;
                break;
              }
            }
            if (blockedMsg) break;

            if (Math.abs(latOff) <= 0.46) {
              const cols = testColliderClearance(ax0, fl0, az0);
              if (cols.length > 0) {
                blockedMsg = `COLLIDER @ step=${step} pen=${cols[0].pen.toFixed(2)}m (${cols[0].cx.toFixed(1)},${cols[0].cz.toFixed(1)})`;
                break;
              }
            }
          }
          if (blockedMsg) {
            issues.push(`lane[${latOff.toFixed(2)}]: ${blockedMsg}`);
          }
        }
        if (!enteredBranchNav) issues.push('NAV NEVER ENTERED BRANCH');
        if (clampFail) issues.push(`NAV CLAMP: ${clampFail}`);

        const sMid = samp[jn.idxStart + jn.stepDir * 4];
        junctionReports.push({
          label: jn.label,
          pos: `(${sMid.x.toFixed(1)}, ${centerFloors[4].toFixed(1)}, ${sMid.z.toFixed(1)}) head>=${minHeadroom.toFixed(1)}m step<=${maxStepDelta.toFixed(2)}m`,
          passed: issues.length === 0,
          issues
        });
      }
    }
  }

  console.log(`=== CALDERA CASTAWAY AUTOMATED 3D CAVE PLAYTEST REPORT (${tris.length} triangles indexed) ===`);
  let failCount = 0;
  for (const jr of junctionReports) {
    if (jr.passed) {
      console.log(`PASS  ${jr.label} @ ${jr.pos}`);
    } else {
      failCount++;
      console.log(`FAIL  ${jr.label} @ ${jr.pos}`);
      for (const iss of jr.issues) {
        console.log(`      -> ${iss}`);
      }
    }
  }
  console.log(`\nInline Path/Clearance Warnings: ${pathFailures.length}`);
  for (const pf of pathFailures) {
    console.log(`  WARN: ${pf}`);
  }
  console.log(`\nSummary: ${junctionReports.length - failCount}/${junctionReports.length} junctions passed, ${pathFailures.length} path checks flagged.`);
  process.exit(failCount > 0 || pathFailures.length > 0 ? 1 : 0);
})();
