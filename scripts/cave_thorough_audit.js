#!/usr/bin/env node
/**
 * Thorough 3D Cave Walkthrough Audit for Caldera Castaway:
 *  1. Head/Body Wall & Ceiling Clipping (actual displaced 3D mesh vs player collision clamp)
 *  2. Cave Wall Gaps & Outside-World Leaks (360° spherical raycasting through all cave + terrain triangles)
 *  3. Boring Long Passages & Instanced Prop Pool Exhaustion Analysis
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

const terrainBlockStart = lines.findIndex(l => l.includes('const terrainSize = 1200;'));
const terrainBlockEnd = lines.findIndex((l, i) => i > terrainBlockStart && l.includes('const terrainMat = new THREE.MeshStandardMaterial'));
const exactTerrainSrc = lines.slice(terrainBlockStart, terrainBlockEnd).join('\n');

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
  applyAAARockShader: (m) => m,
  setBootProgress: () => {},
  cliffTex: null, cliffNormTex: null, skyEnvCubeTex: null,
  sharedBoulderMat: null, waterfallMaterials: [], scene: null,
  terrainMat: null, terrainMesh: null
};
sandbox.window = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);
vm.runInContext(threeCode, sandbox);
sandbox.scene = new sandbox.THREE.Scene();
sandbox.terrainMat = new sandbox.THREE.MeshStandardMaterial();
sandbox.window.wfTex = new sandbox.THREE.Texture();

// Extract island/archipelago constants if defined before terrainSize
const archStart = lines.findIndex(l => l.includes('const archipelagoIslets'));
let archSrc = '';
if (archStart !== -1 && archStart < terrainBlockStart) {
  const archEnd = lines.findIndex((l, i) => i > archStart && l.trim() === '];');
  archSrc = lines.slice(archStart, archEnd + 1).join('\n');
}

vm.runInContext(`
${exactPolySrc}
${exactSmoothSrc}
${archSrc}
${exactTerrainSrc}
${exactRockSrc}
${exactCaveSysSrc}
`, sandbox);

(async function main() {
  await sandbox.buildTerrainGeometryAsync(null);
  await sandbox.createHillsideCaveSystems(null);

  const THREE = sandbox.THREE;
  const CAVE_SYSTEMS = sandbox.CAVE_SYSTEMS;
  const getCaveNavigationInfo = sandbox.getCaveNavigationInfo;
  const getTerrainHeight = sandbox.getTerrainHeight;

  // Build spatial grid (4m XZ cells) separating cave shell vs props vs terrain
  const CELL = 4.0;
  const triGrid = new Map();
  const tris = []; // { ax,ay,az, bx,by,bz, cx,cy,cz, cat, tag }

  function addTri(ax, ay, az, bx, by, bz, cx, cy, cz, cat, tag) {
    const idx = tris.length;
    tris.push({ ax, ay, az, bx, by, bz, cx, cy, cz, cat, tag });
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

  function addGeometryTriangles(geo, matrixWorld, cat, tag) {
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < arr.length; i += 3) {
        vA.fromBufferAttribute(pos, arr[i]).applyMatrix4(matrixWorld);
        vB.fromBufferAttribute(pos, arr[i + 1]).applyMatrix4(matrixWorld);
        vC.fromBufferAttribute(pos, arr[i + 2]).applyMatrix4(matrixWorld);
        addTri(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z, cat, tag);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        vA.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
        vB.fromBufferAttribute(pos, i + 1).applyMatrix4(matrixWorld);
        vC.fromBufferAttribute(pos, i + 2).applyMatrix4(matrixWorld);
        addTri(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z, cat, tag);
      }
    }
  }

  // Index cave meshes & track prop positions for density audit
  const caveRoot = sandbox.window.hillsideCaveRoot;
  caveRoot.updateMatrixWorld(true);
  const instancedProps = []; // { x, y, z, kind }
  const propMap = new Map([
    [sandbox.window.caveSpeleoMesh, 'speleo'],
    [sandbox.window.caveColumnMesh, 'column'],
    [sandbox.window.caveDraperyMesh, 'drapery'],
    [sandbox.window.caveRimstoneMesh, 'rimstone'],
    [sandbox.window.caveLavacicleMesh, 'lavacicle'],
    [sandbox.window.caveCrystalMesh, 'crystal'],
    [sandbox.window.caveRubbleMesh, 'rubble'],
    [sandbox.window.caveBoulderMesh, 'boulder'],
    [sandbox.window.caveCragMesh, 'crag']
  ]);

  const caveEntries = sandbox.window.caveInteriorEntries || [];
  const shellMeshes = new Set();
  for (const ce of caveEntries) {
    if (ce.tunnelMesh) shellMeshes.add(ce.tunnelMesh);
    for (const bm of (ce.branchMeshes || [])) {
      if (bm.geometry && bm.geometry.attributes && bm.geometry.attributes.aRockCrevice) {
        shellMeshes.add(bm); // branch tubes + skylight chimneys
      }
    }
  }

  const instMat = new THREE.Matrix4();
  const worldMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();

  caveRoot.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.material && obj.material.transparent) return; // skip water pools / shafts / waterfall ribbons
    if (obj.isInstancedMesh) {
      const kind = propMap.get(obj) || 'inst';
      for (let i = 0; i < obj.count; i++) {
        obj.getMatrixAt(i, instMat);
        worldMat.multiplyMatrices(obj.matrixWorld, instMat);
        tmpPos.setFromMatrixPosition(worldMat);
        instancedProps.push({ x: tmpPos.x, y: tmpPos.y, z: tmpPos.z, kind });
        // Only add solid rock formations/crags/boulders/columns to gap blocker raycast
        if (kind === 'crag' || kind === 'boulder' || kind === 'column' || kind === 'rubble') {
          addGeometryTriangles(obj.geometry, worldMat, 'rock_prop', kind);
        }
      }
    } else {
      const isShell = shellMeshes.has(obj) || (obj.geometry.attributes && obj.geometry.attributes.aRockCrevice);
      const tag = (obj.userData && obj.userData.branchId) ? obj.userData.branchId : (isShell ? 'cave_shell' : 'portal_rock');
      addGeometryTriangles(obj.geometry, obj.matrixWorld, isShell ? 'cave_shell' : 'portal_rock', tag);
    }
  });

  // Index terrain triangles only near cave regions (saves memory & time)
  const terrainMesh = sandbox.terrainMesh;
  terrainMesh.updateMatrixWorld(true);
  {
    const geo = terrainMesh.geometry;
    const pos = geo.attributes.position;
    const arr = geo.index.array;
    const caveBounds = [];
    for (const cv of CAVE_SYSTEMS) {
      for (let s = 0; s <= 1.0; s += 0.05) {
        const p = cv.getPoint(s);
        caveBounds.push({ x: p.x, z: p.z, r: p.halfW + 30 });
      }
      for (const br of cv.branches) {
        caveBounds.push({
          x: (br.bbox.minX + br.bbox.maxX) * 0.5,
          z: (br.bbox.minZ + br.bbox.maxZ) * 0.5,
          r: Math.hypot(br.bbox.maxX - br.bbox.minX, br.bbox.maxZ - br.bbox.minZ) * 0.5 + 20
        });
      }
    }
    let terrTris = 0;
    for (let i = 0; i < arr.length; i += 3) {
      const i0 = arr[i], i1 = arr[i + 1], i2 = arr[i + 2];
      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
      const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
      const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
      let near = false;
      for (let k = 0; k < caveBounds.length; k++) {
        const cb = caveBounds[k];
        if (Math.abs(mx - cb.x) < cb.r && Math.abs(mz - cb.z) < cb.r) { near = true; break; }
      }
      if (near) {
        addTri(ax, ay, az, bx, by, bz, cx, cy, cz, 'terrain', 'terrain');
        terrTris++;
      }
    }
    console.log(`Indexed ${tris.length} total triangles (${terrTris} near-cave terrain tris, ${tris.length - terrTris} cave/rock tris).`);
  }

  // Ray-triangle Möller–Trumbore (double-sided)
  function rayTri(ox, oy, oz, dx, dy, dz, tObj, maxDist) {
    const e1x = tObj.bx - tObj.ax, e1y = tObj.by - tObj.ay, e1z = tObj.bz - tObj.az;
    const e2x = tObj.cx - tObj.ax, e2y = tObj.cy - tObj.ay, e2z = tObj.cz - tObj.az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-7 && det < 1e-7) return -1;
    const invDet = 1.0 / det;
    const tx = ox - tObj.ax, ty = oy - tObj.ay, tz = oz - tObj.az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0.0 || u > 1.0) return -1;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0.0 || u + v > 1.0) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t > 0.002 && t <= maxDist) return t;
    return -1;
  }

  const testedStamp = new Int32Array(tris.length);
  let curStamp = 0;

  function castRay(ox, oy, oz, dx, dy, dz, maxDist, catFilter = null) {
    curStamp++;
    const step = 2.0;
    const steps = Math.ceil(maxDist / step);
    let bestT = Infinity;
    let bestTri = null;
    let lastGx = -999999, lastGz = -999999;
    for (let s = 0; s <= steps; s++) {
      const distAlong = Math.min(maxDist, s * step);
      if (distAlong > bestT + CELL * 1.5) break;
      const sx = ox + dx * distAlong;
      const sz = oz + dz * distAlong;
      const gx = Math.floor(sx / CELL);
      const gz = Math.floor(sz / CELL);
      if (gx === lastGx && gz === lastGz) continue;
      lastGx = gx; lastGz = gz;
      for (let oxG = -1; oxG <= 1; oxG++) {
        for (let ozG = -1; ozG <= 1; ozG++) {
          const arr = triGrid.get(`${gx + oxG},${gz + ozG}`);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const idx = arr[i];
            if (testedStamp[idx] === curStamp) continue;
            testedStamp[idx] = curStamp;
            const tr = tris[idx];
            if (catFilter && !catFilter(tr.cat)) continue;
            const t = rayTri(ox, oy, oz, dx, dy, dz, tr, Math.min(maxDist, bestT));
            if (t > 0 && t < bestT) {
              bestT = t;
              bestTri = tr;
            }
          }
        }
      }
    }
    return bestTri ? { dist: bestT, tri: bestTri } : null;
  }

  // Helper: check if a ray heading out toward open sky is legitimately through a skylight or front entrance
  function isIntentionalOpeningRay(ox, oy, oz, dx, dy, dz, hostCave) {
    // 1. Exiting out the cave mouth (front portal at s=0)
    const d0 = (ox - hostCave.px) * hostCave.dirX + (oz - hostCave.pz) * hostCave.dirZ;
    const dotBack = -(dx * hostCave.dirX + dz * hostCave.dirZ); // positive if looking toward mouth
    if (d0 < 36.0 && dotBack > 0.25) {
      // Intersect ray with mouth plane (distAlong = 0)
      const denom = dx * hostCave.dirX + dz * hostCave.dirZ;
      if (denom < -0.05) {
        const tPlane = -d0 / denom;
        if (tPlane > 0 && tPlane < 55.0) {
          const hx = ox + dx * tPlane;
          const hy = oy + dy * tPlane;
          const hz = oz + dz * tPlane;
          const lat = Math.abs((hx - hostCave.px) * hostCave.perpX + (hz - hostCave.pz) * hostCave.perpZ);
          const pt0 = hostCave.getPoint(0);
          if (lat <= pt0.halfW + 1.5 && hy >= pt0.floorY - 0.8 && hy <= pt0.ceilY + 1.5) {
            return 'front_portal';
          }
        }
      }
    }
    // 2. Looking up through a defined skylight opening
    if (dy > 0.15) {
      for (const cv of CAVE_SYSTEMS) {
        for (const sk of (cv.skylights || [])) {
          const skPt = cv.getPoint(sk.s);
          const tCeil = (skPt.ceilY - oy) / dy;
          if (tCeil > 0 && tCeil < 45.0) {
            const hx = ox + dx * tCeil;
            const hz = oz + dz * tCeil;
            if (Math.hypot(hx - skPt.x, hz - skPt.z) <= (sk.radius || 4.4) * 1.18) {
              return 'skylight';
            }
          }
        }
      }
    }
    return null;
  }

  // =========================================================================
  // AUDIT 1: HEAD/WALL & CEILING CLIPPING WALKTHROUGH
  // =========================================================================
  console.log('\n====================================================================');
  console.log('AUDIT 1: PLAYER WALL & CEILING HEAD-CLIPPING WALKTHROUGH');
  console.log('====================================================================');

  const CAM_NEAR_PAD = 0.22; // 0.15m near plane + slight oblique view margin
  const EYE_H = 1.88;

  const clipSummary = [];

  function auditRouteClipping(routeId, cave, branch, points) {
    let wallClipCount = 0;
    let maxWallClip = 0;
    let worstWallInfo = null;
    let ceilClipAtEdgeCount = 0;
    let maxCeilClip = 0;
    let worstCeilInfo = null;
    let unClampedMouthStations = 0;
    let roofAboveTerrainCount = 0;
    let maxRoofPoke = 0;
    const clipZones = []; // contiguous stretches

    let inClipRun = false;
    let runStart = null;
    let runMax = 0;

    for (let idx = 0; idx < points.length; idx++) {
      const p = points[idx];
      // Respect runtime dead-end dome stops (player cannot walk past maxS / maxBranchT into closed dome)
      if (!branch && p.t > (cave.isLavaTube ? 0.925 : 0.935)) continue;
      if (branch && !branch.isLoop && p.t > 0.910) continue;

      const nav = getCaveNavigationInfo(p.x, p.z, p.floorY + 0.5);
      if (!nav) continue;

      // Exact game wall & curved-ceiling envelope rule (index.html)
      const headClearance = nav.ceilY - nav.floorY;
      let targetEyeH = EYE_H;
      if (nav.isSqueeze || headClearance < 2.65) {
        targetEyeH = Math.min(1.88, Math.max(1.05, headClearance - 0.36));
      }
      const eyeY = nav.floorY + targetEyeH;
      const env = sandbox.window.evalCaveSafeEnvelope(nav, eyeY, 0.44);

      // Check terrain overburden cover above ceiling
      const terrH = getTerrainHeight(p.x, p.z);
      const isNearSkylight = (cave.skylights || []).some(sk => {
        const sp = cave.getPoint(sk.s);
        return Math.hypot(p.x - sp.x, p.z - sp.z) < (sk.radius || 4.4) + 2.5;
      });
      if (!isNearSkylight && p.distM > 6.0 && p.ceilY > terrH - 0.25) {
        roofAboveTerrainCount++;
        const poke = p.ceilY - terrH;
        if (poke > maxRoofPoke) maxRoofPoke = poke;
      }

      if (nav.openPortalLeft && nav.openPortalRight && p.distM > 1.5 && p.t > 0.05 && p.t < 0.94) {
        unClampedMouthStations++;
      }

      // Check left (-1) and right (+1) actual 3D mesh wall distance at eyeY vs exact safe envelope bound
      let stationMaxPen = 0;
      let stationSide = 0;
      for (const side of [-1, 1]) {
        const onJunctionSide = !branch && (cave.junctionPortals || []).some(jp =>
          Math.abs(p.t - jp.s) < 0.065 && jp.side === side
        );
        if (onJunctionSide) continue;
        if (branch && (p.t < 0.05 || (branch.isLoop && p.t > 0.95))) continue;

        const isSideOpen = (side > 0) ? !!nav.openPortalRight : !!nav.openPortalLeft;
        const allowedLatSigned = (side > 0) ? env.maxLat : env.minLat;
        const allowedDist = isSideOpen ? (p.halfW + 1.2) : Math.max(0.0, side * allowedLatSigned);

        const rdx = p.perpX * side, rdz = p.perpZ * side;
        const hit = castRay(p.x, eyeY, p.z, rdx, 0, rdz, p.halfW * 2.2, c => c === 'cave_shell');
        if (hit) {
          const pen = (allowedDist + CAM_NEAR_PAD) - hit.dist;
          if (pen > 0.08) {
            if (pen > stationMaxPen) {
              stationMaxPen = pen;
              stationSide = side;
            }
          }
        }

        // Also check ceiling height right at the clamped wall edge!
        // Start upward ray strictly above the actual raised wall-edge floor (talus ramp) so it tests the CEILING, not the floor beneath it
        const ex = p.x + p.perpX * allowedLatSigned;
        const ez = p.z + p.perpZ * allowedLatSigned;
        const edgeNav = getCaveNavigationInfo(ex, ez, nav.floorY + 1.0);
        const edgeFloorY = (edgeNav && edgeNav.floorY !== undefined) ? Math.max(nav.floorY, edgeNav.floorY) : nav.floorY;
        const edgeEyeY = edgeFloorY + targetEyeH;
        const rayStartY = edgeFloorY + 0.45;
        const upHit = castRay(ex, rayStartY, ez, 0, 1, 0, p.ceilH + 6.0, c => c === 'cave_shell');
        if (upHit) {
          const actualEdgeCeilY = rayStartY + upHit.dist;
          // Apply the exact same curved ceiling clamp the game applies (Math.min(nav.ceilY, env.ceilAtLat) - targetEyeH - 0.24)
          const clampedEdgeEyeY = Math.min(edgeEyeY, Math.min(nav.ceilY, env.ceilAtLat) - 0.24);
          const headPen = (clampedEdgeEyeY + CAM_NEAR_PAD) - actualEdgeCeilY;
          if (headPen > 0.08) {
            ceilClipAtEdgeCount++;
            if (headPen > maxCeilClip) {
              maxCeilClip = headPen;
              worstCeilInfo = { t: p.t, distM: p.distM, x: ex, y: clampedEdgeEyeY, z: ez, actualCeil: actualEdgeCeilY, headY: clampedEdgeEyeY, side };
            }
          }
        }
      }

      if (stationMaxPen > 0.08) {
        wallClipCount++;
        if (stationMaxPen > maxWallClip) {
          maxWallClip = stationMaxPen;
          worstWallInfo = { t: p.t, distM: p.distM, x: p.x, y: eyeY, z: p.z, halfW: p.halfW, maxWalkLat: env.maxLat, side: stationSide, pen: stationMaxPen };
        }
        if (!inClipRun) {
          inClipRun = true;
          runStart = p.t;
          runMax = stationMaxPen;
        } else if (stationMaxPen > runMax) {
          runMax = stationMaxPen;
        }
      } else if (inClipRun) {
        clipZones.push({ fromT: runStart, toT: points[idx - 1].t, maxPen: runMax });
        inClipRun = false;
      }
    }
    if (inClipRun) {
      clipZones.push({ fromT: runStart, toT: points[points.length - 1].t, maxPen: runMax });
    }

    clipSummary.push({
      routeId, totalStations: points.length,
      wallClipCount, maxWallClip, worstWallInfo,
      ceilClipAtEdgeCount, maxCeilClip, worstCeilInfo,
      unClampedMouthStations, roofAboveTerrainCount, maxRoofPoke, clipZones
    });

    const pctWall = ((wallClipCount / Math.max(1, points.length)) * 100).toFixed(0);
    console.log(
      `[${routeId}] WallClip: ${wallClipCount}/${points.length} stations (${pctWall}%) maxPen=${maxWallClip.toFixed(2)}m` +
      (worstWallInfo ? ` @ s/t=${worstWallInfo.t.toFixed(2)} (${worstWallInfo.x.toFixed(1)},${worstWallInfo.z.toFixed(1)}) side=${worstWallInfo.side}` : '') +
      ` | EdgeCeilClip: ${ceilClipAtEdgeCount} maxPen=${maxCeilClip.toFixed(2)}m` +
      (unClampedMouthStations > 0 ? ` | UnclampedPortalStations=${unClampedMouthStations}` : '') +
      (roofAboveTerrainCount > 0 ? ` | ROOF_POKE_TERRAIN=${roofAboveTerrainCount} (max +${maxRoofPoke.toFixed(2)}m)` : '')
    );
  }

  // Build uniform ~2m station lists for every main cave & branch
  const allRoutes = [];
  for (const cv of CAVE_SYSTEMS) {
    const pts = [];
    const steps = Math.max(20, Math.round(cv.length / 2.0));
    for (let i = 1; i <= steps - 1; i++) {
      const s = i / steps;
      const p = cv.getPoint(s);
      pts.push({ ...p, t: s, distM: s * cv.length });
    }
    allRoutes.push({ id: cv.id, cave: cv, branch: null, length: cv.length, points: pts });
    for (const br of cv.branches) {
      const bPts = [];
      for (let i = 1; i < br.samples.length - 1; i++) {
        const sp = br.samples[i];
        bPts.push({ ...sp, distM: sp.branchDistM !== undefined ? sp.branchDistM : (sp.t * br.length) });
      }
      allRoutes.push({ id: `${cv.id}/${br.id}`, cave: cv, branch: br, length: br.length, points: bPts });
    }
  }

  for (const r of allRoutes) {
    auditRouteClipping(r.id, r.cave, r.branch, r.points);
  }

  // =========================================================================
  // AUDIT 2: 360° WALL GAPS & OUTSIDE-WORLD LEAKS SCANNER
  // =========================================================================
  console.log('\n====================================================================');
  console.log('AUDIT 2: CAVE WALL GAPS & OUTSIDE-WORLD LEAKS (360° RAYCAST AUDIT)');
  console.log('====================================================================');

  // Precompute 24 azimuths x 7 elevations = 168 rays per sample point (elevations -15°..+75°)
  const rayDirs = [];
  const elevDegs = [-12, 0, 12, 26, 42, 58, 74];
  const azCount = 24;
  for (const elD of elevDegs) {
    const el = (elD * Math.PI) / 180;
    const cosE = Math.cos(el), sinE = Math.sin(el);
    for (let a = 0; a < azCount; a++) {
      const az = (a / azCount) * Math.PI * 2;
      rayDirs.push({ dx: Math.cos(az) * cosE, dy: sinE, dz: Math.sin(az) * cosE, elD, azD: Math.round((a / azCount) * 360) });
    }
  }

  const leakClusters = []; // { routeId, label, t, x, y, z, skyLeaks, terrainLeaks, sampleDirs }

  function scanStationLeaks(routeId, cave, label, t, ox, oy, oz) {
    let skyLeaks = 0;
    let terrainLeaks = 0;
    const sampleDirs = [];
    for (let i = 0; i < rayDirs.length; i++) {
      const rd = rayDirs[i];
      const hit = castRay(ox, oy, oz, rd.dx, rd.dy, rd.dz, 260.0);
      if (!hit || hit.tri.cat === 'terrain') {
        const intent = isIntentionalOpeningRay(ox, oy, oz, rd.dx, rd.dy, rd.dz, cave);
        if (intent) continue;
        if (!hit) {
          skyLeaks++;
          if (sampleDirs.length < 4) sampleDirs.push(`SKY(az=${rd.azD}°,el=${rd.elD}°)`);
        } else {
          // Ray escaped cave shell and hit outer terrain!
          terrainLeaks++;
          if (sampleDirs.length < 4) sampleDirs.push(`OUTSIDE_TERR(az=${rd.azD}°,el=${rd.elD}°,d=${hit.dist.toFixed(1)}m)`);
        }
      }
    }
    if (skyLeaks + terrainLeaks > 0) {
      leakClusters.push({ routeId, label, t, x: ox, y: oy, z: oz, skyLeaks, terrainLeaks, sampleDirs });
    }
  }

  // Scan every ~4m along every walkable route (stopping at dead-end dome stop where player cannot walk further)
  for (const r of allRoutes) {
    const isDeadEnd = !r.branch || !r.branch.isLoop;
    const maxWalkT = !r.branch ? (r.cave.isLavaTube ? 0.925 : 0.935) : (r.branch.isLoop ? 1.0 : 0.910);
    const walkablePts = r.points.filter(p => p.t <= maxWalkT + 0.005);
    const stride = Math.max(1, Math.round(walkablePts.length / Math.max(12, Math.round(r.length / 4.0))));
    for (let i = 0; i < walkablePts.length; i += stride) {
      const p = walkablePts[i];
      const ey = p.floorY + Math.min(1.80, p.ceilH * 0.65);
      scanStationLeaks(r.id, r.cave, 'corridor', p.t, p.x, ey, p.z);
    }
    // Also explicitly test from the farthest walkable dead-end dome stop looking directly into the closed end cap!
    if (isDeadEnd) {
      const stopP = walkablePts[walkablePts.length - 1];
      if (stopP) {
        const ey = stopP.floorY + Math.min(1.65, stopP.ceilH * 0.55);
        scanStationLeaks(r.id, r.cave, 'end_cap', stopP.t, stopP.x, ey, stopP.z);
      }
    }
  }

  // Explicitly scan EVERY entrance portal (dist = 1.5m, 3.0m, 5.0m, 7.5m inside) & EVERY junction portal!
  for (const cv of CAVE_SYSTEMS) {
    for (const dm of [1.5, 3.0, 5.0, 7.5]) {
      const s = dm / cv.length;
      const p = cv.getPoint(s);
      scanStationLeaks(cv.id, cv, `entrance_${dm}m`, s, p.x, p.floorY + 1.80, p.z);
    }
    for (const jp of (cv.junctionPortals || [])) {
      const ptH = cv.getPoint(jp.s);
      // Scan from host centerline looking into fork, AND right at seam threshold!
      scanStationLeaks(cv.id, cv, `junction_host:${jp.branch.id}`, jp.s, ptH.x, ptH.floorY + 1.80, ptH.z);
      scanStationLeaks(cv.id, cv, `junction_seam:${jp.branch.id}`, jp.s, jp.wx, jp.floorY + 1.80, jp.wz);
      // And 2.5m into branch throat
      scanStationLeaks(cv.id, cv, `junction_throat:${jp.branch.id}`, jp.s, jp.wx + jp.seamOutX * 2.5, jp.floorY + 1.80, jp.wz + jp.seamOutZ * 2.5);
    }
    for (const sk of (cv.skylights || [])) {
      const p = cv.getPoint(sk.s);
      scanStationLeaks(cv.id, cv, `skylight_rim`, sk.s, p.x, p.floorY + 1.85, p.z);
    }
  }

  // Summarize leaks grouped by routeId & label
  const groupedLeaks = new Map();
  for (const lk of leakClusters) {
    const key = `${lk.routeId} | ${lk.label}`;
    if (!groupedLeaks.has(key)) groupedLeaks.set(key, []);
    groupedLeaks.get(key).push(lk);
  }
  if (groupedLeaks.size === 0) {
    console.log('ZERO wall gaps or outside-world leaks detected!');
  } else {
    console.log(`Found ${leakClusters.length} leaking viewpoints across ${groupedLeaks.size} locations:`);
    for (const [key, list] of groupedLeaks.entries()) {
      list.sort((a, b) => (b.skyLeaks + b.terrainLeaks) - (a.skyLeaks + a.terrainLeaks));
      const worst = list[0];
      const totalSky = list.reduce((s, x) => s + x.skyLeaks, 0);
      const totalTerr = list.reduce((s, x) => s + x.terrainLeaks, 0);
      console.log(
        `  LEAK [${key}] viewpoints=${list.length} | worst=(${worst.skyLeaks} sky, ${worst.terrainLeaks} outerTerr rays) ` +
        `@ s/t=${worst.t.toFixed(2)} (${worst.x.toFixed(1)}, ${worst.y.toFixed(1)}, ${worst.z.toFixed(1)}) ` +
        `dirs=[${worst.sampleDirs.join(', ')}] (group totals: ${totalSky} sky, ${totalTerr} outerTerr)`
      );
    }
  }

  // =========================================================================
  // AUDIT 3: PROP POOL EXHAUSTION & BORING LONG PASSAGES
  // =========================================================================
  console.log('\n====================================================================');
  console.log('AUDIT 3: INSTANCED PROP POOL EXHAUSTION & BORING PASSAGE ANALYSIS');
  console.log('====================================================================');

  const pools = [
    ['speleoMesh (stalactites/mites)', sandbox.window.caveSpeleoMesh, 960],
    ['caveColumnMesh (columns)', sandbox.window.caveColumnMesh, 140],
    ['caveDraperyMesh (flowstone)', sandbox.window.caveDraperyMesh, 240],
    ['caveRimstoneMesh (gours)', sandbox.window.caveRimstoneMesh, 140],
    ['lavacicleMesh (lava drips)', sandbox.window.caveLavacicleMesh, 280],
    ['crystalMesh (minerals)', sandbox.window.caveCrystalMesh, 220],
    ['rubbleMesh (talus scree)', sandbox.window.caveRubbleMesh, 360],
    ['caveBoulderMesh (boulders)', sandbox.window.caveBoulderMesh, 190],
    ['caveCragMesh (wall buttresses)', sandbox.window.caveCragMesh, 320]
  ];
  console.log('Instanced Prop Pool Utilization:');
  for (const [name, mesh, cap] of pools) {
    const used = mesh ? mesh.count : 0;
    const flag = used >= cap ? '  <-- EXHAUSTED (100% CAP HIT!)' : (used >= cap * 0.9 ? '  <-- NEAR CAP' : '');
    console.log(`  ${name.padEnd(34)} ${String(used).padStart(4)} / ${String(cap).padEnd(4)} (${((used / cap) * 100).toFixed(0)}%)${flag}`);
  }

  // Analyze every route for length, walk time, prop density per 20m bin, and landmark gaps
  console.log('\nRoute-by-Route Pacing, Landmark Gaps & Prop Density:');
  for (const r of allRoutes) {
    // Collect known landmarks along this route (t values)
    const landmarks = [{ t: 0.0, name: r.branch ? 'junction_start' : 'portal_mouth' }];
    if (!r.branch) {
      for (const sk of (r.cave.skylights || [])) landmarks.push({ t: sk.s, name: `skylight(${sk.name})` });
      for (const wf of (r.cave.waterfalls || [])) landmarks.push({ t: wf.s, name: 'waterfall' });
      for (const jp of (r.cave.junctionPortals || [])) landmarks.push({ t: jp.s, name: `fork(${jp.branch.id})` });
      if (r.cave.hasCenote) landmarks.push({ t: 0.82, name: 'great_cenote' });
      if (r.cave.isLavaTube) {
        landmarks.push({ t: 0.56, name: 'magma_blister_hall' });
        landmarks.push({ t: 0.82, name: 'magma_sump' });
      }
      if (r.cave.id === 'cataract_grotto') landmarks.push({ t: 0.85, name: 'deep_rimstone_vault' });
      landmarks.push({ t: 1.0, name: 'end_chamber' });
    } else {
      if (r.branch.isSqueeze) landmarks.push({ t: r.branch.spec.squeezeT || 0.45, name: 'squeeze_narrows' });
      if (r.branch.hasDropLedge) landmarks.push({ t: r.branch.spec.dropStartT || 0.32, name: 'drop_ledge' });
      if (r.branch.hasPool && !(r.branch.chambers || []).some(c => c.kind === 'siphon_pool')) {
        landmarks.push({ t: r.branch.isInterCave ? 0.50 : 0.78, name: 'subterranean_pool' });
      }
      for (const ch of (r.branch.chambers || [])) {
        landmarks.push({ t: ch.t, name: `chamber(${ch.name || ch.kind})` });
      }
      landmarks.push({ t: 1.0, name: r.branch.isLoop ? 'junction_end' : 'dead_end_chamber' });
    }
    landmarks.sort((a, b) => a.t - b.t);

    // Find longest gap between landmarks in meters
    let maxLmGapM = 0;
    let maxLmPair = '';
    for (let i = 0; i < landmarks.length - 1; i++) {
      const gapM = (landmarks[i + 1].t - landmarks[i].t) * r.length;
      if (gapM > maxLmGapM) {
        maxLmGapM = gapM;
        maxLmPair = `${landmarks[i].name} (t=${landmarks[i].t.toFixed(2)}) -> ${landmarks[i + 1].name} (t=${landmarks[i + 1].t.toFixed(2)})`;
      }
    }

    // Count props within halfW+2.5m of each 25m segment
    const binSize = 25.0;
    const numBins = Math.max(1, Math.ceil(r.length / binSize));
    const binCounts = new Array(numBins).fill(0);
    const binKinds = Array.from({ length: numBins }, () => new Set());
    let totalProps = 0;

    for (const pr of instancedProps) {
      // Quick distance to route points
      let bestDistSq = Infinity;
      let bestDistM = -1;
      let bestHW = 4;
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        const dx = pr.x - pt.x, dz = pr.z - pt.z, dy = pr.y - (pt.floorY + pt.ceilH * 0.5);
        if (Math.abs(dy) > pt.ceilH + 2.5) continue;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestDistM = pt.distM;
          bestHW = pt.halfW;
        }
      }
      if (bestDistSq < (bestHW + 2.0) * (bestHW + 2.0)) {
        const bIdx = Math.min(numBins - 1, Math.floor(bestDistM / binSize));
        binCounts[bIdx]++;
        binKinds[bIdx].add(pr.kind);
        totalProps++;
      }
    }

    // Width/height variance (monotony indicator)
    const hws = r.points.map(p => p.halfW);
    const avgHW = hws.reduce((a, b) => a + b, 0) / Math.max(1, hws.length);
    const stdHW = Math.sqrt(hws.reduce((a, b) => a + (b - avgHW) * (b - avgHW), 0) / Math.max(1, hws.length));
    const barrenBins = binCounts.map((c, idx) => {
      const binLen = Math.min(r.length, (idx + 1) * binSize) - idx * binSize;
      return { idx, count: c, binLen };
    }).filter(b => b.binLen >= 12.0 && b.count <= 2);

    const walkSec = (r.length / 5.2).toFixed(0);
    const sprintSec = (r.length / 8.8).toFixed(0);
    console.log(
      `\n  ROUTE: ${r.id} | len=${r.length.toFixed(0)}m (~${walkSec}s walk / ${sprintSec}s sprint) | avgHW=${avgHW.toFixed(1)}m (std=${stdHW.toFixed(2)}m) | totalProps=${totalProps} (${(totalProps / (r.length / 10)).toFixed(1)}/10m)`
    );
    console.log(`    Longest landmark gap: ${maxLmGapM.toFixed(0)}m  [${maxLmPair}]`);
    console.log(`    Props per 25m bin: [${binCounts.map((c, i) => `${i * 25}-${Math.min(Math.round(r.length), (i + 1) * 25)}m:${c}`).join(', ')}]`);
    if (barrenBins.length > 0) {
      console.log(`    BARREN STRETCHES (<=2 props/25m): ${barrenBins.map(b => `${b.idx * 25}..${Math.min(Math.round(r.length), (b.idx + 1) * 25)}m (${b.count} props)`).join(', ')}`);
    }
  }
})();
