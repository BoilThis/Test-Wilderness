#!/usr/bin/env python3
"""
Generates curated, photorealistic GLB (glTF 2.0 Binary) 3D assets for Sylvan:
- spruce_tree.glb (dense conifer with multi-tier boughs and bark trunk)
- birch_tree.glb (white birch with branching crown and realistic foliage)
- boulder_granite.glb (smooth subdivided icosahedron boulder with mossy rock shading)
- river_stones.glb (smooth water-worn river stones)
- timber_log.glb (harvested floating timber log with end rings)
- campfire_pit.glb (stone-ringed campfire with charred logs and embers)
- first_person_axe.glb (first-person hand and bound stone axe)
- survival_shelter.glb (lean-to timber shelter with pine boughs)
"""

import struct
import json
import math
import os

def create_glb(meshes, output_path):
    """
    meshes: list of dicts:
    {
        'name': str,
        'positions': list of (x,y,z),
        'normals': list of (nx,ny,nz),
        'colors': list of (r,g,b) or None,
        'indices': list of int (triangles),
        'material': dict (pbrMetallicRoughness, etc.)
    }
    """
    bin_buffer = bytearray()
    buffer_views = []
    accessors = []
    materials = []
    gltf_meshes = []
    nodes = []
    scene_nodes = []

    for mesh_idx, m in enumerate(meshes):
        pos_list = m['positions']
        norm_list = m['normals']
        col_list = m.get('colors')
        idx_list = m['indices']
        mat_def = m.get('material', {})

        # Calculate bounding box
        min_x = min(p[0] for p in pos_list)
        max_x = max(p[0] for p in pos_list)
        min_y = min(p[1] for p in pos_list)
        max_y = max(p[1] for p in pos_list)
        min_z = min(p[2] for p in pos_list)
        max_z = max(p[2] for p in pos_list)

        # 1. Write Indices (UNSIGNED_SHORT or UNSIGNED_INT)
        idx_offset = len(bin_buffer)
        use_uint = len(pos_list) > 65535
        if use_uint:
            for idx in idx_list:
                bin_buffer.extend(struct.pack('<I', idx))
            idx_type = 5125 # UNSIGNED_INT
            idx_elem_size = 4
        else:
            for idx in idx_list:
                bin_buffer.extend(struct.pack('<H', idx))
            idx_type = 5123 # UNSIGNED_SHORT
            idx_elem_size = 2
        # Align to 4 bytes
        while len(bin_buffer) % 4 != 0:
            bin_buffer.append(0)
        idx_len = len(bin_buffer) - idx_offset

        bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": idx_offset,
            "byteLength": idx_len,
            "target": 34963 # ELEMENT_ARRAY_BUFFER
        })
        acc_idx = len(accessors)
        accessors.append({
            "bufferView": bv_idx,
            "byteOffset": 0,
            "componentType": idx_type,
            "count": len(idx_list),
            "type": "SCALAR",
            "max": [max(idx_list)] if idx_list else [0],
            "min": [min(idx_list)] if idx_list else [0]
        })

        # 2. Write Positions (FLOAT, VEC3)
        pos_offset = len(bin_buffer)
        for p in pos_list:
            bin_buffer.extend(struct.pack('<fff', p[0], p[1], p[2]))
        while len(bin_buffer) % 4 != 0:
            bin_buffer.append(0)
        pos_len = len(bin_buffer) - pos_offset

        bv_pos = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": pos_offset,
            "byteLength": pos_len,
            "target": 34962 # ARRAY_BUFFER
        })
        acc_pos = len(accessors)
        accessors.append({
            "bufferView": bv_pos,
            "byteOffset": 0,
            "componentType": 5126, # FLOAT
            "count": len(pos_list),
            "type": "VEC3",
            "max": [max_x, max_y, max_z],
            "min": [min_x, min_y, min_z]
        })

        # 3. Write Normals (FLOAT, VEC3)
        norm_offset = len(bin_buffer)
        for n in norm_list:
            bin_buffer.extend(struct.pack('<fff', n[0], n[1], n[2]))
        while len(bin_buffer) % 4 != 0:
            bin_buffer.append(0)
        norm_len = len(bin_buffer) - norm_offset

        bv_norm = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": norm_offset,
            "byteLength": norm_len,
            "target": 34962 # ARRAY_BUFFER
        })
        acc_norm = len(accessors)
        accessors.append({
            "bufferView": bv_norm,
            "byteOffset": 0,
            "componentType": 5126, # FLOAT
            "count": len(norm_list),
            "type": "VEC3"
        })

        attributes = {
            "POSITION": acc_pos,
            "NORMAL": acc_norm
        }

        # 4. Optional Colors (FLOAT, VEC3)
        if col_list and len(col_list) == len(pos_list):
            col_offset = len(bin_buffer)
            for c in col_list:
                bin_buffer.extend(struct.pack('<fff', c[0], c[1], c[2]))
            while len(bin_buffer) % 4 != 0:
                bin_buffer.append(0)
            col_len = len(bin_buffer) - col_offset

            bv_col = len(buffer_views)
            buffer_views.append({
                "buffer": 0,
                "byteOffset": col_offset,
                "byteLength": col_len,
                "target": 34962
            })
            acc_col = len(accessors)
            accessors.append({
                "bufferView": bv_col,
                "byteOffset": 0,
                "componentType": 5126,
                "count": len(col_list),
                "type": "VEC3"
            })
            attributes["COLOR_0"] = acc_col

        # Material
        mat_idx = len(materials)
        materials.append(mat_def)

        # Mesh Primitive
        gltf_mesh_idx = len(gltf_meshes)
        gltf_meshes.append({
            "name": m['name'],
            "primitives": [{
                "attributes": attributes,
                "indices": acc_idx,
                "material": mat_idx,
                "mode": 4 # TRIANGLES
            }]
        })

        node_idx = len(nodes)
        nodes.append({
            "name": m['name'],
            "mesh": gltf_mesh_idx
        })
        scene_nodes.append(node_idx)

    # GLTF JSON structure
    gltf_dict = {
        "asset": {"version": "2.0", "generator": "SylvanGLBGen"},
        "scenes": [{"nodes": scene_nodes}],
        "scene": 0,
        "nodes": nodes,
        "meshes": gltf_meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_buffer)}]
    }

    json_str = json.dumps(gltf_dict, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    while len(json_bytes) % 4 != 0:
        json_bytes += b' ' # Space padding for JSON

    # Align bin_buffer to 4 bytes
    while len(bin_buffer) % 4 != 0:
        bin_buffer.append(0)

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_buffer)

    header = struct.pack('<4sII', b'glTF', 2, total_len)
    chunk0_hdr = struct.pack('<II', len(json_bytes), 0x4E4F534A) # JSON
    chunk1_hdr = struct.pack('<II', len(bin_buffer), 0x004E4942) # BIN

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'wb') as f:
        f.write(header)
        f.write(chunk0_hdr)
        f.write(json_bytes)
        f.write(chunk1_hdr)
        f.write(bin_buffer)

