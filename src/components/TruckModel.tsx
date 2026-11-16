"use client";

import { RoundedBox } from "@react-three/drei";
import { ReactNode, useMemo } from "react";
import * as THREE from "three";

/**
 * A reasonably faithful European truck, sized from its cargo box:
 *   L ≥ 10 m  → cab-over tractor + box semi-trailer (tri-axle, super-single tyres)
 *   5–10 m    → rigid box truck (cab and body on one chassis, dual rear tyres)
 *   L < 5 m   → small box van
 *
 * Truck frame (m): cargo floor top at y = 0, cargo box x ∈ [0, L] with the cab
 * at x < 0, z ∈ [0, W]. Ground is at y = -floorH. The near side (z = W) wall and
 * the roof are drawn see-through so the load stays visible.
 */

export const WALL = 0.05; // cargo box wall thickness
export const CAB_L = 2.3; // cab length

type V3 = [number, number, number];
const noRaycast = () => null;

export function truckDims(L: number) {
  const semi = L >= 10, van = L < 5;
  return {
    semi,
    van,
    floorH: van ? 0.8 : 1.22, // ground to cargo floor
    wheelR: van ? 0.36 : 0.53, // 385/65 R22.5 ≈ 1.07 m tyre
    tyreW: van ? 0.24 : 0.38,
    cabGap: semi ? 0.85 : 0.12, // cab back to cargo box front
  };
}

// ---------------------------------------------------------------------------
// Materials and shared geometry

