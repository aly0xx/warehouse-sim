"use client";

import { Canvas, ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, OrbitControls, Sky } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Placement, Truck, TruckPlan } from "@/lib/trucks";
import { CAB_L, TruckModel, WALL, truckDims } from "./TruckModel";

interface Props {
  truck: Truck;
  plan: TruckPlan;
  placements: Placement[];
  colorOf: (loadId: string) => string;
  onHover: (loadId: string | null) => void;
}

type V3 = [number, number, number];
const SUN: V3 = [-0.45, 0.8, 0.4]; // toward the sun, lighting the near side
const noRaycast = () => null;

/** 3D view of a truck at a loading dock with every carton in its planned position (near side and roof cut away). */
export default function TruckView({ truck, plan, placements, colorOf, onHover }: Props) {
  const L = truck.length / 100, W = truck.width / 100, H = truck.height / 100;
  const dims = truckDims(L);
  const g = -dims.floorH;
  const span = Math.max(L + dims.cabGap + CAB_L, W * 2, 6);
  return (
    <Canvas
      key={truck.id}
      shadows="percentage"
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 40, near: 0.05, far: 600, position: [span * 0.15, span * 0.55, span * 1.5] }}
    >
      {/* Same daytime sky as the warehouse view */}
      <color attach="background" args={["#c9dceb"]} />
      <Sky distance={4500} sunPosition={SUN} turbidity={5} rayleigh={1.2} mieCoefficient={0.004} mieDirectionalG={0.8} />
      <fog attach="fog" args={["#c9dceb", 80, 450]} />
      {/* Soft studio-style reflections for paint, glass and chrome (generated, no downloads) */}
      <Environment resolution={256} frames={1} environmentIntensity={0.45}>
        <Lightformer form="rect" intensity={2} position={[0, 12, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[40, 40, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#dbeafe" position={[0, 4, 20]} scale={[60, 6, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#fff4e0" position={[-20, 5, 0]} rotation={[0, Math.PI / 2, 0]} scale={[40, 8, 1]} />
        <Lightformer form="rect" intensity={0.3} color="#5b6b4a" position={[0, -2, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[60, 60, 1]} />
      </Environment>
      <hemisphereLight args={["#dbeafe", "#4a6b33", 0.4]} />
      <directionalLight
        position={[SUN[0] * span * 2, SUN[1] * span * 2, SUN[2] * span * 2]}
        intensity={1.9}
        color="#fff4e0"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.02}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-far={span * 6}
      />
      <OrbitControls
        makeDefault
        target={[-(dims.cabGap + CAB_L) / 2, H / 3, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={2}
        maxDistance={span * 4}
      />
      {/* Truck frame: cargo floor at y = 0, cargo box x ∈ [0, L] (cab at x < 0), z ∈ [0, W] */}
      <group position={[-L / 2, 0, -W / 2]}>
        <Yard L={L} W={W} H={H} g={g} />
        <ContactShadows
          position={[(L - dims.cabGap - CAB_L) / 2, g + 0.004, W / 2]}
          scale={[L + dims.cabGap + CAB_L + 3, W + 2.5]}
          resolution={512}
          blur={2.2}
          far={2.5}
          opacity={0.6}
          frames={1}
        />
        <TruckModel L={L} W={W} H={H} />
        <Cartons placements={placements} colorOf={colorOf} onHover={onHover} />
        {plan.usedLength > 0 && (
          <mesh position={[Math.min(plan.usedLength, L), 0.004, W / 2]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
            <planeGeometry args={[0.03, W]} />
            <meshBasicMaterial color={plan.usedLength > L ? "#f43f5e" : "#facc15"} />
          </mesh>
        )}
      </group>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Yard surfaces: small procedural canvas textures, tiled.

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Surface = "asphalt" | "concrete" | "grass" | "cladding";

function makeTexture(kind: Surface) {
  const N = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d")!;
  const rand = mulberry32(kind.length * 977);
  const base = { asphalt: "#35383c", concrete: "#7b7e81", grass: "#56783a", cladding: "#d3d6d9" }[kind];
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, N, N);
  if (kind === "cladding") {
    // Trapezoidal sheet profile: a shaded rib every 64 px.
    for (let x = 0; x < N; x += 64) {
      const grad = ctx.createLinearGradient(x, 0, x + 24, 0);
      grad.addColorStop(0, "rgba(0,0,0,0.18)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.25)");
      grad.addColorStop(1, "rgba(0,0,0,0.12)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, 24, N);
    }
  } else {
    const blotches = kind === "grass" ? 900 : 300;
    for (let i = 0; i < blotches; i++) {
      ctx.fillStyle =
        kind === "grass"
          ? rand() < 0.5 ? "rgba(70,105,45,0.35)" : "rgba(125,150,75,0.25)"
          : rand() < 0.5 ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.arc(rand() * N, rand() * N, 4 + rand() * 30, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fine aggregate speckle.
    const img = ctx.getImageData(0, 0, N, N);
    const amp = kind === "asphalt" ? 34 : kind === "concrete" ? 16 : 22;
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rand() - 0.5) * amp;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    if (kind === "concrete") {
      // Saw-cut joints on the tile edges.
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, N, 3);
      ctx.fillRect(0, 0, 3, N);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** A tiled surface material; `tile` = metres per texture repeat. */
function useSurface(kind: Surface, w: number, h: number, tile: number, roughness = 1) {
  const mat = useMemo(() => {
    const map = makeTexture(kind);
    map.repeat.set(w / tile, h / tile);
    return new THREE.MeshStandardMaterial({ map, roughness, metalness: kind === "cladding" ? 0.3 : 0 });
  }, [kind, w, h, tile, roughness]);
  useEffect(() => () => {
    mat.map?.dispose();
    mat.dispose();
  }, [mat]);
  return mat;
}

function Flat({ p, w, h, m }: { p: V3; w: number; h: number; m: THREE.Material }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={p} material={m} receiveShadow raycast={noRaycast}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}

function Block({ p, s, color, rough = 0.8, metal = 0.1 }: { p: V3; s: V3; color: string; rough?: number; metal?: number }) {
  return (
    <mesh position={p} castShadow receiveShadow raycast={noRaycast}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} roughness={rough} metalness={metal} />
    </mesh>
  );
}

const DOCK_GAP = 0.35; // truck rear to dock wall

/**
 * The loading bay the truck is backed up to: clad warehouse wall with the
 * open dock door behind its rear doors, closed neighbouring bays, asphalt
 * court, concrete apron and grass beyond. Truck frame: dock wall at x ≈ L,
 * ground at y = g.
 */
function Yard({ L, W, H, g }: { L: number; W: number; H: number; g: number }) {
  const wx = L + WALL + DOCK_GAP; // dock wall outer face
  const wallLen = 60, wallH = 11 - g;
  const doorH = Math.max(H, 2.8) + 0.2;
  const pitch = Math.max(W + 2.2, 4.5); // spacing between dock doors
  const doors = [-2, -1, 1, 2].map((k) => W / 2 + k * pitch);
  const courtLen = 60;

  const grass = useSurface("grass", 600, 600, 12);
  const asphalt = useSurface("asphalt", courtLen, wallLen, 5);
  const concrete = useSurface("concrete", 18, wallLen, 4.5);
  const cladding = useSurface("cladding", wallLen, wallH, 2.4, 0.55);

  return (
    <group>
      <Flat p={[wx, g - 0.03, W / 2]} w={600} h={600} m={grass} />
      <Flat p={[wx - courtLen / 2, g - 0.01, W / 2]} w={courtLen} h={wallLen} m={asphalt} />
      <Flat p={[wx - 9, g, W / 2]} w={18} h={wallLen} m={concrete} />
      {/* Yellow bay lines */}
      {[...doors, W / 2].flatMap((zc) => [zc - pitch / 2, zc + pitch / 2]).map((z, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[wx - 9, g + 0.003, z]} raycast={noRaycast}>
          <planeGeometry args={[17.5, 0.14]} />
          <meshStandardMaterial color="#e3b82a" roughness={0.8} />
        </mesh>
      ))}

      {/* Clad wall with a fascia band and a concrete plinth up to dock height */}
      <mesh position={[wx + 0.15, g + wallH / 2, W / 2]} rotation={[0, -Math.PI / 2, 0]} material={cladding} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[wallLen, wallH]} />
      </mesh>
      <Block p={[wx + 0.3, g + wallH / 2, W / 2]} s={[0.3, wallH, wallLen]} color="#c9ccd0" />
      <Block p={[wx + 0.1, g + wallH - 0.4, W / 2]} s={[0.12, 0.6, wallLen]} color="#2b3a4d" metal={0.4} rough={0.4} />
      <Block p={[wx - 0.02, (g - 0.12) / 2, W / 2]} s={[0.3, -g - 0.12, wallLen]} color="#9a9a96" rough={0.95} metal={0} />

      {/* Open dock: dark interior, shelter pads with a header, bumpers, leveller */}
      <Block p={[wx + 0.12, doorH / 2 - 0.1, W / 2]} s={[0.02, doorH, W + 0.2]} color="#141414" rough={1} metal={0} />
      {[-1, 1].map((sd) => (
        <Block key={sd} p={[wx - 0.2, doorH / 2, W / 2 + sd * (W / 2 + 0.28)]} s={[0.4, doorH + 0.4, 0.36]} color="#1a1c1f" rough={0.95} metal={0} />
      ))}
      <Block p={[wx - 0.2, doorH + 0.25, W / 2]} s={[0.4, 0.5, W + 0.92]} color="#1a1c1f" rough={0.95} metal={0} />
      <Block p={[wx - 0.05, doorH + 0.55, W / 2]} s={[0.1, 0.1, W + 0.92]} color="#e3b82a" rough={0.7} metal={0} />
      {[0.3, W - 0.3].map((z) => (
        <Block key={z} p={[wx - 0.1, -0.28, z]} s={[0.2, 0.4, 0.32]} color="#141414" rough={1} metal={0} />
      ))}
      <Block p={[wx - DOCK_GAP / 2 - 0.02, -0.025, W / 2]} s={[DOCK_GAP + 0.12, 0.05, W - 0.2]} color="#8d939a" rough={0.5} metal={0.7} />

      {/* Neighbouring bays: closed sectional doors with their own pads */}
      {doors.map((z) => (
        <group key={z}>
          <Block p={[wx + 0.1, doorH / 2 - 0.1, z]} s={[0.04, doorH, W + 0.2]} color="#a9b1ba" rough={0.45} metal={0.5} />
          {Array.from({ length: 5 }, (_, i) => (
            <Block key={i} p={[wx + 0.07, -0.1 + ((i + 1) * doorH) / 6, z]} s={[0.02, 0.025, W + 0.2]} color="#7d858e" />
          ))}
          {[-1, 1].map((sd) => (
            <Block key={sd} p={[wx - 0.2, doorH / 2, z + sd * (W / 2 + 0.28)]} s={[0.4, doorH + 0.4, 0.36]} color="#1a1c1f" rough={0.95} metal={0} />
          ))}
          <Block p={[wx - 0.2, doorH + 0.25, z]} s={[0.4, 0.5, W + 0.92]} color="#1a1c1f" rough={0.95} metal={0} />
          {[0.3, W - 0.3].map((dz) => (
            <Block key={dz} p={[wx - 0.1, -0.28, z - W / 2 + dz]} s={[0.2, 0.4, 0.32]} color="#141414" rough={1} metal={0} />
          ))}
        </group>
      ))}
    </group>
  );
}

const GAP = 0.006; // visual seam between cartons, m
const KRAFT = new THREE.Color("#b88a5a");

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
      // Cardboard tinted toward the customer's colour, with slight per-carton variation.
      c.set(colorOf(p.loadId)).lerp(KRAFT, 0.6);
      c.offsetHSL(0, 0, (((i * 7) % 5) - 2) * 0.015);
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
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}