# Helper: Cylinder Generator (smooth normals)
def make_cylinder(r_bottom, r_top, height, segments=16, height_segments=8, y_offset=0.0):
    positions = []
    normals = []
    indices = []
    
    for y_step in range(height_segments + 1):
        v = y_step / height_segments
        y = y_offset + v * height
        r = r_bottom * (1.0 - v) + r_top * v
        for s in range(segments):
            u = s / segments
            angle = u * math.pi * 2.0
            x = math.cos(angle) * r
            z = math.sin(angle) * r
            nx = math.cos(angle)
            nz = math.sin(angle)
            positions.append((x, y, z))
            normals.append((nx, 0.0, nz))
            
    for y_step in range(height_segments):
        for s in range(segments):
            next_s = (s + 1) % segments
            i0 = y_step * segments + s
            i1 = y_step * segments + next_s
            i2 = (y_step + 1) * segments + next_s
            i3 = (y_step + 1) * segments + s
            indices.extend([i0, i1, i2, i0, i2, i3])
            
    return positions, normals, indices

# Helper: Sphere / Geodesic Boulders
def make_boulder(radius=1.0, subdivisions=3, seed=42):
    t = (1.0 + math.sqrt(5.0)) / 2.0
    verts = [
        (-1,  t,  0), ( 1,  t,  0), (-1, -t,  0), ( 1, -t,  0),
        ( 0, -1,  t), ( 0,  1,  t), ( 0, -1, -t), ( 0,  1, -t),
        ( t,  0, -1), ( t,  0,  1), (-t,  0, -1), (-t,  0,  1)
    ]
    # Normalize
    verts = [(x/math.sqrt(x*x+y*y+z*z), y/math.sqrt(x*x+y*y+z*z), z/math.sqrt(x*x+y*y+z*z)) for x,y,z in verts]
    faces = [
        (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
        (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
        (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
        (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)
    ]
    
    midpoint_cache = {}
    def get_midpoint(i1, i2):
        key = tuple(sorted([i1, i2]))
        if key in midpoint_cache:
            return midpoint_cache[key]
        p1 = verts[i1]
        p2 = verts[i2]
        mx = (p1[0] + p2[0]) / 2.0
        my = (p1[1] + p2[1]) / 2.0
        mz = (p1[2] + p2[2]) / 2.0
        l = math.sqrt(mx*mx + my*my + mz*mz)
        verts.append((mx/l, my/l, mz/l))
        idx = len(verts) - 1
        midpoint_cache[key] = idx
        return idx
        
    for _ in range(subdivisions):
        new_faces = []
        for f in faces:
            m1 = get_midpoint(f[0], f[1])
            m2 = get_midpoint(f[1], f[2])
            m3 = get_midpoint(f[2], f[0])
            new_faces.extend([
                (f[0], m1, m3),
                (f[1], m2, m1),
                (f[2], m3, m2),
                (m1, m2, m3)
            ])
        faces = new_faces

    # Deform vertices with natural rock noise
    positions = []
    normals = []
    colors = []
    for x, y, z in verts:
        # Multi-octave pseudo-noise
        disp = 1.0 + 0.22 * math.sin(x*4.5 + seed) * math.cos(y*4.5) + 0.12 * math.sin(z*6.0)
        # Flatten bottom slightly for natural ground resting
        y_mod = y
        if y < -0.4:
            disp *= (1.0 - (abs(y) - 0.4) * 0.4)
        px = x * radius * disp * 1.3
        py = y * radius * disp * 0.85
        pz = z * radius * disp
        positions.append((px, py, pz))
        
        # Smooth outward normal
        l = math.sqrt(px*px + py*py + pz*pz)
        normals.append((px/l, py/l, pz/l))
        
        # Mossy rock color tint: moss on top, gray rock on sides
        moss = max(0.0, min(1.0, py / (radius * 0.8) + 0.2))
        r = 0.38 * (1.0 - moss * 0.4)
        g = 0.42 * (1.0 + moss * 0.25)
        b = 0.40 * (1.0 - moss * 0.5)
        colors.append((r, g, b))

    indices = []
    for f in faces:
        indices.extend([f[0], f[1], f[2]])

    return positions, normals, colors, indices

# 1. BUILD SPRUCE TREE (Boreal Conifer)
def build_spruce_tree():
    # Trunk
    t_pos, t_norm, t_idx = make_cylinder(0.35, 0.08, 7.5, segments=16, height_segments=10)
    t_colors = [(0.24, 0.16, 0.11) for _ in t_pos]
    
    # Needles / Boughs (6 tiers of lush conifer cones)
    b_pos = []
    b_norm = []
    b_colors = []
    b_idx = []
    
    base_idx = 0
    tier_configs = [
        (2.0, 2.4, 1.8),
        (3.0, 2.1, 1.7),
        (4.0, 1.7, 1.6),
        (5.0, 1.3, 1.4),
        (6.0, 0.9, 1.3),
        (6.8, 0.5, 1.2)
    ]
    
    for y_start, radius, b_height in tier_configs:
        segs = 16
        # Cone apex
        apex = (0.0, y_start + b_height, 0.0)
        apex_idx = base_idx
        b_pos.append(apex)
        b_norm.append((0.0, 1.0, 0.0))
        b_colors.append((0.11, 0.24, 0.12))
        base_idx += 1
        
        # Base ring with subtle drooping wave
        ring_start = base_idx
        for s in range(segs):
            angle = s / segs * math.pi * 2.0
            wave = 0.15 * math.sin(s * 3.0)
            x = math.cos(angle) * radius
            z = math.sin(angle) * radius
            y = y_start + wave
            b_pos.append((x, y, z))
            # Normal sloping down and out
            nx = math.cos(angle) * 0.8
            nz = math.sin(angle) * 0.8
            b_norm.append((nx, -0.4, nz))
            b_colors.append((0.13, 0.28, 0.14))
            base_idx += 1
            
        for s in range(segs):
            next_s = (s + 1) % segs
            b_idx.extend([apex_idx, ring_start + s, ring_start + next_s])

    meshes = [
        {
            "name": "SpruceTrunk",
            "positions": t_pos,
            "normals": t_norm,
            "colors": t_colors,
            "indices": t_idx,
            "material": {
                "name": "BarkPBR",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.38, 0.26, 0.18, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.88
                }
            }
        },
        {
            "name": "SpruceFoliage",
            "positions": b_pos,
            "normals": b_norm,
            "colors": b_colors,
            "indices": b_idx,
            "material": {
                "name": "PineNeedlesPBR",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.18, 0.35, 0.19, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.65
                }
            }
        }
    ]
    return meshes

# 2. BUILD BIRCH TREE
def build_birch_tree():
    # Trunk with gentle curve
    t_pos, t_norm, t_idx = make_cylinder(0.28, 0.07, 7.0, segments=16, height_segments=10)
    # Give birch trunk realistic curve
    curved_pos = []
    for x, y, z in t_pos:
        lean = math.sin(y * 0.4) * 0.35
        curved_pos.append((x + lean, y, z))
        
    t_colors = []
    for x, y, z in curved_pos:
        # White birch bark with subtle striation markings
        stripe = (math.sin(y * 12.0) + 1.0) * 0.5
        gray = 0.82 + stripe * 0.14
        t_colors.append((gray, gray * 0.98, gray * 0.92))
        
    # Foliage crown (3 soft organic leaf spheres)
    f_pos = []
    f_norm = []
    f_colors = []
    f_idx = []
    base_idx = 0
    
    crown_spheres = [
        (0.3, 5.5, 0.0, 1.8),
        (-0.5, 6.2, 0.3, 1.5),
        (0.4, 6.8, -0.3, 1.3)
    ]
    for cx, cy, cz, cr in crown_spheres:
        bp, bn, bc, bi = make_boulder(radius=cr, subdivisions=2, seed=int(cx*100))
        for p in bp:
            f_pos.append((p[0] + cx, p[1] + cy, p[2] + cz))
        for n in bn:
            f_norm.append(n)
        for _ in bp:
            f_colors.append((0.26, 0.48, 0.22))
        for idx in bi:
            f_idx.append(base_idx + idx)
        base_idx += len(bp)

    return [
        {
            "name": "BirchTrunk",
            "positions": curved_pos,
            "normals": t_norm,
            "colors": t_colors,
            "indices": t_idx,
            "material": {
                "name": "BirchBarkPBR",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.88, 0.86, 0.82, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.75
                }
            }
        },
        {
            "name": "BirchFoliage",
            "positions": f_pos,
            "normals": f_norm,
            "colors": f_colors,
            "indices": f_idx,
            "material": {
                "name": "BirchLeavesPBR",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.35, 0.62, 0.28, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.55
                }
            }
        }
    ]

