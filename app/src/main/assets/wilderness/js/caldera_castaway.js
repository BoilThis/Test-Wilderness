/**
 * SYLVAN: CALDERA CASTAWAY — AAA Wilderness Survival Expansion Module (60 FPS Optimized)
 * Features:
 * - Spatial Raycast Culling (reduces per-frame raycast targets from ~300+ down to 1-4 nearby objects)
 * - GPU Instanced Bamboo Forests (reduces 1,968 bamboo draw calls down to 3 InstancedMesh draw calls)
 * - Dynamic PointLight Distance Culling (culls distant cave & landmark point lights to 2-3 active lights)
 * - Adaptive 60 FPS Frame-Budget Governor & Distance-LOD Wildlife Animations
 * - Full 3D Character Physics (climbable boulders/wings/rafts/foundations & solid tree/cliff collisions)
 * - 5 Archipelago Biomes, 6 3D First-Person Tools, Modular Base Building, Outrigger Raft & Rescue Campaign
 */
(function () {
  'use strict';

  if (!window.THREE || !window.scene || !window.player) {
    console.warn('[CalderaCastaway] Waiting for core 3D engine...');
    return;
  }

  const {
    THREE, scene, camera, renderer, player,
    getTerrainHeight, getWaterInfo,
    interactiveTargets, treeFootprints,
    applyAAARockShader, addWaterRipple, AudioEngine, showToast, WAYPOINTS
  } = window;

  const yieldFrame = () => new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });

  // ============================================================================
  // 1. SURVIVOR PROGRESSION STATE, INVENTORY & CAMPAIGN GOALS
  // ============================================================================
  Object.assign(player.inventory, {
    timber: Math.max(player.inventory.timber || 0, 8),
    stone: Math.max(player.inventory.stone || 0, 8),
    bamboo: 6,
    obsidian: 3,
    fiber: 6,
    hide: 2,
    bone: 2,
    sinew: 2,
    feather: 6,
    flint: 3,
    fat: 0,
    arrows: 6,
    bolts: 6,
    pistolAmmo: 0,
    rifleAmmo: 0,
    dynamite: 0,
    rawFish: 0,
    rawMeat: 0,
    cookedFood: 2,
    purifiedWater: 1,
    flares: 2
  });

  const campaign = {
    started: false,
    mode: 'campaign',
    activeTool: 'hatchet', // 'hatchet'|'spear'|'rod'|'torch'|'flare'|'build'|'bow'|'crossbow'|'pistol'|'rifle'|'dynamite'
    buildPiece: 'foundation',
    unlockedWeapons: {
      bow: false,
      crossbow: false,
      pistol: false,
      rifle: false
    },
    bowDraw: { holding: false, power: 0, holdTime: 0 },
    rangedAim: {
      active: false,
      tool: null,
      pointerMode: null,
      touchId: null,
      lastX: 0,
      lastY: 0,
      startX: 0,
      startY: 0,
      holdTime: 0,
      overCancel: false,
      breathHapticFired: false
    },
    weaponRecoil: {
      camPitch: 0,
      camYaw: 0,
      modelZ: 0,
      modelPitch: 0,
      fovPunch: 0
    },
    weaponPoseBlend: 0,
    crossbowCooldown: 0,
    chamberCycleTimer: 0,
    chamberCycleDuration: 0.25,
    chamberCycleWeapon: null,
    bleedTimer: 0,
    activeHarvest: null,
    modulesFound: {
      cockpitTransponder: false,
      submergedBattery: false,
      cavernRecorder: false
    },
    outpostRepaired: false,
    rescueTriggered: false,
    onRaft: false,
    vessel: null,
    raftBuilt: false,
    boatBuilt: false,
    boatParts: { keel: false, brace: false, skin: false, sail: false },
    toolSwing: 0,
    fishingState: {
      cast: false,
      biteTimer: 0,
      biting: false,
      bobberPos: new THREE.Vector3()
    },
    weather: {
      autoCycle: true,
      current: 'clear',
      timer: 0,
      duration: 95,
      rainIntensity: 0,
      lightningFlash: 0
    },
    activeFlares: []
  };
  window.calderaCampaign = campaign;
  window._calderaActiveTool = campaign.activeTool;

  // ============================================================================
  // 2. SPATIAL RAYCAST & FIXED HARDWARE POINT-LIGHT POOL (ZERO SHADER RECOMPILES)
  // ============================================================================
  // Copy all initial interactiveTargets (trees, boulders) into masterInteractiveTargets
  // and dynamically feed only nearby (<11m) objects into window.interactiveTargets!
  const masterInteractiveTargets = interactiveTargets.slice();
  const managedPointLights = []; // Virtual light descriptors: { light, worldPos: Vector3, maxDistSq }

  // Fixed pool of 4 permanently-visible hardware PointLights so #define NUM_POINT_LIGHTS
  // NEVER changes at runtime (completely eliminating 300-800ms Three.js GLSL shader recompilation freezes!)
  const POINT_LIGHT_POOL_SIZE = 4;
  const pointLightPool = [];
  for (let p = 0; p < POINT_LIGHT_POOL_SIZE; p++) {
    const pl = new THREE.PointLight(0xffffff, 0.0, 40.0, 1.4);
    pl.position.set(0, -500, 0);
    pl.visible = true; // MUST stay true forever so NUM_POINT_LIGHTS is constant!
    pl.castShadow = false;
    scene.add(pl);
    pointLightPool.push(pl);
  }

  function registerInteractiveTarget(obj) {
    if (obj && masterInteractiveTargets.indexOf(obj) === -1) {
      masterInteractiveTargets.push(obj);
    }
  }

  function removeInteractiveTarget(obj) {
    const mIdx = masterInteractiveTargets.indexOf(obj);
    if (mIdx !== -1) masterInteractiveTargets.splice(mIdx, 1);
    const iIdx = interactiveTargets.indexOf(obj);
    if (iIdx !== -1) interactiveTargets.splice(iIdx, 1);
  }

  window.registerInteractiveTarget = registerInteractiveTarget;
  window.removeInteractiveTarget = removeInteractiveTarget;

  function registerManagedLight(light, maxDist = 58.0) {
    if (!light) return;
    const wp = new THREE.Vector3();
    if (light.getWorldPosition) {
      light.updateMatrixWorld(true);
      light.getWorldPosition(wp);
    } else if (light.position) {
      wp.copy(light.position);
    }
    // Keep source light permanently invisible so it never increments NUM_POINT_LIGHTS;
    // our 4 hardware pool lights mirror the 4 nearest active virtual lights!
    light.visible = false;
    light.castShadow = false;
    managedPointLights.push({
      light,
      worldPos: wp,
      maxDistSq: maxDist * maxDist
    });
  }

  // Convert all existing cave PointLights from index.html into virtual pooled lights before the first frame renders
  if (window.hillsideCaveRoot) {
    window.hillsideCaveRoot.traverse(obj => {
      if (obj.isPointLight) {
        registerManagedLight(obj, 54.0);
      }
    });
  }

  // ============================================================================
  // 3. UNIFIED 3D COLLISION & CLIMBABLE SURFACE PHYSICS SOLVER
  // ============================================================================
  const worldColliders = [];     // { x, z, r, minY, maxY, label }
  const climbableSurfaces = [];  // { type:'circle'|'box', ... }
  window.worldColliders = worldColliders;
  window.climbableSurfaces = climbableSurfaces;

  function registerCollider(x, z, r, minY = -50, maxY = 200, label = 'solid') {
    worldColliders.push({ x, z, r, minY, maxY, label });
  }
  window.registerCollider = registerCollider;

  function registerClimbableCircle(x, z, r, topY, minY = -20) {
    climbableSurfaces.push({ type: 'circle', x, z, r, topY, minY });
  }

  function registerClimbableBox(x, z, hx, hz, yaw, topY, minY = -20, slopeZ = 0) {
    climbableSurfaces.push({
      type: 'box', x, z, hx, hz,
      cosY: Math.cos(-yaw), sinY: Math.sin(-yaw),
      topY, minY, slopeZ
    });
  }

  if (Array.isArray(treeFootprints)) {
    for (let i = 0; i < treeFootprints.length; i++) {
      const tf = treeFootprints[i];
      if (!tf || tf.isBush) continue; // Allow player to walk naturally through soft coastal bushes
      const ty = getTerrainHeight(tf.x, tf.z);
      const trunkR = (typeof tf.trunkR === 'number' && tf.trunkR > 0.0)
        ? tf.trunkR
        : Math.max(0.24, Math.min(0.46, (tf.r || 4.5) * 0.06));
      registerCollider(tf.x, tf.z, trunkR, ty - 1.0, ty + 14.0, 'tree');
    }
  }

  // Register all 3D rock structures (hero boulders, gorge boulders, skylight oasis boulders, and portal wing rocks)
  const registeredRockSet = new Set();
  function registerBoulderObject(obj) {
    if (!obj || registeredRockSet.has(obj)) return;
    if (obj.userData && obj.userData.isCaveArch) return;
    registeredRockSet.add(obj);
    const rx = obj.position.x;
    const ry = obj.position.y;
    const rz = obj.position.z;
    const baseR = (obj.userData && obj.userData.baseRadius) ? obj.userData.baseRadius : 1.4;
    const sx = obj.scale ? obj.scale.x : 1.0;
    const sy = obj.scale ? obj.scale.y : 1.0;
    const sz = obj.scale ? obj.scale.z : 1.0;
    const effR = baseR * Math.max(sx, sz) * 0.86;
    const effH = baseR * sy * 0.74;
    const topY = ry + effH;
    registerClimbableCircle(rx, rz, effR * 1.04, topY, ry - baseR * sy);
    registerCollider(rx, rz, effR * 0.84, ry - baseR * sy, topY - 0.55, 'boulder');
  }

  for (let i = 0; i < masterInteractiveTargets.length; i++) {
    const obj = masterInteractiveTargets[i];
    if (obj && obj.userData && (obj.userData.type === 'rock' || obj.userData.type === 'boulder')) {
      registerBoulderObject(obj);
    }
  }
  if (Array.isArray(window.activeBoulders)) {
    for (let i = 0; i < window.activeBoulders.length; i++) {
      registerBoulderObject(window.activeBoulders[i]);
    }
  }
  if (Array.isArray(window.instancedRockColliders)) {
    for (let i = 0; i < window.instancedRockColliders.length; i++) {
      const rc = window.instancedRockColliders[i];
      if (!rc) continue;
      if (rc.climbable) {
        registerClimbableCircle(rc.x, rc.z, rc.r * 1.05, rc.topY, rc.minY);
        registerCollider(rc.x, rc.z, rc.r * 0.85, rc.minY, rc.topY - 0.50, 'instanced_rock');
      } else {
        registerCollider(rc.x, rc.z, rc.r, rc.minY, rc.maxY, 'cave_pillar');
      }
    }
  }

  window.getSupportSurfaceY = function (x, z, currentPlayerY) {
    let bestY = -Infinity;
    for (let i = 0; i < climbableSurfaces.length; i++) {
      const s = climbableSurfaces[i];
      if (s.type === 'circle') {
        const dx = x - s.x;
        const dz = z - s.z;
        if (Math.abs(dx) > s.r || Math.abs(dz) > s.r) continue;
        const d = Math.hypot(dx, dz);
        if (d <= s.r) {
          const edgeRatio = d / Math.max(0.001, s.r);
          const surfY = s.topY - edgeRatio * edgeRatio * 0.24;
          if (currentPlayerY + 1.35 >= surfY && surfY > bestY) {
            bestY = surfY;
          }
        }
      } else if (s.type === 'box') {
        const dx = x - s.x;
        const dz = z - s.z;
        if (Math.abs(dx) > s.hx + s.hz || Math.abs(dz) > s.hx + s.hz) continue;
        const lx = dx * s.cosY - dz * s.sinY;
        const lz = dx * s.sinY + dz * s.cosY;
        if (Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz) {
          const surfY = s.topY + (s.slopeZ ? (lz / s.hz) * s.slopeZ : 0);
          if (currentPlayerY + 1.35 >= surfY && surfY > bestY) {
            bestY = surfY;
          }
        }
      }
    }
    return bestY;
  };

  const lastValidPos = new THREE.Vector3(player.pos.x, player.pos.y, player.pos.z);
  window.resolveHorizontalCollisions = function (pos, playerRadius = 0.52, inCave = false) {
    if (campaign.onRaft) {
      lastValidPos.copy(pos);
      return;
    }

    const pY = pos.y;
    for (let i = 0; i < worldColliders.length; i++) {
      const c = worldColliders[i];
      if (pY + 1.65 < c.minY || pY >= c.maxY) continue;
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const minDist = c.r + playerRadius;
      if (Math.abs(dx) > minDist || Math.abs(dz) > minDist) continue;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist && distSq > 0.00001) {
        const dist = Math.sqrt(distSq);
        const push = (minDist - dist);
        pos.x += (dx / dist) * push;
        pos.z += (dz / dist) * push;
      }
    }

    const sampleSurfaceY = (sx, sz) => {
      const ha = getTerrainHeight(sx, sz);
      return window.sampleTerrainMeshHeight ? Math.max(ha, window.sampleTerrainMeshHeight(sx, sz)) : ha;
    };
    const inCaveApproach = !!(window.isInCaveEntranceApproach && window.isInCaveEntranceApproach(pos.x, pos.z, 5.5, 26.0, 12.0));
    const stepDx = pos.x - lastValidPos.x;
    const stepDz = pos.z - lastValidPos.z;
    const stepDist = Math.hypot(stepDx, stepDz);
    if (!inCave && !inCaveApproach && !player.isSwimming) {
      if (stepDist > 0.001) {
        const hPrev = sampleSurfaceY(lastValidPos.x, lastValidPos.z);
        const hNext = sampleSurfaceY(pos.x, pos.z);
        const supportNext = window.getSupportSurfaceY(pos.x, pos.z, pos.y);
        if (hNext > hPrev + 0.04 && supportNext < hNext) {
          const grade = (hNext - hPrev) / stepDist;
          if (grade > 1.95) {
            pos.x = lastValidPos.x;
            pos.z = lastValidPos.z;
          }
        }
      }
      // 360-degree cliff-face clearance ring: keep camera near-plane cleanly outside vertical canyon/cliff triangles
      const ringR = Math.max(0.66, playerRadius + 0.14);
      const baseFootY = Math.max(pos.y, sampleSurfaceY(pos.x, pos.z));
      let pushX = 0.0, pushZ = 0.0, pushHits = 0;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2.0;
        const dirX = Math.cos(ang), dirZ = Math.sin(ang);
        const rx = pos.x + dirX * ringR;
        const rz = pos.z + dirZ * ringR;
        const hRing = sampleSurfaceY(rx, rz);
        if (hRing > baseFootY + 1.35) {
          const supRing = window.getSupportSurfaceY(rx, rz, pos.y);
          if (supRing < hRing - 0.15) {
            const wallExcess = Math.min(1.0, (hRing - (baseFootY + 1.35)) * 0.45 + 0.25);
            pushX -= dirX * wallExcess;
            pushZ -= dirZ * wallExcess;
            pushHits++;
          }
        }
      }
      if (pushHits > 0) {
        const pLen = Math.hypot(pushX, pushZ);
        if (pLen > 0.001) {
          const pushAmt = Math.min(0.42, ringR * 0.48);
          const candX = pos.x + (pushX / pLen) * pushAmt;
          const candZ = pos.z + (pushZ / pLen) * pushAmt;
          if (sampleSurfaceY(candX, candZ) <= baseFootY + 1.25) {
            pos.x = candX;
            pos.z = candZ;
          }
        }
      }
    }

    lastValidPos.copy(pos);
  };

  // ============================================================================
  // 4. SHARED AAA PROCEDURAL PBR MATERIALS & 512x512 NORMAL / ALBEDO ATLASES
  // ============================================================================
  const woodTextures = window.getWoodTextures ? window.getWoodTextures() : {};

  let aaaSurfacePBRAssets = null;
  async function initAAASurfacePBRMaps() {
    const size = 512;
    const totalPixels = size * size;
    const lumBuf = new Float32Array(totalPixels);

    function heightToNormalCanvas(hCanvas, strength) {
      const sCtx = hCanvas.getContext('2d');
      const src = sCtx.getImageData(0, 0, size, size).data;
      const nCanvas = document.createElement('canvas');
      nCanvas.width = size; nCanvas.height = size;
      const nCtx = nCanvas.getContext('2d');
      const nImg = nCtx.createImageData(size, size);
      const dst = nImg.data;
      const inv255 = 1.0 / 255.0;
      for (let p = 0; p < totalPixels; p++) {
        lumBuf[p] = src[p << 2] * inv255;
      }
      for (let y = 0; y < size; y++) {
        const yUp = (y === 0 ? size - 1 : y - 1) * size;
        const yMid = y * size;
        const yDn = (y === size - 1 ? 0 : y + 1) * size;
        for (let x = 0; x < size; x++) {
          const xL = x === 0 ? size - 1 : x - 1;
          const xR = x === size - 1 ? 0 : x + 1;
          const dx = (lumBuf[yMid + xR] - lumBuf[yMid + xL]) * strength;
          const dy = (lumBuf[yDn + x] - lumBuf[yUp + x]) * strength;
          const inv = 1.0 / Math.sqrt(dx * dx + dy * dy + 1.0);
          const i = (yMid + x) << 2;
          dst[i]     = (((-dx * inv) * 0.5 + 0.5) * 255) | 0;
          dst[i + 1] = (((-dy * inv) * 0.5 + 0.5) * 255) | 0;
          dst[i + 2] = ((inv * 0.5 + 0.5) * 255) | 0;
          dst[i + 3] = 255;
        }
      }
      nCtx.putImageData(nImg, 0, 0);
      const tex = new THREE.CanvasTexture(nCanvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return tex;
    }

    // 1. Riveted Stressed-Skin Aircraft Duralumin (Brushed Micro-Grain, Panel Seams, Double Rivet Rows & Salt Weathering)
    const aluH = document.createElement('canvas');
    aluH.width = size; aluH.height = size;
    const ahCtx = aluH.getContext('2d');
    ahCtx.fillStyle = '#808080';
    ahCtx.fillRect(0, 0, size, size);
    // Fine anisotropic brushed aluminum streaks
    for (let s = 0; s < 420; s++) {
      const sy = Math.random() * size;
      ahCtx.fillStyle = s % 2 === 0 ? 'rgba(210,210,210,0.09)' : 'rgba(60,60,60,0.09)';
      ahCtx.fillRect(0, sy, size, 1 + (s % 2));
    }
    // Panel seam grooves
    ahCtx.strokeStyle = '#242424';
    ahCtx.lineWidth = 3;
    for (let p = 0; p < size; p += 128) {
      ahCtx.beginPath(); ahCtx.moveTo(p, 0); ahCtx.lineTo(p, size); ahCtx.stroke();
      ahCtx.beginPath(); ahCtx.moveTo(0, p); ahCtx.lineTo(size, p); ahCtx.stroke();
      // Raised dome rivets along both sides of panel seams
      ahCtx.fillStyle = '#ececec';
      for (let r = 8; r < size; r += 16) {
        ahCtx.beginPath(); ahCtx.arc(p + 8, r, 2.4, 0, Math.PI * 2); ahCtx.fill();
        ahCtx.beginPath(); ahCtx.arc((p + 120) % size, r, 2.4, 0, Math.PI * 2); ahCtx.fill();
        ahCtx.beginPath(); ahCtx.arc(r, p + 8, 2.4, 0, Math.PI * 2); ahCtx.fill();
      }
    }
    const aluNormTex = heightToNormalCanvas(aluH, 3.6);
    await yieldFrame();

    // 2. Corrugated Weathered Industrial Steel & Reinforced Bunker Concrete Normal Map
    const steelH = document.createElement('canvas');
    steelH.width = size; steelH.height = size;
    const shCtx = steelH.getContext('2d');
    for (let x = 0; x < size; x++) {
      const wave = Math.floor((Math.sin((x / 32) * Math.PI * 2) * 0.5 + 0.5) * 180 + 35);
      shCtx.fillStyle = `rgb(${wave},${wave},${wave})`;
      shCtx.fillRect(x, 0, 1, size);
    }
    for (let i = 0; i < 2000; i++) {
      const px = Math.random() * size, py = Math.random() * size;
      shCtx.fillStyle = Math.random() > 0.5 ? 'rgba(18,18,18,0.38)' : 'rgba(226,226,226,0.28)';
      shCtx.fillRect(px, py, 2 + Math.random() * 6, 3 + Math.random() * 8);
    }
    const steelNormTex = heightToNormalCanvas(steelH, 3.3);
    await yieldFrame();

    // 3. Woven Pandanus Sailcloth & Herringbone Palm Thatch Albedo + Normal Map
    const thatchC = document.createElement('canvas');
    thatchC.width = size; thatchC.height = size;
    const tcCtx = thatchC.getContext('2d');
    tcCtx.fillStyle = '#8b6f36';
    tcCtx.fillRect(0, 0, size, size);
    const thatchH = document.createElement('canvas');
    thatchH.width = size; thatchH.height = size;
    const thCtx = thatchH.getContext('2d');
    thCtx.fillStyle = '#767676';
    thCtx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 16) {
      for (let x = 0; x < size; x += 16) {
        const odd = ((x / 16 + y / 16) % 2 === 0);
        tcCtx.fillStyle = odd ? '#b08f4c' : '#7b602c';
        tcCtx.fillRect(x + 1, y + 1, 14, 14);
        // Fine individual dried palm frond fiber strands
        tcCtx.fillStyle = odd ? 'rgba(220,192,124,0.34)' : 'rgba(65,48,20,0.34)';
        for (let f = 2; f < 14; f += 3) {
          if (odd) tcCtx.fillRect(x + f, y + 1, 1, 14);
          else tcCtx.fillRect(x + 1, y + f, 14, 1);
        }
        thCtx.fillStyle = odd ? '#cacaca' : '#464646';
        thCtx.fillRect(x + 2, y + 2, 12, 12);
      }
    }
    const thatchTex = new THREE.CanvasTexture(thatchC);
    thatchTex.wrapS = thatchTex.wrapT = THREE.RepeatWrapping;
    thatchTex.repeat.set(3, 3);
    const thatchNormTex = heightToNormalCanvas(thatchH, 3.1);
    thatchNormTex.repeat.set(3, 3);

    if (window.applyMaxAnisotropy) {
      window.applyMaxAnisotropy(aluNormTex);
      window.applyMaxAnisotropy(steelNormTex);
      window.applyMaxAnisotropy(thatchTex);
      window.applyMaxAnisotropy(thatchNormTex);
      if (woodTextures.woodBarkTex) window.applyMaxAnisotropy(woodTextures.woodBarkTex);
      if (woodTextures.woodRingsTex) window.applyMaxAnisotropy(woodTextures.woodRingsTex);
    }

    aaaSurfacePBRAssets = { aluNormTex, steelNormTex, thatchTex, thatchNormTex };
    return aaaSurfacePBRAssets;
  }

  const matBrass = new THREE.MeshStandardMaterial({ color: 0xd8b43c, roughness: 0.20, metalness: 0.90 });
  const matCockpitGlass = new THREE.MeshStandardMaterial({ color: 0x0d1d2a, roughness: 0.06, metalness: 0.92, transparent: true, opacity: 0.74 });
  const matBambooCulm = new THREE.MeshStandardMaterial({ color: 0x689f38, roughness: 0.38, metalness: 0.08 });
  const matSeasonedBamboo = new THREE.MeshStandardMaterial({ color: 0xc8a866, roughness: 0.42, metalness: 0.08 });
  const matTimberLog = new THREE.MeshStandardMaterial({
    map: woodTextures.woodBarkTex || woodTextures.barkTex || null,
    color: 0x78553a,
    roughness: 0.80,
    metalness: 0.04
  });
  const matHickory = new THREE.MeshStandardMaterial({
    map: woodTextures.woodRingsTex || woodTextures.hickoryTex || null,
    color: 0x9e744a,
    roughness: 0.48,
    metalness: 0.06
  });

  let matAluminum, matAnodizedDark, matRescueRed, matSafetyOrange, matRustedSteel, matObsidianGlass, matRawhide, matThatch, matSailCanvas;
  function initSharedSurfaceMaterials() {
    matAluminum = new THREE.MeshStandardMaterial({
      color: 0xa4b0bc,
      normalMap: aaaSurfacePBRAssets.aluNormTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.34,
      metalness: 0.78
    });
    matAnodizedDark = new THREE.MeshStandardMaterial({
      color: 0x222830,
      normalMap: aaaSurfacePBRAssets.aluNormTex,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.34,
      metalness: 0.86
    });
    matRescueRed = new THREE.MeshStandardMaterial({
      color: 0xa82828,
      normalMap: aaaSurfacePBRAssets.aluNormTex,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.40,
      metalness: 0.34
    });
    matSafetyOrange = new THREE.MeshStandardMaterial({
      color: 0xd65428,
      normalMap: aaaSurfacePBRAssets.aluNormTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.38,
      metalness: 0.28
    });
    matRustedSteel = new THREE.MeshStandardMaterial({
      color: 0x664434,
      normalMap: aaaSurfacePBRAssets.steelNormTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.66,
      metalness: 0.60
    });
    matObsidianGlass = new THREE.MeshStandardMaterial({
      color: 0x080b12,
      emissive: 0x160828,
      emissiveIntensity: 0.24,
      normalMap: aaaSurfacePBRAssets.steelNormTex,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.08,
      metalness: 0.92
    });
    matRawhide = new THREE.MeshStandardMaterial({
      color: 0x4a2c18,
      normalMap: aaaSurfacePBRAssets.thatchNormTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.68,
      metalness: 0.05
    });
    matThatch = new THREE.MeshStandardMaterial({
      map: aaaSurfacePBRAssets.thatchTex,
      normalMap: aaaSurfacePBRAssets.thatchNormTex,
      normalScale: new THREE.Vector2(1.05, 1.05),
      color: 0x8e7444,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide
    });

    // Stitched salt-weathered cream flax canvas for raft & keeled boat sails
    const sc = document.createElement('canvas');
    sc.width = 256; sc.height = 256;
    const sCtx = sc.getContext('2d');
    sCtx.fillStyle = '#d4c8ae';
    sCtx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 3) {
      sCtx.fillStyle = (y % 6 === 0) ? 'rgba(90,74,52,0.06)' : 'rgba(255,250,238,0.08)';
      sCtx.fillRect(0, y, 256, 1);
    }
    for (let x = 0; x < 256; x += 3) {
      sCtx.fillStyle = (x % 6 === 0) ? 'rgba(90,74,52,0.05)' : 'rgba(255,250,238,0.06)';
      sCtx.fillRect(x, 0, 1, 256);
    }
    // Horizontal reef-panel stitched seams & corner weathering
    sCtx.fillStyle = 'rgba(72,56,38,0.28)';
    for (let sy = 48; sy < 256; sy += 64) {
      sCtx.fillRect(0, sy, 256, 2);
    }
    const sailTex = new THREE.CanvasTexture(sc);
    sailTex.wrapS = sailTex.wrapT = THREE.RepeatWrapping;
    if (window.applyMaxAnisotropy) window.applyMaxAnisotropy(sailTex);
    matSailCanvas = new THREE.MeshStandardMaterial({
      map: sailTex,
      normalMap: aaaSurfacePBRAssets.thatchNormTex,
      normalScale: new THREE.Vector2(0.35, 0.35),
      color: 0xd0c4a8,
      roughness: 0.84,
      metalness: 0.02,
      side: THREE.DoubleSide
    });
  }

  function createLayeredThatchRoof(radius, height) {
    const roofGrp = new THREE.Group();
    const lowerSkirt = new THREE.Mesh(
      new THREE.ConeGeometry(radius, height * 0.62, 12, 1, true),
      matThatch
    );
    lowerSkirt.position.y = -height * 0.19;
    lowerSkirt.castShadow = true;
    lowerSkirt.receiveShadow = true;
    roofGrp.add(lowerSkirt);

    const upperCap = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 0.68, height * 0.68, 12),
      matThatch
    );
    upperCap.position.y = height * 0.18;
    upperCap.castShadow = true;
    upperCap.receiveShadow = true;
    roofGrp.add(upperCap);

    const ridgeCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.15, height * 0.24, 8),
      matSeasonedBamboo
    );
    ridgeCap.position.y = height * 0.48;
    roofGrp.add(ridgeCap);

    const rafterLen = Math.hypot(radius * 0.94, height * 0.92);
    const tilt = Math.atan2(radius * 0.94, height * 0.92);
    for (let r = 0; r < 4; r++) {
      const ang = (r / 4) * Math.PI * 2 + Math.PI / 4;
      const rafter = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.07, rafterLen, 6),
        matTimberLog
      );
      rafter.position.set(Math.cos(ang) * radius * 0.45, -0.02, Math.sin(ang) * radius * 0.45);
      rafter.rotation.order = 'YXZ';
      rafter.rotation.y = -ang + Math.PI / 2;
      rafter.rotation.x = tilt;
      roofGrp.add(rafter);
    }
    return roofGrp;
  }

  // Shared lightweight invisible hit-proxy material for interactive crates & structures
  const _landmarkProxyMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    colorWrite: false
  });

  // ============================================================================
  // 5. EXPANDED ARCHIPELAGO BIOMES & AAA-DETAILED 3D LANDMARKS
  // ============================================================================
  const worldLandmarksGroup = new THREE.Group();
  scene.add(worldLandmarksGroup);
  const animatedProps = [];
  const minorStaticProps = [];

  // Zero-visual-loss static BufferGeometry batcher: merges static child meshes sharing identical material/flags inside a local group
  function mergeStaticGroupByMaterial(rootGroup, skipSet) {
    if (!rootGroup) return;
    rootGroup.updateMatrixWorld(true);
    const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
    const relMat = new THREE.Matrix4();
    const buckets = new Map();
    const matIds = new Map();
    let nextMatId = 1;

    function isSkipped(obj) {
      if (!skipSet || skipSet.size === 0) return false;
      let cur = obj;
      while (cur && cur !== rootGroup) {
        if (skipSet.has(cur)) return true;
        cur = cur.parent;
      }
      return false;
    }

    rootGroup.traverse(obj => {
      if (!obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh) return;
      if (obj.material === _landmarkProxyMat || !obj.material || Array.isArray(obj.material)) return;
      if (obj.userData && obj.userData.noMerge) return;
      if (isSkipped(obj)) return;
      const geo = obj.geometry;
      if (!geo || !geo.attributes || !geo.attributes.position) return;

      let mId = matIds.get(obj.material);
      if (!mId) { mId = nextMatId++; matIds.set(obj.material, mId); }
      const key = `${mId}|${obj.castShadow ? 1 : 0}|${obj.receiveShadow ? 1 : 0}|${obj.layers.mask}`;
      let list = buckets.get(key);
      if (!list) {
        list = { mat: obj.material, castShadow: obj.castShadow, receiveShadow: obj.receiveShadow, layerMask: obj.layers.mask, meshes: [] };
        buckets.set(key, list);
      }
      list.meshes.push(obj);
    });

    buckets.forEach(bucket => {
      if (bucket.meshes.length < 2) return;
      const bakedGeos = [];
      let totalVerts = 0;
      let hasUv = false;
      let hasColor = false;
      let hasSss = false;
      let allNoRaycast = true;

      for (let i = 0; i < bucket.meshes.length; i++) {
        const m = bucket.meshes[i];
        if (m.raycast === THREE.Mesh.prototype.raycast) allNoRaycast = false;
        const srcGeo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        relMat.multiplyMatrices(invRoot, m.matrixWorld);
        srcGeo.applyMatrix4(relMat);
        if (!srcGeo.attributes.normal) srcGeo.computeVertexNormals();
        if (srcGeo.attributes.uv) hasUv = true;
        if (srcGeo.attributes.color) hasColor = true;
        if (srcGeo.attributes.aSssWeight) hasSss = true;
        totalVerts += srcGeo.attributes.position.count;
        bakedGeos.push(srcGeo);
      }

      const posArr = new Float32Array(totalVerts * 3);
      const normArr = new Float32Array(totalVerts * 3);
      const uvArr = hasUv ? new Float32Array(totalVerts * 2) : null;
      const colArr = hasColor ? new Float32Array(totalVerts * 3) : null;
      const sssArr = hasSss ? new Float32Array(totalVerts) : null;

      let vOff = 0;
      for (let i = 0; i < bakedGeos.length; i++) {
        const g = bakedGeos[i];
        const p = g.attributes.position;
        const n = g.attributes.normal;
        const cnt = p.count;
        for (let k = 0; k < cnt; k++) {
          const i3 = (vOff + k) * 3;
          posArr[i3] = p.getX(k); posArr[i3 + 1] = p.getY(k); posArr[i3 + 2] = p.getZ(k);
          normArr[i3] = n.getX(k); normArr[i3 + 1] = n.getY(k); normArr[i3 + 2] = n.getZ(k);
        }
        if (uvArr) {
          const uv = g.attributes.uv;
          if (uv) {
            for (let k = 0; k < cnt; k++) {
              const i2 = (vOff + k) * 2;
              uvArr[i2] = uv.getX(k); uvArr[i2 + 1] = uv.getY(k);
            }
          }
        }
        if (colArr) {
          const col = g.attributes.color;
          for (let k = 0; k < cnt; k++) {
            const i3 = (vOff + k) * 3;
            if (col) {
              colArr[i3] = col.getX(k); colArr[i3 + 1] = col.getY(k); colArr[i3 + 2] = col.getZ(k);
            } else {
              colArr[i3] = 1; colArr[i3 + 1] = 1; colArr[i3 + 2] = 1;
            }
          }
        }
        if (sssArr) {
          const sss = g.attributes.aSssWeight;
          for (let k = 0; k < cnt; k++) {
            sssArr[vOff + k] = sss ? sss.getX(k) : 0.06;
          }
        }
        vOff += cnt;
        g.dispose();
      }

      const mergedGeo = new THREE.BufferGeometry();
      mergedGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      mergedGeo.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
      if (uvArr) mergedGeo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      if (colArr) mergedGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      if (sssArr) mergedGeo.setAttribute('aSssWeight', new THREE.BufferAttribute(sssArr, 1));
      mergedGeo.computeBoundingSphere();

      const mergedMesh = new THREE.Mesh(mergedGeo, bucket.mat);
      mergedMesh.castShadow = bucket.castShadow;
      mergedMesh.receiveShadow = bucket.receiveShadow;
      mergedMesh.layers.mask = bucket.layerMask;
      if (allNoRaycast) mergedMesh.raycast = () => {};

      for (let i = 0; i < bucket.meshes.length; i++) {
        const m = bucket.meshes[i];
        if (m.parent) m.parent.remove(m);
      }
      rootGroup.add(mergedMesh);
    });
  }

  // --- 5A. FLIGHT 409 CRASHED TWIN-OTTER SEAPLANE (Dry sand west of the cove: -44, -28) ---
  function buildCrashedSeaplane() {
    const cx = -44.0, cz = -28.0;
    const cy = getTerrainHeight(cx, cz) + 0.02;
    const planeGroup = new THREE.Group();
    planeGroup.position.set(cx, cy, cz);
    planeGroup.rotation.set(0.07, 0.42, -0.14);

    // 1. High-Poly Riveted Stressed-Skin Fuselage Barrel + External Longerons & Bulkhead Formers
    const fuselageGeo = new THREE.CylinderGeometry(1.38, 1.18, 9.4, 28, 10);
    const fPos = fuselageGeo.attributes.position;
    for (let i = 0; i < fPos.count; i++) {
      const vx = fPos.getX(i), vy = fPos.getY(i), vz = fPos.getZ(i);
      // Subtle impact denting along belly & aft tail section
      const dent = Math.sin(vy * 1.4 + vx * 2.2) * 0.035;
      const belly = vx < 0.2 ? (0.2 - vx) * 0.28 : 0.0;
      fPos.setXYZ(i, vx + dent - belly, vy, vz + (vx < 0 ? 0.08 : 0));
    }
    const bellyCols = new Float32Array(fPos.count * 3);
    for (let i = 0; i < fPos.count; i++) {
      const shade = fPos.getX(i) < 0.05 ? 0.55 : 1.0;
      bellyCols[i * 3] = shade;
      bellyCols[i * 3 + 1] = shade;
      bellyCols[i * 3 + 2] = shade;
    }
    fuselageGeo.setAttribute('color', new THREE.BufferAttribute(bellyCols, 3));
    fuselageGeo.computeVertexNormals();
    fuselageGeo.rotateZ(Math.PI / 2);
    const weatheredAlu = matAluminum.clone();
    weatheredAlu.vertexColors = true;
    const fuselage = new THREE.Mesh(fuselageGeo, weatheredAlu);
    fuselage.position.set(0, 1.62, 0);
    fuselage.castShadow = true;
    fuselage.receiveShadow = true;
    planeGroup.add(fuselage);

    for (let r = -3.8; r <= 3.8; r += 0.95) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.034, 10, 28), matAluminum);
      rib.rotation.y = Math.PI / 2;
      rib.position.set(r, 1.62, 0);
      planeGroup.add(rib);
    }

    // Torn Fuselage Skin & Exposed Structural Stringers near Aft Cargo Door
    for (let s = 0; s < 6; s++) {
      const ang = (s / 6) * Math.PI * 2;
      const stringer = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.04, 0.04), matAnodizedDark);
      stringer.position.set(-4.35, 1.62 + Math.sin(ang) * 1.15, Math.cos(ang) * 1.15);
      stringer.rotation.z = (s % 2 === 0 ? 0.08 : -0.06);
      planeGroup.add(stringer);
    }

    // 2. Crimson Coast-Charter Livery Stripes, Dorsal Spine Fairing & Cabin Porthole Windows
    const stripeGeo = new THREE.CylinderGeometry(1.40, 1.21, 7.8, 28);
    stripeGeo.rotateZ(Math.PI / 2);
    const stripe = new THREE.Mesh(stripeGeo, matRescueRed);
    stripe.position.set(-0.2, 1.58, 0);
    stripe.scale.set(1.0, 0.34, 1.02);
    planeGroup.add(stripe);

    const dorsalFairing = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 6.8, 12), matRescueRed);
    dorsalFairing.rotation.z = Math.PI / 2;
    dorsalFairing.position.set(-0.4, 2.94, 0);
    planeGroup.add(dorsalFairing);

    for (let w = -2.8; w <= 2.0; w += 1.2) {
      [-1.33, 1.33].forEach(zSide => {
        const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.09, 18), matAnodizedDark);
        frame.rotation.x = Math.PI / 2;
        frame.position.set(w, 1.88, zSide);
        planeGroup.add(frame);

        const pane = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.11, 18), matCockpitGlass);
        pane.rotation.x = Math.PI / 2;
        pane.position.set(w, 1.88, zSide);
        planeGroup.add(pane);
      });
    }

    // 3. Sculpted Nose Cone, Weather Radome, Framed Cockpit Canopy & Detailed Cockpit Interior
    const noseGeo = new THREE.ConeGeometry(1.36, 2.85, 28);
    noseGeo.rotateZ(-Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, matAluminum);
    nose.position.set(5.72, 1.44, 0);
    nose.castShadow = true;
    planeGroup.add(nose);

    const radome = new THREE.Mesh(new THREE.SphereGeometry(0.44, 18, 16), matAnodizedDark);
    radome.position.set(6.88, 1.42, 0);
    planeGroup.add(radome);

    const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.28, 1.04, 2.20), matCockpitGlass);
    canopy.position.set(3.55, 2.22, 0);
    canopy.rotation.z = -0.28;
    planeGroup.add(canopy);

    [-0.95, -0.32, 0.32, 0.95].forEach(zM => {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.07, 0.055), matAluminum);
      mullion.position.set(4.15, 2.25, zM);
      mullion.rotation.z = -0.52;
      planeGroup.add(mullion);
    });

    // Cockpit Instrument Glare Shield, Glowing Avionics Dials, Dual Control Yokes, Throttle Quadrant & Seats
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 0.44, 1.72),
      new THREE.MeshStandardMaterial({ color: 0x111920, emissive: 0x00e676, emissiveIntensity: 0.52, roughness: 0.3 })
    );
    dash.position.set(3.82, 1.85, 0);
    planeGroup.add(dash);

    [-0.45, 0.45].forEach(zSeat => {
      // Pilot & Co-Pilot Control Yokes
      const yokeCol = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.38, 8), matAnodizedDark);
      yokeCol.rotation.z = 1.25;
      yokeCol.position.set(3.48, 1.82, zSeat);
      planeGroup.add(yokeCol);
      const yokeWheel = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 6, 12, Math.PI * 1.3), matAnodizedDark);
      yokeWheel.rotation.y = Math.PI / 2;
      yokeWheel.position.set(3.32, 1.88, zSeat);
      planeGroup.add(yokeWheel);

      // Bucket Seats
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.68, 0.46), matRawhide);
      seatBack.position.set(2.85, 1.75, zSeat);
      seatBack.rotation.z = 0.14;
      planeGroup.add(seatBack);
    });

    // Overhead & Center Pedestal Throttle Levers
    for (let t = -1; t <= 1; t++) {
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 8), matRescueRed);
      lever.position.set(3.52, 2.02, t * 0.06);
      lever.rotation.z = 0.38 + t * 0.12;
      planeGroup.add(lever);
    }

    // 4. Twin Pratt & Whitney PT6A Turboprop Nacelles, Turbine Intake Blades & Bent 3-Blade Hartzell Propellers
    [-2.45, 2.45].forEach((zEng, eIdx) => {
      const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.39, 2.45, 20), matAluminum);
      nacelle.rotation.z = Math.PI / 2;
      nacelle.position.set(2.4, 2.65, zEng);
      nacelle.castShadow = true;
      planeGroup.add(nacelle);

      const intakeLip = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.055, 10, 20), matAnodizedDark);
      intakeLip.rotation.y = Math.PI / 2;
      intakeLip.position.set(3.58, 2.65, zEng);
      planeGroup.add(intakeLip);

      const sootRing = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.48, 0.24, 20), matAnodizedDark);
      sootRing.rotation.z = Math.PI / 2;
      sootRing.position.set(2.96, 2.65, zEng);
      planeGroup.add(sootRing);

      [-1, 1].forEach(exSide => {
        const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.48, 12), matRustedSteel);
        exhaust.position.set(2.95, 2.52, zEng + exSide * 0.42);
        exhaust.rotation.x = exSide * 0.82;
        planeGroup.add(exhaust);
      });

      const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.62, 18), matBrass);
      spinner.rotation.z = -Math.PI / 2;
      spinner.position.set(3.82, 2.65, zEng);
      planeGroup.add(spinner);

      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.62, 0.22), matAnodizedDark);
        const ang = (b / 3) * Math.PI * 2 + eIdx * 0.5;
        blade.position.set(3.66, 2.65 + Math.cos(ang) * 0.74, zEng + Math.sin(ang) * 0.74);
        blade.rotation.x = ang + 0.25;
        blade.rotation.z = (b === 0) ? 0.56 : -0.24;
        planeGroup.add(blade);
      }
    });

    // 5. Twin Edo Hydro-Pontoons with Fluted Chines, Antifouling Waterlines, Bow Cleats & N-Struts
    [-1.72, 1.72].forEach(zOff => {
      const pontoonGeo = new THREE.CylinderGeometry(0.50, 0.43, 8.6, 20);
      pontoonGeo.rotateZ(Math.PI / 2);
      const pontoon = new THREE.Mesh(pontoonGeo, matAluminum);
      pontoon.position.set(0.6, 0.22, zOff);
      pontoon.castShadow = true;
      planeGroup.add(pontoon);

      const keelStripe = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.18, 0.92), matRescueRed);
      keelStripe.position.set(0.6, -0.06, zOff);
      planeGroup.add(keelStripe);

      const bowCap = new THREE.Mesh(new THREE.ConeGeometry(0.50, 1.25, 20), matRescueRed);
      bowCap.rotation.z = -Math.PI / 2;
      bowCap.position.set(5.45, 0.24, zOff);
      planeGroup.add(bowCap);

      [-2.0, 0.4, 2.4].forEach((xStrut, sIdx) => {
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 1.58, 10), matAnodizedDark);
        strut.position.set(xStrut, 0.92, zOff * 0.78);
        strut.rotation.x = zOff > 0 ? -0.24 : 0.24;
        if (sIdx === 1) strut.rotation.z = 0.42;
        planeGroup.add(strut);
      });
    });

    // 6. Climbable Sheared Starboard Airfoil Wing Ramp + Flaps + Port Stub Wing with Exposed Wing-Spars
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.68, 0.22, 9.6), matAluminum);
    wing.position.set(0.85, 1.65, 4.9);
    wing.rotation.x = 0.24;
    wing.castShadow = true;
    wing.receiveShadow = true;
    planeGroup.add(wing);

    // Drooped Trailing-Edge Slotted Flap & Aileron Hinge Fairings
    for (let f = 0; f < 4; f++) {
      const fairing = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 8), matRescueRed);
      fairing.rotation.z = Math.PI / 2;
      fairing.position.set(-0.55, 2.15 - f * 0.45, 2.2 + f * 1.9);
      planeGroup.add(fairing);
    }

    const wingTip = new THREE.Mesh(new THREE.BoxGeometry(2.70, 0.24, 1.65), matRescueRed);
    wingTip.position.set(0.85, 0.68, 9.1);
    wingTip.rotation.x = 0.24;
    planeGroup.add(wingTip);

    const portStub = new THREE.Mesh(new THREE.BoxGeometry(2.62, 0.22, 3.45), matAluminum);
    portStub.position.set(0.85, 2.82, -2.5);
    planeGroup.add(portStub);
    for (let s = 0; s < 4; s++) {
      const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.042, 1.35, 8), matAnodizedDark);
      spar.rotation.x = Math.PI / 2 + (s - 1.5) * 0.08;
      spar.position.set(-0.05 + s * 0.58, 2.82, -4.45);
      planeGroup.add(spar);
    }

    // 7. Tail Empennage, Swept Vertical Fin, Rudder Trim Tab & Horizontal Stabilizer
    const tailFin = new THREE.Mesh(new THREE.BoxGeometry(2.55, 3.45, 0.24), matRescueRed);
    tailFin.position.set(-5.1, 2.55, 0);
    tailFin.rotation.z = 0.28;
    tailFin.castShadow = true;
    planeGroup.add(tailFin);

    const hStab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.16, 4.55), matAluminum);
    hStab.position.set(-5.3, 3.2, 0);
    planeGroup.add(hStab);

    const beaconOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xff3d00 })
    );
    beaconOrb.position.set(-5.75, 4.18, 0);
    planeGroup.add(beaconOrb);

    const beaconLight = new THREE.PointLight(0xff3d00, 2.6, 26.0);
    beaconLight.position.set(cx - 4.5, cy + 4.4, cz);
    worldLandmarksGroup.add(beaconLight);
    registerManagedLight(beaconLight, 60.0);

    animatedProps.push({
      update(dt, timeSec) {
        const pulse = Math.sin(timeSec * 6.5) > 0.1 ? 2.8 : 0.15;
        beaconLight.intensity = pulse;
        beaconOrb.material.color.setHex(pulse > 1.0 ? 0xff5252 : 0x4a0e0e);
      }
    });

    mergeStaticGroupByMaterial(planeGroup, new Set([beaconOrb]));
    worldLandmarksGroup.add(planeGroup);
    registerCollider(cx, cz, 3.2, cy - 1.0, cy + 3.5, 'seaplane');
    registerClimbableBox(cx + 0.6, cz + 4.4, 2.2, 5.0, 0.42, cy + 1.85, cy - 0.5, -0.95);
    registerClimbableBox(cx, cz, 4.2, 1.4, 0.42, cy + 2.95, cy + 1.2, 0);

    spawnStoryCrate(
      cx + 4.8, cz + 2.8,
      'cockpitTransponder',
      '📡 Flight 409 Cockpit Transponder',
      'Recovered the UHF Emergency Transponder! (1/3 Radio Outpost Modules)'
    );
  }

  // --- 5B. AAA PELICAN WATERPROOF AVIONICS SURVIVAL CRATES (Molded Ribs, Purge Valve, Heavy Latches & Beacon) ---
  const storyCrates = [];
  function spawnStoryCrate(x, z, moduleKey, title, toastMsg, yOverride) {
    const ty = yOverride !== undefined ? yOverride : getTerrainHeight(x, z);
    const crateGroup = new THREE.Group();
    crateGroup.position.set(x, ty + 0.34, z);

    const box = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.62, 0.78), matSafetyOrange);
    box.castShadow = true;
    box.receiveShadow = true;
    crateGroup.add(box);

    // Molded Structural Impact Bumpers & Lid Overhang
    const lidRim = new THREE.Mesh(new THREE.BoxGeometry(1.10, 0.13, 0.84), matAnodizedDark);
    lidRim.position.y = 0.14;
    crateGroup.add(lidRim);

    for (let r = -0.34; r <= 0.34; r += 0.34) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.65, 0.82), matSafetyOrange);
      rib.position.set(r, 0.0, 0);
      crateGroup.add(rib);
    }

    // Dual Throw-Over Cam Latches, Folding Carry Handles & Brass Pressure Purge Valve
    [-0.28, 0.28].forEach(lx => {
      const latch = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.26, 0.85), matBrass);
      latch.position.set(lx, 0.08, 0);
      crateGroup.add(latch);
    });

    const purgeValve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 12), matBrass);
    purgeValve.rotation.x = Math.PI / 2;
    purgeValve.position.set(0, 0.02, 0.40);
    crateGroup.add(purgeValve);

    const beaconBase = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.08, 14), matAnodizedDark);
    beaconBase.position.set(0, 0.34, 0);
    crateGroup.add(beaconBase);

    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.115, 0.18, 14),
      new THREE.MeshBasicMaterial({ color: 0x00e676 })
    );
    beacon.position.set(0, 0.44, 0);
    crateGroup.add(beacon);

    // Disable raycast on detailed sub-parts and attach 12-triangle hit-proxy
    crateGroup.traverse(c => { if (c.isMesh) c.raycast = () => {}; });
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.95, 0.98), _landmarkProxyMat);
    proxy.position.y = 0.10;
    crateGroup.add(proxy);

    const crateLight = new THREE.PointLight(0x00e676, 1.6, 15.0);
    crateLight.position.set(x, ty + 1.0, z);
    worldLandmarksGroup.add(crateLight);
    registerManagedLight(crateLight, 48.0);

    crateGroup.userData = {
      type: 'story_crate',
      moduleKey,
      promptLabel: `Recover ${title} [Tap Strike]`,
      toastMsg,
      crateLight
    };

    worldLandmarksGroup.add(crateGroup);
    registerInteractiveTarget(crateGroup);
    storyCrates.push(crateGroup);
  }

  // --- 5C. RUINS ON THE LEE SHORE OF OUTER SENTINEL (-62, -268) ---
  function buildSubmergedRuins() {
    const rx = -62.0, rz = -268.0;
    const ruinGroup = new THREE.Group();
    const stoneMat = applyAAARockShader(new THREE.MeshStandardMaterial({
      color: 0x465850, roughness: 0.78, metalness: 0.10
    }));
    const coralPinkMat = new THREE.MeshStandardMaterial({
      color: 0x8c524b, emissive: 0x000000, emissiveIntensity: 0.0, roughness: 0.68
    });
    const coralGoldMat = new THREE.MeshStandardMaterial({
      color: 0x997946, emissive: 0x000000, emissiveIntensity: 0.0, roughness: 0.70
    });

    // Helper for 24-flute carved Doric column shaft with eroded marine limestone relief
    function buildFlutedColumnGeo(rTop, rBot, height) {
      const geo = new THREE.CylinderGeometry(rTop, rBot, height, 32, 10);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
        const ang = Math.atan2(vz, vx);
        // 20 classical concave Doric flutes + subtle entasis swell + drum joint grooves
        const flute = -Math.abs(Math.cos(ang * 10.0)) * 0.055;
        const entasis = Math.sin(((vy / height) + 0.5) * Math.PI) * 0.04;
        const drumSeam = Math.pow(Math.sin(vy * 5.2), 8.0) * -0.025;
        const scale = 1.0 + flute + entasis + drumSeam;
        pos.setXYZ(i, vx * scale, vy, vz * scale);
      }
      geo.computeVertexNormals();
      return geo;
    }

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const px = rx + Math.cos(ang) * 9.5;
      const pz = rz + Math.sin(ang) * 9.5;
      const py = getTerrainHeight(px, pz);
      const isBroken = (i % 3 === 0);
      const colH = isBroken ? 3.2 : 5.4;

      const colGroup = new THREE.Group();
      colGroup.position.set(px, py - 0.2, pz);

      // Stepped Stylobate Plinth & Moulded Torus Base
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.48, 1.85), stoneMat);
      plinth.position.y = 0.24;
      colGroup.add(plinth);
      const torusBase = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.14, 10, 24), stoneMat);
      torusBase.rotation.x = Math.PI / 2;
      torusBase.position.y = 0.54;
      colGroup.add(torusBase);

      const shaft = new THREE.Mesh(buildFlutedColumnGeo(0.58, 0.72, colH), stoneMat);
      shaft.position.y = 0.55 + colH * 0.5;
      if (isBroken) shaft.rotation.z = 0.32;
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      colGroup.add(shaft);

      if (!isBroken) {
        const echinus = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.60, 0.26, 24), stoneMat);
        echinus.position.y = 0.55 + colH + 0.12;
        colGroup.add(echinus);
        const capital = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.38, 1.72), stoneMat);
        capital.position.y = 0.55 + colH + 0.38;
        colGroup.add(capital);
      }

      // Encrusted Reef Brain Coral & Sea Fans at Pillar Base
      const coralGeo = (i % 2 === 0)
        ? new THREE.SphereGeometry(0.34, 10, 8)
        : new THREE.ConeGeometry(0.42, 0.16, 9);
      if (i % 2 === 0) {
        const cp = coralGeo.attributes.position;
        for (let ci = 0; ci < cp.count; ci++) {
          const cx0 = cp.getX(ci), cy0 = cp.getY(ci), cz0 = cp.getZ(ci);
          const lump = 1.0 + Math.sin(cx0 * 18.0) * Math.cos(cz0 * 16.0) * 0.18;
          cp.setXYZ(ci, cx0 * lump, cy0 * 0.45, cz0 * lump);
        }
        coralGeo.computeVertexNormals();
      }
      const coral = new THREE.Mesh(coralGeo, (i % 2 === 0) ? coralPinkMat : coralGoldMat);
      coral.scale.set(1.2, 0.68, 1.1);
      coral.position.set(Math.cos(ang + 0.8) * 0.85, 0.55, Math.sin(ang + 0.8) * 0.85);
      colGroup.add(coral);

      ruinGroup.add(colGroup);
      registerCollider(px, pz, 0.88, py - 1.0, py + colH + 1.0, 'ruin_pillar');
      registerClimbableCircle(px, pz, 0.95, py + colH + 0.8, py - 1.0);
    }

    // 3-Tier Carved Stepped Sunken Altar & Multi-Faceted Bioluminescent Crystal Sanctuary
    const centerY = getTerrainHeight(rx, rz);
    for (let step = 0; step < 3; step++) {
      const rStep = 3.85 - step * 0.85;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(rStep, rStep + 0.28, 0.50, 28), stoneMat);
      const dPos = disc.geometry.attributes.position;
      for (let vi = 0; vi < dPos.count; vi++) {
        const vx = dPos.getX(vi), vy = dPos.getY(vi), vz = dPos.getZ(vi);
        const chip = 1.0 - Math.pow(Math.abs(Math.sin(Math.atan2(vz, vx) * 3.0 + step * 1.7)), 4.0) * 0.22;
        dPos.setXYZ(vi, vx * chip, vy, vz * chip);
      }
      disc.geometry.computeVertexNormals();
      disc.position.set(rx, centerY + step * 0.46, rz);
      disc.receiveShadow = true;
      ruinGroup.add(disc);
    }

    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x168a96,
      emissive: 0x0d5c66,
      emissiveIntensity: 0.42,
      roughness: 0.14,
      metalness: 0.52
    });
    for (let k = 0; k < 7; k++) {
      const h = (k === 0) ? 2.15 : (1.55 - (k % 3) * 0.25);
      const r = (k === 0) ? 0.42 : 0.24;
      const shard = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.25, r, h, 6), crystalMat);
      const a = (k / 6) * Math.PI * 2;
      shard.position.set(
        rx + (k === 0 ? 0 : Math.cos(a) * 0.65),
        centerY + 1.85,
        rz + (k === 0 ? 0 : Math.sin(a) * 0.65)
      );
      if (k > 0) shard.rotation.set(Math.sin(a) * 0.38, k * 0.7, -Math.cos(a) * 0.38);
      ruinGroup.add(shard);
    }

    const trenchLight = new THREE.PointLight(0x1fa8b8, 1.45, 32.0);
    trenchLight.position.set(rx, centerY + 3.0, rz);
    worldLandmarksGroup.add(trenchLight);
    registerManagedLight(trenchLight, 68.0);

    // Partially submerged weathered marker obelisk on the Coral Fan Cay approach shelf so sailors spot the ruins
    const obeliskY = getTerrainHeight(rx + 22.0, rz);
    const obelisk = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.72, 4.4, 6), stoneMat);
    obelisk.position.set(rx + 22.0, obeliskY + 2.0, rz);
    obelisk.rotation.z = -0.14;
    obelisk.castShadow = true;
    ruinGroup.add(obelisk);

    mergeStaticGroupByMaterial(ruinGroup);
    worldLandmarksGroup.add(ruinGroup);

    spawnStoryCrate(
      rx + 1.4, rz - 0.8,
      'submergedBattery',
      '🔋 Waterproof Isotope Battery Core',
      'Recovered the Isotope Battery Core from the ruins on Outer Sentinel! (2/3 Radio Modules)',
      centerY + 1.35
    );
  }

  // --- 5D. PROCEDURAL EZ-TREE BAMBOO GROVES & MANGROVE SWAMPS ---
  let instBambooStalks = null;
  let instBambooRings  = null;
  let instBambooCrowns = null;

  function notchCulm(geo) {
    const p = geo.attributes.position;
    geo.computeBoundingBox();
    const minY = geo.boundingBox.min.y;
    const span = Math.max(0.001, geo.boundingBox.max.y - minY);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const t = (y - minY) / span;
      const ring = Math.pow(Math.abs(Math.sin(t * Math.PI * 7.0)), 12.0);
      const pinch = 1.0 - ring * 0.09;
      p.setXYZ(i, x * pinch, y, z * pinch);
      const wet = t < 0.32 ? 0.58 : 1.0;
      col[i * 3] = wet;
      col[i * 3 + 1] = wet * (t < 0.32 ? 0.9 : 1.0);
      col[i * 3 + 2] = wet * (t < 0.32 ? 0.72 : 1.0);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }

  function buildBambooAndMangroves() {
    const bambooZones = [
      { cx: -68, cz: -28, radius: 20, count: 22 },
      { cx: -102, cz: -142, radius: 26, count: 32 },
      { cx: -455, cz: 390, radius: 28, count: 36 }
    ];

    const maxClumps = 120;
    const stalksPerClump = 3;
    const maxStalks = maxClumps * stalksPerClump;

    const ezMod = window['@dgreenheck/ez-tree'];
    let stalkGeo, stalkMat, crownGeo, crownMat;

    if (ezMod && ezMod.Tree) {
      const ezBamboo = new ezMod.Tree();
      ezBamboo.loadPreset('Aspen Medium');
      ezBamboo.options.seed = 24680;
      ezBamboo.options.bark.type = 'birch';
      ezBamboo.options.bark.tint = 0x92a84e;
      ezBamboo.options.bark.textureScale = { x: 1, y: 2.4 };
      ezBamboo.options.branch.levels = 2;
      ezBamboo.options.branch.length = { 0: 56, 1: 10.5, 2: 7.5, 3: 1 };
      ezBamboo.options.branch.radius = { 0: 0.48, 1: 0.22, 2: 0.15, 3: 0.1 };
      ezBamboo.options.branch.gnarliness = { 0: 0.02, 1: 0.06, 2: 0.08, 3: 0.02 };
      ezBamboo.options.branch.start = { 1: 0.44, 2: 0.24, 3: 0 };
      ezBamboo.options.branch.angle = { 1: 52, 2: 36, 3: 12 };
      ezBamboo.options.branch.children = { 0: 9, 1: 3, 2: 2 };
      ezBamboo.options.branch.sections = { 0: 7, 1: 3, 2: 2, 3: 1 };
      ezBamboo.options.branch.segments = { 0: 6, 1: 3, 2: 3, 3: 3 };
      ezBamboo.options.leaves.type = 'ash';
      ezBamboo.options.leaves.billboard = 'double';
      ezBamboo.options.leaves.tint = 0x78c852;
      ezBamboo.options.leaves.size = 3.05;
      ezBamboo.options.leaves.count = 10;
      ezBamboo.options.leaves.alphaTest = 0.5;
      ezBamboo.generate();

      stalkGeo = ezBamboo.branchesMesh.geometry;
      stalkMat = ezBamboo.branchesMesh.material;
      if (stalkMat && stalkMat.emissive) {
        stalkMat.emissive.setHex(0x14180a);
        stalkMat.emissiveIntensity = 0.35;
      }
      crownGeo = ezBamboo.leavesMesh.geometry;
      crownMat = ezBamboo.leavesMesh.material;
      if (crownMat && crownMat.emissive) {
        crownMat.emissive.setHex(0x183012);
        crownMat.emissiveIntensity = 0.45;
      }
      // Fix EZ-Tree leaf shader stripping #ifdef USE_INSTANCING & blend leaf normals upward for bright close-up foliage
      crownMat.onBeforeCompile = function(shader) {
        shader.uniforms.uTime = { value: 0 };
        shader.uniforms.uWindStrength = { value: new THREE.Vector3(0.42, 0, 0.42) };
        shader.uniforms.uWindFrequency = { value: 0.5 };
        shader.vertexShader = 'uniform float uTime;\nuniform vec3 uWindStrength;\nuniform float uWindFrequency;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <defaultnormal_vertex>',
          `objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.58));
          #include <defaultnormal_vertex>`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `vec4 mvPosition = vec4(transformed, 1.0);
          float windOffset = dot(mvPosition.xyz, vec3(0.09, 0.07, 0.11)) + sin(mvPosition.x * 0.17 + mvPosition.z * 0.13) * 1.8;
          vec3 windSway = uv.y * uWindStrength * (
            0.5 * sin(uTime * uWindFrequency + windOffset) +
            0.3 * sin(2.0 * uTime * uWindFrequency + 1.3 * windOffset) +
            0.2 * sin(5.0 * uTime * uWindFrequency + 1.5 * windOffset)
          );
          mvPosition.xyz += windSway;
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`
        );
        crownMat.userData.shader = shader;
      };
      crownMat.needsUpdate = true;
    } else {
      stalkGeo = new THREE.CylinderGeometry(0.08, 0.12, 8.0, 10, 8);
      notchCulm(stalkGeo);
      stalkGeo.translate(0, 4.0, 0);
      stalkMat = matBambooCulm.clone();
      stalkMat.vertexColors = true;
      stalkMat.roughness = 0.78;
      const cardPos = [];
      for (let card = 0; card < 3; card++) {
        const rot = card * 1.05;
        const cs = Math.cos(rot), sn = Math.sin(rot);
        [[-1.2, 0, 0], [1.2, 0, 0], [1.2, 1.1, 0], [-1.2, 0, 0], [1.2, 1.1, 0], [-1.2, 1.1, 0]].forEach(p => {
          cardPos.push(p[0] * cs, p[1] + 6.8, p[0] * sn);
        });
      }
      crownGeo = new THREE.BufferGeometry();
      crownGeo.setAttribute('position', new THREE.Float32BufferAttribute(cardPos, 3));
      crownGeo.computeVertexNormals();
      crownMat = new THREE.MeshStandardMaterial({ color: 0x72c24e, emissive: 0x183012, emissiveIntensity: 0.42, roughness: 0.75, side: THREE.DoubleSide });
    }

    instBambooStalks = new THREE.InstancedMesh(stalkGeo, stalkMat, maxStalks);
    instBambooStalks.castShadow = false;
    instBambooStalks.receiveShadow = true;
    instBambooStalks.layers.set(3);

    instBambooCrowns = new THREE.InstancedMesh(crownGeo, crownMat, maxStalks);
    instBambooCrowns.castShadow = false;
    instBambooCrowns.receiveShadow = false;
    instBambooCrowns.layers.set(3);

    const dummy = new THREE.Object3D();
    const proxyGeo = new THREE.CylinderGeometry(0.75, 0.75, 6.0, 6);

    let sIdx = 0;
    let bSeed = 1337;
    function bRand() {
      bSeed = (bSeed * 1664525 + 1013904223) >>> 0;
      return bSeed / 4294967296;
    }

    bambooZones.forEach(zone => {
      for (let i = 0; i < zone.count; i++) {
        const ang = bRand() * Math.PI * 2;
        const r = Math.sqrt(bRand()) * zone.radius;
        const bx = zone.cx + Math.cos(ang) * r;
        const bz = zone.cz + Math.sin(ang) * r;
        const by = getTerrainHeight(bx, bz);
        if (by < 0.35 || by > 24.0) continue;

        const clumpStalkIds = [];
        const clumpCrownIds = [];

        for (let s = 0; s < stalksPerClump; s++) {
          if (sIdx >= maxStalks) break;
          const treeScale = (ezMod && ezMod.Tree) ? (0.16 + bRand() * 0.08) : 1.0;
          const ox = bx + (s - 1) * 0.52;
          const oz = bz + ((s % 2) - 0.5) * 0.46;
          const oBy = getTerrainHeight(ox, oz) - 0.22;
          const rx = (bRand() - 0.5) * 0.07;
          const ry = bRand() * Math.PI * 2;
          const rz = (bRand() - 0.5) * 0.07;

          dummy.position.set(ox, oBy, oz);
          dummy.rotation.set(rx, ry, rz);
          dummy.scale.set(treeScale, treeScale * (1.08 + bRand() * 0.18), treeScale);
          dummy.updateMatrix();

          instBambooStalks.setMatrixAt(sIdx, dummy.matrix);
          instBambooCrowns.setMatrixAt(sIdx, dummy.matrix);
          clumpStalkIds.push(sIdx);
          clumpCrownIds.push(sIdx);
          sIdx++;
        }

        const proxy = new THREE.Mesh(proxyGeo, _landmarkProxyMat);
        proxy.position.set(bx, by + 2.8, bz);
        proxy.userData = {
          type: 'bamboo',
          health: 2,
          promptLabel: 'Harvest Giant Bamboo Stalks [Tap Strike]',
          clumpStalkIds,
          clumpRingIds: [],
          clumpCrownIds
        };
        worldLandmarksGroup.add(proxy);
        registerInteractiveTarget(proxy);
        registerCollider(bx, bz, 0.55, by - 0.5, by + 8.5, 'bamboo');
      }
    });

    instBambooStalks.count = sIdx;
    instBambooCrowns.count = sIdx;
    instBambooStalks.instanceMatrix.needsUpdate = true;
    instBambooCrowns.instanceMatrix.needsUpdate = true;
    instBambooStalks.computeBoundingSphere();
    instBambooCrowns.computeBoundingSphere();
    instBambooCrowns.layers.set(1);
    instBambooStalks.matrixAutoUpdate = false;
    instBambooCrowns.matrixAutoUpdate = false;
    worldLandmarksGroup.add(instBambooStalks, instBambooCrowns);

    // 14 Coastal Sculpted Arching Rhizophora Mangrove Prop-Root & Pneumatophore Clusters (No EZ-Tree Canopy Overhead)
    const sharedMangroveRootGeo = (function buildSculptedMangrovePropRootClusterGeo() {
      const positions = [];
      const normals = [];
      const uvs = [];
      const colors = [];
      const indices = [];
      let vOffset = 0;

      function appendTube(curvePts, radii, radialSegs) {
        const steps = curvePts.length - 1;
        const stride = radialSegs + 1;
        for (let i = 0; i <= steps; i++) {
          const p = curvePts[i];
          const r = radii[i];
          const pPrev = curvePts[Math.max(0, i - 1)];
          const pNext = curvePts[Math.min(steps, i + 1)];
          const tang = new THREE.Vector3().subVectors(pNext, pPrev).normalize();
          const upRef = Math.abs(tang.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const binorm = new THREE.Vector3().crossVectors(tang, upRef).normalize();
          const norm = new THREE.Vector3().crossVectors(binorm, tang).normalize();

          // Tidal barnacle / wet emerald algae / sun-bleached upper bark color zonation
          const hNorm = Math.max(0, Math.min(1, (p.y + 0.35) / 1.95));
          let cr, cg, cb;
          if (hNorm < 0.28) {
            // Submerged tidal mud & encrusted gray-white barnacle zone
            const t = hNorm / 0.28;
            cr = 0.36 + t * 0.10;
            cg = 0.38 + t * 0.12;
            cb = 0.34 + t * 0.08;
          } else if (hNorm < 0.56) {
            // Intertidal wet moss & emerald-olive algae band
            const t = (hNorm - 0.28) / 0.28;
            cr = 0.34 + t * 0.24;
            cg = 0.44 - t * 0.04;
            cb = 0.26 + t * 0.06;
          } else {
            // Sun-warmed reddish-brown Rhizophora mangrove bark
            const t = (hNorm - 0.56) / 0.44;
            cr = 0.58 + t * 0.14;
            cg = 0.40 + t * 0.11;
            cb = 0.30 + t * 0.08;
          }

          for (let j = 0; j <= radialSegs; j++) {
            const u = j / radialSegs;
            const ang = u * Math.PI * 2.0;
            const cosA = Math.cos(ang), sinA = Math.sin(ang);
            const gnarl = 1.0 + Math.sin(ang * 3.0 + i * 0.7) * 0.10;
            const nx = norm.x * cosA + binorm.x * sinA;
            const ny = norm.y * cosA + binorm.y * sinA;
            const nz = norm.z * cosA + binorm.z * sinA;
            positions.push(p.x + nx * r * gnarl, p.y + ny * r * gnarl, p.z + nz * r * gnarl);
            normals.push(nx, ny, nz);
            uvs.push(u * 2.0, (i / steps) * 3.5);
            colors.push(cr, cg, cb);
          }
        }
        for (let i = 0; i < steps; i++) {
          for (let j = 0; j < radialSegs; j++) {
            const a = vOffset + i * stride + j;
            const b = a + 1;
            const c = a + stride;
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
          }
        }
        vOffset += (steps + 1) * stride;
      }

      // 1. Central Gnarled Tidal Root Crown / Basal Stump (tapers cleanly at 1.48m with no tree overhead)
      const crownPts = [];
      const crownRadii = [];
      for (let s = 0; s <= 7; s++) {
        const t = s / 7;
        const y = -0.25 + t * 1.72;
        const r = (1.0 - t * 0.72) * 0.28 + Math.sin(t * Math.PI) * 0.06;
        crownPts.push(new THREE.Vector3(Math.sin(t * 4.2) * 0.05, y, Math.cos(t * 3.6) * 0.05));
        crownRadii.push(Math.max(0.04, r));
      }
      appendTube(crownPts, crownRadii, 8);

      // 2. 12 Sculpted Parabolic Arching Stilt/Prop Roots (Primary & Secondary Buttress Arches)
      for (let r = 0; r < 12; r++) {
        const isPrimary = r < 7;
        const baseAng = (r / 12) * Math.PI * 2.0 + (r % 2) * 0.14;
        const startY = isPrimary ? (1.05 + (r % 3) * 0.14) : (0.68 + (r % 2) * 0.15);
        const spanR = isPrimary ? (1.35 + (r % 3) * 0.28) : (1.85 + (r % 2) * 0.32);
        const startR = isPrimary ? 0.12 : 0.62;
        const archPts = [];
        const archRadii = [];
        const archSteps = 9;
        for (let s = 0; s <= archSteps; s++) {
          const t = s / archSteps;
          const rad = startR + (spanR - startR) * Math.pow(t, 0.88);
          const sway = Math.sin(t * Math.PI * 2.0 + r * 1.3) * 0.08 * (1.0 - t * 0.4);
          const ang = baseAng + sway;
          // Parabolic arch cresting outward before plunging vertically into the tidal silt
          const archLift = Math.sin(t * Math.PI) * (isPrimary ? 0.34 : 0.22);
          const y = startY * (1.0 - t * t) + archLift - t * 0.38;
          archPts.push(new THREE.Vector3(Math.cos(ang) * rad, y, Math.sin(ang) * rad));
          archRadii.push((isPrimary ? 0.095 : 0.072) * (1.0 - t * 0.35) + (t > 0.8 ? 0.025 : 0.0));
        }
        appendTube(archPts, archRadii, 7);
      }

      // 3. 10 Vertical Pneumatophore Breathing Root Knees emerging from the surrounding tidal mud
      for (let k = 0; k < 10; k++) {
        const kAng = (k / 10) * Math.PI * 2.0 + 0.25;
        const kRad = 1.15 + (k % 3) * 0.42;
        const kx = Math.cos(kAng) * kRad;
        const kz = Math.sin(kAng) * kRad;
        const kHeight = 0.42 + (k % 4) * 0.14;
        const kneePts = [
          new THREE.Vector3(kx, -0.35, kz),
          new THREE.Vector3(kx + 0.02, kHeight * 0.5, kz - 0.02),
          new THREE.Vector3(kx, kHeight, kz)
        ];
        const kneeRadii = [0.055, 0.042, 0.018];
        appendTube(kneePts, kneeRadii, 5);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeBoundingSphere();
      return geo;
    })();

    const matMangroveRoot = matTimberLog.clone();
    matMangroveRoot.vertexColors = true;
    matMangroveRoot.roughness = 0.72;

    const mangroveCoords = [
      [-62, -46], [-74, -58], [-88, -74], [-95, -96], [-82, -112], [-66, -124],
      [-328, 224], [-428, 372], [-442, 405], [-312, 526], [-348, 548],
      [444, 256], [568, 412], [755, 720]
    ];
    for (let m = 0; m < mangroveCoords.length; m++) {
      let mx = mangroveCoords[m][0];
      let mz = mangroveCoords[m][1];
      let my = getTerrainHeight(mx, mz);
      if (my < -1.4 || my > 1.4) {
        // Nudge along radial outward/inward if shoreline contours shift slightly
        for (let step = 1; step <= 6; step++) {
          const sx = mx + step * 2.5;
          const sy = getTerrainHeight(sx, mz);
          if (sy >= -1.1 && sy <= 1.1) { mx = sx; my = sy; break; }
        }
      }
      if (my < -1.4 || my > 1.4) continue;

      const mGroup = new THREE.Group();
      mGroup.position.set(mx, my, mz);
      mGroup.rotation.y = m * 1.17;
      const mScale = 0.92 + (m % 3) * 0.12;
      mGroup.scale.set(mScale, mScale, mScale);

      const rootClusterMesh = new THREE.Mesh(sharedMangroveRootGeo, matMangroveRoot);
      rootClusterMesh.castShadow = true;
      rootClusterMesh.receiveShadow = true;
      rootClusterMesh.raycast = () => {};
      mGroup.add(rootClusterMesh);

      const mProxy = new THREE.Mesh(proxyGeo, _landmarkProxyMat);
      mProxy.position.y = 1.2;
      mGroup.add(mProxy);

      mGroup.userData = {
        type: 'bamboo',
        health: 3,
        promptLabel: 'Harvest Mangrove Prop-Roots & Fiber [Tap Strike]'
      };
      mGroup.updateMatrixWorld(true);
      mGroup.matrixAutoUpdate = false;
      worldLandmarksGroup.add(mGroup);
      registerInteractiveTarget(mGroup);
      registerCollider(mx, mz, 0.85, my - 1.0, my + 2.2, 'mangrove');
    }
  }

  // --- 5E. MOUNT CALDERA VOLCANO CRATER, WALL-TO-WALL MAGMA CAULDRON, PLUMES & OBSIDIAN NODES ---
  function buildVolcanicCalderaBiome() {
    const mc = window.MOUNT_CALDERA || {
      x: -302.0, z: 64.0, baseR: 112.0, rimR: 36.0, poolEdgeR: 26.5, rimY: 168.0, floorY: 146.5, lavaY: 155.5, footY: 12.0
    };
    const vx = mc.x, vz = mc.z;
    const lavaY = mc.lavaY || 155.5;

    // Build subdivided concentric radial magma disc (14 radial rings x 64 angular segments)
    // Radius = 30.3m embeds cleanly into the inner basalt cauldron wall around 360° -> zero gaps!
    function createRadialMagmaGeometry(radius, rings, segs) {
      const positions = [0, 0, 0];
      const uvs = [0.5, 0.5];
      const indices = [];
      for (let r = 1; r <= rings; r++) {
        const rad = (r / rings) * radius;
        for (let s = 0; s <= segs; s++) {
          const ang = (s / segs) * Math.PI * 2.0;
          const x = Math.cos(ang) * rad;
          const z = Math.sin(ang) * rad;
          positions.push(x, 0, z);
          uvs.push(0.5 + (x / (radius * 2.0)), 0.5 + (z / (radius * 2.0)));
        }
      }
      const ringStride = segs + 1;
      // Inner fan around center vertex 0
      for (let s = 0; s < segs; s++) {
        indices.push(0, 1 + s + 1, 1 + s);
      }
      // Outer concentric quad rings
      for (let r = 1; r < rings; r++) {
        const rowA = 1 + (r - 1) * ringStride;
        const rowB = 1 + r * ringStride;
        for (let s = 0; s < segs; s++) {
          const a = rowA + s, b = rowA + s + 1;
          const c = rowB + s, d = rowB + s + 1;
          indices.push(a, b, c, b, d, c);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }

    const lavaRadius = (mc.poolEdgeR || 26.5) + 3.8;
    const lavaGeo = createRadialMagmaGeometry(lavaRadius, 14, 64);
    const lavaShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: window.fireShaderTime || { value: 0.0 },
        uCalderaCenter: { value: new THREE.Vector2(vx, vz) },
        uPoolEdgeR: { value: mc.poolEdgeR || 26.5 },
        uLavaRadius: { value: lavaRadius }
      },
      vertexShader: `
        uniform float uTime;
        uniform float uLavaRadius;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vRad;
        void main() {
          vUv = uv;
          vec3 pos = position;
          float rad = length(pos.xz);
          vRad = rad;
          float rimDamp = 1.0 - smoothstep(uLavaRadius * 0.55, uLavaRadius * 0.90, rad);
          float swell = (sin(pos.x * 0.34 + uTime * 1.45) * cos(pos.z * 0.34 - uTime * 1.15) * 0.18
                      + sin(rad * 0.65 - uTime * 2.1) * 0.08) * rimDamp;
          vec2 b1 = vec2(sin(uTime * 0.7) * 6.0, cos(uTime * 0.5) * 5.0);
          vec2 b2 = vec2(cos(uTime * 0.45) * 8.0, sin(uTime * 0.85) * 4.0);
          vec2 b3 = vec2(sin(uTime * 0.33 + 2.0) * 3.5, cos(uTime * 0.6 + 1.2) * 7.0);
          float dome = exp(-length(pos.xz - b1) * 0.55) * (0.45 + 0.55 * sin(uTime * 3.1));
          dome += exp(-length(pos.xz - b2) * 0.7) * (0.45 + 0.55 * sin(uTime * 2.4 + 2.0));
          dome += exp(-length(pos.xz - b3) * 0.6) * (0.45 + 0.55 * sin(uTime * 2.8 + 4.1));
          pos.y += swell + dome * 0.45 * rimDamp;
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec2 uCalderaCenter;
        uniform float uPoolEdgeR;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vRad;
        float hash21(vec2 p) {
          p = fract(p * vec2(234.12, 789.45));
          p += dot(p, p + 34.56);
          return fract(p.x * p.y);
        }
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        float fbmMagma(vec2 p) {
          float v = 0.0;
          v += 0.55 * noise2(p); p *= 2.15;
          v += 0.28 * noise2(p); p *= 2.18;
          v += 0.17 * noise2(p);
          return v;
        }
        void main() {
          vec2 relXZ = vWorldPos.xz - uCalderaCenter;
          vec2 uv = relXZ * 0.16;
          float warpX = fbmMagma(uv * 0.8 + vec2(uTime * 0.06, 0.0));
          float warpZ = fbmMagma(uv * 0.8 + vec2(0.0, -uTime * 0.05));
          vec2 warped = uv + vec2(warpX, warpZ) * 0.65;
          float n1 = fbmMagma(warped + vec2(uTime * 0.09, -uTime * 0.07));
          float n2 = fbmMagma(warped * 1.9 - vec2(uTime * 0.13, uTime * 0.11));
          float rNorm = clamp(length(relXZ) / max(1.0, uPoolEdgeR), 0.0, 1.2);
          float rimCool = smoothstep(0.62, 1.02, rNorm);
          float fissures = 1.0 - abs(n1 * 2.0 - 1.0);
          float magma = smoothstep(0.28, 0.78, mix(n1 * 0.58 + n2 * 0.42, fissures * 0.75, 0.35) - rimCool * 0.24);
          // Shore ember ring against the dark basalt cauldron wall
          float wallEmber = smoothstep(0.76, 0.96, rNorm) * (1.0 - smoothstep(0.96, 1.08, rNorm)) * smoothstep(0.35, 0.75, n2);
          vec3 crustCol = vec3(0.07, 0.04, 0.035);
          vec3 deepRed  = vec3(0.68, 0.10, 0.01);
          vec3 orangeLava = vec3(1.00, 0.30, 0.03);
          vec3 yellowCore = vec3(1.00, 0.94, 0.46);
          vec3 col = mix(crustCol, deepRed, smoothstep(0.16, 0.38, magma));
          col = mix(col, orangeLava, smoothstep(0.36, 0.72, magma));
          col = mix(col, yellowCore, smoothstep(0.74, 0.96, magma));
          col += orangeLava * wallEmber * 0.85;
          float bubble = 0.0;
          for (int i = 0; i < 5; i++) {
            float fi = float(i);
            vec2 cell = vec2(hash21(vec2(fi, 1.7)), hash21(vec2(fi, 9.2))) * 2.0 - 1.0;
            cell *= uPoolEdgeR * 0.55;
            float period = 2.2 + hash21(vec2(fi, 3.1)) * 2.6;
            float life = fract(uTime / period + hash21(vec2(fi, 4.4)));
            float d = length(relXZ - cell);
            float core = exp(-d * d / (0.65 + life * 5.0)) * pow(1.0 - life, 0.4) * smoothstep(0.0, 0.07, life);
            float ring = exp(-abs(d - life * 3.4) * 2.2) * (1.0 - life);
            bubble = max(bubble, core * 1.4 + ring * 0.45);
          }
          col = mix(col, yellowCore, clamp(bubble, 0.0, 1.0));
          col += orangeLava * bubble * 0.9;
          gl_FragColor = vec4(col * 1.42, 1.0);
        }
      `
    });
    const lavaPool = new THREE.Mesh(lavaGeo, lavaShaderMat);
    lavaPool.position.set(vx, lavaY, vz);
    worldLandmarksGroup.add(lavaPool);

    const calderaLight = new THREE.PointLight(0xff4d0a, 3.8, 72.0);
    calderaLight.position.set(vx, lavaY + 9.5, vz);
    worldLandmarksGroup.add(calderaLight);
    registerManagedLight(calderaLight, 78.0);

    // Low, deeply embedded weathered basalt slabs on the lower basal apron only (none sticking out on the smooth upper cone)
    for (let s = 0; s < 5; s++) {
      const a = s * 1.25 + 0.25;
      const rad = (mc.baseR || 112.0) * 0.88 + (s % 2) * 8.0;
      const sx = vx + Math.cos(a) * rad;
      const sz = vz + Math.sin(a) * rad;
      const sy = getTerrainHeight(sx, sz);
      if (sy < 2.0) continue;
      const slopeRock = window.createGraniteBoulder(1.4 + (s % 2) * 0.9);
      slopeRock.material = slopeRock.material.clone();
      slopeRock.material.color.set(0x3a332e);
      slopeRock.scale.set(1.25, 0.55, 1.15);
      slopeRock.position.set(sx, sy - 0.85, sz);
      slopeRock.rotation.y = a;
      worldLandmarksGroup.add(slopeRock);
    }

    // --- Multi-Plume Dark & Gray Volcanic Smoke Billowing Directly from the Molten Lava Surface ---
    // Optimized via 3 instanced billboard batches (ash, additive flame bursts, rim steam) with distance-scaled
    // instance budgets, alpha-discard overdraw reduction, and crater lava occlusion culling.
    const vfx = window.getCampfireVFXAssets ? window.getCampfireVFXAssets() : null;
    let updateVolcanoPlumeFn = null;
    if (vfx && vfx.sharedSmokeTex) {
      const plumeGroup = new THREE.Group();
      plumeGroup.position.set(vx, lavaY + 0.6, vz);
      worldLandmarksGroup.add(plumeGroup);

      const baseQuadGeo = new THREE.PlaneBufferGeometry(1.0, 1.0);
      function createBillboardBatch(maxCount, isAdditive, useFog, boundCenterY, boundRadius, worldOriginCenter) {
        const instGeo = new THREE.InstancedBufferGeometry();
        instGeo.index = baseQuadGeo.index;
        instGeo.attributes.position = baseQuadGeo.attributes.position;
        instGeo.attributes.uv = baseQuadGeo.attributes.uv;

        const offsets = new Float32Array(maxCount * 3);
        const scaleRot = new Float32Array(maxCount * 3);
        const colorAlpha = new Float32Array(maxCount * 4);

        const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
        const scaleRotAttr = new THREE.InstancedBufferAttribute(scaleRot, 3);
        const colorAlphaAttr = new THREE.InstancedBufferAttribute(colorAlpha, 4);
        offsetAttr.setUsage(THREE.DynamicDrawUsage);
        scaleRotAttr.setUsage(THREE.DynamicDrawUsage);
        colorAlphaAttr.setUsage(THREE.DynamicDrawUsage);

        instGeo.setAttribute('iOffset', offsetAttr);
        instGeo.setAttribute('iScaleRot', scaleRotAttr);
        instGeo.setAttribute('iColorAlpha', colorAlphaAttr);
        instGeo.instanceCount = 0;
        const cx = worldOriginCenter ? vx : 0.0;
        const cz = worldOriginCenter ? vz : 0.0;
        instGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, boundCenterY, cz), boundRadius);

        const uniforms = useFog
          ? THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: vfx.sharedSmokeTex } }])
          : { uMap: { value: vfx.sharedSmokeTex } };

        const mat = new THREE.ShaderMaterial({
          uniforms,
          fog: useFog,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          side: THREE.DoubleSide,
          blending: isAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
          vertexShader: `
            #include <common>
            ${useFog ? '#include <fog_pars_vertex>' : ''}
            attribute vec3 iOffset;
            attribute vec3 iScaleRot;
            attribute vec4 iColorAlpha;
            varying vec2 vUv;
            varying vec4 vColorAlpha;
            void main() {
              vUv = uv;
              vColorAlpha = iColorAlpha;
              vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
              vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
              float c = cos(iScaleRot.z);
              float s = sin(iScaleRot.z);
              vec2 rotated = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
              vec2 scaled = rotated * iScaleRot.xy;
              vec3 worldCenter = (modelMatrix * vec4(iOffset, 1.0)).xyz;
              vec3 worldVert = worldCenter + camRight * scaled.x + camUp * scaled.y;
              vec4 mvPosition = viewMatrix * vec4(worldVert, 1.0);
              gl_Position = projectionMatrix * mvPosition;
              ${useFog ? '#include <fog_vertex>' : ''}
            }
          `,
          fragmentShader: `
            #include <common>
            ${useFog ? '#include <fog_pars_fragment>' : ''}
            uniform sampler2D uMap;
            varying vec2 vUv;
            varying vec4 vColorAlpha;
            void main() {
              vec4 texel = texture2D(uMap, vUv);
              float alpha = texel.a * vColorAlpha.a;
              if (alpha < 0.035) discard;
              gl_FragColor = vec4(texel.rgb * vColorAlpha.rgb, alpha);
              ${useFog ? '#include <fog_fragment>' : ''}
            }
          `
        });

        const mesh = new THREE.Mesh(instGeo, mat);
        mesh.raycast = () => {};
        mesh.frustumCulled = true;
        mesh.renderOrder = isAdditive ? 3 : 2;
        return { mesh, instGeo, offsets, scaleRot, colorAlpha, offsetAttr, scaleRotAttr, colorAlphaAttr, maxCount };
      }

      // 5 distinct smoke-generating convection vents across the 26.5m-radius molten lava lake inside the volcano core
      const lavaPlumeVents = [
        { ox:  0.0,  oz:  0.0,  spreadScale: 1.00, heightScale: 1.06 }, // Central main cauldron plume
        { ox:  10.5, oz:  4.2,  spreadScale: 0.84, heightScale: 0.90 }, // ENE lava core plume
        { ox: -8.8,  oz:  9.8,  spreadScale: 0.88, heightScale: 0.94 }, // NW lava core plume
        { ox: -11.0, oz: -8.2,  spreadScale: 0.82, heightScale: 0.86 }, // SW lava core plume
        { ox:  7.6,  oz: -11.2, spreadScale: 0.86, heightScale: 0.92 }  // SSE lava core plume
      ];

      // Layer A: 1 instanced draw call for dark soot, charcoal & ash-gray smoke puffs (up to 44 puffs near rim, 12 far silhouette)
      const ashCount = 44;
      const ashBatch = createBillboardBatch(ashCount, false, true, 62.0, 140.0, false);
      plumeGroup.add(ashBatch.mesh);
      const ashPuffs = [];
      for (let i = 0; i < ashCount; i++) {
        const vent = lavaPlumeVents[i % lavaPlumeVents.length];
        const isSurfaceFume = (i % 4 === 0);
        ashPuffs.push({
          ventOx: vent.ox,
          ventOz: vent.oz,
          spreadScale: vent.spreadScale,
          heightScale: vent.heightScale,
          isSurfaceFume,
          shadeTier: i % 4,
          phase: (i / ashCount + (i % 7) * 0.13) % 1.0,
          speed: isSurfaceFume ? (0.075 + (i % 5) * 0.012) : (0.048 + (i % 6) * 0.009),
          angle: (i * 2.39996),
          radialJitter: 0.30 + (i % 5) * 0.18,
          rotOff: (i * 1.17) % (Math.PI * 2),
          rotSpeed: ((i % 2 === 0 ? 1 : -1) * (0.14 + (i % 3) * 0.06))
        });
      }

      // Layer B: 1 instanced additive draw call for caldera throat magma flame bursts (8 puffs max)
      const flameCount = 8;
      const flameBatch = createBillboardBatch(flameCount, true, false, 4.0, 32.0, false);
      plumeGroup.add(flameBatch.mesh);
      const flameBursts = [];
      for (let i = 0; i < flameCount; i++) {
        flameBursts.push({
          phase: Math.random(),
          speed: 0.5 + (i % 5) * 0.09,
          ang: (i / flameCount) * Math.PI * 2 + (i % 3) * 0.4,
          rad: 1.5 + (i % 7) * 2.2
        });
      }

      // Layer C: 1 instanced draw call for rim fumarole steam vents (6 crevices x 3 wisps = 18 puffs max)
      const steamGroup = new THREE.Group();
      worldLandmarksGroup.add(steamGroup);
      const rimVentAngles = [0.42, 1.48, 2.35, 3.25, 4.18, 5.15];
      const steamPuffs = [];
      rimVentAngles.forEach((va, vIdx) => {
        const vRad = (mc.rimR || 36.0) + 0.4 + (vIdx % 2) * 0.6;
        const svx = vx + Math.cos(va) * vRad;
        const svz = vz + Math.sin(va) * vRad;
        const svy = getTerrainHeight(svx, svz) + 0.25;
        for (let k = 0; k < 3; k++) {
          steamPuffs.push({
            bx: svx, by: svy, bz: svz,
            isLight: (k % 2 !== 0),
            phase: (k / 3 + vIdx * 0.17) % 1.0,
            speed: 0.18 + (k % 3) * 0.04,
            ang: va + (k - 1.0) * 0.34
          });
        }
      });
      const steamBatch = createBillboardBatch(steamPuffs.length, false, true, lavaY + 12.0, 58.0, true);
      steamGroup.add(steamBatch.mesh);

      // Layer D: Rising Incandescent Magma Cinders inside cauldron throat (44 sparks in 1 Points draw call)
      let cinderPoints = null;
      let cinderPos = null;
      let cinderData = null;
      const cinderCount = 44;
      if (vfx.sharedSparkTex) {
        const cGeo = new THREE.BufferGeometry();
        cinderPos = new Float32Array(cinderCount * 3);
        cinderData = new Array(cinderCount);
        function initCinder(idx, randAge) {
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.sqrt(Math.random()) * 16.5;
          const maxLife = 1.6 + Math.random() * 1.9;
          const age = randAge ? Math.random() * maxLife : 0.0;
          const vy = 4.2 + Math.random() * 4.8;
          const vxVel = (Math.random() - 0.5) * 1.2;
          const vzVel = (Math.random() - 0.5) * 1.2;
          cinderData[idx] = { age, maxLife, vx: vxVel, vy, vz: vzVel, phase: Math.random() * 6.28 };
          const i3 = idx * 3;
          cinderPos[i3]     = Math.cos(ang) * rad + vxVel * age;
          cinderPos[i3 + 1] = 0.5 + vy * age;
          cinderPos[i3 + 2] = Math.sin(ang) * rad + vzVel * age;
        }
        for (let i = 0; i < cinderCount; i++) initCinder(i, true);
        cGeo.setAttribute('position', new THREE.BufferAttribute(cinderPos, 3));
        const cMat = new THREE.PointsMaterial({
          map: vfx.sharedSparkTex,
          color: 0xffaa33,
          size: 0.65,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        });
        cinderPoints = new THREE.Points(cGeo, cMat);
        cinderPoints.raycast = () => {};
        plumeGroup.add(cinderPoints);
        cinderPoints.userData.respawn = initCinder;
      }

      const _colThroat       = new THREE.Color(0x582414);
      const _colSootBlack    = new THREE.Color(0x18171b);
      const _colDarkCharcoal = new THREE.Color(0x2d2c32);
      const _colSlateGray    = new THREE.Color(0x50535a);
      const _colAshGray      = new THREE.Color(0x787c84);
      const _colSilverSmoke  = new THREE.Color(0x969aa2);
      const _tmpColor        = new THREE.Color();

      updateVolcanoPlumeFn = function (dt, timeSec, camPos, windMult, partScale) {
        if (window._playerInsideCave) {
          plumeGroup.visible = false;
          steamGroup.visible = false;
          lavaPool.visible = false;
          calderaLight.intensity = 0.0;
          return;
        }
        const dx = camPos.x - vx, dz = camPos.z - vz;
        const distSq = dx * dx + dz * dz;

        // Cull recessed cauldron magma shader & point light when viewed strictly from low terrain outside the cone rim
        const craterOccluded = (camPos.y < ((mc.rimY || 168.0) - 22.0)) && (distSq > 7225.0);
        lavaPool.visible = !craterOccluded;

        // Ash smoke column visible up to 880m across the archipelago with distance-scaled density
        const showAsh = distSq < 774400.0;
        plumeGroup.visible = showAsh;
        if (showAsh) {
          const isNear = distSq < 32400.0;  // < 180m
          const isMid  = distSq < 193600.0; // < 440m
          const baseBudget = isNear ? 44 : (isMid ? 22 : 12);
          const minBudget = isNear ? 10 : (isMid ? 7 : 4);
          const activeAsh = Math.min(ashCount, Math.max(minBudget, Math.round(baseBudget * partScale)));
          const lodScaleBoost = isNear ? 1.0 : (isMid ? 1.14 : 1.28);
          const wDrift = windMult * 19.0;

          for (let i = 0; i < activeAsh; i++) {
            const p = ashPuffs[i];
            p.phase = (p.phase + dt * p.speed) % 1.0;
            const t = p.phase;
            const maxRise = p.isSurfaceFume ? 44.0 : (144.0 * p.heightScale);
            const riseY = t * maxRise;
            const baseSpread = p.isSurfaceFume ? (7.5 + t * 18.0) : ((4.8 + Math.pow(t, 1.12) * 22.0) * p.spreadScale);
            const px = p.ventOx + Math.cos(p.angle + t * 2.4 + timeSec * 0.20) * baseSpread * p.radialJitter + Math.pow(t, 1.15) * wDrift;
            const pz = p.ventOz + Math.sin(p.angle + t * 2.1 + timeSec * 0.17) * baseSpread * p.radialJitter - Math.pow(t, 1.15) * wDrift * 0.34;

            const sz = (p.isSurfaceFume
              ? (9.0 + Math.pow(t, 0.75) * 11.5)
              : (7.8 + Math.pow(t, 0.85) * 14.2)) * lodScaleBoost;

            const i3 = i * 3;
            const i4 = i * 4;
            ashBatch.offsets[i3]     = px;
            ashBatch.offsets[i3 + 1] = riseY;
            ashBatch.offsets[i3 + 2] = pz;
            ashBatch.scaleRot[i3]     = sz;
            ashBatch.scaleRot[i3 + 1] = sz * 0.88;
            ashBatch.scaleRot[i3 + 2] = p.rotOff + t * p.rotSpeed * 4.5;

            const baseCol = p.shadeTier === 0 ? _colSootBlack
                          : p.shadeTier === 1 ? _colDarkCharcoal
                          : p.shadeTier === 2 ? _colSlateGray
                          : _colAshGray;
            const topCol  = p.shadeTier === 0 ? _colDarkCharcoal
                          : p.shadeTier === 1 ? _colSlateGray
                          : p.shadeTier === 2 ? _colAshGray
                          : _colSilverSmoke;
            if (t < 0.14) {
              _tmpColor.lerpColors(_colThroat, baseCol, t / 0.14);
            } else {
              _tmpColor.lerpColors(baseCol, topCol, Math.min(1.0, (t - 0.14) / 0.72));
            }
            const env = Math.sin(Math.pow(t, 0.58) * Math.PI);
            const peakAlpha = p.isSurfaceFume ? 0.68 : (p.shadeTier <= 1 ? 0.64 : 0.56);
            ashBatch.colorAlpha[i4]     = _tmpColor.r;
            ashBatch.colorAlpha[i4 + 1] = _tmpColor.g;
            ashBatch.colorAlpha[i4 + 2] = _tmpColor.b;
            ashBatch.colorAlpha[i4 + 3] = env * (peakAlpha - t * 0.18);
          }
          ashBatch.instGeo.instanceCount = activeAsh;
          ashBatch.offsetAttr.needsUpdate = true;
          ashBatch.scaleRotAttr.needsUpdate = true;
          ashBatch.colorAlphaAttr.needsUpdate = true;

          let burst = 0.0;
          const showFlames = !craterOccluded && distSq < 21025.0; // within 145m & visible
          flameBatch.mesh.visible = showFlames;
          if (showFlames) {
            const activeFlames = Math.min(flameCount, Math.max(4, Math.round(6 * partScale)));
            for (let i = 0; i < activeFlames; i++) {
              const f = flameBursts[i];
              f.phase = (f.phase + dt * f.speed) % 1.0;
              const t = f.phase;
              const hot = t < 0.36 ? Math.sin((t / 0.36) * Math.PI) : 0.0;
              const rise = Math.pow(Math.min(t / 0.36, 1.0), 0.6) * 7.2;
              const sc = 0.8 + hot * 4.6;
              const i3 = i * 3, i4 = i * 4;
              flameBatch.offsets[i3]     = Math.cos(f.ang) * f.rad;
              flameBatch.offsets[i3 + 1] = rise;
              flameBatch.offsets[i3 + 2] = Math.sin(f.ang) * f.rad;
              flameBatch.scaleRot[i3]     = sc * 0.5;
              flameBatch.scaleRot[i3 + 1] = sc;
              flameBatch.scaleRot[i3 + 2] = 0.0;
              const isHotCore = t < 0.1;
              flameBatch.colorAlpha[i4]     = 1.0;
              flameBatch.colorAlpha[i4 + 1] = isHotCore ? 0.949 : 0.29;
              flameBatch.colorAlpha[i4 + 2] = isHotCore ? 0.690 : 0.0;
              flameBatch.colorAlpha[i4 + 3] = hot * 0.9;
              if (hot > burst) burst = hot;
            }
            flameBatch.instGeo.instanceCount = activeFlames;
            flameBatch.offsetAttr.needsUpdate = true;
            flameBatch.scaleRotAttr.needsUpdate = true;
            flameBatch.colorAlphaAttr.needsUpdate = true;
          } else {
            flameBatch.instGeo.instanceCount = 0;
          }
          calderaLight.intensity = craterOccluded ? 0.0 : (3.8 + burst * 5.5);

          if (cinderPoints && cinderPos && cinderData) {
            const showCinders = !craterOccluded && distSq < 13225.0; // within 115m
            cinderPoints.visible = showCinders;
            if (showCinders) {
              const activeSparks = Math.max(10, Math.floor(cinderCount * partScale));
              cinderPoints.geometry.setDrawRange(0, activeSparks);
              for (let i = 0; i < activeSparks; i++) {
                const cd = cinderData[i];
                cd.age += dt;
                if (cd.age >= cd.maxLife || cinderPos[i * 3 + 1] > 23.0) {
                  cinderPoints.userData.respawn(i, false);
                } else {
                  const i3 = i * 3;
                  const swirl = Math.cos(timeSec * 2.4 + cd.phase) * 1.4;
                  cinderPos[i3]     += (cd.vx + swirl + windMult * 0.6) * dt;
                  cinderPos[i3 + 1] += cd.vy * dt;
                  cinderPos[i3 + 2] += (cd.vz - swirl * 0.7) * dt;
                }
              }
              cinderPoints.geometry.attributes.position.needsUpdate = true;
            }
          }
        } else {
          calderaLight.intensity = 0.0;
        }

        const showSteam = distSq < 34225.0; // within 185m
        steamGroup.visible = showSteam;
        if (showSteam) {
          const activeSteam = Math.min(steamPuffs.length, Math.max(3, Math.round(steamPuffs.length * partScale)));
          for (let s = 0; s < activeSteam; s++) {
            const st = steamPuffs[s];
            st.phase = (st.phase + dt * st.speed) % 1.0;
            const t = st.phase;
            const sy = st.by + t * 18.5;
            const sx = st.bx + Math.cos(st.ang) * (t * 3.4) + t * windMult * 3.2;
            const sz = st.bz + Math.sin(st.ang) * (t * 3.4) - t * windMult * 1.1;
            const sc = 2.4 + Math.pow(t, 0.8) * 6.0;
            const s3 = s * 3, s4 = s * 4;
            steamBatch.offsets[s3]     = sx;
            steamBatch.offsets[s3 + 1] = sy;
            steamBatch.offsets[s3 + 2] = sz;
            steamBatch.scaleRot[s3]     = sc;
            steamBatch.scaleRot[s3 + 1] = sc * 0.88;
            steamBatch.scaleRot[s3 + 2] = st.ang + t * 2.2;
            steamBatch.colorAlpha[s4]     = st.isLight ? 0.604 : 0.416;
            steamBatch.colorAlpha[s4 + 1] = st.isLight ? 0.627 : 0.431;
            steamBatch.colorAlpha[s4 + 2] = st.isLight ? 0.659 : 0.459;
            steamBatch.colorAlpha[s4 + 3] = Math.sin(t * Math.PI) * 0.42;
          }
          steamBatch.instGeo.instanceCount = activeSteam;
          steamBatch.offsetAttr.needsUpdate = true;
          steamBatch.scaleRotAttr.needsUpdate = true;
          steamBatch.colorAlphaAttr.needsUpdate = true;
        } else {
          steamBatch.instGeo.instanceCount = 0;
        }
      };
    }
    window.updateVolcanoPlume = updateVolcanoPlumeFn;

    const obsProxyGeo = new THREE.CylinderGeometry(0.75, 0.75, 1.85, 8);
    obsProxyGeo.translate(0, 0.85, 0);
    const obsidianCoords = [
      // East basal skirt & lava-tube portal apron of Mount Caldera (kept off the steep upper cone walls)
      [-204, 62], [-209, 78], [-218, 92], [-226, 42], [-242, 142], [-276, 158],
      // Cinder Cone Islet (NE Volcanic Arc)
      [530, -412], [548, -426], [522, -432],
      // Magma Trench Bastion (NE Raft Stronghold at 844, -791)
      [832, -778], [854, -798], [838, -806],
      // Northwest Obsidian Stronghold (NW Raft Stronghold at -797, -814)
      [-784, -802], [-808, -822], [-792, -830]
    ];
    function spawnObsidianNode(ox, oy, oz, isLavaTubeVein) {
      const node = new THREE.Group();
      node.position.set(ox, oy, oz);
      const baseRockGeo = window.buildLoveRockGeometry ? window.buildLoveRockGeometry(0.56, 2, 4) : new THREE.DodecahedronGeometry(0.56, 1);
      const baseRock = new THREE.Mesh(baseRockGeo, matAnodizedDark);
      baseRock.scale.set(1.3, 0.48, 1.2);
      baseRock.position.y = 0.14;
      baseRock.raycast = () => {};
      node.add(baseRock);

      const shardMat = isLavaTubeVein
        ? new THREE.MeshStandardMaterial({
            color: 0x0b0e14,
            emissive: 0xb71c1c,
            emissiveIntensity: 0.42,
            roughness: 0.08,
            metalness: 0.85
          })
        : matObsidianGlass;

      for (let s = 0; s < 6; s++) {
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(0.32 + (s % 2) * 0.12, 1.45 + (s % 3) * 0.35, 5),
          shardMat
        );
        const a = (s / 6) * Math.PI * 2;
        const rad = (s === 0) ? 0.0 : 0.28;
        shard.position.set(Math.cos(a) * rad, 0.62, Math.sin(a) * rad);
        shard.rotation.set(Math.sin(a) * 0.28, s * 1.1, -Math.cos(a) * 0.28);
        shard.castShadow = !isLavaTubeVein;
        shard.raycast = () => {};
        node.add(shard);
      }
      node.add(new THREE.Mesh(obsProxyGeo, _landmarkProxyMat));

      node.userData = {
        type: 'obsidian',
        isLavaTubeVein: !!isLavaTubeVein,
        health: 2,
        promptLabel: isLavaTubeVein
          ? 'Mine Magma-Veined Lava Tube Obsidian (+2 Obsidian, +1 Flint) [Tap Strike]'
          : 'Mine Volcanic Obsidian Shard [Tap Strike]'
      };
      mergeStaticGroupByMaterial(node);
      worldLandmarksGroup.add(node);
      minorStaticProps.push({ obj: node, x: ox, z: oz, maxDist: 220.0 });
      registerInteractiveTarget(node);
      registerCollider(ox, oz, 0.68, oy - 0.5, oy + 1.8, 'obsidian');
    }

    obsidianCoords.forEach(([ox, oz]) => {
      const oy = getTerrainHeight(ox, oz);
      if (oy < 0.5) return;
      spawnObsidianNode(ox, oy, oz, false);
    });

    // Deep Lava Tube Magma-Veined Obsidian Clusters along CAVE_SYSTEMS[2]
    const lavaTubeCave = window.CAVE_SYSTEMS && window.CAVE_SYSTEMS[2];
    if (lavaTubeCave) {
      [0.18, 0.34, 0.50, 0.66, 0.80, 0.90].forEach((sVal, vIdx) => {
        const pt = lavaTubeCave.getPoint(sVal);
        const side = (vIdx % 2 === 0) ? 1 : -1;
        const wallOff = (pt.halfW || 4.2) * 0.62 * side;
        const vxNode = pt.x + pt.perpX * wallOff;
        const vzNode = pt.z + pt.perpZ * wallOff;
        const floorRelief = window.evalCaveFloorRelief
          ? window.evalCaveFloorRelief(true, sVal * (lavaTubeCave.totalLength || 98.0), wallOff, pt.halfW || 4.2, vxNode, vzNode, sVal)
          : 0.0;
        spawnObsidianNode(vxNode, pt.floorY + floorRelief - 0.03, vzNode, true);
      });
    }

    // Register Active Geothermal Steam Vents (warm body temperature & boost stamina recovery when nearby)
    const geothermalVents = [
      { x: -213.5, z: 68.4, y: 33.2, name: 'Lava Tube Portal Fumarole' },
      { x: 540.0,  z: -420.0, y: 22.0, name: 'Cinder Cone Fumarole' },
      { x: 841.0,  z: -788.0, y: 28.0, name: 'Magma Trench Fumarole' }
    ];
    [0.42, 1.48, 2.55, 3.65, 4.78].forEach(va => {
      const gx = vx + Math.cos(va) * ((mc.rimR || 36.0) + 0.8);
      const gz = vz + Math.sin(va) * ((mc.rimR || 36.0) + 0.8);
      geothermalVents.push({ x: gx, z: gz, y: getTerrainHeight(gx, gz), name: 'Caldera Rim Fumarole' });
    });
    window.geothermalVents = geothermalVents;

    // Mount Caldera Summit Survey Cairn & Obsidian Signal Brazier on East Rim Overlook (-265.2, 64.0)
    {
      const bx = vx + (mc.rimR || 36.0) + 0.8;
      const bz = vz;
      const by = getTerrainHeight(bx, bz);
      const brazierGroup = new THREE.Group();
      brazierGroup.position.set(bx, by, bz);

      const cairnBase = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.25, 0.85, 8), matAnodizedDark);
      cairnBase.position.y = 0.42;
      brazierGroup.add(cairnBase);

      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.48, 0.55, 8), matObsidianGlass);
      bowl.position.y = 1.05;
      brazierGroup.add(bowl);

      const brazierVfx = window.getCampfireVFXAssets ? window.getCampfireVFXAssets() : null;
      const emberCoreMat = new THREE.MeshStandardMaterial({
        map: brazierVfx ? brazierVfx.sharedCoalTex : null,
        color: brazierVfx ? 0xffffff : 0x2c160c,
        emissive: 0xff4500,
        emissiveMap: brazierVfx ? brazierVfx.sharedCoalEmissiveTex : null,
        emissiveIntensity: 0.22,
        roughness: 0.88
      });
      const emberCore = new THREE.Mesh(new THREE.DodecahedronGeometry(0.46, 1), emberCoreMat);
      emberCore.scale.set(1.1, 0.55, 1.1);
      emberCore.position.y = 1.28;
      brazierGroup.add(emberCore);

      let brazierFlame;
      if (brazierVfx && brazierVfx.buildVolumetricFlameCluster) {
        brazierFlame = brazierVfx.buildVolumetricFlameCluster({
          width: 1.10,
          height: 1.55,
          wrapRadius: 0.24,
          upMix: 0.10,
          haloOpacity: 0.28,
          isTorch: false
        });
        brazierFlame.position.y = 1.24;
      } else {
        brazierFlame = new THREE.Mesh(
          new THREE.ConeGeometry(0.42, 1.35, 7),
          new THREE.MeshBasicMaterial({ color: 0xffab00 })
        );
        brazierFlame.position.y = 1.85;
      }
      brazierFlame.visible = false;
      brazierGroup.add(brazierFlame);

      brazierGroup.traverse(c => { if (c.isMesh) c.raycast = () => {}; });
      const bProxy = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.3, 8), _landmarkProxyMat);
      bProxy.position.y = 1.1;
      brazierGroup.add(bProxy);

      brazierGroup.userData = {
        type: 'summit_brazier',
        lit: false,
        flame: brazierFlame,
        ember: emberCore,
        promptLabel: 'Ignite Mount Caldera Summit Signal Brazier (+168m Peak) [Tap Strike]'
      };
      worldLandmarksGroup.add(brazierGroup);
      registerInteractiveTarget(brazierGroup);
      registerCollider(bx, bz, 0.95, by - 0.5, by + 2.2, 'brazier');
      geothermalVents.push({ x: bx, z: bz, y: by, name: 'Mount Caldera Summit Brazier' });
    }

    const cave1 = window.CAVE_SYSTEMS && window.CAVE_SYSTEMS[0];
    if (cave1) {
      const cenotePt = cave1.getPoint(0.78);
      const cenoteRelief = window.evalCaveFloorRelief
        ? window.evalCaveFloorRelief(false, 0.78 * (cave1.totalLength || 92.0), 0.0, cenotePt.halfW || 7.2, cenotePt.x, cenotePt.z, 0.78)
        : 0.0;
      spawnStoryCrate(
        cenotePt.x, cenotePt.z,
        'cavernRecorder',
        '📼 Flight 409 Black Box & Signal Amplifier',
        'Recovered the Signal Amplifier inside the Subterranean Cenote! (3/3 Radio Modules)',
        cenotePt.floorY + Math.max(0.0, cenoteRelief) + 0.25
      );
    }
  }

  // --- 5F. ABANDONED RADIO OUTPOST & WEATHER STATION (Plateau at X: 52, Z: 96, Y: ~19.5m) ---
  function buildRadioOutpost() {
    const ox = 52.0, oz = 96.0;
    const oy = getTerrainHeight(ox, oz);
    const outpostGroup = new THREE.Group();
    outpostGroup.position.set(ox, oy, oz);

    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x646c66,
      normalMap: aaaSurfacePBRAssets.steelNormTex,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughness: 0.84
    });

    // Deep reinforced retaining foundation skirt + corner concrete piers so downhill corners never float on slopes
    const foundationPlinth = new THREE.Mesh(new THREE.BoxGeometry(11.35, 3.8, 9.75), concreteMat);
    foundationPlinth.position.set(0, -1.68, 0);
    foundationPlinth.receiveShadow = true;
    outpostGroup.add(foundationPlinth);

    [[-5.4, -4.6], [5.4, -4.6], [-5.4, 4.6], [5.4, 4.6]].forEach(([px, pz]) => {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.95, 4.2, 0.95), concreteMat);
      pier.position.set(px, -1.78, pz);
      pier.receiveShadow = true;
      outpostGroup.add(pier);
    });

    const pad = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.55, 10.0), concreteMat);
    pad.position.set(0, 0.22, 0);
    pad.receiveShadow = true;
    outpostGroup.add(pad);

    const bunker = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.1, 4.4), concreteMat);
    bunker.position.set(-2.2, 1.8, -1.4);
    bunker.castShadow = true;
    bunker.receiveShadow = true;
    outpostGroup.add(bunker);

    // Bunker Roof Parapet Rim & Reinforced Corner Buttresses
    const roofRim = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.24, 4.7), matAnodizedDark);
    roofRim.position.set(-2.2, 3.38, -1.4);
    outpostGroup.add(roofRim);

    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.32, 2.28, 0.22), matAnodizedDark);
    doorFrame.position.set(-2.2, 1.38, 0.80);
    outpostGroup.add(doorFrame);

    const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.15, 0.14), matRustedSteel);
    door.position.set(-2.2, 1.35, 0.85);
    outpostGroup.add(door);

    registerCollider(ox - 2.2, oz - 1.4, 2.7, oy, oy + 3.5, 'bunker');
    registerClimbableBox(ox - 2.2, oz - 1.4, 2.6, 2.2, 0, oy + 3.35, oy);

    // Photovoltaic Solar Array with Aluminum Framing
    const solarPanel = new THREE.Mesh(
      new THREE.BoxGeometry(3.85, 0.12, 2.25),
      new THREE.MeshStandardMaterial({
        color: 0x0e2240,
        normalMap: aaaSurfacePBRAssets.aluNormTex,
        normalScale: new THREE.Vector2(0.6, 0.6),
        roughness: 0.14,
        metalness: 0.84
      })
    );
    solarPanel.position.set(-2.2, 3.74, -1.4);
    solarPanel.rotation.x = 0.32;
    outpostGroup.add(solarPanel);

    const towerX = 2.6, towerZ = 1.6;
    const towerH = 22.0;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    corners.forEach(([sx, sz]) => {
      const foot = getTerrainHeight(ox + towerX + sx * 1.15, oz + towerZ + sz * 1.15) - oy;
      const h = Math.max(14.0, towerH - foot);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.19, h, 10), matRustedSteel);
      leg.position.set(towerX + sx * 1.15, foot + h * 0.5, towerZ + sz * 1.15);
      leg.rotation.z = sx * 0.055;
      leg.rotation.x = -sz * 0.055;
      leg.castShadow = true;
      outpostGroup.add(leg);
    });
    registerCollider(ox + towerX, oz + towerZ, 1.9, oy, oy + towerH, 'radio_tower');

    for (let tier = 1; tier <= 6; tier++) {
      const ty = tier * 3.3;
      const spread = 1.65 * (1.0 - (ty / towerH) * 0.52);
      const ring = new THREE.Mesh(new THREE.BoxGeometry(spread * 2, 0.14, spread * 2), matRustedSteel);
      ring.position.set(towerX, ty, towerZ);
      outpostGroup.add(ring);
    }

    // Parabolic Microwave Dish + Tripod Feedhorn Assembly
    const dishGroup = new THREE.Group();
    dishGroup.position.set(towerX - 0.88, 16.5, towerZ);
    dishGroup.rotation.set(0.22, 0.65, -0.16);
    const dish = new THREE.Mesh(new THREE.ConeGeometry(1.42, 0.68, 24, 1, true), matAluminum);
    dish.rotation.z = Math.PI / 2;
    dishGroup.add(dish);
    const feedHorn = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.95, 10), matBrass);
    feedHorn.rotation.z = Math.PI / 2;
    feedHorn.position.set(-0.52, 0, 0);
    dishGroup.add(feedHorn);
    outpostGroup.add(dishGroup);

    const anemometer = new THREE.Group();
    anemometer.position.set(towerX, towerH + 0.6, towerZ);
    for (let c = 0; c < 3; c++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.04, 0.04), matAnodizedDark);
      arm.rotation.y = (c / 3) * Math.PI * 2;
      const cup = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 10), matAluminum);
      cup.position.set(0.48, 0, 0);
      arm.add(cup);
      anemometer.add(arm);
    }
    outpostGroup.add(anemometer);

    const apexBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xff1744 })
    );
    apexBeacon.position.set(towerX, towerH + 1.15, towerZ);
    outpostGroup.add(apexBeacon);

    const towerLight = new THREE.PointLight(0xff1744, 2.4, 48.0);
    towerLight.position.set(ox + towerX, oy + towerH + 1.2, oz + towerZ);
    worldLandmarksGroup.add(towerLight);
    registerManagedLight(towerLight, 75.0);

    // SOS Radio Transceiver Console with CRT Oscilloscope Display
    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(ox - 2.2, oy + 0.3, oz + 1.55);

    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.76, 1.06, 0.90), matAnodizedDark);
    desk.position.y = 0.53;
    desk.castShadow = true;
    consoleGroup.add(desk);

    const crtCanvas = document.createElement('canvas');
    crtCanvas.width = 256; crtCanvas.height = 128;
    const crtCtx = crtCanvas.getContext('2d');
    function drawCRT(repaired) {
      crtCtx.fillStyle = repaired ? '#041f12' : '#241004';
      crtCtx.fillRect(0, 0, 256, 128);
      crtCtx.strokeStyle = repaired ? 'rgba(0, 230, 118, 0.25)' : 'rgba(255, 145, 0, 0.22)';
      crtCtx.lineWidth = 1;
      for (let x = 0; x < 256; x += 32) { crtCtx.beginPath(); crtCtx.moveTo(x, 0); crtCtx.lineTo(x, 128); crtCtx.stroke(); }
      for (let y = 0; y < 128; y += 32) { crtCtx.beginPath(); crtCtx.moveTo(0, y); crtCtx.lineTo(256, y); crtCtx.stroke(); }
      crtCtx.strokeStyle = repaired ? '#00e676' : '#ff9100';
      crtCtx.lineWidth = 3;
      crtCtx.beginPath();
      for (let x = 0; x < 256; x += 4) {
        const y = 64 + Math.sin(x * (repaired ? 0.12 : 0.05)) * (repaired ? 34 : 12);
        if (x === 0) crtCtx.moveTo(x, y); else crtCtx.lineTo(x, y);
      }
      crtCtx.stroke();
    }
    drawCRT(false);
    const crtTex = new THREE.CanvasTexture(crtCanvas);
    const screenMat = new THREE.MeshBasicMaterial({ map: crtTex });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.52, 0.14), screenMat);
    screen.position.set(0, 1.26, -0.18);
    screen.rotation.x = -0.25;
    consoleGroup.add(screen);

    for (let d = -2; d <= 2; d++) {
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.065, 12), matBrass);
      dial.rotation.x = Math.PI / 2;
      dial.position.set(d * 0.22, 0.88, 0.46);
      consoleGroup.add(dial);
    }

    // Handset Microphone & Coiled Cord on Console Side
    const mic = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.10), matSafetyOrange);
    mic.position.set(0.72, 1.12, 0.15);
    consoleGroup.add(mic);

    consoleGroup.traverse(c => { if (c.isMesh) c.raycast = () => {}; });
    const cProxy = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.6, 1.1), _landmarkProxyMat);
    cProxy.position.y = 0.8;
    consoleGroup.add(cProxy);

    consoleGroup.userData = {
      type: 'radio_console',
      promptLabel: 'Inspect SOS Radio Transceiver [Tap Strike]'
    };
    worldLandmarksGroup.add(consoleGroup);
    registerInteractiveTarget(consoleGroup);

    let wasRepaired = false;
    animatedProps.push({
      update(dt, timeSec) {
        anemometer.rotation.y += dt * 4.8;
        if (campaign.outpostRepaired) {
          if (!wasRepaired) {
            wasRepaired = true;
            drawCRT(true);
            crtTex.needsUpdate = true;
          }
          apexBeacon.material.color.setHex(0x00e676);
          towerLight.color.setHex(0x00e676);
          towerLight.intensity = 2.6 + Math.sin(timeSec * 5.0) * 1.2;
        } else {
          const blink = Math.sin(timeSec * 3.8) > 0.2;
          apexBeacon.material.color.setHex(blink ? 0xff1744 : 0x3b0812);
          towerLight.intensity = blink ? 2.4 : 0.2;
        }
      }
    });

    mergeStaticGroupByMaterial(outpostGroup, new Set([anemometer, apexBeacon]));
    worldLandmarksGroup.add(outpostGroup);
  }

  // --- 5G. OUTER ARCHIPELAGO & PERIMETER EXPEDITION LANDMARKS ---
  function buildArchipelagoExpeditionLandmarks() {
    const expGroup = new THREE.Group();
    const stoneMat = applyAAARockShader(new THREE.MeshStandardMaterial({
      color: 0x626b6e, roughness: 0.88, metalness: 0.04
    }));
    const coralArchMat = applyAAARockShader(new THREE.MeshStandardMaterial({
      color: 0x9c8c78, roughness: 0.84, metalness: 0.03
    }));

    function buildStoneCairn(cx, cz, scale = 1.0) {
      const cy = getTerrainHeight(cx, cz);
      const cairn = new THREE.Group();
      cairn.position.set(cx, cy, cz);
      const radii = [0.78, 0.56, 0.38, 0.24, 0.14];
      let hAcc = 0.22 * scale;
      for (let i = 0; i < radii.length; i++) {
        const r = radii[i] * scale;
        const sGeo = window.buildLoveRockGeometry ? window.buildLoveRockGeometry(r, 2, i) : new THREE.DodecahedronGeometry(r, 0);
        const stone = new THREE.Mesh(sGeo, stoneMat);
        stone.scale.set(1.18, 0.56, 1.05);
        stone.position.set(((i % 2) - 0.5) * 0.04 * scale, hAcc, ((i % 3) - 1) * 0.03 * scale);
        stone.rotation.y = i * 0.85;
        stone.castShadow = true;
        stone.receiveShadow = true;
        cairn.add(stone);
        hAcc += r * 0.72;
      }
      mergeStaticGroupByMaterial(cairn);
      expGroup.add(cairn);
      registerCollider(cx, cz, 0.85 * scale, cy - 0.5, cy + 2.4 * scale, 'cairn');
    }

    // 1. Sheltered Reef Cay (-342, 224): Beached Castaway Driftwood Dinghy + Crest Cairn
    {
      const dx = -322.0, dz = 224.0;
      const dy = getTerrainHeight(dx, dz);
      const dinghy = new THREE.Group();
      dinghy.position.set(dx, dy + 0.22, dz);
      dinghy.rotation.set(0.08, -1.35, 0.16);
      const dinghyMat = matTimberLog.clone();
      dinghyMat.side = THREE.DoubleSide;
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.62, 3.6, 10, 1, false, 0, Math.PI), dinghyMat);
      hull.rotation.z = Math.PI / 2;
      hull.rotation.x = Math.PI;
      hull.scale.set(1.0, 0.65, 1.0);
      hull.castShadow = true;
      dinghy.add(hull);
      for (let s = -1; s <= 1; s += 2) {
        const thwart = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 1.28), matTimberLog);
        thwart.position.set(s * 0.65, 0.26, 0);
        dinghy.add(thwart);
        const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.25, 6), matTimberLog);
        stake.position.set(s * 1.4, 0.35, 0.95);
        stake.rotation.z = 0.14;
        dinghy.add(stake);
      }
      expGroup.add(dinghy);
      buildStoneCairn(-336.0, 224.0, 1.15);
    }

    // 2. NW Obsidian Stronghold (-765, -775) & Basalt Arch Isle (-495, -410): Coastal Watchtower Beacon & Monoliths
    {
      const wx = -794.0, wz = -811.0;
      const wy = getTerrainHeight(wx, wz);
      const tower = new THREE.Group();
      tower.position.set(wx, wy, wz);
      const towerH = 6.2;
      [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]].forEach(([px, pz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, towerH + 2.2, 8), matTimberLog);
        post.position.set(px, (towerH + 2.2) * 0.5 - 0.3, pz);
        post.castShadow = true;
        tower.add(post);
      });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.28, 3.9), matTimberLog);
      deck.position.y = towerH;
      deck.castShadow = true;
      deck.receiveShadow = true;
      tower.add(deck);
      registerClimbableBox(wx, wz, 1.95, 1.95, 0, wy + towerH + 0.14, wy);
      const roof = createLayeredThatchRoof(2.95, 1.65);
      roof.position.y = towerH + 2.55;
      tower.add(roof);
      const lantern = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 0.42, 8),
        new THREE.MeshBasicMaterial({ color: 0xffc107 })
      );
      lantern.position.set(0, towerH + 1.35, 0);
      tower.add(lantern);
      const nwBeaconLight = new THREE.PointLight(0xffb300, 2.8, 48.0);
      nwBeaconLight.position.set(wx, wy + towerH + 1.4, wz);
      worldLandmarksGroup.add(nwBeaconLight);
      registerManagedLight(nwBeaconLight, 78.0);
      mergeStaticGroupByMaterial(tower);
      expGroup.add(tower);

      // Basalt Arch Isle monolith ring
      for (let m = 0; m < 4; m++) {
        const ang = (m / 4) * Math.PI * 2 + 0.35;
        const mx = -490.0 + Math.cos(ang) * 4.5;
        const mz = -405.0 + Math.sin(ang) * 4.5;
        const my = getTerrainHeight(mx, mz);
        const slab = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.72, 3.6 + (m % 2) * 1.1, 6), stoneMat);
        slab.position.set(mx, my + 1.5, mz);
        slab.rotation.set((m % 2 - 0.5) * 0.16, ang, 0.12);
        slab.castShadow = true;
        expGroup.add(slab);
      }
      buildStoneCairn(-490.0, -405.0, 1.3);
    }

    // 3. NE Magma Trench Bastion (795, -715) & Cinder Cone Islet (540, -420): Fumarole Cones
    {
      const vents = [
        { x: 841.0, z: -788.0, r: 2.4, h: 3.6 },
        { x: 540.0, z: -420.0, r: 1.9, h: 2.8 }
      ];
      vents.forEach((v, idx) => {
        const vy = getTerrainHeight(v.x, v.z);
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(v.r * 0.45, v.r, v.h, 10, 1, true), stoneMat);
        cone.position.set(v.x, vy + v.h * 0.42, v.z);
        cone.castShadow = true;
        cone.receiveShadow = true;
        expGroup.add(cone);
        const ember = new THREE.Mesh(
          new THREE.CircleGeometry(v.r * 0.42, 10),
          new THREE.MeshBasicMaterial({ color: 0xff5722 })
        );
        ember.rotation.x = -Math.PI / 2;
        ember.position.set(v.x, vy + v.h * 0.76, v.z);
        expGroup.add(ember);
        const ventLight = new THREE.PointLight(0xff5722, 2.5, 36.0);
        ventLight.position.set(v.x, vy + v.h + 0.8, v.z);
        worldLandmarksGroup.add(ventLight);
        registerManagedLight(ventLight, idx === 0 ? 68.0 : 58.0);
        registerCollider(v.x, v.z, v.r * 0.85, vy - 1.0, vy + v.h + 1.0, 'fumarole');
      });
    }

    // 4. SE Deep Coral Fortress (844, 752): Tidewater Timber Pier & Coral Ceremonial Arch
    {
      let pierX = 781.0, pierZ = 703.0;
      for (let d = 55; d <= 92; d += 3) {
        const tx = 844.0 - d * 0.72;
        const tz = 752.0 - d * 0.68;
        const ty = getTerrainHeight(tx, tz);
        if (ty >= -0.25 && ty <= 1.15) {
          pierX = tx;
          pierZ = tz;
          break;
        }
      }
      const pier = new THREE.Group();
      pier.position.set(pierX, 0.85, pierZ);
      pier.rotation.y = Math.atan2(844.0 - pierX, 752.0 - pierZ);
      const deckLen = 11.5;
      const plankDeck = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.24, deckLen), matTimberLog);
      plankDeck.castShadow = true;
      plankDeck.receiveShadow = true;
      pier.add(plankDeck);
      for (let pz = -4.5; pz <= 4.5; pz += 3.0) {
        for (let px = -1.1; px <= 1.1; px += 2.2) {
          const piling = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 4.2, 8), matTimberLog);
          piling.position.set(px, -1.2, pz);
          piling.castShadow = true;
          pier.add(piling);
        }
      }
      expGroup.add(pier);
      registerClimbableBox(pierX, pierZ, 1.45, deckLen * 0.5, pier.rotation.y, 0.98, -2.0);

      // Coral Ceremonial Arch on fortress plateau
      const ax = 837.0, az = 749.0;
      const ay = getTerrainHeight(ax, az);
      const arch = new THREE.Group();
      arch.position.set(ax, ay, az);
      for (let s = -1; s <= 1; s += 2) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.64, 4.2, 10), coralArchMat);
        pillar.position.set(s * 1.9, 1.95, 0);
        pillar.castShadow = true;
        arch.add(pillar);
        registerCollider(ax + s * 1.9, az, 0.65, ay - 0.5, ay + 4.4, 'coral_arch');
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.68, 0.96), coralArchMat);
      lintel.position.y = 4.2;
      lintel.castShadow = true;
      arch.add(lintel);
      expGroup.add(arch);
    }

    // 5. SW Abyssal Outrider Reef (-825, 760): Storm-Beached Ship Ribcage Hull & Compass Cairn
    {
      const rx = -784.0, rz = 724.0;
      const ry = getTerrainHeight(rx, rz);
      const wreck = new THREE.Group();
      wreck.position.set(rx, Math.max(0.25, ry + 0.1), rz);
      wreck.rotation.y = 0.68;
      const keel = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.42, 8.2), matTimberLog);
      keel.castShadow = true;
      wreck.add(keel);
      for (let r = -3; r <= 3; r++) {
        const ribR = 1.55 - Math.abs(r) * 0.14;
        const rib = new THREE.Mesh(new THREE.TorusGeometry(ribR, 0.11, 6, 12, Math.PI), matTimberLog);
        rib.position.set(0, ribR, r * 1.15);
        rib.rotation.x = Math.PI;
        rib.rotation.z = (r % 2 === 0) ? 0.12 : -0.10;
        rib.castShadow = true;
        wreck.add(rib);
      }
      mergeStaticGroupByMaterial(wreck);
      expGroup.add(wreck);
      buildStoneCairn(-815.0, 755.0, 1.35);
    }

    // 6. Main Island Eastern Limestone Canyon (215, 42): Gorge Timber Footbridge & Survey Cairn
    {
      const bx = 215.0, bz = 42.0;
      const spanLen = 17.5;
      const bridgeY = 22.35;
      const bridge = new THREE.Group();
      bridge.position.set(bx, bridgeY, bz);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.24, spanLen), matTimberLog);
      deck.castShadow = true;
      deck.receiveShadow = true;
      bridge.add(deck);
      for (let sz = -spanLen * 0.46; sz <= spanLen * 0.46; sz += 3.2) {
        for (let sx = -1.05; sx <= 1.05; sx += 2.1) {
          const railPost = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 1.2, 6), matTimberLog);
          railPost.position.set(sx, 0.62, sz);
          bridge.add(railPost);
        }
      }
      for (let sx = -1.05; sx <= 1.05; sx += 2.1) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, spanLen), matTimberLog);
        rail.position.set(sx, 1.12, 0);
        bridge.add(rail);
      }
      mergeStaticGroupByMaterial(bridge);
      expGroup.add(bridge);
      registerClimbableBox(bx, bz, 1.2, spanLen * 0.5, 0, bridgeY + 0.12, bridgeY - 1.5);
      buildStoneCairn(215.0, 42.0, 1.1);
    }

    worldLandmarksGroup.add(expGroup);
  }

  // Landmarks scheduled asynchronously in initCalderaCastaway() below

  // ============================================================================
  // 6. SAILABLE OUTRIGGER BAMBOO RAFT (Moored at Crash Cove X: -18, Z: -36)
  // ============================================================================
  const raftState = {
    mesh: new THREE.Group(),
    pos: new THREE.Vector3(-48.0, 0.08, -36.0),
    yaw: 0.25,
    vel: new THREE.Vector3()
  };
  window.calderaRaft = raftState;

  function buildOutriggerRaft() {
    const rGroup = raftState.mesh;
    rGroup.position.copy(raftState.pos);

    // 9 Lashed Giant Bamboo Deck Logs with Raised Culm Nodes & Hemp Rope Lashings
    const raftWood = matSeasonedBamboo.clone();
    raftWood.vertexColors = true;
    raftWood.roughness = 0.78;
    raftWood.color.set(0xb8925a);
    for (let i = -4; i <= 4; i++) {
      const logGeo = notchCulm(new THREE.CylinderGeometry(0.18, 0.16, 5.6, 12, 8));
      logGeo.rotateX(Math.PI / 2);
      const log = new THREE.Mesh(logGeo, raftWood);
      log.position.set(i * 0.36, 0.12, 0);
      log.castShadow = true;
      log.receiveShadow = true;
      rGroup.add(log);

      [-2.1, -0.7, 0.7, 2.1].forEach(zNode => {
        const lash = new THREE.Mesh(new THREE.TorusGeometry(0.188, 0.024, 8, 14), matRawhide);
        lash.position.set(i * 0.36, 0.12, zNode);
        rGroup.add(lash);
      });
    }

    // Crossbeams (Akas), Twin Outrigger Pontoons (Amas) & Upturned Bow Cones
    [-1.65, 1.65].forEach(zBeam => {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 6.4, 12), matTimberLog);
      beam.rotation.z = Math.PI / 2;
      beam.position.set(0, 0.28, zBeam);
      rGroup.add(beam);
    });

    [-2.95, 2.95].forEach(xPontoon => {
      const pGeo = new THREE.CylinderGeometry(0.165, 0.145, 4.9, 16);
      pGeo.rotateX(Math.PI / 2);
      const pontoon = new THREE.Mesh(pGeo, matBambooCulm);
      pontoon.position.set(xPontoon, 0.06, 0);
      rGroup.add(pontoon);

      const prow = new THREE.Mesh(new THREE.ConeGeometry(0.165, 0.65, 14), matSeasonedBamboo);
      prow.rotation.x = -Math.PI / 2 + 0.25;
      prow.position.set(xPontoon, 0.12, -2.68);
      rGroup.add(prow);
    });

    // Bamboo Mast, Yard/Boom Spars, Rigging Shrouds & Woven Austronesian Crab-Claw Sail
    const mast = new THREE.Mesh(notchCulm(new THREE.CylinderGeometry(0.085, 0.125, 5.0, 10, 8)), raftWood);
    mast.position.set(0, 2.55, -0.6);
    mast.castShadow = true;
    rGroup.add(mast);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.062, 2.6, 10), matSeasonedBamboo);
    boom.rotation.z = Math.PI / 2;
    boom.position.set(0, 1.15, -0.5);
    rGroup.add(boom);

    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.052, 2.5, 10), matSeasonedBamboo);
    yard.rotation.z = Math.PI / 2 - 0.15;
    yard.position.set(0, 4.35, -0.5);
    rGroup.add(yard);

    const sail = new THREE.Mesh(new THREE.PlaneGeometry(2.40, 3.25, 12, 12), matSailCanvas);
    const sPos = sail.geometry.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      const u = sPos.getX(i), v = sPos.getY(i);
      sPos.setZ(i, Math.cos(u * 0.72) * Math.cos(v * 0.52) * 0.42);
    }
    sail.geometry.computeVertexNormals();
    sail.position.set(0, 2.75, -0.45);
    sail.castShadow = true;
    rGroup.add(sail);

    [2.15, 3.35].forEach(by => {
      const batten = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.38, 6), matSeasonedBamboo);
      batten.rotation.z = Math.PI / 2;
      batten.position.set(0, by, -0.22);
      rGroup.add(batten);
    });
    const forestay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 4.65, 6), matRawhide);
    forestay.position.set(0, 2.65, -1.62);
    forestay.rotation.x = 0.48;
    rGroup.add(forestay);

    // Steering Oar Blade & Lashed Supply Crate on Deck
    const deckCrate = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.56, 0.68), matTimberLog);
    deckCrate.position.set(0.55, 0.48, 1.1);
    rGroup.add(deckCrate);

    const oarShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 2.45, 10), matHickory);
    oarShaft.position.set(-0.85, 0.55, 1.85);
    oarShaft.rotation.x = 0.65;
    const oarBlade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.62, 0.028), matHickory);
    oarBlade.position.y = -1.05;
    oarShaft.add(oarBlade);
    rGroup.add(oarShaft);

    rGroup.traverse(c => { if (c.isMesh) c.raycast = () => {}; });
    const raftProxy = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 5.4), _landmarkProxyMat);
    raftProxy.position.y = 1.0;
    rGroup.add(raftProxy);

    rGroup.userData = {
      type: 'raft',
      promptLabel: 'Board Outrigger Bamboo Raft [Tap Raft Button]'
    };
    scene.add(rGroup);
    registerInteractiveTarget(rGroup);
    registerClimbableBox(raftState.pos.x, raftState.pos.z, 1.9, 2.8, raftState.yaw, 0.32, -1.0);

    const poles = new THREE.Group();
    for (let i = -2; i <= 2; i++) {
      const pole = new THREE.Mesh(notchCulm(new THREE.CylinderGeometry(0.11, 0.13, 5.1, 8, 8)), raftWood);
      pole.rotation.x = Math.PI / 2;
      pole.position.set(i * 0.38, 0.18, (i % 2) * 0.35);
      poles.add(pole);
    }
    poles.position.set(raftState.pos.x, getTerrainHeight(raftState.pos.x, raftState.pos.z) + 0.12, raftState.pos.z);
    poles.rotation.y = 0.4;
    scene.add(poles);
    raftState.poles = poles;
    rGroup.visible = false;

    const keel = new THREE.Group();
    const keelLog = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 6.4), matTimberLog);
    keel.add(keelLog);
    const keelRibL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.18), matTimberLog);
    keelRibL.position.set(-0.55, 0.2, 0.4);
    keel.add(keelRibL);
    const keelRibR = keelRibL.clone();
    keelRibR.position.x = 0.55;
    keel.add(keelRibR);
    raftState.boatPos = new THREE.Vector3(-40.0, 0.4, -24.0);
    keel.position.copy(raftState.boatPos);
    keel.position.y = getTerrainHeight(-40.0, -24.0) + 0.28;
    scene.add(keel);
    raftState.keel = keel;
    raftState.boatMesh = null;
    raftState.boatYaw = 0.2;

    const partColors = { keel: 0xb0bec5, brace: 0x4fc3f7, skin: 0xff8a65, sail: 0xffe082 };
    if (window.archipelagoIslets) {
      window.archipelagoIslets.forEach(isl => {
        if (!isl.part) return;
        const relic = new THREE.Group();
        const px = isl.x + Math.cos(isl.partAng || 0) * (isl.partR || 0);
        const pz = isl.z + Math.sin(isl.partAng || 0) * (isl.partR || 0);
        const my = getTerrainHeight(px, pz);
        relic.position.set(px, Math.max(my, 0.3), pz);

        // Timber salvage plinth + signal pennant mast
        const chock = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.26, 1.35), matTimberLog);
        chock.position.y = 0.13;
        relic.add(chock);

        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 4.2, 6), matSeasonedBamboo);
        pole.position.set(-0.48, 2.1, -0.48);
        relic.add(pole);

        const pennant = new THREE.Mesh(
          new THREE.ConeGeometry(0.38, 1.15, 3),
          new THREE.MeshStandardMaterial({ color: partColors[isl.part], emissive: partColors[isl.part], emissiveIntensity: 0.28, roughness: 0.5 })
        );
        pennant.rotation.z = -Math.PI / 2;
        pennant.position.set(0.05, 3.85, -0.48);
        relic.add(pennant);

        // Part-specific 3D nautical salvage centerpiece
        const pMat = new THREE.MeshStandardMaterial({ color: partColors[isl.part], roughness: 0.42, metalness: 0.22 });
        if (isl.part === 'keel') {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.45, 1.85), pMat);
          beam.position.y = 0.52;
          relic.add(beam);
        } else if (isl.part === 'brace') {
          const knee = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.14, 6, 12, Math.PI * 1.15), matObsidianGlass);
          knee.position.y = 0.65;
          relic.add(knee);
        } else if (isl.part === 'skin') {
          const amphora = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.92, 10), pMat);
          amphora.position.y = 0.72;
          relic.add(amphora);
        } else {
          const sailRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.65, 10), pMat);
          sailRoll.rotation.z = Math.PI / 2;
          sailRoll.position.y = 0.54;
          relic.add(sailRoll);
        }

        scene.add(relic);
        isl._marker = relic;
      });
    }
  }

  // ============================================================================
  // 7. 5 AAA FIRST-PERSON 3D TOOLS + VOLUMETRIC FBM TORCH, BOBBER & SIGNAL FLARES
  // ============================================================================
  const fpToolHolder = new THREE.Group();
  camera.add(fpToolHolder);

  const toolMeshes = {
    hatchet: window.fpAxeMesh || null,
    spear: new THREE.Group(),
    rod: new THREE.Group(),
    torch: new THREE.Group(),
    flare: new THREE.Group(),
    build: new THREE.Group(),
    bow: new THREE.Group(),
    crossbow: new THREE.Group(),
    pistol: new THREE.Group(),
    rifle: new THREE.Group(),
    dynamite: new THREE.Group()
  };

  // 7A. AAA Obsidian Hunting Spear (Sculpted Ash Shaft, Stitched Leather Grip, Bone Socket, Sinew Lashing & Leaf-Shaped Knapped Obsidian Blade)
  function buildSpearTool() {
    const g = toolMeshes.spear;
    const spearAssembly = new THREE.Group();
    spearAssembly.rotation.order = 'YXZ';

    const woodCanvas = document.createElement('canvas');
    woodCanvas.width = 256; woodCanvas.height = 512;
    const wCtx = woodCanvas.getContext('2d');
    const wGrad = wCtx.createLinearGradient(0, 0, 0, 512);
    wGrad.addColorStop(0.0, '#6e4324');
    wGrad.addColorStop(0.5, '#98643e');
    wGrad.addColorStop(1.0, '#784a28');
    wCtx.fillStyle = wGrad;
    wCtx.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 380; i++) {
      wCtx.strokeStyle = i % 2 === 0 ? 'rgba(58, 32, 12, 0.30)' : 'rgba(190, 138, 90, 0.22)';
      wCtx.lineWidth = 0.8 + Math.random() * 1.6;
      const x = Math.random() * 256;
      wCtx.beginPath();
      wCtx.moveTo(x, 0);
      wCtx.bezierCurveTo(x + (Math.random() - 0.5) * 16, 170, x + (Math.random() - 0.5) * 16, 340, x, 512);
      wCtx.stroke();
    }
    const spearWoodTex = new THREE.CanvasTexture(woodCanvas);

    const lthCanvas = document.createElement('canvas');
    lthCanvas.width = 256; lthCanvas.height = 256;
    const lCtx = lthCanvas.getContext('2d');
    lCtx.fillStyle = '#331d12';
    lCtx.fillRect(0, 0, 256, 256);
    for (let y = 10; y < 256; y += 24) {
      lCtx.fillStyle = '#180c06';
      lCtx.fillRect(0, y, 256, 4);
      lCtx.fillStyle = '#4c2c1c';
      lCtx.fillRect(0, y + 4, 256, 3);
    }
    lCtx.strokeStyle = '#c89d66';
    lCtx.lineWidth = 2.2;
    for (let y = 8; y < 248; y += 18) {
      lCtx.beginPath();
      lCtx.moveTo(118, y); lCtx.lineTo(138, y + 12);
      lCtx.moveTo(138, y); lCtx.lineTo(118, y + 12);
      lCtx.stroke();
    }
    const spearLeatherTex = new THREE.CanvasTexture(lthCanvas);

    const obsNormCanvas = document.createElement('canvas');
    obsNormCanvas.width = 256; obsNormCanvas.height = 256;
    const onCtx = obsNormCanvas.getContext('2d');
    onCtx.fillStyle = 'rgb(128, 128, 255)';
    onCtx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 180; i++) {
      const cx = Math.random() * 256, cy = Math.random() * 256, r = 6 + Math.random() * 18;
      const rg = onCtx.createRadialGradient(cx, cy, 1, cx, cy, r);
      rg.addColorStop(0, 'rgb(148, 112, 245)');
      rg.addColorStop(1, 'rgba(128, 128, 255, 0)');
      onCtx.fillStyle = rg;
      onCtx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    const obsidianNormTex = new THREE.CanvasTexture(obsNormCanvas);

    const shaftRings = 28;
    const shaftSegs = 16;
    const sPos = [];
    const sUvs = [];
    const sIdx = [];
    const yStart = -0.34;
    const yEnd = 0.62;
    const shaftLen = yEnd - yStart;

    for (let r = 0; r <= shaftRings; r++) {
      const v = r / shaftRings;
      const y = yStart + v * shaftLen;
      const gripSwell = Math.sin(Math.max(0, Math.min(1, (y + 0.08) / 0.36)) * Math.PI) * 0.0035;
      const forwardTaper = -v * 0.0035;
      const socketFlare = Math.pow(Math.max(0, (v - 0.85) / 0.15), 1.6) * 0.0045;
      const rad = 0.0205 + gripSwell + forwardTaper + socketFlare;

      for (let s = 0; s <= shaftSegs; s++) {
        const u = s / shaftSegs;
        const ang = u * Math.PI * 2.0;
        sPos.push(Math.cos(ang) * rad, y, Math.sin(ang) * rad);
        sUvs.push(u, v);
      }
    }
    const stride = shaftSegs + 1;
    for (let r = 0; r < shaftRings; r++) {
      for (let s = 0; s < shaftSegs; s++) {
        const a = r * stride + s;
        const b = a + 1;
        const c = (r + 1) * stride + s;
        const d = c + 1;
        sIdx.push(a, c, b, b, c, d);
      }
    }
    const shaftGeo = new THREE.BufferGeometry();
    shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
    shaftGeo.setAttribute('uv', new THREE.Float32BufferAttribute(sUvs, 2));
    shaftGeo.setIndex(sIdx);
    shaftGeo.computeVertexNormals();

    const shaftMat = new THREE.MeshStandardMaterial({
      map: spearWoodTex,
      roughness: 0.38,
      metalness: 0.04,
      side: THREE.DoubleSide
    });
    spearAssembly.add(new THREE.Mesh(shaftGeo, shaftMat));

    const buttSpike = new THREE.Mesh(new THREE.ConeGeometry(0.021, 0.09, 12), matAnodizedDark);
    buttSpike.rotation.x = Math.PI;
    buttSpike.position.set(0, -0.375, 0);
    spearAssembly.add(buttSpike);

    const gripMat = new THREE.MeshStandardMaterial({
      map: spearLeatherTex,
      roughness: 0.62,
      metalness: 0.05
    });
    const gripSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.0238, 0.0245, 0.32, 16), gripMat);
    gripSleeve.position.set(0, 0.10, 0);
    spearAssembly.add(gripSleeve);

    [-0.06, 0.26].forEach(ky => {
      const keeper = new THREE.Mesh(new THREE.CylinderGeometry(0.0255, 0.0255, 0.016, 16), matBrass);
      keeper.position.set(0, ky, 0);
      spearAssembly.add(keeper);
    });

    const handGauntlet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.036, 0.033, 0.11, 12),
      new THREE.MeshStandardMaterial({ map: spearLeatherTex, color: 0x4e3222, roughness: 0.65 })
    );
    handGauntlet.scale.set(1.06, 1.0, 0.86);
    handGauntlet.position.set(0, 0.02, 0);
    spearAssembly.add(handGauntlet);

    const boneCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0235, 0.0218, 0.085, 16),
      new THREE.MeshStandardMaterial({ color: 0xede6d6, roughness: 0.38 })
    );
    boneCollar.position.set(0, 0.555, 0);
    spearAssembly.add(boneCollar);

    [0.535, 0.575].forEach(ry => {
      [-0.023, 0.023].forEach(rz => {
        const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 8), matBrass);
        rivet.position.set(0, ry, rz);
        spearAssembly.add(rivet);
      });
    });

    const sinewSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.0245, 0.0235, 0.075, 16), gripMat);
    sinewSleeve.position.set(0, 0.618, 0);
    spearAssembly.add(sinewSleeve);

    for (let c = 0; c < 4; c++) {
      const cord = new THREE.Mesh(new THREE.TorusGeometry(0.0232, 0.0044, 6, 16), matRawhide);
      cord.position.set(0, 0.595 + c * 0.015, 0);
      cord.rotation.x = Math.PI / 2 + (c % 2 === 0 ? 0.24 : -0.24);
      spearAssembly.add(cord);
    }

    const bladeStations = 22;
    const bStart = 0.62;
    const bLen = 0.46;
    const corePos = [];
    const coreIdx = [];
    const edgePos = [];
    const edgeIdx = [];

    function getBladeProfile(t) {
      let w;
      if (t < 0.12) {
        const u = t / 0.12;
        w = 0.018 + Math.pow(u, 0.75) * 0.048;
      } else if (t < 0.20) {
        const u = (t - 0.12) / 0.08;
        w = 0.066 - Math.sin(u * Math.PI * 0.5) * 0.012;
      } else {
        const u = (t - 0.20) / 0.80;
        w = 0.054 * Math.pow(Math.cos(u * Math.PI * 0.5), 0.78);
      }
      const zThick = 0.0145 * (1.0 - Math.pow(t, 1.15) * 0.88);
      return { w, zThick };
    }

    for (let i = 0; i <= bladeStations; i++) {
      const t = i / bladeStations;
      const y = bStart + t * bLen;
      const { w, zThick } = getBladeProfile(t);
      const sw = w * 0.72;
      const sz = zThick * 0.42;

      corePos.push(-sw, y,  sz,   0, y,  zThick,   sw, y,  sz);
      corePos.push(-sw, y, -sz,   0, y, -zThick,   sw, y, -sz);

      edgePos.push(-sw, y,  sz,  -w, y, 0,  -sw, y, -sz);
      edgePos.push( sw, y,  sz,   w, y, 0,   sw, y, -sz);
    }

    for (let i = 0; i < bladeStations; i++) {
      const b = i * 6;
      const n = (i + 1) * 6;
      coreIdx.push(b + 0, b + 1, n + 0,  b + 1, n + 1, n + 0);
      coreIdx.push(b + 1, b + 2, n + 1,  b + 2, n + 2, n + 1);
      coreIdx.push(b + 4, b + 3, n + 4,  b + 3, n + 3, n + 4);
      coreIdx.push(b + 5, b + 4, n + 5,  b + 4, n + 4, n + 5);

      edgeIdx.push(b + 0, n + 0, b + 1,  b + 1, n + 0, n + 1);
      edgeIdx.push(b + 1, n + 1, b + 2,  b + 2, n + 1, n + 2);
      edgeIdx.push(b + 3, b + 4, n + 3,  b + 4, n + 4, n + 3);
      edgeIdx.push(b + 4, b + 5, n + 4,  b + 5, n + 5, n + 4);
    }

    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute('position', new THREE.Float32BufferAttribute(corePos, 3));
    coreGeo.setIndex(coreIdx);
    coreGeo.computeVertexNormals();

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    edgeGeo.setIndex(edgeIdx);
    edgeGeo.computeVertexNormals();

    const obsidianCoreMat = new THREE.MeshStandardMaterial({
      color: 0x0b1016,
      normalMap: obsidianNormTex,
      normalScale: new THREE.Vector2(0.75, 0.75),
      metalness: 0.58,
      roughness: 0.12,
      side: THREE.DoubleSide
    });
    const obsidianEdgeMat = new THREE.MeshStandardMaterial({
      color: 0x607d8b,
      metalness: 0.92,
      roughness: 0.08,
      side: THREE.DoubleSide
    });

    spearAssembly.add(new THREE.Mesh(coreGeo, obsidianCoreMat));
    spearAssembly.add(new THREE.Mesh(edgeGeo, obsidianEdgeMat));

    [-1, 1].forEach(dir => {
      const barb = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.075, 4), obsidianEdgeMat);
      barb.position.set(dir * 0.052, 0.665, 0);
      barb.rotation.z = dir * 2.55;
      barb.scale.set(1.0, 1.0, 0.45);
      spearAssembly.add(barb);
    });

    spearAssembly.rotation.set(-1.02, 0.22, 0.24);
    g.add(spearAssembly);

    g.position.set(0.36, -0.36, -0.66);
    g.visible = false;
    fpToolHolder.add(g);
  }

  // 7B. AAA Segmented Tonkin Bamboo Fishing Rod + Machined Brass Fly Reel + Monofilament Line & 3D World Bobber
  const fishingBobber = new THREE.Group();
  function buildFishingRodTool() {
    const g = toolMeshes.rod;
    const rodAssembly = new THREE.Group();
    rodAssembly.rotation.order = 'YXZ';

    const corkGrip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.025, 0.36, 16),
      new THREE.MeshStandardMaterial({
        color: 0xc89d66,
        normalMap: aaaSurfacePBRAssets.thatchNormTex,
        normalScale: new THREE.Vector2(0.45, 0.45),
        roughness: 0.84
      })
    );
    corkGrip.position.set(0, 0.04, 0);
    rodAssembly.add(corkGrip);

    [-0.14, 0.22].forEach(ry => {
      const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.022, 16), matBrass);
      ferrule.position.set(0, ry, 0);
      rodAssembly.add(ferrule);
    });

    const rodShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.019, 1.56, 14), matSeasonedBamboo);
    rodShaft.position.set(0, 0.96, 0);
    rodAssembly.add(rodShaft);

    for (let n = 1; n <= 4; n++) {
      const t = n / 4;
      const ny = 0.24 + t * 1.38;
      const rAtNode = 0.019 * (1 - t * 0.72);
      const nodeRing = new THREE.Mesh(new THREE.TorusGeometry(rAtNode + 0.002, 0.003, 8, 14), matRawhide);
      nodeRing.rotation.x = Math.PI / 2;
      nodeRing.position.set(0, ny, 0);
      rodAssembly.add(nodeRing);

      const eyeGuide = new THREE.Mesh(new THREE.TorusGeometry(0.011 * (1 - t * 0.35), 0.0022, 8, 12), matBrass);
      eyeGuide.position.set(0, ny, rAtNode + 0.012);
      rodAssembly.add(eyeGuide);
    }

    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.038, 20), matBrass);
    reel.rotation.z = Math.PI / 2;
    reel.position.set(-0.032, 0.14, 0.028);
    rodAssembly.add(reel);

    const spool = new THREE.Mesh(
      new THREE.CylinderGeometry(0.036, 0.036, 0.028, 16),
      new THREE.MeshStandardMaterial({ color: 0xb2ebf2, roughness: 0.25 })
    );
    spool.rotation.z = Math.PI / 2;
    spool.position.set(-0.032, 0.14, 0.028);
    rodAssembly.add(spool);

    const crank = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.038, 10), matAnodizedDark);
    crank.rotation.z = Math.PI / 2;
    crank.position.set(-0.056, 0.155, 0.038);
    rodAssembly.add(crank);

    rodAssembly.rotation.set(-1.02, 0.20, 0.12);
    g.add(rodAssembly);

    g.position.set(0.36, -0.35, -0.52);
    g.visible = false;
    fpToolHolder.add(g);

    const bTop = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 14), matRescueRed);
    bTop.position.y = 0.06;
    const bBot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 14), matAluminum);
    bBot.position.y = -0.06;
    const bStem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.38, 10), matSafetyOrange);
    bStem.position.y = 0.16;
    fishingBobber.add(bTop, bBot, bStem);
    fishingBobber.visible = false;
    scene.add(fishingBobber);
  }

  // 7C. AAA Campfire-Grade Pitch Cavern Torch (Twisted Wrought-Iron Brazier Cage, Incandescent Pitch Knot,
  //     3D Volumetric FBM Blackbody Fire Shader Ribbons, Helical Rising Ember Sparks & Billowing Smoke Wisps)
  const playerTorchLight = new THREE.PointLight(0xffa44d, 0.0, 56.0, 1.05);
  playerTorchLight.visible = true; // Stay visible=true with intensity=0 when holstered so NUM_POINT_LIGHTS never changes!
  playerTorchLight.castShadow = false;
  camera.add(playerTorchLight);
  playerTorchLight.position.set(0.35, 0.1, -0.65);

  function buildTorchTool() {
    const g = toolMeshes.torch;
    const vfx = window.getCampfireVFXAssets ? window.getCampfireVFXAssets() : null;

    // 1. Sculpted Charred Hickory Shaft + Soot Collar + Cross-Lashed Leather Grip
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.019, 0.66, 16), matHickory);
    g.add(handle);

    const charCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.0262, 0.0252, 0.13, 14), matAnodizedDark);
    charCollar.position.y = 0.21;
    g.add(charCollar);

    const gripWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.026, 0.24, 14), matRawhide);
    gripWrap.position.y = -0.08;
    g.add(gripWrap);

    for (let c = 0; c < 4; c++) {
      const cord = new THREE.Mesh(new THREE.TorusGeometry(0.0275, 0.0035, 6, 14), matBrass);
      cord.position.y = -0.17 + c * 0.06;
      cord.rotation.x = Math.PI / 2 + (c % 2 === 0 ? 0.22 : -0.22);
      g.add(cord);
    }

    // 2. Twisted Wrought-Iron Brazier Cage (3 Riveted Iron Hoops + 6 Flared Spiral Basket Ribs)
    [0.22, 0.31, 0.40].forEach((hy, idx) => {
      const rHoop = 0.034 + idx * 0.012;
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(rHoop, 0.0055, 8, 18), matAnodizedDark);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = hy;
      g.add(hoop);
    });
    for (let r = 0; r < 6; r++) {
      const a = (r / 6) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.0045, 0.24, 8), matAnodizedDark);
      rib.position.set(Math.cos(a) * 0.044, 0.30, Math.sin(a) * 0.044);
      rib.rotation.set(Math.sin(a) * 0.20, 0, -Math.cos(a) * 0.20);
      g.add(rib);
    }

    // 3. Cracked Pitch-Soaked Burlap & Charred Pine-Resin Coal Core (Glow Inside Fissures Only)
    const emberCoreGeo = new THREE.DodecahedronGeometry(0.041, 2);
    emberCoreGeo.scale(0.92, 1.25, 0.92);
    const emberCoreMat = new THREE.MeshStandardMaterial({
      map: (vfx && vfx.sharedCoalTex) ? vfx.sharedCoalTex : null,
      color: (vfx && vfx.sharedCoalTex) ? 0xffffff : 0x1a0c06,
      emissive: 0xff4e0c,
      emissiveMap: (vfx && vfx.sharedCoalEmissiveTex) ? vfx.sharedCoalEmissiveTex : null,
      emissiveIntensity: 1.85,
      normalMap: aaaSurfacePBRAssets.thatchNormTex,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 0.86
    });
    const emberCore = new THREE.Mesh(emberCoreGeo, emberCoreMat);
    emberCore.position.y = 0.33;
    g.add(emberCore);

    // 4. Cylindrical-Billboard Volumetric FBM Torch Flame Cluster (Buoyant Sky-Up Curve & Inertia Drag)
    let flameGroup;
    if (vfx && vfx.buildVolumetricFlameCluster) {
      flameGroup = vfx.buildVolumetricFlameCluster({
        width: 0.165,
        height: 0.295,
        wrapRadius: 0.036,
        upMix: 0.52,
        haloOpacity: 0.20,
        isTorch: true
      });
      flameGroup.position.y = 0.285;
    } else {
      flameGroup = new THREE.Group();
      flameGroup.position.y = 0.32;
      const fbMat = new THREE.MeshBasicMaterial({
        color: 0xff7a1a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      const fbRibbon = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.24, 2, 4), fbMat);
      fbRibbon.position.y = 0.11;
      flameGroup.add(fbRibbon);
    }
    g.add(flameGroup);
    g.userData.flame = flameGroup;
    g.userData.emberCore = emberCore;
    g.userData.vfx = vfx;

    // 5. Crisp Rising Ember Sparks (20 Local Particles) & Subtle Warm Smoke Wisps
    if (vfx && vfx.sharedSparkTex && vfx.sharedSmokeTex) {
      const sparkCount = 20;
      const sparkGeo = new THREE.BufferGeometry();
      const sparkPositions = new Float32Array(sparkCount * 3);
      const sparkSeeds = new Float32Array(sparkCount);
      for (let s = 0; s < sparkCount; s++) {
        sparkSeeds[s] = (s / sparkCount) + Math.random() * 0.08;
        sparkPositions[s * 3 + 1] = 0.35 + sparkSeeds[s] * 0.44;
      }
      sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
      const sparkMat = new THREE.PointsMaterial({
        map: vfx.sharedSparkTex,
        color: 0xffb347,
        size: 0.036,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
      g.add(sparkPoints);
      g.userData.sparkPoints = sparkPoints;
      g.userData.sparkSeeds = sparkSeeds;

      const smokeWisps = [];
      for (let sm = 0; sm < 5; sm++) {
        const smMat = new THREE.SpriteMaterial({
          map: vfx.sharedSmokeTex,
          color: 0x7c7874,
          transparent: true,
          opacity: 0.10,
          depthWrite: false
        });
        const sprite = new THREE.Sprite(smMat);
        sprite.userData.phase = sm / 5;
        g.add(sprite);
        smokeWisps.push(sprite);
      }
      g.userData.smokeWisps = smokeWisps;
    }

    g.position.set(0.36, -0.38, -0.62);
    g.rotation.set(0.18, -0.15, 0.08);
    g.visible = false;
    fpToolHolder.add(g);
  }

  // 7D. AAA Marine Signal Flare Gun (Heavy-Duty Breech Barrel, Sight Post, Knurled Grip, Hammer Spur & Brass Shell)
  const activeSkyFlares = [];
  function buildFlareGunTool() {
    const g = toolMeshes.flare;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.039, 0.34, 18), matSafetyOrange);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.08, -0.12);
    g.add(barrel);

    const sightPost = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.018, 0.024), matAnodizedDark);
    sightPost.position.set(0, 0.122, -0.26);
    g.add(sightPost);

    const muzzleBore = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.025, 16), matAnodizedDark);
    muzzleBore.rotation.x = Math.PI / 2;
    muzzleBore.position.set(0, 0.08, -0.29);
    g.add(muzzleBore);

    const breech = new THREE.Mesh(new THREE.BoxGeometry(0.070, 0.084, 0.13), matSafetyOrange);
    breech.position.set(0, 0.065, 0.02);
    g.add(breech);

    const brassRim = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.018, 16), matBrass);
    brassRim.rotation.x = Math.PI / 2;
    brassRim.position.set(0, 0.08, 0.086);
    g.add(brassRim);

    const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.048, 0.038), matAnodizedDark);
    hammer.position.set(0, 0.118, 0.078);
    hammer.rotation.x = -0.45;
    g.add(hammer);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.195, 0.084), matAnodizedDark);
    grip.position.set(0, -0.03, 0.04);
    grip.rotation.x = 0.30;
    g.add(grip);

    const lanyardRing = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.0035, 6, 12), matBrass);
    lanyardRing.position.set(0, -0.125, 0.068);
    g.add(lanyardRing);

    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.005, 8, 14), matSafetyOrange);
    guard.rotation.y = Math.PI / 2;
    guard.position.set(0, 0.01, -0.02);
    g.add(guard);

    g.position.set(0.34, -0.34, -0.56);
    g.visible = false;
    fpToolHolder.add(g);
  }

  // 7E. AAA Framing Construction Hammer (Hickory Swell Handle, Stitched Leather Grip, Octagonal Neck & Curved Rip-Claw)
  function buildHammerTool() {
    const g = toolMeshes.build;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.026, 0.64, 16), matHickory);
    g.add(handle);

    const leatherGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.24, 16), matRawhide);
    leatherGrip.position.y = -0.14;
    g.add(leatherGrip);

    const brassCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.025, 16), matBrass);
    brassCollar.position.y = 0.22;
    g.add(brassCollar);

    const eyeBlock = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.078, 0.105), matAnodizedDark);
    eyeBlock.position.y = 0.28;
    g.add(eyeBlock);

    const pollFace = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.028, 0.095, 12), matAluminum);
    pollFace.rotation.x = Math.PI / 2;
    pollFace.position.set(0, 0.28, -0.095);
    g.add(pollFace);

    [-0.016, 0.016].forEach(cx => {
      const claw = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.025, 0.115), matAluminum);
      claw.position.set(cx, 0.27, 0.095);
      claw.rotation.x = -0.30;
      g.add(claw);
    });

    g.position.set(0.35, -0.35, -0.59);
    g.rotation.set(0.20, -0.22, 0.10);
    g.visible = false;
    fpToolHolder.add(g);
  }

  // 7F. AAA Hunting Weapons & Explosives (Recurve Bow, Crossbow, Scavenged Pistol, Hunting Rifle, Dynamite Bundle)
  function buildHuntingWeapons() {
    // 1. Recurve Hunting Bow (Split Animated Bowstring Halves + Nocked Arrow)
    {
      const g = toolMeshes.bow;
      const limbCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.56, 0.08),
        new THREE.Vector3(0, 0.28, -0.10),
        new THREE.Vector3(0, 0.0, -0.15),
        new THREE.Vector3(0, -0.28, -0.10),
        new THREE.Vector3(0, -0.56, 0.08)
      ]);
      const stave = new THREE.Mesh(new THREE.TubeGeometry(limbCurve, 20, 0.017, 8, false), matHickory);
      g.add(stave);
      // Horn-reinforced recurve limb tips & arrow rest brass collar
      [0.55, -0.55].forEach(ty => {
        const limbTip = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.016, 0.06, 8), matAnodizedDark);
        limbTip.position.set(0, ty, 0.075);
        limbTip.rotation.x = ty > 0 ? 0.45 : -0.45;
        g.add(limbTip);
      });
      const gripWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 10), matRawhide);
      gripWrap.position.set(0, 0, -0.15);
      g.add(gripWrap);
      const halfStrGeo = new THREE.CylinderGeometry(0.0028, 0.0028, 1.0, 6);
      const upperString = new THREE.Mesh(halfStrGeo, matRawhide);
      upperString.position.set(0, 0.28, 0.08);
      upperString.scale.set(1, 0.56, 1);
      g.add(upperString);
      const lowerString = new THREE.Mesh(halfStrGeo, matRawhide);
      lowerString.position.set(0, -0.28, 0.08);
      lowerString.scale.set(1, 0.56, 1);
      g.add(lowerString);
      const nockedArrow = new THREE.Group();
      const aShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.68, 6), matHickory);
      aShaft.rotation.x = Math.PI / 2;
      aShaft.position.z = -0.24;
      nockedArrow.add(aShaft);
      const aFerrule = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.0065, 0.03, 6), matBrass);
      aFerrule.rotation.x = Math.PI / 2;
      aFerrule.position.z = -0.57;
      nockedArrow.add(aFerrule);
      const aTip = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.055, 6), matAnodizedDark);
      aTip.rotation.x = -Math.PI / 2;
      aTip.position.z = -0.60;
      nockedArrow.add(aTip);
      // Crimson fletching vanes at tail
      [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].forEach(fa => {
        const vane = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.016, 0.075), matRescueRed);
        vane.position.set(Math.sin(fa) * 0.01, Math.cos(fa) * 0.01, 0.055);
        vane.rotation.z = -fa;
        nockedArrow.add(vane);
      });
      g.add(nockedArrow);
      g.userData.nockedArrow = nockedArrow;
      g.userData.upperString = upperString;
      g.userData.lowerString = lowerString;
      g.position.set(0.28, -0.24, -0.54);
      g.rotation.set(0.08, 0.16, -0.22);
      g.visible = false;
      fpToolHolder.add(g);
    }

    // 2. Hunting Crossbow (Split Animated Prod Strings + Latch Block + Steel Stirrup + Fletched Bolt)
    {
      const g = toolMeshes.crossbow;
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.068, 0.62), matHickory);
      stock.position.set(0, 0.0, -0.15);
      g.add(stock);
      const foreGrip = new THREE.Mesh(new THREE.BoxGeometry(0.060, 0.036, 0.22), matRawhide);
      foreGrip.position.set(0, -0.022, -0.24);
      g.add(foreGrip);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.44), matAnodizedDark);
      rail.position.set(0, 0.042, -0.26);
      g.add(rail);
      const prod = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.018, 0.026), matAnodizedDark);
      prod.position.set(0, 0.036, -0.45);
      g.add(prod);
      const stirrup = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.006, 6, 12), matAnodizedDark);
      stirrup.rotation.x = Math.PI / 2;
      stirrup.position.set(0, 0.024, -0.50);
      g.add(stirrup);
      const xHalfGeo = new THREE.CylinderGeometry(0.0024, 0.0024, 1.0, 6);
      xHalfGeo.rotateZ(Math.PI / 2);
      const xLeftStr = new THREE.Mesh(xHalfGeo, matRawhide);
      xLeftStr.position.set(-0.115, 0.042, -0.34);
      xLeftStr.scale.set(0.255, 1, 1);
      g.add(xLeftStr);
      const xRightStr = new THREE.Mesh(xHalfGeo, matRawhide);
      xRightStr.position.set(0.115, 0.042, -0.34);
      xRightStr.scale.set(0.255, 1, 1);
      g.add(xRightStr);
      const xLatch = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.022, 0.035), matBrass);
      xLatch.position.set(0, 0.054, -0.18);
      g.add(xLatch);
      const loadedBolt = new THREE.Group();
      loadedBolt.position.set(0, 0.055, -0.29);
      const bShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.34, 6), matAluminum);
      bShaft.rotation.x = Math.PI / 2;
      loadedBolt.add(bShaft);
      const bTip = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.045, 6), matBrass);
      bTip.rotation.x = -Math.PI / 2;
      bTip.position.set(0, 0, -0.18);
      loadedBolt.add(bTip);
      const bVane = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.002, 0.055), matSafetyOrange);
      bVane.position.set(0, 0, 0.14);
      loadedBolt.add(bVane);
      g.add(loadedBolt);
      g.userData.loadedBolt = loadedBolt;
      g.userData.xbowLeftStr = xLeftStr;
      g.userData.xbowRightStr = xRightStr;
      g.userData.xbowLatch = xLatch;
      g.position.set(0.30, -0.28, -0.52);
      g.visible = false;
      fpToolHolder.add(g);
    }

    // 3. Scavenged Expedition Pistol (Reciprocating Slide, Iron Sights & Brass Trigger Guard)
    {
      const g = toolMeshes.pistol;
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.046, 0.25), matAnodizedDark);
      slide.position.set(0, 0.065, -0.09);
      const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.010, 0.010), matBrass);
      frontSight.position.set(0, 0.026, -0.115);
      slide.add(frontSight);
      const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.009, 0.010), matAnodizedDark);
      rearSight.position.set(0, 0.026, 0.112);
      slide.add(rearSight);
      const ejectPort = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.048), matAluminum);
      ejectPort.position.set(0.012, 0.018, -0.02);
      slide.add(ejectPort);
      g.add(slide);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.14, 10), matAluminum);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.068, -0.22);
      g.add(barrel);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.125, 0.052), matHickory);
      grip.position.set(0, -0.01, 0.01);
      grip.rotation.x = 0.28;
      g.add(grip);
      const triggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.020, 0.0035, 6, 12), matAnodizedDark);
      triggerGuard.rotation.y = Math.PI / 2;
      triggerGuard.position.set(0, 0.024, -0.045);
      g.add(triggerGuard);
      const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.020, 0.008), matBrass);
      trigger.position.set(0, 0.025, -0.040);
      trigger.rotation.x = 0.35;
      g.add(trigger);
      g.userData.slideMesh = slide;
      g.position.set(0.30, -0.28, -0.50);
      g.visible = false;
      fpToolHolder.add(g);
    }

    // 4. Bolt-Action Scoped Hunting Rifle (Animated Bolt Handle + Optic Lenses & Rings)
    {
      const g = toolMeshes.rifle;
      const woodStock = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.088, 0.52), matHickory);
      woodStock.position.set(0, 0.02, -0.08);
      g.add(woodStock);
      const buttPad = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.092, 0.032), matAnodizedDark);
      buttPad.position.set(0, 0.018, 0.185);
      g.add(buttPad);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.56, 10), matAnodizedDark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.062, -0.44);
      g.add(barrel);
      const frontBead = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 8, 8), matBrass);
      frontBead.position.set(0, 0.078, -0.70);
      g.add(frontBead);
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.018, 0.24, 12), matBrass);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.105, -0.18);
      g.add(scope);
      [-0.298, -0.062].forEach(lz => {
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 12), matCockpitGlass);
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0.105, lz);
        g.add(lens);
      });
      [-0.23, -0.13].forEach(rz => {
        const sRing = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.018, 12), matAnodizedDark);
        sRing.rotation.x = Math.PI / 2;
        sRing.position.set(0, 0.105, rz);
        g.add(sRing);
      });
      const boltHandle = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.012, 0.016), matAluminum);
      boltHandle.position.set(0.032, 0.064, -0.14);
      g.add(boltHandle);
      g.userData.boltHandle = boltHandle;
      g.position.set(0.28, -0.28, -0.48);
      g.visible = false;
      fpToolHolder.add(g);
    }

    // 5. Bundle of Dynamite
    {
      const g = toolMeshes.dynamite;
      const dynMat = new THREE.MeshStandardMaterial({ color: 0xa61818, roughness: 0.58 });
      [[-0.018, 0], [0.018, 0], [0, 0.028]].forEach(([dx, dy]) => {
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 10), dynMat);
        stick.position.set(dx, dy, 0);
        g.add(stick);
      });
      [-0.045, 0.045].forEach(by => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.032, 10), matAnodizedDark);
        band.position.y = by;
        g.add(band);
      });
      const fuseCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.10, 0),
        new THREE.Vector3(0.008, 0.125, 0.006),
        new THREE.Vector3(0, 0.145, 0)
      ]);
      const fuseCord = new THREE.Mesh(new THREE.TubeGeometry(fuseCurve, 6, 0.003, 6, false), matRawhide);
      g.add(fuseCord);
      const fuseSpark = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffab00 }));
      fuseSpark.position.set(0, 0.145, 0);
      g.add(fuseSpark);
      g.position.set(0.32, -0.30, -0.52);
      g.rotation.set(0.22, 0, -0.15);
      g.visible = false;
      fpToolHolder.add(g);
    }
  }

  const rareWeaponCaches = [];
  window.rareWeaponCaches = rareWeaponCaches;
  function buildRareExpeditionCaches() {
    const cave1 = (window.CAVE_SYSTEMS && window.CAVE_SYSTEMS[1]) ? window.CAVE_SYSTEMS[1] : null;
    const cave2 = (window.CAVE_SYSTEMS && window.CAVE_SYSTEMS[2]) ? window.CAVE_SYSTEMS[2] : null;
    const cave1Pt = cave1 && cave1.getPoint ? cave1.getPoint(0.76) : { x: -165, floorY: 2.0, z: 120 };
    const cave2Pt = cave2 && cave2.getPoint ? cave2.getPoint(0.72) : { x: -112, floorY: 28.0, z: 242 };

    const specs = [
      {
        id: 'sw_wreck_pistol',
        name: 'Expedition Sidearm Locker (SW Shipwreck)',
        x: -782.0, z: 722.0, yOverride: null,
        loot: { unlock: 'pistol', pistolAmmo: 5, dynamite: 1 },
        desc: 'Recovered Waterproof Expedition Pistol (5 rounds) + 1 Dynamite Stick!'
      },
      {
        id: 'nw_tower_rifle',
        name: 'Survey Rifle Strongbox (NW Stronghold)',
        x: -792.5, z: -809.5, yOverride: null,
        loot: { unlock: 'rifle', rifleAmmo: 4, dynamite: 2 },
        desc: 'Recovered Bolt-Action Hunting Rifle (4 rounds) + 2 Dynamite Sticks!'
      },
      {
        id: 'ne_bastion_blaster',
        name: 'Volcanic Miner Blast Crate (NE Bastion)',
        x: 837.0, z: -784.0, yOverride: null,
        loot: { dynamite: 2, pistolAmmo: 3, obsidian: 3 },
        desc: 'Recovered 2 Dynamite Sticks, 3 Pistol Rounds & 3 Volcanic Obsidian!'
      },
      {
        id: 'karst_miner_cache',
        name: 'Deep Karst Blasting Tin (Subterranean Vault)',
        x: cave1Pt.x, z: cave1Pt.z,
        yOverride: (cave1Pt.floorY !== undefined ? cave1Pt.floorY : (cave1Pt.y || 2.0)) +
          (window.evalCaveFloorRelief ? Math.max(0.0, window.evalCaveFloorRelief(false, 0.76 * ((cave1 && cave1.totalLength) || 88.0), 0.0, cave1Pt.halfW || 6.4, cave1Pt.x, cave1Pt.z, 0.76)) : 0.0) + 0.05,
        loot: { dynamite: 2, rifleAmmo: 3, flares: 3 },
        desc: 'Recovered Deep Cavern 2 Dynamite Sticks, 3 Rifle Rounds & 3 Flares!'
      },
      {
        id: 'lavatube_hunter_pack',
        name: 'Lava Tube Hunter Field Pack',
        x: cave2Pt.x, z: cave2Pt.z,
        yOverride: (cave2Pt.floorY !== undefined ? cave2Pt.floorY : (cave2Pt.y || 28.0)) +
          (window.evalCaveFloorRelief ? Math.max(0.0, window.evalCaveFloorRelief(true, 0.72 * ((cave2 && cave2.totalLength) || 98.0), 0.0, cave2Pt.halfW || 6.5, cave2Pt.x, cave2Pt.z, 0.72)) : 0.0) + 0.05,
        loot: { unlock: 'bow', arrows: 8, sinew: 2, pistolAmmo: 2 },
        desc: 'Recovered Recurve Hunting Bow, 8 Feather Arrows & 2 Pistol Rounds!'
      }
    ];

    const crateWoodMat = matTimberLog;
    const brassTrimMat = matBrass;
    specs.forEach((sp, idx) => {
      const cy = sp.yOverride !== null ? sp.yOverride : getTerrainHeight(sp.x, sp.z);
      const cg = new THREE.Group();
      cg.position.set(sp.x, cy + 0.22, sp.z);
      cg.rotation.y = idx * 0.7;

      const box = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.44, 0.56), crateWoodMat);
      box.castShadow = true;
      box.receiveShadow = true;
      cg.add(box);

      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 0.58), brassTrimMat);
      lid.position.y = 0.24;
      cg.add(lid);
      cg.userData.lid = lid;

      const glint = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd54f })
      );
      glint.position.y = 0.42;
      cg.add(glint);
      cg.userData.glint = glint;

      cg.userData = Object.assign(cg.userData, {
        type: 'weapon_cache',
        cacheId: sp.id,
        loot: sp.loot,
        desc: sp.desc,
        opened: false,
        promptLabel: `Loot ${sp.name} [Tap Strike]`
      });
      worldLandmarksGroup.add(cg);
      registerInteractiveTarget(cg);
      rareWeaponCaches.push(cg);
    });
  }

  const buildGhost = (() => {
    const grp = new THREE.Group();
    const h = 1.85, c = 0.55;
    const pts = [
      -h, 0, -h,  -h + c, 0, -h,   -h, 0, -h,  -h, 0, -h + c,
       h, 0, -h,   h - c, 0, -h,    h, 0, -h,   h, 0, -h + c,
       h, 0,  h,   h - c, 0,  h,    h, 0,  h,   h, 0,  h - c,
      -h, 0,  h,  -h + c, 0,  h,   -h, 0,  h,  -h, 0,  h - c
    ];
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const gMat = new THREE.LineBasicMaterial({ color: 0xdcb46a, transparent: true, opacity: 0.48 });
    grp.add(new THREE.LineSegments(gGeo, gMat));
    grp.visible = false;
    return grp;
  })();
  scene.add(buildGhost);

  const RANGED_WEAPON_CONFIG = {
    bow: {
      sensScale: 0.55,
      zoomFov: -6.5,
      hipPos: { x: 0.28, y: -0.24, z: -0.54 },
      hipRot: { x: 0.08, y: 0.16, z: -0.22 },
      aimPos: { x: 0.15, y: -0.13, z: -0.45 },
      aimRot: { x: 0.03, y: 0.05, z: -0.54 },
      recoil: { camPitch: 0.018, camYawJitter: 0.004, modelZ: 0.055, modelPitch: 0.08, fovPunch: 1.0, hapticMs: 16 },
      emptyMsg: '🏹 Out of Arrows! Recover shot arrows or craft more in Pack.'
    },
    crossbow: {
      sensScale: 0.50,
      zoomFov: -8.0,
      hipPos: { x: 0.30, y: -0.28, z: -0.52 },
      hipRot: { x: 0.0, y: 0.0, z: 0.0 },
      aimPos: { x: 0.11, y: -0.15, z: -0.41 },
      aimRot: { x: 0.01, y: 0.03, z: 0.0 },
      recoil: { camPitch: 0.032, camYawJitter: 0.008, modelZ: 0.085, modelPitch: 0.14, fovPunch: 1.6, hapticMs: 22 },
      emptyMsg: '🎯 Out of Bolts & Arrows! Pick up fired bolts/arrows or craft in Pack.'
    },
    pistol: {
      sensScale: 0.58,
      zoomFov: -5.5,
      hipPos: { x: 0.30, y: -0.28, z: -0.50 },
      hipRot: { x: 0.0, y: 0.0, z: 0.0 },
      aimPos: { x: 0.09, y: -0.16, z: -0.40 },
      aimRot: { x: 0.01, y: 0.02, z: 0.0 },
      muzzleOffset: { right: 0.08, up: -0.09, fwd: 0.72 },
      recoil: { camPitch: 0.044, camYawJitter: 0.012, modelZ: 0.095, modelPitch: 0.25, fovPunch: 1.9, hapticMs: 24 },
      emptyMsg: '🔫 Out of Pistol Rounds! Search outer island expedition crates.'
    },
    rifle: {
      sensScale: 0.42,
      zoomFov: -11.5,
      hipPos: { x: 0.28, y: -0.28, z: -0.48 },
      hipRot: { x: 0.0, y: 0.0, z: 0.0 },
      aimPos: { x: 0.07, y: -0.15, z: -0.36 },
      aimRot: { x: 0.0, y: 0.02, z: 0.0 },
      muzzleOffset: { right: 0.07, up: -0.09, fwd: 1.05 },
      recoil: { camPitch: 0.070, camYawJitter: 0.016, modelZ: 0.14, modelPitch: 0.28, fovPunch: 3.1, hapticMs: 36 },
      emptyMsg: '🎯 Out of Rifle Rounds! Search outer island & deep cave caches.'
    },
    flare: {
      sensScale: 0.62,
      zoomFov: -4.0,
      hipPos: { x: 0.34, y: -0.34, z: -0.56 },
      hipRot: { x: 0.0, y: 0.0, z: 0.0 },
      aimPos: { x: 0.13, y: -0.20, z: -0.45 },
      aimRot: { x: 0.05, y: 0.03, z: 0.0 },
      muzzleOffset: { right: 0.11, up: -0.11, fwd: 0.80 },
      recoil: { camPitch: 0.050, camYawJitter: 0.010, modelZ: 0.11, modelPitch: 0.26, fovPunch: 2.2, hapticMs: 32 },
      emptyMsg: '⚠️ Out of Signal Flares! Craft more in Pack (1 Obsidian + 1 Bamboo).'
    }
  };
  window.RANGED_WEAPON_CONFIG = RANGED_WEAPON_CONFIG;

  function isRangedAimTool(toolId) {
    return Object.prototype.hasOwnProperty.call(RANGED_WEAPON_CONFIG, toolId);
  }
  function getRangedAmmoCount(toolId) {
    if (toolId === 'bow') return player.inventory.arrows || 0;
    if (toolId === 'crossbow') return (player.inventory.bolts || 0) + (player.inventory.arrows || 0);
    if (toolId === 'pistol') return player.inventory.pistolAmmo || 0;
    if (toolId === 'rifle') return player.inventory.rifleAmmo || 0;
    if (toolId === 'flare') return player.inventory.flares || 0;
    return 0;
  }
  function resetRangedAimState() {
    const aim = campaign.rangedAim;
    aim.active = false;
    aim.tool = null;
    aim.pointerMode = null;
    aim.touchId = null;
    aim.holdTime = 0;
    aim.overCancel = false;
    aim.breathHapticFired = false;
    campaign.bowDraw.holding = false;
    campaign.bowDraw.power = 0;
    campaign.bowDraw.holdTime = 0;
    window._bowBreathSteady = false;
    const strikeEl = document.getElementById('btn-strike');
    if (strikeEl) strikeEl.classList.remove('aiming');
    const cancelEl = document.getElementById('cc-cancel-aim');
    if (cancelEl) {
      cancelEl.style.display = 'none';
      cancelEl.classList.remove('hover-cancel');
    }
  }
  window.resetRangedAimState = resetRangedAimState;

  function selectTool(toolId) {
    if (['bow', 'crossbow', 'pistol', 'rifle'].includes(toolId) && !campaign.unlockedWeapons[toolId]) {
      const hints = {
        bow: 'Craft the Recurve Bow in Pack (2 Timber + 1 Sinew + 1 Fiber)!',
        crossbow: 'Craft the Crossbow in Pack (3 Timber + 2 Bone + 2 Sinew)!',
        pistol: 'Scavenge the rare Pistol from the SW Shipwreck Cache (-782, 722)!',
        rifle: 'Scavenge the Hunting Rifle from the NW Watchtower Cache (-760, -770)!'
      };
      showToast('🔒 ' + (hints[toolId] || 'Weapon not yet unlocked!'));
      return;
    }
    if (toolId === 'dynamite' && (player.inventory.dynamite || 0) <= 0) {
      showToast('🧨 No Dynamite remaining! Scavenge Expedition Blast Crates on outer islands or deep caves.');
      return;
    }
    resetRangedAimState();
    campaign.weaponPoseBlend = 0;
    campaign.activeTool = toolId;
    window._calderaActiveTool = toolId;
    Object.keys(toolMeshes).forEach(k => {
      if (toolMeshes[k]) toolMeshes[k].visible = (k === toolId);
    });
    if (window.fpAxeMesh) {
      window.fpAxeMesh.visible = (toolId === 'hatchet');
    }
    playerTorchLight.intensity = (toolId === 'torch') ? (3.35 + (window.caveDarknessFactor || 0.0) * 3.85) : 0.0;
    buildGhost.visible = (toolId === 'build');

    const aimEl = document.getElementById('cc-bow-arc');
    if (aimEl) {
      aimEl.className = isRangedAimTool(toolId) ? `reticle-${toolId}` : '';
      aimEl.style.display = isRangedAimTool(toolId) ? 'block' : 'none';
    }
    const aimBadgeEl = document.getElementById('cc-aim-badge');
    if (aimBadgeEl) {
      aimBadgeEl.style.display = isRangedAimTool(toolId) ? 'block' : 'none';
    }

    document.querySelectorAll('.cc-tool-slot').forEach(el => {
      el.classList.toggle('active', el.dataset.tool === toolId);
    });
    // Dynamically update Quick Belt slot 3 (Ranged) or slot 4 (Utility) if a secondary ranged/utility tool is equipped
    const rangedMeta = {
      bow: { ico: '🏹', lbl: 'Bow' },
      crossbow: { ico: '🎯', lbl: 'X-Bow' },
      pistol: { ico: '🔫', lbl: 'Pistol' },
      rifle: { ico: '🎯', lbl: 'Rifle' }
    };
    const utilMeta = {
      torch: { ico: '🔥', lbl: 'Torch' },
      rod: { ico: '🎣', lbl: 'Rod' },
      flare: { ico: '🎇', lbl: 'Flare' },
      dynamite: { ico: '🧨', lbl: 'Blast' },
      build: { ico: '🔨', lbl: 'Build' }
    };
    const slotRanged = document.getElementById('cc-belt-ranged');
    if (slotRanged && rangedMeta[toolId]) {
      slotRanged.dataset.tool = toolId;
      slotRanged.innerHTML = `<span class="ico">${rangedMeta[toolId].ico}</span><span>${rangedMeta[toolId].lbl}</span>`;
      slotRanged.classList.add('active');
    }
    const slotUtil = document.getElementById('cc-belt-util');
    if (slotUtil && utilMeta[toolId]) {
      slotUtil.dataset.tool = toolId;
      slotUtil.innerHTML = `<span class="ico">${utilMeta[toolId].ico}</span><span>${utilMeta[toolId].lbl}</span>`;
      slotUtil.classList.add('active');
    }
    updateCastawayHUD();
    // Sync Primary #btn-strike action label with equipped tool
    const strikeLblEl = document.querySelector('#btn-strike span');
    if (strikeLblEl) {
      const actionNames = {
        hatchet: 'Chop', spear: 'Thrust', bow: 'Aim', crossbow: 'Aim',
        pistol: 'Aim', rifle: 'Aim', dynamite: 'Toss', rod: 'Cast',
        torch: 'Swing', flare: 'Aim', build: 'Place'
      };
      strikeLblEl.innerText = actionNames[toolId] || 'Strike';
    }

    const labels = {
      hatchet: '🪓 Forged Bearded Hatchet equipped',
      spear: '🔱 Obsidian Hunting Spear equipped',
      rod: '🎣 Bamboo Fishing Rod equipped — Tap Cast near water!',
      torch: '🔥 Pitch Cavern Torch lit',
      flare: `🎇 Signal Flare Gun (${player.inventory.flares} Flares)`,
      build: `🔨 Builder: ${campaign.buildPiece.toUpperCase()} — Tap Place or open Pack to change`,
      bow: `🏹 Recurve Bow (${player.inventory.arrows || 0} Arrows)`,
      crossbow: `🎯 Heavy Crossbow (${player.inventory.bolts || 0} Bolts)`,
      pistol: `🔫 Pistol (${player.inventory.pistolAmmo || 0} Rounds)`,
      rifle: `🎯 Hunting Rifle (${player.inventory.rifleAmmo || 0} Rounds)`,
      dynamite: `🧨 Dynamite (${player.inventory.dynamite || 0} Sticks)`
    };
    if (labels[toolId]) showToast(labels[toolId]);
  }
  window.selectSurvivorTool = selectTool;

  // ============================================================================
  // 8. AAA MODULAR BASE BUILDING, RAIN CATCHERS, COOKING RACKS & CRAB TRAPS
  // ============================================================================
  const BUILD_RECIPES = {
    foundation: { name: 'Timber Deck Foundation', cost: { timber: 3 }, desc: '3.8m elevated walkable timber platform' },
    wall:       { name: 'Palisade Log Wall',      cost: { timber: 2 }, desc: 'Solid 6-log shelter wall & predator barrier' },
    roof:       { name: 'Palm Thatch Roof Canopy', cost: { timber: 2, fiber: 2 }, desc: 'Sloped tropical shelter roof at +2.6m' },
    campfire:   { name: 'Stone-Ring Campfire',    cost: { timber: 2, stone: 2 }, desc: 'Warmth, light & campfire cooking station' },
    cookrack:   { name: 'Spit-Roast Cooking Rack', cost: { timber: 2, bamboo: 1 }, desc: 'Roasts Raw Fish & Meat into hearty meals' },
    raincatcher:{ name: 'Bamboo Rainwater Catcher',cost: { bamboo: 2, fiber: 1 }, desc: 'Collects fresh drinking water (+40 Hydration)' },
    crabtrap:   { name: 'Woven Shoreline Crab Trap',cost: { bamboo: 2, fiber: 1 }, desc: 'Passively catches shoreline crabs for food' }
  };

  function hasResources(cost) {
    for (const k in cost) {
      if ((player.inventory[k] || 0) < cost[k]) return false;
    }
    return true;
  }

  function deductResources(cost) {
    for (const k in cost) {
      player.inventory[k] = Math.max(0, (player.inventory[k] || 0) - cost[k]);
    }
    updateCastawayHUD();
  }

  function placeModularStructure() {
    const piece = campaign.buildPiece;
    const recipe = BUILD_RECIPES[piece];
    if (!recipe) return;

    if (!hasResources(recipe.cost)) {
      const needed = Object.entries(recipe.cost).map(([k, v]) => `${v} ${k}`).join(', ');
      showToast(`⚠️ Need ${needed} to build ${recipe.name}!`);
      return;
    }

    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, player.yaw, 0));
    const gx = Math.round((player.pos.x + fwd.x * 3.8) / 1.9) * 1.9;
    const gz = Math.round((player.pos.z + fwd.z * 3.8) / 1.9) * 1.9;
    const gy = Math.max(getTerrainHeight(gx, gz), window.getSupportSurfaceY(gx, gz, player.pos.y));
    const snapYaw = Math.round(player.yaw / (Math.PI / 2)) * (Math.PI / 2);

    deductResources(recipe.cost);
    AudioEngine.playChop();

    const sGroup = new THREE.Group();
    sGroup.position.set(gx, gy, gz);
    sGroup.rotation.y = snapYaw;

    if (piece === 'foundation') {
      // 8 Hewn Timber Deck Planks + Perimeter Ledger Beams + 4 Lashed Corner Pilings
      for (let p = -3.5; p <= 3.5; p += 1.0) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.14, 0.44), matHickory);
        plank.position.set(0, 0.52, p * 0.46);
        plank.castShadow = true;
        plank.receiveShadow = true;
        sGroup.add(plank);
      }
      [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]].forEach(([px, pz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 1.45, 10), matTimberLog);
        post.position.set(px, 0.0, pz);
        sGroup.add(post);
      });
      registerClimbableBox(gx, gz, 1.95, 1.95, snapYaw, gy + 0.59, gy - 0.5);
    } else if (piece === 'wall') {
      // 6 Horizontal Saddle-Notched Palisade Logs + 2 Vertical Brace Posts with Rope Lashings
      for (let l = 0; l < 6; l++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 3.85, 12), matTimberLog);
        log.rotation.z = Math.PI / 2;
        log.position.y = 0.22 + l * 0.38;
        log.castShadow = true;
        sGroup.add(log);
      }
      [-1.7, 1.7].forEach(bx => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 2.55, 10), matTimberLog);
        post.position.set(bx, 1.25, 0.16);
        sGroup.add(post);
      });
      registerCollider(gx, gz, 1.2, gy, gy + 2.6, 'built_wall');
    } else if (piece === 'roof') {
      const roof = createLayeredThatchRoof(2.92, 1.52);
      roof.position.y = 2.85;
      sGroup.add(roof);
      registerClimbableBox(gx, gz, 1.9, 1.9, snapYaw, gy + 2.6, gy + 1.5);
    } else if (piece === 'campfire') {
      const pLight = new THREE.PointLight(0xff8b38, 1.38, 9.8, 2.0);
      pLight.position.set(gx, gy + 0.45, gz);
      scene.add(pLight);
      registerManagedLight(pLight, 38.0);
      const fireMesh = window.createCampfire(pLight);
      fireMesh.position.set(gx, gy, gz);
      scene.add(fireMesh);
      showToast('🔥 Stone-Ring Campfire built with cooking spit!');
      return;
    } else if (piece === 'cookrack') {
      // A-Frame Bipod Timber Supports, Bamboo Spit Crossbar & Suspended Roast Ration
      [-0.78, 0.78].forEach(xOff => {
        [-0.25, 0.25].forEach(zLean => {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, 1.35, 10), matTimberLog);
          leg.position.set(xOff, 0.62, zLean * 0.85);
          leg.rotation.x = zLean > 0 ? -0.36 : 0.36;
          leg.raycast = () => {};
          sGroup.add(leg);
        });
      });
      const crossbar = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 1.75, 10), matSeasonedBamboo);
      crossbar.rotation.z = Math.PI / 2;
      crossbar.position.y = 1.15;
      crossbar.raycast = () => {};
      sGroup.add(crossbar);

      const roastHaunch = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), matRawhide);
      roastHaunch.scale.set(1.5, 0.85, 0.9);
      roastHaunch.position.y = 1.15;
      roastHaunch.raycast = () => {};
      sGroup.add(roastHaunch);

      const proxy = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.35, 0.95), _landmarkProxyMat);
      proxy.position.y = 0.65;
      sGroup.add(proxy);

      sGroup.userData = { type: 'cookrack', promptLabel: 'Roast Fish/Meat on Spit [Tap Strike]' };
      registerInteractiveTarget(sGroup);
    } else if (piece === 'raincatcher') {
      // 4 Bamboo Corner Legs + Woven Funnel Basin + Shimmering Purified Water Surface
      for (let c = 0; c < 4; c++) {
        const a = (c / 4) * Math.PI * 2 + Math.PI / 4;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.05, 10), matSeasonedBamboo);
        leg.position.set(Math.cos(a) * 0.62, 0.52, Math.sin(a) * 0.62);
        leg.raycast = () => {};
        sGroup.add(leg);
      }
      const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.52, 0.78, 16), matThatch);
      frame.position.y = 0.56;
      frame.raycast = () => {};
      sGroup.add(frame);
      const waterSurface = new THREE.Mesh(
        new THREE.CircleGeometry(0.68, 18),
        new THREE.MeshStandardMaterial({ color: 0x00bcd4, roughness: 0.08, metalness: 0.35 })
      );
      waterSurface.rotation.x = -Math.PI / 2;
      waterSurface.position.y = 0.91;
      waterSurface.raycast = () => {};
      sGroup.add(waterSurface);

      const proxy = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.72, 1.1, 10), _landmarkProxyMat);
      proxy.position.y = 0.55;
      sGroup.add(proxy);

      sGroup.userData = { type: 'raincatcher', promptLabel: 'Drink Purified Rainwater (+40 Thirst) [Tap Strike]' };
      registerInteractiveTarget(sGroup);
    } else if (piece === 'crabtrap') {
      // Woven Bamboo Slat Lobster/Crab Pot with Entry Funnel
      const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.96, 12), matThatch);
      cage.rotation.z = Math.PI / 2;
      cage.position.y = 0.28;
      cage.raycast = () => {};
      sGroup.add(cage);
      [-0.36, 0, 0.36].forEach(rx => {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.49, 0.03, 8, 14), matSeasonedBamboo);
        hoop.rotation.y = Math.PI / 2;
        hoop.position.set(rx, 0.28, 0);
        hoop.raycast = () => {};
        sGroup.add(hoop);
      });
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.65, 0.95), _landmarkProxyMat);
      proxy.position.y = 0.32;
      sGroup.add(proxy);

      sGroup.userData = {
        type: 'crabtrap',
        hasCatch: true,
        promptLabel: 'Harvest Trapped Shoreline Crab (+1 Raw Meat) [Tap Strike]'
      };
      registerInteractiveTarget(sGroup);
    }

    scene.add(sGroup);
    showToast(`🏗️ Built ${recipe.name}!`);
  }

  // ============================================================================
  // ============================================================================
  // 9. AAA PROCEDURAL WOLF (HIGH-POLY MUSCULATURE, GPU-INSTANCED FUR,
  //    512x512 NORMAL/DISPLACEMENT MAPS & ANISOTROPIC + SSS CUSTOM SHADERS)
  // ============================================================================
  const wildlifeAgents = [];
  const wildlifeGroup = new THREE.Group();
  scene.add(wildlifeGroup);

  const matBoarHide  = new THREE.MeshStandardMaterial({ color: 0x3b281e, roughness: 0.86 });
  const matBoarMane  = new THREE.MeshStandardMaterial({ color: 0x1e130d, roughness: 0.92 });
  const matSnoutPink = new THREE.MeshStandardMaterial({ color: 0x5c3632, roughness: 0.68 });
  const matWolfFur   = new THREE.MeshStandardMaterial({ color: 0x565e66, roughness: 0.80 });
  const matWolfBelly = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.82 });
  const matEyeAmber  = new THREE.MeshStandardMaterial({ color: 0x9e5e14, roughness: 0.08, metalness: 0.25 });
  const matEyeDark   = new THREE.MeshStandardMaterial({ color: 0x0e0f12, roughness: 0.08, metalness: 0.25 });
  const matIvory     = new THREE.MeshStandardMaterial({ color: 0xf7f2e4, roughness: 0.28 });
  const matCrabShell = new THREE.MeshStandardMaterial({ color: 0xb73e26, roughness: 0.38 });
  const matFishScale = new THREE.MeshStandardMaterial({ color: 0x26c6da, roughness: 0.18, metalness: 0.68 });
  const matFishFin   = new THREE.MeshStandardMaterial({ color: 0x80deea, roughness: 0.32, side: THREE.DoubleSide });
  const matEaglePlume= new THREE.MeshStandardMaterial({ color: 0x2c2018, roughness: 0.72, side: THREE.DoubleSide });

  // Shared 12-triangle invisible hit-proxy so raycasting against high-poly wolves costs <0.001ms on CPU
  const _wildlifeHitProxyGeo = new THREE.CylinderGeometry(0.68, 0.68, 1.55, 8, 1);
  _wildlifeHitProxyGeo.translate(0, 0.72, 0);
  const _wildlifeHitProxyMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    colorWrite: false
  });

  // Shared AAA Wolf Shader Uniforms & Procedural 512x512 Normal/Displacement/Albedo Maps
  const wolfShaderUniforms = {
    uFurTime: { value: 0.0 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.78, -0.42).normalize() }
  };
  window.wolfShaderUniforms = wolfShaderUniforms;

  let wolfPBRAssets = null;
  async function buildWolfPBRMapsAndMaterialsAsync() {
    const size = 512;

    // 1. High-Resolution 512x512 Displacement Map (Muscle Striations, Ribcage Definition, Battle Scars & Skin Pores)
    const dispCanvas = document.createElement('canvas');
    dispCanvas.width = size;
    dispCanvas.height = size;
    const dCtx = dispCanvas.getContext('2d');
    dCtx.fillStyle = '#808080';
    dCtx.fillRect(0, 0, size, size);

    // Broad anatomical muscle bundles (scapula, deltoid, ribcage intercostals, quadriceps)
    for (let m = 0; m < 48; m++) {
      const y = (m / 48) * size;
      const g = dCtx.createLinearGradient(0, y, size, y + 24);
      g.addColorStop(0.0, 'rgba(165, 165, 165, 0.18)');
      g.addColorStop(0.5, 'rgba(95, 95, 95, 0.18)');
      g.addColorStop(1.0, 'rgba(165, 165, 165, 0.18)');
      dCtx.fillStyle = g;
      dCtx.fillRect(0, y, size, 14);
    }

    // Fine directional fur-follicle pores & dermis micro-grain
    for (let i = 0; i < 3800; i++) {
      const px = Math.random() * size;
      const py = Math.random() * size;
      const lum = Math.random() > 0.45 ? 195 : 68;
      dCtx.fillStyle = `rgba(${lum}, ${lum}, ${lum}, 0.28)`;
      dCtx.fillRect(px, py, 2, 5);
    }

    // Deep battle scars across muzzle, shoulder & flank (sunken dermal grooves with raised keloid ridges)
    const scars = [
      [110, 90, 210, 145],
      [118, 84, 218, 139],
      [310, 210, 420, 265],
      [280, 340, 390, 310]
    ];
    scars.forEach(([x0, y0, x1, y1]) => {
      dCtx.strokeStyle = 'rgba(215, 215, 215, 0.65)';
      dCtx.lineWidth = 6.0;
      dCtx.beginPath();
      dCtx.moveTo(x0, y0);
      dCtx.lineTo(x1, y1);
      dCtx.stroke();

      dCtx.strokeStyle = 'rgba(28, 28, 28, 0.88)';
      dCtx.lineWidth = 2.6;
      dCtx.beginPath();
      dCtx.moveTo(x0, y0);
      dCtx.lineTo(x1, y1);
      dCtx.stroke();
    });
    await yieldFrame();

    // 2. Convert 512x512 Height/Displacement Map into Sobel Tangent-Space Normal Map (Flat Float32Array optimized)
    const srcData = dCtx.getImageData(0, 0, size, size).data;
    const normCanvas = document.createElement('canvas');
    normCanvas.width = size;
    normCanvas.height = size;
    const nCtx = normCanvas.getContext('2d');
    const nImg = nCtx.createImageData(size, size);
    const nData = nImg.data;
    const strength = 3.2;
    const totalPixels = size * size;
    const lumBuf = new Float32Array(totalPixels);
    const inv255 = 1.0 / 255.0;
    for (let p = 0; p < totalPixels; p++) {
      lumBuf[p] = srcData[p << 2] * inv255;
    }

    for (let y = 0; y < size; y++) {
      const yUp = (y === 0 ? size - 1 : y - 1) * size;
      const yMid = y * size;
      const yDn = (y === size - 1 ? 0 : y + 1) * size;
      for (let x = 0; x < size; x++) {
        const xL = x === 0 ? size - 1 : x - 1;
        const xR = x === size - 1 ? 0 : x + 1;
        const dx = (lumBuf[yMid + xR] - lumBuf[yMid + xL]) * strength;
        const dy = (lumBuf[yDn + x] - lumBuf[yUp + x]) * strength;
        const invLen = 1.0 / Math.sqrt(dx * dx + dy * dy + 1.0);
        const idx = (yMid + x) << 2;
        nData[idx]     = (((-dx * invLen) * 0.5 + 0.5) * 255) | 0;
        nData[idx + 1] = (((-dy * invLen) * 0.5 + 0.5) * 255) | 0;
        nData[idx + 2] = ((invLen * 0.5 + 0.5) * 255) | 0;
        nData[idx + 3] = 255;
      }
    }
    nCtx.putImageData(nImg, 0, 0);
    await yieldFrame();

    // 3. Agouti Timber-Wolf Coat Albedo Map (Charcoal Dorsal Cape, Silver-Ash Shoulder Ruff, Tawny Flanks & Cream Belly)
    const coatCanvas = document.createElement('canvas');
    coatCanvas.width = size;
    coatCanvas.height = size;
    const cCtx = coatCanvas.getContext('2d');
    const coatGrad = cCtx.createLinearGradient(0, 0, 0, size);
    coatGrad.addColorStop(0.00, '#181c22'); // Dorsal charcoal spine
    coatGrad.addColorStop(0.28, '#464e58'); // Silver-slate upper cape
    coatGrad.addColorStop(0.58, '#7a6c5d'); // Warm tawny-ochre flank
    coatGrad.addColorStop(0.82, '#b6aea2'); // Pale silver-cream chest/underbelly
    coatGrad.addColorStop(1.00, '#22262c');
    cCtx.fillStyle = coatGrad;
    cCtx.fillRect(0, 0, size, size);

    for (let s = 0; s < 5200; s++) {
      const sx = Math.random() * size;
      const sy = Math.random() * size;
      cCtx.strokeStyle = (s % 3 === 0)
        ? 'rgba(225, 230, 236, 0.24)'
        : (s % 3 === 1 ? 'rgba(20, 24, 30, 0.30)' : 'rgba(156, 132, 104, 0.22)');
      cCtx.lineWidth = 1.1;
      cCtx.beginPath();
      cCtx.moveTo(sx, sy);
      cCtx.lineTo(sx + (Math.random() - 0.5) * 4, sy + 10 + Math.random() * 10);
      cCtx.stroke();
    }

    const dispTex = new THREE.CanvasTexture(dispCanvas);
    const normTex = new THREE.CanvasTexture(normCanvas);
    const coatTex = new THREE.CanvasTexture(coatCanvas);
    [dispTex, normTex, coatTex].forEach(t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    });

    // 4. Custom Shader Customization on THREE.MeshStandardMaterial:
    //    - Kajiya-Kay Anisotropic Fur Specular Highlights (light catching hair along tangent flow)
    //    - Subsurface Scattering (SSS) warm light transmission through the thin tips of the ears
    //    - Dynamic fur-clump vertex flow along back, neck, and tail
    function injectWolfAnisotropicSSSMaterial(mat, isInstancedHair = false) {
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uFurTime = wolfShaderUniforms.uFurTime;
        shader.uniforms.uSunDir = wolfShaderUniforms.uSunDir;

        shader.vertexShader = `
          attribute float aSssWeight;
          varying float vSssWeight;
          varying vec3 vWolfWorldPos;
          varying vec3 vWolfFurTangent;
          uniform float uFurTime;
        ` + shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          vSssWeight = aSssWeight;
          vec3 localTangent = normalize(vec3(0.0, -0.25, -1.0));
          ${isInstancedHair ? `
            // Clumping wind & gait ripple on individual instanced guard hairs (rooted at y=0, tip at y=1)
            float tipFactor = clamp(position.y * 8.5, 0.0, 1.0);
            #ifdef USE_INSTANCING
              float instPhase = dot(vec3(instanceMatrix[3].xyz), vec3(12.9898, 78.233, 37.719));
            #else
              float instPhase = position.x * 12.9898 + position.z * 78.233;
            #endif
            float wave = sin(uFurTime * 4.2 + instPhase) * 0.008 * tipFactor * tipFactor;
            transformed.x += wave;
            transformed.z -= abs(wave) * 0.6;
          ` : `
            // Subtle muscular breathing & fur-clump ripple along dorsal spine and neck ruff
            float dorsalMask = smoothstep(0.0, 0.25, normal.y);
            float ripple = sin(uFurTime * 3.6 + position.z * 9.0 + position.x * 6.0) * 0.0045 * dorsalMask;
            transformed += normal * ripple;
          `}
          `
        ).replace(
          '#include <worldpos_vertex>',
          `
          #include <worldpos_vertex>
          vWolfWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWolfFurTangent = normalize(mat3(modelMatrix) * localTangent);
          `
        );

        shader.fragmentShader = `
          varying float vSssWeight;
          varying vec3 vWolfWorldPos;
          varying vec3 vWolfFurTangent;
          uniform vec3 uSunDir;
        ` + shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          // 1. Kajiya-Kay Anisotropic Specular Highlights (Dual-lobe sun-keyed hair sheen)
          vec3 viewDirW = normalize(cameraPosition - vWolfWorldPos);
          vec3 sunDirW = normalize(uSunDir);
          float sunUp = smoothstep(-0.05, 0.18, sunDirW.y);
          vec3 H = normalize(sunDirW + viewDirW);
          vec3 T = normalize(vWolfFurTangent + normal * 0.28);
          float dotTH = clamp(dot(T, H), -1.0, 1.0);
          float sinTH = sqrt(max(0.001, 1.0 - dotTH * dotTH));
          float dirAtten = smoothstep(-1.0, 0.0, dotTH) * sunUp;
          float primaryAniso = dirAtten * pow(sinTH, 32.0) * 0.30;
          float secondaryAniso = dirAtten * pow(sinTH, 8.0) * 0.14;
          vec3 anisoSheen = vec3(1.0, 0.94, 0.84) * primaryAniso + vec3(0.66, 0.56, 0.44) * secondaryAniso;

          // 2. Subsurface Scattering (SSS) — Warm crimson-amber light passing through ear tips & silhouette coat edges
          float backLight = pow(clamp(dot(viewDirW, -sunDirW), 0.0, 1.0), 2.4) * sunUp;
          float rimGrazing = pow(1.0 - clamp(dot(normal, viewDirW), 0.0, 1.0), 3.0);
          float earSss = clamp(vSssWeight, 0.0, 1.0) * (backLight * 0.85 + rimGrazing * 0.45);
          vec3 sssContribution = vec3(1.0, 0.28, 0.10) * earSss * 0.70 + vec3(0.96, 0.82, 0.58) * rimGrazing * backLight * 0.20;

          gl_FragColor.rgb += anisoSheen + sssContribution;
          #include <dithering_fragment>
          `
        );
      };
      return mat;
    }

    const skinMat = injectWolfAnisotropicSSSMaterial(new THREE.MeshStandardMaterial({
      map: coatTex,
      normalMap: normTex,
      normalScale: new THREE.Vector2(1.35, 1.35),
      displacementMap: dispTex,
      displacementScale: 0.014,
       displacementBias: -0.006,
      roughness: 0.64,
      metalness: 0.08,
      envMap: window.skyEnvCubeTex || null,
      envMapIntensity: 0.95
    }), false);

    const furStrandMat = injectWolfAnisotropicSSSMaterial(new THREE.MeshStandardMaterial({
      map: coatTex,
      normalMap: normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.52,
      metalness: 0.10,
      vertexColors: true,
      side: THREE.DoubleSide,
      envMap: window.skyEnvCubeTex || null,
      envMapIntensity: 1.05
    }), true);

    const rhinariumMat = new THREE.MeshStandardMaterial({
      normalMap: normTex,
      normalScale: new THREE.Vector2(1.8, 1.8),
      color: 0x121417,
      roughness: 0.22,
      metalness: 0.15,
      envMap: window.skyEnvCubeTex || null
    });

    // Soft radial contact shadow texture for grounded PCFSoftShadowMap realism
    const shCanvas = document.createElement('canvas');
    shCanvas.width = 128; shCanvas.height = 128;
    const shCtx = shCanvas.getContext('2d');
    const shGrad = shCtx.createRadialGradient(64, 64, 6, 64, 64, 62);
    shGrad.addColorStop(0.0, 'rgba(5, 8, 12, 0.62)');
    shGrad.addColorStop(0.55, 'rgba(5, 8, 12, 0.28)');
    shGrad.addColorStop(1.0, 'rgba(5, 8, 12, 0.0)');
    shCtx.fillStyle = shGrad;
    shCtx.fillRect(0, 0, 128, 128);
    const contactShadowMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shCanvas),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1
    });

    wolfPBRAssets = { skinMat, furStrandMat, rhinariumMat, contactShadowMat, normTex, dispTex, injectWolfAnisotropicSSSMaterial };
    return wolfPBRAssets;
  }

  // Helper: Build High-Polygon Anatomical Spline-Lofted Wolf Torso & Muscular Neck Geometry
  function buildWolfAnatomicalTorsoGeometry() {
    const axialSegs = 40;
    const radialSegs = 28;
    const positions = [];
    const uvs = [];
    const sssWeights = [];
    const indices = [];
    const surfaceSamples = []; // Stored for GPU-instanced fur distribution

    // Anatomical profile from pelvic croup (s=0, z=-0.56) -> lumbar waist -> deep thoracic ribcage -> scapular withers -> arched neck (s=1, z=+0.56)
    function sampleSpineProfile(s) {
      const z = -0.56 + s * 1.12;
      let centerY = 0.64;
      let rx = 0.16;
      let ryTop = 0.16;
      let ryBot = 0.16;

      if (s < 0.22) {
        // Muscular pelvic croup & hindquarters
        const u = s / 0.22;
        const swell = Math.sin(u * Math.PI * 0.85);
        centerY = 0.62 + u * 0.04;
        rx = 0.08 + swell * 0.135;
        ryTop = 0.09 + swell * 0.125;
        ryBot = 0.08 + swell * 0.120;
      } else if (s < 0.46) {
        // Tucked athletic lumbar waist
        const u = (s - 0.22) / 0.24;
        centerY = 0.66 - Math.sin(u * Math.PI) * 0.012;
        rx = 0.195 - Math.sin(u * Math.PI) * 0.032 + u * 0.035;
        ryTop = 0.195 + u * 0.025;
        ryBot = 0.165 - Math.sin(u * Math.PI) * 0.038 + u * 0.085;
      } else if (s < 0.78) {
        // Deep keel-shaped thoracic ribcage & prominent scapular ridge (withers)
        const u = (s - 0.46) / 0.32;
        const withersPeak = Math.sin(u * Math.PI);
        centerY = 0.66 + u * 0.045;
        rx = 0.23 + withersPeak * 0.038;
        ryTop = 0.22 + withersPeak * 0.055;
        ryBot = 0.25 + Math.sin(u * Math.PI * 0.8) * 0.045;
      } else {
        // Thick muscular cervical neck rising to cranium base
        const u = (s - 0.78) / 0.22;
        centerY = 0.705 + Math.pow(u, 1.15) * 0.175;
        rx = 0.235 * (1.0 - u * 0.30);
        ryTop = 0.225 * (1.0 - u * 0.32);
        ryBot = 0.215 * (1.0 - u * 0.35);
      }
      return { z, centerY, rx, ryTop, ryBot };
    }

    for (let i = 0; i <= axialSegs; i++) {
      const s = i / axialSegs;
      const { z, centerY, rx, ryTop, ryBot } = sampleSpineProfile(s);

      for (let j = 0; j <= radialSegs; j++) {
        const v = j / radialSegs;
        const theta = v * Math.PI * 2.0;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        // Anatomical muscle sculpting: scapular shoulder definitions, latissimus dorsi groove & sternum keel
        const isTop = sinT >= 0;
        const ry = isTop ? ryTop : ryBot;
        const scapulaBulk = (s > 0.52 && s < 0.80) ? Math.pow(Math.max(0, Math.abs(cosT) - 0.35), 1.5) * 0.038 : 0.0;
        const spinalCrest = (isTop && Math.abs(cosT) < 0.28) ? (0.28 - Math.abs(cosT)) * 0.055 : 0.0;
        const ribRuffle = (s > 0.36 && s < 0.72 && Math.abs(cosT) > 0.45)
          ? Math.sin(s * 52.0) * 0.0055 * Math.abs(cosT)
          : 0.0;

        const x = cosT * (rx + scapulaBulk + ribRuffle);
        const y = centerY + sinT * ry + spinalCrest;

        positions.push(x, y, z);
        uvs.push(s * 2.5, v * 2.0);
        sssWeights.push(0.06); // Subtle rim translucency on body coat

        if (i > 1 && i < axialSegs && j < radialSegs) {
          const nx = cosT;
          const ny = sinT;
          const nz = -0.18;
          const nLen = Math.hypot(nx, ny, nz) || 1.0;
          surfaceSamples.push({
            x, y, z,
            nx: nx / nLen,
            ny: ny / nLen,
            nz: nz / nLen,
            s,
            isRuff: (s > 0.68),
            isDorsal: (sinT > 0.25)
          });
        }
      }
    }

    const stride = radialSegs + 1;
    for (let i = 0; i < axialSegs; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = (i + 1) * stride + j;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sssWeights, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return { geo, surfaceSamples };
  }

  // Helper: Build Sculpted High-Poly Wolf Cranium & Upper Muzzle Geometry
  function buildWolfCraniumGeometry() {
    const axialSegs = 22;
    const radialSegs = 20;
    const positions = [];
    const uvs = [];
    const sssWeights = [];
    const indices = [];

    for (let i = 0; i <= axialSegs; i++) {
      const s = i / axialSegs;
      const z = -0.16 + s * 0.56; // Back of occiput (-0.16) to nasal tip (+0.40)
      let rx, ryTop, ryBot, centerY;

      if (s < 0.48) {
        // Broad cranium & zygomatic cheek arches
        const u = s / 0.48;
        const arch = Math.sin(u * Math.PI);
        rx = 0.08 + arch * 0.095;
        ryTop = 0.075 + arch * 0.070;
        ryBot = 0.065 + arch * 0.048;
        centerY = 0.02 + (1.0 - u) * 0.015;
      } else if (s < 0.60) {
        // Frontal stop (distinctive wolf brow drop into nasal bridge)
        const u = (s - 0.48) / 0.12;
        rx = 0.135 * (1.0 - u * 0.34);
        ryTop = 0.115 * (1.0 - u * 0.36);
        ryBot = 0.082 * (1.0 - u * 0.25);
        centerY = 0.015 - u * 0.022;
      } else {
        // Tapered nasal bridge & upper maxilla
        const u = (s - 0.60) / 0.40;
        const taper = 1.0 - Math.pow(u, 1.25) * 0.52;
        rx = 0.089 * taper;
        ryTop = 0.074 * taper;
        ryBot = 0.062 * taper;
        centerY = -0.007 - u * 0.012;
      }

      for (let j = 0; j <= radialSegs; j++) {
        const v = j / radialSegs;
        const theta = v * Math.PI * 2.0;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        // Zygomatic flare & supraorbital brow ridge
        const browRidge = (s > 0.34 && s < 0.54 && sinT > 0.35) ? Math.sin(((s - 0.34) / 0.20) * Math.PI) * 0.018 : 0.0;
        const cheekFlare = (s > 0.24 && s < 0.52 && Math.abs(cosT) > 0.6) ? 0.016 : 0.0;

        const x = cosT * (rx + cheekFlare);
        const y = centerY + sinT * (sinT >= 0 ? ryTop : ryBot) + browRidge;
        positions.push(x, y, z);
        uvs.push(s, v);
        sssWeights.push(0.08);
      }
    }

    const stride = radialSegs + 1;
    for (let i = 0; i < axialSegs; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = (i + 1) * stride + j;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sssWeights, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // Helper: Build Thin Cartilaginous Wolf Pinna (Ear) Geometry with High Subsurface Scattering (aSssWeight) at Tips
  function buildWolfEarGeometry() {
    const hSegs = 14;
    const rSegs = 14;
    const positions = [];
    const uvs = [];
    const sssWeights = [];
    const indices = [];

    for (let i = 0; i <= hSegs; i++) {
      const u = i / hSegs; // 0 = ear base, 1 = pointed ear tip
      const y = u * 0.195;
      const taper = Math.sin((1.0 - Math.pow(u, 1.35)) * Math.PI * 0.5);
      const rx = 0.052 * taper + 0.004;
      const rz = 0.036 * taper + 0.003;

      for (let j = 0; j <= rSegs; j++) {
        const v = j / rSegs;
        const ang = v * Math.PI * 2.0;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        // Cupped anterior pinna hollow (facing +Z)
        const cupZ = (sinA > 0) ? -sinA * 0.018 * Math.sin(u * Math.PI) : sinA * rz;
        const x = cosA * rx;
        const z = cupZ - u * 0.018;

        positions.push(x, y, z);
        uvs.push(u, v);
        // Strong subsurface scattering weight at ear tips (u -> 1) and thin cupped inner membrane
        const sss = Math.min(1.0, Math.pow(u, 0.85) * 0.92 + (sinA > 0 ? 0.25 : 0.0));
        sssWeights.push(sss);
      }
    }

    const stride = rSegs + 1;
    for (let i = 0; i < hSegs; i++) {
      for (let j = 0; j < rSegs; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = (i + 1) * stride + j;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sssWeights, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // Helper: Build Bushy Plumed Wolf Tail Geometry + Fur Surface Samples
  function buildWolfPlumedTailGeometry() {
    const axialSegs = 18;
    const radialSegs = 14;
    const positions = [];
    const uvs = [];
    const sssWeights = [];
    const indices = [];
    const tailSamples = [];

    for (let i = 0; i <= axialSegs; i++) {
      const s = i / axialSegs;
      const y = -s * 0.44;
      const z = -s * 0.34 - Math.pow(s, 1.8) * 0.08;
      const brushRadius = 0.038 + Math.sin(Math.pow(s, 0.75) * Math.PI) * 0.068;

      for (let j = 0; j <= radialSegs; j++) {
        const v = j / radialSegs;
        const ang = v * Math.PI * 2.0;
        const x = Math.cos(ang) * brushRadius;
        const py = y + Math.sin(ang) * brushRadius * 0.72;
        const pz = z + Math.sin(ang) * brushRadius * 0.68;

        positions.push(x, py, pz);
        uvs.push(s, v);
        sssWeights.push(0.14);

        if (i > 0 && i < axialSegs && j < radialSegs) {
          tailSamples.push({
            x, y: py, z: pz,
            nx: Math.cos(ang),
            ny: Math.sin(ang) * 0.6 - 0.5,
            nz: -0.65,
            s
          });
        }
      }
    }

    const stride = radialSegs + 1;
    for (let i = 0; i < axialSegs; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = (i + 1) * stride + j;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sssWeights, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return { geo, tailSamples };
  }

  // Helper: Build Curved Tapered Guard-Hair Blade Geometry for GPU Instancing (InstancedMesh)
  function buildCurvedHairStrandGeometry() {
    const segs = 4;
    const positions = [];
    const uvs = [];
    const sssWeights = [];
    const indices = [];

    for (let i = 0; i <= segs; i++) {
      const t = i / segs; // 0 = follicle root, 1 = tapered hair tip
      const halfW = 0.0085 * (1.0 - Math.pow(t, 0.85));
      const y = t * 0.115;
      const zCurve = -Math.pow(t, 1.85) * 0.048; // Natural caudal arch along the pelt

      positions.push(-halfW, y, zCurve, halfW, y, zCurve);
      uvs.push(0, t, 1, t);
      const sss = Math.pow(t, 1.2) * 0.38;
      sssWeights.push(sss, sss);
    }

    for (let i = 0; i < segs; i++) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sssWeights, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  let sharedWolfGeometries = null;
  function buildSharedWolfGeometries() {
    const torsoData = buildWolfAnatomicalTorsoGeometry();
    const craniumGeo = buildWolfCraniumGeometry();
    const earGeo = buildWolfEarGeometry();
    const tailData = buildWolfPlumedTailGeometry();
    const hairStrandGeo = buildCurvedHairStrandGeometry();
    sharedWolfGeometries = {
      torsoGeo: torsoData.geo,
      torsoSamples: torsoData.surfaceSamples,
      craniumGeo,
      earGeo,
      tailGeo: tailData.geo,
      tailSamples: tailData.tailSamples,
      hairStrandGeo
    };
    return sharedWolfGeometries;
  }

  // 9A-1. Senior Technical Artist AAA Procedural Wolf Builder
  function createAAAProceduralWolf(x, z) {
    const root = new THREE.Group();
    const y = getTerrainHeight(x, z);
    root.position.set(x, y, z);

    // 1. Soft Grounded Contact Shadow Disc beneath the wolf
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.45, 1.95),
      wolfPBRAssets.contactShadowMat
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, 0.025, 0.02);
    root.add(contactShadow);

    // 2. High-Polygon Anatomical Torso & Neck Musculature Mesh (Normal + Displacement + Anisotropic + SSS)
    const torsoMesh = new THREE.Mesh(sharedWolfGeometries.torsoGeo, wolfPBRAssets.skinMat);
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    root.add(torsoMesh);

    // 3. Fur Simulation via GPU Instancing (Thousands of Clumping Guard-Hair Strands along Back, Neck Ruff & Tail)
    const bodySamples = sharedWolfGeometries.torsoSamples;
    const bodyFurCount = 2400;
    const bodyFurInstanced = new THREE.InstancedMesh(
      sharedWolfGeometries.hairStrandGeo,
      wolfPBRAssets.furStrandMat,
      bodyFurCount
    );
    bodyFurInstanced.castShadow = false;
    bodyFurInstanced.receiveShadow = true;
    bodyFurInstanced.layers.set(1);

    const dummy = new THREE.Object3D();
    const upVec = new THREE.Vector3(0, 1, 0);
    const dirVec = new THREE.Vector3();
    const clumpColor = new THREE.Color();

    for (let h = 0; h < bodyFurCount; h++) {
      const sample = bodySamples[(h * 13) % bodySamples.length];
      // Clumping fur offset: group nearby hairs toward shared tuft centers
      const clumpPhase = Math.floor(h / 6) * 1.73;
      const jitterX = Math.sin(h * 12.9898) * 0.016;
      const jitterZ = Math.cos(h * 78.233) * 0.018;

      dummy.position.set(
        sample.x + jitterX,
        sample.y + Math.sin(clumpPhase) * 0.006,
        sample.z + jitterZ
      );

      // Flow direction: blend surface normal with caudal-ventral fur flow + clumping convergence
      const flowZ = sample.isRuff ? -0.58 : -0.82;
      const flowY = sample.isDorsal ? 0.35 : -0.28;
      dirVec.set(
        sample.nx * 0.68 + Math.sin(clumpPhase) * 0.12,
        sample.ny * 0.55 + flowY,
        sample.nz * 0.45 + flowZ
      ).normalize();

      dummy.quaternion.setFromUnitVectors(upVec, dirVec);
      dummy.rotateY((h % 7) * 0.18 - 0.54);

      const lenScale = sample.isRuff
        ? (1.35 + (h % 5) * 0.14)
        : (sample.isDorsal ? (1.12 + (h % 4) * 0.10) : (0.78 + (h % 3) * 0.08));
      dummy.scale.set(1.0 + (h % 3) * 0.15, lenScale, 1.0);
      dummy.updateMatrix();
      bodyFurInstanced.setMatrixAt(h, dummy.matrix);

      // Authentic Agouti Timber-Wolf Guard-Hair Color Banding
      if (sample.isDorsal && !sample.isRuff) {
        clumpColor.setHex((h % 4 === 0) ? 0x9aa4b0 : 0x1e232a); // Charcoal cape with silver guard tips
      } else if (sample.isRuff) {
        clumpColor.setHex((h % 3 === 0) ? 0xd2d8de : 0x626c76); // Thick silver-ash neck ruff
      } else if (sample.ny < -0.15) {
        clumpColor.setHex(0xc8c2b8); // Pale cream chest & belly
      } else {
        clumpColor.setHex((h % 2 === 0) ? 0x7e6e5c : 0x4c525a); // Tawny-slate flanks
      }
      bodyFurInstanced.setColorAt(h, clumpColor);
    }
    bodyFurInstanced.instanceMatrix.needsUpdate = true;
    if (bodyFurInstanced.instanceColor) bodyFurInstanced.instanceColor.needsUpdate = true;
    root.add(bodyFurInstanced);

    // 4. Sculpted Wolf Head, Muzzle, Amber Predator Eyes, Thin SSS Ears & Snapping Fang-Lined Mandible
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.88, 0.58);

    const craniumMesh = new THREE.Mesh(sharedWolfGeometries.craniumGeo, wolfPBRAssets.skinMat);
    craniumMesh.castShadow = true;
    craniumMesh.receiveShadow = true;
    headPivot.add(craniumMesh);

    // Wet Leathery Black Rhinarium (Nose Pad) with Nostril flares
    const rhinarium = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 14, 12),
      wolfPBRAssets.rhinariumMat
    );
    rhinarium.scale.set(1.05, 0.82, 0.95);
    rhinarium.position.set(0, -0.008, 0.405);
    headPivot.add(rhinarium);

    // Forward-Facing Binocular Predator Eyes (Glowing Amber-Gold Iris + Slit Pupil + Dark Eyelid Rim)
    [-0.078, 0.078].forEach(ex => {
      const eyeSocket = new THREE.Mesh(new THREE.SphereGeometry(0.029, 10, 10), wolfPBRAssets.rhinariumMat);
      eyeSocket.position.set(ex, 0.038, 0.145);
      headPivot.add(eyeSocket);

      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), matEyeAmber);
      iris.position.set(ex * 1.02, 0.039, 0.156);
      headPivot.add(iris);

      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), matEyeDark);
      pupil.scale.set(0.65, 1.15, 0.7);
      pupil.position.set(ex * 1.03, 0.039, 0.172);
      headPivot.add(pupil);
    });

    // Erect Cartilaginous Pinnae (Ears) with Subsurface Scattering (SSS) at Ear Tips
    [-0.095, 0.095].forEach(ex => {
      const earMesh = new THREE.Mesh(sharedWolfGeometries.earGeo, wolfPBRAssets.skinMat);
      earMesh.position.set(ex, 0.095, -0.045);
      earMesh.rotation.z = ex > 0 ? -0.22 : 0.22;
      earMesh.rotation.x = 0.12;
      earMesh.castShadow = true;
      headPivot.add(earMesh);
    });

    // Articulated Snapping Lower Mandible (Jaw, Gumline, Pink Tongue, Curved Ivory Canines & Carnassials)
    const jawPivot = new THREE.Group();
    jawPivot.position.set(0, -0.048, 0.065);

    const mandibleGeo = new THREE.CylinderGeometry(0.038, 0.068, 0.31, 14);
    mandibleGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(mandibleGeo.attributes.position.count).fill(0.05), 1));
    const mandible = new THREE.Mesh(
      mandibleGeo,
      wolfPBRAssets.skinMat
    );
    mandible.rotation.x = Math.PI / 2;
    mandible.scale.set(1.0, 0.56, 1.0);
    mandible.position.set(0, -0.012, 0.155);
    jawPivot.add(mandible);

    const tongue = new THREE.Mesh(
      new THREE.BoxGeometry(0.048, 0.014, 0.21),
      matSnoutPink
    );
    tongue.position.set(0, 0.008, 0.16);
    jawPivot.add(tongue);

    // Lower & Upper Curved Ivory Canine Fangs
    [-0.034, 0.034].forEach(fx => {
      const lowerCanine = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.052, 8), matIvory);
      lowerCanine.position.set(fx, 0.024, 0.275);
      lowerCanine.rotation.x = 0.12;
      jawPivot.add(lowerCanine);

      const upperCanine = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.056, 8), matIvory);
      upperCanine.rotation.x = Math.PI - 0.10;
      upperCanine.position.set(fx * 1.12, -0.046, 0.335);
      headPivot.add(upperCanine);
    });

    headPivot.add(jawPivot);
    root.userData.jaw = jawPivot;
    root.add(headPivot);

    // 5. Bushy Plumed Tail + Instanced Tail Guard-Hair Brush
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.64, -0.54);

    const tailCoreMesh = new THREE.Mesh(sharedWolfGeometries.tailGeo, wolfPBRAssets.skinMat);
    tailCoreMesh.castShadow = true;
    tailPivot.add(tailCoreMesh);

    const tailSamples = sharedWolfGeometries.tailSamples;
    const tailFurCount = 420;
    const tailFurInstanced = new THREE.InstancedMesh(
      sharedWolfGeometries.hairStrandGeo,
      wolfPBRAssets.furStrandMat,
      tailFurCount
    );
    for (let t = 0; t < tailFurCount; t++) {
      const ts = tailSamples[(t * 7) % tailSamples.length];
      dummy.position.set(ts.x, ts.y, ts.z);
      dirVec.set(ts.nx * 0.75, ts.ny - 0.45, ts.nz - 0.65).normalize();
      dummy.quaternion.setFromUnitVectors(upVec, dirVec);
      const sc = 1.15 + Math.sin(ts.s * Math.PI) * 0.45;
      dummy.scale.set(1.2, sc, 1.2);
      dummy.updateMatrix();
      tailFurInstanced.setMatrixAt(t, dummy.matrix);
      clumpColor.setHex(ts.s > 0.78 ? 0x14181e : (t % 2 === 0 ? 0x424a54 : 0x8e96a0));
      tailFurInstanced.setColorAt(t, clumpColor);
    }
    tailFurInstanced.instanceMatrix.needsUpdate = true;
    if (tailFurInstanced.instanceColor) tailFurInstanced.instanceColor.needsUpdate = true;
    tailFurInstanced.castShadow = false;
    tailFurInstanced.layers.set(1);
    tailFurInstanced.computeBoundingSphere();
    bodyFurInstanced.computeBoundingSphere();
    tailPivot.add(tailFurInstanced);
    root.add(tailPivot);

    // 6. Four Two-Jointed Anatomical Digitigrade Legs (Muscular Upper Limb + Stifle/Elbow + Angled Hock/Carpus + 4-Toed Clawed Paw)
    const legs = [];
    const legSpecs = [
      { lx: -0.175, lz:  0.34, isHind: false },
      { lx:  0.175, lz:  0.34, isHind: false },
      { lx: -0.180, lz: -0.38, isHind: true  },
      { lx:  0.180, lz: -0.38, isHind: true  }
    ];

    const digitGeo = new THREE.SphereGeometry(0.022, 8, 8);
    digitGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(digitGeo.attributes.position.count).fill(0.03), 1));

    legSpecs.forEach(({ lx, lz, isHind }) => {
      const hipPivot = new THREE.Group();
      hipPivot.position.set(lx, isHind ? 0.58 : 0.56, lz);

      // Sculpted Upper Thigh (Femur/Quadriceps) or Upper Arm (Humerus/Triceps)
      const upperGeo = new THREE.CylinderGeometry(isHind ? 0.098 : 0.082, 0.054, 0.30, 12, 4);
      upperGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(upperGeo.attributes.position.count).fill(0.04), 1));
      const upperLimb = new THREE.Mesh(upperGeo, wolfPBRAssets.skinMat);
      upperLimb.position.set(0, -0.13, isHind ? -0.02 : 0.01);
      upperLimb.rotation.x = isHind ? 0.22 : -0.14;
      upperLimb.castShadow = true;
      hipPivot.add(upperLimb);

      // Stifle/Knee or Elbow Joint Pivot
      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -0.26, isHind ? -0.04 : 0.02);

      const lowerGeo = new THREE.CylinderGeometry(0.050, 0.036, 0.25, 10, 3);
      lowerGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(lowerGeo.attributes.position.count).fill(0.04), 1));
      const lowerLimb = new THREE.Mesh(lowerGeo, wolfPBRAssets.skinMat);
      lowerLimb.position.set(0, -0.11, isHind ? -0.03 : 0.01);
      lowerLimb.rotation.x = isHind ? -0.28 : 0.08;
      lowerLimb.castShadow = true;
      kneePivot.add(lowerLimb);

      // Digitigrade Metatarsus / Pastern + 4-Toed Paw with Curved Keratin Claws
      const pawGroup = new THREE.Group();
      pawGroup.position.set(0, -0.24, isHind ? -0.02 : 0.03);
      for (let toe = -1.5; toe <= 1.5; toe += 1.0) {
        const digit = new THREE.Mesh(
          digitGeo,
          wolfPBRAssets.skinMat
        );
        digit.scale.set(0.85, 0.72, 1.45);
        digit.position.set(toe * 0.022, -0.01, 0.025 - Math.abs(toe) * 0.008);
        pawGroup.add(digit);

        const claw = new THREE.Mesh(
          new THREE.ConeGeometry(0.006, 0.026, 6),
          wolfPBRAssets.rhinariumMat
        );
        claw.rotation.x = Math.PI / 2 + 0.35;
        claw.position.set(toe * 0.022, -0.014, 0.055 - Math.abs(toe) * 0.008);
        pawGroup.add(claw);
      }
      kneePivot.add(pawGroup);

      hipPivot.add(kneePivot);
      hipPivot.userData.knee = kneePivot;
      root.add(hipPivot);
      legs.push(hipPivot);
    });

    // Disable CPU raycasting on high-poly musculature & 2,820 instanced hair blades, and attach fast 12-triangle hit-proxy
    root.traverse(child => {
      if (child.isMesh || child.isInstancedMesh) {
        child.raycast = () => {};
      }
    });
    const hitProxy = new THREE.Mesh(_wildlifeHitProxyGeo, _wildlifeHitProxyMat);
    root.add(hitProxy);

    root.userData = {
      type: 'wildlife',
      species: 'wolf',
      health: 3,
      promptLabel: 'Strike Ridge Stalker Wolf [Tap Strike]',
      headPivot,
      tailPivot,
      legs,
      furMeshes: [bodyFurInstanced, tailFurInstanced]
    };

    wildlifeGroup.add(root);
    registerInteractiveTarget(root);

    wildlifeAgents.push({
      species: 'wolf',
      mesh: root,
      homeX: x,
      homeZ: z,
      yaw: Math.random() * Math.PI * 2,
      speed: 3.3,
      timer: Math.random() * 6,
      attackCooldown: 0
    });
  }

  // 9A-2. AAA PROCEDURAL WILD ISLAND BOAR (Spline-Lofted Razorback Musculature, 1,260 GPU-Instanced Dorsal Bristles,
  //       Scarred Hide Normal/Displacement Maps, Anisotropic + SSS Shaders, Curved Ivory Tusks & Cloven Hooves)
  let sharedBoarAssets = null;
  function buildSharedBoarAssets() {
    const boarSkinMat = new THREE.MeshStandardMaterial({
      color: 0x362216,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(1.75, 1.75),
      displacementMap: wolfPBRAssets.dispTex,
      displacementScale: 0.014,
      displacementBias: -0.007,
      roughness: 0.68,
      metalness: 0.06
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(boarSkinMat, false);

    const boarBristleMat = new THREE.MeshStandardMaterial({
      color: 0x1e120b,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughness: 0.52,
      metalness: 0.08,
      side: THREE.DoubleSide
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(boarBristleMat, true);

    // High-Poly Spline-Lofted Razorback Torso & Massive Shoulder Hump (32 axial stations x 24 radial segments)
    const stations = [
      { z: -0.58, y: 0.50, rx: 0.08, ry: 0.10 }, // Tail root
      { z: -0.46, y: 0.54, rx: 0.22, ry: 0.24 }, // Croup / rump
      { z: -0.28, y: 0.57, rx: 0.28, ry: 0.28 }, // Pelvis & loin
      { z: -0.05, y: 0.60, rx: 0.33, ry: 0.33 }, // Barrel abdomen
      { z:  0.18, y: 0.64, rx: 0.36, ry: 0.38 }, // Deep ribcage & massive razorback shoulder hump
      { z:  0.38, y: 0.65, rx: 0.33, ry: 0.36 }, // Scapula / neck base
      { z:  0.54, y: 0.63, rx: 0.24, ry: 0.26 }, // Thick muscular neck
      { z:  0.64, y: 0.62, rx: 0.17, ry: 0.19 }  // Head atlas joint
    ];
    const axialSteps = 32;
    const radialSegs = 24;
    const pos = [];
    const uvs = [];
    const sss = [];
    const idx = [];
    const bristleSamples = [];

    function sampleBoarSpine(t) {
      const scaled = t * (stations.length - 1);
      const i0 = Math.min(stations.length - 2, Math.floor(scaled));
      const f = scaled - i0;
      const sm = f * f * (3.0 - 2.0 * f);
      const a = stations[i0], b = stations[i0 + 1];
      return {
        z: a.z + (b.z - a.z) * sm,
        y: a.y + (b.y - a.y) * sm,
        rx: a.rx + (b.rx - a.rx) * sm,
        ry: a.ry + (b.ry - a.ry) * sm
      };
    }

    for (let i = 0; i <= axialSteps; i++) {
      const v = i / axialSteps;
      const sp = sampleBoarSpine(v);
      for (let j = 0; j <= radialSegs; j++) {
        const u = j / radialSegs;
        const ang = u * Math.PI * 2.0;
        const sinA = Math.sin(ang);
        const cosA = Math.cos(ang);
        // Pronounced razorback dorsal spine crest at cosA > 0.65
        const razorCrest = cosA > 0.55 ? Math.pow((cosA - 0.55) / 0.45, 1.5) * 0.065 * Math.sin(v * Math.PI) : 0.0;
        const flankMuscles = Math.sin(v * Math.PI * 3.0) * 0.015 * Math.abs(sinA);
        const x = sinA * (sp.rx + flankMuscles);
        const y = sp.y + cosA * sp.ry + razorCrest;
        const z = sp.z;
        pos.push(x, y, z);
        uvs.push(u * 2.5, v * 3.0);
        sss.push(0.04);

        if (i >= 2 && i <= axialSteps - 2 && j < radialSegs && cosA > -0.35) {
          bristleSamples.push({ x, y, z, nx: sinA, ny: cosA, nz: -0.32, isSpine: cosA > 0.68, v });
        }
      }
    }
    const stride = radialSegs + 1;
    for (let i = 0; i < axialSteps; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = (i + 1) * stride + j;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const torsoGeo = new THREE.BufferGeometry();
    torsoGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    torsoGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    torsoGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sss, 1));
    torsoGeo.setIndex(idx);
    torsoGeo.computeVertexNormals();

    // Sculpted Wedge-Shaped Boar Cranium & Long Rooting Snout Geometry (20 axial x 18 radial)
    const hSteps = 20, hSegs = 18;
    const hPos = [], hUvs = [], hSss = [], hIdx = [];
    for (let i = 0; i <= hSteps; i++) {
      const v = i / hSteps;
      const z = -0.10 + v * 0.54; // -0.10 occiput to +0.44 nasal disc
      const w = v < 0.45 ? (0.18 - v * 0.10) : (0.135 - (v - 0.45) * 0.04);
      const h = v < 0.45 ? (0.17 - v * 0.12) : (0.115 - (v - 0.45) * 0.03);
      const yOff = -v * 0.045;
      for (let j = 0; j <= hSegs; j++) {
        const u = j / hSegs;
        const ang = u * Math.PI * 2.0;
        const sinA = Math.sin(ang), cosA = Math.cos(ang);
        const tuskFlange = (v > 0.55 && v < 0.85 && Math.abs(sinA) > 0.6) ? 0.028 : 0.0;
        hPos.push(sinA * (w + tuskFlange), yOff + cosA * h, z);
        hUvs.push(u * 1.5, v * 1.8);
        hSss.push(0.06);
      }
    }
    const hStride = hSegs + 1;
    for (let i = 0; i < hSteps; i++) {
      for (let j = 0; j < hSegs; j++) {
        const a = i * hStride + j, b = a + 1, c = (i + 1) * hStride + j, d = c + 1;
        hIdx.push(a, b, c, b, d, c);
      }
    }
    const headGeo = new THREE.BufferGeometry();
    headGeo.setAttribute('position', new THREE.Float32BufferAttribute(hPos, 3));
    headGeo.setAttribute('uv', new THREE.Float32BufferAttribute(hUvs, 2));
    headGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(hSss, 1));
    headGeo.setIndex(hIdx);
    headGeo.computeVertexNormals();

    sharedBoarAssets = { boarSkinMat, boarBristleMat, torsoGeo, headGeo, bristleSamples };
    return sharedBoarAssets;
  }

  function createQuadruped(species, x, z) {
    if (species === 'wolf') {
      createAAAProceduralWolf(x, z);
      return;
    }

    const root = new THREE.Group();
    const y = getTerrainHeight(x, z);
    root.position.set(x, y, z);

    // 1. Soft Grounded Contact Shadow
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.45, 1.85),
      wolfPBRAssets.contactShadowMat
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, 0.02, 0.04);
    root.add(contactShadow);

    // 2. High-Poly Spline-Lofted Razorback Torso & Muscular Shoulder Hump
    const torsoMesh = new THREE.Mesh(sharedBoarAssets.torsoGeo, sharedBoarAssets.boarSkinMat);
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    root.add(torsoMesh);

    // 3. 1,260 GPU-Instanced Coarse Razorback Bristles & Coat Guard Hairs (InstancedMesh)
    const bSamples = sharedBoarAssets.bristleSamples;
    const bristleCount = 1260;
    const instBristles = new THREE.InstancedMesh(
      sharedWolfGeometries.hairStrandGeo,
      sharedBoarAssets.boarBristleMat,
      bristleCount
    );
    instBristles.castShadow = true;
    const dummy = new THREE.Object3D();
    const upVec = new THREE.Vector3(0, 1, 0);
    const dirVec = new THREE.Vector3();
    const bCol = new THREE.Color();
    let bSeed = Math.floor(Math.abs(x * 197 + z * 311)) + 11;
    function bRand() {
      bSeed = (bSeed * 1664525 + 1013904223) >>> 0;
      return bSeed / 4294967296;
    }

    for (let i = 0; i < bristleCount; i++) {
      const s = bSamples[(i * 11 + Math.floor(bRand() * 17)) % bSamples.length];
      dummy.position.set(
        s.x + (bRand() - 0.5) * 0.015,
        s.y + (bRand() - 0.5) * 0.015,
        s.z + (bRand() - 0.5) * 0.022
      );
      if (s.isSpine) {
        // Stiff upright razorback dorsal mane crest
        dirVec.set((bRand() - 0.5) * 0.15, 0.92, -0.38).normalize();
        dummy.scale.set(1.25, 1.55 + Math.sin(s.v * Math.PI) * 0.65, 1.25);
        bCol.setHex(i % 3 === 0 ? 0x140b06 : 0x2c1910);
      } else {
        dirVec.set(s.nx * 0.62, s.ny * 0.35 - 0.25, -0.72).normalize();
        dummy.scale.set(1.0, 0.92 + bRand() * 0.35, 1.0);
        bCol.setHex(i % 2 === 0 ? 0x3b2416 : 0x523422);
      }
      dummy.quaternion.setFromUnitVectors(upVec, dirVec);
      dummy.updateMatrix();
      instBristles.setMatrixAt(i, dummy.matrix);
      instBristles.setColorAt(i, bCol);
    }
    instBristles.instanceMatrix.needsUpdate = true;
    if (instBristles.instanceColor) instBristles.instanceColor.needsUpdate = true;
    instBristles.castShadow = false;
    instBristles.layers.set(1);
    instBristles.computeBoundingSphere();
    root.add(instBristles);

    // 4. Sculpted Wedge Head, Wet Pink Rooting Nasal Disc, Curved Ivory Tusks & SSS Ears
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.62, 0.60);

    const headMesh = new THREE.Mesh(sharedBoarAssets.headGeo, sharedBoarAssets.boarSkinMat);
    headMesh.castShadow = true;
    headPivot.add(headMesh);

    const nasalDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.105, 0.045, 16),
      new THREE.MeshStandardMaterial({ color: 0x3b2622, roughness: 0.22, metalness: 0.12 })
    );
    nasalDisc.rotation.x = Math.PI / 2 + 0.12;
    nasalDisc.position.set(0, -0.045, 0.44);
    headPivot.add(nasalDisc);

    [-0.032, 0.032].forEach(nx => {
      const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), matEyeDark);
      nostril.scale.set(0.8, 1.2, 0.6);
      nostril.position.set(nx, -0.042, 0.462);
      headPivot.add(nostril);
    });

    // Deep-set Amber/Dark Boar Eyes + Brow Ridges
    [-0.105, 0.105].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 10), matEyeDark);
      eye.position.set(ex, 0.045, 0.12);
      headPivot.add(eye);
    });

    // Cartilaginous Fringed Boar Ears with SSS
    [-0.12, 0.12].forEach(ex => {
      const ear = new THREE.Mesh(sharedWolfGeometries.earGeo, sharedBoarAssets.boarSkinMat);
      ear.scale.set(1.15, 0.92, 1.1);
      ear.position.set(ex, 0.11, -0.02);
      ear.rotation.set(0.28, 0, ex > 0 ? -0.48 : 0.48);
      headPivot.add(ear);
    });

    // Swept Curved Upper & Lower Ivory Tusks (Cutters & Whetters)
    [-0.105, 0.105].forEach(tx => {
      const mainTusk = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.22, 10), matIvory);
      mainTusk.position.set(tx, -0.02, 0.30);
      mainTusk.rotation.set(0.38, 0, tx > 0 ? -0.32 : 0.32);
      headPivot.add(mainTusk);

      const upperWhetter = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.12, 8), matIvory);
      upperWhetter.position.set(tx * 1.08, -0.04, 0.25);
      upperWhetter.rotation.set(0.20, 0, tx > 0 ? -0.58 : 0.58);
      headPivot.add(upperWhetter);
    });
    root.add(headPivot);

    // 5. Articulated Tufted Tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.52, -0.56);
    const tailShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.010, 0.26, 8), sharedBoarAssets.boarSkinMat);
    tailShaft.rotation.x = -0.45;
    tailShaft.position.set(0, -0.11, -0.06);
    const tailTuft = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.12, 8), sharedBoarAssets.boarBristleMat);
    tailTuft.rotation.x = Math.PI - 0.45;
    tailTuft.position.set(0, -0.24, -0.12);
    tailPivot.add(tailShaft, tailTuft);
    root.add(tailPivot);

    // 6. Four Two-Jointed Articulated Legs with Cloven Hooves
    const legs = [];
    const legSpecs = [
      [-0.18, 0.34, false], [0.18, 0.34, false],
      [-0.18, -0.36, true], [0.18, -0.36, true]
    ];
    legSpecs.forEach(([lx, lz, isHind]) => {
      const hipPivot = new THREE.Group();
      hipPivot.position.set(lx, 0.48, lz);

      const upperGeo = new THREE.CylinderGeometry(isHind ? 0.095 : 0.085, 0.056, 0.26, 12);
      upperGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(upperGeo.attributes.position.count).fill(0.02), 1));
      const upperLimb = new THREE.Mesh(upperGeo, sharedBoarAssets.boarSkinMat);
      upperLimb.position.y = -0.12;
      upperLimb.castShadow = true;
      hipPivot.add(upperLimb);

      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -0.24, 0);

      const lowerGeo = new THREE.CylinderGeometry(0.052, 0.038, 0.22, 10);
      lowerGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(lowerGeo.attributes.position.count).fill(0.02), 1));
      const lowerLimb = new THREE.Mesh(lowerGeo, sharedBoarAssets.boarSkinMat);
      lowerLimb.position.y = -0.10;
      kneePivot.add(lowerLimb);

      // Split Cloven Hoof (2 Keratin Toes)
      [-0.018, 0.018].forEach(hx => {
        const hoof = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.065, 6), wolfPBRAssets.rhinariumMat);
        hoof.position.set(hx, -0.22, 0.022);
        hoof.rotation.x = 0.25;
        kneePivot.add(hoof);
      });

      hipPivot.add(kneePivot);
      hipPivot.userData.knee = kneePivot;
      root.add(hipPivot);
      legs.push(hipPivot);
    });

    root.traverse(child => {
      if (child.isMesh || child.isInstancedMesh) child.raycast = () => {};
    });
    root.add(new THREE.Mesh(_wildlifeHitProxyGeo, _wildlifeHitProxyMat));

    root.userData = {
      type: 'wildlife',
      species,
      health: 2,
      promptLabel: 'Hunt Wild Island Boar [Tap Strike]',
      headPivot,
      tailPivot,
      legs,
      furMeshes: [instBristles]
    };

    wildlifeGroup.add(root);
    registerInteractiveTarget(root);

    wildlifeAgents.push({
      species,
      mesh: root,
      homeX: x,
      homeZ: z,
      yaw: Math.random() * Math.PI * 2,
      speed: 2.1,
      timer: Math.random() * 6,
      attackCooldown: 0
    });
  }

  async function spawnBoarsAndWolvesAsync() {
    // Wild Boars forage along Elderwood glades, S-Meandering River point bars (48, 178), and Spring T2/T4 banks
    const boarCoords = [[-32, 18], [-48, 36], [-62, -16], [18, 52], [48, 178], [26, -34], [-50, 142]];
    for (let i = 0; i < boarCoords.length; i++) {
      createQuadruped('boar', boarCoords[i][0], boarCoords[i][1]);
      if (i % 2 === 1) await yieldFrame();
    }
    const wolfCoords = [[38, 82], [62, 74], [-28, 96], [-94, 178], [-25, 31]];
    for (let i = 0; i < wolfCoords.length; i++) {
      createQuadruped('wolf', wolfCoords[i][0], wolfCoords[i][1]);
      await yieldFrame();
    }
  }

  // ============================================================================
  // 9B. AAA SHORELINE COCONUT CRABS (Tuberculated Chitin Carapace Normal/Displacement,
  //     Wet Specular Sheen, Serrated Cheliped Pincers & Multi-Jointed Walking Legs)
  // ============================================================================
  let sharedCrabAssets = null;
  function buildSharedCrabAssets() {
    // Sculpted Branchiostegal Carapace with Swollen Gill Chambers & Transverse Ridges
    const carapaceGeo = new THREE.SphereGeometry(0.25, 24, 20);
    const cPos = carapaceGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
      const vx = cPos.getX(i), vy = cPos.getY(i), vz = cPos.getZ(i);
      const branchialSwell = (vz < 0.05 && Math.abs(vx) > 0.08) ? 1.28 : 1.0;
      const ridges = 1.0 + Math.sin(vz * 26.0) * 0.045 + Math.cos(vx * 22.0) * 0.035;
      cPos.setXYZ(i, vx * 1.28 * branchialSwell * ridges, vy * 0.54 * ridges, vz * 1.08 * ridges);
    }
    carapaceGeo.computeVertexNormals();

    const crabChitinMat = new THREE.MeshStandardMaterial({
      color: 0xb8381e,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(1.45, 1.45),
      roughness: 0.16, // Wet shoreline calcified shell sheen
      metalness: 0.24
    });

    const crabUnderMat = new THREE.MeshStandardMaterial({
      color: 0xe08e58,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.28,
      metalness: 0.12
    });

    const crabHitProxyGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.65, 8);
    crabHitProxyGeo.translate(0, 0.22, 0);

    sharedCrabAssets = { carapaceGeo, crabChitinMat, crabUnderMat, crabHitProxyGeo };
    return sharedCrabAssets;
  }

  function spawnCrabs() {
    for (let c = 0; c < 10; c++) {
      const cx = -35 + c * 8.5;
      const cz = -28 - (c % 4) * 6.5;
      const cy = getTerrainHeight(cx, cz);
      if (cy < -0.5 || cy > 2.8) continue;

      const crab = new THREE.Group();
      crab.position.set(cx, cy + 0.14, cz);

    // 1. Sculpted Branchiostegal Carapace & Tucked Segmented Abdomen Tergetes
    const carapace = new THREE.Mesh(sharedCrabAssets.carapaceGeo, sharedCrabAssets.crabChitinMat);
    carapace.castShadow = true;
    carapace.receiveShadow = true;
    crab.add(carapace);

    for (let ab = 0; ab < 3; ab++) {
      const plate = new THREE.Mesh(
        new THREE.SphereGeometry(0.18 - ab * 0.03, 14, 10),
        sharedCrabAssets.crabUnderMat
      );
      plate.scale.set(1.2, 0.42, 0.65);
      plate.position.set(0, -0.04 - ab * 0.02, -0.22 - ab * 0.06);
      crab.add(plate);
    }

    // 2. Pedunculate Eye Stalks, Rostral Spine & Sensory Antennules
    [-0.075, 0.075].forEach(ex => {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.09, 8), sharedCrabAssets.crabUnderMat);
      stalk.position.set(ex, 0.09, 0.22);
      stalk.rotation.x = 0.35;
      const cornea = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 10), matEyeDark);
      cornea.position.set(ex, 0.13, 0.24);
      crab.add(stalk, cornea);
    });

    // 3. Two Heavy Asymmetric Serrated Cheliped Pincers (Merus + Carpus + Propodus Palm + Dactylus Movable Finger + White Tooth Tubercles)
    const claws = [];
    [-0.22, 0.22].forEach((cxOff, cIdx) => {
      const isCrusher = (cIdx === 0);
      const sc = isCrusher ? 1.16 : 0.96;
      const clawPivot = new THREE.Group();
      clawPivot.position.set(cxOff, 0.02, 0.18);

      const merus = new THREE.Mesh(new THREE.CylinderGeometry(0.046 * sc, 0.036 * sc, 0.18, 12), sharedCrabAssets.crabChitinMat);
      merus.rotation.x = Math.PI / 2;
      merus.rotation.z = cxOff > 0 ? -0.35 : 0.35;
      merus.position.set(cxOff * 0.25, 0, 0.08);
      clawPivot.add(merus);

      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.068 * sc, 14, 12), sharedCrabAssets.crabChitinMat);
      palm.scale.set(0.85, 0.72, 1.55);
      palm.position.set(cxOff * 0.35, -0.01, 0.20);
      clawPivot.add(palm);

      const fixedFinger = new THREE.Mesh(new THREE.ConeGeometry(0.038 * sc, 0.16, 10), sharedCrabAssets.crabChitinMat);
      fixedFinger.rotation.x = Math.PI / 2;
      fixedFinger.position.set(cxOff * 0.28, -0.02, 0.31);
      clawPivot.add(fixedFinger);

      const movableDactyl = new THREE.Mesh(new THREE.ConeGeometry(0.032 * sc, 0.15, 10), sharedCrabAssets.crabUnderMat);
      movableDactyl.rotation.x = Math.PI / 2 + 0.18;
      movableDactyl.position.set(cxOff * 0.42, 0.01, 0.30);
      clawPivot.add(movableDactyl);

      // White calcified crushing teeth along inner pincer edge
      for (let t = 0; t < 3; t++) {
        const tooth = new THREE.Mesh(new THREE.SphereGeometry(0.012 * sc, 6, 6), matIvory);
        tooth.position.set(cxOff * 0.34, -0.005, 0.26 + t * 0.03);
        clawPivot.add(tooth);
      }

      crab.add(clawPivot);
      claws.push(clawPivot);
    });

    // 4. Six Multi-Jointed Walking Legs (Merus + Carpus/Propodus + Dark Keratin Dactylus Tip)
    const crabLegs = [];
    for (let l = 0; l < 6; l++) {
      const side = (l < 3) ? -1 : 1;
      const zIdx = (l % 3) - 1;
      const legGroup = new THREE.Group();
      legGroup.position.set(side * 0.22, 0.01, zIdx * 0.12);

      const upperSeg = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.020, 0.18, 10), sharedCrabAssets.crabChitinMat);
      upperSeg.rotation.z = side * 1.15;
      upperSeg.position.set(side * 0.08, 0.03, 0);
      legGroup.add(upperSeg);

      const lowerSeg = new THREE.Mesh(new THREE.ConeGeometry(0.020, 0.22, 10), sharedCrabAssets.crabUnderMat);
      lowerSeg.rotation.z = side * 2.55;
      lowerSeg.position.set(side * 0.21, -0.06, 0);
      legGroup.add(lowerSeg);

      crab.add(legGroup);
      crabLegs.push(legGroup);
    }

    crab.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
    crab.add(new THREE.Mesh(sharedCrabAssets.crabHitProxyGeo, _wildlifeHitProxyMat));

    crab.userData = {
      type: 'wildlife',
      species: 'crab',
      health: 1,
      promptLabel: 'Catch Shoreline Coconut Crab [Tap Strike]',
      claws,
      crabLegs
    };
    wildlifeGroup.add(crab);
    registerInteractiveTarget(crab);
      wildlifeAgents.push({
        species: 'crab',
        mesh: crab,
        homeX: cx,
        homeZ: cz,
        yaw: c * 1.1,
        speed: 1.15,
        timer: c,
        attackCooldown: 0
      });
    }
  }

  // ============================================================================
  // 9C. AAA TROPICAL LAGOON FISH (24-Station Spline-Lofted Hydrodynamic Fusiform Body,
  //     Thin-Film Iridescent Scale GLSL Shader & Translucent Rayed Fins)
  // ============================================================================
  let sharedFishAssets = null;
  function buildSharedFishAssets() {
    // 1. Procedural Overlapping Cycloid Fish Scale Normal Map (256x256)
    const scSize = 256;
    const scH = document.createElement('canvas');
    scH.width = scSize; scH.height = scSize;
    const shCtx = scH.getContext('2d');
    shCtx.fillStyle = '#808080';
    shCtx.fillRect(0, 0, scSize, scSize);
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const cx = (col + (row % 2) * 0.5) * 16;
        const cy = row * 16;
        const g = shCtx.createRadialGradient(cx, cy, 2, cx, cy, 12);
        g.addColorStop(0.0, '#ffffff');
        g.addColorStop(0.75, '#707070');
        g.addColorStop(1.0, '#202020');
        shCtx.fillStyle = g;
        shCtx.beginPath();
        shCtx.arc(cx, cy, 11, 0, Math.PI * 2);
        shCtx.fill();
      }
    }
    const scaleNormTex = new THREE.CanvasTexture(scH);
    scaleNormTex.wrapS = scaleNormTex.wrapT = THREE.RepeatWrapping;

    // 2. Thin-Film Iridescent Scale Material (Turquoise <-> Emerald <-> Sunlit Gold + Swimming Wave)
    const iridescentFishMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      normalMap: scaleNormTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.12,
      metalness: 0.78
    });
    iridescentFishMat.onBeforeCompile = function (shader) {
      shader.uniforms.uFurTime = wolfShaderUniforms.uFurTime;
      shader.vertexShader = `
        uniform float uFurTime;
        varying vec3 vFishWorldPos;
      ` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        // Smooth hydrodynamic S-wave swimming undulation along spine (-Z)
        float tailFactor = clamp((0.28 - position.z) / 0.68, 0.0, 1.0);
        transformed.x += sin(uFurTime * 11.0 - position.z * 9.5) * 0.045 * tailFactor * tailFactor;
        `
      ).replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vFishWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );
      shader.fragmentShader = `
        varying vec3 vFishWorldPos;
      ` + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        vec3 viewDir = normalize(cameraPosition - vFishWorldPos);
        float ndv = clamp( abs(dot(normal, viewDir)), 0.0, 1.0 );
        vec3 colTurquoise = vec3(0.00, 0.90, 1.00);
        vec3 colEmerald   = vec3(0.11, 0.91, 0.71);
        vec3 colGold      = vec3(1.00, 0.84, 0.25);
        vec3 irid = mix(colGold, colEmerald, smoothstep(0.15, 0.55, ndv));
        irid = mix(irid, colTurquoise, smoothstep(0.55, 0.92, ndv));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, irid * (0.65 + 0.55 * ndv), 0.62);
        #include <dithering_fragment>
        `
      );
    };

    const rayedFinMat = new THREE.MeshStandardMaterial({
      color: 0x84ffff,
      emissive: 0x00838f,
      emissiveIntensity: 0.35,
      roughness: 0.24,
      metalness: 0.25,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide
    });

    // 3. 24-Station x 18-Segment Spline-Lofted Hydrodynamic Fusiform Fish Body
    const fSteps = 24, fSegs = 18;
    const fPos = [], fUvs = [], fIdx = [];
    for (let i = 0; i <= fSteps; i++) {
      const v = i / fSteps;
      const z = 0.34 - v * 0.72; // +0.34 nose to -0.38 caudal peduncle
      const profile = Math.sin(Math.pow(v, 0.68) * Math.PI);
      const rx = 0.115 * profile + (v > 0.82 ? 0.018 : 0.0);
      const ry = 0.215 * profile + (v > 0.82 ? 0.025 : 0.0);
      for (let j = 0; j <= fSegs; j++) {
        const u = j / fSegs;
        const ang = u * Math.PI * 2.0;
        fPos.push(Math.sin(ang) * rx, Math.cos(ang) * ry, z);
        fUvs.push(u * 4.0, v * 6.0);
      }
    }
    const fStride = fSegs + 1;
    for (let i = 0; i < fSteps; i++) {
      for (let j = 0; j < fSegs; j++) {
        const a = i * fStride + j, b = a + 1, c = (i + 1) * fStride + j, d = c + 1;
        fIdx.push(a, b, c, b, d, c);
      }
    }
    const fishBodyGeo = new THREE.BufferGeometry();
    fishBodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3));
    fishBodyGeo.setAttribute('uv', new THREE.Float32BufferAttribute(fUvs, 2));
    fishBodyGeo.setIndex(fIdx);
    fishBodyGeo.computeVertexNormals();

    const fishHitProxyGeo = new THREE.SphereGeometry(0.45, 8, 6);

    // 4. Procedural 512x512 Fish Anatomy Albedo Texture (Countershaded Metallic Scales, Lateral Stripe, Gill Arch, Eye & Fin Rays)
    const faCanvas = document.createElement('canvas');
    faCanvas.width = 512; faCanvas.height = 512;
    const faCtx = faCanvas.getContext('2d');
    const bodyGrad = faCtx.createLinearGradient(0, 0, 512, 0);
    bodyGrad.addColorStop(0.0, '#1e4d6b');
    bodyGrad.addColorStop(0.26, '#3a88a8');
    bodyGrad.addColorStop(0.32, '#ffd54f');
    bodyGrad.addColorStop(0.48, '#b2ebf2');
    bodyGrad.addColorStop(0.54, '#ffd54f');
    bodyGrad.addColorStop(0.74, '#3a88a8');
    bodyGrad.addColorStop(1.0, '#1e4d6b');
    faCtx.fillStyle = bodyGrad;
    faCtx.fillRect(0, 0, 512, 512);

    // Vertical tropical reef bars & shimmering scale diamond lattice
    faCtx.fillStyle = 'rgba(18, 42, 64, 0.24)';
    for (let b = 80; b < 420; b += 48) {
      faCtx.fillRect(0, b, 512, 16);
    }
    faCtx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    faCtx.lineWidth = 1.4;
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        const sx = (c + (r % 2) * 0.5) * 22;
        const sy = r * 22;
        faCtx.beginPath();
        faCtx.arc(sx, sy, 10, 0, Math.PI);
        faCtx.stroke();
      }
    }
    // Gill operculum crescent & bilateral eyes near head (v ~ 0.14)
    [128, 384].forEach(ex => {
      faCtx.strokeStyle = 'rgba(15, 35, 50, 0.65)';
      faCtx.lineWidth = 4.0;
      faCtx.beginPath();
      faCtx.arc(ex, 92, 26, 0.2, Math.PI - 0.2);
      faCtx.stroke();

      faCtx.fillStyle = '#ffb300';
      faCtx.beginPath();
      faCtx.arc(ex, 64, 15, 0, Math.PI * 2);
      faCtx.fill();
      faCtx.fillStyle = '#0d1117';
      faCtx.beginPath();
      faCtx.arc(ex, 62, 8.5, 0, Math.PI * 2);
      faCtx.fill();
      faCtx.fillStyle = '#ffffff';
      faCtx.beginPath();
      faCtx.arc(ex - 3, 59, 3.0, 0, Math.PI * 2);
      faCtx.fill();
    });
    const fishAnatomyTex = new THREE.CanvasTexture(faCanvas);
    fishAnatomyTex.wrapS = fishAnatomyTex.wrapT = THREE.RepeatWrapping;

    // 5. Welded Multi-Part 3D Schooling Fish Geometry (Fusiform Body + Spiny Dorsal + Forked Lunate Caudal Tail + Pectoral & Anal Fins + 3D Eyes)
    function createCompleteSchoolFishGeometry(lenScale = 1.0, heightScale = 1.0, widthScale = 1.0) {
      const pos = [];
      const uvs = [];
      const idx = [];
      let vOff = 0;

      function appendMeshPart(partGeo, ox, oy, oz, rx, ry, rz, sx, sy, sz, uvScale = 1.0) {
        const g = partGeo.clone();
        const m4 = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
        m4.compose(new THREE.Vector3(ox, oy, oz), q, new THREE.Vector3(sx, sy, sz));
        g.applyMatrix4(m4);
        const pAttr = g.attributes.position;
        const uAttr = g.attributes.uv;
        for (let i = 0; i < pAttr.count; i++) {
          pos.push(pAttr.getX(i) * widthScale, pAttr.getY(i) * heightScale, pAttr.getZ(i) * lenScale);
          if (uAttr) {
            uvs.push(uAttr.getX(i) * uvScale, uAttr.getY(i) * uvScale);
          } else {
            uvs.push(0.5, 0.5);
          }
        }
        if (g.index) {
          const iArr = g.index.array;
          for (let i = 0; i < iArr.length; i++) idx.push(vOff + iArr[i]);
        } else {
          for (let i = 0; i < pAttr.count; i++) idx.push(vOff + i);
        }
        vOff += pAttr.count;
        g.dispose();
      }

      // A. 18-Station x 12-Segment Hydrodynamic Fusiform Body (+0.34 nose to -0.38 tail peduncle)
      const bSteps = 18, bSegs = 12;
      for (let i = 0; i <= bSteps; i++) {
        const v = i / bSteps;
        const z = (0.34 - v * 0.72) * lenScale;
        const prof = Math.sin(Math.pow(v, 0.68) * Math.PI);
        const rx = (0.105 * prof + (v > 0.82 ? 0.016 : 0.0)) * widthScale;
        const ry = (0.195 * prof + (v > 0.82 ? 0.022 : 0.0)) * heightScale;
        for (let j = 0; j <= bSegs; j++) {
          const u = j / bSegs;
          const ang = u * Math.PI * 2.0;
          pos.push(Math.sin(ang) * rx, Math.cos(ang) * ry, z);
          uvs.push(u, v);
        }
      }
      const bStride = bSegs + 1;
      for (let i = 0; i < bSteps; i++) {
        for (let j = 0; j < bSegs; j++) {
          const a = i * bStride + j, b = a + 1, c = (i + 1) * bStride + j, d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
      vOff = (bSteps + 1) * (bSegs + 1);

      const finCone = new THREE.ConeGeometry(0.08, 0.28, 4);
      const eyeSphere = new THREE.SphereGeometry(0.026, 6, 6);

      // B. Swept Dorsal Fin
      appendMeshPart(finCone, 0, 0.19, -0.04, -0.62, 0, 0, 0.20, 1.0, 1.35, 0.5);
      // C. Ventral Anal Fin
      appendMeshPart(finCone, 0, -0.15, -0.14, -Math.PI + 0.58, 0, 0, 0.18, 0.75, 1.05, 0.5);
      // D. Forked Lunate Caudal Tail Fin (Upper + Lower Swept Lobes)
      appendMeshPart(finCone, 0, 0.10, -0.46, -Math.PI / 2 + 0.48, 0, 0, 0.18, 1.05, 1.15, 0.5);
      appendMeshPart(finCone, 0, -0.10, -0.46, -Math.PI / 2 - 0.48, 0, 0, 0.18, 1.05, 1.15, 0.5);
      // E. Paired Swept Pectoral Fins
      appendMeshPart(finCone, -0.095, -0.03, 0.08, -0.35, 0, 1.15, 0.16, 0.72, 0.95, 0.5);
      appendMeshPart(finCone,  0.095, -0.03, 0.08, -0.35, 0, -1.15, 0.16, 0.72, 0.95, 0.5);
      // F. Bilateral 3D Eyes
      appendMeshPart(eyeSphere, -0.072, 0.035, 0.21, 0, 0, 0, 0.85, 1.0, 1.1, 0.2);
      appendMeshPart(eyeSphere,  0.072, 0.035, 0.21, 0, 0, 0, 0.85, 1.0, 1.1, 0.2);

      finCone.dispose();
      eyeSphere.dispose();

      const outGeo = new THREE.BufferGeometry();
      outGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      outGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      outGeo.setIndex(idx);
      outGeo.computeVertexNormals();
      return outGeo;
    }

    function injectSchoolFishSwimShader(mat, freq = 12.5, amp = 0.055) {
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uFurTime = wolfShaderUniforms.uFurTime;
        shader.vertexShader = `uniform float uFurTime;\n` + shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float instPhase = 0.0;
          #ifdef USE_INSTANCING
            instPhase = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.9;
          #endif
          float tailFactor = clamp((0.26 - position.z) / 0.72, 0.0, 1.25);
          transformed.x += sin(uFurTime * ${freq.toFixed(1)} - position.z * 8.5 + instPhase) * ${amp.toFixed(4)} * tailFactor * tailFactor;
          `
        );
      };
    }

    sharedFishAssets = {
      iridescentFishMat,
      rayedFinMat,
      fishBodyGeo,
      fishHitProxyGeo,
      scaleNormTex,
      fishAnatomyTex,
      createCompleteSchoolFishGeometry,
      injectSchoolFishSwimShader
    };
    return sharedFishAssets;
  }

  const fishAgents = [];
  function spawnFish() {
    // Lagoon & Estuary schools + Waterfall Plunge-Pool Trout (C1: 21.5, 2.0; C2: -14.5, 124.0) + Multi-Lobe Lakes (L1, L2, L3) & S-Meander River (R2)
    const fishCoords = [
      [2, 12], [5, 22], [-2, 4], [-6, -12], [-14, -28], [8, 30], [-4, -22], [12, 18],
      // C1 East Gorge Waterfall Plunge Scour Pool (-4.4m)
      [21.5, 2.0], [18.5, 3.2],
      // C2 Headwaters Waterfall Plunge Scour Pool (-4.6m)
      [-14.5, 124.0], [-16.2, 121.5],
      // L1 Cliff-Top Tarn (+33.6m), L2 Headwaters Lake (+26.6m), L3 Windward Valley Lagoon (+6.8m) & R2 Meander Bend
      [114, 2], [122, 4], [-18, 198], [-22, 208], [86, 212], [92, 218], [46, 179]
    ];
    fishCoords.forEach(([fx, fz], idx) => {
      const w = getWaterInfo(fx, fz, 0);
      const fy = (w.isWater ? w.surfaceY : 0.0) - 0.85 - (idx % 3) * 0.45;
      const fGroup = new THREE.Group();
      fGroup.position.set(fx, fy, fz);

      const body = new THREE.Mesh(sharedFishAssets.fishBodyGeo, sharedFishAssets.iridescentFishMat);
      fGroup.add(body);

      // Golden-Rimmed Eyes
      [-0.075, 0.075].forEach(ex => {
        const eyeRing = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), matEyeAmber);
        eyeRing.position.set(ex, 0.035, 0.21);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 8), matEyeDark);
        pupil.position.set(ex * 1.12, 0.035, 0.218);
        fGroup.add(eyeRing, pupil);
      });

      // Swept Spiny Dorsal & Ventral Anal Fins
      const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 5), sharedFishAssets.rayedFinMat);
      dorsal.scale.set(0.22, 1.0, 1.45);
      dorsal.position.set(0, 0.22, -0.04);
      dorsal.rotation.x = -0.58;
      fGroup.add(dorsal);

      const analFin = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.20, 4), sharedFishAssets.rayedFinMat);
      analFin.scale.set(0.22, 1.0, 1.2);
      analFin.position.set(0, -0.18, -0.14);
      analFin.rotation.x = -Math.PI + 0.55;
      fGroup.add(analFin);

      [-0.105, 0.105].forEach(px => {
        const pec = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.18, 4), sharedFishAssets.rayedFinMat);
        pec.scale.set(0.2, 1.0, 1.1);
        pec.position.set(px, -0.03, 0.08);
        pec.rotation.set(-0.35, 0, px > 0 ? -1.15 : 1.15);
        fGroup.add(pec);
      });

      // Deeply Forked Lunate Caudal Tail Fin (Upper + Lower Lobes)
      const tail = new THREE.Group();
      tail.position.z = -0.36;
      [1, -1].forEach(lobe => {
        const lobeMesh = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.28, 4), sharedFishAssets.rayedFinMat);
        lobeMesh.scale.set(0.22, 1.0, 1.2);
        lobeMesh.position.set(0, lobe * 0.09, -0.10);
        lobeMesh.rotation.x = -Math.PI / 2 + lobe * 0.48;
        tail.add(lobeMesh);
      });
      fGroup.add(tail);

      fGroup.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
      fGroup.add(new THREE.Mesh(sharedFishAssets.fishHitProxyGeo, _wildlifeHitProxyMat));

      fGroup.userData = {
        type: 'fish',
        health: 1,
        promptLabel: 'Spear Lagoon Fish (+1 Raw Fish) [Tap Strike]',
        tail
      };
      wildlifeGroup.add(fGroup);
      registerInteractiveTarget(fGroup);
      fishAgents.push({ mesh: fGroup, cx: fx, cz: fz, baseY: fy, ang: idx * 0.9, rad: 2.2 + (idx % 4) * 1.1 });
    });
  }

  // ============================================================================
  // 9C-2. OPEN-OCEAN PATROLLING SHARKS (Articulated Fusiform Body, 512px Dermal/Gill PBR,
  //       Sinusoidal Swim Wave Kinematics & 3-Beat Patrol / Circle / Lunge Predator AI)
  // ============================================================================
  const sharkAgents = [];
  let sharedSharkAssets = null;

  function buildSharedSharkAssets() {
    if (sharedSharkAssets) return sharedSharkAssets;

    // Procedural 512x512 Countershaded Shark Skin + 5 Gill Slits + Dermal Texture
    const size = 512;
    const skinCanvas = document.createElement('canvas');
    skinCanvas.width = size;
    skinCanvas.height = size;
    const ctx = skinCanvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0.00, '#20313d'); // Dorsal slate-steel blue
    grad.addColorStop(0.44, '#364b59');
    grad.addColorStop(0.56, '#798b96'); // Crisp lateral countershading line
    grad.addColorStop(0.66, '#d3dbdf'); // Pale off-white ventral belly
    grad.addColorStop(1.00, '#dfe5e8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Subtle placoid dermal denticle grain & old ocean battle scars
    for (let i = 0; i < 3200; i++) {
      const px = Math.random() * size;
      const py = Math.random() * size;
      ctx.fillStyle = (i % 2 === 0) ? 'rgba(18, 28, 36, 0.14)' : 'rgba(235, 244, 248, 0.12)';
      ctx.fillRect(px, py, 2, 1);
    }
    // 5 curved gill slits on lateral flanks (painted near anterior u = 0.25..0.38)
    ctx.strokeStyle = 'rgba(14, 20, 26, 0.78)';
    ctx.lineWidth = 4.0;
    for (let g = 0; g < 5; g++) {
      const gx = size * (0.24 + g * 0.026);
      ctx.beginPath();
      ctx.moveTo(gx, size * 0.34);
      ctx.quadraticCurveTo(gx - 8, size * 0.46, gx + 2, size * 0.57);
      ctx.stroke();
    }

    const sharkSkinTex = new THREE.CanvasTexture(skinCanvas);
    sharkSkinTex.wrapS = sharkSkinTex.wrapT = THREE.RepeatWrapping;

    const sharkSkinMat = new THREE.MeshStandardMaterial({
      map: sharkSkinTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.28,
      metalness: 0.14,
      envMap: window.skyEnvCubeTex || null,
      envMapIntensity: 0.85
    });
    const sharkFinMat = new THREE.MeshStandardMaterial({
      color: 0x263744,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.34,
      metalness: 0.12
    });
    const sharkJawMat = new THREE.MeshStandardMaterial({
      color: 0xc29898,
      roughness: 0.32,
      metalness: 0.05
    });

    // Build 3 articulated spine sections (Head/Snout, Torso, Peduncle) via fusiform lofting
    function loftSharkSection(zStart, zEnd, rFn) {
      const aSteps = 14, rSegs = 18;
      const pos = [], uvs = [], idx = [];
      for (let i = 0; i <= aSteps; i++) {
        const t = i / aSteps;
        const z = zStart + (zEnd - zStart) * t;
        const { rx, ry, cy } = rFn(t);
        for (let j = 0; j <= rSegs; j++) {
          const u = j / rSegs;
          const ang = u * Math.PI * 2.0; // ang=0 top dorsal -> PI ventral -> 2PI top
          pos.push(Math.sin(ang) * rx, cy + Math.cos(ang) * ry, z);
          uvs.push(t, (Math.cos(ang) * -0.5 + 0.5));
        }
      }
      const stride = rSegs + 1;
      for (let i = 0; i < aSteps; i++) {
        for (let j = 0; j < rSegs; j++) {
          const a = i * stride + j, b = a + 1, c = (i + 1) * stride + j, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    }

    // Anterior Head/Snout (+0.0 .. +1.25 forward in local Head pivot)
    const headGeo = loftSharkSection(0.0, 1.25, t => {
      const k = 1.0 - t;
      return {
        rx: 0.34 * Math.pow(k, 0.52) + 0.025,
        ry: 0.36 * Math.pow(k, 0.58) + 0.02,
        cy: 0.02 * (1.0 - t)
      };
    });
    // Mid-Body Torso (-0.55 .. +0.62)
    const torsoGeo = loftSharkSection(-0.58, 0.62, t => {
      const bulge = Math.sin(Math.pow(t, 0.72) * Math.PI * 0.78 + 0.32);
      return {
        rx: 0.22 + bulge * 0.16,
        ry: 0.24 + bulge * 0.18,
        cy: 0.0
      };
    });
    // Rear Tail Peduncle (0.0 .. -0.95 local tail pivot)
    const peduncleGeo = loftSharkSection(0.0, -0.95, t => {
      const taper = Math.max(0.18, 1.0 - t * 0.82);
      return {
        rx: 0.24 * taper,
        ry: 0.26 * taper,
        cy: 0.0
      };
    });

    const sharkHitProxyGeo = new THREE.CylinderGeometry(0.95, 0.95, 3.6, 8);
    sharkHitProxyGeo.rotateX(Math.PI / 2);

    sharedSharkAssets = {
      sharkSkinMat, sharkFinMat, sharkJawMat,
      headGeo, torsoGeo, peduncleGeo, sharkHitProxyGeo
    };
    return sharedSharkAssets;
  }

  function spawnSharks() {
    const assets = buildSharedSharkAssets();
    // Patrol the trench rings around the 3 outer strongholds + outer archipelago sea channels (strictly clear of Swim-Safe Reef Cay at (-342, 224))
    const patrolAnchors = [
      { x: 780, z: -730, rad: 70, name: 'Magma Bastion Trench Shark' },
      { x: 900, z: -760, rad: 54, name: 'Magma Bastion Trench Shark' }
    ];

    patrolAnchors.forEach((anch, idx) => {
      const root = new THREE.Group();
      const w = getWaterInfo(anch.x, anch.z, 0);
      const baseDepth = (w.isWater ? w.surfaceY : 0.05) - 0.55;
      root.position.set(anch.x, baseDepth, anch.z);

      // 1. Torso Spine Root + Swept Tall Dorsal Fin
      const torso = new THREE.Mesh(assets.torsoGeo, assets.sharkSkinMat);
      torso.castShadow = true;
      root.add(torso);

      const dorsalShape = new THREE.Shape();
      dorsalShape.moveTo(0.0, 0.0);
      dorsalShape.quadraticCurveTo(0.14, 0.42, -0.34, 0.62);
      dorsalShape.quadraticCurveTo(-0.22, 0.28, -0.38, 0.0);
      dorsalShape.lineTo(0.0, 0.0);
      const dorsalGeo = new THREE.ExtrudeGeometry(dorsalShape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.01, bevelSegments: 2 });
      dorsalGeo.translate(0, 0, -0.02);
      dorsalGeo.rotateY(Math.PI / 2);
      const dorsalFin = new THREE.Mesh(dorsalGeo, assets.sharkFinMat);
      dorsalFin.position.set(0, 0.34, 0.24);
      root.add(dorsalFin);

      // Paired Articulating Pectoral Fins (bank into turns)
      const pecShape = new THREE.Shape();
      pecShape.moveTo(0, 0);
      pecShape.lineTo(0.68, -0.36);
      pecShape.quadraticCurveTo(0.32, -0.44, 0.0, -0.22);
      pecShape.lineTo(0, 0);
      const pecGeo = new THREE.ExtrudeGeometry(pecShape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 });
      pecGeo.rotateX(Math.PI / 2);

      const pecLeft = new THREE.Group();
      pecLeft.position.set(-0.30, -0.14, 0.32);
      const pecLeftMesh = new THREE.Mesh(pecGeo, assets.sharkFinMat);
      pecLeftMesh.scale.x = -1;
      pecLeft.add(pecLeftMesh);
      root.add(pecLeft);

      const pecRight = new THREE.Group();
      pecRight.position.set(0.30, -0.14, 0.32);
      pecRight.add(new THREE.Mesh(pecGeo, assets.sharkFinMat));
      root.add(pecRight);

      // 2. Articulated Head + Hinged Jaw & White Sawtooth Teeth
      const headPivot = new THREE.Group();
      headPivot.position.set(0, 0, 0.56);
      headPivot.add(new THREE.Mesh(assets.headGeo, assets.sharkSkinMat));
      [-0.22, 0.22].forEach(ex => {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 8), matEyeDark);
        eye.position.set(ex, 0.05, 0.62);
        headPivot.add(eye);
      });
      const jawPivot = new THREE.Group();
      jawPivot.position.set(0, -0.14, 0.36);
      const lowerJaw = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.44, 10), assets.sharkJawMat);
      lowerJaw.scale.set(1.0, 1.0, 0.45);
      lowerJaw.rotation.x = Math.PI / 2;
      lowerJaw.position.set(0, -0.02, 0.22);
      jawPivot.add(lowerJaw);
      for (let t = -3; t <= 3; t++) {
        const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.052, 4), matIvory);
        tooth.position.set(t * 0.042, 0.02, 0.38 - Math.abs(t) * 0.035);
        jawPivot.add(tooth);
      }
      headPivot.add(jawPivot);
      root.add(headPivot);

      // 3. Articulated Tail Peduncle + Crescent Heterocercal Caudal Fin
      const tailPivot = new THREE.Group();
      tailPivot.position.set(0, 0, -0.52);
      tailPivot.add(new THREE.Mesh(assets.peduncleGeo, assets.sharkSkinMat));

      // Small rear pelvic & second dorsal fins
      [-0.14, 0.14].forEach(px => {
        const pelvic = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 5), assets.sharkFinMat);
        pelvic.scale.set(0.25, 1.0, 1.2);
        pelvic.position.set(px, -0.16, -0.35);
        pelvic.rotation.set(-Math.PI * 0.72, 0, px > 0 ? 0.6 : -0.6);
        tailPivot.add(pelvic);
      });

      const caudalPivot = new THREE.Group();
      caudalPivot.position.set(0, 0, -0.88);
      const upperCaudal = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.88, 6), assets.sharkFinMat);
      upperCaudal.scale.set(0.22, 1.0, 1.25);
      upperCaudal.position.set(0, 0.28, -0.26);
      upperCaudal.rotation.x = -0.68;
      const lowerCaudal = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.56, 6), assets.sharkFinMat);
      lowerCaudal.scale.set(0.22, 1.0, 1.15);
      lowerCaudal.position.set(0, -0.19, -0.20);
      lowerCaudal.rotation.x = -Math.PI + 0.62;
      caudalPivot.add(upperCaudal, lowerCaudal);
      tailPivot.add(caudalPivot);
      root.add(tailPivot);

      root.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
      root.add(new THREE.Mesh(assets.sharkHitProxyGeo, _wildlifeHitProxyMat));

      const ag = {
        species: 'shark',
        isShark: true,
        mesh: root,
        homeX: anch.x,
        homeZ: anch.z,
        patrolRad: anch.rad,
        yaw: idx * 1.15,
        prevYaw: idx * 1.15,
        speed: 2.9,
        baseSpeed: 2.9,
        state: 'patrol', // 'patrol' | 'circle' | 'lunge' | 'recover' | 'flee'
        stateTimer: 0,
        orbitAng: idx * 1.05,
        circleDir: (idx % 2 === 0) ? 1 : -1,
        warned: false,
        hp: 5,
        maxHp: 5,
        isDead: false,
        swimPhase: idx * 1.7,
        headPivot,
        jawPivot,
        tailPivot,
        caudalPivot,
        pecLeft,
        pecRight
      };

      root.userData = {
        type: 'wildlife',
        species: 'shark',
        health: 5,
        agentRef: ag,
        promptLabel: `Repel / Hunt ${anch.name} [Tap Strike]`
      };
      wildlifeGroup.add(root);
      registerInteractiveTarget(root);
      sharkAgents.push(ag);
    });
    window.sharkAgents = sharkAgents;
  }

  // ============================================================================
  // 9C-3. INSTANCED UNDERWATER BOID SCHOOLS (ANCHOVIES, DAMSELFISH), REEF SNAPPERS & STINGRAYS
  // ============================================================================
  const fishBoidGroups = [];
  const stingrayAgents = [];
  const snapperAgents = [];

  function buildInstancedUnderwaterSchoolsAndRays() {
    if (!sharedFishAssets) buildSharedFishAssets();

    // Ensure every underwater school, reef snapper, and stingray is placed in true deep water (never on islands or in the sky!)
    function resolveDeepWaterPoint(cx, cz, minBedY = -2.8) {
      let h = getTerrainHeight(cx, cz);
      if (h <= minBedY) return { x: cx, z: cz, bedY: h };
      for (let rad = 12; rad <= 140; rad += 12) {
        for (let a = 0; a < 16; a++) {
          const ang = (a * Math.PI * 2) / 16;
          const tx = cx + Math.cos(ang) * rad;
          const tz = cz + Math.sin(ang) * rad;
          const th = getTerrainHeight(tx, tz);
          if (th <= minBedY) {
            return { x: tx, z: tz, bedY: th };
          }
        }
      }
      return { x: -18, z: -48, bedY: getTerrainHeight(-18, -48) };
    }

    // 1. Anchovy & Sardine Baitballs (360 multi-finned silver fish with scales, eyes & undulating forked tails)
    const anchGeo = sharedFishAssets.createCompleteSchoolFishGeometry(0.62, 0.52, 0.48);
    const anchMat = new THREE.MeshStandardMaterial({
      color: 0xd8f0ff,
      map: sharedFishAssets.fishAnatomyTex,
      normalMap: sharedFishAssets.scaleNormTex,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.16,
      metalness: 0.78
    });
    sharedFishAssets.injectSchoolFishSwimShader(anchMat, 14.5, 0.048);
    const anchCount = 360;
    const anchInst = new THREE.InstancedMesh(anchGeo, anchMat, anchCount);
    anchInst.frustumCulled = false;
    anchInst.layers.set(1);
    scene.add(anchInst);

    const baitCenters = [
      { x: -16,  z: -32,  y: -1.8 },
      { x: -328, z: 222,  y: -1.6 },
      { x: -302, z: 224,  y: -1.6 },
      { x: -245, z: 195,  y: -4.5 },
      { x: 590,  z: 430,  y: -2.4 },
      { x: 640,  z: 400,  y: -4.8 },
      { x: -500, z: 340,  y: -4.2 },
      { x: -410, z: 360,  y: -5.6 },
      { x: -150, z: -170, y: -4.2 },
      { x: -60,  z: -210, y: -5.0 }
    ].map(c => {
      const pt = resolveDeepWaterPoint(c.x, c.z, -2.6);
      return { x: pt.x, z: pt.z, y: c.y, bedY: pt.bedY };
    });

    const anchBoids = [];
    for (let i = 0; i < anchCount; i++) {
      const c = baitCenters[i % baitCenters.length];
      const ang = (i * 0.72) % (Math.PI * 2);
      const r = 1.4 + (i % 8) * 0.55;
      const bx = c.x + Math.cos(ang) * r;
      const bz = c.z + Math.sin(ang) * r;
      const floorY = getTerrainHeight(bx, bz);
      // Strictly clamp underwater (<= -0.95m) so no fish ever spawns in the air
      const safeY = Math.min(-0.95, Math.max(floorY + 0.85, c.y));
      anchBoids.push({
        cx: c.x, cz: c.z, baseY: safeY,
        x: bx,
        y: Math.min(-0.85, safeY + ((i % 5) - 2) * 0.22),
        z: bz,
        vx: -Math.sin(ang) * 2.2,
        vy: 0,
        vz: Math.cos(ang) * 2.2,
        phase: i * 0.37
      });
    }
    fishBoidGroups.push({ mesh: anchInst, boids: anchBoids, speed: 2.5, radius: 6.5, scatterScale: 1.8 });

    // 2. Reef Damselfish, Chromis & Butterflyfish (300 detailed multi-fin coral-reef fish with scales, eyes & undulating tails)
    const damselGeo = sharedFishAssets.createCompleteSchoolFishGeometry(0.68, 0.88, 0.56);
    const damselMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: sharedFishAssets.fishAnatomyTex,
      normalMap: sharedFishAssets.scaleNormTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.20,
      metalness: 0.48
    });
    sharedFishAssets.injectSchoolFishSwimShader(damselMat, 13.0, 0.052);
    const damselCount = 300;
    const damselInst = new THREE.InstancedMesh(damselGeo, damselMat, damselCount);
    damselInst.frustumCulled = false;
    damselInst.layers.set(1);
    const damselColors = [
      new THREE.Color(0x2898b5), // Reef Turquoise-Blue
      new THREE.Color(0xd19a34), // Amber-Gold Damselfish
      new THREE.Color(0x3a9478), // Sea-Jade Chromis
      new THREE.Color(0xc96c4c), // Terracotta Anthias
      new THREE.Color(0xe0b842), // Sunlit Lemon Butterflyfish
      new THREE.Color(0x4b7bc9)  // Cobalt Reef Tang
    ];
    const coralCenters = [
      { x: -24,  z: -46,  y: -1.6 },
      { x: -348, z: 234,  y: -1.6 },
      { x: 468,  z: 274,  y: -2.6 },
      { x: -115, z: -168, y: -3.8 },
      { x: 112,  z: -178, y: -4.2 },
      { x: -195, z: -112, y: -3.6 },
      { x: 215,  z: -124, y: -4.1 },
      { x: -312, z: 216,  y: -1.6 },
      { x: -268, z: 242,  y: -2.8 },
      { x: 312,  z: 228,  y: -5.2 },
      { x: 398,  z: 282,  y: -4.6 },
      { x: -345, z: -215, y: -6.2 },
      { x: 335,  z: -195, y: -5.8 },
      { x: -415, z: 125,  y: -5.5 },
      { x: -75,  z: 275,  y: -4.8 },
      { x: 95,   z: 285,  y: -5.0 }
    ].map(c => {
      const pt = resolveDeepWaterPoint(c.x, c.z, -2.5);
      return { x: pt.x, z: pt.z, y: c.y, bedY: pt.bedY };
    });

    const damselBoids = [];
    for (let i = 0; i < damselCount; i++) {
      const c = coralCenters[i % coralCenters.length];
      const ang = (i * 0.91) % (Math.PI * 2);
      const r = 1.8 + (i % 7) * 0.72;
      const bx = c.x + Math.cos(ang) * r;
      const bz = c.z + Math.sin(ang) * r;
      const floorY = getTerrainHeight(bx, bz);
      const safeY = Math.min(-0.95, Math.max(floorY + 0.85, c.y));
      damselBoids.push({
        cx: c.x, cz: c.z, baseY: safeY,
        x: bx,
        y: Math.min(-0.85, safeY + ((i % 4) - 1.5) * 0.22),
        z: bz,
        vx: -Math.sin(ang) * 1.5,
        vy: 0,
        vz: Math.cos(ang) * 1.5,
        phase: i * 0.51
      });
      damselInst.setColorAt(i, damselColors[i % damselColors.length]);
    }
    if (damselInst.instanceColor) damselInst.instanceColor.needsUpdate = true;
    scene.add(damselInst);
    fishBoidGroups.push({ mesh: damselInst, boids: damselBoids, speed: 1.7, radius: 7.5, scatterScale: 1.45 });

    // 2B. Deep-Channel Pelagic Trevally & Tuna Cruisers (140 sculpted multi-fin silver-cobalt gamefish patrolling deep channels)
    const pelGeo = sharedFishAssets.createCompleteSchoolFishGeometry(1.18, 0.95, 0.86);
    const pelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: sharedFishAssets.fishAnatomyTex,
      normalMap: sharedFishAssets.scaleNormTex,
      normalScale: new THREE.Vector2(0.90, 0.90),
      roughness: 0.16,
      metalness: 0.76
    });
    sharedFishAssets.injectSchoolFishSwimShader(pelMat, 11.5, 0.065);
    const pelagicCount = 140;
    const pelInst = new THREE.InstancedMesh(pelGeo, pelMat, pelagicCount);
    pelInst.frustumCulled = false;
    pelInst.layers.set(1);
    const pelColors = [
      new THREE.Color(0x8ab4d4), // Silver-Cobalt Trevally
      new THREE.Color(0x6e9bc2), // Deep Channel Bluefin
      new THREE.Color(0x9ec4c8)  // Teal-Silver Mackerel
    ];
    const pelagicCenters = [
      { x: -135, z: -195, y: -7.5 },
      { x: 145,  z: -205, y: -8.2 },
      { x: -245, z: -165, y: -9.0 },
      { x: 255,  z: -175, y: -8.8 },
      { x: -275, z: 165,  y: -6.5 },
      { x: 335,  z: 215,  y: -8.5 },
      { x: -385, z: -85,  y: -10.5 },
      { x: 395,  z: -75,  y: -10.2 },
      { x: -185, z: 325,  y: -9.4 },
      { x: 195,  z: 335,  y: -9.2 },
      { x: -465, z: 285,  y: -11.5 },
      { x: 485,  z: -285, y: -12.0 },
      { x: 0,    z: -165, y: -7.8 },
      { x: 415,  z: 295,  y: -4.2 }
    ].map(c => {
      const pt = resolveDeepWaterPoint(c.x, c.z, -3.8);
      return { x: pt.x, z: pt.z, y: c.y, bedY: pt.bedY };
    });

    const pelBoids = [];
    for (let i = 0; i < pelagicCount; i++) {
      const c = pelagicCenters[i % pelagicCenters.length];
      const ang = (i * 0.64) % (Math.PI * 2);
      const r = 3.2 + (i % 6) * 1.35;
      const bx = c.x + Math.cos(ang) * r;
      const bz = c.z + Math.sin(ang) * r;
      const floorY = getTerrainHeight(bx, bz);
      const safeY = Math.min(-1.25, Math.max(floorY + 1.1, c.y));
      pelBoids.push({
        cx: c.x, cz: c.z, baseY: safeY,
        x: bx,
        y: Math.min(-1.05, safeY + ((i % 5) - 2) * 0.38),
        z: bz,
        vx: -Math.sin(ang) * 3.1,
        vy: 0,
        vz: Math.cos(ang) * 3.1,
        phase: i * 0.43
      });
      pelInst.setColorAt(i, pelColors[i % pelColors.length]);
    }
    if (pelInst.instanceColor) pelInst.instanceColor.needsUpdate = true;
    scene.add(pelInst);
    fishBoidGroups.push({ mesh: pelInst, boids: pelBoids, speed: 3.1, radius: 11.5, scatterScale: 1.65 });
    window.fishSchools = fishBoidGroups;

    // 3. Striped Reef Snappers (36 articulated multi-fin coral reef hunters with eyes, dorsal/pectoral/anal fins & forked tail — spearable!)
    const snapperMat = new THREE.MeshStandardMaterial({
      color: 0xe58a68,
      map: sharedFishAssets.fishAnatomyTex,
      normalMap: sharedFishAssets.scaleNormTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.22,
      metalness: 0.46
    });
    const snapperLocations = [
      [-18, -36], [-34, -52], [28, -42], [-334, 212], [-346, 238], [590, 430], [624, 408], [-448, 350],
      [6, 18], [-42, -96], [-448, 386], [575, 420], [-288, 224],
      // Inter-Island Reef & Channel Snappers
      [-92, -148], [88, -158], [-172, -124], [192, -138], [-312, 228], [-254, 206], [284, 196], [368, 252],
      [-310, -242], [305, -228], [-392, 62], [384, 48], [-152, 282], [156, 298], [-224, -186], [234, -192],
      [-368, 178], [422, 288], [-128, -212], [134, -218]
    ];
    snapperLocations.forEach(([rawX, rawZ], idx) => {
      const pt = resolveDeepWaterPoint(rawX, rawZ, -2.2);
      const sx = pt.x, sz = pt.z;
      const sy = Math.min(-0.95, Math.max(pt.bedY + 0.75, -2.4));
      const sg = new THREE.Group();
      sg.position.set(sx, sy, sz);
      const sBody = new THREE.Mesh(sharedFishAssets.fishBodyGeo, snapperMat);
      sBody.scale.set(1.25, 1.35, 1.35);
      sg.add(sBody);

      [-0.09, 0.09].forEach(ex => {
        const eyeRing = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), matEyeAmber);
        eyeRing.position.set(ex, 0.045, 0.28);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), matEyeDark);
        pupil.position.set(ex * 1.12, 0.045, 0.29);
        sg.add(eyeRing, pupil);
      });

      const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.38, 5), sharedFishAssets.rayedFinMat);
      dorsal.scale.set(0.22, 1.0, 1.45);
      dorsal.position.set(0, 0.28, -0.05);
      dorsal.rotation.x = -0.58;
      sg.add(dorsal);

      const analFin = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 4), sharedFishAssets.rayedFinMat);
      analFin.scale.set(0.22, 1.0, 1.2);
      analFin.position.set(0, -0.22, -0.18);
      analFin.rotation.x = -Math.PI + 0.55;
      sg.add(analFin);

      [-0.13, 0.13].forEach(px => {
        const pec = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 4), sharedFishAssets.rayedFinMat);
        pec.scale.set(0.2, 1.0, 1.1);
        pec.position.set(px, -0.04, 0.10);
        pec.rotation.set(-0.35, 0, px > 0 ? -1.15 : 1.15);
        sg.add(pec);
      });

      const sTail = new THREE.Group();
      sTail.position.z = -0.48;
      [1, -1].forEach(lobe => {
        const lobeMesh = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 4), sharedFishAssets.rayedFinMat);
        lobeMesh.scale.set(0.22, 1.0, 1.2);
        lobeMesh.position.set(0, lobe * 0.11, -0.12);
        lobeMesh.rotation.x = -Math.PI / 2 + lobe * 0.48;
        sTail.add(lobeMesh);
      });
      sg.add(sTail);

      sg.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
      sg.add(new THREE.Mesh(sharedFishAssets.fishHitProxyGeo, _wildlifeHitProxyMat));
      sg.userData = { type: 'fish', health: 1, promptLabel: 'Spear Striped Reef Snapper (+1 Raw Fish) [Tap Strike]', tail: sTail };
      wildlifeGroup.add(sg);
      registerInteractiveTarget(sg);
      snapperAgents.push({ mesh: sg, cx: sx, cz: sz, baseY: sy, ang: idx * 0.8, rad: 3.4 + (idx % 4) * 1.1 });
    });

    // 4. Bottom Stingrays (20 articulated spotted benthic rays gliding strictly across deep sandy seabed channels)
    const rayGeo = new THREE.SphereGeometry(0.65, 16, 10);
    const rPos = rayGeo.attributes.position;
    for (let i = 0; i < rPos.count; i++) {
      const vx = rPos.getX(i), vy = rPos.getY(i), vz = rPos.getZ(i);
      const wingSpan = 1.55 - Math.abs(vz) * 0.65;
      const flat = (vy > 0 ? 0.14 : 0.05) * (1.0 - Math.min(0.85, Math.abs(vx) * 1.15));
      rPos.setXYZ(i, vx * wingSpan, vy * flat, vz * 1.15);
    }
    rayGeo.computeVertexNormals();
    const rayMat = new THREE.MeshStandardMaterial({
      color: 0x5c6873,
      normalMap: sharedFishAssets.scaleNormTex,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.40,
      metalness: 0.14
    });
    rayMat.onBeforeCompile = function (shader) {
      shader.uniforms.uFurTime = wolfShaderUniforms.uFurTime;
      shader.vertexShader = `uniform float uFurTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float wingDist = clamp((abs(position.x) - 0.18) / 0.72, 0.0, 1.0);
        transformed.y += sin(uFurTime * 3.4 - position.z * 3.8) * 0.14 * wingDist * wingDist;
        `
      );
    };

    const raySpots = [
      [-14, -26], [-325, 224], [-352, 218], [590, 418],
      [24, -36], [-62, -104], [-292, 220], [18, 22],
      // Inter-Island Channel Seabed Stingrays
      [-95, -162], [92, -172], [-182, -132], [198, -146],
      [-262, 198], [295, 212], [382, 268], [-325, -235],
      [318, -218], [-395, 85], [-138, 292], [148, 305]
    ];
    raySpots.forEach(([rawX, rawZ], idx) => {
      const pt = resolveDeepWaterPoint(rawX, rawZ, -3.0);
      const rx = pt.x, rz = pt.z;
      const rGroup = new THREE.Group();
      const bedY = Math.min(-1.5, pt.bedY);
      rGroup.position.set(rx, bedY + 0.42, rz);
      const disc = new THREE.Mesh(rayGeo, rayMat);
      rGroup.add(disc);
      [-0.12, 0.12].forEach(ex => {
        const rEye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), matEyeDark);
        rEye.position.set(ex, 0.09, 0.24);
        rGroup.add(rEye);
      });
      const whipTail = new THREE.Mesh(new THREE.ConeGeometry(0.028, 1.05, 6), rayMat);
      whipTail.rotation.x = -Math.PI / 2;
      whipTail.position.set(0, 0.01, -1.02);
      rGroup.add(whipTail);
      rGroup.layers.set(1);
      wildlifeGroup.add(rGroup);
      stingrayAgents.push({ mesh: rGroup, cx: rx, cz: rz, ang: idx * 1.1, rad: 6.5 + (idx % 3) * 2.2, speed: 0.24 });
    });
    window.stingrayAgents = stingrayAgents;
  }

  // ============================================================================
  // 9E. AAA FOREST WILDLIFE — DEER (BUCK & DOE), WILD RABBITS & CLIMBING SQUIRRELS
  // ============================================================================
  let sharedForestWildlifeAssets = null;

  function buildForestWildlifeMaterials() {
    if (sharedForestWildlifeAssets) return sharedForestWildlifeAssets;

    // 1. Procedural Countershaded Deer Coat (Russet Chestnut + Dappled Fawn Spots + White Belly)
    const dCan = document.createElement('canvas');
    dCan.width = 256; dCan.height = 256;
    const dCtx = dCan.getContext('2d');
    const dGrad = dCtx.createLinearGradient(0, 0, 0, 256);
    dGrad.addColorStop(0.00, '#2c160e');
    dGrad.addColorStop(0.42, '#6e4124');
    dGrad.addColorStop(0.72, '#c4a27a');
    dGrad.addColorStop(0.86, '#f4efe4');
    dGrad.addColorStop(1.00, '#fbf7f0');
    dCtx.fillStyle = dGrad;
    dCtx.fillRect(0, 0, 256, 256);
    for (let s = 0; s < 42; s++) {
      dCtx.fillStyle = 'rgba(244, 232, 208, 0.24)';
      dCtx.beginPath();
      dCtx.arc(20 + Math.random() * 216, 40 + Math.random() * 95, 2.2 + Math.random() * 3.0, 0, Math.PI * 2);
      dCtx.fill();
    }
    const deerTex = new THREE.CanvasTexture(dCan);
    deerTex.wrapS = deerTex.wrapT = THREE.RepeatWrapping;

    const deerMat = wolfPBRAssets.injectWolfAnisotropicSSSMaterial(new THREE.MeshStandardMaterial({
      map: deerTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.62,
      metalness: 0.04,
      envMap: window.skyEnvCubeTex || null
    }), false);
    const deerWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf0eadc, roughness: 0.72 });
    const antlerMat = new THREE.MeshStandardMaterial({ color: 0xd2c3a4, roughness: 0.45, metalness: 0.05 });

    // 2. Rabbit Agouti Sandy-Brown Coat
    const rabbitMat = wolfPBRAssets.injectWolfAnisotropicSSSMaterial(new THREE.MeshStandardMaterial({
      color: 0x6a5342,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.78,
      metalness: 0.02
    }), false);

    // 3. Squirrel Auburn Coat
    const squirrelMat = wolfPBRAssets.injectWolfAnisotropicSSSMaterial(new THREE.MeshStandardMaterial({
      color: 0x9b4d24,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.70, 0.70),
      roughness: 0.72,
      metalness: 0.03
    }), false);

    // Spline-Lofted Slender Deer Torso Geometry
    const axial = 26, rad = 18;
    const pos = [], uvs = [], sss = [], idx = [];
    for (let i = 0; i <= axial; i++) {
      const s = i / axial;
      const z = -0.62 + s * 1.24;
      const profile = Math.sin(s * Math.PI * 0.88 + 0.18);
      const rx = 0.14 + profile * 0.12;
      const ry = 0.17 + profile * 0.15;
      const cy = 0.96 + (s > 0.75 ? (s - 0.75) * 0.14 : 0.0);
      for (let j = 0; j <= rad; j++) {
        const u = j / rad;
        const ang = u * Math.PI * 2;
        pos.push(Math.sin(ang) * rx, cy + Math.cos(ang) * ry, z);
        uvs.push(s * 1.8, (Math.cos(ang) * -0.5 + 0.5));
        sss.push(0.05);
      }
    }
    const stride = rad + 1;
    for (let i = 0; i < axial; i++) {
      for (let j = 0; j < rad; j++) {
        const a = i * stride + j, b = a + 1, c = (i + 1) * stride + j, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const deerTorsoGeo = new THREE.BufferGeometry();
    deerTorsoGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    deerTorsoGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    deerTorsoGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(sss, 1));
    deerTorsoGeo.setIndex(idx);
    deerTorsoGeo.computeVertexNormals();

    sharedForestWildlifeAssets = { deerMat, deerWhiteMat, antlerMat, rabbitMat, squirrelMat, deerTorsoGeo };
    return sharedForestWildlifeAssets;
  }

  function createForestDeer(x, z, isBuck = false) {
    const assets = buildForestWildlifeMaterials();
    const root = new THREE.Group();
    const y = getTerrainHeight(x, z);
    root.position.set(x, y, z);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 2.05), wolfPBRAssets.contactShadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    root.add(shadow);

    const torso = new THREE.Mesh(assets.deerTorsoGeo, assets.deerMat);
    torso.castShadow = true;
    root.add(torso);

    // Graceful Slender Neck & Head Assembly
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 1.02, 0.56);
    const neckGeo = new THREE.CylinderGeometry(0.095, 0.145, 0.52, 12);
    neckGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(neckGeo.attributes.position.count).fill(0.06), 1));
    const neckMesh = new THREE.Mesh(neckGeo, assets.deerMat);
    neckMesh.position.set(0, 0.22, 0.08);
    neckMesh.rotation.x = 0.38;
    neckMesh.castShadow = true;
    neckPivot.add(neckMesh);

    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.44, 0.20);
    const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 10), assets.deerMat);
    cranium.scale.set(0.86, 0.92, 1.45);
    headPivot.add(cranium);

    const muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.24, 10), assets.deerMat);
    muzzle.rotation.x = Math.PI / 2 + 0.14;
    muzzle.position.set(0, -0.04, 0.18);
    headPivot.add(muzzle);

    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), wolfPBRAssets.rhinariumMat);
    noseTip.position.set(0, -0.055, 0.29);
    headPivot.add(noseTip);

    [-0.08, 0.08].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), matEyeDark);
      eye.position.set(ex, 0.03, 0.09);
      headPivot.add(eye);
    });

    const ears = [];
    [-0.095, 0.095].forEach(ex => {
      const ear = new THREE.Mesh(sharedWolfGeometries.earGeo, assets.deerMat);
      ear.scale.set(1.25, 1.45, 1.0);
      ear.position.set(ex, 0.09, -0.05);
      ear.rotation.set(0.18, ex > 0 ? -0.35 : 0.35, ex > 0 ? -0.58 : 0.58);
      headPivot.add(ear);
      ears.push(ear);
    });

    if (isBuck) {
      // Branching 4-point Antlers
      [-0.055, 0.055].forEach(ax => {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.022, 0.44, 7), assets.antlerMat);
        beam.position.set(ax * 2.1, 0.24, -0.03);
        beam.rotation.set(-0.22, 0, ax > 0 ? -0.45 : 0.45);
        headPivot.add(beam);

        const browTine = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.17, 6), assets.antlerMat);
        browTine.position.set(ax * 2.2, 0.20, 0.09);
        browTine.rotation.x = 0.55;
        headPivot.add(browTine);

        const crownTine = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.19, 6), assets.antlerMat);
        crownTine.position.set(ax * 3.1, 0.40, -0.06);
        crownTine.rotation.set(0.12, 0, ax > 0 ? -0.25 : 0.25);
        headPivot.add(crownTine);
      });
    }

    neckPivot.add(headPivot);
    root.add(neckPivot);

    // White Underside Tail Flag (flips upright on Alert / Flee)
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.98, -0.60);
    const tailFlag = new THREE.Mesh(new THREE.ConeGeometry(0.072, 0.22, 8), assets.deerWhiteMat);
    tailFlag.rotation.x = Math.PI + 0.35;
    tailFlag.position.set(0, -0.08, -0.04);
    tailPivot.add(tailFlag);
    root.add(tailPivot);

    // 4 Slender Two-Jointed Articulated Legs + Cloven Hooves
    const legs = [];
    const legSpecs = [
      [-0.145, 0.38, false], [0.145, 0.38, false],
      [-0.155, -0.40, true], [0.155, -0.40, true]
    ];
    legSpecs.forEach(([lx, lz, isHind]) => {
      const hipPivot = new THREE.Group();
      hipPivot.position.set(lx, 0.86, lz);
      const upperGeo = new THREE.CylinderGeometry(isHind ? 0.082 : 0.068, 0.042, 0.44, 10);
      upperGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(upperGeo.attributes.position.count).fill(0.03), 1));
      const upper = new THREE.Mesh(upperGeo, assets.deerMat);
      upper.position.y = -0.20;
      upper.rotation.x = isHind ? 0.18 : -0.10;
      upper.castShadow = true;
      hipPivot.add(upper);

      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -0.42, isHind ? -0.04 : 0.02);
      const lowerGeo = new THREE.CylinderGeometry(0.038, 0.026, 0.44, 8);
      lowerGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(lowerGeo.attributes.position.count).fill(0.03), 1));
      const lower = new THREE.Mesh(lowerGeo, assets.deerMat);
      lower.position.y = -0.21;
      lower.castShadow = true;
      kneePivot.add(lower);

      const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.055, 8), wolfPBRAssets.rhinariumMat);
      hoof.position.set(0, -0.43, 0.015);
      kneePivot.add(hoof);

      hipPivot.add(kneePivot);
      hipPivot.userData.knee = kneePivot;
      root.add(hipPivot);
      legs.push(hipPivot);
    });

    root.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
    root.add(new THREE.Mesh(_wildlifeHitProxyGeo, _wildlifeHitProxyMat));

    const ag = {
      species: 'deer',
      subType: isBuck ? 'buck' : 'doe',
      mesh: root,
      homeX: x,
      homeZ: z,
      yaw: Math.random() * Math.PI * 2,
      speed: 2.3,
      timer: 1.5 + Math.random() * 4.5,
      attackCooldown: 0,
      state: 'graze', // 'graze' | 'alert' | 'flee'
      alertTimer: 0,
      fleeTimer: 0,
      hp: isBuck ? 3 : 2,
      maxHp: isBuck ? 3 : 2,
      limpWeight: 0,
      isDead: false,
      ears
    };

    root.userData = {
      type: 'wildlife',
      species: 'deer',
      subType: ag.subType,
      health: ag.hp,
      agentRef: ag,
      promptLabel: `Hunt Forest ${isBuck ? 'Stag Buck' : 'Deer'} [Tap Strike]`,
      neckPivot,
      headPivot,
      tailPivot,
      legs,
      ears
    };

    wildlifeGroup.add(root);
    registerInteractiveTarget(root);
    wildlifeAgents.push(ag);
  }

  function createWildRabbit(x, z) {
    const assets = buildForestWildlifeMaterials();
    const root = new THREE.Group();
    const y = getTerrainHeight(x, z);
    root.position.set(x, y, z);

    const bodyPivot = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 10), assets.rabbitMat);
    body.scale.set(0.88, 0.92, 1.38);
    body.position.set(0, 0.14, 0);
    body.castShadow = true;
    bodyPivot.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), assets.deerWhiteMat);
    belly.scale.set(0.72, 0.42, 1.15);
    belly.position.set(0, 0.06, 0.02);
    bodyPivot.add(belly);

    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.22, 0.18);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.088, 10, 8), assets.rabbitMat);
    head.scale.set(0.92, 0.90, 1.15);
    headPivot.add(head);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), matSnoutPink);
    nose.position.set(0, -0.01, 0.098);
    headPivot.add(nose);
    [-0.055, 0.055].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 6), matEyeDark);
      eye.position.set(ex, 0.025, 0.052);
      headPivot.add(eye);
    });
    const ears = [];
    [-0.042, 0.042].forEach(ex => {
      const ear = new THREE.Mesh(sharedWolfGeometries.earGeo, assets.rabbitMat);
      ear.scale.set(0.62, 1.95, 0.65);
      ear.position.set(ex, 0.075, -0.02);
      ear.rotation.set(-0.22, 0, ex > 0 ? -0.18 : 0.18);
      headPivot.add(ear);
      ears.push(ear);
    });
    bodyPivot.add(headPivot);

    const scutTail = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 8), assets.deerWhiteMat);
    scutTail.position.set(0, 0.14, -0.21);
    bodyPivot.add(scutTail);

    const hindLegs = [];
    [-0.088, 0.088].forEach(hx => {
      const hLeg = new THREE.Mesh(new THREE.SphereGeometry(0.068, 8, 8), assets.rabbitMat);
      hLeg.scale.set(0.65, 0.72, 1.48);
      hLeg.position.set(hx, 0.07, -0.11);
      bodyPivot.add(hLeg);
      hindLegs.push(hLeg);
    });
    root.add(bodyPivot);

    const rHitGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.55, 8);
    rHitGeo.translate(0, 0.25, 0);
    root.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
    root.add(new THREE.Mesh(rHitGeo, _wildlifeHitProxyMat));

    const ag = {
      species: 'rabbit',
      mesh: root,
      homeX: x,
      homeZ: z,
      yaw: Math.random() * Math.PI * 2,
      speed: 2.0,
      timer: Math.random() * 4.0,
      attackCooldown: 0,
      state: 'graze',
      alertTimer: 0,
      fleeTimer: 0,
      zigSign: 1,
      zigTimer: 0,
      hopPhase: Math.random() * Math.PI * 2,
      hp: 1,
      maxHp: 1,
      isDead: false
    };
    root.userData = {
      type: 'wildlife',
      species: 'rabbit',
      health: 1,
      agentRef: ag,
      promptLabel: 'Hunt Wild Island Rabbit [Tap Strike]',
      bodyPivot,
      headPivot,
      ears,
      hindLegs
    };
    wildlifeGroup.add(root);
    registerInteractiveTarget(root);
    wildlifeAgents.push(ag);
  }

  function createTreeSquirrel(x, z) {
    const assets = buildForestWildlifeMaterials();
    const root = new THREE.Group();
    const y = getTerrainHeight(x, z);
    root.position.set(x, y, z);

    const bodyPivot = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 8), assets.squirrelMat);
    body.scale.set(0.84, 0.88, 1.52);
    body.position.set(0, 0.09, 0);
    body.castShadow = true;
    bodyPivot.add(body);

    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.14, 0.14);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.062, 8, 8), assets.squirrelMat);
    head.scale.set(0.92, 0.90, 1.12);
    headPivot.add(head);
    [-0.042, 0.042].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.013, 6, 6), matEyeDark);
      eye.position.set(ex, 0.018, 0.036);
      headPivot.add(eye);
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.042, 5), assets.squirrelMat);
      ear.position.set(ex * 0.85, 0.058, -0.01);
      headPivot.add(ear);
    });
    bodyPivot.add(headPivot);

    // Plush S-Curve Bushy Bottle-Brush Tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.11, -0.12);
    const tSeg1 = new THREE.Mesh(new THREE.SphereGeometry(0.056, 8, 8), assets.squirrelMat);
    tSeg1.scale.set(0.82, 1.75, 0.82);
    tSeg1.position.set(0, 0.09, -0.05);
    tSeg1.rotation.x = -0.35;
    const tSeg2 = new THREE.Mesh(new THREE.SphereGeometry(0.068, 8, 8), assets.squirrelMat);
    tSeg2.scale.set(0.88, 1.85, 0.95);
    tSeg2.position.set(0, 0.22, -0.02);
    tSeg2.rotation.x = 0.42;
    tailPivot.add(tSeg1, tSeg2);
    bodyPivot.add(tailPivot);
    root.add(bodyPivot);

    const sHitGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.48, 8);
    sHitGeo.translate(0, 0.20, 0);
    root.traverse(ch => { if (ch.isMesh) ch.raycast = () => {}; });
    root.add(new THREE.Mesh(sHitGeo, _wildlifeHitProxyMat));

    const ag = {
      species: 'squirrel',
      mesh: root,
      homeX: x,
      homeZ: z,
      yaw: Math.random() * Math.PI * 2,
      speed: 2.8,
      timer: Math.random() * 3.0,
      attackCooldown: 0,
      state: 'graze', // 'graze' | 'flee' | 'climbing' | 'perched'
      climbTree: null,
      climbY: 0,
      climbMaxH: 5.5,
      perchTimer: 0,
      hp: 1,
      maxHp: 1,
      isDead: false
    };
    root.userData = {
      type: 'wildlife',
      species: 'squirrel',
      health: 1,
      agentRef: ag,
      promptLabel: 'Hunt Forest Squirrel [Tap Strike]',
      bodyPivot,
      headPivot,
      tailPivot
    };
    wildlifeGroup.add(root);
    registerInteractiveTarget(root);
    wildlifeAgents.push(ag);
  }

  async function spawnForestWildlifeAsync() {
    // 12 Forest Deer (5 Antlered Bucks + 7 Does across Elderwood, S-Meandering River Point Bars, Windward Lagoon Littoral Shelf & Springs)
    const deerSpecs = [
      { x: -55,  z: 56,  buck: true },
      { x: -64,  z: 62,  buck: false },
      { x: -96,  z: 38,  buck: false },
      { x: -132, z: 76,  buck: true },
      { x: 88,   z: 66,  buck: false }, // Karst Spring T1 glade
      { x: 16,   z: 155, buck: true },  // S-Meander River R2 inner sandy point bar
      { x: 46,   z: 177, buck: false }, // S-Meander River R2 upper point bar
      { x: 74,   z: 198, buck: false }, // Windward Valley Lagoon L3 weir shelf
      { x: 88,   z: 172, buck: true },  // Windward Valley Lagoon L3 north sandy littoral shelf
      { x: 106,  z: 212, buck: false }, // Windward Valley Lagoon L3 east cove
      { x: 498,  z: 299, buck: true },
      { x: -452, z: 392, buck: false }
    ];
    for (let i = 0; i < deerSpecs.length; i++) {
      const d = deerSpecs[i];
      if (getTerrainHeight(d.x, d.z) > 0.35) createForestDeer(d.x, d.z, d.buck);
      if (i % 3 === 2) await yieldFrame();
    }

    // 14 Wild Rabbits across meadows, trails, bamboo border & clearings
    const rabbitCoords = [
      [-30, 32], [-46, 52], [-74, 48], [-108, 66], [-148, 86], [-182, 42], [-58, 12],
      [22, 146], [52, 208], [84, 224], [-18, 165], [-92, -112], [-340, 222], [585, 425]
    ];
    for (let i = 0; i < rabbitCoords.length; i++) {
      const [rx, rz] = rabbitCoords[i];
      if (getTerrainHeight(rx, rz) > 0.9) createWildRabbit(rx, rz);
      if (i % 5 === 4) await yieldFrame();
    }

    // 12 Tree Squirrels anchored near Elderwood & Overlook trees
    const ezList = window.activeEZTrees || [];
    const sqFallback = [
      [-36, 30], [-52, 34], [-66, 60], [-82, 54], [-115, 72], [-145, 58],
      [-172, 84], [-198, 68], [-44, 18], [46, 16], [116, -42], [-26, 36]
    ];
    for (let i = 0; i < 12; i++) {
      let sx = sqFallback[i][0], sz = sqFallback[i][1];
      if (ezList.length > 16) {
        const tPick = ezList[(i * 19 + 7) % ezList.length];
        if (tPick && tPick.position) {
          sx = tPick.position.x + 1.4;
          sz = tPick.position.z + 1.1;
        }
      }
      if (getTerrainHeight(sx, sz) > 1.2) createTreeSquirrel(sx, sz);
    }
    window.wildlifeAgents = wildlifeAgents;
  }

  // ============================================================================
  // 9D. AAA CALDERA SEA EAGLES (Sculpted Raptor Anatomy, Hooked Golden Beak,
  //     2-Stage Cambered Wings & GPU-Instanced Primary/Secondary Flight Feathers)
  // ============================================================================
  let sharedEagleAssets = null;
  function buildSharedEagleAssets() {
    // 1. Sculpted Individual Flight Feather (Remex) Geometry with Central Rachis & Asymmetric Vane
    const featherGeo = new THREE.PlaneGeometry(0.085, 0.42, 3, 6);
    featherGeo.translate(0, 0.21, 0);
    const fPos = featherGeo.attributes.position;
    const fSss = new Float32Array(fPos.count);
    for (let i = 0; i < fPos.count; i++) {
      const vx = fPos.getX(i), vy = fPos.getY(i);
      const h = vy / 0.42;
      const taper = Math.sin(Math.pow(h, 0.65) * Math.PI);
      const camber = Math.sin(h * Math.PI) * 0.018;
      fPos.setXYZ(i, vx * (0.35 + 0.85 * taper), vy, camber);
      fSss[i] = Math.pow(h, 1.2) * 0.85; // Backlit feather tip translucency!
    }
    featherGeo.setAttribute('aSssWeight', new THREE.BufferAttribute(fSss, 1));
    featherGeo.computeVertexNormals();

    const eaglePlumeMat = new THREE.MeshStandardMaterial({
      color: 0x2a1c14,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.46,
      metalness: 0.08,
      side: THREE.DoubleSide
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(eaglePlumeMat, true);

    const eagleBodyMat = new THREE.MeshStandardMaterial({
      color: 0x261810,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.52,
      metalness: 0.06
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(eagleBodyMat, false);

    // Procedural 512x512 Avian Feather Plumage Texture (overlapping contour coverts, rachis shafts & barbules)
    const pCanvas = document.createElement('canvas');
    pCanvas.width = 512; pCanvas.height = 512;
    const pCtx = pCanvas.getContext('2d');
    pCtx.fillStyle = '#d8dce0';
    pCtx.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 16; col++) {
        const fx = (col + (row % 2) * 0.5) * 32;
        const fy = row * 26;
        const fg = pCtx.createRadialGradient(fx, fy, 2, fx, fy + 10, 20);
        fg.addColorStop(0.0, '#ffffff');
        fg.addColorStop(0.7, '#cfd5dc');
        fg.addColorStop(1.0, '#7a828c');
        pCtx.fillStyle = fg;
        pCtx.beginPath();
        pCtx.ellipse(fx, fy, 15, 20, 0, 0, Math.PI * 2);
        pCtx.fill();
        pCtx.strokeStyle = 'rgba(60, 68, 78, 0.35)';
        pCtx.lineWidth = 1.2;
        pCtx.beginPath();
        pCtx.moveTo(fx, fy - 14);
        pCtx.lineTo(fx, fy + 16);
        pCtx.stroke();
      }
    }
    const birdPlumageTex = new THREE.CanvasTexture(pCanvas);
    birdPlumageTex.wrapS = birdPlumageTex.wrapT = THREE.RepeatWrapping;

    eaglePlumeMat.map = birdPlumageTex;
    eagleBodyMat.map = birdPlumageTex;

    const seabirdBodyMat = new THREE.MeshStandardMaterial({
      color: 0xf7f9fc,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.44,
      metalness: 0.05
    });
    const seabirdWingMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.42,
      metalness: 0.06,
      side: THREE.DoubleSide
    });
    const coralBeakMat = new THREE.MeshStandardMaterial({
      color: 0xff6e40,
      roughness: 0.35,
      metalness: 0.10
    });

    const tanagerBodyMat = new THREE.MeshStandardMaterial({
      color: 0xd92626,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.44,
      metalness: 0.05
    });
    const tanagerWingMat = new THREE.MeshStandardMaterial({
      color: 0x1e2229,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.42,
      metalness: 0.08,
      side: THREE.DoubleSide
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(tanagerWingMat, true);
    const tanagerBellyMat = new THREE.MeshStandardMaterial({
      color: 0xef4b3a,
      map: birdPlumageTex,
      roughness: 0.48,
      metalness: 0.04
    });

    const kingfisherBodyMat = new THREE.MeshStandardMaterial({
      color: 0x1d78d8,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.38,
      metalness: 0.12
    });
    const kingfisherWingMat = new THREE.MeshStandardMaterial({
      color: 0x1456a0,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.38,
      metalness: 0.12,
      side: THREE.DoubleSide
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(kingfisherWingMat, true);
    const kingfisherBreastMat = new THREE.MeshStandardMaterial({
      color: 0xd96b27,
      map: birdPlumageTex,
      roughness: 0.46,
      metalness: 0.05
    });

    const doveBodyMat = new THREE.MeshStandardMaterial({
      color: 0x8c766a,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.90, 0.90),
      roughness: 0.48,
      metalness: 0.05
    });
    const doveWingMat = new THREE.MeshStandardMaterial({
      color: 0x2b7d5c,
      map: birdPlumageTex,
      normalMap: wolfPBRAssets.normTex,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.36,
      metalness: 0.16,
      side: THREE.DoubleSide
    });
    wolfPBRAssets.injectWolfAnisotropicSSSMaterial(doveWingMat, true);
    const doveBreastMat = new THREE.MeshStandardMaterial({
      color: 0xe2d8d0,
      map: birdPlumageTex,
      roughness: 0.50,
      metalness: 0.04
    });

    const songbirdLegMat = new THREE.MeshStandardMaterial({
      color: 0x4a3b34,
      roughness: 0.55,
      metalness: 0.08
    });
    const songbirdBeakDarkMat = new THREE.MeshStandardMaterial({
      color: 0x22252a,
      roughness: 0.30,
      metalness: 0.15
    });

    sharedEagleAssets = {
      featherGeo, eaglePlumeMat, eagleBodyMat, seabirdBodyMat, seabirdWingMat, coralBeakMat, birdPlumageTex,
      tanagerBodyMat, tanagerWingMat, tanagerBellyMat,
      kingfisherBodyMat, kingfisherWingMat, kingfisherBreastMat,
      doveBodyMat, doveWingMat, doveBreastMat,
      songbirdLegMat, songbirdBeakDarkMat
    };
    return sharedEagleAssets;
  }

  const eagleAgents = [];
  const forestBirdAgents = [];
  const perchNodes = [];

  function triggerBirdFlightToNewPerch(fb, avoidX = null, avoidZ = null, isStartled = false) {
    if (!fb || !perchNodes.length) return;
    const pos = fb.mesh.position;
    let bestPerch = null;
    let bestScore = -Infinity;
    const preferElevated = isStartled || (fb.currentPerch && fb.currentPerch.type === 'ground') || Math.random() < 0.72;

    const stride = Math.max(1, Math.floor(perchNodes.length / 90));
    const offset = Math.floor(Math.random() * stride);
    for (let idx = offset; idx < perchNodes.length; idx += stride) {
      const cand = perchNodes[idx];
      if (!cand || cand === fb.currentPerch) continue;
      if (cand.hostObj && !cand.hostObj.parent) continue;
      const dx = cand.x - pos.x;
      const dz = cand.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 5.0 || dist > 38.0) continue;

      let score = -Math.abs(dist - (isStartled ? 15.5 : 13.5)) * 0.45 + (Math.random() * 4.5);
      if (preferElevated && (cand.type === 'branch' || cand.type === 'rock')) score += 6.5;
      if (!preferElevated && cand.type === 'ground') score += 6.0;

      // Keep mildly near home region so birds remain well-distributed across biomes
      const dHome = Math.hypot(cand.x - fb.homeX, cand.z - fb.homeZ);
      if (dHome > 54.0) score -= (dHome - 54.0) * 0.35;

      if (avoidX !== null && avoidZ !== null) {
        const dPlayer = Math.hypot(cand.x - avoidX, cand.z - avoidZ);
        if (dPlayer < 10.5) {
          score -= (10.5 - dPlayer) * 4.0;
        } else {
          // Prefer flying away from the player's approach vector
          const awayX = pos.x - avoidX, awayZ = pos.z - avoidZ;
          const awayLen = Math.max(0.01, Math.hypot(awayX, awayZ));
          const dotAway = ((dx / dist) * (awayX / awayLen)) + ((dz / dist) * (awayZ / awayLen));
          score += dotAway * 5.0;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPerch = cand;
      }
    }

    if (!bestPerch) {
      // Fallback: synthetic branch/ground perch 14m away from avoid point
      const awayYaw = (avoidX !== null && avoidZ !== null)
        ? Math.atan2(pos.x - avoidX, pos.z - avoidZ) + (Math.random() - 0.5) * 0.9
        : Math.random() * Math.PI * 2;
      const tx = pos.x + Math.sin(awayYaw) * 14.5;
      const tz = pos.z + Math.cos(awayYaw) * 14.5;
      const ty = Math.max(1.2, getTerrainHeight(tx, tz));
      bestPerch = { type: 'ground', x: tx, y: ty, z: tz, hostObj: null };
    }

    fb.startPos.copy(pos);
    fb.targetPerch = bestPerch;
    fb.currentPerch = null;
    fb.flightDist = Math.max(1.0, Math.hypot(bestPerch.x - pos.x, bestPerch.z - pos.z));
    fb.flightProgress = 0.0;
    fb.flightSpeed = (isStartled ? 7.6 : 6.2) + Math.random() * 1.1;
    fb.arcHeight = Math.min(4.2, Math.max(1.35, fb.flightDist * 0.16));
    fb.yaw = Math.atan2(bestPerch.x - pos.x, bestPerch.z - pos.z);
    fb.state = 'flying';
    fb.isAlert = false;
    fb.stateTimer = 0;
  }
  function spawnEagles() {
    if (!sharedEagleAssets) buildSharedEagleAssets();
    const dummy = new THREE.Object3D();
    const fCol = new THREE.Color();

    // Helper: Build 2-stage articulated cambered wing with 54 GPU-instanced layered flight feathers (remiges & coverts)
    function buildArticulatedFeatheredWing(side, isSeabird = false) {
      const innerGroup = new THREE.Group();
      const sparMat = isSeabird ? sharedEagleAssets.seabirdBodyMat : sharedEagleAssets.eagleBodyMat;
      const plumeMat = isSeabird ? sharedEagleAssets.seabirdWingMat : sharedEagleAssets.eaglePlumeMat;
      const innerSpar = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.036, 0.96, 8), sparMat);
      innerSpar.rotation.z = side * Math.PI / 2;
      innerSpar.position.set(side * 0.48, 0.02, 0.12);
      innerGroup.add(innerSpar);

      const innerFeatherCount = 32;
      const innerInst = new THREE.InstancedMesh(sharedEagleAssets.featherGeo, plumeMat, innerFeatherCount);
      for (let i = 0; i < innerFeatherCount; i++) {
        const isCovert = (i >= 16);
        const u = (i % 16) / 15;
        const xPos = side * (0.12 + u * 0.82);
        dummy.position.set(xPos, isCovert ? 0.028 : 0.01, isCovert ? 0.08 : 0.02);
        dummy.rotation.set(-Math.PI / 2 + (isCovert ? 0.08 : 0.03), 0, side * (0.08 + u * 0.12));
        dummy.scale.set(isCovert ? 1.15 : 1.05, isCovert ? 0.62 : (1.12 - u * 0.12), 1.0);
        dummy.updateMatrix();
        innerInst.setMatrixAt(i, dummy.matrix);
        if (isSeabird) {
          fCol.setHex(isCovert ? 0xf5f7fa : 0xd0d8e2);
        } else {
          fCol.setHex(isCovert ? 0x3b261a : 0x22150e);
        }
        innerInst.setColorAt(i, fCol);
      }
      innerInst.instanceMatrix.needsUpdate = true;
      if (innerInst.instanceColor) innerInst.instanceColor.needsUpdate = true;
      innerInst.castShadow = false;
      innerInst.layers.set(1);
      innerInst.computeBoundingSphere();
      innerGroup.add(innerInst);

      // Outer Wing Segment (Manus + Slotted Primary Finger Feathers)
      const outerGroup = new THREE.Group();
      outerGroup.position.set(side * 0.94, 0.01, 0.10);
      const outerFeatherCount = 22;
      const outerInst = new THREE.InstancedMesh(sharedEagleAssets.featherGeo, plumeMat, outerFeatherCount);
      for (let i = 0; i < outerFeatherCount; i++) {
        const isCovert = (i >= 12);
        const u = isCovert ? ((i - 12) / 9) : (i / 11);
        dummy.position.set(side * (u * 0.72), isCovert ? 0.02 : 0.0, -u * 0.06);
        const fanZ = side * (0.18 + u * 0.82);
        const tipUp = (!isCovert && u > 0.6) ? (u - 0.6) * 0.35 : 0.0;
        dummy.rotation.set(-Math.PI / 2 + tipUp, 0, fanZ);
        dummy.scale.set(0.95, isCovert ? 0.52 : (1.28 - u * 0.22), 1.0);
        dummy.updateMatrix();
        outerInst.setMatrixAt(i, dummy.matrix);
        if (isSeabird) {
          // Crisp black-tipped primary flight feathers & snow-white coverts like real Tropicbirds & Sea Gulls
          fCol.setHex(u > 0.52 ? 0x1c222b : 0xeef2f7);
        } else {
          fCol.setHex(u > 0.65 ? 0x140c08 : 0x2c1c12);
        }
        outerInst.setColorAt(i, fCol);
      }
      outerInst.instanceMatrix.needsUpdate = true;
      if (outerInst.instanceColor) outerInst.instanceColor.needsUpdate = true;
      outerInst.castShadow = false;
      outerInst.layers.set(1);
      outerInst.computeBoundingSphere();
      outerGroup.add(outerInst);

      innerGroup.add(outerGroup);
      return { innerGroup, outerGroup };
    }

    function createArticulatedBirdMesh(isSeabird = false) {
      const bird = new THREE.Group();
      const bodyMat = isSeabird ? sharedEagleAssets.seabirdBodyMat : sharedEagleAssets.eagleBodyMat;
      const beakMat = isSeabird ? sharedEagleAssets.coralBeakMat : matBrass;

      // 1. Sculpted Aerodynamic Avian Torso & Pectoral Keel
      const torsoGeo = new THREE.SphereGeometry(0.24, 16, 14);
      torsoGeo.scale(isSeabird ? 0.80 : 0.88, isSeabird ? 0.76 : 0.82, isSeabird ? 2.25 : 2.15);
      torsoGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(torsoGeo.attributes.position.count).fill(0.05), 1));
      const torso = new THREE.Mesh(torsoGeo, bodyMat);
      bird.add(torso);

      // 2. Sculpted Head, Supraorbital Brow, Eyes & Beak
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 14, 12), isSeabird ? sharedEagleAssets.seabirdBodyMat : matIvory);
      head.scale.set(0.92, 0.95, 1.24);
      head.position.set(0, 0.06, 0.50);
      bird.add(head);

      const upperBeak = new THREE.Mesh(new THREE.ConeGeometry(isSeabird ? 0.044 : 0.052, isSeabird ? 0.24 : 0.19, 10), beakMat);
      upperBeak.rotation.x = Math.PI / 2 + (isSeabird ? 0.10 : 0.25);
      upperBeak.position.set(0, 0.04, 0.67);
      bird.add(upperBeak);
      if (!isSeabird) {
        const beakHook = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.075, 8), beakMat);
        beakHook.rotation.x = Math.PI - 0.25;
        beakHook.position.set(0, 0.00, 0.73);
        bird.add(beakHook);
      }

      [-0.085, 0.085].forEach(ex => {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), isSeabird ? matEyeDark : matEyeAmber);
        eye.position.set(ex, 0.075, 0.56);
        bird.add(eye);
      });

      // 3. Tucked Talons / Webbed Feet Beneath Belly
      [-0.08, 0.08].forEach(tx => {
        const talon = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), beakMat);
        talon.scale.set(0.8, 0.8, 1.4);
        talon.position.set(tx, -0.17, -0.15);
        bird.add(talon);
      });

      // 4. Articulated Fanned 9-Feather Rectrices Tail (+ Twin Long White Tail Streamers for Coastal Tropicbirds)
      const tailFan = new THREE.Group();
      tailFan.position.set(0, 0.0, -0.46);
      for (let t = -4; t <= 4; t++) {
        const rectrix = new THREE.Mesh(sharedEagleAssets.featherGeo, isSeabird ? sharedEagleAssets.seabirdWingMat : matIvory);
        rectrix.rotation.x = -Math.PI / 2;
        rectrix.rotation.z = t * 0.11;
        rectrix.scale.set(1.15, 1.05 - Math.abs(t) * 0.04, 1.0);
        tailFan.add(rectrix);
      }
      if (isSeabird) {
        [-0.025, 0.025].forEach(sx => {
          const streamer = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.012, 0.78, 6), sharedEagleAssets.seabirdBodyMat);
          streamer.rotation.x = Math.PI / 2 - 0.08;
          streamer.position.set(sx, -0.01, -0.58);
          tailFan.add(streamer);
        });
      }
      bird.add(tailFan);

      const leftW = buildArticulatedFeatheredWing(-1, isSeabird);
      const rightW = buildArticulatedFeatheredWing(1, isSeabird);
      bird.add(leftW.innerGroup, rightW.innerGroup);
      if (!isSeabird) {
        bird.scale.setScalar(1.18);
      } else {
        bird.scale.setScalar(0.92);
      }
      bird.traverse(ch => { if (ch.isMesh || ch.isInstancedMesh) ch.raycast = () => {}; });
      wildlifeGroup.add(bird);

      return {
        mesh: bird,
        leftWing: leftW.innerGroup,
        rightWing: rightW.innerGroup,
        leftOuter: leftW.outerGroup,
        rightOuter: rightW.outerGroup,
        tailFan
      };
    }

    // 4 High-Altitude Caldera Sea Eagles + 8 Coastal White-Tailed Tropicbirds / Seabirds over Emerald Bamboo Wetlands, Coral Cove & Channels
    const birdSpecs = [
      { isSeabird: false, cx:  45,  cz:  65,  alt: 46, rad: 38, speed: 0.28, flapFreq: 4.8 },
      { isSeabird: false, cx: -25,  cz:  65,  alt: 54, rad: 45, speed: 0.26, flapFreq: 4.6 },
      { isSeabird: false, cx:  45,  cz: -95,  alt: 58, rad: 52, speed: 0.25, flapFreq: 4.5 },
      { isSeabird: false, cx: -185, cz:  72,  alt: 62, rad: 48, speed: 0.27, flapFreq: 4.7 },
      // 8 Coastal White-Tailed Tropicbirds & Seabirds soaring over Emerald Bamboo Wetlands, Coral Cove & Lagoons
      { isSeabird: true,  cx: -88,  cz: -128, alt: 22, rad: 28, speed: 0.42, flapFreq: 6.4 },
      { isSeabird: true,  cx: -112, cz: -148, alt: 26, rad: 34, speed: 0.38, flapFreq: 6.1 },
      { isSeabird: true,  cx: -68,  cz: -28,  alt: 20, rad: 26, speed: 0.44, flapFreq: 6.6 },
      { isSeabird: true,  cx: -18,  cz: -32,  alt: 19, rad: 30, speed: 0.40, flapFreq: 6.2 },
      { isSeabird: true,  cx:  55,  cz: -45,  alt: 24, rad: 32, speed: 0.39, flapFreq: 6.0 },
      { isSeabird: true,  cx: -328, cz:  222, alt: 23, rad: 30, speed: 0.41, flapFreq: 6.3 },
      { isSeabird: true,  cx: -145, cz: -85,  alt: 28, rad: 36, speed: 0.37, flapFreq: 5.9 },
      { isSeabird: true,  cx:  125, cz: -110, alt: 25, rad: 34, speed: 0.40, flapFreq: 6.2 }
    ];

    birdSpecs.forEach((sp, e) => {
      const bObj = createArticulatedBirdMesh(sp.isSeabird);
      eagleAgents.push({
        mesh: bObj.mesh,
        leftWing: bObj.leftWing,
        rightWing: bObj.rightWing,
        leftOuter: bObj.leftOuter,
        rightOuter: bObj.rightOuter,
        tailFan: bObj.tailFan,
        isSeabird: sp.isSeabird,
        cx: sp.cx,
        cz: sp.cz,
        alt: sp.alt,
        ang: e * 1.15,
        rad: sp.rad,
        speed: sp.speed,
        flapFreq: sp.flapFreq
      });
    });

    // ==========================================================================
    // 9E. LOW-FLYING PERCHING, WALKING & FORAGING ISLAND BIRDS
    //     (Scarlet Tanagers, Azure Kingfishers & Emerald Ground Doves that land
    //      on real 3D tree branches, boulders/rocks, and forest clearings)
    // ==========================================================================
    function buildPerchCatalog() {
      perchNodes.length = 0;
      const trees = window.activeEZTrees || [];
      // 1. Sample real 3D lateral tree branch geometry vertices across island trees
      for (let t = 0; t < trees.length; t++) {
        const tr = trees[t];
        if (!tr || !tr.parent || !tr.userData || tr.userData.type !== 'tree') continue;
        const tx = tr.position.x, ty = tr.position.y, tz = tr.position.z;
        if (ty < 0.8 || ty > 62.0) continue;
        const s = (tr.scale && tr.scale.x) ? tr.scale.x : 1.0;
        const ry = tr.rotation ? tr.rotation.y : 0.0;
        const cosR = Math.cos(ry), sinR = Math.sin(ry);
        let foundBranchOnTree = false;

        if (tr.branchesMesh && tr.branchesMesh.geometry && tr.branchesMesh.geometry.attributes.position) {
          const bPos = tr.branchesMesh.geometry.attributes.position;
          const step = Math.max(1, Math.floor(bPos.count / 45));
          for (let v = 0; v < bPos.count; v += step) {
            const vx = bPos.getX(v) * s;
            const vy = bPos.getY(v) * s;
            const vz = bPos.getZ(v) * s;
            const rad = Math.hypot(vx, vz);
            // Select genuine outward lateral limbs between 1.8m and 5.2m above ground
            if (vy >= 1.85 && vy <= 5.2 && rad >= 0.82 && rad <= 2.45) {
              const wx = tx + vx * cosR + vz * sinR;
              const wy = ty + vy + 0.015;
              const wz = tz - vx * sinR + vz * cosR;
              perchNodes.push({
                type: 'branch',
                x: wx,
                y: wy,
                z: wz,
                hostObj: tr,
                perchYaw: Math.atan2(vx * cosR + vz * sinR, -vx * sinR + vz * cosR) + Math.PI * 0.5
              });
              foundBranchOnTree = true;
              break;
            }
          }
        }
        if (!foundBranchOnTree) {
          const bAng = (t * 2.39996) % (Math.PI * 2);
          const bRad = 1.15 * s;
          perchNodes.push({
            type: 'branch',
            x: tx + Math.cos(bAng) * bRad,
            y: ty + 2.65 * s,
            z: tz + Math.sin(bAng) * bRad,
            hostObj: tr,
            perchYaw: bAng + Math.PI * 0.5
          });
        }
      }

      // 2. Sample rock & boulder crests from masterInteractiveTargets
      for (let i = 0; i < masterInteractiveTargets.length; i++) {
        const obj = masterInteractiveTargets[i];
        if (!obj || !obj.parent || !obj.userData || obj.userData.type !== 'rock') continue;
        const rx = obj.position.x, rz = obj.position.z;
        const gY = getTerrainHeight(rx, rz);
        if (gY < 0.85 || gY > 55.0) continue;
        const sc = obj.scale ? obj.scale.x : 1.2;
        if (sc < 0.55) continue;
        perchNodes.push({
          type: 'rock',
          x: rx,
          y: obj.position.y + sc * 0.72,
          z: rz,
          hostObj: obj,
          perchYaw: (i * 1.7) % (Math.PI * 2)
        });
      }

      // 3. Curated ground foraging spots (glades, trail edges, streambanks, starting beach edge)
      const groundSpots = [
        [-12, 18], [-24, 28], [-38, 36], [-52, 46], [-68, 54], [-84, 44],
        [-102, 58], [-122, 68], [-142, 74], [-44, 14], [-28, 8], [14, 24],
        [32, 38], [58, 52], [82, 64], [18, 142], [44, 168], [76, 192],
        [-72, -96], [-88, -118], [-104, -132], [28, -24], [64, -38], [-162, 62]
      ];
      for (let g = 0; g < groundSpots.length; g++) {
        const [gx, gz] = groundSpots[g];
        const gy = getTerrainHeight(gx, gz);
        if (gy > 1.1 && gy < 45.0) {
          perchNodes.push({
            type: 'ground',
            x: gx,
            y: gy,
            z: gz,
            hostObj: null,
            perchYaw: Math.random() * Math.PI * 2
          });
        }
      }
    }

    function buildSongbirdFeatheredWing(side, species) {
      const innerGroup = new THREE.Group();
      const bodyMat = species === 'tanager'
        ? sharedEagleAssets.tanagerWingMat
        : (species === 'kingfisher' ? sharedEagleAssets.kingfisherBodyMat : sharedEagleAssets.doveBodyMat);
      const wingMat = species === 'tanager'
        ? sharedEagleAssets.tanagerWingMat
        : (species === 'kingfisher' ? sharedEagleAssets.kingfisherWingMat : sharedEagleAssets.doveWingMat);

      const innerSpar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.65, 6), bodyMat);
      innerSpar.rotation.z = side * Math.PI / 2;
      innerSpar.position.set(side * 0.32, 0.01, 0.06);
      innerGroup.add(innerSpar);

      const innerCount = 20;
      const innerInst = new THREE.InstancedMesh(sharedEagleAssets.featherGeo, wingMat, innerCount);
      for (let i = 0; i < innerCount; i++) {
        const isCovert = (i >= 10);
        const u = (i % 10) / 9;
        dummy.position.set(side * (0.08 + u * 0.56), isCovert ? 0.018 : 0.005, isCovert ? 0.05 : 0.01);
        dummy.rotation.set(-Math.PI / 2 + (isCovert ? 0.07 : 0.02), 0, side * (0.06 + u * 0.14));
        dummy.scale.set(0.88, isCovert ? 0.46 : (0.82 - u * 0.10), 1.0);
        dummy.updateMatrix();
        innerInst.setMatrixAt(i, dummy.matrix);
        if (species === 'tanager') {
          fCol.setHex(isCovert ? 0x262b34 : 0x15181e);
        } else if (species === 'kingfisher') {
          fCol.setHex(isCovert ? 0x2986e8 : 0x1558a6);
        } else {
          fCol.setHex(isCovert ? 0x328f6a : 0x6e5c52);
        }
        innerInst.setColorAt(i, fCol);
      }
      innerInst.instanceMatrix.needsUpdate = true;
      if (innerInst.instanceColor) innerInst.instanceColor.needsUpdate = true;
      innerInst.castShadow = false;
      innerInst.layers.set(1);
      innerInst.computeBoundingSphere();
      innerGroup.add(innerInst);

      const outerGroup = new THREE.Group();
      outerGroup.position.set(side * 0.64, 0.008, 0.05);
      const outerCount = 16;
      const outerInst = new THREE.InstancedMesh(sharedEagleAssets.featherGeo, wingMat, outerCount);
      for (let i = 0; i < outerCount; i++) {
        const isCovert = (i >= 9);
        const u = isCovert ? ((i - 9) / 6) : (i / 8);
        dummy.position.set(side * (u * 0.48), isCovert ? 0.014 : 0.0, -u * 0.04);
        const fanZ = side * (0.16 + u * 0.76);
        dummy.rotation.set(-Math.PI / 2 + ((!isCovert && u > 0.55) ? (u - 0.55) * 0.25 : 0.0), 0, fanZ);
        dummy.scale.set(0.80, isCovert ? 0.42 : (0.94 - u * 0.18), 1.0);
        dummy.updateMatrix();
        outerInst.setMatrixAt(i, dummy.matrix);
        if (species === 'tanager') {
          fCol.setHex(0x14171c);
        } else if (species === 'kingfisher') {
          fCol.setHex(u > 0.55 ? 0x0e3b75 : 0x2474cc);
        } else {
          fCol.setHex(u > 0.60 ? 0x4a3e38 : 0x267555);
        }
        outerInst.setColorAt(i, fCol);
      }
      outerInst.instanceMatrix.needsUpdate = true;
      if (outerInst.instanceColor) outerInst.instanceColor.needsUpdate = true;
      outerInst.castShadow = false;
      outerInst.layers.set(1);
      outerInst.computeBoundingSphere();
      outerGroup.add(outerInst);

      innerGroup.add(outerGroup);
      return { innerGroup, outerGroup };
    }

    function buildArticulatedSongbirdLeg(side, legMat) {
      const legPivot = new THREE.Group();
      legPivot.position.set(side * 0.044, 0.145, -0.01);

      // Feathered Tibiotarsus Thigh
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.008, 0.072, 6), legMat);
      thigh.position.set(0, -0.034, 0.008);
      thigh.rotation.x = 0.22;
      legPivot.add(thigh);

      // Tarsometatarsus Shin Pivot (Ankle/Knee Joint)
      const shinPivot = new THREE.Group();
      shinPivot.position.set(0, -0.068, 0.016);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.0055, 0.082, 6), legMat);
      shin.position.set(0, -0.038, -0.01);
      shin.rotation.x = -0.24;
      shinPivot.add(shin);

      // 4-Toed Perching Foot (3 Anterior Digital Toes + 1 Posterior Hallux Claw)
      const footGroup = new THREE.Group();
      footGroup.position.set(0, -0.076, -0.018);
      [-0.28, 0.0, 0.28].forEach(tAng => {
        const toe = new THREE.Mesh(new THREE.ConeGeometry(0.0045, 0.042, 5), legMat);
        toe.rotation.x = Math.PI / 2 + 0.12;
        toe.rotation.z = tAng;
        toe.position.set(Math.sin(tAng) * 0.012, 0.003, 0.018);
        footGroup.add(toe);
      });
      const hallux = new THREE.Mesh(new THREE.ConeGeometry(0.0045, 0.032, 5), legMat);
      hallux.rotation.x = -Math.PI / 2 - 0.15;
      hallux.position.set(0, 0.003, -0.014);
      footGroup.add(hallux);

      shinPivot.add(footGroup);
      legPivot.add(shinPivot);
      return { legPivot, shinPivot, footGroup };
    }

    function createPerchingForestBirdMesh(species = 'tanager') {
      const root = new THREE.Group();
      const bodyMat = species === 'tanager'
        ? sharedEagleAssets.tanagerBodyMat
        : (species === 'kingfisher' ? sharedEagleAssets.kingfisherBodyMat : sharedEagleAssets.doveBodyMat);
      const breastMat = species === 'tanager'
        ? sharedEagleAssets.tanagerBellyMat
        : (species === 'kingfisher' ? sharedEagleAssets.kingfisherBreastMat : sharedEagleAssets.doveBreastMat);
      const wingMat = species === 'tanager'
        ? sharedEagleAssets.tanagerWingMat
        : (species === 'kingfisher' ? sharedEagleAssets.kingfisherWingMat : sharedEagleAssets.doveWingMat);
      const beakMat = species === 'tanager'
        ? sharedEagleAssets.coralBeakMat
        : (species === 'kingfisher' ? sharedEagleAssets.songbirdBeakDarkMat : sharedEagleAssets.coralBeakMat);

      const bodyPivot = new THREE.Group();
      bodyPivot.position.set(0, 0.145, 0);

      // 1. Sculpted Songbird Torso & Rounded Pectoral Breast
      const torsoGeo = new THREE.SphereGeometry(0.105, 14, 12);
      torsoGeo.scale(0.84, 0.86, 1.62);
      torsoGeo.setAttribute('aSssWeight', new THREE.Float32BufferAttribute(new Float32Array(torsoGeo.attributes.position.count).fill(0.06), 1));
      const torso = new THREE.Mesh(torsoGeo, bodyMat);
      bodyPivot.add(torso);

      const breast = new THREE.Mesh(new THREE.SphereGeometry(0.092, 12, 10), breastMat);
      breast.scale.set(0.78, 0.74, 1.38);
      breast.position.set(0, -0.024, 0.036);
      bodyPivot.add(breast);

      if (species === 'dove') {
        // Emerald-iridescent neck collar badge
        const collar = new THREE.Mesh(new THREE.SphereGeometry(0.078, 10, 8), wingMat);
        collar.scale.set(0.92, 0.65, 0.88);
        collar.position.set(0, 0.038, 0.085);
        bodyPivot.add(collar);
      }

      // 2. Articulated Neck & Head Pivot with Crown Crest, Glossy Eyes & Opening Beak
      const headPivot = new THREE.Group();
      headPivot.position.set(0, 0.068, 0.138);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.074, 12, 10), bodyMat);
      head.scale.set(0.90, 0.94, 1.16);
      headPivot.add(head);

      if (species === 'kingfisher') {
        const throat = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), sharedEagleAssets.seabirdBodyMat);
        throat.scale.set(0.85, 0.65, 0.95);
        throat.position.set(0, -0.026, 0.042);
        headPivot.add(throat);
      }

      // Sculpted Swept Crown Crest Feathers (for Scarlet Tanager/Cardinal & Azure Kingfisher)
      const crestGroup = new THREE.Group();
      crestGroup.position.set(0, 0.056, -0.01);
      if (species === 'tanager' || species === 'kingfisher') {
        for (let c = -1; c <= 1; c++) {
          const plume = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.078, 6), bodyMat);
          plume.rotation.x = -Math.PI * 0.36 + Math.abs(c) * 0.08;
          plume.rotation.z = c * 0.18;
          plume.position.set(c * 0.014, 0.016, -0.022);
          crestGroup.add(plume);
        }
      }
      headPivot.add(crestGroup);

      // Glossy Eyes + Orbital Ring
      [-0.048, 0.048].forEach(ex => {
        const eyeRing = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), sharedEagleAssets.seabirdBodyMat);
        eyeRing.scale.set(0.65, 1.0, 1.0);
        eyeRing.position.set(ex, 0.016, 0.036);
        headPivot.add(eyeRing);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0135, 8, 8), matEyeDark);
        eye.position.set(ex * 1.06, 0.016, 0.038);
        headPivot.add(eye);
      });

      // Upper & Articulated Lower Beak (Mandible opens when chirping or pecking seeds)
      const beakLen = species === 'kingfisher' ? 0.118 : (species === 'tanager' ? 0.068 : 0.064);
      const beakRad = species === 'tanager' ? 0.026 : (species === 'kingfisher' ? 0.021 : 0.016);
      const upperBeak = new THREE.Mesh(new THREE.ConeGeometry(beakRad, beakLen, 8), beakMat);
      upperBeak.rotation.x = Math.PI / 2 + 0.06;
      upperBeak.position.set(0, 0.006, 0.072 + beakLen * 0.42);
      headPivot.add(upperBeak);

      const lowerBeak = new THREE.Mesh(new THREE.ConeGeometry(beakRad * 0.82, beakLen * 0.88, 8), beakMat);
      lowerBeak.rotation.x = Math.PI / 2 - 0.04;
      lowerBeak.position.set(0, -0.008, 0.068 + beakLen * 0.38);
      headPivot.add(lowerBeak);

      bodyPivot.add(headPivot);

      // 3. Articulated 7-Feather Tail Fan (Spreads during landing flare, flicks when perched/walking)
      const tailFan = new THREE.Group();
      tailFan.position.set(0, 0.008, -0.155);
      for (let t = -3; t <= 3; t++) {
        const rectrix = new THREE.Mesh(sharedEagleAssets.featherGeo, wingMat);
        rectrix.rotation.x = -Math.PI / 2;
        rectrix.rotation.z = t * 0.12;
        rectrix.scale.set(0.68, 0.62 - Math.abs(t) * 0.03, 1.0);
        tailFan.add(rectrix);
      }
      bodyPivot.add(tailFan);

      // 4. Two-Stage Articulated Wings (Spread in flight, fold neatly along flanks when perched/walking)
      const leftW = buildSongbirdFeatheredWing(-1, species);
      const rightW = buildSongbirdFeatheredWing(1, species);
      leftW.innerGroup.position.set(-0.055, 0.025, 0.03);
      rightW.innerGroup.position.set(0.055, 0.025, 0.03);
      bodyPivot.add(leftW.innerGroup, rightW.innerGroup);

      root.add(bodyPivot);

      // 5. Two-Segment Articulated Bipedal Legs & Perching Talons
      const leftLeg = buildArticulatedSongbirdLeg(-1, sharedEagleAssets.songbirdLegMat);
      const rightLeg = buildArticulatedSongbirdLeg(1, sharedEagleAssets.songbirdLegMat);
      root.add(leftLeg.legPivot, rightLeg.legPivot);

      // Merge static sub-meshes within each articulated songbird pivot (4 toes -> 1, 7 tail feathers -> 1, 3 crest plumes -> 1, paired eyes -> 1)
      // Preserves 100% of wing, leg, beak, crest, head & tail articulation with zero visual loss
      mergeStaticGroupByMaterial(crestGroup);
      mergeStaticGroupByMaterial(tailFan);
      mergeStaticGroupByMaterial(headPivot, new Set([crestGroup, lowerBeak]));
      mergeStaticGroupByMaterial(leftLeg.footGroup);
      mergeStaticGroupByMaterial(rightLeg.footGroup);

      const speciesScale = species === 'dove' ? 1.18 : (species === 'kingfisher' ? 1.08 : 1.02);
      root.scale.setScalar(speciesScale);
      root.userData.species = 'songbird';
      root.traverse(ch => { if (ch.isMesh || ch.isInstancedMesh) ch.raycast = () => {}; });
      wildlifeGroup.add(root);

      return {
        mesh: root,
        bodyPivot,
        headPivot,
        crestGroup,
        lowerBeak,
        tailFan,
        leftWing: leftW.innerGroup,
        rightWing: rightW.innerGroup,
        leftOuter: leftW.outerGroup,
        rightOuter: rightW.outerGroup,
        leftLeg: leftLeg.legPivot,
        rightLeg: rightLeg.legPivot,
        leftShin: leftLeg.shinPivot,
        rightShin: rightLeg.shinPivot,
        leftFoot: leftLeg.footGroup,
        rightFoot: rightLeg.footGroup
      };
    }

    buildPerchCatalog();
    const branchPerches = perchNodes.filter(p => p.type === 'branch' && Math.hypot(p.x, p.z - 25) < 220);
    const rockPerches = perchNodes.filter(p => p.type === 'rock' && Math.hypot(p.x, p.z - 25) < 220);
    const groundPerches = perchNodes.filter(p => p.type === 'ground');
    const speciesRotation = ['tanager', 'kingfisher', 'dove'];
    const totalLowBirds = 32;
    for (let b = 0; b < totalLowBirds; b++) {
      const spName = speciesRotation[b % speciesRotation.length];
      const bObj = createPerchingForestBirdMesh(spName);
      let initialPerch = null;
      if (b % 3 === 0 && branchPerches.length > 0) {
        initialPerch = branchPerches[(b * 5 + 1) % branchPerches.length];
      } else if (b % 3 === 1 && rockPerches.length > 0) {
        initialPerch = rockPerches[(b * 3 + 2) % rockPerches.length];
      } else if (groundPerches.length > 0) {
        initialPerch = groundPerches[b % groundPerches.length];
      } else if (perchNodes.length > 0) {
        initialPerch = perchNodes[(b * 7 + 3) % perchNodes.length];
      } else {
        initialPerch = { type: 'ground', x: -24 + b * 2, y: getTerrainHeight(-24 + b * 2, 24), z: 24, hostObj: null, perchYaw: 0 };
      }

      bObj.mesh.position.set(initialPerch.x, initialPerch.y, initialPerch.z);
      const initYaw = initialPerch.perchYaw || (b * 1.3);
      bObj.mesh.rotation.y = initYaw;

      const startInFlight = (b % 5 === 4);
      const startState = startInFlight
        ? 'perched'
        : (initialPerch.type === 'ground' ? (b % 2 === 0 ? 'ground_walk' : 'ground_idle') : 'perched');

      const fbAgent = {
        species: spName,
        mesh: bObj.mesh,
        bodyPivot: bObj.bodyPivot,
        headPivot: bObj.headPivot,
        crestGroup: bObj.crestGroup,
        lowerBeak: bObj.lowerBeak,
        tailFan: bObj.tailFan,
        leftWing: bObj.leftWing,
        rightWing: bObj.rightWing,
        leftOuter: bObj.leftOuter,
        rightOuter: bObj.rightOuter,
        leftLeg: bObj.leftLeg,
        rightLeg: bObj.rightLeg,
        leftShin: bObj.leftShin,
        rightShin: bObj.rightShin,
        leftFoot: bObj.leftFoot,
        rightFoot: bObj.rightFoot,
        homeX: initialPerch.x,
        homeZ: initialPerch.z,
        currentPerch: initialPerch,
        targetPerch: null,
        startPos: new THREE.Vector3(initialPerch.x, initialPerch.y, initialPerch.z),
        flightDist: 10.0,
        flightProgress: 0.0,
        flightSpeed: 6.5,
        arcHeight: 2.2,
        yaw: initYaw,
        prevYaw: initYaw,
        state: startState, // 'perched' | 'ground_idle' | 'ground_walk' | 'flying' | 'landing'
        stateTimer: 3.5 + (b % 7) * 1.4,
        groundResidencyTimer: 10.0 + (b % 5) * 2.2,
        wingFold: startInFlight ? 0.0 : 1.0,
        walkPhase: b * 0.9,
        peckPhase: b * 1.3,
        isAlert: false
      };

      if (startInFlight) {
        triggerBirdFlightToNewPerch(fbAgent, null, null, false);
        fbAgent.flightProgress = (b % 5) * 0.16;
      }
      forestBirdAgents.push(fbAgent);
    }
  }

  // ============================================================================
  // 10. DYNAMIC WEATHER PATTERN ENGINE (3D Rain Streaks, Lightning & Thunder)
  // ============================================================================
  const rainCount = 900;
  const rainGeo = new THREE.BufferGeometry();
  const rainPositions = new Float32Array(rainCount * 6);
  for (let i = 0; i < rainCount; i++) {
    const rx = (Math.random() - 0.5) * 44;
    const ry = Math.random() * 24;
    const rz = (Math.random() - 0.5) * 44;
    const i6 = i * 6;
    rainPositions[i6]     = rx;
    rainPositions[i6 + 1] = ry;
    rainPositions[i6 + 2] = rz;
    rainPositions[i6 + 3] = rx - 0.18;
    rainPositions[i6 + 4] = ry - 1.15;
    rainPositions[i6 + 5] = rz - 0.12;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rainLines = new THREE.LineSegments(
    rainGeo,
    new THREE.LineBasicMaterial({ color: 0xc5e8ff, transparent: true, opacity: 0.48 })
  );
  rainLines.visible = false;
  scene.add(rainLines);

  function setDynamicWeatherState(stateName, notify = true) {
    campaign.weather.current = stateName;
    campaign.weather.timer = 0;
    const badge = document.getElementById('cc-weather-badge');

    if (stateName === 'clear') {
      campaign.weather.rainIntensity = 0.0;
      if (window.cloudUniforms) window.cloudUniforms['uCloudCover'].value = 0.42;
      if (window.skyUniforms) window.skyUniforms['stormMix'].value = 0.0;
      if (badge) badge.innerText = '☀️ Sunlit Clear';
    } else if (stateName === 'clouds') {
      campaign.weather.rainIntensity = 0.0;
      if (window.cloudUniforms) window.cloudUniforms['uCloudCover'].value = 0.65;
      if (window.skyUniforms) window.skyUniforms['stormMix'].value = 0.18;
      if (badge) badge.innerText = '⛅ Trade Winds';
    } else if (stateName === 'mist') {
      campaign.weather.rainIntensity = 0.0;
      if (window.cloudUniforms) window.cloudUniforms['uCloudCover'].value = 0.58;
      if (scene.fog && !(window.caveDarknessFactor > 0.25)) scene.fog.density = 0.0052;
      if (badge) badge.innerText = '🌫️ Golden Mist';
    } else if (stateName === 'rain') {
      campaign.weather.rainIntensity = 0.65;
      if (window.cloudUniforms) window.cloudUniforms['uCloudCover'].value = 0.82;
      if (window.skyUniforms) window.skyUniforms['stormMix'].value = 0.65;
      if (badge) badge.innerText = '🌧️ Tropical Rain';
      if (notify) showToast('🌧️ Tropical Rainshower — Rainwater Catchers refilling!');
    } else if (stateName === 'storm') {
      campaign.weather.rainIntensity = 1.0;
      if (window.cloudUniforms) window.cloudUniforms['uCloudCover'].value = 0.92;
      if (window.skyUniforms) window.skyUniforms['stormMix'].value = 0.95;
      if (badge) badge.innerText = '⛈️ Caldera Squall';
      if (notify) showToast('⛈️ Caldera Lightning Squall! Seek shelter or light a campfire for warmth.');
    }

    if (window.water && window.water.material && window.water.material.uniforms['uRainIntensity']) {
      window.water.material.uniforms['uRainIntensity'].value = campaign.weather.rainIntensity;
    }
    rainLines.visible = campaign.weather.rainIntensity > 0.1;
  }
  window.setDynamicWeatherState = setDynamicWeatherState;

  // ============================================================================
  // 11. PRIMARY STRIKE, PROJECTILE BALLISTICS, CARCASS HARVESTING & COOKING
  // ============================================================================
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const activeProjectiles = [];
  const activeExplosives = [];
  const activeImpactEffects = [];
  const harvestableCarcasses = [];
  const lodgedAmmoItems = [];
  const bloodSpecks = [];
  window.harvestableCarcasses = harvestableCarcasses;
  window.activeProjectiles = activeProjectiles;
  window.lodgedAmmoItems = lodgedAmmoItems;

  // Build high-visibility 3D Hunting Arrow / Crossbow Bolt with broadhead, 3-vane feather fletching & aerodynamic flight trail
  function createFlightArrowMesh(weaponType) {
    const isBolt = (weaponType === 'crossbow');
    const grp = new THREE.Group();
    const shaftLen = isBolt ? 0.64 : 0.90;
    const shaftRad = isBolt ? 0.016 : 0.014;

    // 1. Seasoned Hickory / Reinforced Ash Shaft oriented along local +Z (matches Object3D.lookAt)
    const shaftGeo = new THREE.CylinderGeometry(shaftRad, shaftRad * 0.92, shaftLen, 8);
    shaftGeo.rotateX(Math.PI / 2);
    const shaftMat = isBolt
      ? new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.55, metalness: 0.25 })
      : new THREE.MeshStandardMaterial({ color: 0xd7b377, roughness: 0.65 });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    grp.add(shaft);

    // 2. Glinting 4-Blade Steel / Obsidian Broadhead Tip at front (+Z)
    const tipLen = isBolt ? 0.12 : 0.11;
    const tipGeo = new THREE.ConeGeometry(0.032, tipLen, 6);
    tipGeo.rotateX(Math.PI / 2);
    const tipMat = new THREE.MeshStandardMaterial({
      color: isBolt ? 0xcfd8dc : 0x37474f,
      metalness: 0.78,
      roughness: 0.22,
      emissive: isBolt ? 0x102027 : 0x1a1a1a,
      emissiveIntensity: 0.35
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.z = shaftLen * 0.5 + tipLen * 0.42;
    grp.add(tip);

    // Broadhead cross-barbs
    const barbGeo = new THREE.BoxGeometry(0.068, 0.006, 0.075);
    const barb1 = new THREE.Mesh(barbGeo, tipMat);
    barb1.position.z = shaftLen * 0.5 + 0.015;
    const barb2 = barb1.clone();
    barb2.rotation.z = Math.PI / 2;
    grp.add(barb1, barb2);

    // 3. High-Visibility 3-Vane Feather Fletching & Nock Cap at tail (-Z)
    const vaneColorPrimary = isBolt ? 0x26e6c6 : 0xff5252;
    const vaneColorSecondary = isBolt ? 0xffd54f : 0xfff8e1;
    const vaneMat1 = new THREE.MeshBasicMaterial({ color: vaneColorPrimary, side: THREE.DoubleSide });
    const vaneMat2 = new THREE.MeshBasicMaterial({ color: vaneColorSecondary, side: THREE.DoubleSide });
    const vaneGeo = new THREE.BoxGeometry(0.005, 0.048, 0.16);
    const tailZ = -shaftLen * 0.5 + 0.09;
    for (let v = 0; v < 3; v++) {
      const ang = (v * Math.PI * 2) / 3;
      const vane = new THREE.Mesh(vaneGeo, v === 0 ? vaneMat2 : vaneMat1);
      vane.position.set(Math.cos(ang) * 0.022, Math.sin(ang) * 0.022, tailZ);
      vane.rotation.z = ang - Math.PI / 2;
      grp.add(vane);
    }

    const nockMat = new THREE.MeshBasicMaterial({ color: vaneColorSecondary });
    const nock = new THREE.Mesh(new THREE.SphereGeometry(0.020, 8, 8), nockMat);
    nock.position.z = -shaftLen * 0.5 - 0.01;
    grp.add(nock);

    // 4. Glowing Aerodynamic Flight Slipstream Ribbon (visible while airborne, hidden once lodged)
    const trailLen = isBolt ? 2.10 : 1.75;
    const trailGeo = new THREE.CylinderGeometry(0.004, 0.044, trailLen, 8, 1, true);
    trailGeo.rotateX(Math.PI / 2);
    const trailMat = new THREE.MeshBasicMaterial({
      color: isBolt ? 0x80deea : 0xffe082,
      transparent: true,
      opacity: 0.52,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const flightTrail = new THREE.Mesh(trailGeo, trailMat);
    flightTrail.position.z = -shaftLen * 0.5 - trailLen * 0.5;
    grp.add(flightTrail);

    grp.userData.flightTrail = flightTrail;
    grp.userData.shaftLen = shaftLen;
    return grp;
  }

  // Spawn multi-layered 3D impact burst (shockwave ring, core flash, rising dust puff & 14 surface-matched debris/spark particles)
  function spawnProjectileImpactEffect(hitPos, hitDir, surfaceType = 'ground', weaponType = 'bow') {
    const grp = new THREE.Group();
    grp.position.copy(hitPos);
    scene.add(grp);

    const isRock = (surfaceType === 'rock');
    const isWood = (surfaceType === 'wood');
    const isFlesh = (surfaceType === 'flesh');
    const isWater = (surfaceType === 'water');

    if (isRock && AudioEngine.playRockHit) AudioEngine.playRockHit();
    else if (isWater && AudioEngine.playSplash) AudioEngine.playSplash();
    else if (AudioEngine.playChop) AudioEngine.playChop();

    const ringColor = isRock ? 0xffca28 : (isFlesh ? 0xff5252 : (isWater ? 0x80deea : (isWood ? 0xffe082 : 0xd7ccc8)));
    const flashColor = isRock ? 0xffab00 : (isFlesh ? 0xd32f2f : (isWater ? 0xe0f7fa : 0xfff59d));

    // 1. Expanding 3D Impact Shockwave Ring
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.17, 20), ringMat);
    const lookTarget = hitPos.clone().add(hitDir ? hitDir.clone().negate() : new THREE.Vector3(0, 1, 0));
    ringMesh.lookAt(lookTarget);
    grp.add(ringMesh);

    // 2. Core Point Impact Flash Sphere
    const flashMat = new THREE.MeshBasicMaterial({
      color: flashColor,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), flashMat);
    grp.add(flashMesh);

    // 3. Expanding Dust / Smoke Puff Cloud
    const puffMat = new THREE.MeshBasicMaterial({
      color: isRock ? 0x90a4ae : (isFlesh ? 0xb71c1c : (isWater ? 0xb2ebf2 : (isWood ? 0xa1887f : 0x8d6e63))),
      transparent: true,
      opacity: 0.48,
      depthWrite: false
    });
    const puffMesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), puffMat);
    grp.add(puffMesh);

    // 4. 14 Ballistic 3D Sparks, Wood Splinters, Stone Chips or Earth Clods
    const particles = [];
    const palette = isRock
      ? [0xffab00, 0xffe082, 0x78909c, 0xff6d00]
      : isWood
      ? [0xd7ccc8, 0x8d6e63, 0x66bb6a, 0xffcc80]
      : isFlesh
      ? [0xd32f2f, 0xff5252, 0x880e4f]
      : isWater
      ? [0xe0f7fa, 0x4dd0e1, 0xffffff]
      : [0x8d6e63, 0xa1887f, 0x9ccc65, 0xd7ccc8];

    const partGeo = isWood
      ? new THREE.BoxGeometry(0.032, 0.022, 0.11)
      : (THREE.DodecahedronGeometry ? new THREE.DodecahedronGeometry(0.042, 0) : new THREE.BoxGeometry(0.055, 0.055, 0.055));

    const backDir = hitDir ? hitDir.clone().negate() : new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 14; i++) {
      const pCol = palette[i % palette.length];
      const pMat = new THREE.MeshBasicMaterial({ color: pCol, transparent: true, opacity: 1.0 });
      const pm = new THREE.Mesh(partGeo, pMat);
      const spreadX = (Math.random() - 0.5) * 2.2;
      const spreadY = Math.random() * 1.6 + 0.4;
      const spreadZ = (Math.random() - 0.5) * 2.2;
      const spd = (weaponType === 'crossbow' ? 4.2 : 3.4) + Math.random() * 3.8;
      const vel = new THREE.Vector3(
        backDir.x * 1.4 + spreadX,
        Math.max(0.6, backDir.y * 1.2 + spreadY),
        backDir.z * 1.4 + spreadZ
      ).normalize().multiplyScalar(spd);
      pm.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      grp.add(pm);
      particles.push({
        mesh: pm,
        mat: pMat,
        vel,
        rotVel: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14)
      });
    }

    // Brief crosshair hit-confirmation pulse & X-hitmarker
    const bowArcEl = document.getElementById('cc-bow-arc');
    if (bowArcEl && isRangedAimTool(campaign.activeTool)) {
      bowArcEl.style.borderColor = isFlesh ? '#ff5252' : '#ffd54f';
      bowArcEl.style.transform = 'translate(-50%, -50%) scale(1.24)';
      setTimeout(() => {
        if (bowArcEl) bowArcEl.style.transform = 'translate(-50%, -50%) scale(1.0)';
      }, 170);
    }
    if (isFlesh && window.triggerHitmarker) {
      window.triggerHitmarker(false, false);
    }

    activeImpactEffects.push({
      group: grp,
      ringMesh,
      ringMat,
      flashMesh,
      flashMat,
      puffMesh,
      puffMat,
      particles,
      age: 0,
      maxLife: 0.68
    });
  }

  // Lodge a retrievable arrow or crossbow bolt at the impact point with a pulsing finder ring & generous pickup proxy
  function lodgeRetrievableProjectile(pr, hitPos, segDir, surfaceType = 'ground') {
    const mesh = pr.mesh;
    if (!mesh) return;
    if (mesh.userData && mesh.userData.flightTrail) {
      mesh.userData.flightTrail.visible = false;
    }

    // Back the arrow out slightly along its flight vector so the shaft and bright fletching stick clearly out of the surface
    const dir = (segDir && segDir.lengthSq() > 0.0001) ? segDir.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const lodgePos = hitPos.clone().addScaledVector(dir, -0.24);
    const minGroundY = getTerrainHeight(lodgePos.x, lodgePos.z) + 0.14;
    if (surfaceType === 'ground' && lodgePos.y < minGroundY) {
      lodgePos.y = minGroundY;
    }
    mesh.position.copy(lodgePos);
    mesh.lookAt(lodgePos.clone().add(dir));

    const isBolt = (pr.weaponType === 'crossbow');
    // Subtle glowing finder halo ring around the lodged arrow's fletching so the player can spot it in grass or forest shade
    const beaconGeo = new THREE.RingGeometry(0.16, 0.26, 18);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: isBolt ? 0x26e6c6 : 0xffd54f,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const beaconRing = new THREE.Mesh(beaconGeo, beaconMat);
    beaconRing.position.z = -0.22;
    mesh.add(beaconRing);

    // Generous invisible raycast hit-sphere (radius 0.88m) so looking anywhere near the arrow highlights & picks it up
    const hitProxy = new THREE.Mesh(
      new THREE.SphereGeometry(0.88, 8, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitProxy.layers.enable(1);
    hitProxy.layers.enable(2);
    mesh.add(hitProxy);

    const ammoLabel = isBolt ? 'Crossbow Bolt' : 'Hunting Arrow';
    mesh.userData = Object.assign(mesh.userData || {}, {
      type: 'lodged_ammo',
      ammoType: isBolt ? 'bolt' : 'arrow',
      lodgedAge: 0,
      beaconRing,
      beaconMat,
      promptLabel: `${isBolt ? '🎯' : '🏹'} Pick Up ${ammoLabel} (+1 to Inventory) [Tap Strike]`
    });

    registerInteractiveTarget(mesh);
    lodgedAmmoItems.push(mesh);
    if (lodgedAmmoItems.length > 30) {
      const oldA = lodgedAmmoItems.shift();
      if (oldA && oldA.parent) oldA.parent.remove(oldA);
      removeInteractiveTarget(oldA);
    }
  }

  // Pick up a lodged arrow or crossbow bolt and add it to the player's inventory
  function pickupLodgedAmmo(ammoMesh) {
    if (!ammoMesh || !ammoMesh.userData || ammoMesh.userData.pickedUp) return false;
    ammoMesh.userData.pickedUp = true;
    const isBolt = (ammoMesh.userData.ammoType === 'bolt');
    if (isBolt) {
      player.inventory.bolts = (player.inventory.bolts || 0) + 1;
    } else {
      player.inventory.arrows = (player.inventory.arrows || 0) + 1;
    }
    if (ammoMesh.parent) ammoMesh.parent.remove(ammoMesh);
    removeInteractiveTarget(ammoMesh);
    const idx = lodgedAmmoItems.indexOf(ammoMesh);
    if (idx !== -1) lodgedAmmoItems.splice(idx, 1);

    if (AudioEngine.playChop) AudioEngine.playChop();
    updateCastawayHUD();
    if (isBolt) {
      showToast(`🎯 Picked up Crossbow Bolt! (+1 Bolt — ${player.inventory.bolts} in Inventory)`);
    } else {
      showToast(`🏹 Picked up Hunting Arrow! (+1 Arrow — ${player.inventory.arrows} in Inventory)`);
    }
    return true;
  }
  window.pickupLodgedAmmo = pickupLodgedAmmo;

  function spawnBloodSpeck(x, y, z) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0x7f0e0e })
    );
    m.position.set(x, y + 0.06, z);
    scene.add(m);
    bloodSpecks.push({ mesh: m, age: 0, maxLife: 18.0 });
    if (bloodSpecks.length > 48) {
      const old = bloodSpecks.shift();
      scene.remove(old.mesh);
    }
  }

  function alertWildlifeFromGunshot(origin, radius = 140.0) {
    const rSq = radius * radius;
    for (let i = 0; i < wildlifeAgents.length; i++) {
      const ag = wildlifeAgents[i];
      if (!ag.mesh.parent || ag.isDead || ag.state === 'dying') continue;
      if (ag.species === 'crab') continue;
      const dx = ag.mesh.position.x - origin.x;
      const dz = ag.mesh.position.z - origin.z;
      if (dx * dx + dz * dz <= rSq) {
        ag.state = 'flee';
        ag.fleeTimer = 7.5;
        ag.yaw = Math.atan2(dx, dz);
      }
    }
    // Startle nearby perched or ground-foraging songbirds within 28m of loud impacts/shots
    const birdR2 = Math.min(28.0, radius) * Math.min(28.0, radius);
    for (let b = 0; b < forestBirdAgents.length; b++) {
      const fb = forestBirdAgents[b];
      if (!fb || fb.state === 'flying' || fb.state === 'landing') continue;
      const bdx = fb.mesh.position.x - origin.x;
      const bdz = fb.mesh.position.z - origin.z;
      if (bdx * bdx + bdz * bdz <= birdR2) {
        triggerBirdFlightToNewPerch(fb, origin.x, origin.z, true);
      }
    }
  }

  function transitionAgentToDying(ag, hitDir = null) {
    if (!ag || ag.isDead || ag.state === 'dying') return;
    if (ag.isShark) {
      ag.isDead = true;
      ag.state = 'dying';
      ag.deathCollapseT = 0;
      ag.collapseSide = Math.random() < 0.5 ? 1 : -1;
    } else {
      ag.isDead = true;
      ag.state = 'dying';
      ag.deathCollapseT = 0;
      ag.collapseSide = Math.random() < 0.5 ? 1 : -1;
      if (hitDir) {
        ag.yaw = Math.atan2(hitDir.x, hitDir.z);
      }
    }
    const u = ag.mesh.userData;
    u.type = 'carcass';
    u.carcassState = 'fresh'; // 'fresh' | 'dressed' | 'skeletal'
    u.harvestProgress = 0;
    u.decayAge = 0;
    u.species = u.species || ag.species || 'deer';
    u.promptLabel = `[Tap/Hold Strike] Field-Dress ${u.species.toUpperCase()} (Fresh)`;
    registerInteractiveTarget(ag.mesh);
    if (!harvestableCarcasses.includes(ag)) {
      harvestableCarcasses.push(ag);
    }
  }

  function applyWildlifeDamage(ag, baseDmg, hitPoint, shooterPos, hitDir, labelOverride = null) {
    if (!ag || !ag.mesh || !ag.mesh.parent) return false;
    const u = ag.mesh.userData || {};
    if (u.type === 'carcass' || ag.isDead || ag.state === 'dying') return false;

    // Vital-zone check (head/chest heart area -> 2.2x damage)
    let isVital = false;
    if (hitPoint) {
      const chestH = ag.species === 'deer' ? 1.15 : (ag.species === 'boar' || ag.species === 'wolf' ? 0.65 : 0.24);
      const fwdX = Math.sin(ag.yaw || 0), fwdZ = Math.cos(ag.yaw || 0);
      const localY = hitPoint.y - ag.mesh.position.y;
      const forwardDot = (hitPoint.x - ag.mesh.position.x) * fwdX + (hitPoint.z - ag.mesh.position.z) * fwdZ;
      if (localY >= chestH * 0.62 && forwardDot >= -0.1) isVital = true;
    }
    const mult = isVital ? 2.2 : 1.0;
    const finalDmg = Math.max(1, Math.round(baseDmg * mult));
    u.health = Math.max(0, (u.health || ag.hp || 2) - finalDmg);
    ag.hp = u.health;
    spawnBloodSpeck(ag.mesh.position.x, ag.mesh.position.y + 0.15, ag.mesh.position.z);

    if (window.triggerHitmarker) {
      window.triggerHitmarker(isVital, u.health <= 0);
    }
    if (AudioEngine._haptic) {
      AudioEngine._haptic(isVital || u.health <= 0 ? 28 : 14);
    }

    if (ag.isShark) {
      if (u.health <= 0) {
        transitionAgentToDying(ag, hitDir);
        showToast('🦈 Shark defeated! Float-harpooned carcass ready to field-dress!');
      } else {
        ag.state = 'flee';
        ag.stateTimer = 6.2;
        ag.yaw = Math.atan2(ag.mesh.position.x - shooterPos.x, ag.mesh.position.z - shooterPos.z);
        showToast(`🦈 ${isVital ? 'CRITICAL FIN/GILL HIT! ' : ''}Struck Shark! (${u.health} HP left)`);
      }
      return true;
    }

    if (u.health <= 0) {
      transitionAgentToDying(ag, hitDir);
      const spName = (u.subType ? `${u.subType} ${u.species}` : u.species).toUpperCase();
      showToast(`${isVital ? '🎯 VITAL KILL! ' : '🏹 Downed '}${spName}! Approach carcass to field-dress!`);
    } else {
      ag.state = 'flee';
      ag.fleeTimer = 7.5;
      ag.yaw = Math.atan2(ag.mesh.position.x - shooterPos.x, ag.mesh.position.z - shooterPos.z);
      const hpRatio = u.health / Math.max(1, ag.maxHp || 4);
      if (hpRatio < 0.48) {
        ag.limpWeight = Math.min(1.0, 0.55 + (0.48 - hpRatio));
      }
      showToast(`${isVital ? '🎯 VITAL HIT! ' : (labelOverride || '')}${u.species.toUpperCase()} wounded (${u.health} HP left — tracking limp)`);
    }
    return true;
  }

  function stepFieldDressCarcass(root, instantTap = false) {
    const u = root.userData;
    const ag = u.agentRef;
    const tool = campaign.activeTool;
    const toolSpeed = (tool === 'hatchet' || tool === 'spear') ? 1.55 : 1.0;
    const stepAmt = instantTap ? 0.42 * toolSpeed : 0.34 * toolSpeed;
    u.harvestProgress = Math.min(1.0, (u.harvestProgress || 0) + stepAmt);
    AudioEngine.playChop();

    const sp = u.species || (ag && ag.species) || 'deer';
    if (u.harvestProgress >= 0.45 && u.carcassState === 'fresh') {
      u.carcassState = 'dressed';
      if (root.traverse) {
        root.traverse(c => {
          if (c.isMesh && c.material && c.material.color) {
            c.material = c.material.clone();
            c.material.color.lerp(new THREE.Color(0x6e2a28), 0.48);
          }
        });
      }
      u.promptLabel = `[Tap Strike] Finish Harvest ${sp.toUpperCase()} (Dressed)`;
    }

    if (u.harvestProgress < 1.0) {
      showToast(`🔪 Field-dressing ${sp.toUpperCase()}... ${Math.round(u.harvestProgress * 100)}%`);
      return;
    }

    u.carcassState = 'skeletal';
    u.promptLabel = `Skeletal Remains (${sp.toUpperCase()})`;
    // Transfer species-accurate survival yields!
    if (sp === 'deer') {
      player.inventory.rawMeat += 4;
      player.inventory.hide += 2;
      player.inventory.bone += 2;
      player.inventory.sinew += 2;
      player.inventory.fat += 1;
      showToast('🦌 Harvested Deer: +4 Venison, +2 Hide, +2 Bone, +2 Sinew, +1 Fat!');
    } else if (sp === 'rabbit') {
      player.inventory.rawMeat += 1;
      player.inventory.hide += 1;
      player.inventory.bone += 1;
      showToast('🐇 Harvested Rabbit: +1 Meat, +1 Small Pelt, +1 Bone!');
    } else if (sp === 'squirrel') {
      player.inventory.rawMeat += 1;
      player.inventory.hide += 1;
      showToast('🐿️ Harvested Squirrel: +1 Game Meat, +1 Fur Scrap!');
    } else if (sp === 'shark') {
      player.inventory.rawMeat += 4;
      player.inventory.rawFish += 2;
      player.inventory.hide += 1;
      player.inventory.bone += 2;
      showToast('🦈 Harvested Shark: +4 Shark Meat, +2 Fish, +1 Shark Skin, +2 Teeth!');
    } else if (sp === 'wolf') {
      player.inventory.rawMeat += 2;
      player.inventory.hide += 2;
      player.inventory.bone += 1;
      player.inventory.sinew += 1;
      showToast('🐺 Harvested Wolf: +2 Steak, +2 Wolf Pelt, +1 Bone, +1 Sinew!');
    } else {
      player.inventory.rawMeat += 2;
      player.inventory.hide += 2;
      player.inventory.bone += 1;
      player.inventory.sinew += 1;
      showToast(`🐗 Harvested ${sp.toUpperCase()}: +2 Pork, +2 Hide, +1 Tusk/Bone, +1 Sinew!`);
    }
    // Leave skeletal remains visually shrunk & bleached on terrain, then remove from interactive
    if (root.traverse) {
      root.traverse(c => {
        if (c.isMesh && c.material && c.material.color) {
          c.material.color.setHex(0xd4cbb8);
        }
      });
    }
    root.scale.multiplyScalar(0.68);
    removeInteractiveTarget(root);
    updateCastawayHUD();
  }
  window.stepFieldDressCarcass = stepFieldDressCarcass;

  function interactCampfireSpit(cfRecord) {
    if (!cfRecord || !cfRecord.cookSlots) return;
    // 1. Prioritize pulling off golden-cooked or burnt items first
    for (let i = 0; i < cfRecord.cookSlots.length; i++) {
      const slot = cfRecord.cookSlots[i];
      if (slot.state === 'cooked') {
        slot.state = 'empty';
        slot.itemType = null;
        slot.cookProgress = 0;
        slot.sizzledReady = false;
        slot.sizzledBurnt = false;
        slot.mesh.visible = false;
        player.inventory.cookedFood++;
        AudioEngine.playSizzle(1.2);
        showToast('🍖 Pulled perfectly golden-cooked ration off the spit! +1 Cooked Ration');
        updateCastawayHUD();
        return;
      } else if (slot.state === 'burnt') {
        slot.state = 'empty';
        slot.itemType = null;
        slot.cookProgress = 0;
        slot.sizzledReady = false;
        slot.sizzledBurnt = false;
        slot.mesh.visible = false;
        player.vitals.hunger = Math.min(100, player.vitals.hunger + 15);
        showToast('🖤 Scraped charred cut off spit (+15 Hunger — watch sizzle timing next time!)');
        updateCastawayHUD();
        return;
      }
    }
    // 2. Otherwise place raw meat or fish onto an empty slot
    const emptySlot = cfRecord.cookSlots.find(s => s.state === 'empty');
    if (emptySlot && (player.inventory.rawMeat > 0 || player.inventory.rawFish > 0)) {
      if (player.inventory.rawMeat > 0) {
        player.inventory.rawMeat--;
        emptySlot.itemType = 'rawMeat';
      } else {
        player.inventory.rawFish--;
        emptySlot.itemType = 'rawFish';
      }
      emptySlot.state = 'raw';
      emptySlot.cookProgress = 0;
      emptySlot.sizzledReady = false;
      emptySlot.sizzledBurnt = false;
      emptySlot.mat.color.setRGB(0.72, 0.29, 0.28);
      emptySlot.mat.roughness = 0.38;
      emptySlot.mesh.visible = true;
      AudioEngine.playSizzle(0.95);
      showToast(`🔥 Skewered Raw ${emptySlot.itemType === 'rawFish' ? 'Fish' : 'Meat'} on Spit Slot ${emptySlot.index + 1}!`);
      updateCastawayHUD();
      return;
    }
    // 3. Report status if all slots busy cooking
    const cookingSlot = cfRecord.cookSlots.find(s => s.state === 'raw' || s.state === 'searing');
    if (cookingSlot) {
      const pct = Math.min(99, Math.round((cookingSlot.cookProgress / 0.85) * 100));
      showToast(`🔥 Roasting on coals (${pct}% seared — wait for golden sizzle!)`);
    } else {
      showToast('🔥 Catch Fish [Slot 3] or Hunt Game to roast on this campfire spit!');
    }
  }
  window.interactCampfireSpit = interactCampfireSpit;

  function detonateDynamiteBlast(pos) {
    AudioEngine.playExplosion();
    addWaterRipple(pos.x, pos.z, 3.6);
    const radius = 11.5;
    let felledTrees = 0;
    let shatteredRocks = 0;
    let downedAnimals = 0;

    // 1. Blast-fell nearby trees with radial away azimuth
    const trees = window.activeEZTrees || [];
    for (let i = 0; i < trees.length; i++) {
      const tr = trees[i];
      if (!tr || !tr.parent || (tr.userData && tr.userData.isFalling)) continue;
      const dx = tr.position.x - pos.x;
      const dz = tr.position.z - pos.z;
      if (dx * dx + dz * dz <= radius * radius) {
        if (window.fellTreeWithPhysics && window.fellTreeWithPhysics(tr, Math.atan2(dx, dz), true)) {
          felledTrees++;
          player.inventory.timber += 3;
        }
      }
    }

    // 2. Blast-harvest nearby rocks & obsidian outcrops
    for (let i = masterInteractiveTargets.length - 1; i >= 0; i--) {
      const obj = masterInteractiveTargets[i];
      if (!obj || !obj.parent) continue;
      const u = obj.userData || {};
      const dx = obj.position.x - pos.x;
      const dz = obj.position.z - pos.z;
      if (dx * dx + dz * dz <= radius * radius) {
        if (u.type === 'rock' || u.type === 'boulder' || u.type === 'obsidian') {
          if (obj.parent) obj.parent.remove(obj);
          removeInteractiveTarget(obj);
          if (u.type === 'obsidian') {
            player.inventory.obsidian += 3;
          }
          player.inventory.stone += 4;
          if (window.spawnWoodchipBurst) window.spawnWoodchipBurst(obj.position.x, obj.position.y, obj.position.z, 0x6a7178, 12);
          shatteredRocks++;
        }
      }
    }

    // 3. Shockwave wildlife damage & stunned fish
    for (let i = 0; i < wildlifeAgents.length; i++) {
      const ag = wildlifeAgents[i];
      if (!ag.mesh.parent || ag.isDead) continue;
      const dx = ag.mesh.position.x - pos.x;
      const dz = ag.mesh.position.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= 13.0) {
        ag.mesh.userData.health = 0;
        transitionAgentToDying(ag, new THREE.Vector3(dx, 0, dz).normalize());
        downedAnimals++;
      }
    }
    for (let s = 0; s < sharkAgents.length; s++) {
      const sh = sharkAgents[s];
      if (!sh.mesh.parent || sh.isDead) continue;
      const dx = sh.mesh.position.x - pos.x;
      const dz = sh.mesh.position.z - pos.z;
      if (dx * dx + dz * dz <= 28.0 * 28.0) {
        sh.state = 'flee';
        sh.stateTimer = 9.0;
        sh.yaw = Math.atan2(dx, dz);
      }
    }
    const wBlast = getWaterInfo(pos.x, pos.z, performance.now() * 0.001);
    let stunnedFish = 0;
    if (wBlast.isWater || pos.y < 1.2) {
      stunnedFish = 2;
      player.inventory.rawFish += 2;
    }

    // Brief flash sphere visual
    const blastFlash = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffab40, transparent: true, opacity: 0.78 })
    );
    blastFlash.position.copy(pos);
    scene.add(blastFlash);
    setTimeout(() => scene.remove(blastFlash), 190);

    alertWildlifeFromGunshot(pos, 145.0);
    showToast(`💥 DYNAMITE DETONATION! Felled ${felledTrees} trees, shattered ${shatteredRocks} rocks${stunnedFish ? `, surfaced +${stunnedFish} Fish` : ''}${downedAnimals ? `, downed ${downedAnimals} fauna` : ''}!`);
    updateCastawayHUD();
  }
  window.detonateDynamiteBlast = detonateDynamiteBlast;

  const activeMuzzleEffects = [];
  function triggerWeaponKickback(weaponType, powerScale = 1.0) {
    const cfg = RANGED_WEAPON_CONFIG[weaponType];
    if (!cfg || !cfg.recoil) return;
    const r = cfg.recoil;
    const scale = Math.max(0.45, Math.min(1.25, powerScale));
    const wr = campaign.weaponRecoil;
    wr.camPitch = Math.min(0.14, wr.camPitch + r.camPitch * scale);
    wr.camYaw += (Math.random() - 0.5) * 2.0 * r.camYawJitter * scale;
    wr.modelZ = Math.min(0.22, wr.modelZ + r.modelZ * scale);
    wr.modelPitch = Math.min(0.45, wr.modelPitch + r.modelPitch * scale);
    wr.fovPunch = Math.min(5.0, wr.fovPunch + r.fovPunch * scale);
    // Subtle authentic upward muzzle climb on firearms
    if (weaponType === 'pistol' || weaponType === 'rifle' || weaponType === 'flare') {
      player.pitch = Math.max(-1.3, Math.min(1.3, player.pitch + r.camPitch * 0.22 * scale));
    }
    if (AudioEngine._haptic && r.hapticMs) {
      AudioEngine._haptic(r.hapticMs);
    }
  }
  window.triggerWeaponKickback = triggerWeaponKickback;

  function spawnMuzzleFlashAndSmoke(weaponType) {
    const cfg = RANGED_WEAPON_CONFIG[weaponType];
    if (!cfg || !cfg.muzzleOffset) return;
    const euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(euler).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyEuler(euler).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyEuler(euler).normalize();
    const aimBlend = campaign.weaponPoseBlend || 0;
    const mOff = cfg.muzzleOffset;
    const muzzlePos = camera.position.clone()
      .addScaledVector(right, mOff.right * (1.0 - aimBlend * 0.65))
      .addScaledVector(up, mOff.up * (1.0 - aimBlend * 0.35))
      .addScaledVector(fwd, mOff.fwd);

    const isFlare = (weaponType === 'flare');
    const flashCol = isFlare ? 0xff3d57 : (weaponType === 'rifle' ? 0xffe082 : 0xffcc66);
    const flashMat = new THREE.MeshBasicMaterial({
      color: flashCol,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const flashMesh = new THREE.Mesh(
      new THREE.SphereGeometry(weaponType === 'rifle' ? 0.11 : (isFlare ? 0.13 : 0.085), 8, 8),
      flashMat
    );
    flashMesh.position.copy(muzzlePos);
    scene.add(flashMesh);

    const smokePuffs = [];
    const puffGeo = new THREE.SphereGeometry(0.065, 6, 6);
    const puffCount = isFlare ? 5 : 4;
    for (let i = 0; i < puffCount; i++) {
      const pMat = new THREE.MeshBasicMaterial({
        color: isFlare ? 0xff8a80 : 0xcfd8dc,
        transparent: true,
        opacity: 0.36,
        depthWrite: false
      });
      const pm = new THREE.Mesh(puffGeo, pMat);
      pm.position.copy(muzzlePos).addScaledVector(fwd, 0.05 * i);
      scene.add(pm);
      smokePuffs.push({
        mesh: pm,
        mat: pMat,
        vel: new THREE.Vector3(
          fwd.x * (1.4 + i * 0.35) + (Math.random() - 0.5) * 0.45,
          0.55 + Math.random() * 0.45,
          fwd.z * (1.4 + i * 0.35) + (Math.random() - 0.5) * 0.45
        )
      });
    }
    activeMuzzleEffects.push({
      flashMesh,
      flashMat,
      smokePuffs,
      age: 0,
      maxLife: 0.44
    });
  }

  window.triggerHitmarker = function (isVital = false, isKill = false) {
    if (AudioEngine.playHitmarker) AudioEngine.playHitmarker(isVital, isKill);
    const hmEl = document.getElementById('cc-hitmarker');
    if (!hmEl) return;
    hmEl.classList.remove('active', 'crit', 'kill');
    void hmEl.offsetWidth;
    hmEl.classList.add('active');
    if (isKill) hmEl.classList.add('kill');
    else if (isVital) hmEl.classList.add('crit');
    clearTimeout(window._hitmarkerTimer);
    window._hitmarkerTimer = setTimeout(() => {
      hmEl.classList.remove('active', 'crit', 'kill');
    }, isKill ? 280 : 190);
  };

  function fireRangedProjectile(weaponType, drawPow = 1.0) {
    let firedAmmoType = 'arrow';
    if (weaponType === 'bow') {
      if ((player.inventory.arrows || 0) <= 0) {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast('🏹 Out of Arrows! Find your shot arrows or craft more in Pack (1 Timber + 1 Flint + 1 Feather).');
        return;
      }
      player.inventory.arrows--;
      firedAmmoType = 'arrow';
      AudioEngine.playBowTwang();
      triggerWeaponKickback('bow', Math.max(0.65, drawPow));
    } else if (weaponType === 'crossbow') {
      if (campaign.crossbowCooldown > 0) {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast(`🎯 Reloading Crossbow (${campaign.crossbowCooldown.toFixed(1)}s)...`);
        return;
      }
      if ((player.inventory.bolts || 0) > 0) {
        player.inventory.bolts--;
        firedAmmoType = 'bolt';
      } else if ((player.inventory.arrows || 0) > 0) {
        player.inventory.arrows--;
        firedAmmoType = 'arrow';
      } else {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast('🎯 Out of Bolts & Arrows! Pick up fired bolts/arrows or craft more in Pack.');
        return;
      }
      campaign.crossbowCooldown = 1.8;
      AudioEngine.playBowTwang();
      if (AudioEngine.playCrossbowReload) AudioEngine.playCrossbowReload();
      triggerWeaponKickback('crossbow', 1.0);
    } else if (weaponType === 'pistol') {
      if ((player.inventory.pistolAmmo || 0) <= 0) {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast('🔫 Out of Pistol Rounds! Search outer island expedition crates.');
        return;
      }
      player.inventory.pistolAmmo--;
      AudioEngine.playRifleShot(true);
      if (AudioEngine.playChamberCycle) AudioEngine.playChamberCycle(false);
      campaign.chamberCycleWeapon = 'pistol';
      campaign.chamberCycleDuration = 0.20;
      campaign.chamberCycleTimer = 0.20;
      alertWildlifeFromGunshot(player.pos, 130.0);
      triggerWeaponKickback('pistol', 1.0);
      spawnMuzzleFlashAndSmoke('pistol');
    } else if (weaponType === 'rifle') {
      if ((player.inventory.rifleAmmo || 0) <= 0) {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast('🎯 Out of Rifle Rounds! Search outer island & deep cave caches.');
        return;
      }
      player.inventory.rifleAmmo--;
      AudioEngine.playRifleShot(false);
      if (AudioEngine.playChamberCycle) AudioEngine.playChamberCycle(true);
      campaign.chamberCycleWeapon = 'rifle';
      campaign.chamberCycleDuration = 0.42;
      campaign.chamberCycleTimer = 0.42;
      alertWildlifeFromGunshot(player.pos, 155.0);
      triggerWeaponKickback('rifle', 1.0);
      spawnMuzzleFlashAndSmoke('rifle');
    }
    updateCastawayHUD();

    const euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(euler).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyEuler(euler).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyEuler(euler).normalize();

    // Launch from the held bow/crossbow position in the player's right hand and converge on the crosshair target point
    const isArrowOrBolt = (weaponType === 'bow' || weaponType === 'crossbow');
    const startPos = isArrowOrBolt
      ? camera.position.clone().addScaledVector(right, 0.14).addScaledVector(up, -0.09).addScaledVector(fwd, 0.56)
      : camera.position.clone().addScaledVector(fwd, 0.75);
    const aimPoint = camera.position.clone().addScaledVector(fwd, 42.0);
    const launchDir = isArrowOrBolt ? aimPoint.sub(startPos).normalize() : fwd.clone();

    const speed = weaponType === 'bow' ? (26.0 + 22.0 * drawPow)
      : weaponType === 'crossbow' ? 58.0
      : weaponType === 'pistol' ? 165.0
      : 280.0;
    const gravity = weaponType === 'bow' ? 9.2 : (weaponType === 'crossbow' ? 6.8 : 2.2);
    const dmg = weaponType === 'bow' ? Math.max(1, Math.round(1 + drawPow * 1.5))
      : weaponType === 'crossbow' ? 3
      : weaponType === 'pistol' ? 3
      : 5;

    // Briefly hide the nocked arrow / loaded bolt on the held weapon mesh right after firing so you see it leave the bow/crossbow
    campaign.arrowReloadVisualTimer = weaponType === 'crossbow' ? 1.6 : 0.42;

    const projMesh = isArrowOrBolt
      ? createFlightArrowMesh(weaponType)
      : new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffd54f }));
    projMesh.position.copy(startPos);
    projMesh.lookAt(startPos.clone().add(launchDir));
    scene.add(projMesh);

    activeProjectiles.push({
      mesh: projMesh,
      pos: startPos.clone(),
      vel: launchDir.clone().multiplyScalar(speed),
      gravity,
      dmg,
      weaponType: firedAmmoType === 'bolt' ? 'crossbow' : (isArrowOrBolt ? 'bow' : weaponType),
      retrievable: isArrowOrBolt,
      age: 0,
      maxLife: (weaponType === 'pistol' || weaponType === 'rifle') ? 0.9 : 6.5
    });
  }
  window.fireRangedProjectile = fireRangedProjectile;

  function throwDynamiteStick() {
    if ((player.inventory.dynamite || 0) <= 0) {
      showToast('🧨 No Dynamite remaining!');
      return;
    }
    player.inventory.dynamite--;
    updateCastawayHUD();
    AudioEngine.playFire();

    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ')).normalize();
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8),
      new THREE.MeshStandardMaterial({ color: 0xb71c1c, emissive: 0xff6d00, emissiveIntensity: 0.7 })
    );
    const startPos = camera.position.clone().addScaledVector(fwd, 0.9);
    stick.position.copy(startPos);
    scene.add(stick);

    activeExplosives.push({
      mesh: stick,
      pos: startPos,
      vel: new THREE.Vector3(fwd.x * 16.5, fwd.y * 14.0 + 4.8, fwd.z * 16.5),
      fuseTimer: 3.2
    });
    showToast('🧨 Lit Dynamite thrown! Take cover — 3.2s fuse!');
  }

  function handleCastawayPrimaryAction(bowReleasePow = null) {
    const tool = campaign.activeTool;
    campaign.toolSwing = 1.0;

    // First check if the player is looking at or standing beside a lodged arrow/bolt or weapon cache (works even while holding Bow/Crossbow!)
    if (lodgedAmmoItems.length > 0) {
      const lookRay = new THREE.Raycaster();
      lookRay.layers.enable(1);
      lookRay.layers.enable(2);
      lookRay.far = 6.2;
      lookRay.setFromCamera(new THREE.Vector2(0, 0), camera);
      const ammoHits = lookRay.intersectObjects(lodgedAmmoItems, true);
      if (ammoHits.length > 0 && ammoHits[0].distance <= 6.2) {
        let aRoot = ammoHits[0].object;
        while (aRoot.parent && aRoot.parent !== scene && (!aRoot.userData || aRoot.userData.type !== 'lodged_ammo')) {
          aRoot = aRoot.parent;
        }
        if (aRoot && aRoot.userData && aRoot.userData.type === 'lodged_ammo' && (aRoot.userData.lodgedAge || 0) > 0.15) {
          pickupLodgedAmmo(aRoot);
          return;
        }
      }
    }

    if (tool === 'bow') {
      fireRangedProjectile('bow', bowReleasePow !== null ? bowReleasePow : 0.72);
      return;
    }
    if (tool === 'crossbow') {
      fireRangedProjectile('crossbow', 1.0);
      return;
    }
    if (tool === 'pistol' || tool === 'rifle') {
      fireRangedProjectile(tool, 1.0);
      return;
    }
    if (tool === 'dynamite') {
      throwDynamiteStick();
      return;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(1);
    raycaster.layers.enable(2);
    raycaster.far = (tool === 'spear') ? 9.5 : 7.5;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObjects(interactiveTargets, true);

    if (hits.length > 0 && hits[0].distance <= raycaster.far) {
      let root = hits[0].object;
      while (root.parent && root.parent !== scene && root.parent !== worldLandmarksGroup && root.parent !== wildlifeGroup && (!root.userData || !root.userData.type)) {
        root = root.parent;
      }
      const u = root.userData || {};

      if (u.type === 'weapon_cache' && !u.opened) {
        u.opened = true;
        const l = u.loot || {};
        if (l.unlock) campaign.unlockedWeapons[l.unlock] = true;
        if (l.pistolAmmo) player.inventory.pistolAmmo += l.pistolAmmo;
        if (l.rifleAmmo) player.inventory.rifleAmmo += l.rifleAmmo;
        if (l.dynamite) player.inventory.dynamite += l.dynamite;
        if (l.arrows) player.inventory.arrows += l.arrows;
        if (l.sinew) player.inventory.sinew += l.sinew;
        if (l.flares) player.inventory.flares += l.flares;
        if (l.obsidian) player.inventory.obsidian += l.obsidian;
        if (u.lid) { u.lid.rotation.x = -0.75; u.lid.position.y += 0.14; u.lid.position.z -= 0.16; }
        if (u.glint) u.glint.visible = false;
        AudioEngine.playChop();
        showToast(`🎁 ${u.desc}`);
        showStoryDialog('EXPEDITION CACHE RECOVERED', u.desc);
        removeInteractiveTarget(root);
        updateCastawayHUD();
        return;
      }

      if (u.type === 'lodged_ammo') {
        pickupLodgedAmmo(root);
        return;
      }

      if (u.type === 'carcass') {
        stepFieldDressCarcass(root, true);
        return;
      }

      if (u.type === 'campfire' && u.cfRecord) {
        interactCampfireSpit(u.cfRecord);
        return;
      }

      if (u.type === 'story_crate') {
        campaign.modulesFound[u.moduleKey] = true;
        AudioEngine.playChop();
        showToast(`✅ ${u.toastMsg}`);
        showStoryDialog('SURVIVOR LOG — AVIONICS RECOVERED', u.toastMsg);
        if (u.crateLight) {
          u.crateLight.userData.disabled = true;
          u.crateLight.intensity = 0;
        }
        if (root.parent) root.parent.remove(root);
        removeInteractiveTarget(root);
        updateCastawayHUD();
        return;
      }

      if (u.type === 'radio_console') {
        const m = campaign.modulesFound;
        const foundCount = (m.cockpitTransponder ? 1 : 0) + (m.submergedBattery ? 1 : 0) + (m.cavernRecorder ? 1 : 0);
        if (campaign.outpostRepaired) {
          showToast('📡 SOS Beacon is broadcasting! Equip the Signal Flare Gun (Slot 5) and fire into the sky!');
        } else if (foundCount < 3) {
          if (player.inventory.obsidian >= 2 && player.inventory.bamboo >= 2) {
            player.inventory.obsidian -= 2;
            player.inventory.bamboo -= 2;
            campaign.outpostRepaired = true;
            AudioEngine.playFire();
            showStoryDialog(
              '📡 SOS DISTRESS BEACON ONLINE!',
              'High-gain radio array repaired using Volcanic Obsidian & Bamboo! Equip your Signal Flare Gun [Slot 5] and fire a crimson flare into the sky to guide the rescue seaplane!'
            );
            updateCastawayHUD();
          } else {
            showStoryDialog(
              'WEATHER OUTPOST TRANSCEIVER OFFLINE',
              `Diagnostic: ${foundCount}/3 Avionics Modules installed. Recover the Transponder (Crash Cove), Isotope Battery (Outer Sentinel ruins), and Signal Amplifier (Basalt Cavern Cenote), or bring 2 Obsidian + 2 Bamboo.`
            );
          }
        } else {
          campaign.outpostRepaired = true;
          AudioEngine.playFire();
          showStoryDialog(
            '📡 SOS DISTRESS BEACON ONLINE!',
            'All 3 Flight 409 modules installed! Equip your Signal Flare Gun [Slot 5] and fire a crimson flare into the sky to signal the rescue plane!'
          );
          updateCastawayHUD();
        }
        return;
      }

      if (u.type === 'bamboo') {
        u.health = (u.health || 2) - 1;
        AudioEngine.playChop();
        if (u.health <= 0) {
          if (u.clumpStalkIds && instBambooStalks) {
            u.clumpStalkIds.forEach(id => instBambooStalks.setMatrixAt(id, zeroMatrix));
            if (instBambooRings && u.clumpRingIds) {
              u.clumpRingIds.forEach(id => instBambooRings.setMatrixAt(id, zeroMatrix));
              instBambooRings.instanceMatrix.needsUpdate = true;
            }
            if (instBambooCrowns && u.clumpCrownIds) {
              u.clumpCrownIds.forEach(id => instBambooCrowns.setMatrixAt(id, zeroMatrix));
              instBambooCrowns.instanceMatrix.needsUpdate = true;
            }
            instBambooStalks.instanceMatrix.needsUpdate = true;
          }
          if (root.parent) root.parent.remove(root);
          removeInteractiveTarget(root);
          player.inventory.bamboo += 2;
          player.inventory.fiber += 1;
          showToast('🎍 Harvested +2 Giant Bamboo & +1 Plant Fiber!');
          updateCastawayHUD();
        } else {
          showToast('🎍 Chopping bamboo stalks...');
        }
        return;
      }

      if (u.type === 'obsidian') {
        u.health = (u.health || 2) - 1;
        AudioEngine.playChop();
        if (u.health <= 0) {
          if (root.parent) root.parent.remove(root);
          removeInteractiveTarget(root);
          player.inventory.obsidian += 2;
          player.inventory.stone += 2;
          if (u.isLavaTubeVein) {
            player.inventory.flint = (player.inventory.flint || 0) + 1;
            showToast('🌋 Mined Magma-Veined Obsidian! +2 Obsidian, +1 Flint & +2 Stone!');
          } else {
            showToast('🖤 Mined +2 Volcanic Obsidian & +2 Stone!');
          }
          updateCastawayHUD();
        } else {
          showToast('⛏️ Chipping volcanic obsidian...');
        }
        return;
      }

      if (u.type === 'summit_brazier') {
        AudioEngine.playFire();
        if (!u.lit) {
          u.lit = true;
          if (u.flame) u.flame.visible = true;
          if (u.ember && u.ember.material) u.ember.material.emissiveIntensity = 1.85;
          player.inventory.obsidian = (player.inventory.obsidian || 0) + 3;
          player.inventory.flares = (player.inventory.flares || 0) + 2;
          player.vitals.temp = 37.4;
          player.vitals.stamina = 100;
          u.promptLabel = 'Mount Caldera Summit Signal Brazier (Lit — Warming +168m Crest)';
          showToast('🌋 Ignited the +168m Mount Caldera Summit Brazier! Found +3 Obsidian & +2 Signal Flares!');
          updateCastawayHUD();
        } else {
          player.vitals.temp = 37.4;
          player.vitals.stamina = 100;
          showToast('🔥 Warmed by the Mount Caldera Summit Signal Brazier (+168m ASL)!');
        }
        return;
      }

      if (u.type === 'wildlife') {
        const dmg = (tool === 'spear') ? 2 : 1;
        AudioEngine.playChop();
        const ag = u.agentRef;
        if (ag) {
          applyWildlifeDamage(ag, dmg, hits[0].point, player.pos, new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)));
        }
        return;
      }

      if (u.type === 'fish') {
        if (root.parent) root.parent.remove(root);
        removeInteractiveTarget(root);
        player.inventory.rawFish += 1;
        AudioEngine.playSplash();
        showToast('🐟 Speared fresh Reef Fish! +1 Raw Fish');
        updateCastawayHUD();
        return;
      }

      if (u.type === 'cookrack') {
        if (player.inventory.rawFish > 0 || player.inventory.rawMeat > 0) {
          if (player.inventory.rawFish > 0) player.inventory.rawFish--;
          else player.inventory.rawMeat--;
          player.inventory.cookedFood++;
          AudioEngine.playFire();
          showToast('🍖 Spit-roasted a hot meal! +1 Cooked Ration');
          updateCastawayHUD();
        } else if (player.inventory.cookedFood > 0) {
          player.inventory.cookedFood--;
          player.vitals.hunger = Math.min(100, player.vitals.hunger + 45);
          player.vitals.hp = Math.min(100, player.vitals.hp + 20);
          showToast('🍖 Ate roasted island ration! +45 Hunger, +20 HP');
          updateCastawayHUD();
        } else {
          showToast('🔥 Catch fish or hunt wildlife first to roast on the spit!');
        }
        return;
      }

      if (u.type === 'raincatcher') {
        player.vitals.thirst = Math.min(100, player.vitals.thirst + 40);
        AudioEngine.playSplash('scoop');
        showToast('💧 Drank fresh purified rainwater! +40 Hydration');
        updateCastawayHUD();
        return;
      }

      if (u.type === 'crabtrap') {
        player.inventory.rawMeat += 1;
        AudioEngine.playChop();
        showToast('🦀 Collected Shoreline Crab from trap! +1 Raw Meat');
        updateCastawayHUD();
        return;
      }
    }

    if (tool === 'build') {
      placeModularStructure();
      return;
    }

    if (tool === 'rod') {
      handleFishingCastOrReel();
      return;
    }

    if (tool === 'flare') {
      fireSignalFlare();
      return;
    }

    if (window.triggerSwing) {
      window.triggerSwing();
      updateCastawayHUD();
    }
  }

  function handleFishingCastOrReel() {
    const fs = campaign.fishingState;
    if (!fs.cast) {
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, player.yaw, 0));
      const bx = player.pos.x + fwd.x * 7.5;
      const bz = player.pos.z + fwd.z * 7.5;
      const w = getWaterInfo(bx, bz, performance.now() * 0.001);
      if (!w.isWater) {
        showToast('🎣 Aim at the river, lagoon, or cliff-top lake to cast your fishing line!');
        return;
      }
      const isPlungeOrPointBar = Math.hypot(bx - 21.5, bz - 2.0) < 15.0
        || Math.hypot(bx - (-14.5), bz - 124.0) < 16.0
        || Math.hypot(bx - 88.0, bz - 214.0) < 28.0
        || Math.hypot(bx - 46.0, bz - 178.0) < 16.0;
      fs.cast = true;
      fs.isPrimeSpot = isPlungeOrPointBar;
      fs.biteTimer = (isPlungeOrPointBar ? 1.5 : 2.5) + Math.random() * 1.4;
      fs.biting = false;
      fs.bobberPos.set(bx, w.surfaceY, bz);
      fishingBobber.position.copy(fs.bobberPos);
      fishingBobber.visible = true;
      addWaterRipple(bx, bz, 1.4);
      AudioEngine.playSplash();
      showToast(isPlungeOrPointBar
        ? '🎣 Cast into prime Plunge-Pool / Point-Bar eddy! Trout are schooling here!'
        : '🎣 Line cast! Wait for the bobber to plunge, then tap Strike to reel in!');
    } else {
      if (fs.biting) {
        const bonus = fs.isPrimeSpot ? 2 : 1;
        player.inventory.rawFish += bonus;
        AudioEngine.playSplash();
        addWaterRipple(fs.bobberPos.x, fs.bobberPos.z, 1.8);
        showToast(fs.isPrimeSpot
          ? '🐟 Caught a Trophy Waterfall Plunge Trout! +2 Raw Fish!'
          : '🐟 Caught a prized Caldera Trout! +1 Raw Fish (Cook at any campfire spit!)');
        updateCastawayHUD();
      } else {
        showToast('🎣 Reeled line back in early.');
      }
      fs.cast = false;
      fs.biting = false;
      fishingBobber.visible = false;
    }
  }

  function fireSignalFlare() {
    if (player.inventory.flares <= 0) {
      if (AudioEngine.playDryFire) AudioEngine.playDryFire();
      showToast('⚠️ Out of Signal Flares! Craft more in Pack (1 Obsidian + 1 Bamboo).');
      return;
    }
    player.inventory.flares--;
    updateCastawayHUD();
    if (AudioEngine.playFlareLaunch) AudioEngine.playFlareLaunch();
    else AudioEngine.playFire();
    triggerWeaponKickback('flare', 1.0);
    spawnMuzzleFlashAndSmoke('flare');

    const caveHit = window.getCaveNavigationInfo ? window.getCaveNavigationInfo(camera.position.x, camera.position.z, player.pos.y) : null;
    const inCave = !!(caveHit && caveHit.isInside);
    const launchPitch = inCave ? Math.max(-0.35, Math.min(0.45, player.pitch)) : Math.max(0.45, player.pitch);
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(launchPitch, player.yaw, 0));
    const flareMesh = new THREE.Mesh(
      new THREE.SphereGeometry(inCave ? 0.16 : 0.28, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff1744 })
    );
    flareMesh.position.copy(camera.position).addScaledVector(fwd, 1.0);
    scene.add(flareMesh);

    const virtualFlareLight = {
      color: new THREE.Color(0xff1744),
      intensity: inCave ? 3.8 : 4.5,
      distance: inCave ? 36.0 : 95.0,
      decay: inCave ? 1.65 : 1.35,
      userData: { disabled: false }
    };
    const flareLightEntry = {
      light: virtualFlareLight,
      worldPos: flareMesh.position,
      maxDistSq: 110 * 110
    };
    managedPointLights.push(flareLightEntry);

    const flareObj = {
      mesh: flareMesh,
      lightEntry: flareLightEntry,
      isCaveFlare: inCave,
      vel: inCave
        ? new THREE.Vector3(fwd.x * 11.5, Math.max(1.2, fwd.y * 8.0 + 2.2), fwd.z * 11.5)
        : new THREE.Vector3(fwd.x * 18, Math.max(22, fwd.y * 28), fwd.z * 18),
      age: 0,
      maxLife: inCave ? 28.0 : 14.0
    };
    activeSkyFlares.push(flareObj);
    if (inCave && Array.isArray(campaign.activeFlares)) {
      campaign.activeFlares.push(flareObj);
    }

    if (inCave) {
      showToast('🧨 Signal Flare tossed into cavern — burning crimson for 28s!');
    } else if (campaign.outpostRepaired && !campaign.rescueTriggered) {
      campaign.rescueTriggered = true;
      showStoryDialog(
        '✈️ RESCUE SEAPLANE INBOUND — CAMPAIGN COMPLETE!',
        'Coast Guard Cutter & Rescue Twin-Otter have locked onto your repaired Radio Outpost beacon and crimson sky flare! You survived the Caldera Archipelago! You may continue exploring & building freely.'
      );
      updateCastawayHUD();
    } else {
      showToast('🎇 Crimson Signal Flare launched into the sky!');
    }
  }

  function tryDirectAmmoOrCachePickup() {
    if (lodgedAmmoItems.length > 0) {
      const lookRay = new THREE.Raycaster();
      lookRay.layers.enable(1);
      lookRay.layers.enable(2);
      lookRay.far = 6.2;
      lookRay.setFromCamera(new THREE.Vector2(0, 0), camera);
      const ammoHits = lookRay.intersectObjects(lodgedAmmoItems, true);
      if (ammoHits.length > 0 && ammoHits[0].distance <= 6.2) {
        let aRoot = ammoHits[0].object;
        while (aRoot.parent && aRoot.parent !== scene && (!aRoot.userData || aRoot.userData.type !== 'lodged_ammo')) {
          aRoot = aRoot.parent;
        }
        if (aRoot && aRoot.userData && aRoot.userData.type === 'lodged_ammo' && (aRoot.userData.lodgedAge || 0) > 0.15) {
          return pickupLodgedAmmo(aRoot);
        }
      }
    }
    return false;
  }

  const strikeBtn = document.getElementById('btn-strike');
  if (strikeBtn) {
    const newStrikeBtn = strikeBtn.cloneNode(true);
    strikeBtn.parentNode.replaceChild(newStrikeBtn, strikeBtn);

    const getCancelRectWithSlop = () => {
      const cancelEl = document.getElementById('cc-cancel-aim');
      if (!cancelEl || cancelEl.style.display === 'none') return null;
      const r = cancelEl.getBoundingClientRect();
      const slop = 12;
      return { left: r.left - slop, right: r.right + slop, top: r.top - slop, bottom: r.bottom + slop, el: cancelEl };
    };

    const isInsideCancelZone = (clientX, clientY) => {
      const box = getCancelRectWithSlop();
      if (!box) return false;
      return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    };

    const beginRangedAim = (mode, touchId, clientX, clientY) => {
      const tool = campaign.activeTool;
      const cfg = RANGED_WEAPON_CONFIG[tool];
      if (!cfg) return false;
      if (getRangedAmmoCount(tool) <= 0) {
        if (!tryDirectAmmoOrCachePickup()) {
          if (AudioEngine.playDryFire) AudioEngine.playDryFire();
          if (AudioEngine._haptic) AudioEngine._haptic(10);
          showToast(cfg.emptyMsg);
        }
        return false;
      }
      if (tool === 'crossbow' && campaign.crossbowCooldown > 0) {
        if (AudioEngine.playDryFire) AudioEngine.playDryFire();
        showToast(`🎯 Reloading Crossbow (${campaign.crossbowCooldown.toFixed(1)}s)...`);
        return false;
      }
      const aim = campaign.rangedAim;
      aim.active = true;
      aim.tool = tool;
      aim.pointerMode = mode;
      aim.touchId = touchId;
      aim.lastX = clientX;
      aim.lastY = clientY;
      aim.startX = clientX;
      aim.startY = clientY;
      aim.holdTime = 0;
      aim.overCancel = false;
      aim.breathHapticFired = false;

      if (tool === 'bow') {
        campaign.bowDraw.holding = true;
        campaign.bowDraw.holdTime = 0;
        campaign.bowDraw.power = 0.25;
        if (AudioEngine.playBowDrawCreak) AudioEngine.playBowDrawCreak();
      }
      newStrikeBtn.classList.add('aiming');
      const cancelEl = document.getElementById('cc-cancel-aim');
      if (cancelEl) {
        cancelEl.style.display = 'flex';
        cancelEl.classList.remove('hover-cancel');
      }
      return true;
    };

    const moveRangedAim = (clientX, clientY) => {
      const aim = campaign.rangedAim;
      if (!aim.active) return;
      const cfg = RANGED_WEAPON_CONFIG[aim.tool];
      if (!cfg) return;
      const dx = clientX - aim.lastX;
      const dy = clientY - aim.lastY;
      aim.lastX = clientX;
      aim.lastY = clientY;

      const steadyMult = (aim.tool === 'bow' && window._bowBreathSteady) ? 0.84 : 1.0;
      const sens = cfg.sensScale * steadyMult;
      player.yaw -= dx * 0.005 * sens;
      player.pitch = Math.max(-1.3, Math.min(1.3, player.pitch - dy * 0.004 * sens));

      const nowOver = isInsideCancelZone(clientX, clientY);
      if (nowOver !== aim.overCancel) {
        aim.overCancel = nowOver;
        const cancelEl = document.getElementById('cc-cancel-aim');
        if (cancelEl) cancelEl.classList.toggle('hover-cancel', nowOver);
        if (nowOver && AudioEngine._haptic) AudioEngine._haptic(12);
      }
    };

    const finishRangedAim = (clientX, clientY, forceCancel = false) => {
      const aim = campaign.rangedAim;
      if (!aim.active) return;
      const tool = aim.tool;
      const wasCanceled = forceCancel || aim.overCancel || isInsideCancelZone(clientX, clientY);
      const dragDist = Math.hypot(clientX - aim.startX, clientY - aim.startY);
      const quickTap = aim.holdTime < 0.18 && dragDist < 10;
      const bowPow = Math.min(
        1.15,
        Math.max(0.45, (campaign.bowDraw.power || 0.72) * (window._bowBreathSteady ? 1.15 : 1.0))
      );

      resetRangedAimState();
      if (wasCanceled) {
        showToast('❌ Shot canceled');
        return;
      }
      if (quickTap && tryDirectAmmoOrCachePickup()) {
        return;
      }
      if (tool === 'bow') {
        handleCastawayPrimaryAction(bowPow);
      } else {
        handleCastawayPrimaryAction();
      }
    };

    let nonRangedTouchId = null;

    newStrikeBtn.addEventListener('touchstart', e => {
      e.stopPropagation();
      e.preventDefault();
      AudioEngine.init();
      const t = e.changedTouches[0];
      if (!t) return;
      if (isRangedAimTool(campaign.activeTool)) {
        beginRangedAim('touch', t.identifier, t.clientX, t.clientY);
      } else {
        nonRangedTouchId = t.identifier;
      }
    }, { passive: false });

    newStrikeBtn.addEventListener('touchend', e => {
      e.stopPropagation();
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (campaign.rangedAim.active && campaign.rangedAim.pointerMode === 'touch' && t.identifier === campaign.rangedAim.touchId) {
          finishRangedAim(t.clientX, t.clientY, false);
        } else if (t.identifier === nonRangedTouchId) {
          nonRangedTouchId = null;
          handleCastawayPrimaryAction();
        }
      }
    }, { passive: false });

    newStrikeBtn.addEventListener('touchcancel', e => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (campaign.rangedAim.active && campaign.rangedAim.pointerMode === 'touch' && t.identifier === campaign.rangedAim.touchId) {
          finishRangedAim(t.clientX, t.clientY, true);
        } else if (t.identifier === nonRangedTouchId) {
          nonRangedTouchId = null;
        }
      }
    });

    // Window-level touchmove / touchend / touchcancel so sliding thumb anywhere across screen steers aim seamlessly
    window.addEventListener('touchmove', e => {
      if (!campaign.rangedAim.active || campaign.rangedAim.pointerMode !== 'touch') return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === campaign.rangedAim.touchId) {
          e.preventDefault();
          moveRangedAim(t.clientX, t.clientY);
          break;
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', e => {
      if (!campaign.rangedAim.active || campaign.rangedAim.pointerMode !== 'touch') return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === campaign.rangedAim.touchId) {
          finishRangedAim(t.clientX, t.clientY, false);
          break;
        }
      }
    });

    window.addEventListener('touchcancel', e => {
      if (!campaign.rangedAim.active || campaign.rangedAim.pointerMode !== 'touch') return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === campaign.rangedAim.touchId) {
          finishRangedAim(t.clientX, t.clientY, true);
          break;
        }
      }
    });

    // Desktop mouse hold-drag-release & tap fallback
    let mouseHandledStrike = false;
    newStrikeBtn.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      AudioEngine.init();
      mouseHandledStrike = true;
      if (isRangedAimTool(campaign.activeTool)) {
        beginRangedAim('mouse', null, e.clientX, e.clientY);
      } else {
        handleCastawayPrimaryAction();
      }
    });
    window.addEventListener('mousemove', e => {
      if (!campaign.rangedAim.active || campaign.rangedAim.pointerMode !== 'mouse') return;
      moveRangedAim(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', e => {
      if (!campaign.rangedAim.active || campaign.rangedAim.pointerMode !== 'mouse') return;
      finishRangedAim(e.clientX, e.clientY, false);
    });
    newStrikeBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (mouseHandledStrike) {
        mouseHandledStrike = false;
        return;
      }
      handleCastawayPrimaryAction();
    });
  }

  const promptActionEl = document.getElementById('interaction-prompt');
  if (promptActionEl) {
    const onPromptTap = e => {
      e.stopPropagation();
      if (e.type === 'touchend') e.preventDefault();
      handleCastawayPrimaryAction();
    };
    promptActionEl.addEventListener('click', onPromptTap);
    promptActionEl.addEventListener('touchend', onPromptTap);
  }

  // ============================================================================
  // 12. UI OVERLAYS: TITLE SCREEN, STORY AUDIO-LOGS, TOOL DOCK & CRAFTING MODAL
  // ============================================================================
  function buildCastawayUI() {
    const style = document.createElement('style');
    style.textContent = `
      #cc-objective-card {
        display: none !important;
      }
      #cc-tool-dock {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 10px) + 12px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 46;
        display: flex;
        align-items: center;
        gap: 5px;
        background: rgba(8, 15, 22, 0.72);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        padding: 4px 6px;
        border-radius: 15px;
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      }
      #cc-bow-arc {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 44px;
        height: 44px;
        pointer-events: none;
        z-index: 48;
        display: none;
        border: 2px dashed rgba(255, 213, 79, 0.72);
        border-radius: 50%;
        transition: width 0.08s ease, height 0.08s ease, border-color 0.12s ease, transform 0.12s ease;
      }
      #cc-bow-arc.reticle-crossbow {
        border-style: solid;
        border-width: 1.5px;
        border-color: rgba(128, 216, 255, 0.75);
      }
      #cc-bow-arc.reticle-pistol,
      #cc-bow-arc.reticle-rifle {
        border-style: solid;
        border-width: 1.5px;
        border-color: rgba(255, 255, 255, 0.65);
        width: 30px;
        height: 30px;
      }
      #cc-bow-arc.reticle-rifle::before,
      #cc-bow-arc.reticle-rifle::after {
        content: '';
        position: absolute;
        background: rgba(38, 230, 198, 0.75);
      }
      #cc-bow-arc.reticle-rifle::before {
        top: 50%; left: -7px; right: -7px; height: 1px; transform: translateY(-50%);
      }
      #cc-bow-arc.reticle-rifle::after {
        left: 50%; top: -7px; bottom: -7px; width: 1px; transform: translateX(-50%);
      }
      #cc-bow-arc.reticle-flare {
        border-style: dashed;
        border-color: rgba(255, 82, 82, 0.78);
        width: 36px;
        height: 36px;
      }
      #cc-bow-arc.is-aiming {
        box-shadow: 0 0 14px rgba(38, 230, 198, 0.35);
      }
      #cc-aim-badge {
        position: fixed;
        top: calc(50% - 48px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 48;
        pointer-events: none;
        display: none;
        white-space: nowrap;
        font-size: 9.5px;
        font-weight: 800;
        letter-spacing: 0.3px;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(8, 15, 22, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: #f4f9fc;
        font-variant-numeric: tabular-nums;
      }
      #cc-hitmarker {
        position: fixed;
        top: 50%;
        left: 50%;
        width: 24px;
        height: 24px;
        transform: translate(-50%, -50%) scale(0.7);
        pointer-events: none;
        z-index: 49;
        opacity: 0;
      }
      #cc-hitmarker span {
        position: absolute;
        width: 8px;
        height: 2px;
        background: #ffffff;
        border-radius: 2px;
        box-shadow: 0 0 4px rgba(0, 0, 0, 0.7);
      }
      #cc-hitmarker span:nth-child(1) { top: 4px; left: 1px; transform: rotate(45deg); }
      #cc-hitmarker span:nth-child(2) { top: 4px; right: 1px; transform: rotate(-45deg); }
      #cc-hitmarker span:nth-child(3) { bottom: 4px; left: 1px; transform: rotate(-45deg); }
      #cc-hitmarker span:nth-child(4) { bottom: 4px; right: 1px; transform: rotate(45deg); }
      #cc-hitmarker.active {
        animation: ccHitPop 0.19s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      #cc-hitmarker.crit span {
        background: #ffca58;
        box-shadow: 0 0 8px rgba(255, 202, 88, 0.85);
      }
      #cc-hitmarker.kill span {
        background: #ff5252;
        width: 10px;
        height: 2.5px;
        box-shadow: 0 0 10px rgba(255, 82, 82, 0.9);
      }
      @keyframes ccHitPop {
        0% { opacity: 1; transform: translate(-50%, -50%) scale(0.75); }
        45% { opacity: 1; transform: translate(-50%, -50%) scale(1.22); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(1.0); }
      }
      #cc-cancel-aim {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 14px) + 156px);
        right: 16px;
        min-width: 76px;
        min-height: 48px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(18, 12, 16, 0.82);
        border: 1.5px solid rgba(255, 94, 98, 0.58);
        color: #ffcdd2;
        font-size: 11px;
        font-weight: 800;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 4px;
        z-index: 52;
        pointer-events: none;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
        transition: transform 0.12s ease, background 0.12s ease, border-color 0.12s ease;
      }
      #cc-cancel-aim.hover-cancel {
        background: rgba(255, 68, 76, 0.92);
        border-color: #ffffff;
        color: #ffffff;
        transform: scale(1.08);
        box-shadow: 0 0 20px rgba(255, 82, 82, 0.72);
      }
      #cc-cook-panel {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 8px) + 68px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 47;
        display: none;
        gap: 6px;
        background: rgba(12, 18, 26, 0.88);
        border: 1px solid rgba(255, 167, 38, 0.45);
        border-radius: 14px;
        padding: 5px 10px;
        color: #ffecb3;
        font-size: 11px;
        align-items: center;
      }
      .cc-cook-slot-btn {
        min-height: 36px;
        padding: 4px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255, 183, 77, 0.4);
        background: rgba(255, 138, 40, 0.16);
        color: #fff3e0;
        font-size: 10px;
        font-weight: 700;
        cursor: pointer;
      }
      .cc-tool-slot {
        flex: 0 0 auto;
        width: 48px;
        height: 48px;
        border-radius: 11px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.05);
        color: #dbe9f6;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-size: 8.5px;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        transition: transform 0.12s ease, background 0.15s ease;
      }
      .cc-tool-slot:active { transform: scale(0.92); }
      .cc-tool-slot span.ico { font-size: 15px; line-height: 1.1; }
      .cc-tool-slot.active {
        background: linear-gradient(135deg, rgba(38, 230, 198, 0.34), rgba(0, 176, 255, 0.30));
        border-color: #26e6c6;
        color: #ffffff;
        box-shadow: 0 0 12px rgba(38, 230, 198, 0.35);
      }
      .cc-tool-slot.pack-slot {
        background: rgba(255, 202, 88, 0.14);
        border-color: rgba(255, 202, 88, 0.45);
        color: #ffe082;
      }
      #cc-raft-btn {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 8px) + 68px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 47;
        background: linear-gradient(135deg, #00b0ff, #00e676);
        color: #04141e;
        font-weight: 800;
        font-size: 12px;
        padding: 8px 16px;
        border-radius: 999px;
        border: none;
        box-shadow: 0 6px 20px rgba(0, 230, 118, 0.45);
        display: none;
        cursor: pointer;
      }
      #cc-dialog-banner {
        position: fixed;
        top: calc(max(env(safe-area-inset-top, 12px), 40px) + 56px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 65;
        background: rgba(8, 16, 24, 0.88);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(38, 230, 198, 0.48);
        border-radius: 14px;
        padding: 9px 13px;
        color: #ffffff;
        max-width: 380px;
        width: calc(100vw - 28px);
        display: none;
        box-shadow: 0 10px 28px rgba(0,0,0,0.5);
      }
      @media (max-width: 680px) {
        #cc-tool-dock {
          bottom: calc(env(safe-area-inset-bottom, 6px) + 8px);
          width: min(calc(100vw - 16px), 316px);
          justify-content: space-between;
          gap: 4px;
          padding: 4px 5px;
        }
        .cc-tool-slot {
          flex: 1 1 0;
          width: auto;
          min-width: 48px;
          height: 48px;
          font-size: 8px;
        }
        #cc-cancel-aim {
          bottom: calc(env(safe-area-inset-bottom, 10px) + 206px);
          right: 12px;
        }
        #cc-cook-panel,
        #cc-raft-btn {
          bottom: calc(env(safe-area-inset-bottom, 10px) + 264px);
        }
        #cc-dialog-banner {
          top: calc(max(env(safe-area-inset-top, 10px), 40px) + 118px);
        }
        body.pod-drawer-open #cc-dialog-banner {
          top: calc(max(env(safe-area-inset-top, 10px), 40px) + 164px);
        }
        #cc-naval-hud {
          top: calc(max(env(safe-area-inset-top, 10px), 40px) + 118px) !important;
          max-width: calc(100vw - 24px);
          white-space: normal !important;
          text-align: center;
        }
      }
      @media (max-height: 460px) and (min-width: 560px) {
        #cc-tool-dock {
          bottom: 8px;
          gap: 4px;
          padding: 3px 5px;
        }
        .cc-tool-slot {
          width: 48px;
          height: 48px;
          font-size: 8px;
        }
        #cc-cancel-aim {
          bottom: 140px;
          right: 14px;
        }
      }
      #cc-title-screen {
        position: fixed;
        inset: 0;
        z-index: 120;
        background: radial-gradient(circle at center, rgba(6, 18, 32, 0.35) 0%, rgba(3, 10, 18, 0.82) 100%);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .cc-title-card {
        background: rgba(9, 19, 28, 0.90);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 22px;
        padding: 22px 24px;
        max-width: 400px;
        width: 100%;
        color: #f0f7ff;
        text-align: center;
        box-shadow: 0 20px 50px rgba(0,0,0,0.65);
      }
      .cc-btn-primary {
        background: linear-gradient(135deg, #26e6c6, #00b0ff);
        color: #03131d;
        border: none;
        border-radius: 13px;
        padding: 12px 18px;
        font-weight: 800;
        font-size: 14px;
        cursor: pointer;
        width: 100%;
        margin-top: 10px;
      }
      .cc-btn-secondary {
        background: rgba(255,255,255,0.08);
        color: #e0f2fe;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 12px;
        padding: 9px 14px;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
        width: 100%;
        margin-top: 7px;
      }
      #cc-craft-modal {
        position: fixed;
        inset: 0;
        z-index: 95;
        background: rgba(3, 10, 18, 0.72);
        backdrop-filter: blur(8px);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 14px;
      }
      .cc-craft-box {
        background: rgba(10, 20, 30, 0.96);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 20px;
        max-width: 520px;
        width: 100%;
        max-height: 86vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 14px;
        color: #eaf4ff;
      }
      .cc-pack-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      #cc-close-craft {
        background: rgba(255,255,255,0.10);
        border: 1px solid rgba(255,255,255,0.18);
        color: #fff;
        min-width: 48px;
        height: 48px;
        border-radius: 50%;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .cc-pack-res-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
        padding: 6px 9px;
        background: rgba(255,255,255,0.05);
        border-radius: 10px;
        font-size: 10.5px;
        font-weight: 700;
        color: #b2ebf2;
        flex-shrink: 0;
      }
      .cc-pack-tabs {
        display: flex;
        gap: 4px;
        margin-top: 10px;
        padding: 4px;
        background: rgba(0, 0, 0, 0.42);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 13px;
        flex-shrink: 0;
      }
      .cc-pack-tab {
        flex: 1;
        min-height: 44px;
        border: none;
        border-radius: 9px;
        background: transparent;
        color: rgba(216, 232, 242, 0.76);
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 4px 6px;
        transition: background 0.16s ease, color 0.16s ease;
      }
      .cc-pack-tab.active {
        background: #26e6c6;
        color: #041410;
        box-shadow: 0 2px 10px rgba(38, 230, 198, 0.35);
      }
      .cc-pack-body {
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        margin-top: 10px;
        padding-right: 2px;
        flex: 1 1 auto;
      }
      .cc-pack-pane { display: none; }
      .cc-pack-pane.active { display: block; }
      .cc-arsenal-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
        gap: 6px;
      }
      .cc-arsenal-grid .cc-tool-slot.locked {
        opacity: 0.48;
        border-style: dashed;
      }
      .cc-craft-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
      }
      .cc-craft-grid .cc-btn-secondary,
      .cc-travel-grid .cc-btn-secondary {
        min-height: 48px;
        margin-top: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        line-height: 1.2;
      }
      .cc-travel-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        margin-top: 8px;
      }
      .cc-recipe-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
        gap: 7px;
      }
      .cc-recipe-item {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 12px;
        padding: 9px;
        min-height: 48px;
        font-size: 11px;
        cursor: pointer;
      }
      .cc-recipe-item.active {
        border-color: #26e6c6;
        background: rgba(38, 230, 198, 0.16);
      }
      .cc-section-lbl {
        font-size: 10.5px;
        font-weight: 800;
        letter-spacing: 0.06em;
        color: #80d8ff;
        text-transform: uppercase;
        margin-top: 4px;
        margin-bottom: 6px;
      }
      @media (max-width: 400px) {
        .cc-craft-box { padding: 11px; }
        .cc-pack-tab { font-size: 10px; padding: 4px 3px; }
        .cc-craft-grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);

    const bowArcEl = document.createElement('div');
    bowArcEl.id = 'cc-bow-arc';
    document.body.appendChild(bowArcEl);

    const aimBadgeEl = document.createElement('div');
    aimBadgeEl.id = 'cc-aim-badge';
    document.body.appendChild(aimBadgeEl);

    const hitmarkerEl = document.createElement('div');
    hitmarkerEl.id = 'cc-hitmarker';
    hitmarkerEl.innerHTML = '<span></span><span></span><span></span><span></span>';
    document.body.appendChild(hitmarkerEl);

    const cancelAimEl = document.createElement('div');
    cancelAimEl.id = 'cc-cancel-aim';
    cancelAimEl.innerHTML = '<span>✕</span><span>Cancel</span>';
    document.body.appendChild(cancelAimEl);

    // Wire Survivor Pod collapsible smart-reveal drawer (tap to expand, or peek 3.2s on harvest)
    const podEl = document.getElementById('survivor-pod');
    if (podEl) {
      const togglePodDrawer = e => {
        if (e.target && (e.target.id === 'cc-weather-badge' || e.target.closest('#cc-weather-badge'))) return;
        e.stopPropagation();
        const expanded = podEl.classList.toggle('pod-expanded');
        document.body.classList.toggle(
          'pod-drawer-open',
          expanded || podEl.classList.contains('pod-peek') || podEl.classList.contains('pod-alert')
        );
      };
      podEl.addEventListener('click', togglePodDrawer);
      podEl.addEventListener('touchend', e => {
        if (e.target && (e.target.id === 'cc-weather-badge' || e.target.closest('#cc-weather-badge'))) return;
        e.preventDefault();
        togglePodDrawer(e);
      });
      window._peekSurvivorPod = () => {
        podEl.classList.add('pod-peek');
        document.body.classList.add('pod-drawer-open');
        clearTimeout(window._podPeekTimer);
        window._podPeekTimer = setTimeout(() => {
          podEl.classList.remove('pod-peek');
          document.body.classList.toggle(
            'pod-drawer-open',
            podEl.classList.contains('pod-expanded') || podEl.classList.contains('pod-alert')
          );
        }, 3200);
      };
    }

    const cookPanel = document.createElement('div');
    cookPanel.id = 'cc-cook-panel';
    cookPanel.innerHTML = `<span style="font-weight:800;">🔥 Spit:</span><button class="cc-cook-slot-btn" data-slot="0">Slot 1</button><button class="cc-cook-slot-btn" data-slot="1">Slot 2</button><button class="cc-cook-slot-btn" data-slot="2">Stone</button>`;
    document.body.appendChild(cookPanel);
    cookPanel.querySelectorAll('.cc-cook-slot-btn').forEach(btn => {
      const slotIdx = Number(btn.dataset.slot);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const camps = window.activeCampfires || [];
        let nearestCf = null, minD = 5.2;
        for (let c = 0; c < camps.length; c++) {
          const cf = camps[c];
          if (!cf || !cf.group) continue;
          const d = Math.hypot(cf.group.position.x - player.pos.x, cf.group.position.z - player.pos.z);
          if (d < minD) { minD = d; nearestCf = cf; }
        }
        if (nearestCf && nearestCf.cookSlots && nearestCf.cookSlots[slotIdx]) {
          const sl = nearestCf.cookSlots[slotIdx];
          if (sl.state === 'cooked' || sl.state === 'burnt') {
            if (sl.state === 'cooked') { player.inventory.cookedFood++; showToast('🍖 Golden-cooked ration pulled off spit!'); AudioEngine.playSizzle(1.2); }
            else { player.vitals.hunger = Math.min(100, player.vitals.hunger + 15); showToast('🖤 Charred scrap eaten (+15 Hunger).'); }
            sl.state = 'empty'; sl.itemType = null; sl.cookProgress = 0; sl.sizzledReady = false; sl.sizzledBurnt = false; sl.mesh.visible = false;
            updateCastawayHUD();
          } else if (sl.state === 'empty') {
            if (player.inventory.rawMeat > 0 || player.inventory.rawFish > 0) {
              if (player.inventory.rawMeat > 0) { player.inventory.rawMeat--; sl.itemType = 'rawMeat'; }
              else { player.inventory.rawFish--; sl.itemType = 'rawFish'; }
              sl.state = 'raw'; sl.cookProgress = 0; sl.sizzledReady = false; sl.sizzledBurnt = false;
              sl.mat.color.setRGB(0.72, 0.29, 0.28); sl.mat.roughness = 0.38; sl.mesh.visible = true;
              AudioEngine.playSizzle(0.95);
              updateCastawayHUD();
            } else {
              showToast('⚠️ No Raw Fish or Meat in inventory!');
            }
          } else {
            showToast(`🔥 Slot ${slotIdx + 1} roasting (${Math.min(99, Math.round((sl.cookProgress / 0.85) * 100))}%)...`);
          }
        }
      });
    });

    // Clean 5-Slot Quick Belt (4 Active Tool Slots + 1 Pack/Crafting Drawer Button)
    const dock = document.createElement('div');
    dock.id = 'cc-tool-dock';
    dock.innerHTML = `
      <div class="cc-tool-slot active" data-tool="hatchet"><span class="ico">🪓</span><span>Hatchet</span></div>
      <div class="cc-tool-slot" data-tool="spear"><span class="ico">🔱</span><span>Spear</span></div>
      <div class="cc-tool-slot" id="cc-belt-ranged" data-tool="bow"><span class="ico">🏹</span><span>Bow</span></div>
      <div class="cc-tool-slot" id="cc-belt-util" data-tool="torch"><span class="ico">🔥</span><span>Torch</span></div>
      <div class="cc-tool-slot pack-slot" id="cc-belt-pack"><span class="ico">🎒</span><span>Pack</span></div>
    `;
    document.body.appendChild(dock);

    const openPackModal = e => {
      if (e) e.stopPropagation();
      updateCastawayHUD();
      const cm = document.getElementById('cc-craft-modal');
      if (cm) cm.style.display = 'flex';
    };

    dock.querySelectorAll('.cc-tool-slot').forEach(slot => {
      const handler = e => {
        e.stopPropagation();
        if (slot.id === 'cc-belt-pack') {
          openPackModal(e);
          return;
        }
        const t = slot.dataset.tool;
        if (t === 'build' && campaign.activeTool === 'build') {
          openPackModal(e);
        } else {
          selectTool(t);
        }
      };
      slot.addEventListener('click', handler);
      slot.addEventListener('touchend', e => { e.preventDefault(); handler(e); });
    });

    const raftBtn = document.createElement('button');
    raftBtn.id = 'cc-raft-btn';
    raftBtn.innerText = '🛶 Board Outrigger Raft';
    document.body.appendChild(raftBtn);

    const navalHud = document.createElement('div');
    navalHud.id = 'cc-naval-hud';
    navalHud.style.cssText = 'position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:48;background:rgba(6,18,28,0.86);border:1px solid rgba(102,252,241,0.38);border-radius:999px;padding:4px 13px;color:#e0f7fa;font-size:11px;font-weight:700;letter-spacing:0.02em;display:none;pointer-events:none;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.45);';
    document.body.appendChild(navalHud);

    const toggleRaftHandler = e => {
      e.stopPropagation();
      if (campaign.onRaft) {
        campaign.onRaft = false;
        campaign.vessel = null;
        player.pos.y += 0.65;
        showToast('⚓ Disembarked.');
        updateCastawayHUD();
        return;
      }
      const dRaft = Math.hypot(player.pos.x - raftState.pos.x, player.pos.z - raftState.pos.z);
      const dBoat = raftState.boatPos ? Math.hypot(player.pos.x - raftState.boatPos.x, player.pos.z - raftState.boatPos.z) : 999;
      if (campaign.boatBuilt && dBoat < 9 && dBoat <= dRaft) {
        campaign.onRaft = true;
        campaign.vessel = 'boat';
        player.pos.set(raftState.boatPos.x, raftState.boatPos.y + 0.45, raftState.boatPos.z);
        player.vel.set(0, 0, 0);
        showToast('⛵ Boarded the keeled boat. She holds the wind.');
      } else if (dRaft < 9) {
        if (!campaign.raftBuilt) {
          showToast('The hull is still loose poles. Lash it here with 4 bamboo and 2 fiber.');
          return;
        }
        campaign.onRaft = true;
        campaign.vessel = 'raft';
        player.pos.set(raftState.pos.x, raftState.pos.y + 0.35, raftState.pos.z);
        player.vel.set(0, 0, 0);
        showToast('🛶 Boarded the bamboo raft. She will not cross trench water.');
      }
      updateCastawayHUD();
    };
    raftBtn.addEventListener('click', toggleRaftHandler);
    raftBtn.addEventListener('touchend', e => { e.preventDefault(); toggleRaftHandler(e); });

    const dialogBanner = document.createElement('div');
    dialogBanner.id = 'cc-dialog-banner';
    dialogBanner.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b id="cc-dialog-title" style="color:#26e6c6;font-size:11.5px;letter-spacing:0.05em;">SURVIVOR LOG</b>
        <span id="cc-dialog-close" style="cursor:pointer;font-size:14px;color:#90a4ae;">✕</span>
      </div>
      <div id="cc-dialog-body" style="font-size:12px;line-height:1.4;margin-top:4px;color:#e2f1ff;"></div>
    `;
    document.body.appendChild(dialogBanner);
    document.getElementById('cc-dialog-close').addEventListener('click', () => {
      dialogBanner.style.display = 'none';
    });

    const craftModal = document.createElement('div');
    craftModal.id = 'cc-craft-modal';
    craftModal.innerHTML = `
      <div class="cc-craft-box">
        <div class="cc-pack-header">
          <h3 style="margin:0;font-size:15.5px;color:#26e6c6;">🎒 Survivor Pack</h3>
          <button id="cc-close-craft" aria-label="Close Pack">✕</button>
        </div>
        <div id="cc-objective-text" style="font-size:11px;color:#ffd54f;margin-top:5px;font-weight:700;">📡 Avionics Modules: 0/3 found • Repair Radio Outpost at (52, 96)</div>
        <div class="cc-pack-res-strip">
          <span>🎍 Bamboo: <b id="cc-cnt-bamboo">6</b></span>
          <span>🖤 Obsidian: <b id="cc-cnt-obsidian">3</b></span>
          <span>🐟 Raw: <b id="cc-cnt-fish">0</b></span>
          <span>🍖 Rations: <b id="cc-cnt-food">2</b></span>
          <span>🏹 Arrows: <b id="cc-cnt-arrows">6</b></span>
          <span>🎯 Bolts: <b id="cc-cnt-bolts">6</b></span>
          <span>🧨 Blast: <b id="cc-cnt-dyn">0</b></span>
          <span>🎇 Flares: <b id="cc-cnt-flares">2</b></span>
        </div>

        <div class="cc-pack-tabs" id="cc-pack-tabs">
          <button class="cc-pack-tab active" data-packtab="pack-tab-gear">⚔️ Gear</button>
          <button class="cc-pack-tab" data-packtab="pack-tab-craft">🛠️ Craft</button>
          <button class="cc-pack-tab" data-packtab="pack-tab-build">🔨 Build</button>
          <button class="cc-pack-tab" data-packtab="pack-tab-travel">🧭 Travel</button>
        </div>

        <div class="cc-pack-body">
          <div class="cc-pack-pane active" id="pack-tab-gear">
            <div class="cc-section-lbl">Equip Tool or Weapon</div>
            <div class="cc-arsenal-grid" id="cc-arsenal-grid">
              <div class="cc-tool-slot active" data-tool="hatchet" style="width:100%;"><span class="ico">🪓</span><span>Hatchet</span></div>
              <div class="cc-tool-slot" data-tool="spear" style="width:100%;"><span class="ico">🔱</span><span>Spear</span></div>
              <div class="cc-tool-slot" data-tool="bow" style="width:100%;"><span class="ico">🏹</span><span>Bow</span></div>
              <div class="cc-tool-slot" data-tool="crossbow" style="width:100%;"><span class="ico">🎯</span><span>X-Bow</span></div>
              <div class="cc-tool-slot" data-tool="pistol" style="width:100%;"><span class="ico">🔫</span><span>Pistol</span></div>
              <div class="cc-tool-slot" data-tool="rifle" style="width:100%;"><span class="ico">🎯</span><span>Rifle</span></div>
              <div class="cc-tool-slot" data-tool="rod" style="width:100%;"><span class="ico">🎣</span><span>Fish Rod</span></div>
              <div class="cc-tool-slot" data-tool="torch" style="width:100%;"><span class="ico">🔥</span><span>Torch</span></div>
              <div class="cc-tool-slot" data-tool="flare" style="width:100%;"><span class="ico">🎇</span><span>Flare</span></div>
              <div class="cc-tool-slot" data-tool="dynamite" style="width:100%;"><span class="ico">🧨</span><span>Blast</span></div>
              <div class="cc-tool-slot" data-tool="build" style="width:100%;"><span class="ico">🔨</span><span>Build</span></div>
            </div>
            <button class="cc-btn-secondary" id="cc-act-unlock-all" style="margin-top:10px;min-height:48px;background:rgba(255,193,7,0.16);border-color:rgba(255,213,79,0.55);color:#ffe082;">🎁 Unlock All Weapons, Boats &amp; Collectibles</button>
          </div>

          <div class="cc-pack-pane" id="pack-tab-craft">
            <div class="cc-section-lbl">Rations, Ammo &amp; Vessels</div>
            <div class="cc-craft-grid">
              <button class="cc-btn-secondary" id="cc-act-eat">🍖 Eat Ration (+45 Food)</button>
              <button class="cc-btn-secondary" id="cc-act-cook">🍳 Roast Raw Fish/Meat</button>
              <button class="cc-btn-secondary" id="cc-act-bow">🏹 Craft Bow (2T+1S+1F)</button>
              <button class="cc-btn-secondary" id="cc-act-xbow">🎯 Craft X-Bow (3T+2B+2S)</button>
              <button class="cc-btn-secondary" id="cc-act-arrows">🏹 +5 Arrows (1T+1Fl+1Fe)</button>
              <button class="cc-btn-secondary" id="cc-act-bolts">🎯 +4 Bolts (1T+1Ob+1Fe)</button>
              <button class="cc-btn-secondary" id="cc-act-flare">🎇 +2 Flares (1Ob+1Bam)</button>
              <button class="cc-btn-secondary" id="cc-act-raft">🛶 Lash Beach Raft (4 Bam + 2 Fiber)</button>
              <button class="cc-btn-secondary" id="cc-act-boat">⛵ Build Keeled Boat (4 arc pieces)</button>
            </div>
          </div>

          <div class="cc-pack-pane" id="pack-tab-build">
            <div class="cc-section-lbl">Modular Shelter Blueprints (Tap to Arm Hammer)</div>
            <div class="cc-recipe-grid" id="cc-build-grid"></div>
          </div>

          <div class="cc-pack-pane" id="pack-tab-travel">
            <div class="cc-section-lbl">Watershed Map &amp; Waypoints</div>
            <button class="cc-btn-secondary" id="cc-open-geo-map" style="margin-top:0;min-height:48px;background:rgba(0,188,212,0.22);border-color:#00e5ff;color:#80deea;">🗺️ Full Geological &amp; Hydrology Map</button>
            <div class="cc-travel-grid">
              <button class="cc-btn-secondary" data-cctp="crash">✈️ Crash Cove</button>
              <button class="cc-btn-secondary" data-cctp="outpost">📡 Radio Outpost</button>
              <button class="cc-btn-secondary" data-cctp="volcano">🌋 Volcano Rim</button>
              <button class="cc-btn-secondary" data-cctp="lavatube">🔥 Lava Tube</button>
              <button class="cc-btn-secondary" data-cctp="valley_pond">🌿 Valley Lagoon</button>
              <button class="cc-btn-secondary" data-cctp="ruins">🏛️ Sunken Ruins</button>
              <button class="cc-btn-secondary" data-cctp="bamboo">🎍 Bamboo Grove</button>
              <button class="cc-btn-secondary" data-cctp="swim_cay">🏖️ Reef Cay</button>
              <button class="cc-btn-secondary" data-cctp="outer_stronghold">⛵ Outer Island</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(craftModal);

    craftModal.querySelectorAll('.cc-pack-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', e => {
        e.stopPropagation();
        const targetId = tabBtn.dataset.packtab;
        craftModal.querySelectorAll('.cc-pack-tab').forEach(b => b.classList.toggle('active', b === tabBtn));
        craftModal.querySelectorAll('.cc-pack-pane').forEach(p => p.classList.toggle('active', p.id === targetId));
      });
    });

    const openGeoMapBtn = document.getElementById('cc-open-geo-map');
    if (openGeoMapBtn) {
      openGeoMapBtn.addEventListener('click', e => {
        e.stopPropagation();
        craftModal.style.display = 'none';
        if (typeof window.openSettings === 'function') {
          window.openSettings('tab-world');
        }
      });
    }

    craftModal.querySelectorAll('#cc-arsenal-grid .cc-tool-slot').forEach(slot => {
      slot.addEventListener('click', e => {
        e.stopPropagation();
        craftModal.style.display = 'none';
        selectTool(slot.dataset.tool);
      });
    });

    const buildGrid = document.getElementById('cc-build-grid');
    Object.entries(BUILD_RECIPES).forEach(([key, rec]) => {
      const costStr = Object.entries(rec.cost).map(([k, v]) => `${v} ${k}`).join(', ');
      const div = document.createElement('div');
      div.className = 'cc-recipe-item' + (campaign.buildPiece === key ? ' active' : '');
      div.innerHTML = `<div style="font-weight:800;color:#80d8ff;">${rec.name}</div><div style="color:#ffd54f;margin:2px 0;">${costStr}</div><div style="color:#cfd8dc;font-size:10px;">${rec.desc}</div>`;
      div.addEventListener('click', () => {
        campaign.buildPiece = key;
        buildGrid.querySelectorAll('.cc-recipe-item').forEach(el => el.classList.remove('active'));
        div.classList.add('active');
        craftModal.style.display = 'none';
        selectTool('build');
      });
      buildGrid.appendChild(div);
    });

    document.getElementById('cc-close-craft').addEventListener('click', () => {
      craftModal.style.display = 'none';
    });
    const openCraftLink = document.getElementById('cc-open-craft-link');
    if (openCraftLink) {
      openCraftLink.addEventListener('click', openPackModal);
      openCraftLink.addEventListener('touchend', e => { e.preventDefault(); openPackModal(e); });
    }

    document.getElementById('cc-act-bow').addEventListener('click', () => {
      if (campaign.unlockedWeapons.bow) { selectTool('bow'); craftModal.style.display = 'none'; return; }
      if (player.inventory.timber >= 2 && player.inventory.sinew >= 1 && player.inventory.fiber >= 1) {
        player.inventory.timber -= 2; player.inventory.sinew -= 1; player.inventory.fiber -= 1;
        campaign.unlockedWeapons.bow = true;
        player.inventory.arrows += 4;
        AudioEngine.playChop();
        showToast('🏹 Crafted Recurve Hunting Bow + 4 Arrows!');
        updateCastawayHUD();
        craftModal.style.display = 'none';
        selectTool('bow');
      } else {
        showToast('⚠️ Need 2 Timber + 1 Sinew + 1 Fiber (harvest animal sinew or reeds).');
      }
    });

    document.getElementById('cc-act-xbow').addEventListener('click', () => {
      if (campaign.unlockedWeapons.crossbow) { selectTool('crossbow'); craftModal.style.display = 'none'; return; }
      if (player.inventory.timber >= 3 && player.inventory.bone >= 2 && player.inventory.sinew >= 2) {
        player.inventory.timber -= 3; player.inventory.bone -= 2; player.inventory.sinew -= 2;
        campaign.unlockedWeapons.crossbow = true;
        player.inventory.bolts += 4;
        AudioEngine.playChop();
        showToast('🎯 Crafted Hunting Crossbow + 4 Bolts!');
        updateCastawayHUD();
        craftModal.style.display = 'none';
        selectTool('crossbow');
      } else {
        showToast('⚠️ Need 3 Timber + 2 Bone + 2 Sinew (field-dress deer/boar/wolves).');
      }
    });

    document.getElementById('cc-act-arrows').addEventListener('click', () => {
      if (player.inventory.timber >= 1 && player.inventory.flint >= 1 && player.inventory.feather >= 1) {
        player.inventory.timber -= 1; player.inventory.flint -= 1; player.inventory.feather -= 1;
        player.inventory.arrows += 5;
        showToast('🏹 Crafted +5 Feather Arrows!');
        updateCastawayHUD();
      } else {
        showToast('⚠️ Need 1 Timber + 1 Flint + 1 Feather!');
      }
    });

    document.getElementById('cc-act-bolts').addEventListener('click', () => {
      if (player.inventory.timber >= 1 && player.inventory.obsidian >= 1 && player.inventory.feather >= 1) {
        player.inventory.timber -= 1; player.inventory.obsidian -= 1; player.inventory.feather -= 1;
        player.inventory.bolts += 4;
        showToast('🎯 Crafted +4 Obsidian-Tipped Crossbow Bolts!');
        updateCastawayHUD();
      } else {
        showToast('⚠️ Need 1 Timber + 1 Obsidian + 1 Feather!');
      }
    });

    document.getElementById('cc-act-cook').addEventListener('click', () => {
      if (player.inventory.rawFish > 0 || player.inventory.rawMeat > 0) {
        if (player.inventory.rawFish > 0) player.inventory.rawFish--;
        else player.inventory.rawMeat--;
        player.inventory.cookedFood++;
        AudioEngine.playFire();
        showToast('🍳 Cooked 1 hearty Island Ration!');
        updateCastawayHUD();
      } else {
        showToast('⚠️ No Raw Fish or Raw Meat in inventory! Fish with Fish Rod or hunt wildlife.');
      }
    });

    document.getElementById('cc-act-eat').addEventListener('click', () => {
      if (player.inventory.cookedFood > 0) {
        player.inventory.cookedFood--;
        player.vitals.hunger = Math.min(100, player.vitals.hunger + 45);
        player.vitals.thirst = Math.min(100, player.vitals.thirst + 20);
        player.vitals.hp = Math.min(100, player.vitals.hp + 25);
        showToast('🍖 Consumed Cooked Ration! +45 Hunger, +25 HP');
        updateCastawayHUD();
      } else {
        showToast('⚠️ No Cooked Rations left! Roast Raw Fish or Meat first.');
      }
    });

    document.getElementById('cc-act-flare').addEventListener('click', () => {
      if (player.inventory.obsidian >= 1 && player.inventory.bamboo >= 1) {
        player.inventory.obsidian--;
        player.inventory.bamboo--;
        player.inventory.flares += 2;
        showToast('🎇 Crafted +2 Signal Flares!');
        updateCastawayHUD();
      } else {
        showToast('⚠️ Need 1 Obsidian + 1 Bamboo to craft Signal Flares!');
      }
    });

    document.getElementById('cc-act-raft').addEventListener('click', () => {
      if (campaign.raftBuilt) {
        showToast('The beach raft is already lashed.');
        return;
      }
      const dist = Math.hypot(player.pos.x - raftState.pos.x, player.pos.z - raftState.pos.z);
      if (dist > 22) {
        showToast('The pole hull is on the crash-cove beach, not in your pack.');
        return;
      }
      if ((player.inventory.bamboo || 0) < 4 || (player.inventory.fiber || 0) < 2) {
        showToast('Need 4 bamboo and 2 fiber, gathered on this island.');
        return;
      }
      player.inventory.bamboo -= 4;
      player.inventory.fiber -= 2;
      campaign.raftBuilt = true;
      raftState.mesh.visible = true;
      if (raftState.poles) raftState.poles.visible = false;
      craftModal.style.display = 'none';
      showToast('🛶 Raft lashed. She will cross open water and be blown off a trench.');
      updateCastawayHUD();
    });

    function buildKeeledBoatHull() {
      if (raftState.boatMesh) return;
      const hull = new THREE.Group();
      // Carved keel spine + flared port/starboard carvel hull strakes + pointed prow stempost + ribs
      const keelSpine = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.36, 6.6), matTimberLog);
      keelSpine.position.y = 0.14;
      hull.add(keelSpine);

      const deckPlank = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.16, 5.6), matTimberLog);
      deckPlank.position.y = 0.34;
      hull.add(deckPlank);

      [-0.78, 0.78].forEach(sx => {
        const gunwale = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.44, 5.8), matHickory);
        gunwale.position.set(sx, 0.48, 0);
        gunwale.rotation.z = sx > 0 ? -0.18 : 0.18;
        hull.add(gunwale);
      });

      [-1.8, -0.6, 0.6, 1.8].forEach(rz => {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.14, 0.16), matHickory);
        rib.position.set(0, 0.43, rz);
        hull.add(rib);
      });

      const prowStem = new THREE.Mesh(new THREE.ConeGeometry(0.48, 1.45, 4), matHickory);
      prowStem.rotation.x = -Math.PI / 2 + 0.38;
      prowStem.position.set(0, 0.56, -3.15);
      hull.add(prowStem);

      // Stepped Mast + Articulated Lateen Sail Boom Pivot + Stern Rudder Pivot + Night Bow Lantern
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.09, 3.8, 8), matHickory);
      mast.position.set(0, 2.15, -0.45);
      hull.add(mast);

      const sailPivot = new THREE.Group();
      sailPivot.position.set(0, 2.25, -0.45);
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.6, 6), matSeasonedBamboo);
      boom.rotation.x = Math.PI / 2;
      boom.position.set(0, -0.82, 0.35);
      sailPivot.add(boom);

      const gaff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.042, 2.55, 6), matSeasonedBamboo);
      gaff.rotation.x = Math.PI / 2 - 0.14;
      gaff.position.set(0, 1.16, 0.32);
      sailPivot.add(gaff);

      const boatSailGeo = new THREE.PlaneGeometry(2.45, 2.05, 10, 8);
      const bsPos = boatSailGeo.attributes.position;
      for (let i = 0; i < bsPos.count; i++) {
        const su = bsPos.getX(i), sv = bsPos.getY(i);
        bsPos.setZ(i, Math.cos(su * 0.85) * Math.cos(sv * 0.95) * 0.28);
      }
      boatSailGeo.computeVertexNormals();
      const sailCanvas = new THREE.Mesh(boatSailGeo, matSailCanvas);
      sailCanvas.rotation.y = Math.PI / 2;
      sailCanvas.position.set(0, 0.15, 0.32);
      sailPivot.add(sailCanvas);
      hull.add(sailPivot);

      const rudderPivot = new THREE.Group();
      rudderPivot.position.set(0, 0.35, 3.15);
      const rudderBlade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.68, 0.52), matHickory);
      rudderBlade.position.set(0, -0.18, 0.22);
      rudderPivot.add(rudderBlade);
      hull.add(rudderPivot);

      const lanternGlobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd54f })
      );
      lanternGlobe.position.set(0, 0.88, -2.85);
      hull.add(lanternGlobe);
      const boatLight = new THREE.PointLight(0xffb74d, 2.2, 24.0);
      boatLight.position.set(0, 1.05, -2.85);
      hull.add(boatLight);
      registerManagedLight(boatLight, 32.0);

      hull.userData = { sailPivot, rudderPivot };
      hull.position.copy(raftState.boatPos);
      scene.add(hull);
      raftState.boatMesh = hull;
      if (raftState.keel) raftState.keel.visible = false;
    }

    function unlockAllWeaponsBoatsAndCollectibles() {
      // 1. Unlock all weapons (Bow, Crossbow, Pistol, Rifle; Hatchet, Spear, Rod, Torch, Flare, Dynamite, Build already equippable)
      campaign.unlockedWeapons.bow = true;
      campaign.unlockedWeapons.crossbow = true;
      campaign.unlockedWeapons.pistol = true;
      campaign.unlockedWeapons.rifle = true;

      // 2. Grant generous stockpiles of all crafting materials, collectibles, ammo & rations (never decreasing existing higher counts)
      const sandboxMin = {
        timber: 60,
        stone: 60,
        bamboo: 40,
        obsidian: 25,
        fiber: 40,
        hide: 20,
        bone: 20,
        sinew: 20,
        feather: 30,
        flint: 25,
        fat: 15,
        arrows: 40,
        bolts: 40,
        pistolAmmo: 30,
        rifleAmmo: 30,
        dynamite: 12,
        flares: 12,
        rawFish: 8,
        rawMeat: 8,
        cookedFood: 12,
        purifiedWater: 10
      };
      Object.keys(sandboxMin).forEach(k => {
        player.inventory[k] = Math.max(player.inventory[k] || 0, sandboxMin[k]);
      });

      // 3. Build both vessels (Outrigger Bamboo Raft & Keeled Sailboat) + mark all 4 boat salvage parts collected
      campaign.raftBuilt = true;
      if (raftState.mesh) raftState.mesh.visible = true;
      if (raftState.poles) raftState.poles.visible = false;

      campaign.boatParts.keel = true;
      campaign.boatParts.brace = true;
      campaign.boatParts.skin = true;
      campaign.boatParts.sail = true;
      if (window.archipelagoIslets) {
        window.archipelagoIslets.forEach(isl => {
          if (isl._marker) isl._marker.visible = false;
        });
      }
      campaign.boatBuilt = true;
      buildKeeledBoatHull();

      // 4. Mark all 3 story Avionics Modules & all rare world weapon caches as collected
      campaign.modulesFound.cockpitTransponder = true;
      campaign.modulesFound.submergedBattery = true;
      campaign.modulesFound.cavernRecorder = true;
      storyCrates.forEach(crate => {
        const u = crate.userData || {};
        if (u.crateLight) {
          u.crateLight.userData.disabled = true;
          u.crateLight.intensity = 0;
        }
        if (crate.parent) crate.parent.remove(crate);
        removeInteractiveTarget(crate);
      });
      rareWeaponCaches.forEach(cg => {
        const u = cg.userData || {};
        if (!u.opened) {
          u.opened = true;
          if (u.lid) {
            u.lid.rotation.x = -0.75;
            u.lid.position.y += 0.14;
            u.lid.position.z -= 0.16;
          }
          if (u.glint) u.glint.visible = false;
          removeInteractiveTarget(cg);
        }
      });

      campaign.sandboxUnlocked = true;
      AudioEngine.playChop();
      updateCastawayHUD();
      showToast('🎁 Unlocked all weapons, raft, keeled boat (Crash Cove), 3/3 avionics & full supplies!');
    }
    window.unlockAllWeaponsBoatsAndCollectibles = unlockAllWeaponsBoatsAndCollectibles;

    const unlockPackBtn = document.getElementById('cc-act-unlock-all');
    if (unlockPackBtn) {
      unlockPackBtn.addEventListener('click', e => {
        e.stopPropagation();
        unlockAllWeaponsBoatsAndCollectibles();
      });
    }

    document.getElementById('cc-act-boat').addEventListener('click', () => {
      const parts = campaign.boatParts;
      const missing = ['keel', 'brace', 'skin', 'sail'].filter(k => !parts[k]);
      if (missing.length) {
        showToast('The keel is still short: ' + missing.join(', ') + '. One piece from each arc, not from a stronghold.');
        return;
      }
      const dist = Math.hypot(player.pos.x - raftState.boatPos.x, player.pos.z - raftState.boatPos.z);
      if (dist > 22) {
        showToast('Bring the four pieces back to the keel on the home beach.');
        return;
      }
      if (campaign.boatBuilt) {
        showToast('The keeled boat is already built.');
        return;
      }
      campaign.boatBuilt = true;
      buildKeeledBoatHull();
      craftModal.style.display = 'none';
      showToast('⛵ Keeled boat finished. She is faster, and she is the only craft that crosses the trench.');
      updateCastawayHUD();
    });

    const NEW_WAYPOINTS = {
      crash:            { x: -40.0,  z: -28.0,  yaw: 0.79, pitch: -0.05, dive: false, label: '✈️ Teleported to Flight 409 Seaplane Crash Cove!' },
      outpost:          { x: 46.0,   z: 88.0,   yaw: -0.45, pitch: 0.05,  dive: false, label: '📡 Teleported to Abandoned Radio Outpost & Weather Station!' },
      volcano:          { x: -250.0, z: 64.0, yaw: 1.57, pitch: -0.22, dive: false, label: '🌋 Teleported to Mount Caldera east rim. Crest is 168m at -302, 64.' },
      lavatube:         { x: -208.1, z: 68.7, yaw: 1.52, pitch: -0.04, dive: false, label: '🔥 Teleported to the lava tube mouth on the east flank!' },
      ruins:            { x: -62.0,  z: -268.0, yaw: 0.4, pitch: -0.04, dive: false, label: '🏛️ Teleported to the ruins on the lee shore of Outer Sentinel!' },
      bamboo:           { x: -64.0,  z: -24.0,  yaw: 0.65,  pitch: 0.0,   dive: false, label: '🎍 Teleported to Emerald Bamboo Jungle & Mangrove Delta!' },
      valley_pond:      { x: 88.0,   z: 168.0,  yaw: 3.14, pitch: -0.06, dive: false, label: '🌿 Teleported to the north shore of Windward Valley Lagoon (+6.8m)!' },
      canyon_gorge:     { x: 215.0,  z: 42.0,   yaw: -1.57, pitch: -0.04, dive: false, label: '🪨 Teleported to Stratified Eastern Limestone Canyon!' },
      swim_cay:         { x: -294.0, z: 224.0,  yaw: 1.57,  pitch: -0.05, dive: false, label: '🏖️ Teleported to Sheltered Reef Cove (25m Swim to Cay)!' },
      outer_stronghold: { x: 790.0,  z: -740.0, yaw: -0.6, pitch: -0.08, dive: false, label: '⛵ Teleported to the Magma Trench Bastion. The raft cannot make this crossing.' }
    };
    if (WAYPOINTS) Object.assign(WAYPOINTS, NEW_WAYPOINTS);

    craftModal.querySelectorAll('[data-cctp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const wp = NEW_WAYPOINTS[btn.dataset.cctp];
        if (!wp) return;
        campaign.onRaft = false;
        player.pos.x = wp.x;
        player.pos.z = wp.z;
        player.vel.set(0, 0, 0);
        player.pos.y = wp.yOverride !== undefined ? wp.yOverride : (getTerrainHeight(wp.x, wp.z) + 0.25);
        player.yaw = wp.yaw;
        player.pitch = wp.pitch;
        player.isDivingUnderwater = !!wp.dive;
        if (window.ArchipelagoChunkManager) window.ArchipelagoChunkManager.update(player.pos.x, player.pos.z);
        craftModal.style.display = 'none';
        showToast(wp.label);
      });
    });

    const wBadge = document.getElementById('cc-weather-badge');
    if (wBadge) {
      wBadge.addEventListener('click', e => {
        e.stopPropagation();
        const order = ['clear', 'clouds', 'mist', 'rain', 'storm'];
        const next = order[(order.indexOf(campaign.weather.current) + 1) % order.length];
        setDynamicWeatherState(next, true);
      });
    }

    // 12-Stop Interactive Visual Showcase Tour (Areas, Cave Exteriors/Interiors, Objects & Wildlife)
    const TOUR_STOPS = [
      {
        title: '1/12 ✈️ Flight 409 Crashed Seaplane',
        desc: 'Twin-Otter fuselage, radial engines, 3-blade props, sheared wing & Cockpit Transponder crate.',
        x: -36.5, z: -22.5, tx: -44.0, tz: -28.0, pitch: -0.04, dive: false, tool: 'hatchet'
      },
      {
        title: '2/12 🛶 Outrigger Bamboo Raft & Base',
        desc: '9-culm lashed bamboo deck, twin outrigger floats, canvas sail, steering oar & Bamboo Fishing Rod.',
        x: -41.5, z: -29.5, tx: -48.0, tz: -36.0, pitch: -0.08, dive: false, tool: 'rod'
      },
      {
        title: '3/12 🕳️ Whispering Cave (Outside Archway)',
        desc: 'Exterior hillside limestone cavern mouth with wet rock face, cool draft and pitch darkness beyond.',
        caveOutside: 0, pitch: -0.02, dive: false, tool: 'torch'
      },
      {
        title: '4/12 🕳️ Whispering Cave (Dark Branching Hall)',
        desc: 'Inside Cave 0: multi-level branching limestone cavern in near-total darkness, illuminated by your Pitch Torch.',
        caveIdx: 0, caveT: 0.42, pitch: -0.02, dive: false, tool: 'torch'
      },
      {
        title: '5/12 🏞️ Subterranean Cenote & Black Box',
        desc: 'Inside Cave 0 Skylight Chamber: underground pool & Flight 409 Black Box crate.',
        caveIdx: 0, caveT: 0.72, pitch: -0.05, dive: false, tool: 'torch'
      },
      {
        title: '6/12 🔥 Volcanic Lava Tube (Outside Entrance)',
        desc: 'Exterior basalt tunnel portal on Mount Caldera slope surrounded by volcanic obsidian outcrops.',
        caveOutside: 2, pitch: -0.03, dive: false, tool: 'spear'
      },
      {
        title: '7/12 🌋 Volcanic Lava Tube (Inside Dark Sump)',
        desc: 'Inside Cave 2: pitch-dark volcanic lava tube & sump fissures lit by handheld Pitch Torch & subtle mineral glints.',
        caveIdx: 2, caveT: 0.42, pitch: -0.04, dive: false, tool: 'torch'
      },
      {
        title: '8/12 🏛️ Ruins on the Lee Shore of Outer Sentinel',
        desc: 'The colonnade and the isotope battery now stand on the lee shore of Outer Sentinel.',
        x: -70.0, z: -268.0, tx: -62.0, tz: -268.0, yOffset: 1.8, pitch: -0.04, dive: false, tool: 'spear'
      },
      {
        title: '9/12 🎍 EZ-Tree Bamboo Jungle & Mangroves',
        desc: 'Procedural EZ-Tree bamboo groves with nodal birch bark, feathery ash foliage & Obsidian Spear.',
        x: -58.0, z: -22.0, tx: -68.0, tz: -28.0, pitch: 0.02, dive: false, tool: 'spear'
      },
      {
        title: '10/12 ⛰️ Mount Caldera Crater & Molten Lava Lake',
        desc: 'Coastal stratovolcano, 168m dark scoria crest, molten crater pool, ash column and the east-flank lava tube.',
        x: -224.6, z: 73.3, tx: -302.0, tz: 64.0, pitch: -0.28, dive: false, tool: 'flare'
      },
      {
        title: '11/12 📡 Abandoned Radio Outpost & 22m Tower',
        desc: 'Concrete weather bunker, 22m steel lattice radio tower, spinning anemometer & SOS console.',
        x: 43.5, z: 103.5, tx: 52.0, tz: 96.0, pitch: 0.12, dive: false, tool: 'build'
      },
      {
        title: '12/12 🐗 Articulated Wildlife (Boars, Wolves & Crabs)',
        desc: 'Multi-jointed Wild Boars with tusks, Ridge Alpha Wolves & 6-legged Coconut Crabs.',
        wildlifeFocus: true, tool: 'spear'
      }
    ];
    let currentTourIdx = 0;

    function goToTourStop(idx) {
      currentTourIdx = (idx + TOUR_STOPS.length) % TOUR_STOPS.length;
      const stop = TOUR_STOPS[currentTourIdx];
      campaign.started = true;
      campaign.onRaft = false;
      const ts = document.getElementById('cc-title-screen');
      if (ts) ts.style.display = 'none';

      if (stop.tool) selectTool(stop.tool);

      if (stop.caveOutside !== undefined && CAVE_SYSTEMS && CAVE_SYSTEMS[stop.caveOutside]) {
        const cSys = CAVE_SYSTEMS[stop.caveOutside];
        const pt0 = cSys.getPoint(0.0);
        const pt1 = cSys.getPoint(0.06);
        const camX = pt0.x - cSys.dirX * 10.5;
        const camZ = pt0.z - cSys.dirZ * 10.5;
        player.pos.set(camX, Math.max(0.45, getTerrainHeight(camX, camZ) + 0.25), camZ);
        player.vel.set(0, 0, 0);
        player.yaw = Math.atan2(-(pt1.x - camX), -(pt1.z - camZ));
        player.pitch = stop.pitch || -0.02;
        player.isDivingUnderwater = false;
      } else if (stop.caveIdx !== undefined && CAVE_SYSTEMS && CAVE_SYSTEMS[stop.caveIdx]) {
        const cSys = CAVE_SYSTEMS[stop.caveIdx];
        const pt0 = cSys.getPoint(stop.caveT);
        const pt1 = cSys.getPoint(Math.min(0.92, stop.caveT + 0.05));
        player.pos.set(pt0.x, pt0.floorY + 0.35, pt0.z);
        player.vel.set(0, 0, 0);
        player.yaw = Math.atan2(-(pt1.x - pt0.x), -(pt1.z - pt0.z));
        player.pitch = stop.pitch || -0.02;
        player.isDivingUnderwater = false;
      } else if (stop.wildlifeFocus && wildlifeAgents.length > 0) {
        const bx = -22.0, bz = 14.0;
        const boar = wildlifeAgents.find(a => a.species === 'boar');
        const wolf = wildlifeAgents.find(a => a.species === 'wolf');
        const crab = wildlifeAgents.find(a => a.species === 'crab');
        if (boar) {
          boar.mesh.position.set(bx - 1.15, getTerrainHeight(bx - 1.15, bz), bz);
          boar.mesh.rotation.y = 0.48;
          boar.yaw = 0.48;
          boar.homeX = bx - 1.15;
          boar.homeZ = bz;
        }
        if (wolf) {
          wolf.mesh.position.set(bx + 1.15, getTerrainHeight(bx + 1.15, bz - 0.1), bz - 0.1);
          wolf.mesh.rotation.y = -0.48;
          wolf.yaw = -0.48;
          wolf.homeX = bx + 1.15;
          wolf.homeZ = bz - 0.1;
        }
        if (crab) {
          crab.mesh.position.set(bx, getTerrainHeight(bx, bz + 1.15), bz + 1.15);
          crab.mesh.rotation.y = 0.15;
          crab.yaw = 0.15;
          crab.homeX = bx;
          crab.homeZ = bz + 1.15;
        }
        if (!window._showcaseBaseBuilt) {
          window._showcaseBaseBuilt = true;
          const campX = bx - 3.6, campZ = bz - 3.8;
          const campY = getTerrainHeight(campX, campZ);
          const campGroup = new THREE.Group();
          campGroup.position.set(campX, campY, campZ);
          const deck = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.28, 3.8), matTimberLog);
          deck.position.y = 0.45;
          deck.castShadow = true;
          deck.receiveShadow = true;
          campGroup.add(deck);
          const stepLog = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.55), matTimberLog);
          stepLog.position.set(0, 0.22, 2.08);
          campGroup.add(stepLog);
          const roof = createLayeredThatchRoof(2.85, 1.45);
          roof.position.y = 2.65;
          campGroup.add(roof);
          [-1.5, 1.5].forEach(px => [-1.5, 1.5].forEach(pz => {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.3, 8), matTimberLog);
            post.position.set(px, 1.15, pz);
            post.castShadow = true;
            campGroup.add(post);
            // Deep ground pilings so sanctuary shelter deck never hovers on slopes
            const piling = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 3.2, 8), matTimberLog);
            piling.position.set(px, -0.95, pz);
            campGroup.add(piling);
          }));
          scene.add(campGroup);
        }
        const viewX = bx;
        const viewZ = bz + 3.6;
        const camGroundY = getTerrainHeight(viewX, viewZ);
        const targetGroundY = getTerrainHeight(bx, bz) + 0.55;
        player.pos.set(viewX, camGroundY + 0.05, viewZ);
        player.vel.set(0, 0, 0);
        player.yaw = 0.0;
        player.pitch = Math.atan2(targetGroundY - (camGroundY + 1.67), 3.6);
        player.isDivingUnderwater = false;
      } else {
        player.pos.x = stop.x;
        player.pos.z = stop.z;
        player.vel.set(0, 0, 0);
        const baseH = getTerrainHeight(stop.x, stop.z);
        player.pos.y = stop.dive ? (baseH + (stop.yOffset || 1.5)) : Math.max(0.45, baseH + 0.25);
        player.yaw = (stop.tx !== undefined)
          ? Math.atan2(-(stop.tx - stop.x), -(stop.tz - stop.z))
          : (stop.yaw || 0);
        player.pitch = stop.pitch || 0;
        player.isDivingUnderwater = !!stop.dive;
      }

      if (window.ArchipelagoChunkManager) window.ArchipelagoChunkManager.update(player.pos.x, player.pos.z);
      if (window.syncCaveAtmosphere) window.syncCaveAtmosphere(0.016, true);
      const labelEl = document.getElementById('cc-tour-label');
      if (labelEl) labelEl.innerText = stop.title;
      showStoryDialog('📸 SHOWCASE TOUR — ' + stop.title, stop.desc);
      updateCastawayHUD();
    }
    window.goToTourStop = goToTourStop;

    const galleryModal = document.createElement('div');
    galleryModal.id = 'cc-gallery-modal';
    galleryModal.style.cssText = 'position:fixed;inset:0;z-index:130;background:rgba(3,10,18,0.94);backdrop-filter:blur(10px);display:none;flex-direction:column;padding:14px;overflow-y:auto;color:#eaf4ff;';
    galleryModal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;max-width:980px;width:100%;margin:0 auto 10px;">
        <div>
          <div style="font-size:14px;font-weight:800;color:#26e6c6;">📸 IN-ENGINE WEBGL LANDMARK GALLERY</div>
          <div style="font-size:11px;color:#90a4ae;">Tap any location to teleport there live in 3D</div>
        </div>
        <button id="cc-gallery-close" style="background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:800;cursor:pointer;">✕ Close</button>
      </div>
      <div id="cc-gallery-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;max-width:980px;width:100%;margin:0 auto;"></div>
    `;
    document.body.appendChild(galleryModal);

    document.getElementById('cc-gallery-close').addEventListener('click', () => {
      galleryModal.style.display = 'none';
    });

    function openLiveScreenshotGallery() {
      const grid = document.getElementById('cc-gallery-grid');
      if (!grid) return;
      grid.innerHTML = '';
      galleryModal.style.display = 'flex';
      const ts = document.getElementById('cc-title-screen');
      if (ts) ts.style.display = 'none';
      const cm = document.getElementById('cc-craft-modal');
      if (cm) cm.style.display = 'none';
      campaign.started = true;

      const savedPos = player.pos.clone();
      const savedYaw = player.yaw;
      const savedPitch = player.pitch;
      const savedDive = player.isDivingUnderwater;
      const savedTool = campaign.activeTool;

      for (let i = 0; i < TOUR_STOPS.length; i++) {
        goToTourStop(i);
        updateCalderaCastaway(0.016, 12.5, null);
        if (window.syncCaveAtmosphere) window.syncCaveAtmosphere(0.016, true);
        camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
        camera.rotation.order = 'YXZ';
        camera.rotation.y = player.yaw;
        camera.rotation.x = player.pitch;
        camera.rotation.z = 0;
        camera.updateMatrixWorld(true);
        scene.updateMatrixWorld(true);
        renderer.render(scene, camera);

        let dataUrl = '';
        try {
          dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.88);
        } catch (err) {}

        const stop = TOUR_STOPS[i];
        const card = document.createElement('div');
        card.style.cssText = 'background:rgba(12,24,38,0.95);border:1px solid rgba(38,230,198,0.35);border-radius:14px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;';
        card.innerHTML = `
          <img src="${dataUrl}" alt="${stop.title}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#071320;" />
          <div style="padding:8px 10px;">
            <div style="font-size:12px;font-weight:800;color:#26e6c6;margin-bottom:3px;">${stop.title}</div>
            <div style="font-size:10.5px;color:#cfd8dc;line-height:1.35;">${stop.desc}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          galleryModal.style.display = 'none';
          goToTourStop(i);
        });
        grid.appendChild(card);
      }

      player.pos.copy(savedPos);
      player.yaw = savedYaw;
      player.pitch = savedPitch;
      player.isDivingUnderwater = savedDive;
      if (savedTool) selectTool(savedTool);
      if (window.syncCaveAtmosphere) window.syncCaveAtmosphere(0.016, true);
    }
    window.openLiveScreenshotGallery = openLiveScreenshotGallery;

    window.stepShowcaseTour = function (delta) {
      goToTourStop(currentTourIdx + delta);
    };

    const titleScreen = document.createElement('div');
    titleScreen.id = 'cc-title-screen';
    titleScreen.innerHTML = `
      <div class="cc-title-card">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:0.14em;color:#26e6c6;text-transform:uppercase;">Island Survival Adventure</div>
        <h1 style="margin:5px 0 8px;font-size:24px;letter-spacing:0.02em;color:#ffffff;">CALDERA CASTAWAY</h1>
        <p style="font-size:12px;line-height:1.45;color:#cfd8dc;margin:0 0 14px;">
          Forced down in an uncharted volcanic archipelago aboard <b>Flight 409</b>. Gather resources, craft gear, sail the outrigger raft, and repair the hilltop Radio Outpost to signal rescue.
        </p>
        <button class="cc-btn-primary" id="cc-start-campaign">▶ Play Survival Campaign</button>
        <button class="cc-btn-secondary" id="cc-start-free">🧭 Free Exploration</button>
      </div>
    `;
    document.body.appendChild(titleScreen);

    document.getElementById('cc-start-campaign').addEventListener('click', () => {
      AudioEngine.init();
      campaign.started = true;
      campaign.mode = 'campaign';
      titleScreen.style.display = 'none';
      player.pos.set(-40.0, getTerrainHeight(-40.0, -28.0) + 0.2, -28.0);
      player.yaw = 0.79;
      player.pitch = -0.04;
      showStoryDialog(
        '🎙️ FLIGHT 409 — CRASH COVE',
        'Inspect the wrecked seaplane ahead to recover the Cockpit Transponder, or board the Outrigger Raft along the shore.'
      );
      updateCastawayHUD();
    });

    document.getElementById('cc-start-free').addEventListener('click', () => {
      AudioEngine.init();
      campaign.started = true;
      campaign.mode = 'free';
      titleScreen.style.display = 'none';
      showToast('🧭 Free Exploration Mode active');
      updateCastawayHUD();
    });
  }

  function showStoryDialog(title, body) {
    const banner = document.getElementById('cc-dialog-banner');
    const tEl = document.getElementById('cc-dialog-title');
    const bEl = document.getElementById('cc-dialog-body');
    if (!banner || !tEl || !bEl) return;
    tEl.innerText = title;
    bEl.innerText = body;
    banner.style.display = 'block';
    clearTimeout(showStoryDialog._timer);
    showStoryDialog._timer = setTimeout(() => {
      banner.style.display = 'none';
    }, 6500);
  }
  window.showStoryDialog = showStoryDialog;

  function updateCastawayHUD() {
    const setTxt = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val;
    };
    setTxt('cc-cnt-bamboo', player.inventory.bamboo || 0);
    setTxt('cc-cnt-obsidian', player.inventory.obsidian || 0);
    setTxt('cc-cnt-fish', (player.inventory.rawFish || 0) + (player.inventory.rawMeat || 0));
    setTxt('cc-cnt-food', player.inventory.cookedFood || 0);
    setTxt('cc-cnt-arrows', player.inventory.arrows || 0);
    setTxt('cc-cnt-bolts', player.inventory.bolts || 0);
    setTxt('cc-cnt-dyn', player.inventory.dynamite || 0);
    setTxt('cc-cnt-flares', player.inventory.flares || 0);
    setTxt('timber-count', player.inventory.timber || 0);
    setTxt('stone-count', player.inventory.stone || 0);

    const m = campaign.modulesFound;
    const count = (m.cockpitTransponder ? 1 : 0) + (m.submergedBattery ? 1 : 0) + (m.cavernRecorder ? 1 : 0);
    const miniObj = document.getElementById('cc-objective-mini');
    if (miniObj) {
      if (campaign.rescueTriggered) {
        miniObj.innerText = '🏆 Rescued!';
      } else if (campaign.outpostRepaired) {
        miniObj.innerText = '🎇 Fire Flare!';
      } else {
        miniObj.innerText = `📡 ${count}/3 Avionics`;
      }
    }
    const objText = document.getElementById('cc-objective-text');
    if (objText) {
      if (campaign.rescueTriggered) {
        objText.innerText = '🏆 Rescue Seaplane Inbound! Campaign Complete — Free Sandbox Active.';
      } else if (campaign.outpostRepaired) {
        objText.innerText = '🎇 Radio Outpost Online! Equip Flare Gun & fire into the sky!';
      } else {
        objText.innerText = `📡 Avionics Modules: ${count}/3 found • Repair Radio Outpost at (52, 96)`;
      }
    }

    document.querySelectorAll('#cc-arsenal-grid .cc-tool-slot').forEach(slot => {
      const t = slot.dataset.tool;
      const isLocked = ['bow', 'crossbow', 'pistol', 'rifle'].includes(t) && !campaign.unlockedWeapons[t];
      slot.classList.toggle('locked', isLocked);
    });

    // Live ammo & ration count badges on the 5-Slot Quick Belt
    const slotRanged = document.getElementById('cc-belt-ranged');
    if (slotRanged) {
      const rTool = slotRanged.dataset.tool || 'bow';
      const rMeta = {
        bow:      { ico: '🏹', lbl: 'Bow',    cnt: player.inventory.arrows || 0 },
        crossbow: { ico: '🎯', lbl: 'X-Bow',  cnt: player.inventory.bolts || 0 },
        pistol:   { ico: '🔫', lbl: 'Pistol', cnt: player.inventory.pistolAmmo || 0 },
        rifle:    { ico: '🎯', lbl: 'Rifle',  cnt: player.inventory.rifleAmmo || 0 }
      }[rTool];
      if (rMeta) {
        slotRanged.innerHTML = `<span class="ico">${rMeta.ico}</span><span>${rMeta.lbl}·${rMeta.cnt}</span>`;
      }
    }
    const slotUtil = document.getElementById('cc-belt-util');
    if (slotUtil) {
      const uTool = slotUtil.dataset.tool || 'torch';
      if (uTool === 'flare') {
        slotUtil.innerHTML = `<span class="ico">🎇</span><span>Flare·${player.inventory.flares || 0}</span>`;
      } else if (uTool === 'dynamite') {
        slotUtil.innerHTML = `<span class="ico">🧨</span><span>Blast·${player.inventory.dynamite || 0}</span>`;
      }
    }
    const slotPack = document.getElementById('cc-belt-pack');
    if (slotPack) {
      const rations = player.inventory.cookedFood || 0;
      slotPack.innerHTML = `<span class="ico">🎒</span><span>${rations > 0 ? `Pack·${rations}` : 'Pack'}</span>`;
    }
    const allUnlocked = !!campaign.sandboxUnlocked || (
      campaign.unlockedWeapons.bow &&
      campaign.unlockedWeapons.crossbow &&
      campaign.unlockedWeapons.pistol &&
      campaign.unlockedWeapons.rifle &&
      campaign.raftBuilt &&
      campaign.boatBuilt &&
      count >= 3
    );
    const dbgUnlockBtn = document.getElementById('btn-debug-unlock-all');
    if (dbgUnlockBtn) {
      dbgUnlockBtn.classList.toggle('active', allUnlocked);
      dbgUnlockBtn.innerText = allUnlocked ? '✅ All Gear, Boats & Collectibles Unlocked' : '🎁 Unlock All Gear, Boats & Collectibles';
    }
    const worldUnlockBtn = document.getElementById('btn-world-unlock-all');
    if (worldUnlockBtn) {
      worldUnlockBtn.classList.toggle('active', allUnlocked);
      worldUnlockBtn.innerText = allUnlocked ? '✅ All Weapons, Boats & Collectibles Unlocked' : '🎁 Unlock All Weapons, Boats & Collectibles';
    }
    const worldUnlockBadge = document.getElementById('unlock-all-badge');
    if (worldUnlockBadge) {
      worldUnlockBadge.innerText = allUnlocked ? 'All Unlocked' : 'Survival';
    }
    const packUnlockBtn = document.getElementById('cc-act-unlock-all');
    if (packUnlockBtn) {
      packUnlockBtn.innerText = allUnlocked ? '✅ All Unlocked (Tap to Top Up Supplies)' : '🎁 Unlock All Weapons, Boats & Collectibles';
    }
  }

  async function initCalderaCastaway() {
    try {
      await initAAASurfacePBRMaps();
      initSharedSurfaceMaterials();
      await yieldFrame();

      buildCrashedSeaplane();
      await yieldFrame();
      buildSubmergedRuins();
      await yieldFrame();
      buildBambooAndMangroves();
      await yieldFrame();
      buildVolcanicCalderaBiome();
      await yieldFrame();
      buildRadioOutpost();
      await yieldFrame();
      buildArchipelagoExpeditionLandmarks();
      buildRareExpeditionCaches();
      await yieldFrame();
      buildOutriggerRaft();
      await yieldFrame();

      buildSpearTool();
      buildFishingRodTool();
      await yieldFrame();
      buildTorchTool();
      buildFlareGunTool();
      buildHammerTool();
      buildHuntingWeapons();
      await yieldFrame();

      await buildWolfPBRMapsAndMaterialsAsync();
      await yieldFrame();
      buildSharedWolfGeometries();
      await yieldFrame();
      buildSharedBoarAssets();
      await yieldFrame();

      await spawnBoarsAndWolvesAsync();

      buildSharedCrabAssets();
      spawnCrabs();
      await yieldFrame();

      buildSharedFishAssets();
      spawnFish();
      buildInstancedUnderwaterSchoolsAndRays();
      await yieldFrame();

      buildSharedSharkAssets();
      spawnSharks();
      await yieldFrame();

      await spawnForestWildlifeAsync();
      await yieldFrame();

      buildSharedEagleAssets();
      spawnEagles();
      await yieldFrame();

      buildCastawayUI();
      updateCastawayHUD();
    } catch (err) {
      console.error('[CalderaCastawayInitError]', err);
      throw err;
    }
  }
  window._calderaReadyPromise = initCalderaCastaway();

  // ============================================================================
  // 13. ZERO-FIDELITY-LOSS 60 FPS FRAME UPDATE LOOP + SPATIAL CULLER
  // ============================================================================
  let frameCounter = 0;
  let _torchPrevPx = null, _torchPrevPz = null, _torchPrevYaw = null;
  const _torchSway = new THREE.Vector3(0, 0, 0);

  window.updateCalderaCastaway = function (dt, timeSec, wish) {
    frameCounter++;

    const px = player.pos.x;
    const py = player.pos.y;
    const pz = player.pos.z;

    // A. SPATIAL RAYCAST FILTER (Every 4 frames: restricts window.interactiveTargets to objects within 11m!)
    // Zero visual impact — eliminates 99% of per-frame raycast CPU cost!
    if (frameCounter % 4 === 1) {
      interactiveTargets.length = 0;
      for (let i = 0; i < masterInteractiveTargets.length; i++) {
        const obj = masterInteractiveTargets[i];
        if (!obj || !obj.parent) continue;
        const dx = obj.position.x - px;
        const dz = obj.position.z - pz;
        if (dx * dx + dz * dz <= 121.0) {
          interactiveTargets.push(obj);
        }
      }
    }

    // B. FIXED 4-LIGHT HARDWARE POOL SYNC (Every 4 frames: maps the 4 nearest virtual lights to pointLightPool[0..3])
    // Keeps #define NUM_POINT_LIGHTS strictly constant forever — 0 GLSL shader recompilations!
    if (frameCounter % 4 === 2) {
      let b0 = null, b1 = null, b2 = null, b3 = null;
      let d0 = Infinity, d1 = Infinity, d2 = Infinity, d3 = Infinity;

      for (let i = 0; i < managedPointLights.length; i++) {
        const ml = managedPointLights[i];
        const src = ml.light;
        if (!src || (src.userData && src.userData.disabled) || src.intensity <= 0.01) continue;
        const dx = ml.worldPos.x - px;
        const dy = ml.worldPos.y - py;
        const dz = ml.worldPos.z - pz;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq > ml.maxDistSq) continue;

        if (dSq < d0) {
          d3 = d2; b3 = b2;
          d2 = d1; b2 = b1;
          d1 = d0; b1 = b0;
          d0 = dSq; b0 = ml;
        } else if (dSq < d1) {
          d3 = d2; b3 = b2;
          d2 = d1; b2 = b1;
          d1 = dSq; b1 = ml;
        } else if (dSq < d2) {
          d3 = d2; b3 = b2;
          d2 = dSq; b2 = ml;
        } else if (dSq < d3) {
          d3 = dSq; b3 = ml;
        }
      }

      const winners = [b0, b1, b2, b3];
      for (let s = 0; s < POINT_LIGHT_POOL_SIZE; s++) {
        const pl = pointLightPool[s];
        const w = winners[s];
        if (w && w.light) {
          pl.position.copy(w.worldPos);
          pl.color.copy(w.light.color);
          pl.intensity = w.light.intensity;
          pl.distance = w.light.distance || 40.0;
          pl.decay = w.light.decay || 1.4;
        } else {
          pl.intensity = 0.0;
        }
      }
    }

    // 1. Update Animated Landmark Props & AAA Wolf Fur Shader Uniforms
    wolfShaderUniforms.uFurTime.value = timeSec;
    if (window.sunLight) {
      wolfShaderUniforms.uSunDir.value.copy(window.sunLight.position).normalize();
    }
    for (let i = 0; i < animatedProps.length; i++) {
      animatedProps[i].update(dt, timeSec);
    }

    // 2. Update First-Person Active Tool Pose (Hip vs Braced Aim), Recoil Kickback & Torch Flicker
    if (campaign.toolSwing > 0) {
      campaign.toolSwing = Math.max(0, campaign.toolSwing - dt * 5.0);
    }
    const wr = campaign.weaponRecoil;
    const damp = Math.exp(-15.0 * dt);
    const camDamp = Math.exp(-12.5 * dt);
    wr.camPitch *= camDamp;
    wr.camYaw *= camDamp;
    wr.modelZ *= damp;
    wr.modelPitch *= damp;
    wr.fovPunch *= Math.exp(-14.0 * dt);
    if (Math.abs(wr.camPitch) < 0.0002) wr.camPitch = 0;
    if (Math.abs(wr.camYaw) < 0.0002) wr.camYaw = 0;
    if (Math.abs(wr.modelZ) < 0.0002) wr.modelZ = 0;
    if (Math.abs(wr.modelPitch) < 0.0002) wr.modelPitch = 0;
    if (Math.abs(wr.fovPunch) < 0.01) wr.fovPunch = 0;
    player.recoilPitchOffset = wr.camPitch;
    player.recoilYawOffset = wr.camYaw;

    const activeCfg = RANGED_WEAPON_CONFIG[campaign.activeTool];
    const isAimingNow = !!(campaign.rangedAim.active && activeCfg && campaign.rangedAim.tool === campaign.activeTool);
    if (isAimingNow) {
      campaign.rangedAim.holdTime += dt;
    }
    const targetPoseBlend = isAimingNow ? 1.0 : 0.0;
    campaign.weaponPoseBlend += (targetPoseBlend - campaign.weaponPoseBlend) * Math.min(1.0, 14.0 * dt);
    const targetAimFov = (isAimingNow ? activeCfg.zoomFov : 0.0) + wr.fovPunch;
    player.aimFovOffset = (player.aimFovOffset || 0) + (targetAimFov - (player.aimFovOffset || 0)) * Math.min(1.0, 14.0 * dt);

    // Update 3D Muzzle Flash & Gunsmoke Wisps
    for (let me = activeMuzzleEffects.length - 1; me >= 0; me--) {
      const mfx = activeMuzzleEffects[me];
      mfx.age += dt;
      if (mfx.age >= mfx.maxLife) {
        if (mfx.flashMesh && mfx.flashMesh.parent) mfx.flashMesh.parent.remove(mfx.flashMesh);
        for (let s = 0; s < mfx.smokePuffs.length; s++) {
          const sp = mfx.smokePuffs[s];
          if (sp.mesh && sp.mesh.parent) sp.mesh.parent.remove(sp.mesh);
        }
        activeMuzzleEffects.splice(me, 1);
        continue;
      }
      if (mfx.flashMesh && mfx.flashMat) {
        const ft = Math.min(1.0, mfx.age / 0.085);
        mfx.flashMesh.scale.setScalar(1.0 + ft * 0.65);
        mfx.flashMat.opacity = Math.max(0, (1.0 - ft) * 0.96);
        if (ft >= 1.0) mfx.flashMesh.visible = false;
      }
      const st = mfx.age / mfx.maxLife;
      for (let s = 0; s < mfx.smokePuffs.length; s++) {
        const sp = mfx.smokePuffs[s];
        sp.mesh.position.addScaledVector(sp.vel, dt);
        const sc = 1.0 + st * 2.8;
        sp.mesh.scale.setScalar(sc);
        sp.mat.opacity = Math.max(0, (1.0 - st) * 0.34);
      }
    }

    const activeMesh = toolMeshes[campaign.activeTool];
    if (activeMesh && campaign.activeTool !== 'hatchet') {
      const moveMag = (wish && typeof wish.length === 'function') ? wish.length() : 0;
      const aimSteady = 1.0 - campaign.weaponPoseBlend * 0.68;
      const swayX = Math.sin(timeSec * 7.0) * 0.018 * moveMag * aimSteady;
      const swayY = Math.abs(Math.cos(timeSec * 7.0)) * 0.022 * moveMag * aimSteady;
      if (activeCfg) {
        const b = campaign.weaponPoseBlend;
        const hp = activeCfg.hipPos, ap = activeCfg.aimPos;
        const hr = activeCfg.hipRot, ar = activeCfg.aimRot;
        let reloadDipY = 0, reloadPitch = 0, reloadRoll = 0;
        if (campaign.activeTool === 'crossbow' && campaign.crossbowCooldown > 0) {
          const reloadPhase = 1.0 - Math.min(1.0, campaign.crossbowCooldown / 1.8);
          const crankArc = Math.sin(Math.min(1.0, reloadPhase * 1.15) * Math.PI);
          reloadDipY = -0.045 * crankArc;
          reloadPitch = -0.18 * crankArc;
          reloadRoll = 0.22 * crankArc;
        }
        if (campaign.chamberCycleTimer > 0 && campaign.chamberCycleWeapon === campaign.activeTool) {
          const ct = 1.0 - (campaign.chamberCycleTimer / Math.max(0.01, campaign.chamberCycleDuration));
          if (campaign.activeTool === 'rifle') {
            const boltArc = Math.sin(Math.min(1.0, ct * 1.2) * Math.PI);
            reloadRoll += -0.18 * boltArc;
            reloadPitch += 0.04 * boltArc;
            if (activeMesh.userData.boltHandle) {
              activeMesh.userData.boltHandle.position.z = -0.14 + Math.sin(ct * Math.PI) * 0.055;
            }
          } else if (campaign.activeTool === 'pistol' && activeMesh.userData.slideMesh) {
            const slideArc = Math.sin(ct * Math.PI);
            activeMesh.userData.slideMesh.position.z = -0.09 + slideArc * 0.045;
          }
        } else {
          if (activeMesh.userData.slideMesh) activeMesh.userData.slideMesh.position.z = -0.09;
          if (activeMesh.userData.boltHandle) activeMesh.userData.boltHandle.position.z = -0.14;
        }
        activeMesh.position.x = hp.x + (ap.x - hp.x) * b + swayX;
        activeMesh.position.y = hp.y + (ap.y - hp.y) * b + swayY + wr.modelZ * 0.16 + reloadDipY;
        activeMesh.position.z = hp.z + (ap.z - hp.z) * b + wr.modelZ;
        activeMesh.rotation.x = hr.x + (ar.x - hr.x) * b + wr.modelPitch + reloadPitch;
        activeMesh.rotation.y = hr.y + (ar.y - hr.y) * b;
        activeMesh.rotation.z = hr.z + (ar.z - hr.z) * b + reloadRoll;
      } else {
        const thrust = Math.sin(campaign.toolSwing * Math.PI) * 0.24;
        const baseZ = (campaign.activeTool === 'spear' ? -0.66 : -0.58);
        activeMesh.position.x = 0.36 + swayX - thrust * 0.18;
        activeMesh.position.y = -0.36 + swayY + thrust * 0.08;
        activeMesh.position.z = baseZ - thrust;
      }

      if (campaign.activeTool === 'torch' && activeMesh.userData.flame) {
        const safeDt = Math.max(0.004, Math.min(0.1, dt));
        if (_torchPrevPx === null) {
          _torchPrevPx = px;
          _torchPrevPz = pz;
          _torchPrevYaw = player.yaw;
        }
        const vx = (px - _torchPrevPx) / safeDt;
        const vz = (pz - _torchPrevPz) / safeDt;
        let dYaw = player.yaw - _torchPrevYaw;
        while (dYaw > Math.PI) dYaw -= Math.PI * 2;
        while (dYaw < -Math.PI) dYaw += Math.PI * 2;
        const yawVel = dYaw / safeDt;
        _torchPrevPx = px;
        _torchPrevPz = pz;
        _torchPrevYaw = player.yaw;

        const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
        const rightX = Math.cos(player.yaw), rightZ = -Math.sin(player.yaw);
        const fwdSpeed = vx * fwdX + vz * fwdZ;
        const rightSpeed = vx * rightX + vz * rightZ;
        const swingThrust = Math.sin(campaign.toolSwing * Math.PI);

        // Aerodynamic drag pulls torch flame tips gently opposite player movement & yaw sweep
        const targetSwayX = Math.max(-0.085, Math.min(0.085,
          -rightSpeed * 0.0075 + yawVel * 0.022 + Math.sin(timeSec * 1.9) * 0.008));
        const targetSwayZ = Math.max(-0.065, Math.min(0.095,
          fwdSpeed * 0.0085 + swingThrust * 0.065 + Math.cos(timeSec * 1.4) * 0.006));
        const targetSwayY = -0.25 * (Math.abs(targetSwayX) + Math.abs(targetSwayZ));
        const swayLerp = 1.0 - Math.exp(-10.0 * safeDt);
        _torchSway.x += (targetSwayX - _torchSway.x) * swayLerp;
        _torchSway.y += (targetSwayY - _torchSway.y) * swayLerp;
        _torchSway.z += (targetSwayZ - _torchSway.z) * swayLerp;

        const tvfx = activeMesh.userData.vfx;
        if (tvfx && tvfx.torchFlameMat && tvfx.torchFlameMat.uniforms.uMotionSway) {
          tvfx.torchFlameMat.uniforms.uMotionSway.value.copy(_torchSway);
        }
        if (activeMesh.userData.flame.userData && activeMesh.userData.flame.userData.halo) {
          activeMesh.userData.flame.userData.halo.material.opacity = 0.17 + Math.sin(timeSec * 9.3) * 0.035;
        }
        if (activeMesh.userData.emberCore && activeMesh.userData.emberCore.material) {
          activeMesh.userData.emberCore.material.emissiveIntensity = 1.65 + Math.sin(timeSec * 6.7) * 0.25;
        }

        const cDark = window.caveDarknessFactor || 0.0;
        const caveTorchBoost = cDark * 3.85;
        playerTorchLight.intensity = 3.25 + caveTorchBoost
          + Math.sin(timeSec * 11.4) * 0.26
          + Math.cos(timeSec * 19.3) * 0.14
          + Math.sin(timeSec * 29.7) * 0.08;

        // Animate crisp rising ember sparks & subtle trailing smoke wisps on the Pitch Torch
        const spPts = activeMesh.userData.sparkPoints;
        const spSeeds = activeMesh.userData.sparkSeeds;
        if (spPts && spSeeds) {
          const posArr = spPts.geometry.attributes.position.array;
          for (let s = 0; s < spSeeds.length; s++) {
            const seed = spSeeds[s];
            const rate = 1.15 + (s % 4) * 0.22;
            const life = (timeSec * rate + seed) % 1.0;
            const ang = life * (5.5 + (s % 3) * 1.4) + seed * 6.28;
            const rad = 0.012 + Math.pow(life, 0.85) * 0.048;
            posArr[s * 3]     = Math.cos(ang) * rad + _torchSway.x * life * 0.85;
            posArr[s * 3 + 1] = 0.34 + life * 0.44;
            posArr[s * 3 + 2] = Math.sin(ang) * rad + _torchSway.z * life * 0.85;
          }
          spPts.geometry.attributes.position.needsUpdate = true;
        }
        const wisps = activeMesh.userData.smokeWisps;
        if (wisps) {
          for (let w = 0; w < wisps.length; w++) {
            const wisp = wisps[w];
            const wLife = (timeSec * 0.58 + wisp.userData.phase) % 1.0;
            wisp.position.set(
              Math.sin(wLife * 4.5 + w) * 0.032 * wLife + _torchSway.x * (0.4 + wLife * 0.9),
              0.50 + wLife * 0.38,
              Math.cos(wLife * 4.0 + w) * 0.032 * wLife + _torchSway.z * (0.4 + wLife * 0.9)
            );
            const wScale = 0.065 + wLife * 0.14;
            wisp.scale.set(wScale, wScale, 1);
            wisp.material.opacity = Math.sin(wLife * Math.PI) * 0.10;
          }
        }
      }
    }
    // Faint 1.8m tactile arm-reach calcite glint in deep cave darkness when torch is unequipped (prevents blind wall soft-locks)
    if (campaign.activeTool !== 'torch') {
      const cDark = window.caveDarknessFactor || 0.0;
      if (cDark > 0.55) {
        playerTorchLight.color.setHex(0x6ec6d8);
        playerTorchLight.distance = 3.2;
        playerTorchLight.decay = 1.35;
        playerTorchLight.intensity = (cDark - 0.55) * 0.42;
      } else {
        playerTorchLight.intensity = 0.0;
      }
    } else {
      const cDark = window.caveDarknessFactor || 0.0;
      playerTorchLight.color.setHex(cDark > 0.25 ? 0xffb366 : 0xff9c42);
      playerTorchLight.distance = 36.0 + cDark * 26.0;
      playerTorchLight.decay = 1.15 - cDark * 0.30;
    }

    // 3. Update Modular Builder Holographic Placement Ghost
    if (campaign.activeTool === 'build') {
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, player.yaw, 0));
      const gx = Math.round((px + fwd.x * 3.8) / 1.9) * 1.9;
      const gz = Math.round((pz + fwd.z * 3.8) / 1.9) * 1.9;
      const gy = Math.max(getTerrainHeight(gx, gz), window.getSupportSurfaceY(gx, gz, py));
      buildGhost.position.set(gx, gy + (campaign.buildPiece === 'roof' ? 2.6 : 0.06), gz);
      buildGhost.rotation.y = Math.round(player.yaw / (Math.PI / 2)) * (Math.PI / 2);
      buildGhost.visible = true;
    } else {
      buildGhost.visible = false;
    }

    // 4. Update Outrigger Bamboo Raft Boarding & Sailing Physics (Dirty-Checked DOM Sync)
    const distToRaft = Math.hypot(px - raftState.pos.x, pz - raftState.pos.z);
    const distToBoat = raftState.boatPos ? Math.hypot(px - raftState.boatPos.x, pz - raftState.boatPos.z) : 999;
    const raftBtn = updateCalderaCastaway._raftBtn || (updateCalderaCastaway._raftBtn = document.getElementById('cc-raft-btn'));
    if (raftBtn) {
      const nearCraft = distToRaft < 8.5 || (campaign.boatBuilt && distToBoat < 8.5);
      const nextState = campaign.onRaft ? 'on' : (nearCraft ? 'near' : 'far');
      const token = nextState + (campaign.raftBuilt ? 'R' : 'r') + (campaign.boatBuilt ? 'B' : 'b') + (distToBoat < distToRaft ? '1' : '0');
      if (updateCalderaCastaway._lastRaftState !== token) {
        updateCalderaCastaway._lastRaftState = token;
        if (nextState === 'on') {
          raftBtn.style.display = 'block';
          raftBtn.innerText = '⚓ Disembark';
        } else if (nextState === 'near') {
          raftBtn.style.display = 'block';
          if (!campaign.raftBuilt && distToRaft <= distToBoat) raftBtn.innerText = '🛶 Hull not lashed';
          else if (campaign.boatBuilt && distToBoat < distToRaft) raftBtn.innerText = '⛵ Board keeled boat';
          else raftBtn.innerText = '🛶 Board bamboo raft';
        } else {
          raftBtn.style.display = 'none';
        }
      }
    }

    if (frameCounter % 20 === 0 && window.archipelagoIslets && campaign.boatParts) {
      const partNames = { keel: 'stone keel', brace: 'obsidian brace', skin: 'coral resin', sail: 'fiber sail' };
      for (let i = 0; i < window.archipelagoIslets.length; i++) {
        const isl = window.archipelagoIslets[i];
        if (!isl.part || campaign.boatParts[isl.part]) continue;
        if (Math.hypot(px - isl.x, pz - isl.z) < (isl.form === 'ring' ? isl.r * 1.05 : isl.r * 0.72)) {
          campaign.boatParts[isl.part] = true;
          if (isl._marker) isl._marker.visible = false;
          showToast('Recovered the ' + partNames[isl.part] + ' from ' + isl.name + '.');
        }
      }
    }

    // Geothermal Fumarole & Lava Tube Warming (restores body warmth & stamina near volcanic steam vents)
    if (window.geothermalVents) {
      for (let gv = 0; gv < window.geothermalVents.length; gv++) {
        const vent = window.geothermalVents[gv];
        const dSq = (px - vent.x) * (px - vent.x) + (pz - vent.z) * (pz - vent.z);
        if (dSq < 196.0) { // within 14m of fumarole / summit brazier
          player.vitals.temp = Math.min(37.4, player.vitals.temp + dt * 0.45);
          player.vitals.stamina = Math.min(100, player.vitals.stamina + dt * 4.5);
          break;
        }
      }
    }

    const floatCraft = (pos) => {
      const w = getWaterInfo(pos.x, pos.z, timeSec);
      const targetY = w.isWater ? w.surfaceY + 0.06 : getTerrainHeight(pos.x, pos.z) + 0.2;
      pos.y += (targetY - pos.y) * Math.min(1.0, 6.0 * dt);
    };
    floatCraft(raftState.pos);
    if (raftState.boatPos) floatCraft(raftState.boatPos);

    if (campaign.onRaft) {
      const usingBoat = campaign.vessel === 'boat' && campaign.boatBuilt;
      const pos = usingBoat ? raftState.boatPos : raftState.pos;
      let sailSpeed = usingBoat ? 22 : 14.5;
      const sea = window.getSeaBand ? window.getSeaBand(pos.x, pos.z) : null;
      const storm = campaign.weather && (campaign.weather.current === 'storm' || campaign.weather.current === 'rain');
      const drift = (usingBoat ? 0.45 : 2.7) * (storm ? 1.55 : 1);
      if (sea && sea.band === 'trench' && !usingBoat) {
        sailSpeed = 1.1;
        if (!campaign._trenchTold) {
          campaign._trenchTold = true;
          showToast('The raft makes no headway in the trench. This water wants the keeled boat.');
          setTimeout(() => { campaign._trenchTold = false; }, 9000);
        }
      }
      pos.x += 0.71 * drift * dt;
      pos.z += -0.70 * drift * dt;
      if (wish && wish.lengthSq() > 0.02) {
        const nextX = Math.max(-1220, Math.min(1220, pos.x + wish.x * sailSpeed * dt));
        const nextZ = Math.max(-1220, Math.min(1220, pos.z + wish.z * sailSpeed * dt));
        if (getTerrainHeight(nextX, nextZ) < pos.y + 0.5) {
          pos.x = nextX;
          pos.z = nextZ;
          const yaw = Math.atan2(-wish.x, -wish.z);
          if (usingBoat) raftState.boatYaw = yaw;
          else raftState.yaw = yaw;
          if ((frameCounter % 10) === 0) {
            addWaterRipple(pos.x - Math.sin(yaw) * 2.2, pos.z - Math.cos(yaw) * 2.2, usingBoat ? 1.75 : 1.35);
          }
        }
      }
      player.pos.set(pos.x, pos.y + (usingBoat ? 0.5 : 0.32), pos.z);
      player.vel.set(0, 0, 0);
      player.isSwimming = false;
      player.isGrounded = true;
      player.washingBack = false;
      camera.position.set(player.pos.x, player.pos.y + 1.88, player.pos.z);
    }

    // Live Naval Wind-Vane, Sea-Band & Boat-Part HUD Indicator
    if ((frameCounter & 7) === 0) {
      const navalHud = updateCalderaCastaway._navalHud || (updateCalderaCastaway._navalHud = document.getElementById('cc-naval-hud'));
      if (navalHud) {
        const sea = window.getSeaBand ? window.getSeaBand(px, pz) : { band: 'lee', distShore: 0, offshoreFactor: 0 };
        const showNaval = campaign.onRaft || (player.isSwimming && ((sea.distShore || 0) > 25 || Math.abs(px) > 150 || Math.abs(pz) > 150));
        if (!showNaval) {
          if (navalHud.style.display !== 'none') navalHud.style.display = 'none';
        } else {
          const distM = Math.round(sea.distShore || 0);
          const bandLbl = sea.band === 'trench'
            ? `🦈 Stronghold Trench (${distM}m)`
            : (sea.band === 'open'
                ? `🌬️ Open Trade Wind (${distM}m offshore)`
                : (sea.band === 'swell'
                    ? `🌊 Offshore Swell (${distM}m offshore)`
                    : `🏖️ Sheltered Lagoon (${distM}m from shore)`));
          const vesselLbl = campaign.onRaft
            ? (campaign.vessel === 'boat' ? '⛵ Keeled Boat' : '🛶 Bamboo Raft')
            : (player.vitals && player.vitals.stamina < 25 ? '🏊 Swimming (Tired)' : '🏊 Swimming');
          const bp = campaign.boatParts || {};
          const partCnt = (bp.keel ? 1 : 0) + (bp.brace ? 1 : 0) + (bp.skin ? 1 : 0) + (bp.sail ? 1 : 0);
          const partStr = campaign.boatBuilt ? '• ✅ Boat Built' : `• ⚙️ Boat Parts: ${partCnt}/4`;
          navalHud.style.display = 'block';
          navalHud.innerText = `${vesselLbl} • ${bandLbl} ${partStr}`;
        }
      }
    }

    raftState.mesh.position.copy(raftState.pos);
    raftState.mesh.rotation.y = raftState.yaw;
    raftState.mesh.rotation.x = Math.sin(timeSec * 2.2 + raftState.pos.x * 0.2) * 0.045;
    raftState.mesh.rotation.z = Math.cos(timeSec * 1.9 + raftState.pos.z * 0.2) * 0.045;
    if (raftState.boatMesh) {
      raftState.boatMesh.position.copy(raftState.boatPos);
      const bYaw = raftState.boatYaw || 0.2;
      raftState.boatMesh.rotation.y = bYaw;
      raftState.boatMesh.rotation.x = Math.sin(timeSec * 2.0 + raftState.boatPos.x * 0.15) * 0.038;
      raftState.boatMesh.rotation.z = Math.cos(timeSec * 1.7 + raftState.boatPos.z * 0.15) * 0.035;
      const u = raftState.boatMesh.userData;
      if (u && u.sailPivot) {
        u.sailPivot.rotation.y = Math.sin(bYaw - 0.78) * 0.55 + Math.sin(timeSec * 2.6) * 0.05;
      }
      if (u && u.rudderPivot && wish) {
        u.rudderPivot.rotation.y = Math.max(-0.45, Math.min(0.45, -wish.x * 0.35));
      }
    }

    // 5. Update Interactive Fishing Bobber & Bite Minigame
    const fs = campaign.fishingState;
    if (fs.cast) {
      fs.biteTimer -= dt;
      const bw = getWaterInfo(fs.bobberPos.x, fs.bobberPos.z, timeSec);
      if (fs.biteTimer <= 0 && !fs.biting) {
        fs.biting = true;
        fs.biteTimer = 2.8;
        addWaterRipple(fs.bobberPos.x, fs.bobberPos.z, 1.6);
        AudioEngine.playSplash();
        showToast('🐟 FISH ON! Bobber is plunging — Tap Strike NOW to reel it in!');
      } else if (fs.biting && fs.biteTimer <= 0) {
        fs.biting = false;
        fs.biteTimer = 3.0 + Math.random() * 2.5;
      }
      const bobOffset = fs.biting ? Math.sin(timeSec * 22.0) * 0.24 - 0.15 : Math.sin(timeSec * 3.5) * 0.05;
      fishingBobber.position.y = (bw.isWater ? bw.surfaceY : 0.05) + bobOffset;
    }

    if (campaign.crossbowCooldown > 0) {
      campaign.crossbowCooldown = Math.max(0, campaign.crossbowCooldown - dt);
    }
    if (campaign.chamberCycleTimer > 0) {
      campaign.chamberCycleTimer = Math.max(0, campaign.chamberCycleTimer - dt);
      if (campaign.chamberCycleTimer <= 0) campaign.chamberCycleWeapon = null;
    }
    if (campaign.arrowReloadVisualTimer && campaign.arrowReloadVisualTimer > 0) {
      campaign.arrowReloadVisualTimer = Math.max(0, campaign.arrowReloadVisualTimer - dt);
    }
    if (activeMesh) {
      if (campaign.activeTool === 'bow' && activeMesh.userData.nockedArrow) {
        activeMesh.userData.nockedArrow.visible = (player.inventory.arrows || 0) > 0 && !(campaign.arrowReloadVisualTimer > 0);
      } else if (campaign.activeTool === 'crossbow') {
        const hasAmmo = ((player.inventory.bolts || 0) + (player.inventory.arrows || 0)) > 0;
        const reloadPct = campaign.crossbowCooldown > 0 ? Math.max(0, Math.min(1, 1.0 - (campaign.crossbowCooldown / 1.8))) : 1.0;
        if (activeMesh.userData.loadedBolt) {
          activeMesh.userData.loadedBolt.visible = hasAmmo && campaign.crossbowCooldown <= 0.35;
          activeMesh.userData.loadedBolt.position.z = campaign.crossbowCooldown > 0
            ? -0.29 - (0.35 - Math.min(0.35, campaign.crossbowCooldown)) * 0.12 + (campaign.crossbowCooldown * 0.25)
            : -0.29;
        }
        if (activeMesh.userData.xbowLeftStr && activeMesh.userData.xbowRightStr && activeMesh.userData.xbowLatch) {
          // Draw crossbow string & latch progressively from uncocked (-0.43) back to cocked (-0.18) across reload
          const drawFrac = (campaign.crossbowCooldown > 0)
            ? Math.max(0, Math.min(1, (reloadPct - 0.15) / 0.78))
            : 1.0;
          const latchZ = -0.43 + drawFrac * 0.25;
          const dz = latchZ - (-0.45);
          const halfSpan = Math.hypot(0.23, dz);
          const sweep = Math.atan2(dz, 0.23);
          activeMesh.userData.xbowLatch.position.z = latchZ;
          activeMesh.userData.xbowLeftStr.position.set(-0.115, 0.042, (-0.45 + latchZ) * 0.5);
          activeMesh.userData.xbowLeftStr.scale.set(halfSpan, 1, 1);
          activeMesh.userData.xbowLeftStr.rotation.y = -sweep;
          activeMesh.userData.xbowRightStr.position.set(0.115, 0.042, (-0.45 + latchZ) * 0.5);
          activeMesh.userData.xbowRightStr.scale.set(halfSpan, 1, 1);
          activeMesh.userData.xbowRightStr.rotation.y = sweep;
        }
      }
    }
    const bowArcEl = document.getElementById('cc-bow-arc');
    const aimBadgeEl = document.getElementById('cc-aim-badge');
    if (campaign.bowDraw.holding && campaign.activeTool === 'bow') {
      campaign.bowDraw.holdTime += dt;
      campaign.bowDraw.power = Math.min(1.0, campaign.bowDraw.power + dt * 1.15);
      const inBreathWindow = campaign.bowDraw.holdTime >= 0.35 && campaign.bowDraw.holdTime <= 1.15;
      window._bowBreathSteady = inBreathWindow;
      if (inBreathWindow && !campaign.rangedAim.breathHapticFired) {
        campaign.rangedAim.breathHapticFired = true;
        if (AudioEngine.playBowSteadyCue) AudioEngine.playBowSteadyCue();
        if (AudioEngine._haptic) AudioEngine._haptic(12);
      }
      if (campaign.bowDraw.holdTime > 4.0) {
        player.vitals.stamina = Math.max(5, player.vitals.stamina - dt * 12.0);
      }
      const drawPull = campaign.bowDraw.power * 0.16;
      if (activeMesh && activeMesh.userData.nockedArrow) {
        activeMesh.userData.nockedArrow.position.z = drawPull;
      }
      if (activeMesh && activeMesh.userData.upperString && activeMesh.userData.lowerString) {
        const segLen = Math.hypot(0.56, drawPull);
        const tilt = Math.atan2(drawPull, 0.56);
        activeMesh.userData.upperString.position.set(0, 0.28, 0.08 + drawPull * 0.5);
        activeMesh.userData.upperString.scale.set(1, segLen, 1);
        activeMesh.userData.upperString.rotation.x = -tilt;
        activeMesh.userData.lowerString.position.set(0, -0.28, 0.08 + drawPull * 0.5);
        activeMesh.userData.lowerString.scale.set(1, segLen, 1);
        activeMesh.userData.lowerString.rotation.x = tilt;
      }
      if (bowArcEl) {
        const sz = Math.round(52 - campaign.bowDraw.power * 28);
        bowArcEl.classList.add('is-aiming');
        bowArcEl.style.width = `${sz}px`;
        bowArcEl.style.height = `${sz}px`;
        bowArcEl.style.borderColor = inBreathWindow
          ? 'rgba(38,230,198,0.98)'
          : (campaign.bowDraw.power > 0.85 ? 'rgba(105,240,174,0.95)' : 'rgba(255,224,130,0.82)');
      }
    } else {
      window._bowBreathSteady = false;
      if (activeMesh && campaign.activeTool === 'bow') {
        if (activeMesh.userData.nockedArrow) activeMesh.userData.nockedArrow.position.z = 0;
        if (activeMesh.userData.upperString && activeMesh.userData.lowerString) {
          activeMesh.userData.upperString.position.set(0, 0.28, 0.08);
          activeMesh.userData.upperString.scale.set(1, 0.56, 1);
          activeMesh.userData.upperString.rotation.x = 0;
          activeMesh.userData.lowerString.position.set(0, -0.28, 0.08);
          activeMesh.userData.lowerString.scale.set(1, 0.56, 1);
          activeMesh.userData.lowerString.rotation.x = 0;
        }
      }
      if (bowArcEl && isRangedAimTool(campaign.activeTool)) {
        bowArcEl.classList.toggle('is-aiming', isAimingNow);
        if (campaign.activeTool === 'bow') {
          bowArcEl.style.width = '46px';
          bowArcEl.style.height = '46px';
          bowArcEl.style.borderColor = 'rgba(255,224,130,0.75)';
        } else if (campaign.activeTool === 'crossbow') {
          const reloading = campaign.crossbowCooldown > 0;
          bowArcEl.style.width = isAimingNow ? '24px' : '28px';
          bowArcEl.style.height = isAimingNow ? '24px' : '28px';
          bowArcEl.style.borderColor = reloading
            ? 'rgba(255, 167, 38, 0.88)'
            : (isAimingNow ? 'rgba(38, 230, 198, 0.96)' : 'rgba(128, 216, 255, 0.78)');
        } else if (campaign.activeTool === 'pistol' || campaign.activeTool === 'rifle') {
          const baseSz = campaign.activeTool === 'rifle' ? (isAimingNow ? 22 : 30) : (isAimingNow ? 24 : 32);
          bowArcEl.style.width = `${baseSz}px`;
          bowArcEl.style.height = `${baseSz}px`;
          bowArcEl.style.borderColor = isAimingNow ? 'rgba(38, 230, 198, 0.96)' : 'rgba(255, 255, 255, 0.65)';
        } else if (campaign.activeTool === 'flare') {
          bowArcEl.style.width = isAimingNow ? '30px' : '36px';
          bowArcEl.style.height = isAimingNow ? '30px' : '36px';
          bowArcEl.style.borderColor = isAimingNow ? 'rgba(255, 82, 82, 0.98)' : 'rgba(255, 82, 82, 0.72)';
        }
      }
    }
    if (aimBadgeEl && isRangedAimTool(campaign.activeTool)) {
      const cnt = getRangedAmmoCount(campaign.activeTool);
      let badgeStr = `${cnt}`;
      if (campaign.activeTool === 'bow') {
        badgeStr = campaign.bowDraw.holding
          ? (window._bowBreathSteady ? `✦ STEADY · ${cnt}` : `${Math.round(campaign.bowDraw.power * 100)}% · ${cnt}`)
          : `🏹 ${cnt}`;
      } else if (campaign.activeTool === 'crossbow') {
        badgeStr = campaign.crossbowCooldown > 0
          ? `⏳ ${campaign.crossbowCooldown.toFixed(1)}s`
          : `🎯 ${cnt}`;
      } else if (campaign.activeTool === 'pistol') {
        badgeStr = `🔫 ${cnt}`;
      } else if (campaign.activeTool === 'rifle') {
        badgeStr = `🎯 ${cnt}`;
      } else if (campaign.activeTool === 'flare') {
        const caveHit = window.getCaveNavigationInfo ? window.getCaveNavigationInfo(camera.position.x, camera.position.z, player.pos.y) : null;
        badgeStr = (caveHit && caveHit.isInside) ? `🎇 CAVE · ${cnt}` : `🎇 SKY · ${cnt}`;
      }
      if (aimBadgeEl.innerText !== badgeStr) aimBadgeEl.innerText = badgeStr;
    }

    // Stepped ballistic projectiles (swept prevPos -> nextPos against wildlife, trees, rocks, water & terrain)
    const projRay = updateCalderaCastaway._projRay || (updateCalderaCastaway._projRay = new THREE.Raycaster());
    projRay.layers.enable(1);
    projRay.layers.enable(2);
    for (let p = activeProjectiles.length - 1; p >= 0; p--) {
      const pr = activeProjectiles[p];
      pr.age += dt;
      if (pr.age >= pr.maxLife) {
        scene.remove(pr.mesh);
        activeProjectiles.splice(p, 1);
        continue;
      }
      const prev = pr.pos.clone();
      pr.vel.y -= pr.gravity * dt;
      pr.pos.addScaledVector(pr.vel, dt);
      pr.mesh.position.copy(pr.pos);
      pr.mesh.lookAt(pr.pos.clone().add(pr.vel));
      // Spin arrow/bolt slightly along its flight axis for realistic rifled fletching stability
      if (pr.retrievable) {
        pr.mesh.rotateZ(pr.age * 16.0);
      }

      let hitHandled = false;
      const segVec = pr.pos.clone().sub(prev);
      const segLen = segVec.length();
      if (segLen > 0.001) {
        const segDir = segVec.clone().divideScalar(segLen);

        // 1. Check against all live wildlife & sharks (closest point to segment)
        const targets = wildlifeAgents.concat(sharkAgents);
        for (let k = 0; k < targets.length; k++) {
          const ag = targets[k];
          if (!ag || !ag.mesh || !ag.mesh.parent || ag.isDead || ag.state === 'dying') continue;
          const ctr = ag.mesh.position.clone();
          ctr.y += (ag.species === 'deer' ? 0.95 : (ag.species === 'rabbit' || ag.species === 'squirrel' ? 0.22 : 0.55));
          const hitRad = ag.isShark ? 1.55 : (ag.species === 'deer' ? 0.95 : (ag.species === 'boar' || ag.species === 'wolf' ? 0.72 : 0.38));
          const toC = ctr.clone().sub(prev);
          const projT = Math.max(0, Math.min(segLen, toC.dot(segDir)));
          const closestPt = prev.clone().addScaledVector(segDir, projT);
          if (closestPt.distanceToSquared(ctr) <= hitRad * hitRad) {
            applyWildlifeDamage(ag, pr.dmg, closestPt, prev, segDir);
            spawnProjectileImpactEffect(closestPt, segDir, 'flesh', pr.weaponType);
            if (pr.retrievable) {
              lodgeRetrievableProjectile(pr, closestPt, segDir, 'flesh');
            } else {
              scene.remove(pr.mesh);
            }
            activeProjectiles.splice(p, 1);
            hitHandled = true;
            break;
          }
        }
        if (hitHandled) continue;

        // 2. Check against nearby trees, boulders/rocks, and bamboo along flight segment
        if (pr.age > 0.03) {
          const nearObstacles = [];
          for (let t = 0; t < interactiveTargets.length; t++) {
            const obj = interactiveTargets[t];
            if (!obj || !obj.visible || obj === pr.mesh || (obj.userData && obj.userData.type === 'lodged_ammo')) continue;
            const dx = obj.position.x - pr.pos.x;
            const dz = obj.position.z - pr.pos.z;
            if (dx * dx + dz * dz <= 36.0) nearObstacles.push(obj);
          }
          if (nearObstacles.length > 0) {
            projRay.set(prev, segDir);
            projRay.far = segLen + 0.35;
            const obsHits = projRay.intersectObjects(nearObstacles, true);
            if (obsHits.length > 0 && obsHits[0].distance <= segLen + 0.35) {
              let oRoot = obsHits[0].object;
              while (oRoot.parent && oRoot.parent !== scene && oRoot.parent !== worldLandmarksGroup && (!oRoot.userData || !oRoot.userData.type)) {
                oRoot = oRoot.parent;
              }
              const oType = (oRoot && oRoot.userData && oRoot.userData.type) ? oRoot.userData.type : '';
              const surfType = (oType === 'boulder' || oType === 'obsidian') ? 'rock' : 'wood';
              const impactPt = obsHits[0].point.clone();
              spawnProjectileImpactEffect(impactPt, segDir, surfType, pr.weaponType);
              if (pr.retrievable) {
                lodgeRetrievableProjectile(pr, impactPt, segDir, surfType);
              } else {
                scene.remove(pr.mesh);
              }
              activeProjectiles.splice(p, 1);
              continue;
            }
          }
        }

        // 3. Check water surface splash when entering water
        if (!pr.enteredWater) {
          const wInfo = getWaterInfo(pr.pos.x, pr.pos.z, timeSec);
          if (wInfo.isWater && prev.y > wInfo.surfaceY && pr.pos.y <= wInfo.surfaceY) {
            pr.enteredWater = true;
            const waterHitPt = new THREE.Vector3(pr.pos.x, wInfo.surfaceY + 0.04, pr.pos.z);
            addWaterRipple(pr.pos.x, pr.pos.z, 1.5);
            spawnProjectileImpactEffect(waterHitPt, segDir, 'water', pr.weaponType);
            pr.vel.multiplyScalar(0.42);
          }
        }

        // 4. Ground / cliff collision -> spawn impact effect & lodge retrievable arrow/bolt
        const gY = getTerrainHeight(pr.pos.x, pr.pos.z);
        if (pr.pos.y <= gY + 0.08) {
          const gSlope = Math.hypot(
            getTerrainHeight(pr.pos.x + 1.0, pr.pos.z) - gY,
            getTerrainHeight(pr.pos.x, pr.pos.z + 1.0) - gY
          );
          const groundSurf = (gSlope > 0.65 || gY > 45.0) ? 'rock' : 'ground';
          const hitPt = new THREE.Vector3(pr.pos.x, gY + 0.06, pr.pos.z);
          spawnProjectileImpactEffect(hitPt, segDir, groundSurf, pr.weaponType);
          if (pr.retrievable) {
            lodgeRetrievableProjectile(pr, hitPt, segDir, groundSurf);
          } else {
            scene.remove(pr.mesh);
          }
          activeProjectiles.splice(p, 1);
        }
      }
    }

    // Animate 3D projectile impact effects (shockwave ring, flash, dust puff & ballistic sparks/splinters)
    for (let ie = activeImpactEffects.length - 1; ie >= 0; ie--) {
      const eff = activeImpactEffects[ie];
      eff.age += dt;
      if (eff.age >= eff.maxLife) {
        if (eff.group.parent) eff.group.parent.remove(eff.group);
        activeImpactEffects.splice(ie, 1);
        continue;
      }
      const t = eff.age / eff.maxLife;
      const ringScale = 1.0 + Math.pow(t, 0.55) * 6.2;
      eff.ringMesh.scale.set(ringScale, ringScale, 1.0);
      eff.ringMat.opacity = Math.max(0, (1.0 - t) * 0.92);

      const flashScale = Math.max(0.01, 1.0 - t * 3.2);
      eff.flashMesh.scale.setScalar(flashScale);
      eff.flashMat.opacity = Math.max(0, 1.0 - t * 3.5);

      const puffScale = 1.0 + t * 3.8;
      eff.puffMesh.scale.setScalar(puffScale);
      eff.puffMesh.position.y = t * 0.55;
      eff.puffMat.opacity = Math.max(0, (1.0 - t) * 0.45);

      for (let i = 0; i < eff.particles.length; i++) {
        const pt = eff.particles[i];
        pt.vel.y -= 14.0 * dt;
        pt.mesh.position.addScaledVector(pt.vel, dt);
        pt.mesh.rotation.x += pt.rotVel.x * dt;
        pt.mesh.rotation.y += pt.rotVel.y * dt;
        pt.mesh.rotation.z += pt.rotVel.z * dt;
        pt.mat.opacity = Math.max(0, 1.0 - Math.pow(t, 1.4));
      }
    }

    // Pulse lodged arrow/bolt finder beacon rings & auto-pickup when the player walks over them (<= 2.25m)
    for (let la = lodgedAmmoItems.length - 1; la >= 0; la--) {
      const aMesh = lodgedAmmoItems[la];
      if (!aMesh || !aMesh.parent) {
        lodgedAmmoItems.splice(la, 1);
        continue;
      }
      const u = aMesh.userData || {};
      u.lodgedAge = (u.lodgedAge || 0) + dt;
      if (u.beaconRing && u.beaconMat) {
        u.beaconRing.rotation.z = timeSec * 2.2;
        const pulse = 0.85 + 0.32 * Math.sin(timeSec * 4.5 + la);
        u.beaconRing.scale.setScalar(pulse);
        u.beaconMat.opacity = 0.48 + 0.36 * Math.sin(timeSec * 4.5 + la);
      }
      // Walk-over proximity pickup after 0.48s so the player can simply walk up to any found arrow/bolt to collect it
      if (u.lodgedAge > 0.48) {
        const dx = aMesh.position.x - px;
        const dy = aMesh.position.y - (py + 0.9);
        const dz = aMesh.position.z - pz;
        if (dx * dx + dz * dz <= 2.25 * 2.25 && Math.abs(dy) <= 2.6) {
          pickupLodgedAmmo(aMesh);
        }
      }
    }

    // Update thrown Dynamite sticks with 3.2s fuse -> detonation blast
    for (let d = activeExplosives.length - 1; d >= 0; d--) {
      const ex = activeExplosives[d];
      ex.fuseTimer -= dt;
      ex.vel.y -= 16.0 * dt;
      ex.pos.addScaledVector(ex.vel, dt);
      const ey = getTerrainHeight(ex.pos.x, ex.pos.z) + 0.08;
      if (ex.pos.y <= ey) {
        ex.pos.y = ey;
        ex.vel.y = Math.abs(ex.vel.y) > 1.5 ? -ex.vel.y * 0.25 : 0;
        ex.vel.x *= 0.48;
        ex.vel.z *= 0.48;
      }
      ex.mesh.position.copy(ex.pos);
      ex.mesh.rotation.x += dt * 4.5;
      if (ex.fuseTimer <= 0) {
        scene.remove(ex.mesh);
        activeExplosives.splice(d, 1);
        detonateDynamiteBlast(ex.pos);
      }
    }

    // Sync nearby Campfire Tactile Cooking Spit UI Panel + Bleed Timer
    if ((frameCounter & 3) === 0) {
      const cPanel = document.getElementById('cc-cook-panel');
      if (cPanel) {
        const camps = window.activeCampfires || [];
        let nearCf = null, minD = 5.2;
        for (let c = 0; c < camps.length; c++) {
          const cf = camps[c];
          if (!cf || !cf.group) continue;
          const d = Math.hypot(cf.group.position.x - px, cf.group.position.z - pz);
          if (d < minD) { minD = d; nearCf = cf; }
        }
        if (nearCf && nearCf.cookSlots) {
          cPanel.style.display = 'flex';
          const btns = cPanel.querySelectorAll('.cc-cook-slot-btn');
          nearCf.cookSlots.forEach((sl, sIdx) => {
            if (!btns[sIdx]) return;
            if (sl.state === 'empty') btns[sIdx].innerText = sIdx === 2 ? 'Stone: +Place' : `Spit ${sIdx + 1}: +Place`;
            else if (sl.state === 'cooked') btns[sIdx].innerText = '✨ GOLDEN (Take!)';
            else if (sl.state === 'burnt') btns[sIdx].innerText = '🖤 Burnt (Clear)';
            else btns[sIdx].innerText = `🔥 ${Math.min(99, Math.round((sl.cookProgress / 0.85) * 100))}%`;
          });
        } else {
          cPanel.style.display = 'none';
        }
      }
    }

    // Age & fade carcass decay / blood specks
    for (let b = bloodSpecks.length - 1; b >= 0; b--) {
      bloodSpecks[b].age += dt;
      if (bloodSpecks[b].age >= bloodSpecks[b].maxLife) {
        scene.remove(bloodSpecks[b].mesh);
        bloodSpecks.splice(b, 1);
      }
    }
    for (let c = harvestableCarcasses.length - 1; c >= 0; c--) {
      const ca = harvestableCarcasses[c];
      if (ca && ca.mesh && ca.mesh.userData) {
        ca.mesh.userData.decayAge = (ca.mesh.userData.decayAge || 0) + dt;
        if (ca.mesh.userData.decayAge > 540.0) {
          scene.remove(ca.mesh);
          removeInteractiveTarget(ca.mesh);
          harvestableCarcasses.splice(c, 1);
        }
      }
    }

    // 6. Update Articulated 3D Wildlife & Unified Sensory Behavior Controller
    const torchActive = (campaign.activeTool === 'torch');
    const isStealth = (player.effectiveEyeH || 1.88) < 1.48;
    const isMovingLoud = !!(player.isSprinting && wish && wish.lengthSq && wish.lengthSq() > 0.1);
    const stealthMult = isStealth ? 0.52 : (isMovingLoud ? 1.45 : 1.0);
    const pFwdX = -Math.sin(player.yaw);
    const pFwdZ = -Math.cos(player.yaw);

    if (campaign.bleedTimer && campaign.bleedTimer > 0) {
      campaign.bleedTimer -= dt;
      player.vitals.hp = Math.max(5, player.vitals.hp - dt * 1.4);
    }

    for (let i = 0; i < wildlifeAgents.length; i++) {
      const ag = wildlifeAgents[i];
      if (!ag.mesh.parent) continue;
      if (ag.state === 'dying') {
        ag.deathCollapseT = Math.min(1.0, (ag.deathCollapseT || 0) + dt * 0.95);
        const ct = ag.deathCollapseT;
        const smoothCt = ct * ct * (3.0 - 2.0 * ct);
        const pos = ag.mesh.position;
        const gH = getTerrainHeight(pos.x, pos.z);
        pos.y += (gH + 0.12 - pos.y) * Math.min(1.0, dt * 8.0);
        ag.mesh.rotation.order = 'YXZ';
        ag.mesh.rotation.y = ag.yaw;
        ag.mesh.rotation.z = (ag.collapseSide || 1) * smoothCt * (Math.PI * 0.46);
        const uD = ag.mesh.userData || {};
        if (uD.neckPivot) uD.neckPivot.rotation.x = smoothCt * 0.52;
        if (uD.legs) {
          for (let l = 0; l < uD.legs.length; l++) {
            uD.legs[l].rotation.x = smoothCt * ((l < 2) ? 0.45 : -0.38);
          }
        }
        if (ag.deathCollapseT >= 1.0) ag.state = 'carcass_settled';
        continue;
      }
      const pos = ag.mesh.position;
      const dxP = px - pos.x;
      const dzP = pz - pos.z;
      const distP = Math.hypot(dxP, dzP);
      // Tiered Longer-Sightline visibility culling (small 90m, medium 170m) with hysteresis buffer
      const isSmallAg = (ag.species === 'rabbit' || ag.species === 'squirrel' || ag.species === 'crab');
      const showDist = isSmallAg ? 90.0 : 170.0;
      const hideDist = isSmallAg ? 96.0 : 178.0;
      if (ag.mesh.visible && distP > hideDist) ag.mesh.visible = false;
      else if (!ag.mesh.visible && distP <= showDist) ag.mesh.visible = true;

      if (ag.isDead) continue;

      // Throttle distant wildlife (>95m) to 1/8th update rate to avoid 50+ full FBM/cave getTerrainHeight calls per frame
      if (distP > 95.0 && ((frameCounter + i) & 7) !== 0) continue;
      const stepDt = distP > 95.0 ? dt * 8.0 : dt;
      const uData = ag.mesh.userData;

      ag.timer -= stepDt;
      if (ag.attackCooldown > 0) ag.attackCooldown -= stepDt;

      let moveSpeed = ag.speed;
      if (ag.species === 'wolf') {
        if (distP < 18.0 && !torchActive && !campaign.onRaft) {
          ag.yaw = Math.atan2(dxP, dzP);
          moveSpeed = ag.speed * 1.35;
          if (distP < 2.3 && ag.attackCooldown <= 0) {
            ag.attackCooldown = 2.6;
            player.vitals.hp = Math.max(10, player.vitals.hp - 8);
            showToast('🐺 Ridge Stalker Wolf lunged! (-8 HP — Equip Pitch Torch [Slot 4] to repel predators!)');
          }
        } else if (distP < 12.0 && torchActive) {
          ag.yaw = Math.atan2(-dxP, -dzP);
          moveSpeed = ag.speed * 1.5;
        } else if (ag.timer <= 0) {
          ag.timer = 3.5 + Math.random() * 4.0;
          ag.yaw = Math.atan2(ag.homeX - pos.x, ag.homeZ - pos.z) + (Math.random() - 0.5) * 1.4;
        }
      } else if (ag.species === 'deer' || ag.species === 'rabbit') {
        const detectNoiseR = (ag.species === 'deer' ? 14.0 : 9.5) * stealthMult;
        const detectSightR = (ag.species === 'deer' ? 24.0 : 15.0) * stealthMult;
        // Dot product check for whether animal faces toward player
        const toPlayerLen = Math.max(0.01, distP);
        const facingPlayer = (Math.sin(ag.yaw) * (dxP / toPlayerLen) + Math.cos(ag.yaw) * (dzP / toPlayerLen)) > 0.25;
        const spotted = distP < detectNoiseR || (facingPlayer && distP < detectSightR);

        if (ag.state === 'graze') {
          moveSpeed = (ag.timer > 1.8) ? 0.0 : ag.speed * 0.55;
          if (spotted) {
            ag.state = 'alert';
            ag.alertTimer = ag.species === 'deer' ? (1.2 + Math.random() * 0.9) : 0.7;
            ag.yaw = Math.atan2(dxP, dzP);
            // Herd alarm propagation to nearby prey within 18m
            for (let k = 0; k < wildlifeAgents.length; k++) {
              const peer = wildlifeAgents[k];
              if (peer !== ag && peer.mesh.parent && (peer.species === 'deer' || peer.species === 'rabbit') && peer.state === 'graze') {
                if (Math.hypot(peer.mesh.position.x - pos.x, peer.mesh.position.z - pos.z) < 18.0) {
                  peer.state = 'alert';
                  peer.alertTimer = 0.85;
                }
              }
            }
          } else if (ag.timer <= 0) {
            ag.timer = 3.2 + Math.random() * 4.5;
            ag.yaw = Math.atan2(ag.homeX - pos.x, ag.homeZ - pos.z) + (Math.random() - 0.5) * 2.1;
          }
        } else if (ag.state === 'alert') {
          moveSpeed = 0.0;
          ag.alertTimer -= dt;
          ag.yaw = Math.atan2(dxP, dzP);
          if (distP < 7.5 * stealthMult || ag.alertTimer <= 0) {
            ag.state = 'flee';
            ag.fleeTimer = 5.5 + Math.random() * 3.0;
            ag.yaw = Math.atan2(-dxP, -dzP);
          }
        } else if (ag.state === 'flee') {
          ag.fleeTimer -= dt;
          if (ag.species === 'rabbit') {
            ag.zigTimer = (ag.zigTimer || 0) - dt;
            if (ag.zigTimer <= 0) {
              ag.zigSign = -(ag.zigSign || 1);
              ag.zigTimer = 0.45 + Math.random() * 0.4;
            }
            ag.yaw = Math.atan2(-dxP, -dzP) + ag.zigSign * 0.52;
            moveSpeed = 6.2;
          } else {
            const targetFleeYaw = Math.atan2(-dxP, -dzP);
            ag.yaw += Math.sin(targetFleeYaw - ag.yaw) * Math.min(1.0, dt * 4.5);
            moveSpeed = 8.4 * (1.0 - (ag.limpWeight || 0) * 0.35);
          }
          if (ag.fleeTimer <= 0 && distP > 28.0) {
            ag.state = 'graze';
            ag.timer = 3.0 + Math.random() * 3.0;
          }
        }
      } else if (ag.species === 'squirrel') {
        const sqDetect = 11.5 * stealthMult;
        if (ag.state === 'graze') {
          moveSpeed = (ag.timer > 1.4) ? 0.0 : ag.speed * 0.65;
          if (distP < sqDetect) {
            // Find nearest tree trunk in activeEZTrees to scamper vertically up!
            const trees = window.activeEZTrees || [];
            let bestTree = null, bestD = 26.0;
            for (let t = 0; t < trees.length; t++) {
              const tr = trees[t];
              if (!tr || !tr.parent) continue;
              const td = Math.hypot(tr.position.x - pos.x, tr.position.z - pos.z);
              if (td < bestD) { bestD = td; bestTree = tr; }
            }
            ag.climbTree = bestTree;
            ag.state = 'flee';
            ag.fleeTimer = 6.0;
          } else if (ag.timer <= 0) {
            ag.timer = 2.0 + Math.random() * 3.0;
            ag.yaw = Math.atan2(ag.homeX - pos.x, ag.homeZ - pos.z) + (Math.random() - 0.5) * 2.4;
          }
        } else if (ag.state === 'flee') {
          moveSpeed = 5.6;
          if (ag.climbTree && ag.climbTree.parent) {
            const tx = ag.climbTree.position.x, tz = ag.climbTree.position.z;
            const dTree = Math.hypot(tx - pos.x, tz - pos.z);
            ag.yaw = Math.atan2(tx - pos.x, tz - pos.z);
            if (dTree < 0.72) {
              ag.state = 'climbing';
              ag.climbY = getTerrainHeight(tx, tz) + 0.35;
              ag.climbMaxH = ag.climbY + 4.2 + Math.random() * 2.5;
            }
          } else {
            ag.yaw = Math.atan2(-dxP, -dzP);
            ag.fleeTimer -= dt;
            if (ag.fleeTimer <= 0 && distP > 18.0) ag.state = 'graze';
          }
        } else if (ag.state === 'climbing' && ag.climbTree) {
          moveSpeed = 0.0;
          ag.climbY += dt * 4.4;
          ag.yaw += dt * 2.2;
          const trunkOff = 0.32;
          pos.set(
            ag.climbTree.position.x + Math.sin(ag.yaw) * trunkOff,
            ag.climbY,
            ag.climbTree.position.z + Math.cos(ag.yaw) * trunkOff
          );
          ag.mesh.rotation.y = ag.yaw;
          ag.mesh.rotation.x = -Math.PI * 0.46; // Nose pitched vertically up trunk!
          if (ag.climbY >= ag.climbMaxH) {
            ag.state = 'perched';
            ag.perchTimer = 5.5 + Math.random() * 3.5;
            ag.mesh.rotation.x = 0;
          }
          continue;
        } else if (ag.state === 'perched') {
          moveSpeed = 0.0;
          ag.perchTimer -= dt;
          ag.mesh.rotation.x = 0;
          ag.mesh.rotation.y = Math.atan2(dxP, dzP);
          if (ag.perchTimer <= 0 && distP > 13.0) {
            ag.state = 'graze';
            ag.climbTree = null;
            pos.y = getTerrainHeight(pos.x, pos.z);
          }
          continue;
        }
      } else {
        if (distP < 7.5) {
          ag.yaw = Math.atan2(-dxP, -dzP);
          moveSpeed = ag.speed * 1.45;
        } else if (ag.timer <= 0) {
          ag.timer = 4.0 + Math.random() * 4.5;
          ag.yaw = Math.atan2(ag.homeX - pos.x, ag.homeZ - pos.z) + (Math.random() - 0.5) * 1.8;
        }
      }

      if (moveSpeed > 0.01) {
        const nx = pos.x + Math.sin(ag.yaw) * moveSpeed * stepDt;
        const nz = pos.z + Math.cos(ag.yaw) * moveSpeed * stepDt;
        const ny = getTerrainHeight(nx, nz);
        if (ny > 0.25 && ny < 54.0) {
          pos.set(nx, ny, nz);
        } else {
          ag.yaw += Math.PI * 0.75;
        }
      }
      ag.mesh.rotation.x = 0;
      ag.mesh.rotation.y = ag.yaw;

      // Sub-pixel distance LOD gating (<52m) for instanced fur & bristle coats
      if (uData.furMeshes) {
        const showFur = distP < 52.0;
        for (let fm = 0; fm < uData.furMeshes.length; fm++) {
          if (uData.furMeshes[fm].visible !== showFur) {
            uData.furMeshes[fm].visible = showFur;
          }
        }
      }

      // Multi-joint articulated skeletal IK within 65m (throttled 15Hz beyond 65m)
      if (distP < 65.0 || ((frameCounter + i) & 3) === 0) {
        if (ag.species === 'rabbit') {
          if (moveSpeed > 0.2 && uData.bodyPivot) {
            ag.hopPhase = (ag.hopPhase || 0) + dt * moveSpeed * 2.8;
            const arc = Math.abs(Math.sin(ag.hopPhase));
            pos.y += arc * 0.28;
            uData.bodyPivot.rotation.x = -Math.cos(ag.hopPhase) * 0.26;
          } else if (uData.bodyPivot) {
            uData.bodyPivot.rotation.x = 0;
          }
          if (uData.ears) {
            const earTilt = ag.state === 'alert' ? -0.05 : -0.24 + Math.sin(timeSec * 3.5 + i) * 0.08;
            uData.ears[0].rotation.x = earTilt;
            uData.ears[1].rotation.x = earTilt + Math.cos(timeSec * 4.0 + i) * 0.06;
          }
        } else if (ag.species === 'squirrel') {
          if (uData.tailPivot) uData.tailPivot.rotation.x = Math.sin(timeSec * 8.0 + i) * 0.24;
          if (uData.headPivot) uData.headPivot.rotation.x = Math.sin(timeSec * 5.2 + i) * 0.14;
        } else {
          if (uData.legs && uData.legs.length === 4) {
            if (moveSpeed > 0.15) {
              const gait = timeSec * moveSpeed * 3.8 + i;
              const isBounding = (ag.species === 'deer' && ag.state === 'flee');
              const phases = isBounding ? [0, 0.22, Math.PI, Math.PI + 0.22] : [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5];
              for (let l = 0; l < 4; l++) {
                const limpMul = (l === 2 && ag.limpWeight) ? (1.0 - ag.limpWeight * 0.55) : 1.0;
                uData.legs[l].rotation.x = Math.sin(gait + phases[l]) * (isBounding ? 0.68 : 0.52) * limpMul;
                if (uData.legs[l].userData.knee) {
                  uData.legs[l].userData.knee.rotation.x = Math.max(0, -Math.cos(gait + phases[l]) * 0.52);
                }
              }
            } else {
              for (let l = 0; l < 4; l++) {
                uData.legs[l].rotation.x = 0;
                if (uData.legs[l].userData.knee) uData.legs[l].userData.knee.rotation.x = 0;
              }
            }
          }
          if (uData.neckPivot && ag.species === 'deer') {
            const targetNeckX = (ag.state === 'graze' && moveSpeed < 0.15) ? (0.85 + Math.sin(timeSec * 3.8 + i) * 0.12) : 0.05;
            uData.neckPivot.rotation.x += (targetNeckX - uData.neckPivot.rotation.x) * Math.min(1.0, dt * 6.0);
          }
          if (uData.headPivot) uData.headPivot.rotation.x = Math.sin(timeSec * 3.2 + i) * 0.09;
          if (uData.tailPivot) {
            if (ag.species === 'deer') {
              const targetTailX = (ag.state === 'alert' || ag.state === 'flee') ? -1.45 : 0.0;
              uData.tailPivot.rotation.x += (targetTailX - uData.tailPivot.rotation.x) * Math.min(1.0, dt * 9.0);
            } else {
              uData.tailPivot.rotation.y = Math.sin(timeSec * 6.5 + i) * 0.28;
            }
          }
          if (uData.jaw) uData.jaw.rotation.x = (distP < 12.0) ? Math.abs(Math.sin(timeSec * 9.0)) * 0.42 : 0.05;
          if (uData.claws) {
            uData.claws[0].rotation.y = Math.sin(timeSec * 5.0 + i) * 0.25;
            uData.claws[1].rotation.y = -Math.sin(timeSec * 5.0 + i) * 0.25;
          }
          if (uData.crabLegs) {
            for (let cl = 0; cl < uData.crabLegs.length; cl++) {
              const side = (cl < 3) ? -1 : 1;
              uData.crabLegs[cl].rotation.z = side * (0.82 + Math.sin(timeSec * 12.0 + cl * 1.2) * 0.18);
            }
          }
        }
      }
    }

    // 6B. Update Patrolling Ocean Sharks (Sinusoidal Multi-Segment Swim Wave + 3-Beat AI + Swim-Safe Exclusion)
    const playerWaterInfo = getWaterInfo(px, pz, timeSec);
    const playerFloorY = getTerrainHeight(px, pz);
    const playerWaterDepth = playerWaterInfo.isWater ? Math.max(0.0, playerWaterInfo.surfaceY - playerFloorY) : 0.0;
    const playerDistToSwimCay = Math.hypot(px - (-342), pz - 224);
    const playerVulnerableInDeepWater = playerWaterInfo.isWater && playerWaterDepth > 1.85 && playerDistToSwimCay > 88.0 && !campaign.onRaft;

    for (let s = 0; s < sharkAgents.length; s++) {
      const sh = sharkAgents[s];
      if (!sh.mesh.parent) continue;
      if (sh.state === 'dying') {
        sh.deathCollapseT = Math.min(1.0, (sh.deathCollapseT || 0) + dt * 0.85);
        const ct = sh.deathCollapseT;
        const smoothCt = ct * ct * (3.0 - 2.0 * ct);
        const sp = sh.mesh.position;
        const nwDead = getWaterInfo(sp.x, sp.z, timeSec);
        const surfTargetY = (nwDead.isWater ? nwDead.surfaceY : 0.05) - 0.16;
        sp.y += (surfTargetY - sp.y) * Math.min(1.0, dt * 4.2);
        sh.mesh.rotation.order = 'YXZ';
        sh.mesh.rotation.y = sh.yaw;
        sh.mesh.rotation.z = (sh.collapseSide || 1) * smoothCt * (Math.PI * 0.92);
        sh.jawPivot.rotation.x = smoothCt * 0.25;
        if (sh.deathCollapseT >= 1.0) sh.state = 'carcass_settled';
        continue;
      }
      const sp = sh.mesh.position;
      const dxP = px - sp.x, dzP = pz - sp.z;
      const distP = Math.hypot(dxP, dzP);
      // Medium-tier shark visibility culling (170m sightline with hysteresis)
      if (sh.mesh.visible && distP > 178.0) sh.mesh.visible = false;
      else if (!sh.mesh.visible && distP <= 170.0) sh.mesh.visible = true;
      if (sh.isDead) continue;
      if (distP > 130.0 && ((frameCounter + s) & 7) !== 0) continue;
      sh.prevYaw = sh.yaw;

      if (sh.state === 'flee') {
        sh.stateTimer -= dt;
        sh.speed = 8.8;
        if (sh.stateTimer <= 0) sh.state = 'patrol';
      } else if (sh.state === 'recover') {
        sh.stateTimer -= dt;
        sh.speed = 5.4;
        sh.yaw += sh.circleDir * dt * 0.65;
        if (sh.stateTimer <= 0) sh.state = playerVulnerableInDeepWater && distP < 65.0 ? 'circle' : 'patrol';
      } else if (sh.state === 'lunge') {
        sh.stateTimer -= dt;
        sh.speed = 11.4;
        const targetYaw = Math.atan2(dxP, dzP);
        sh.yaw += Math.sin(targetYaw - sh.yaw) * Math.min(1.0, dt * 6.5);
        sh.jawPivot.rotation.x = 0.66; // Jaws wide open 38 deg!
        if (distP < 2.9 && playerVulnerableInDeepWater) {
          player.vitals.hp = Math.max(5, player.vitals.hp - 38);
          campaign.bleedTimer = 5.0;
          addWaterRipple(px, pz, 3.2);
          AudioEngine.playSplash();
          player.vel.x += Math.sin(sh.yaw) * 7.5;
          player.vel.z += Math.cos(sh.yaw) * 7.5;
          showToast('🦈 SHARK BITE! (-38 HP + Bleed! Swim for shore or climb onto a raft!)');
          sh.state = 'recover';
          sh.stateTimer = 4.8;
        } else if (sh.stateTimer <= 0 || !playerVulnerableInDeepWater) {
          sh.state = 'recover';
          sh.stateTimer = 3.8;
        }
      } else if (sh.state === 'circle') {
        sh.stateTimer -= dt;
        sh.speed = 4.9;
        if (!playerVulnerableInDeepWater || distP > 84.0) {
          sh.state = 'patrol';
          sh.warned = false;
        } else {
          const rad = 16.5;
          const angFromP = Math.atan2(sp.z - pz, sp.x - px) + sh.circleDir * dt * (sh.speed / rad);
          const goalX = px + Math.cos(angFromP) * rad;
          const goalZ = pz + Math.sin(angFromP) * rad;
          const desiredYaw = Math.atan2(goalX - sp.x, goalZ - sp.z);
          sh.yaw += Math.sin(desiredYaw - sh.yaw) * Math.min(1.0, dt * 3.8);
          if (!sh.warned) {
            sh.warned = true;
            addWaterRipple(sp.x, sp.z, 2.2);
            showToast('🦈 Dorsal fin circling nearby deep water! Seek shallow reef or board your raft!');
          }
          if (sh.stateTimer <= 0) {
            sh.state = 'lunge';
            sh.stateTimer = 2.6;
          }
        }
      } else {
        // PATROL deep channels (figure-8 spline)
        sh.speed = 2.9;
        sh.jawPivot.rotation.x += (0.04 - sh.jawPivot.rotation.x) * Math.min(1.0, dt * 6.0);
        sh.orbitAng += dt * 0.055;
        const tx = sh.homeX + Math.cos(sh.orbitAng) * sh.patrolRad;
        const tz = sh.homeZ + Math.sin(sh.orbitAng * 2.0) * (sh.patrolRad * 0.62);
        const desiredYaw = Math.atan2(tx - sp.x, tz - sp.z);
        sh.yaw += Math.sin(desiredYaw - sh.yaw) * Math.min(1.0, dt * 1.9);
        if (playerVulnerableInDeepWater && distP < 72.0) {
          sh.state = 'circle';
          sh.stateTimer = 3.8 + Math.random() * 1.6;
        }
      }

      if (sh.state !== 'lunge') {
        sh.jawPivot.rotation.x += (0.04 - sh.jawPivot.rotation.x) * Math.min(1.0, dt * 6.0);
      }

      const nx = sp.x + Math.sin(sh.yaw) * sh.speed * dt;
      const nz = sp.z + Math.cos(sh.yaw) * sh.speed * dt;
      const bedH = getTerrainHeight(nx, nz);
      const nw = getWaterInfo(nx, nz, timeSec);
      const nextDepth = (nw.isWater ? nw.surfaceY : 0.05) - bedH;
      const nextDistSwimCay = Math.hypot(nx - (-342), nz - 224);

      if (nextDepth < 2.8 || nextDistSwimCay < 95.0) {
        // Steer firmly seaward away from shallows or Swim-Safe Sheltered Reef Cay
        sh.yaw += Math.PI * 0.68;
      } else {
        const surfTargetY = (sh.state === 'circle' || sh.state === 'lunge')
          ? ((nw.isWater ? nw.surfaceY : 0.05) - 0.34)
          : Math.max(bedH + 1.1, (nw.isWater ? nw.surfaceY : 0.05) - 1.35 + Math.sin(timeSec * 0.55 + s) * 0.45);
        sp.x = nx;
        sp.z = nz;
        sp.y += (surfTargetY - sp.y) * Math.min(1.0, dt * 3.5);
      }

      sh.mesh.rotation.y = sh.yaw;
      const yawRate = Math.sin(sh.yaw - sh.prevYaw) / Math.max(0.004, dt);
      const bankRoll = Math.max(-0.42, Math.min(0.42, yawRate * 0.25));
      sh.mesh.rotation.z += (bankRoll - sh.mesh.rotation.z) * Math.min(1.0, dt * 6.0);

      // Multi-segment traveling sinusoidal swimming wave scaled by speed
      sh.swimPhase += dt * (2.6 + sh.speed * 1.15);
      const amp = 0.14 + (sh.speed / 12.0) * 0.20;
      sh.headPivot.rotation.y = Math.sin(sh.swimPhase) * amp * 0.28;
      sh.tailPivot.rotation.y = Math.sin(sh.swimPhase - 0.85) * amp * 1.15;
      sh.caudalPivot.rotation.y = Math.sin(sh.swimPhase - 1.75) * amp * 1.85;
      sh.pecLeft.rotation.z = bankRoll * 0.65;
      sh.pecRight.rotation.z = bankRoll * 0.65;
    }

    // 6C. Update Underwater Boid Fish Schools, Reef Snappers & Seabed Stingrays (active within 90m)
    const bDummy = updateCalderaCastaway._boidDummy || (updateCalderaCastaway._boidDummy = new THREE.Object3D());
    if (instBambooCrowns && instBambooCrowns.material && instBambooCrowns.material.userData && instBambooCrowns.material.userData.shader) {
      instBambooCrowns.material.userData.shader.uniforms.uTime.value = timeSec;
    }
    for (let g = 0; g < fishBoidGroups.length; g++) {
      const grp = fishBoidGroups[g];
      const bList = grp.boids;
      let anyUpdated = false;

      for (let b = 0; b < bList.length; b++) {
        const bo = bList[b];
        // Per-school distance check so schools across all inter-island channels animate smoothly when nearby
        const cDist = Math.hypot(bo.cx - px, bo.cz - pz);
        if (cDist > 210.0 && frameCounter > 3) continue;
        if (cDist > 90.0 && frameCounter > 3 && ((frameCounter + b) & 3) !== 0) continue;
        const stepDt = (cDist > 90.0 && frameCounter > 3) ? dt * 4.0 : dt;
        anyUpdated = true;

        const toCx = bo.cx - bo.x;
        const toCz = bo.cz - bo.z;
        const dHome = Math.hypot(toCx, toCz);
        // Gentle orbital swirl + cohesion toward school center
        const swirlX = -toCz * 0.35 + toCx * Math.max(0, (dHome - grp.radius) * 0.45);
        const swirlZ = toCx * 0.35 + toCz * Math.max(0, (dHome - grp.radius) * 0.45);
        bo.vx += swirlX * stepDt * 0.45;
        bo.vz += swirlZ * stepDt * 0.45;

        // Scatter rapidly away if swimmer dives nearby (<5.5m)
        const dSwim = Math.hypot(bo.x - px, bo.y - (py + 1.2), bo.z - pz);
        if (dSwim < 5.5) {
          const inv = 1.0 / Math.max(0.25, dSwim);
          bo.vx += (bo.x - px) * inv * 12.0 * stepDt;
          bo.vz += (bo.z - pz) * inv * 12.0 * stepDt;
        }
        const spd = Math.hypot(bo.vx, bo.vz) || 0.01;
        const targetSpd = dSwim < 5.5 ? grp.speed * grp.scatterScale : grp.speed;
        bo.vx = (bo.vx / spd) * targetSpd;
        bo.vz = (bo.vz / spd) * targetSpd;

        bo.x += bo.vx * stepDt;
        bo.z += bo.vz * stepDt;
        const bedNow = getTerrainHeight(bo.x, bo.z);
        if (bedNow > -1.35) {
          // Steer schooling fish firmly back toward their deep-water channel center if approaching an island bank
          bo.vx = (bo.cx - bo.x) * 0.85;
          bo.vz = (bo.cz - bo.z) * 0.85;
          bo.x += bo.vx * stepDt;
          bo.z += bo.vz * stepDt;
        }
        // Strictly clamp every schooling fish underwater (<= -0.75m) so no fish can ever float into the sky
        bo.y = Math.min(-0.75, Math.max(bedNow + 0.55, bo.baseY + Math.sin(timeSec * 1.9 + bo.phase) * 0.22));

        bDummy.position.set(bo.x, bo.y, bo.z);
        bDummy.rotation.set(0, Math.atan2(bo.vx, bo.vz) + Math.sin(timeSec * 12.0 + bo.phase) * 0.08, 0);
        bDummy.scale.set(1, 1, 1);
        bDummy.updateMatrix();
        grp.mesh.setMatrixAt(b, bDummy.matrix);
      }
      if (anyUpdated) {
        grp.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    for (let r = 0; r < snapperAgents.length; r++) {
      const sn = snapperAgents[r];
      if (!sn.mesh.parent) continue;
      const snDist = Math.hypot(sn.cx - px, sn.cz - pz);
      if (sn.mesh.visible && snDist > 96.0) sn.mesh.visible = false;
      else if (!sn.mesh.visible && snDist <= 90.0) sn.mesh.visible = true;
      if (!sn.mesh.visible) continue;
      sn.ang += dt * 0.65;
      if (snDist > 85.0 && ((frameCounter + r) & 3) !== 0) continue;
      const sx = sn.cx + Math.cos(sn.ang) * sn.rad;
      const sz = sn.cz + Math.sin(sn.ang) * sn.rad;
      const sBed = getTerrainHeight(sx, sz);
      const sy = Math.min(-0.80, Math.max(sBed + 0.55, sn.baseY + Math.sin(timeSec * 1.7 + r) * 0.14));
      sn.mesh.position.set(sx, sy, sz);
      sn.mesh.rotation.y = -sn.ang;
      if (sn.mesh.userData.tail) sn.mesh.userData.tail.rotation.y = Math.sin(timeSec * 13.0 + r) * 0.36;
    }

    for (let st = 0; st < stingrayAgents.length; st++) {
      const ray = stingrayAgents[st];
      const rayDist = Math.hypot(ray.cx - px, ray.cz - pz);
      if (ray.mesh.visible && rayDist > 96.0) ray.mesh.visible = false;
      else if (!ray.mesh.visible && rayDist <= 90.0) ray.mesh.visible = true;
      if (!ray.mesh.visible) continue;
      if (rayDist > 85.0 && ((frameCounter + st) & 3) !== 0) continue;
      ray.ang += dt * ray.speed;
      const rx = ray.cx + Math.cos(ray.ang) * ray.rad;
      const rz = ray.cz + Math.sin(ray.ang) * ray.rad;
      const bedY = Math.min(-1.25, getTerrainHeight(rx, rz));
      ray.mesh.position.set(rx, bedY + 0.36 + Math.sin(timeSec * 1.5 + st) * 0.05, rz);
      ray.mesh.rotation.y = -ray.ang;
    }

    // Animate Swimming Lagoon Fish
    for (let f = 0; f < fishAgents.length; f++) {
      const fa = fishAgents[f];
      if (!fa.mesh.parent) continue;
      const fDist = Math.hypot(fa.cx - px, fa.cz - pz);
      if (fa.mesh.visible && fDist > 96.0) fa.mesh.visible = false;
      else if (!fa.mesh.visible && fDist <= 90.0) fa.mesh.visible = true;
      if (!fa.mesh.visible) continue;
      fa.ang += dt * 0.85;
      if (fDist > 85.0 && ((frameCounter + f) & 3) !== 0) continue;
      fa.mesh.position.set(
        fa.cx + Math.cos(fa.ang) * fa.rad,
        fa.baseY + Math.sin(timeSec * 2.0 + f) * 0.12,
        fa.cz + Math.sin(fa.ang) * fa.rad
      );
      fa.mesh.rotation.y = -fa.ang;
      if (fa.mesh.userData.tail) {
        fa.mesh.userData.tail.rotation.y = Math.sin(timeSec * 14.0 + f) * 0.42;
      }
    }

    // Animate Two-Stage Articulated Sea Eagles & Coastal Tropicbirds / Seabirds (300m soaring sightline culling)
    for (let e = 0; e < eagleAgents.length; e++) {
      const ea = eagleAgents[e];
      const spd = ea.speed || 0.28;
      ea.ang += dt * spd;
      const ex = ea.cx + Math.cos(ea.ang) * ea.rad;
      const ez = ea.cz + Math.sin(ea.ang) * ea.rad;
      const eDist = Math.hypot(ex - px, ez - pz);
      if (ea.mesh.visible && eDist > 312.0) ea.mesh.visible = false;
      else if (!ea.mesh.visible && eDist <= 300.0) ea.mesh.visible = true;
      if (!ea.mesh.visible) continue;

      const flapFreq = ea.flapFreq || 5.2;
      // Alternate naturally between active flapping wingbeats and smooth cambered thermal glides
      const glideMod = 0.55 + 0.45 * Math.sin(timeSec * 0.9 + e * 1.7);
      const phase = timeSec * flapFreq + e * 1.3;
      const flap = Math.sin(phase) * (ea.isSeabird ? 0.34 : 0.26) * glideMod;
      const outerFlex = Math.cos(phase - 0.35) * (ea.isSeabird ? 0.28 : 0.22) * glideMod;

      ea.mesh.position.set(
        ex,
        ea.alt + Math.sin(timeSec * 0.85 + e) * 1.8 - Math.cos(phase) * 0.08 * glideMod,
        ez
      );
      ea.mesh.rotation.y = -ea.ang;
      ea.mesh.rotation.z = 0.18 + Math.sin(timeSec * 0.7 + e) * 0.06;
      ea.leftWing.rotation.z = flap;
      ea.rightWing.rotation.z = -flap;
      if (ea.leftOuter) ea.leftOuter.rotation.z = outerFlex;
      if (ea.rightOuter) ea.rightOuter.rotation.z = -outerFlex;
      if (ea.tailFan) {
        ea.tailFan.rotation.x = Math.sin(phase) * 0.09 * glideMod;
      }
    }

    // Distance visibility culling for small minor ground props (obsidian clusters beyond 220m)
    if ((frameCounter & 7) === 0 && minorStaticProps.length > 0) {
      for (let mp = 0; mp < minorStaticProps.length; mp++) {
        const item = minorStaticProps[mp];
        if (!item.obj || !item.obj.parent) continue;
        const dSq = (item.x - px) * (item.x - px) + (item.z - pz) * (item.z - pz);
        const showSq = item.maxDist * item.maxDist;
        const hideSq = (item.maxDist + 10.0) * (item.maxDist + 10.0);
        if (item.obj.visible && dSq > hideSq) item.obj.visible = false;
        else if (!item.obj.visible && dSq <= showSq) item.obj.visible = true;
      }
    }

    // 6D. Animate Low-Flying Perching, Walking & Foraging Island Birds (90m small-wildlife sightline culling)
    const playerHorizSpeed = Math.hypot(player.vel.x, player.vel.z);
    const playerDisturbScale = player.isCrouching ? 0.65 : (playerHorizSpeed > 5.2 ? 1.32 : 1.0);
    for (let b = 0; b < forestBirdAgents.length; b++) {
      const fb = forestBirdAgents[b];
      const pos = fb.mesh.position;
      const dxP = px - pos.x;
      const dzP = pz - pos.z;
      const distP = Math.hypot(dxP, dzP);
      if (fb.mesh.visible && distP > 96.0) fb.mesh.visible = false;
      else if (!fb.mesh.visible && distP <= 90.0) fb.mesh.visible = true;
      if (!fb.mesh.visible) continue;
      const stepDt = dt;
      const dyP = Math.abs((py + 1.4) - pos.y);

      // Check if host tree or boulder was felled/mined while perched
      if (fb.currentPerch && fb.currentPerch.hostObj && !fb.currentPerch.hostObj.parent && fb.state !== 'flying') {
        triggerBirdFlightToNewPerch(fb, px, pz, true);
      }

      // Mild Fear of the Character:
      // - Within ~5.2m (or ~6.8m if player sprints), the bird gently takes off to a nearby branch or boulder.
      // - Between 5.2m and 9.0m, the bird becomes cautiously alert (watches player with head-tilts, or hops/walks away on the ground).
      const flushRadius = ((fb.state === 'ground_idle' || fb.state === 'ground_walk') ? 5.6 : 4.6) * playerDisturbScale;
      const watchRadius = ((fb.state === 'ground_idle' || fb.state === 'ground_walk') ? 9.2 : 7.8) * playerDisturbScale;

      if (fb.state !== 'flying' && fb.state !== 'landing') {
        if (distP < flushRadius && dyP < 3.8) {
          triggerBirdFlightToNewPerch(fb, px, pz, true);
        } else if (distP < watchRadius && dyP < 4.8) {
          fb.isAlert = true;
          if (fb.state === 'ground_idle' && distP < watchRadius * 0.85) {
            fb.state = 'ground_walk';
            fb.stateTimer = 1.8 + Math.random() * 1.2;
            fb.yaw = Math.atan2(-dxP, -dzP) + (Math.random() - 0.5) * 0.45;
          }
        } else {
          fb.isAlert = false;
        }
      }

      if (fb.state === 'flying' || fb.state === 'landing') {
        const tgt = fb.targetPerch;
        if (!tgt || (tgt.hostObj && !tgt.hostObj.parent)) {
          triggerBirdFlightToNewPerch(fb, px, pz, false);
          continue;
        }
        fb.flightProgress += (fb.flightSpeed * stepDt) / Math.max(1.0, fb.flightDist);
        const u = Math.min(1.0, fb.flightProgress);
        if (u >= 0.76 && fb.state === 'flying') {
          fb.state = 'landing';
        }

        const curX = fb.startPos.x + (tgt.x - fb.startPos.x) * u;
        const curZ = fb.startPos.z + (tgt.z - fb.startPos.z) * u;
        const linearY = fb.startPos.y + (tgt.y - fb.startPos.y) * u;
        const arcBoost = Math.sin(u * Math.PI) * fb.arcHeight;
        const groundFloor = getTerrainHeight(curX, curZ);
        const minClearance = (u < 0.85) ? (groundFloor + 1.45 * Math.sin(u * Math.PI)) : tgt.y;
        pos.set(curX, Math.max(minClearance, linearY + arcBoost), curZ);

        fb.prevYaw = fb.yaw;
        const desiredYaw = Math.atan2(tgt.x - fb.startPos.x, tgt.z - fb.startPos.z);
        fb.yaw += Math.sin(desiredYaw - fb.yaw) * Math.min(1.0, stepDt * 8.0);
        fb.mesh.rotation.y = fb.yaw;

        const isLandingFlare = (fb.state === 'landing');
        // Unfold wings smoothly in flight; during final landing flare, flutter rapidly and prepare to fold
        const targetFold = isLandingFlare ? Math.max(0.0, (u - 0.82) * 3.5) : 0.0;
        fb.wingFold += (targetFold - fb.wingFold) * Math.min(1.0, stepDt * 14.0);

        const flapHz = isLandingFlare ? 16.5 : 12.2;
        const phase = timeSec * flapHz + b * 1.7;
        // Songbird bounding flight modulation (brief glide every few beats during cruise)
        const boundGlide = isLandingFlare ? 1.0 : (0.68 + 0.32 * Math.sin(timeSec * 3.2 + b));
        const flapAmp = (isLandingFlare ? 0.62 : 0.48) * boundGlide * (1.0 - fb.wingFold * 0.75);
        const flapAngle = Math.sin(phase) * flapAmp;
        const outerAngle = Math.cos(phase - 0.35) * flapAmp * 0.82;

        // Body pitch: streamlined forward in cruise (+0.12), pitched up into aerodynamic braking flare (-0.54) on landing
        const targetPitch = isLandingFlare ? -0.54 : 0.12;
        fb.bodyPivot.rotation.x += (targetPitch - fb.bodyPivot.rotation.x) * Math.min(1.0, stepDt * 9.0);
        fb.bodyPivot.position.y = 0.145;
        fb.mesh.rotation.z = Math.sin(timeSec * 2.5 + b) * 0.08 * (1.0 - fb.wingFold);

        // Apply 2-stage wing articulation blended with wing-fold pose
        const foldT = fb.wingFold;
        fb.leftWing.rotation.set(-0.18 * foldT + (isLandingFlare ? 0.28 * (1 - foldT) : 0), 1.26 * foldT, flapAngle * (1 - foldT) - 0.46 * foldT);
        fb.rightWing.rotation.set(-0.18 * foldT + (isLandingFlare ? 0.28 * (1 - foldT) : 0), -1.26 * foldT, -flapAngle * (1 - foldT) + 0.46 * foldT);
        fb.leftOuter.rotation.z = outerAngle * (1 - foldT) - 0.82 * foldT;
        fb.rightOuter.rotation.z = -outerAngle * (1 - foldT) + 0.82 * foldT;

        // Tail fan spreads wide during landing braking flare
        const tailSpread = isLandingFlare ? 1.42 : 1.05;
        fb.tailFan.scale.x += (tailSpread - fb.tailFan.scale.x) * Math.min(1.0, stepDt * 10.0);
        fb.tailFan.rotation.x = isLandingFlare ? 0.42 : (Math.sin(phase) * 0.08);

        // Legs: tucked back beneath belly during cruise (-1.05), extended forward (+0.32) to grasp branch/ground during landing flare
        const targetLegX = isLandingFlare ? 0.32 : -1.05;
        fb.leftLeg.rotation.x += (targetLegX - fb.leftLeg.rotation.x) * Math.min(1.0, stepDt * 10.0);
        fb.rightLeg.rotation.x += (targetLegX - fb.rightLeg.rotation.x) * Math.min(1.0, stepDt * 10.0);
        fb.leftShin.rotation.x = isLandingFlare ? -0.15 : 0.45;
        fb.rightShin.rotation.x = isLandingFlare ? -0.15 : 0.45;

        fb.headPivot.rotation.set(isLandingFlare ? 0.32 : -0.08, 0, 0);
        fb.lowerBeak.rotation.x = Math.PI / 2 - 0.04;

        if (u >= 1.0) {
          pos.set(tgt.x, tgt.y, tgt.z);
          fb.currentPerch = tgt;
          fb.targetPerch = null;
          fb.mesh.rotation.z = 0;
          if (tgt.type === 'ground') {
            fb.state = Math.random() < 0.55 ? 'ground_walk' : 'ground_idle';
            fb.stateTimer = 2.4 + Math.random() * 2.8;
            fb.groundResidencyTimer = 11.0 + Math.random() * 7.0;
          } else {
            fb.state = 'perched';
            fb.stateTimer = 6.5 + Math.random() * 8.5;
            if (tgt.perchYaw !== undefined) fb.yaw = tgt.perchYaw;
          }
        }
      } else if (fb.state === 'perched') {
        fb.stateTimer -= stepDt;
        fb.wingFold += (1.0 - fb.wingFold) * Math.min(1.0, stepDt * 10.0);
        const foldT = fb.wingFold;

        // Neat folded wing posture along the flanks
        fb.leftWing.rotation.set(-0.18 * foldT, 1.26 * foldT, -0.46 * foldT);
        fb.rightWing.rotation.set(-0.18 * foldT, -1.26 * foldT, 0.46 * foldT);
        fb.leftOuter.rotation.z = -0.82 * foldT;
        fb.rightOuter.rotation.z = 0.82 * foldT;

        // Upright perched/sitting posture with flexed knees & gentle respiratory bob
        const sitSquat = 0.126 + Math.sin(timeSec * 2.8 + b) * 0.004;
        fb.bodyPivot.position.y += (sitSquat - fb.bodyPivot.position.y) * Math.min(1.0, stepDt * 8.0);
        fb.bodyPivot.rotation.x += (-0.34 - fb.bodyPivot.rotation.x) * Math.min(1.0, stepDt * 8.0);

        fb.leftLeg.rotation.x += (-0.22 - fb.leftLeg.rotation.x) * Math.min(1.0, stepDt * 8.0);
        fb.rightLeg.rotation.x += (-0.22 - fb.rightLeg.rotation.x) * Math.min(1.0, stepDt * 8.0);
        fb.leftShin.rotation.x = 0.28;
        fb.rightShin.rotation.x = 0.28;

        // Tail balance bob & occasional tail flick
        fb.tailFan.scale.x += (0.88 - fb.tailFan.scale.x) * Math.min(1.0, stepDt * 8.0);
        const tailFlick = Math.pow(Math.max(0, Math.sin(timeSec * 1.9 + b * 2.3)), 8.0) * 0.24;
        fb.tailFan.rotation.x = 0.22 + Math.sin(timeSec * 2.4 + b) * 0.05 + tailFlick;

        // Head vigilance: watches player if mildly alert, otherwise scans branches & tilts curiously
        if (fb.isAlert) {
          const toPYaw = Math.atan2(dxP, dzP);
          const relYaw = Math.atan2(Math.sin(toPYaw - fb.yaw), Math.cos(toPYaw - fb.yaw));
          fb.headPivot.rotation.y += (Math.max(-0.95, Math.min(0.95, relYaw)) - fb.headPivot.rotation.y) * Math.min(1.0, stepDt * 9.0);
          fb.headPivot.rotation.z = Math.sin(timeSec * 4.5 + b) * 0.18;
          fb.headPivot.rotation.x = 0.18;
          if (fb.crestGroup) fb.crestGroup.scale.y = 1.25;
        } else {
          const scanYaw = Math.sin(timeSec * 1.35 + b * 2.1) * 0.48 + Math.sin(timeSec * 3.1 + b) * 0.15;
          fb.headPivot.rotation.y += (scanYaw - fb.headPivot.rotation.y) * Math.min(1.0, stepDt * 6.0);
          fb.headPivot.rotation.z = Math.sin(timeSec * 2.0 + b * 1.7) * 0.14;
          fb.headPivot.rotation.x = 0.16 + Math.sin(timeSec * 1.6 + b) * 0.06;
          if (fb.crestGroup) fb.crestGroup.scale.y = 1.0;
        }

        // Periodic songbird chirp beak movement
        const chirpOpen = Math.pow(Math.max(0, Math.sin(timeSec * 3.6 + b * 1.9)), 6.0) * 0.24;
        fb.lowerBeak.rotation.x = (Math.PI / 2 - 0.04) - chirpOpen;

        if (fb.stateTimer <= 0) {
          triggerBirdFlightToNewPerch(fb, fb.isAlert ? px : null, fb.isAlert ? pz : null, false);
        }
      } else {
        // GROUND FORAGING STATES: 'ground_idle' (pecking & looking around) and 'ground_walk' (walking/hopping across terrain)
        fb.stateTimer -= stepDt;
        fb.groundResidencyTimer -= stepDt;
        fb.wingFold += (1.0 - fb.wingFold) * Math.min(1.0, stepDt * 10.0);
        const foldT = fb.wingFold;
        fb.leftWing.rotation.set(-0.18 * foldT, 1.26 * foldT, -0.46 * foldT);
        fb.rightWing.rotation.set(-0.18 * foldT, -1.26 * foldT, 0.46 * foldT);
        fb.leftOuter.rotation.z = -0.82 * foldT;
        fb.rightOuter.rotation.z = 0.82 * foldT;
        fb.tailFan.scale.x += (0.92 - fb.tailFan.scale.x) * Math.min(1.0, stepDt * 8.0);

        if (fb.state === 'ground_walk') {
          const walkSpd = fb.isAlert ? 1.55 : 0.98;
          if (fb.isAlert) {
            const awayYaw = Math.atan2(-dxP, -dzP);
            fb.yaw += Math.sin(awayYaw - fb.yaw) * Math.min(1.0, stepDt * 5.0);
          }
          const nx = pos.x + Math.sin(fb.yaw) * walkSpd * stepDt;
          const nz = pos.z + Math.cos(fb.yaw) * walkSpd * stepDt;
          const ny = getTerrainHeight(nx, nz);
          if (ny > 1.05 && ny < 48.0) {
            fb.walkPhase += stepDt * walkSpd * 13.5;
            const hopArc = Math.abs(Math.sin(fb.walkPhase * 0.5)) * 0.032;
            pos.set(nx, ny + hopArc, nz);
          } else {
            fb.yaw += Math.PI * 0.75;
          }
          fb.mesh.rotation.y = fb.yaw;

          // Alternating bipedal leg stride + knee flexion
          const strideL = Math.sin(fb.walkPhase) * 0.68;
          const strideR = -Math.sin(fb.walkPhase) * 0.68;
          fb.leftLeg.rotation.x = strideL;
          fb.rightLeg.rotation.x = strideR;
          fb.leftShin.rotation.x = Math.max(0, -Math.cos(fb.walkPhase) * 0.45);
          fb.rightShin.rotation.x = Math.max(0, Math.cos(fb.walkPhase) * 0.45);

          // Walking posture & rhythmic avian head-bob
          fb.bodyPivot.position.y = 0.145;
          fb.bodyPivot.rotation.x = 0.06 + Math.sin(fb.walkPhase * 2.0) * 0.05;
          fb.headPivot.rotation.set(Math.sin(fb.walkPhase * 2.0) * 0.14, fb.isAlert ? Math.sin(timeSec * 5.0 + b) * 0.25 : 0, 0);
          fb.tailFan.rotation.x = 0.12 - Math.sin(fb.walkPhase * 2.0) * 0.08;
          fb.lowerBeak.rotation.x = Math.PI / 2 - 0.04;

          if (fb.stateTimer <= 0) {
            fb.state = 'ground_idle';
            fb.stateTimer = 2.0 + Math.random() * 2.6;
          }
        } else {
          // 'ground_idle': standing on ground, alternating between seed/insect pecking and alert head scans
          pos.y = getTerrainHeight(pos.x, pos.z);
          fb.leftLeg.rotation.x += (0.0 - fb.leftLeg.rotation.x) * Math.min(1.0, stepDt * 10.0);
          fb.rightLeg.rotation.x += (0.0 - fb.rightLeg.rotation.x) * Math.min(1.0, stepDt * 10.0);
          fb.leftShin.rotation.x = 0.08;
          fb.rightShin.rotation.x = 0.08;
          fb.bodyPivot.position.y = 0.142;

          fb.peckPhase += stepDt * 8.5;
          const isPeckingWindow = !fb.isAlert && (Math.sin(timeSec * 1.4 + b * 1.7) > -0.15);
          const peckPulse = isPeckingWindow ? Math.pow(Math.max(0, Math.sin(fb.peckPhase)), 3.0) : 0.0;

          fb.bodyPivot.rotation.x = 0.04 + peckPulse * 0.56;
          fb.headPivot.rotation.x = peckPulse * 0.52;
          fb.headPivot.rotation.y = fb.isAlert
            ? Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(Math.atan2(dxP, dzP) - fb.yaw), Math.cos(Math.atan2(dxP, dzP) - fb.yaw))))
            : Math.sin(timeSec * 1.8 + b) * 0.36 * (1.0 - peckPulse);
          fb.headPivot.rotation.z = (1.0 - peckPulse) * Math.sin(timeSec * 2.5 + b) * 0.12;
          fb.tailFan.rotation.x = 0.14 + peckPulse * 0.38;
          fb.lowerBeak.rotation.x = (Math.PI / 2 - 0.04) - peckPulse * 0.22;

          if (fb.stateTimer <= 0) {
            fb.state = 'ground_walk';
            fb.stateTimer = 2.2 + Math.random() * 2.8;
            fb.yaw += (Math.random() - 0.5) * 2.2;
          }
        }

        // After foraging on the ground for 11-18s, fly back up to a nearby tree branch or rock perch!
        if (fb.groundResidencyTimer <= 0) {
          triggerBirdFlightToNewPerch(fb, fb.isAlert ? px : null, fb.isAlert ? pz : null, false);
        }
      }
    }

    // 7. Update Parabolic Sky Flares & Subterranean Floor Flares
    for (let i = activeSkyFlares.length - 1; i >= 0; i--) {
      const fl = activeSkyFlares[i];
      fl.age += dt;
      if (fl.age >= fl.maxLife) {
        if (fl.lightEntry) {
          fl.lightEntry.light.userData.disabled = true;
          fl.lightEntry.light.intensity = 0;
          const mIdx = managedPointLights.indexOf(fl.lightEntry);
          if (mIdx !== -1) managedPointLights.splice(mIdx, 1);
        }
        if (Array.isArray(campaign.activeFlares)) {
          const fIdx = campaign.activeFlares.indexOf(fl);
          if (fIdx !== -1) campaign.activeFlares.splice(fIdx, 1);
        }
        scene.remove(fl.mesh);
        activeSkyFlares.splice(i, 1);
      } else if (fl.isCaveFlare) {
        fl.vel.y -= 14.0 * dt;
        fl.mesh.position.addScaledVector(fl.vel, dt);
        const fNav = window.getCaveNavigationInfo ? window.getCaveNavigationInfo(fl.mesh.position.x, fl.mesh.position.z, fl.mesh.position.y) : null;
        const minY = (fNav ? fNav.floorY : getTerrainHeight(fl.mesh.position.x, fl.mesh.position.z)) + 0.16;
        if (fl.mesh.position.y <= minY) {
          fl.mesh.position.y = minY;
          fl.vel.y = Math.abs(fl.vel.y) > 1.2 ? -fl.vel.y * 0.25 : 0;
          fl.vel.x *= 0.52;
          fl.vel.z *= 0.52;
        }
        if (fNav) {
          if (fl.mesh.position.y > fNav.ceilY - 0.22) {
            fl.mesh.position.y = fNav.ceilY - 0.22;
            fl.vel.y = Math.min(0, -Math.abs(fl.vel.y) * 0.4);
          }
          const maxF = Math.max(0.35, fNav.halfW - 0.25);
          if (Math.abs(fNav.lateral) > maxF) {
            const cLat = Math.sign(fNav.lateral) * maxF;
            fl.mesh.position.x = fNav.cx + fNav.perpX * cLat;
            fl.mesh.position.z = fNav.cz + fNav.perpZ * cLat;
            fl.vel.x *= -0.35;
            fl.vel.z *= -0.35;
          }
        }
        if (fl.lightEntry && fl.lightEntry.light) {
          const fadeOut = (fl.age > fl.maxLife - 3.0) ? Math.max(0.0, (fl.maxLife - fl.age) / 3.0) : 1.0;
          fl.lightEntry.light.intensity = (3.6 + Math.sin(timeSec * 19.0 + i) * 0.45) * fadeOut;
        }
      } else {
        if (fl.vel.y > -1.8) fl.vel.y -= 6.5 * dt;
        fl.mesh.position.addScaledVector(fl.vel, dt);
      }
    }

    // 8. Update Dynamic Weather Cycle & 3D Rain Streaks
    const wState = campaign.weather;
    if (wState.autoCycle) {
      wState.timer += dt;
      if (wState.timer >= wState.duration) {
        const order = ['clear', 'clouds', 'mist', 'rain', 'storm'];
        const next = order[(order.indexOf(wState.current) + 1) % order.length];
        setDynamicWeatherState(next, true);
      }
    }

    if (rainLines.visible && !window._playerInsideCave) {
      rainLines.position.set(px, Math.max(0, py - 6.0), pz);
      const pBudget = (window.AdaptiveGovernor && window.AdaptiveGovernor.particleBudgetScale) ? window.AdaptiveGovernor.particleBudgetScale : 1.0;
      const activeRainCount = Math.max(180, Math.floor(rainCount * pBudget));
      rainGeo.setDrawRange(0, activeRainCount * 2);
      const rArr = rainGeo.attributes.position.array;
      for (let i = 0; i < activeRainCount; i++) {
        const i6 = i * 6;
        rArr[i6 + 1] -= 26.0 * dt;
        rArr[i6 + 4] -= 26.0 * dt;
        if (rArr[i6 + 1] < 0) {
          rArr[i6 + 1] = 24.0;
          rArr[i6 + 4] = 22.85;
        }
      }
      rainGeo.attributes.position.needsUpdate = true;

      if (wState.current === 'storm' && Math.random() < dt * 0.16) {
        wState.lightningFlash = 1.0;
        AudioEngine.playWindGust();
      }
    }

    if (wState.lightningFlash > 0) {
      wState.lightningFlash = Math.max(0, wState.lightningFlash - dt * 4.5);
      window._activeLightningBoost = wState.lightningFlash * 2.8;
      if (window.hemiLight) {
        const dFac = window.caveDarknessFactor || 0.0;
        const baseHemi = (window._surfaceHemiInt !== undefined) ? window._surfaceHemiInt : 0.85;
        window.hemiLight.intensity = (baseHemi + window._activeLightningBoost) * (1.0 - 0.992 * dFac);
      }
    } else {
      window._activeLightningBoost = 0.0;
    }
  };
})();
