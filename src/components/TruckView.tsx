"use client";

import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { Placement, Truck, TruckPlan } from "@/lib/trucks";

interface Props {
  truck: Truck;
  plan: TruckPlan;
  placements: Placement[];
  colorOf: (loadId: string) => string;
  onHover: (loadId: string | null) => void;
}

/** 3D view of a truck with every carton in its planned position (near side and roof cut away). */
export default function TruckView({ truck, plan, placements, colorOf, onHover }: Props) {
  const L = truck.length / 100, W = truck.width / 100, H = truck.height / 100;
  const dims = truckDims(L);
  const span = Math.max(L + dims.cabGap + CAB_L, W * 2, 6);
  return (
    <Canvas
      key={truck.id}
      shadows
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.05, far: 500, position: [span * 0.2, span * 0.55, span * 1.0] }}
    >
      <color attach="background" args={["#0f172a"]} />
      <fog attach="fog" args={["#0f172a", span * 2, span * 5]} />
      <hemisphereLight args={["#e2e8f0", "#334155", 1.1]} />
      <directionalLight
        position={[span * 0.3, span * 1.2, span * 0.6]}
        intensity={2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
      />
      <OrbitControls makeDefault target={[-(dims.cabGap + CAB_L) / 2, H / 3, 0]} maxPolarAngle={Math.PI / 2 - 0.05} />
      {/* Truck frame: cargo floor at y = 0, cargo box x ∈ [0, L] (cab at x < 0), z ∈ [0, W] */}
      <group position={[-L / 2, 0, -W / 2]}>
        <TruckModel L={L} W={W} H={H} />
        <Cartons placements={placements} colorOf={colorOf} onHover={onHover} />
        {plan.usedLength > 0 && (
          <mesh position={[Math.min(plan.usedLength, L), 0.004, W / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.03, W]} />
            <meshBasicMaterial color={plan.usedLength > L ? "#f43f5e" : "#facc15"} />
          </mesh>
        )}
      </group>
    </Canvas>
  );
}

const CAB_L = 2.3; // cab length, m
const WALL = 0.05; // cargo box wall thickness
const noRaycast = () => null;

/** Proportions by vehicle class: semi-trailer (tractor + trailer), rigid truck or van. */
function truckDims(L: number) {
  const semi = L >= 10, van = L < 5;
  return {
    semi,
    floorH: van ? 0.75 : 1.2, // ground to cargo floor
    wheelR: van ? 0.34 : 0.5,
    cabGap: semi ? 0.9 : 0.15, // cab back to cargo box front
    cabH: van ? 1.9 : 2.25, // cab body height above its floor
    rearAxles: semi ? 3 : van ? 1 : 2,
  };
}

type V3 = [number, number, number];

function Part({
  p,
  s,
  color,
  metal = 0.2,
  rough = 0.55,
  opacity = 1,
  rot,
}: {
  p: V3;
  s: V3;
  color: string;
  metal?: number;
  rough?: number;
  opacity?: number;
  rot?: V3;
}) {
  const glass = opacity < 1;
  return (
    <mesh position={p} rotation={rot} castShadow={!glass} receiveShadow raycast={noRaycast}>
      <boxGeometry args={s} />
      <meshStandardMaterial
        color={color}
        metalness={metal}
        roughness={rough}
        transparent={glass}
        opacity={opacity}
        depthWrite={!glass}
        side={glass ? THREE.DoubleSide : THREE.FrontSide}
      />
    </mesh>
  );
}

function Wheel({ x, z, r, y }: { x: number; z: number; r: number; y: number }) {
  return (
    <group position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]}>
      <mesh castShadow raycast={noRaycast}>
        <cylinderGeometry args={[r, r, 0.32, 24]} />
        <meshStandardMaterial color="#111827" roughness={0.95} />
      </mesh>
      <mesh raycast={noRaycast}>
        <cylinderGeometry args={[r * 0.55, r * 0.55, 0.34, 16]} />
        <meshStandardMaterial color="#9ca3af" metalness={0.7} roughness={0.35} />
      </mesh>
    </group>
  );
}