# 3. BUILD GRANITE BOULDER
def build_granite_boulder():
    pos, norm, col, idx = make_boulder(radius=1.8, subdivisions=3, seed=107)
    return [{
        "name": "GraniteBoulder",
        "positions": pos,
        "normals": norm,
        "colors": col,
        "indices": idx,
        "material": {
            "name": "GranitePBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.55, 0.58, 0.56, 1.0],
                "metallicFactor": 0.05,
                "roughnessFactor": 0.85
            }
        }
    }]

# 4. BUILD RIVER STONES
def build_river_stones():
    all_pos = []
    all_norm = []
    all_col = []
    all_idx = []
    base_idx = 0
    
    stone_configs = [
        (0.0, 0.1, 0.0, 0.45, 12),
        (0.6, 0.08, 0.2, 0.35, 34),
        (-0.5, 0.09, -0.3, 0.40, 56),
        (0.2, 0.07, -0.6, 0.30, 78),
        (-0.4, 0.06, 0.5, 0.25, 90)
    ]
    for sx, sy, sz, sr, seed in stone_configs:
        p, n, c, i = make_boulder(radius=sr, subdivisions=2, seed=seed)
        for pt in p:
            all_pos.append((pt[0]*1.4 + sx, pt[1]*0.5 + sy, pt[2]*1.1 + sz))
        all_norm.extend(n)
        for _ in p:
            all_col.append((0.35, 0.42, 0.44)) # Riverbed slate
        for idx in i:
            all_idx.append(base_idx + idx)
        base_idx += len(p)
        
    return [{
        "name": "RiverStones",
        "positions": all_pos,
        "normals": all_norm,
        "colors": all_col,
        "indices": all_idx,
        "material": {
            "name": "WetRiverStonePBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.42, 0.48, 0.50, 1.0],
                "metallicFactor": 0.15,
                "roughnessFactor": 0.32 # Wet sheen
            }
        }
    }]

