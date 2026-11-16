"use client";

import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Sky } from "@react-three/drei";
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
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.05, far: 500, position: [span * 0.15, span * 0.7, span * 1.5] }}
    >
      {/* Same daytime sky as the warehouse view */}
      <color attach="background" args={["#c9dceb"]} />
      <Sky distance={4500} sunPosition={SUN} turbidity={5} rayleigh={1.2} mieCoefficient={0.004} mieDirectionalG={0.8} />
      <fog attach="fog" args={["#c9dceb", 60, 400]} />
      <hemisphereLight args={["#dbeafe", "#4a6b33", 1.1]} />
      <directionalLight
        position={[SUN[0] * span * 2, SUN[1] * span * 2, SUN[2] * span * 2]}
        intensity={2.4}
        color="#fff4e0"
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

const SUN: V3 = [-0.45, 0.8, 0.4]; // toward the sun, lighting the near side
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

const DOCK_GAP = 0.35; // truck rear to dock wall

/**
 * The loading bay the truck is backed up to: warehouse wall with the dock door
 * behind its rear doors, closed neighbouring doors, painted truck court,
 * concrete apron and grass beyond. Truck frame: dock wall at x ≈ L, ground at y = g.
 */
function Yard({ L, W, H, g }: { L: number; W: number; H: number; g: number }) {
  const wx = L + WALL + DOCK_GAP; // dock wall outer face
  const wallH = g + 11; // top of the wall
  const wallZ0 = W / 2 - 30, wallZ1 = W / 2 + 30;
  const doorH = Math.max(H, 2.8) + 0.2;
  const pitch = Math.max(W + 2.2, 4.5); // spacing between dock doors
  const doors = [-2, -1, 1, 2].map((k) => W / 2 + k * pitch);
  const court = { x0: wx - 60, x1: wx, z0: wallZ0, z1: wallZ1 };
  return (
    <group>
      {/* Grass */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx, g - 0.03, W / 2]} receiveShadow raycast={noRaycast}>
        <circleGeometry args={[500, 48]} />
        <meshStandardMaterial color="#56783a" roughness={1} />
      </mesh>
      {/* Asphalt truck court */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(court.x0 + court.x1) / 2, g - 0.01, (court.z0 + court.z1) / 2]}
        receiveShadow
        raycast={noRaycast}
      >
        <planeGeometry args={[court.x1 - court.x0, court.z1 - court.z0]} />
        <meshStandardMaterial color="#3f4448" roughness={1} />
      </mesh>
      {/* Concrete apron in front of the docks */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx - 9, g, W / 2]} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[18, wallZ1 - wallZ0]} />
        <meshStandardMaterial color="#6b7075" roughness={1} />
      </mesh>
      {/* Yellow stall lines between the bays */}
      {[...doors, W / 2].flatMap((zc) => [zc - pitch / 2, zc + pitch / 2]).map((z, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[wx - 9, g + 0.005, z]} raycast={noRaycast}>
          <planeGeometry args={[17.5, 0.15]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      ))}

      {/* Warehouse wall, with the building's floor at dock height behind it */}
      <Part p={[wx + 0.15, (g + wallH) / 2, W / 2]} s={[0.3, wallH - g, wallZ1 - wallZ0]} color="#d6d3d1" rough={0.8} metal={0.1} />
      <Part p={[wx + 0.16, wallH - 0.4, W / 2]} s={[0.32, 0.5, wallZ1 - wallZ0]} color="#2563eb" metal={0.3} />
      {/* Open dock door: dark interior, shelter pads and bumpers */}
      <Part p={[wx - 0.005, doorH / 2 - 0.1, W / 2]} s={[0.02, doorH, W + 0.2]} color="#1c1917" rough={1} metal={0} />
      {[-1, 1].map((sd) => (
        <Part
          key={sd}
          p={[wx - 0.15, doorH / 2, W / 2 + sd * (W / 2 + 0.25)]}
          s={[0.3, doorH + 0.3, 0.3]}
          color="#111827"
          rough={1}
          metal={0}
        />
      ))}
      <Part p={[wx - 0.15, doorH + 0.15, W / 2]} s={[0.3, 0.4, W + 0.8]} color="#111827" rough={1} metal={0} />
      {[0.3, W - 0.3].map((z) => (
        <Part key={z} p={[wx - 0.08, -0.25, z]} s={[0.16, 0.35, 0.3]} color="#111827" rough={1} metal={0} />
      ))}
      {/* Dock leveller bridging the gap to the truck floor */}
      <Part p={[wx - DOCK_GAP / 2 - 0.02, -0.03, W / 2]} s={[DOCK_GAP + 0.1, 0.05, W - 0.2]} color="#9ca3af" metal={0.7} />
      {/* Neighbouring bays: closed roller shutters with their own pads */}
      {doors.map((z) => (
        <group key={z}>
          <Part p={[wx - 0.02, doorH / 2 - 0.1, z]} s={[0.04, doorH, W + 0.2]} color="#94a3b8" metal={0.5} rough={0.4} />
          {[-1, 1].map((sd) => (
            <Part key={sd} p={[wx - 0.15, doorH / 2, z + sd * (W / 2 + 0.25)]} s={[0.3, doorH + 0.3, 0.3]} color="#111827" rough={1} metal={0} />
          ))}
        </group>
      ))}
      {/* Building plinth below dock level */}
      <Part p={[wx - 0.2, (g - 0.1) / 2, W / 2]} s={[0.4, -g - 0.1, wallZ1 - wallZ0]} color="#a8a29e" rough={0.9} metal={0} />
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
      <Yard L={L} W={W} H={H} g={g} />

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
      {/* Rear doors folded back flat against the sides (the near one see-through like its wall) */}
      <Part p={[L - W / 4, H / 2, -WALL - 0.05]} s={[W / 2, H, 0.04]} color={body} />
      <Part p={[L - W / 4, H / 2, W + WALL + 0.05]} s={[W / 2, H, 0.04]} color="#e2e8f0" opacity={0.1} />
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
