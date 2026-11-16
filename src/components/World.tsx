"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Layout, WarehouseConfig } from "@/lib/warehouse";

/**
 * The site around the warehouse: grass, truck court, access road, staff car
 * park, parked trucks, trees and a few neighbouring buildings.
 *
 * Built in the warehouse's site frame (see lib/warehouse.ts): the dock wall
 * lies on fz = 0, the building spans fx ∈ [0, E] × fz ∈ [0, D], and fz < 0 is
 * outside the docks. The parent group rotates the frame into world space.
 */

const MARGIN = 110; // painted ground beyond the building on each side, m
const ROAD_Z0 = -52; // road edges in the dock frame
const ROAD_Z1 = -42;
const COURT_Z = -42; // truck court reaches the road
const noRaycast = () => null;

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function siteRects(E: number, D: number) {
  const court: Rect = { x0: -14, x1: E + 14, z0: COURT_Z, z1: 0 };
  const parking: Rect = { x0: E + 8, x1: E + 36, z0: COURT_Z, z1: Math.min(D, 46) };
  const road: Rect = { x0: -MARGIN - E, x1: 2 * E + MARGIN, z0: ROAD_Z0, z1: ROAD_Z1 };
  const building: Rect = { x0: -2, x1: E + 2, z0: -0.5, z1: D + 2 };
  return { court, parking, road, building };
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inRect = (r: Rect, x: number, z: number, pad = 0) =>
  x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;

export default function World({ config, layout }: { config: WarehouseConfig; layout: Layout }) {
  // Rendered inside the site frame: dock wall on z = 0, building fx ∈ [0, E], fz ∈ [0, D].
  const E = config.width;
  const D = config.length;
  const docks = layout.docks.map((d) => d.at);
  const dockW = layout.docks[0]?.width ?? 3;

  return (
    <group>
      <Ground E={E} D={D} docks={docks} dockW={dockW} />
      {/* Docks 1 & 3 unload into the AS/RS, dock 2 loads outbound pallets */}
      {docks.map((at, i) => (
        <Truck key={i} at={at} variant={i} />
      ))}
      <Cars E={E} D={D} />
      <Trees E={E} D={D} />
      <Neighbours E={E} />
    </group>
  );
}

function Ground({ E, D, docks, dockW }: { E: number; D: number; docks: number[]; dockW: number }) {
  const gl = useThree((s) => s.gl);
  const area = useMemo(() => ({ x0: -MARGIN, z0: -MARGIN, w: E + 2 * MARGIN, l: D + 2 * MARGIN }), [E, D]);
  const texture = useMemo(() => {
    const ppm = Math.min(8, Math.min(gl.capabilities.maxTextureSize, 4096) / Math.max(area.w, area.l));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(area.w * ppm);
    canvas.height = Math.round(area.l * ppm);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(canvas.width / area.w, canvas.height / area.l);
    ctx.translate(-area.x0, -area.z0); // draw in frame meters

    const { court, parking, road } = siteRects(E, D);
    const rand = mulberry32(7);

    // Grass with mottled patches.
    ctx.fillStyle = "#5b7f3a";
    ctx.fillRect(area.x0, area.z0, area.w, area.l);
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = rand() < 0.5 ? "rgba(70,105,45,0.35)" : "rgba(120,150,70,0.25)";
      ctx.beginPath();
      ctx.arc(area.x0 + rand() * area.w, area.z0 + rand() * area.l, 1 + rand() * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const fill = (r: Rect, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
    };
    // Concrete footpath around the building, then the paved areas.
    fill({ x0: -2.5, x1: E + 2.5, z0: -2.5, z1: D + 2.5 }, "#a8a29e");
    fill(court, "#3f4448");
    fill(parking, "#45494d");
    fill({ x0: road.x0, x1: road.x1, z0: road.z0 - 2, z1: road.z0 }, "#a8a29e"); // far sidewalk
    fill(road, "#2f3336");
    // Concrete dock aprons in front of each door.
    for (const at of docks) fill({ x0: at - dockW / 2 - 0.8, x1: at + dockW / 2 + 0.8, z0: -18, z1: 0 }, "#6b7075");

    ctx.fillStyle = "#f8fafc";
    // Road edge lines + dashed centre line.
    ctx.fillRect(road.x0, road.z0 + 0.3, road.x1 - road.x0, 0.15);
    ctx.fillRect(road.x0, road.z1 - 0.45, road.x1 - road.x0, 0.15);
    ctx.fillStyle = "#facc15";
    const mid = (road.z0 + road.z1) / 2;
    for (let x = road.x0; x < road.x1; x += 6) ctx.fillRect(x, mid - 0.08, 3, 0.16);

    // Trailer stall lines either side of each dock.
    ctx.fillStyle = "#facc15";
    for (const at of docks)
      for (const x of [at - 1.9, at + 1.9]) ctx.fillRect(x - 0.08, -18, 0.16, 17.5);

    // Car park stalls: two rows facing a central drive lane.
    ctx.fillStyle = "#f8fafc";
    const stallW = 2.6, stallL = 5;
    for (const [x0, x1] of [
      [parking.x0 + 1, parking.x0 + 1 + stallL],
      [parking.x1 - 1 - stallL, parking.x1 - 1],
    ]) {
      for (let z = parking.z0 + 4; z + stallW <= parking.z1 - 1; z += stallW) ctx.fillRect(x0, z, x1 - x0, 0.12);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = gl.capabilities.getMaxAnisotropy();
    return tex;
  }, [gl, area, E, D, docks, dockW]);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <group>
      {/* Painted site, just below the warehouse floor */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[area.x0 + area.w / 2, -0.03, area.z0 + area.l / 2]}
        receiveShadow
        raycast={noRaycast}
      >
        <planeGeometry args={[area.w, area.l]} />
        <meshStandardMaterial map={texture} roughness={1} />
      </mesh>
      {/* Endless grass beyond, fading into the fog */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[E / 2, -0.06, D / 2]} raycast={noRaycast}>
        <circleGeometry args={[4000, 48]} />
        <meshStandardMaterial color="#56783a" roughness={1} />
      </mesh>
    </group>
  );
}

/**
 * Box-trailer truck backed up to a dock door (front of the cab points away).
 * The trailer floor sits at dock-conveyor height, so pallets the AS/RS loads
 * or unloads are hidden inside the trailer body while they appear/disappear.
 */
function Truck({ at, variant }: { at: number; variant: number }) {
  const cab = ["#dc2626", "#16a34a", "#2563eb"][variant % 3];
  const trailerL = 13.6, gap = 0.35;
  const tz = -(gap + trailerL / 2);
  const cz = -(gap + trailerL + 0.6 + 1.2);
  const box = (key: string, p: [number, number, number], s: [number, number, number], color: string, metal = 0.2) => (
    <mesh key={key} position={p} castShadow receiveShadow raycast={noRaycast}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} metalness={metal} roughness={0.55} />
    </mesh>
  );
  const wheels: [number, number][] = [];
  for (const z of [-gap - 1.2, -gap - 2.6, -gap - 4.0]) wheels.push([0, z]);
  for (const z of [cz + 0.6, cz - 0.6, cz - 1.7]) wheels.push([0, z]);
  return (
    <group position={[at, 0, 0]}>
      {/* Trailer body y ∈ [0.45, 3.45]: fully encloses a pallet on the 0.5 m conveyor */}
      {box("trailer", [0, 1.95, tz], [2.5, 3.0, trailerL], "#f1f5f9", 0.3)}
      {box("stripe", [1.26, 1.3, tz], [0.02, 0.3, trailerL - 0.4], cab)}
      {box("stripe2", [-1.26, 1.3, tz], [0.02, 0.3, trailerL - 0.4], cab)}
      {box("chassis", [0, 0.35, (tz + cz) / 2], [1.0, 0.2, trailerL + 3], "#1f2937")}
      {box("cab", [0, 1.9, cz], [2.5, 2.6, 2.4], cab, 0.4)}
      {box("glass", [0, 2.4, cz - 1.21], [2.2, 0.9, 0.02], "#1e293b", 0.8)}
      {wheels.map(([, z], i) =>
        [-1.05, 1.05].map((x) => (
          <mesh key={`${i}${x}`} position={[x, 0.42, z]} rotation={[0, 0, Math.PI / 2]} castShadow raycast={noRaycast}>
            <cylinderGeometry args={[0.42, 0.42, 0.35, 16]} />
            <meshStandardMaterial color="#111827" roughness={0.9} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Instanced helper: one unit box mesh with per-instance transforms and colors. */
function InstancedBoxes({
  items,
  geometry,
  roughness = 0.6,
  metalness = 0.1,
}: {
  items: { m: THREE.Matrix4; c: string }[];
  geometry: THREE.BufferGeometry;
  roughness?: number;
  metalness?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const col = new THREE.Color();
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, col.set(it.c));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[geometry, undefined, items.length]} castShadow receiveShadow raycast={noRaycast}>
      <meshStandardMaterial roughness={roughness} metalness={metalness} />
    </instancedMesh>
  );
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 1, 6).translate(0, 0.5, 0);
const crownGeo = new THREE.IcosahedronGeometry(1, 0);
const pineGeo = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);

function compose(x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry),
    new THREE.Vector3(sx, sy, sz),
  );
}

function Cars({ E, D }: { E: number; D: number }) {
  const { bodies, cabins } = useMemo(() => {
    const { parking } = siteRects(E, D);
    const rand = mulberry32(42);
    const palette = ["#e2e8f0", "#0f172a", "#9ca3af", "#b91c1c", "#1d4ed8", "#f8fafc", "#475569", "#065f46"];
    const bodies: { m: THREE.Matrix4; c: string }[] = [];
    const cabins: { m: THREE.Matrix4; c: string }[] = [];
    const stallW = 2.6;
    for (const [xc, dir] of [
      [parking.x0 + 1 + 2.5, 1],
      [parking.x1 - 1 - 2.5, -1],
    ] as const) {
      for (let z = parking.z0 + 4; z + stallW <= parking.z1 - 1; z += stallW) {
        if (rand() < 0.35) continue; // empty stall
        const c = palette[Math.floor(rand() * palette.length)];
        const zc = z + stallW / 2;
        bodies.push({ m: compose(xc, 0.55, zc, 4.3, 0.75, 1.8), c });
        cabins.push({ m: compose(xc - dir * 0.25, 1.2, zc, 2.1, 0.6, 1.6), c: "#1e293b" });
      }
    }
    return { bodies, cabins };
  }, [E, D]);
  return (
    <group>
      <InstancedBoxes items={bodies} geometry={unitBox} roughness={0.35} metalness={0.5} />
      <InstancedBoxes items={cabins} geometry={unitBox} roughness={0.2} metalness={0.6} />
    </group>
  );
}

function Trees({ E, D }: { E: number; D: number }) {
  const { trunks, crowns, pines } = useMemo(() => {
    const rects = siteRects(E, D);
    const rand = mulberry32(1234);
    const trunks: { m: THREE.Matrix4; c: string }[] = [];
    const crowns: { m: THREE.Matrix4; c: string }[] = [];
    const pines: { m: THREE.Matrix4; c: string }[] = [];
    const greens = ["#3f6d2a", "#4d7c2f", "#2f5d24", "#5a8a35"];
    const placed: [number, number][] = [];
    const R = MARGIN + 40;
    const blocked = (x: number, z: number) =>
      inRect(rects.building, x, z, 5) ||
      inRect(rects.court, x, z, 3) ||
      inRect(rects.parking, x, z, 3) ||
      inRect(rects.road, x, z, 4) ||
      (z < ROAD_Z0 - 10 && z > ROAD_Z0 - 75 && x > -30 && x < E + 60) || // neighbour lots
      placed.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 16);
    const target = Math.round(Math.min(600, ((E + 2 * R) * (D + 2 * R)) / 180));
    for (let tries = 0; placed.length < target && tries < target * 8; tries++) {
      const x = -R + rand() * (E + 2 * R);
      const z = -R + rand() * (D + 2 * R);
      if (blocked(x, z)) continue;
      placed.push([x, z]);
      const s = 0.7 + rand() * 0.7;
      const g = greens[Math.floor(rand() * greens.length)];
      if (rand() < 0.35) {
        trunks.push({ m: compose(x, 0, z, s, 1.2 * s, s), c: "#5b3a24" });
        pines.push({ m: compose(x, 1 * s, z, 1.9 * s, 6.5 * s, 1.9 * s), c: "#2b4f25" });
      } else {
        trunks.push({ m: compose(x, 0, z, s, 2.6 * s, s), c: "#6b4428" });
        crowns.push({ m: compose(x, 3.6 * s, z, 2.4 * s, 2.0 * s, 2.4 * s, rand() * 6), c: g });
      }
    }
    // A tidy row of street trees along the road verge.
    for (let x = -60; x < E + 80; x += 12) {
      if (x > -18 && x < E + 40) continue; // leave the site entrance open
      const z = ROAD_Z1 + 3;
      trunks.push({ m: compose(x, 0, z, 0.9, 2.4, 0.9), c: "#6b4428" });
      crowns.push({ m: compose(x, 3.3, z, 2.2, 1.9, 2.2, x), c: "#4d7c2f" });
    }
    return { trunks, crowns, pines };
  }, [E, D]);
  return (
    <group>
      <InstancedBoxes items={trunks} geometry={trunkGeo} roughness={0.9} metalness={0} />
      <InstancedBoxes items={crowns} geometry={crownGeo} roughness={0.85} metalness={0} />
      <InstancedBoxes items={pines} geometry={pineGeo} roughness={0.85} metalness={0} />
    </group>
  );
}

/** A few simple industrial buildings across the road. */
function Neighbours({ E }: { E: number }) {
  const items = useMemo(() => {
    const rand = mulberry32(99);
    const out: { m: THREE.Matrix4; c: string }[] = [];
    const roofs: { m: THREE.Matrix4; c: string }[] = [];
    const colors = ["#cbd5e1", "#d6d3d1", "#94a3b8", "#e2e8f0"];
    let x = -24;
    while (x < E + 56) {
      const w = 18 + rand() * 22, l = 25 + rand() * 25, h = 7 + rand() * 6;
      const z = ROAD_Z0 - 14 - l / 2;
      out.push({ m: compose(x + w / 2, h / 2, z, w, h, l), c: colors[Math.floor(rand() * colors.length)] });
      roofs.push({ m: compose(x + w / 2, h + 0.15, z, w + 0.4, 0.3, l + 0.4), c: "#64748b" });
      x += w + 8 + rand() * 10;
    }
    return { out, roofs };
  }, [E]);
  return (
    <group>
      <InstancedBoxes items={items.out} geometry={unitBox} roughness={0.8} metalness={0.2} />
      <InstancedBoxes items={items.roofs} geometry={unitBox} roughness={0.7} metalness={0.4} />
    </group>
  );
}