# 5. BUILD TIMBER LOG (Floating Buoyant Log)
def build_timber_log():
    # Horizontal log along Z axis
    length = 2.8
    radius = 0.22
    segs = 16
    h_segs = 8
    
    pos = []
    norm = []
    idx = []
    col = []
    
    for z_step in range(h_segs + 1):
        v = z_step / h_segs
        z = -length/2.0 + v * length
        for s in range(segs):
            angle = s / segs * math.pi * 2.0
            x = math.cos(angle) * radius
            y = math.sin(angle) * radius
            pos.append((x, y, z))
            norm.append((math.cos(angle), math.sin(angle), 0.0))
            col.append((0.36, 0.22, 0.14)) # Bark
            
    for z_step in range(h_segs):
        for s in range(segs):
            next_s = (s + 1) % segs
            i0 = z_step * segs + s
            i1 = z_step * segs + next_s
            i2 = (z_step + 1) * segs + next_s
            i3 = (z_step + 1) * segs + s
            idx.extend([i0, i1, i2, i0, i2, i3])
            
    # End caps with annular rings
    cap1_center = len(pos)
    pos.append((0.0, 0.0, -length/2.0))
    norm.append((0.0, 0.0, -1.0))
    col.append((0.74, 0.58, 0.38))
    for s in range(segs):
        idx.extend([cap1_center, (s+1)%segs, s])
        
    cap2_center = len(pos)
    pos.append((0.0, 0.0, length/2.0))
    norm.append((0.0, 0.0, 1.0))
    col.append((0.74, 0.58, 0.38))
    last_ring = h_segs * segs
    for s in range(segs):
        idx.extend([cap2_center, last_ring + s, last_ring + (s+1)%segs])

    return [{
        "name": "TimberLog",
        "positions": pos,
        "normals": norm,
        "colors": col,
        "indices": idx,
        "material": {
            "name": "TimberPBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.48, 0.32, 0.22, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.85
            }
        }
    }]