function TruckModel({ L, W, H }: { L: number; W: number; H: number }) {
  const d = truckDims(L);
  const g = -d.floorH; // ground level
  const body = "#f1f5f9", trim = "#cbd5e1", paint = "#2563eb", dark = "#1f2937";
  const wy = g + d.wheelR;
  const wheelZ = [0.2, W - 0.2];

  // Rear axles near the back of the cargo box; tractor drive axles under the trailer nose.
  const rear = Array.from({ length: d.rearAxles }, (_, i) => L - (d.semi ? 1.5 : Math.min(L * 0.28, 2)) - i * 1.35);
  const cabX1 = -d.cabGap, cabX0 = cabX1 - CAB_L;
  const front = cabX0 + 0.85;
  const drive = d.semi ? [0.4, 1.75] : [];
  const cabY0 = g + d.wheelR * 1.7; // cab floor
  const cabTop = cabY0 + d.cabH;

  // Aluminium frame rails around the cargo box edges.
  const r = 0.07;
  const rails: { p: V3; s: V3 }[] = [];
  for (const y of [-r / 2, H + r / 2])
    for (const z of [-WALL, W + WALL]) rails.push({ p: [L / 2, y, z], s: [L + 2 * WALL, r, r] });
  for (const x of [-WALL, L + WALL])
    for (const z of [-WALL, W + WALL]) rails.push({ p: [x, H / 2, z], s: [r, H + r, r] });
  for (const y of [-r / 2, H + r / 2]) rails.push({ p: [L + WALL, y, W / 2], s: [r, r, W + 2 * WALL] });
  // Vertical ribs along the far wall.
  const ribs = Math.max(1, Math.round(L / 1.2));
  for (let i = 1; i < ribs; i++) rails.push({ p: [(L * i) / ribs, H / 2, -WALL - 0.02], s: [0.04, H, 0.03] });

  return (
    <group>
      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[L / 2 - 1.5, g, W / 2]} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[L * 4 + 40, L * 4 + 40]} />
        <meshStandardMaterial color="#1e293b" roughness={1} />
      </mesh>

      {/* Cargo box: floor, solid front and far walls, see-through near wall and roof */}
      <Part p={[L / 2, -0.06, W / 2]} s={[L + 2 * WALL, 0.12, W + 2 * WALL]} color="#8b6b4a" rough={0.9} metal={0} />
      <Part p={[-WALL / 2, H / 2, W / 2]} s={[WALL, H, W]} color={body} />
      <Part p={[L / 2, H / 2, -WALL / 2]} s={[L, H, WALL]} color={body} />
      <Part p={[L / 2, H / 2, W + WALL / 2]} s={[L, H, WALL]} color="#e2e8f0" opacity={0.08} />
      <Part p={[L / 2, H + WALL / 2, W / 2]} s={[L, WALL, W]} color="#e2e8f0" opacity={0.06} />
      {/* Livery stripe on the far wall */}
      <Part p={[L / 2, H * 0.35, -WALL - 0.005]} s={[L - 0.4, 0.25, 0.01]} color={paint} />
      {rails.map((x, i) => (
        <Part key={i} p={x.p} s={x.s} color={trim} metal={0.6} rough={0.35} />
      ))}
      {/* Rear doors swung open against the sides */}
      {[-1, 1].map((side) => (
        <Part
          key={side}
          p={[L + WALL + 0.03, H / 2, side < 0 ? -WALL - W / 4 : W + WALL + W / 4]}
          s={[0.04, H, W / 2]}
          color={body}
        />
      ))}
      {/* Rear lights and underride bar */}
      {wheelZ.map((z) => (
        <Part key={z} p={[L + WALL + 0.02, -0.3, z]} s={[0.04, 0.12, 0.3]} color="#ef4444" metal={0.1} />
      ))}
      <Part p={[L - 0.1, g + 0.45, W / 2]} s={[0.12, 0.12, W - 0.2]} color={dark} />

      {/* Chassis */}
      <Part
        p={[(cabX0 + 0.3 + L - 0.3) / 2, -0.12 - 0.15, W / 2]}
        s={[L - 0.6 - cabX0 - 0.3, 0.3, Math.min(1.0, W * 0.45)]}
        color={dark}
        metal={0.4}
      />
      {[...rear, ...drive, front].map((x) => wheelZ.map((z) => <Wheel key={`${x}:${z}`} x={x} z={z} r={d.wheelR} y={wy} />))}
      {/* Mudguards over the rear axle group */}
      {wheelZ.map((z) => (
        <Part
          key={z}
          p={[(rear[0] + rear[rear.length - 1]) / 2, -0.15, z]}
          s={[Math.abs(rear[0] - rear[rear.length - 1]) + d.wheelR * 2.2, 0.04, 0.4]}
          color={dark}
        />
      ))}

      {/* Cab */}
      <group>
        <Part p={[(cabX0 + cabX1) / 2, (cabY0 + cabTop) / 2, W / 2]} s={[CAB_L, d.cabH, W]} color={paint} metal={0.35} rough={0.4} />
        {/* Roof fairing up to the cargo box */}
        {H > cabTop + 0.2 && (
          <Part
            p={[(cabX0 + cabX1) / 2 + 0.2, (cabTop + H) / 2, W / 2]}
            s={[CAB_L - 0.4, H - cabTop, W - 0.1]}
            color={paint}
            metal={0.35}
            rough={0.4}
          />
        )}
        {/* Windscreen, side windows */}
        <Part p={[cabX0 - 0.01, cabTop - d.cabH * 0.28, W / 2]} s={[0.03, d.cabH * 0.42, W - 0.25]} color="#0f172a" metal={0.9} rough={0.1} />
        {[-0.01, W + 0.01].map((z) => (
          <Part key={z} p={[cabX0 + 0.55, cabTop - d.cabH * 0.28, z]} s={[0.8, d.cabH * 0.38, 0.03]} color="#0f172a" metal={0.9} rough={0.1} />
        ))}
        {/* Grille, headlights, bumper */}
        <Part p={[cabX0 - 0.02, cabY0 + d.cabH * 0.28, W / 2]} s={[0.03, d.cabH * 0.32, W * 0.5]} color="#374151" metal={0.6} />
        {[0.3, W - 0.3].map((z) => (
          <Part key={z} p={[cabX0 - 0.02, cabY0 + 0.2, z]} s={[0.04, 0.16, 0.35]} color="#fef9c3" metal={0.2} rough={0.2} />
        ))}
        <Part p={[cabX0 - 0.08, cabY0 - 0.15, W / 2]} s={[0.18, 0.3, W + 0.05]} color={dark} metal={0.5} />
        {/* Mirrors */}
        {[-0.25, W + 0.25].map((z) => (
          <Part key={z} p={[cabX0 + 0.15, cabTop - 0.45, z]} s={[0.06, 0.45, 0.14]} color={dark} />
        ))}
        {/* Steps */}
        {[-0.03, W + 0.03].map((z) => (
          <Part key={z} p={[cabX0 + 1.3, cabY0 - 0.25, z]} s={[0.5, 0.06, 0.12]} color="#9ca3af" metal={0.7} />
        ))}
      </group>
    </group>
  );
}

const GAP = 0.006; // visual seam between cartons, m

function Cartons({
  placements,
  colorOf,
  onHover,
}: {
  placements: Placement[];
  colorOf: (loadId: string) => string;
  onHover: (loadId: string | null) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    placements.forEach((p, i) => {
      o.position.set(p.x + p.dx / 2, p.y + p.dy / 2, p.z + p.dz / 2);
      o.scale.set(p.dx - GAP, p.dy - GAP, p.dz - GAP);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      c.set(colorOf(p.loadId));
      c.offsetHSL(0, 0, (((i * 7) % 5) - 2) * 0.02); // slight shade variation per carton
      mesh.setColorAt(i, c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements, colorOf]);
  if (!placements.length) return null;
  return (
    <instancedMesh
      key={placements.length}
      ref={ref}
      args={[undefined, undefined, placements.length]}
      castShadow
      receiveShadow
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined) onHover(placements[e.instanceId].loadId);
      }}
      onPointerOut={() => onHover(null)}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.8} />
    </instancedMesh>
  );
}