function useMaterials() {
  return useMemo(() => {
    const std = (color: string, metalness: number, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
    return {
      paint: new THREE.MeshPhysicalMaterial({
        color: "#eceef0",
        metalness: 0.25,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
      }),
      accent: new THREE.MeshPhysicalMaterial({ color: "#1d3557", metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
      plastic: std("#2b2e33", 0.05, 0.65),
      grille: std("#15171a", 0.3, 0.5),
      chrome: std("#e3e6ea", 1, 0.12),
      alu: std("#c3c8ce", 0.85, 0.32),
      steel: std("#2a2d31", 0.55, 0.5),
      rubber: std("#18191b", 0, 0.92),
      rim: std("#b9bec4", 0.9, 0.28),
      glass: new THREE.MeshPhysicalMaterial({ color: "#16212c", metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0 }),
      lens: new THREE.MeshPhysicalMaterial({ color: "#eef3f8", metalness: 0.6, roughness: 0.05, clearcoat: 1 }),
      red: std("#a3101a", 0.2, 0.25, { emissive: "#3a0005" }),
      amber: std("#e08600", 0.2, 0.25, { emissive: "#3a2000" }),
      panel: std("#f2f3f4", 0.1, 0.5),
      lining: std("#d7d9db", 0.05, 0.75),
      seam: std("#c9ccd0", 0.3, 0.5),
      wood: std("#7a5b3d", 0, 0.85),
      ghost: new THREE.MeshStandardMaterial({
        color: "#dfe6ee",
        metalness: 0.1,
        roughness: 0.2,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    };
  }, []);
}
type Mats = ReturnType<typeof useMaterials>;

const tyreCache = new Map<string, THREE.LatheGeometry>();
/** Tyre as a lathe: flat tread, rounded shoulders, bulging sidewalls. Axis = y. */
function tyreGeometry(r: number, w: number) {
  const key = `${r}:${w}`;
  let g = tyreCache.get(key);
  if (!g) {
    const rim = r * 0.54, h = w / 2;
    const pts = [
      [rim, -h * 0.92],
      [r * 0.8, -h],
      [r * 0.95, -h * 0.94],
      [r * 0.99, -h * 0.75],
      [r, -h * 0.55],
      [r, h * 0.55],
      [r * 0.99, h * 0.75],
      [r * 0.95, h * 0.94],
      [r * 0.8, h],
      [rim, h * 0.92],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    g = new THREE.LatheGeometry(pts, 40);
    tyreCache.set(key, g);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Primitives

function Box({ p, s, m, rot, shadow = true }: { p: V3; s: V3; m: THREE.Material; rot?: V3; shadow?: boolean }) {
  return (
    <mesh position={p} rotation={rot} material={m} castShadow={shadow} receiveShadow raycast={noRaycast}>
      <boxGeometry args={s} />
    </mesh>
  );
}

function Round({ p, s, r, m }: { p: V3; s: V3; r: number; m: THREE.Material }) {
  return (
    <RoundedBox args={s} radius={r} smoothness={4} position={p} material={m} castShadow receiveShadow raycast={noRaycast} />
  );
}

/** Cylinder along an axis. */
function Cyl({ p, r, len, m, axis = "y", seg = 24 }: { p: V3; r: number; len: number; m: THREE.Material; axis?: "x" | "y" | "z"; seg?: number }) {
  const rot: V3 = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return (
    <mesh position={p} rotation={rot} material={m} castShadow receiveShadow raycast={noRaycast}>
      <cylinderGeometry args={[r, r, len, seg]} />
    </mesh>
  );
}

/**
 * One wheel position on one side: a single (super-single / steer) or twin
 * tyre set with rim, hub and wheel nuts on the outer face. `out` = +1 when the
 * outer face points to +z.
 */
function WheelSet({ x, y, z, r, w, out, dual, m }: { x: number; y: number; z: number; r: number; w: number; out: 1 | -1; dual: boolean; m: Mats }) {
  const offsets = dual ? [-(w / 2 + 0.012), w / 2 + 0.012] : [0];
  const outer = (dual ? w + 0.012 : w / 2) * out; // outer face z offset
  const rim = r * 0.54;
  const nuts = Array.from({ length: 10 }, (_, i) => (i / 10) * Math.PI * 2);
  return (
    <group position={[x, y, z]}>
      {offsets.map((o) => (
        <group key={o} position={[0, 0, o]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh geometry={tyreGeometry(r, w)} material={m.rubber} castShadow receiveShadow raycast={noRaycast} />
          <mesh material={m.rim} raycast={noRaycast}>
            <cylinderGeometry args={[rim, rim, w * 0.86, 32]} />
          </mesh>
        </group>
      ))}
      {/* Outer face: dished rim, hub, nuts */}
      <Cyl p={[0, 0, outer - out * 0.03]} r={rim * 0.98} len={0.02} m={m.rim} axis="z" seg={32} />
      <Cyl p={[0, 0, outer]} r={rim * 0.36} len={0.07} m={m.steel} axis="z" />
      <Cyl p={[0, 0, outer + out * 0.04]} r={rim * 0.2} len={0.04} m={m.chrome} axis="z" />
      {nuts.map((a) => (
        <Cyl key={a} p={[Math.cos(a) * rim * 0.47, Math.sin(a) * rim * 0.47, outer]} r={0.016} len={0.05} m={m.chrome} axis="z" seg={6} />
      ))}
    </group>
  );
}

/** Axle: wheel sets on both sides joined by a beam. */
function Axle({ x, y, W, r, w, dual, m }: { x: number; y: number; W: number; r: number; w: number; dual: boolean; m: Mats }) {
  const inset = dual ? w + 0.012 : w / 2; // keep the outer face flush with the body side
  return (
    <group>
      <WheelSet x={x} y={y} z={inset} r={r} w={w} out={-1} dual={dual} m={m} />
      <WheelSet x={x} y={y} z={W - inset} r={r} w={w} out={1} dual={dual} m={m} />
      <Cyl p={[x, y, W / 2]} r={0.07} len={W - 2 * inset} m={m.steel} axis="z" />
      {/* Differential housing on driven axles */}
      {dual && <Round p={[x, y, W / 2]} s={[0.42, 0.38, 0.42]} r={0.12} m={m.steel} />}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Cab

function Cab({ x0, W, g, H, d, m }: { x0: number; W: number; g: number; H: number; d: ReturnType<typeof truckDims>; m: Mats }) {
  const x1 = x0 + CAB_L;
  const cw = Math.min(2.5, W + 0.02);
  const zc = W / 2, z0 = zc - cw / 2, z1 = zc + cw / 2;
  const bot = g + (d.van ? 0.6 : 1.0);
  const top = g + (d.semi ? 3.9 : d.van ? 2.6 : 3.45);
  const h = top - bot;
  const wsH = h * 0.36; // windscreen height
  const wsY = top - 0.16 - wsH / 2;
  const fx = x0 - 0.004; // front face

  // Roof deflector: sweeps from the cab roof up to the trailer roof.
  const deflector = useMemo(() => {
    if (!d.semi || H < top + 0.15) return null;
    const s = new THREE.Shape();
    s.moveTo(x0 + 0.35, top - 0.02);
    s.quadraticCurveTo(x1 - 0.55, top + 0.02, x1 - 0.2, H - 0.03);
    s.lineTo(x1 - 0.02, H - 0.03);
    s.lineTo(x1 - 0.02, top - 0.02);
    s.closePath();
    const depth = cw - 0.24;
    const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 3 });
    geo.translate(0, 0, zc - depth / 2);
    return geo;
  }, [d.semi, H, top, x0, x1, cw, zc]);

  return (
    <group>
      {/* Shell with an accent lower band */}
      <Round p={[(x0 + x1) / 2, (bot + top) / 2, zc]} s={[CAB_L, h, cw]} r={0.14} m={m.paint} />
      <Round p={[(x0 + x1) / 2 + 0.01, bot + h * 0.1, zc]} s={[CAB_L + 0.01, h * 0.2, cw + 0.01]} r={0.08} m={m.accent} />
      {deflector && <mesh geometry={deflector} material={m.paint} castShadow receiveShadow raycast={noRaycast} />}
      {/* Cab-to-trailer side extenders */}
      {d.semi &&
        [z0 + 0.02, z1 - 0.02].map((z) => (
          <Box key={z} p={[x1 + d.cabGap / 2 - 0.02, top - h * 0.42, z]} s={[d.cabGap + 0.04, h * 0.78, 0.03]} m={m.paint} />
        ))}

      {/* Windscreen with black surround, sun visor, wipers */}
      <Round p={[fx + 0.01, wsY, zc]} s={[0.04, wsH + 0.12, cw - 0.12]} r={0.02} m={m.plastic} />
      <Box p={[fx - 0.012, wsY, zc]} s={[0.02, wsH, cw - 0.24]} m={m.glass} />
      <Box p={[x0 - 0.1, top - 0.08, zc]} s={[0.22, 0.05, cw - 0.06]} m={m.plastic} />
      {[zc - 0.55, zc + 0.35].map((z) => (
        <Box key={z} p={[fx - 0.03, wsY - wsH / 2 + 0.08, z]} s={[0.02, 0.025, 0.75]} rot={[0.12, 0, 0]} m={m.plastic} />
      ))}

      {/* Grille with slats */}
      <Box p={[fx - 0.006, bot + h * 0.33, zc]} s={[0.02, h * 0.3, cw * 0.66]} m={m.grille} />
      {Array.from({ length: 5 }, (_, i) => (
        <Box key={i} p={[fx - 0.02, bot + h * 0.21 + i * h * 0.06, zc]} s={[0.015, 0.025, cw * 0.62]} m={m.alu} />
      ))}

      {/* Bumper, headlights, indicators, lower steps */}
      <Round p={[x0 + 0.12, bot - 0.14, zc]} s={[0.36, 0.5, cw + 0.02]} r={0.06} m={m.plastic} />
      {[z0 + 0.36, z1 - 0.36].map((z) => (
        <group key={z}>
          <Round p={[x0 - 0.065, bot + 0.02, z]} s={[0.04, 0.17, 0.46]} r={0.015} m={m.lens} />
          <Box p={[x0 - 0.064, bot + 0.02, z + (z < zc ? -0.29 : 0.29)]} s={[0.04, 0.1, 0.1]} m={m.amber} />
        </group>
      ))}

      {[-1, 1].map((sd) => {
        const zs = sd < 0 ? z0 : z1;
        return (
          <group key={sd}>
            {/* Door glass, door seam and handle */}
            <Box p={[x0 + 0.62, wsY, zs + sd * 0.004]} s={[1.0, wsH * 0.95, 0.02]} m={m.glass} />
            <Box p={[x0 + 1.32, (bot + top) / 2 - 0.1, zs + sd * 0.002]} s={[0.012, h * 0.82, 0.01]} m={m.plastic} shadow={false} />
            <Box p={[x0 + 1.12, bot + h * 0.45, zs + sd * 0.02]} s={[0.2, 0.035, 0.03]} m={m.chrome} />
            {/* Entry steps, behind the steer wheel */}
            {[bot - 0.18, bot - 0.52].map((y) => (
              <Box key={y} p={[x0 + 1.9, y, zs - sd * 0.13]} s={[0.42, 0.04, 0.26]} m={m.alu} />
            ))}
            <Box p={[x0 + 1.9, bot - 0.35, zs - sd * 0.26]} s={[0.48, 0.5, 0.02]} m={m.plastic} />
            {/* Mirror arm and housings */}
            <Cyl p={[x0 + 0.2, top - 0.45, zs + sd * 0.14]} r={0.018} len={0.28} m={m.plastic} axis="z" />
            <Round p={[x0 + 0.2, top - 0.6, zs + sd * 0.3]} s={[0.1, 0.42, 0.2]} r={0.03} m={m.paint} />
            <Round p={[x0 + 0.2, top - 0.96, zs + sd * 0.3]} s={[0.1, 0.2, 0.2]} r={0.03} m={m.paint} />
          </group>
        );
      })}

      {/* Roof marker lights */}
      {[-0.5, 0, 0.5].map((dz) => (
        <Box key={dz} p={[x0 + 0.12, top + 0.03, zc + dz]} s={[0.06, 0.05, 0.14]} m={m.amber} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Cargo box (semi-trailer or rigid body)

function CargoBox({ L, W, H, m, children }: { L: number; W: number; H: number; m: Mats; children?: ReactNode }) {
  const seams = Math.max(1, Math.round(L / 1.25));
  const xs = Array.from({ length: seams - 1 }, (_, i) => (L * (i + 1)) / seams);
  return (
    <group>
      {/* Floor with aluminium sill rails */}
      <Box p={[L / 2, -0.06, W / 2]} s={[L + 2 * WALL, 0.12, W + 2 * WALL]} m={m.wood} />
      {[-WALL - 0.01, W + WALL + 0.01].map((z) => (
        <Box key={z} p={[L / 2, -0.08, z]} s={[L + 2 * WALL, 0.18, 0.05]} m={m.alu} />
      ))}
      {/* Front and far walls: white panels outside, lining and load rails inside */}
      <Box p={[-WALL / 2, H / 2, W / 2]} s={[WALL, H, W]} m={m.panel} />
      <Box p={[L / 2, H / 2, -WALL / 2]} s={[L, H, WALL]} m={m.panel} />
      <Box p={[L / 2, H / 2, 0.002]} s={[L, H, 0.004]} m={m.lining} shadow={false} />
      {[0.42, 0.78].map((f) => (
        <Box key={f} p={[L / 2, H * f, 0.008]} s={[L, 0.09, 0.008]} m={m.alu} shadow={false} />
      ))}
      {xs.map((x) => (
        <group key={x}>
          <Box p={[x, H / 2, -WALL - 0.003]} s={[0.025, H - 0.02, 0.006]} m={m.seam} shadow={false} />
          <Box p={[x, H / 2, 0.006]} s={[0.02, H, 0.006]} m={m.seam} shadow={false} />
        </group>
      ))}
      {/* Near wall and roof cut away */}
      <Box p={[L / 2, H / 2, W + WALL / 2]} s={[L, H, WALL]} m={m.ghost} shadow={false} />
      <Box p={[L / 2, H + WALL / 2, W / 2]} s={[L, WALL, W]} m={m.ghost} shadow={false} />
      {/* Top rails, corner posts, rear header */}
      {[-WALL - 0.01, W + WALL + 0.01].map((z) => (
        <group key={z}>
          <Box p={[L / 2, H + 0.03, z]} s={[L + 2 * WALL, 0.12, 0.06]} m={m.alu} />
          {[-WALL, L + WALL].map((x) => (
            <Box key={x} p={[x, H / 2, z]} s={[0.1, H + 0.18, 0.1]} m={m.alu} />
          ))}
        </group>
      ))}
      <Box p={[L + WALL, H + 0.03, W / 2]} s={[0.1, 0.16, W + 0.12]} m={m.alu} />
      <Box p={[-WALL, H + 0.03, W / 2]} s={[0.1, 0.12, W + 0.12]} m={m.alu} />
      {/* Rear doors folded flat against the sides, with lock rods (near door see-through) */}
      <Box p={[L - W / 4, H / 2, -WALL - 0.07]} s={[W / 2, H, 0.04]} m={m.panel} />
      {[0.25, 0.75].map((f) => (
        <Cyl key={f} p={[L - W / 2 + (W / 2) * f, H / 2, -WALL - 0.105]} r={0.016} len={H - 0.1} m={m.chrome} />
      ))}
      <Box p={[L - W / 4, H / 2, W + WALL + 0.07]} s={[W / 2, H, 0.04]} m={m.ghost} shadow={false} />
      {children}
    </group>
  );
}

/** Rear underride bar with light clusters and plate. */
function RearEnd({ L, W, g, m }: { L: number; W: number; g: number; m: Mats }) {
  const y = g + 0.52;
  return (
    <group>
      <Box p={[L - 0.05, y, W / 2]} s={[0.1, 0.12, W - 0.1]} m={m.steel} />
      {[0.35, W - 0.35].map((z) => (
        <Box key={z} p={[L - 0.25, (y - 0.12) / 2, z]} s={[0.08, -y - 0.12, 0.08]} m={m.steel} />
      ))}
      {[0.28, W - 0.28].map((z) => (
        <group key={z}>
          <Box p={[L + 0.01, y + 0.13, z]} s={[0.06, 0.15, 0.4]} m={m.plastic} />
          <Box p={[L + 0.045, y + 0.13, z + (z < W / 2 ? -0.12 : 0.12)]} s={[0.01, 0.11, 0.13]} m={m.red} />
          <Box p={[L + 0.045, y + 0.13, z]} s={[0.01, 0.11, 0.1]} m={m.amber} />
          <Box p={[L + 0.045, y + 0.13, z + (z < W / 2 ? 0.12 : -0.12)]} s={[0.01, 0.11, 0.1]} m={m.lens} />
        </group>
      ))}
      <Box p={[L + 0.01, y + 0.13, W / 2]} s={[0.02, 0.12, 0.52]} m={m.panel} />
    </group>
  );
}

/** Mudguard over an axle group on both sides, with mud flaps behind it. */
function Mudguards({ xs, W, g, r, w, dual, m }: { xs: number[]; W: number; g: number; r: number; w: number; dual: boolean; m: Mats }) {
  const lo = Math.min(...xs) - r - 0.08, hi = Math.max(...xs) + r + 0.08;
  const width = (dual ? 2 * w : w) + 0.1;
  return (
    <>
      {[width / 2 - 0.03, W - width / 2 + 0.03].map((z) => (
        <group key={z}>
          <Box p={[(lo + hi) / 2, g + 2 * r + 0.07, z]} s={[hi - lo, 0.03, width]} m={m.plastic} />
          <Box p={[hi + 0.02, g + 0.45, z]} s={[0.015, 0.6, width - 0.04]} m={m.rubber} />
        </group>
      ))}
    </>
  );
}

/** Side underrun guard rails between two x positions. */
function SideGuards({ x0, x1, W, g, m }: { x0: number; x1: number; W: number; g: number; m: Mats }) {
  if (x1 - x0 < 0.6) return null;
  const n = Math.max(2, Math.round((x1 - x0) / 1.8) + 1);
  const posts = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1));
  return (
    <>
      {[-0.005, W + 0.005].map((z) => (
        <group key={z}>
          {[0.4, 0.72].map((h) => (
            <Box key={h} p={[(x0 + x1) / 2, g + h, z]} s={[x1 - x0, 0.09, 0.03]} m={m.alu} />
          ))}
          {posts.map((x) => (
            <Box key={x} p={[x, (g + 0.35) / 2 - 0.06, z + (z < 0 ? 0.05 : -0.05)]} s={[0.05, -g - 0.47, 0.05]} m={m.steel} />
          ))}
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

export function TruckModel({ L, W, H }: { L: number; W: number; H: number }) {
  const m = useMaterials();
  const d = truckDims(L);
  const g = -d.floorH;
  const r = d.wheelR, w = d.tyreW;
  const wy = g + r;
  const cabX0 = -d.cabGap - CAB_L;
  const frontAxle = cabX0 + 1.05;

  // Rear axles (behind the load) and, for a tractor, its drive axle under the trailer nose.
  const rear = d.semi
    ? [L - 1.9, L - 3.21, L - 4.52]
    : d.van
      ? [L - Math.max(0.9, L * 0.25)]
      : [L - Math.max(1.3, L * 0.27), L - Math.max(1.3, L * 0.27) - 1.35].filter((x, i) => i === 0 || L >= 7);
  const drive = d.semi ? frontAxle + 3.7 : null;
  const firstRear = Math.min(...rear);

  // Tractor / rigid chassis rails (semi-trailer has its own beams under the box).
  const railTop = d.semi ? g + 1.0 : -0.12;
  const railX1 = d.semi ? drive! + 0.9 : L - 0.3;
  const tankX0 = frontAxle + r + 0.65; // clear of the cab steps
  const tankX1 = (d.semi ? drive! : firstRear) - r - 0.35;

  return (
    <group>
      <Cab x0={cabX0} W={W} g={g} H={H} d={d} m={m} />

      {/* Chassis rails */}
      {[W / 2 - 0.43, W / 2 + 0.43].map((z) => (
        <Box key={z} p={[(cabX0 + 0.3 + railX1) / 2, railTop - 0.14, z]} s={[railX1 - cabX0 - 0.3, 0.28, 0.07]} m={m.steel} />
      ))}
      {/* Fuel tank (near side) and battery box (far side) */}
      {tankX1 - tankX0 > 0.8 && (
        <>
          <Cyl p={[(tankX0 + tankX1) / 2, g + 0.68, W - 0.42]} r={0.3} len={tankX1 - tankX0} m={m.alu} axis="x" seg={32} />
          {[tankX0 + 0.2, tankX1 - 0.2].map((x) => (
            <Cyl key={x} p={[x, g + 0.68, W - 0.42]} r={0.305} len={0.04} m={m.steel} axis="x" seg={32} />
          ))}
          <Round p={[(tankX0 + tankX1) / 2, g + 0.72, 0.4]} s={[Math.min(1.0, tankX1 - tankX0), 0.5, 0.42]} r={0.03} m={m.plastic} />
        </>
      )}

      {/* Steer axle under the cab */}
      <Axle x={frontAxle} y={wy} W={W} r={r} w={w} dual={false} m={m} />

      {d.semi && (
        <>
          {/* Tractor drive axle, rear fenders, fifth wheel */}
          <Axle x={drive!} y={wy} W={W} r={r} w={w * 0.82} dual m={m} />
          <Mudguards xs={[drive!]} W={W} g={g} r={r} w={w * 0.82} dual m={m} />
          <Box p={[drive! - 0.3, -0.2, W / 2]} s={[0.95, 0.12, 0.95]} m={m.steel} />
          {/* Trailer main beams and landing gear */}
          {[W / 2 - 0.5, W / 2 + 0.5].map((z) => (
            <Box key={z} p={[L / 2 + 0.1, -0.32, z]} s={[L - 0.4, 0.4, 0.08]} m={m.steel} />
          ))}
          {[W / 2 - 0.55, W / 2 + 0.55].map((z) => (
            <group key={z}>
              <Box p={[3.2, (g + 0.27 - 0.12) / 2, z]} s={[0.12, -0.12 - g - 0.27, 0.12]} m={m.steel} />
              <Box p={[3.2, g + 0.25, z]} s={[0.28, 0.05, 0.28]} m={m.steel} />
            </group>
          ))}
          <SideGuards x0={3.6} x1={firstRear - r - 0.35} W={W} g={g} m={m} />
        </>
      )}
      {!d.semi && <SideGuards x0={tankX1 + 0.3} x1={firstRear - r - 0.35} W={W} g={g} m={m} />}

      {/* Rear axle group */}
      {rear.map((x) => (
        <Axle key={x} x={x} y={wy} W={W} r={r} w={w} dual={!d.semi} m={m} />
      ))}
      <Mudguards xs={rear} W={W} g={g} r={r} w={w} dual={!d.semi} m={m} />

      <CargoBox L={L} W={W} H={H} m={m} />
      <RearEnd L={L} W={W} g={g} m={m} />
    </group>
  );
}