# 6. BUILD CAMPFIRE PIT
def build_campfire_pit():
    pos = []
    norm = []
    col = []
    idx = []
    base_idx = 0
    
    # 10 Stones in a circle
    num_stones = 10
    ring_radius = 0.95
    for i in range(num_stones):
        ang = i / num_stones * math.pi * 2.0
        sx = math.cos(ang) * ring_radius
        sz = math.sin(ang) * ring_radius
        p, n, c, f = make_boulder(radius=0.18, subdivisions=2, seed=i*13)
        for pt in p:
            pos.append((pt[0] + sx, pt[1]*0.7 + 0.1, pt[2] + sz))
        norm.extend(n)
        for _ in p:
            col.append((0.38, 0.36, 0.34))
        for f_idx in f:
            idx.append(base_idx + f_idx)
        base_idx += len(p)
        
    # Cross logs in center
    for log_ang in [0.4, 1.9, 3.5]:
        lx = math.cos(log_ang)
        lz = math.sin(log_ang)
        p, n, f = make_cylinder(0.08, 0.06, 1.1, segments=8, height_segments=4)
        for pt in p:
            # Rotate cylinder horizontally
            rx = pt[0] * lz - (pt[1] - 0.55) * lx
            rz = pt[0] * lx + (pt[1] - 0.55) * lz
            ry = pt[2] + 0.12
            pos.append((rx, ry, rz))
            norm.append((0.0, 1.0, 0.0))
            col.append((0.15, 0.12, 0.10)) # Charred timber
        for f_idx in f:
            idx.append(base_idx + f_idx)
        base_idx += len(p)
        
    # Glowing coal embers bed
    ember_p, ember_n, ember_c, ember_f = make_boulder(radius=0.45, subdivisions=2, seed=99)
    for pt in ember_p:
        pos.append((pt[0], pt[1]*0.2 + 0.08, pt[2]))
        norm.append((0.0, 1.0, 0.0))
        col.append((0.95, 0.35, 0.08)) # Hot ember glow
    for f_idx in ember_f:
        idx.append(base_idx + f_idx)

    return [{
        "name": "CampfirePit",
        "positions": pos,
        "normals": norm,
        "colors": col,
        "indices": idx,
        "material": {
            "name": "CampfirePBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.65, 0.45, 0.35, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.90
            },
            "emissiveFactor": [0.8, 0.25, 0.05]
        }
    }]

# 7. BUILD FIRST-PERSON HAND & STONE AXE
def build_first_person_axe():
    pos = []
    norm = []
    col = []
    idx = []
    base_idx = 0
    
    # 1. Wooden handle
    hp, hn, hf = make_cylinder(0.035, 0.03, 0.85, segments=12, height_segments=6)
    for p in hp:
        pos.append((p[0], p[1], p[2]))
        norm.append(hn[len(pos) - 1 - base_idx])
        col.append((0.42, 0.28, 0.18))
    for f in hf:
        idx.append(base_idx + f)
    base_idx += len(hp)
    
    # 2. Sharpened Flint / Granite Axe Head
    ap, an, ac, af = make_boulder(radius=0.16, subdivisions=2, seed=77)
    for p in ap:
        # Scale to wedge shape
        wx = p[0] * 0.45 + 0.08
        wy = p[1] * 1.3 + 0.75
        wz = p[2] * 0.95
        pos.append((wx, wy, wz))
        norm.append(an[len(pos) - 1 - base_idx])
        col.append((0.28, 0.32, 0.35)) # Dark sharp flint
    for f in af:
        idx.append(base_idx + f)
    base_idx += len(ap)
    
    # 3. Rawhide binding wraps around head
    bp, bn, bf = make_cylinder(0.055, 0.055, 0.14, segments=10, height_segments=2, y_offset=0.68)
    for p in bp:
        pos.append(p)
        norm.append(bn[len(pos) - 1 - base_idx])
        col.append((0.62, 0.52, 0.40)) # Rawhide leather
    for f in bf:
        idx.append(base_idx + f)
    base_idx += len(bp)

    # 4. Realistic First-Person Hand / Forearm gripping haft
    gp, gn, gc, gf = make_boulder(radius=0.12, subdivisions=2, seed=33)
    for p in gp:
        pos.append((p[0]*1.1, p[1]*1.4 + 0.32, p[2]*1.1))
        norm.append(gn[len(pos) - 1 - base_idx])
        col.append((0.76, 0.58, 0.46)) # Skin tone
    for f in gf:
        idx.append(base_idx + f)
        
    return [{
        "name": "FirstPersonAxe",
        "positions": pos,
        "normals": norm,
        "colors": col,
        "indices": idx,
        "material": {
            "name": "AxePBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.65, 0.55, 0.48, 1.0],
                "metallicFactor": 0.15,
                "roughnessFactor": 0.55
            }
        }
    }]

# 8. BUILD SURVIVAL SHELTER
def build_survival_shelter():
    pos = []
    norm = []
    col = []
    idx = []
    base_idx = 0
    
    # 3 Main Ridge Timber Poles
    pole_coords = [
        (-1.2, 0.0, -1.0, -1.2, 1.8, 1.0),
        ( 1.2, 0.0, -1.0,  1.2, 1.8, 1.0),
        (-1.2, 1.8,  1.0,  1.2, 1.8, 1.0)
    ]
    for x1, y1, z1, x2, y2, z2 in pole_coords:
        p, n, f = make_cylinder(0.08, 0.07, 2.6, segments=8, height_segments=4)
        for pt in p:
            t = (pt[1] / 2.6)
            px = x1 + (x2 - x1) * t + pt[0]
            py = y1 + (y2 - y1) * t
            pz = z1 + (z2 - z1) * t + pt[2]
            pos.append((px, py, pz))
            norm.append((0.0, 1.0, 0.0))
            col.append((0.38, 0.25, 0.16))
        for f_idx in f:
            idx.append(base_idx + f_idx)
        base_idx += len(p)
        
    # Slanted spruce bough roof
    sp, sn, sc, sf = make_boulder(radius=1.6, subdivisions=2, seed=88)
    for p in sp:
        rx = p[0] * 1.1
        ry = p[1] * 0.35 + 1.1 - (p[2] * 0.4)
        rz = p[2] * 0.7 - 0.2
        pos.append((rx, ry, rz))
        norm.append((0.0, 0.8, -0.6))
        col.append((0.15, 0.32, 0.16)) # Spruce boughs
    for f in sf:
        idx.append(base_idx + f)

    return [{
        "name": "SurvivalShelter",
        "positions": pos,
        "normals": norm,
        "colors": col,
        "indices": idx,
        "material": {
            "name": "ShelterPBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.35, 0.42, 0.25, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.88
            }
        }
    }]

def main():
    out_dir = "app/src/main/assets/wilderness/models"
    os.makedirs(out_dir, exist_ok=True)
    
    print("Generating curated GLB assets...")
    create_glb(build_spruce_tree(), f"{out_dir}/spruce_tree.glb")
    print("-> spruce_tree.glb OK")
    create_glb(build_birch_tree(), f"{out_dir}/birch_tree.glb")
    print("-> birch_tree.glb OK")
    create_glb(build_granite_boulder(), f"{out_dir}/boulder_granite.glb")
    print("-> boulder_granite.glb OK")
    create_glb(build_river_stones(), f"{out_dir}/river_stones.glb")
    print("-> river_stones.glb OK")
    create_glb(build_timber_log(), f"{out_dir}/timber_log.glb")
    print("-> timber_log.glb OK")
    create_glb(build_campfire_pit(), f"{out_dir}/campfire_pit.glb")
    print("-> campfire_pit.glb OK")
    create_glb(build_first_person_axe(), f"{out_dir}/first_person_axe.glb")
    print("-> first_person_axe.glb OK")
    create_glb(build_survival_shelter(), f"{out_dir}/survival_shelter.glb")
    print("-> survival_shelter.glb OK")
    print("All curated GLB assets created successfully!")

if __name__ == '__main__':
    main()
