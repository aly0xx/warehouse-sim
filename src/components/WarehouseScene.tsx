"use client";

import { Canvas, ThreeElements, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sky } from "@react-three/drei";
import World from "./World";
import Asrs, { FlowStats, FlowView } from "./Asrs";
import { ScanLayer, ScanPanel, useScan } from "./ScanOverlay";
import ScanCartons, { CartonPallet, GroundOutlines, useEuroPallet } from "./ScanCartons";
import { ScanFit, ScanSlot, scanToSite } from "@/lib/scan";
import { ComponentRef, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Customer,
  Dock,
  Layout,
  PALLET_DECK_H,
  Product,
  Stacks,
  WarehouseConfig,
  BEAM_HEIGHT,
  RACK_START,
  colName,
  frameToWorld,
  levelY,
  SlotContent,
  palletContents,
  rowName,
  slotLabel,
} from "@/lib/warehouse";

// Unit vector toward the sun (mid-afternoon, high in the south-west).
const SUN: [number, number, number] = [0.45, 0.8, 0.4];

export interface HoverInfo {
  customerId: string;
  slot: string;
  boxes: number; // cartons on the hovered pallet
}

interface Props {
  config: WarehouseConfig;
  layout: Layout;
  stacks: Stacks;
  customers: Customer[];
  products: Product[];
  warehouseId: string;
  transition: "animate" | "snap";
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (h: HoverInfo | null) => void;
  onScanRoom?: (pallets: number | null) => void; // pallets the open scan can hold; null without a scan
}

export default function WarehouseScene(props: Props) {
  const { config, layout, selectedId, onSelect } = props;
  // Everything inside the building is laid out in the site frame (dock wall at
  // z = 0); `fc` is the config with the frame's width/length.
  const fc = useMemo(
    () => ({ ...config, width: layout.frame.width, length: layout.frame.length }),
    [config, layout.frame.width, layout.frame.length],
  );
  const frameProps = { ...props, config: fc };

  // In-flight pallets (from the AS/RS flow simulation) and its playback controls.
  const [flowView, setFlowView] = useState<FlowView | null>(null);
  const [stats, setStats] = useState<FlowStats>({ inbound: 0, outbound: 0 });
  const [speed, setSpeed] = useState(1);
  const [finish, setFinish] = useState(0);
  const scanPallet = useMemo(
    () => ({ width: config.palletWidth, depth: config.palletDepth, height: config.palletHeight }),
    [config.palletWidth, config.palletDepth, config.palletHeight],
  );
  const scan = useScan(props.warehouseId, scanPallet);
  // Over a scan, pallets sit on the open floor found in it, not in the simulated racks.
  const scanSlots = scan.showing ? (scan.fit?.slots ?? []) : null;
  const { onScanRoom } = props;
  const scanRoom = scan.showing && scan.fit ? scan.fit.slots.length : null;
  useEffect(() => onScanRoom?.(scanRoom), [onScanRoom, scanRoom]);
  // A scan has no cranes to watch, so pallets sit in their final slots right away.
  const display = !scan.showing && flowView?.warehouseId === props.warehouseId ? flowView : EMPTY_VIEW;
  const onView = useCallback((v: FlowView) => setFlowView(v), []);
  const onStats = useCallback((s: FlowStats) => setStats(s), []);
  const moving = stats.inbound + stats.outbound;
  const span = Math.max(config.width, config.length);
  const tags = useTags(props, scanSlots, scan.fit);
  const stored = useMemo(() => props.stacks.reduce((n, stack) => n + stack.filter((id) => id !== null).length, 0), [props.stacks]);
  const tagEls = useRef(new Map<string, HTMLElement>());
  return (
    <div className="absolute inset-0">
    <Canvas
      shadows="percentage"
      dpr={scan.showing ? 1 : [1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 45, near: 0.1, far: 6000 }}
      onPointerMissed={() => props.onSelect(null)}
    >
      {/* Daytime sky; fog tinted to the horizon so the ground fades into it */}
      <color attach="background" args={[scan.showing ? "#0b1020" : "#c9dceb"]} />
      {!scan.showing && (
        <>
          <Sky distance={4500} sunPosition={SUN} turbidity={5} rayleigh={1.2} mieCoefficient={0.004} mieDirectionalG={0.8} />
          <fog attach="fog" args={["#c9dceb", span * 2.5 + 80, span * 8 + 600]} />
        </>
      )}
      {/* Under a scan: soft, even light like the building's own, with no outdoor sun */}
      <hemisphereLight args={scan.showing ? ["#fff8ec", "#b9ad9a", 2.5] : ["#dbeafe", "#4a6b33", 1.1]} />
      <directionalLight
        position={[SUN[0] * (span + 40), SUN[1] * (span + 40), SUN[2] * (span + 40)]}
        intensity={scan.showing ? 0.9 : 2.4}
        color="#fff4e0"
        castShadow={!scan.showing}
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0004}
        shadow-camera-left={-(span * 0.75 + 30)}
        shadow-camera-right={span * 0.75 + 30}
        shadow-camera-top={span * 0.75 + 30}
        shadow-camera-bottom={-(span * 0.75 + 30)}
        shadow-camera-far={span * 4 + 200}
      />
      <CameraRig config={config} />
      {/* Recenter: warehouse corner at origin -> center at origin */}
      <group position={[-config.width / 2, 0, -config.length / 2]}>
        {/* Site frame -> world: rotate 90° when the docks are on the world x = 0 wall */}
        <group
          position={[0, 0, layout.frame.rotated ? layout.frame.width : 0]}
          rotation={[0, layout.frame.rotated ? Math.PI / 2 : 0, 0]}
        >
          {/* Hidden, not unmounted, under a scan so the AS/RS flow simulation keeps running */}
          <group visible={!scan.showing}>
            <Building config={fc} layout={layout} />
            <Racking config={fc} layout={layout} />
            <Asrs
              config={fc}
              layout={layout}
              stacks={props.stacks}
              customers={props.customers}
              products={props.products}
              warehouseId={props.warehouseId}
              transition={props.transition}
              speed={speed}
              finishSignal={finish}
              onView={onView}
              onStats={onStats}
            />
            <RowSigns config={fc} layout={layout} />
            <Docks config={fc} layout={layout} />
            <World config={fc} layout={layout} />
          </group>
          <ScanLayer scan={scan} stored={stored} pallet={scanPallet} />
          <Pallets {...frameProps} display={display} scanSlots={scanSlots} scanFit={scan.showing ? scan.fit : null} />
        </group>
      </group>
      <TagProjector tags={tags} els={tagEls} />
    </Canvas>
    {/* Name tags: plain DOM over the canvas, positioned by TagProjector */}
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {tags.map(({ c }) => (
        <button
          key={c.id}
          ref={(el) => {
            if (el) tagEls.current.set(c.id, el);
            else tagEls.current.delete(c.id);
          }}
          onClick={() => onSelect(c.id === selectedId ? null : c.id)}
          className="pointer-events-auto invisible absolute left-0 top-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-md transition-opacity"
          style={{
            background: c.color,
            opacity: selectedId && selectedId !== c.id ? 0.35 : 1,
            textShadow: "0 1px 2px rgba(0,0,0,.5)",
          }}
        >
          {c.name}
        </button>
      ))}
    </div>
    <ScanPanel scan={scan} stored={stored} />
    {moving > 0 && !scan.showing && (
      <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-amber-500/40 bg-[#0d1433]/90 px-3 py-2 text-xs text-slate-200 shadow-lg">
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          {stats.inbound > 0 && <span>{stats.inbound} pallet{stats.inbound === 1 ? "" : "s"} inbound</span>}
          {stats.inbound > 0 && stats.outbound > 0 && <span className="text-slate-500">·</span>}
          {stats.outbound > 0 && <span>{stats.outbound} outbound</span>}
        </span>
        <span className="flex overflow-hidden rounded border border-slate-700" role="group" aria-label="Simulation speed">
          {[1, 4, 16].map((v) => (
            <button
              key={v}
              onClick={() => setSpeed(v)}
              aria-pressed={speed === v}
              className={`px-2 py-0.5 ${speed === v ? "bg-amber-500 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {v}×
            </button>
          ))}
        </span>
        <button onClick={() => setFinish((n) => n + 1)} className="text-sky-400 hover:text-sky-300">
          Finish now
        </button>
      </div>
    )}
    </div>
  );
}

const EMPTY_VIEW: FlowView = { warehouseId: "", hidden: new Set(), ghosts: [] };

function CameraRig({ config }: { config: WarehouseConfig }) {
  const get = useThree((s) => s.get);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  useEffect(() => {
    const camera = get().camera;
    const span = Math.max(config.width, config.length);
    camera.position.set(config.width * 0.75, span * 0.75, config.length * 0.85);
    camera.updateProjectionMatrix();
    controls.current?.target.set(0, 0, 0);
    controls.current?.update();
  }, [get, config.width, config.length]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      maxPolarAngle={Math.PI / 2 - 0.02}
      maxDistance={Math.max(config.width, config.length) * 4 + 150}
      enableDamping
    />
  );
}

/**
 * Paint all floor markings (aisles, yellow lines, pallet spots) into a single
 * mipmapped texture. Thin geometry stacked a few mm apart shimmers and
 * z-fights at a distance; a filtered texture stays smooth at any zoom.
 */
function useFloorTexture(config: WarehouseConfig, layout: Layout) {
  const gl = useThree((s) => s.gl);
  const texture = useMemo(() => {
    const { width: W, length: L } = config;
    const maxTex = Math.min(gl.capabilities.maxTextureSize, 8192);
    const ppm = Math.min(64, maxTex / Math.max(W, L)); // pixels per meter
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * ppm);
    canvas.height = Math.round(L * ppm);
    const ctx = canvas.getContext("2d")!;
    // Canvas x -> world x, canvas y -> world z (see plane orientation below).
    ctx.scale(canvas.width / W, canvas.height / L);

    // Epoxy-style floor: blue rack zone, grey crane aisles, lighter pre-zone.
    ctx.fillStyle = "#24365a";
    ctx.fillRect(0, 0, W, L);
    ctx.fillStyle = "#2b3d63";
    ctx.fillRect(0.5, 0.5, W - 1, RACK_START - 0.9);

    // Crane aisles run from the P&D stations to the back wall.
    const craneZ0 = layout.rackZ0 - 1.6;
    ctx.fillStyle = "#334155";
    for (const a of layout.aisles) ctx.fillRect(a.x0 + 0.05, craneZ0, a.x1 - a.x0 - 0.1, L - 0.5 - craneZ0);

    // Hatched no-entry band where the crane zone meets the pre-zone.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0.5, craneZ0 - 0.4, W - 1, 0.3);
    ctx.clip();
    ctx.fillStyle = "#facc15";
    ctx.fillRect(0.5, craneZ0 - 0.4, W - 1, 0.3);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 0.12;
    for (let t = 0; t < W + 1; t += 0.4) {
      ctx.beginPath();
      ctx.moveTo(t, craneZ0 - 0.4);
      ctx.lineTo(t + 0.3, craneZ0 - 0.1);
      ctx.stroke();
    }
    ctx.restore();

    // Orange hazard band around the perimeter.
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 0.15;
    ctx.strokeRect(0.25, 0.25, W - 0.5, L - 0.5);

    const { palletDepth: d, palletWidth: w } = config;
    ctx.fillStyle = "#2f4f86";
    ctx.strokeStyle = "#7dd3fc";
    ctx.lineWidth = 0.04;
    for (const r of layout.rows)
      for (const z of layout.cols) {
        ctx.fillRect(r.x - d / 2, z - w / 2, d, w);
        ctx.strokeRect(r.x - d / 2 + 0.02, z - w / 2 + 0.02, d - 0.04, w - 0.04);
      }

    // Text in meters: undo the canvas scale so the font is set in real pixels.
    const ppmX = canvas.width / W;
    const text = (s: string, x: number, z: number, size: number, color: string) => {
      ctx.save();
      ctx.translate(x, z);
      ctx.scale(1 / ppmX, 1 / ppmX);
      ctx.font = `700 ${Math.max(1, size * ppmX)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(s, 0, 0);
      ctx.restore();
    };

    // Dock staging zones: hazard-striped box inside each door.
    const zones = layout.docks.map(dockZone);
    zones.forEach((z, i) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(z.x0, z.z0, z.x1 - z.x0, z.z1 - z.z0);
      ctx.clip();
      ctx.fillStyle = "#facc15";
      ctx.fillRect(z.x0, z.z0, z.x1 - z.x0, z.z1 - z.z0);
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 0.18;
      for (let t = -10; t < 20; t += 0.5) {
        ctx.beginPath();
        ctx.moveTo(z.x0 + t, z.z0);
        ctx.lineTo(z.x0 + t + 10, z.z0 + 10);
        ctx.stroke();
      }
      const inset = 0.22;
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(z.x0 + inset, z.z0 + inset, z.x1 - z.x0 - 2 * inset, z.z1 - z.z0 - 2 * inset);
      ctx.restore();
      const size = Math.min(0.6, (z.z1 - z.z0) * 0.3, (z.x1 - z.x0) * 0.18);
      text(`DOCK ${i + 1}`, (z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2, size, "#facc15");
    });
    const inDock = (x: number, z: number) => zones.some((d) => x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1);

    // Row letters at the back end of each row (the row heads hold P&D conveyors).
    const rowSize = Math.min(0.8, d * 0.7);
    layout.rows.forEach((r, i) => {
      const z = layout.rackZ1 + 0.6;
      if (!inDock(r.x, z)) text(rowName(i), r.x, z, rowSize, "#e0f2fe");
    });

    // Column numbers along every crane aisle, beside the floor rail.
    const colSize = Math.min(0.36, w * 0.42);
    for (const a of layout.aisles) {
      const x = a.x0 + Math.min(0.4, (a.x1 - a.x0) / 4);
      layout.cols.forEach((z, i) => {
        if (!inDock(x, z)) text(colName(i), x, z, colSize, "#bae6fd");
      });
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = gl.capabilities.getMaxAnisotropy();
    return tex;
  }, [gl, config, layout]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** Floor rectangle (site frame x/z) of a dock's staging zone, just inside the door. */
function dockZone(d: Dock) {
  const a0 = d.at - d.width / 2, a1 = d.at + d.width / 2;
  return { x0: a0, x1: a1, z0: 0.3, z1: 0.3 + d.depth };
}

const noRaycast = () => null;

/** Canvas texture with centered bold text, for signs. */
function useLabelTexture(label: string, bg: string, fg: string, aspect: number) {
  const texture = useMemo(() => {
    const h = 128, w = Math.round(h * aspect);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = 84;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (size > 20 && ctx.measureText(label).width > w - 36) ctx.font = `800 ${(size -= 4)}px system-ui, sans-serif`;
    ctx.fillText(label, w / 2, h / 2 + 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }, [label, bg, fg, aspect]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** Flat sign facing local +z. */
function Sign({ label, w, h, bg, fg, ...rest }: { label: string; w: number; h: number; bg: string; fg: string } & Omit<ThreeElements["mesh"], "args">) {
  const map = useLabelTexture(label, bg, fg, w / h);
  return (
    <mesh raycast={noRaycast} {...rest}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={map} toneMapped={false} side={THREE.FrontSide} />
    </mesh>
  );
}

/** Row letter boards on top of both ends of every rack row. */
function RowSigns({ config, layout }: { config: WarehouseConfig; layout: Layout }) {
  if (!layout.cols.length) return null;
  const top = layout.levels >= 2 ? levelY(config, layout.levels - 1) + config.palletHeight * 0.6 : config.palletHeight;
  const y = Math.min(top + 0.45, config.ceilingHeight - 0.4);
  const zFront = layout.cols[0] - config.palletWidth / 2 - 0.08;
  const zBack = layout.cols[layout.cols.length - 1] + config.palletWidth / 2 + 0.08;
  const w = Math.min(1.1, config.palletDepth);
  return (
    <group>
      {layout.rows.map((r, i) => (
        <group key={i}>
          <Sign label={rowName(i)} w={w} h={0.7} bg="#1d4ed8" fg="#ffffff" position={[r.x, y, zFront]} rotation={[0, Math.PI, 0]} />
          <Sign label={rowName(i)} w={w} h={0.7} bg="#1d4ed8" fg="#ffffff" position={[r.x, y, zBack]} />
        </group>
      ))}
    </group>
  );
}

/** Loading dock doors: frame, half-open roller shutter, bumpers, seal and sign. */
function Docks({ config, layout }: { config: WarehouseConfig; layout: Layout }) {
  return (
    <group>
      {layout.docks.map((d, i) => (
        <DockDoor key={i} dock={d} index={i} ceiling={config.ceilingHeight} />
      ))}
    </group>
  );
}

function DockDoor({ dock, index, ceiling }: { dock: Dock; index: number; ceiling: number }) {
  const { width: w, height: h } = dock;
  // Local frame: wall at z = 0, building interior toward +z, door spans x ±w/2.
  const shutterH = h * 0.45;
  const box = (key: string, p: [number, number, number], s: [number, number, number], color: string, metal = 0.2) => (
    <mesh key={key} position={p} raycast={noRaycast} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} metalness={metal} roughness={0.6} />
    </mesh>
  );
  return (
    <group position={[dock.at, 0, 0]}>
      {/* Door frame */}
      {box("pl", [-w / 2 - 0.1, h / 2, 0.06], [0.2, h, 0.2], "#facc15")}
      {box("pr", [w / 2 + 0.1, h / 2, 0.06], [0.2, h, 0.2], "#facc15")}
      {box("hd", [0, h + 0.1, 0.06], [w + 0.4, 0.2, 0.2], "#facc15")}
      {/* Roller shutter, half raised, with its coil housing */}
      {box("sh", [0, h - shutterH / 2, 0.03], [w, shutterH, 0.04], "#94a3b8", 0.6)}
      {box("co", [0, h + 0.38, 0.22], [w + 0.2, 0.36, 0.36], "#64748b", 0.6)}
      {/* Outside: rubber bumpers and dock seal (apron is painted by World) */}
      {box("bl", [-w / 2 + 0.25, 0.45, -0.1], [0.25, 0.5, 0.2], "#111827")}
      {box("br", [w / 2 - 0.25, 0.45, -0.1], [0.25, 0.5, 0.2], "#111827")}
      {box("sl", [-w / 2 - 0.15, h / 2, -0.18], [0.3, h, 0.3], "#1f2937")}
      {box("sr", [w / 2 + 0.15, h / 2, -0.18], [0.3, h, 0.3], "#1f2937")}
      {box("st", [0, h + 0.15, -0.18], [w + 0.6, 0.3, 0.3], "#1f2937")}
      {/* Sign above the door, readable from inside and outside */}
      <Sign label={`DOCK ${index + 1}`} w={1.8} h={0.55} bg="#facc15" fg="#111827" position={[0, Math.min(h + 0.95, ceiling - 0.35), 0.3]} />
      <Sign label={`DOCK ${index + 1}`} w={1.8} h={0.55} bg="#facc15" fg="#111827" position={[0, Math.min(h + 0.95, ceiling - 0.35), -0.36]} rotation={[0, Math.PI, 0]} />
    </group>
  );
}

function Building({ config, layout }: { config: WarehouseConfig; layout: Layout }) {
  const { width: W, length: L, ceilingHeight: H } = config;
  const floorTex = useFloorTexture(config, layout);

  const wallEdges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, L)),
    [W, H, L],
  );

  return (
    <group>
      {/* Floor (plane's local +Y maps to world -Z, so texture top = z 0) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, L / 2]} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial map={floorTex} roughness={0.95} />
      </mesh>
      {/* Walls: translucent shell + outline */}
      <lineSegments geometry={wallEdges} position={[W / 2, H / 2, L / 2]}>
        <lineBasicMaterial color="#475569" />
      </lineSegments>
      {[
        { p: [W / 2, H / 2, 0], s: [W, H] , r: 0 },
        { p: [0, H / 2, L / 2], s: [L, H], r: Math.PI / 2 },
        { p: [W, H / 2, L / 2], s: [L, H], r: -Math.PI / 2 },
      ].map((w, i) => (
        <mesh key={i} position={w.p as [number, number, number]} rotation={[0, w.r, 0]} raycast={() => null}>
          <planeGeometry args={w.s as [number, number]} />
          <meshStandardMaterial color="#cbd5e1" transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Selective pallet racking (blue upright frames, orange step beams, wire
 * decking) drawn with three instanced meshes of unit boxes scaled per piece.
 */
const UPRIGHT = 0.09; // upright profile size
const DECK_T = 0.03;

function Racking({ config, layout }: { config: WarehouseConfig; layout: Layout }) {
  const parts = useMemo(() => {
    const uprights: THREE.Matrix4[] = [];
    const beams: THREE.Matrix4[] = [];
    const decks: THREE.Matrix4[] = [];
    const braces: THREE.Matrix4[] = [];
    if (layout.levels < 2) return { uprights, beams, decks, braces }; // floor-only: no racking
    const top = levelY(config, layout.levels - 1) + config.palletHeight * 0.6;
    const d = config.palletDepth;
    const frameD = d - 0.1; // frame depth; pallet overhangs the beams slightly
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const box = (out: THREE.Matrix4[], x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
      out.push(new THREE.Matrix4().compose(pos.set(x, y, z), q, scl.set(sx, sy, sz)));

    // Unique frame positions along the row (bay boundaries).
    const frameZ = new Set<number>();
    for (const b of layout.bays) {
      frameZ.add(+b.z0.toFixed(4));
      frameZ.add(+b.z1.toFixed(4));
    }

    for (const r of layout.rows) {
      const xf = r.x - frameD / 2, xb = r.x + frameD / 2; // front/back upright lines
      for (const z of frameZ) {
        box(uprights, xf, top / 2, z, UPRIGHT, top, UPRIGHT);
        box(uprights, xb, top / 2, z, UPRIGHT, top, UPRIGHT);
        // Horizontal frame ties between the two uprights.
        for (let y = 0.3; y < top; y += 1.2) box(braces, r.x, y, z, frameD, 0.04, 0.04);
      }
      for (const b of layout.bays) {
        const len = b.z1 - b.z0, zc = (b.z0 + b.z1) / 2;
        for (let k = 1; k < layout.levels; k++) {
          const y = levelY(config, k);
          box(beams, xf, y - BEAM_HEIGHT / 2, zc, 0.05, BEAM_HEIGHT, len);
          box(beams, xb, y - BEAM_HEIGHT / 2, zc, 0.05, BEAM_HEIGHT, len);
          box(decks, r.x, y - DECK_T / 2, zc, frameD, DECK_T, len - UPRIGHT);
        }
      }
    }
    return { uprights, beams, decks, braces };
  }, [config, layout]);

  return (
    <group>
      <PartMesh matrices={parts.uprights} color="#1d4ed8" metalness={0.5} roughness={0.45} />
      <PartMesh matrices={parts.braces} color="#3b82f6" metalness={0.5} roughness={0.45} />
      <PartMesh matrices={parts.beams} color="#f97316" metalness={0.35} roughness={0.5} />
      <PartMesh matrices={parts.decks} color="#b8c2cc" metalness={0.8} roughness={0.35} transparent opacity={0.85} />
    </group>
  );
}

function PartMesh({
  matrices,
  color,
  metalness,
  roughness,
  transparent,
  opacity,
}: {
  matrices: THREE.Matrix4[];
  color: string;
  metalness: number;
  roughness: number;
  transparent?: boolean;
  opacity?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [matrices]);
  if (matrices.length === 0) return null;
  return (
    <instancedMesh
      key={matrices.length}
      ref={ref}
      args={[undefined, undefined, matrices.length]}
      castShadow
      receiveShadow
      raycast={() => null}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} transparent={transparent} opacity={opacity} />
    </instancedMesh>
  );
}

interface Instance extends SlotContent {
  x: number;
  y: number;
  z: number;
  spot?: number; // 1-based open-floor spot when placed on a scan
}

/** Above this many cartons in total, extra pallets are drawn as one solid load block. */
const BOX_BUDGET = 90_000;
const BOX_GAP = 0.012; // visible seam between cartons, m
const CARDBOARD = new THREE.Color("#b58a5c"); // cartons look like cartons over a real scan

function Pallets({
  config,
  layout,
  stacks,
  customers,
  products,
  selectedId,
  onSelect,
  onHover,
  display,
  scanSlots,
  scanFit,
}: Props & { display: FlowView; scanSlots: ScanSlot[] | null; scanFit: ScanFit | null }) {
  // What is physically in the racks: allocated pallets that have landed, plus
  // removed pallets still waiting for their crane.
  const instances = useMemo(() => {
    const nC = layout.cols.length;
    const out: Instance[] = [];
    let spot = 0;
    const tops = new Map<string, number>(); // height reached so far on each floor spot
    const add = (c: SlotContent) => {
      if (scanSlots) {
        const s = scanSlots[spot++];
        if (!s) return;
        // Floor stacks rest directly on the load below, unlike pallets on rack beams.
        const at = `${s.x}:${s.z}`;
        const y = tops.get(at) ?? 0;
        const load = c.pattern && c.boxes > 0 ? Math.ceil(c.boxes / c.pattern.perLayer) * c.pattern.bh : config.palletHeight - PALLET_DECK_H;
        tops.set(at, y + PALLET_DECK_H + load);
        out.push({ ...c, x: s.x, y, z: s.z, spot });
        return;
      }
      const r = layout.rows[Math.floor(c.p / nC)];
      const z = layout.cols[c.p % nC];
      if (r && z !== undefined) out.push({ ...c, x: r.x, y: levelY(config, c.level), z });
    };
    for (const c of palletContents(stacks, customers, products, config)) if (!display.hidden.has(c.key)) add(c);
    for (const c of display.ghosts) add(c);
    return out;
  }, [stacks, layout, config, customers, products, display, scanSlots]);

  // Split pallets into "draw every carton" and "draw a solid block" within the budget.
  const { boxCount, solid } = useMemo(() => {
    let boxCount = 0;
    const solid: number[] = [];
    instances.forEach((it, i) => {
      if (scanSlots && it.pattern && it.boxes > 0) return; // drawn by ScanCartons
      if (it.pattern && it.boxes > 0 && boxCount + it.boxes <= BOX_BUDGET) boxCount += it.boxes;
      else solid.push(i);
    });
    return { boxCount, solid };
  }, [instances, scanSlots]);

  const cartonPallets = useMemo<CartonPallet[]>(() => {
    if (!scanSlots) return [];
    const productOf = new Map(customers.map((c) => [c.id, c.productId]));
    return instances.flatMap((it) => {
      const productId = productOf.get(it.customerId);
      if (!it.pattern || it.boxes === 0 || !productId) return [];
      return [{ x: it.x, y: it.y, z: it.z, boxes: it.boxes, customerId: it.customerId, productId, pattern: it.pattern }];
    });
  }, [scanSlots, instances, customers]);
  const euroPallet = useEuroPallet(config.palletDepth, config.palletWidth);

  const baseRef = useRef<THREE.InstancedMesh>(null);
  const pickRef = useRef<THREE.InstancedMesh>(null);
  const boxRef = useRef<THREE.InstancedMesh>(null);
  const solidRef = useRef<THREE.InstancedMesh>(null);
  const fullH = config.palletHeight - PALLET_DECK_H - 0.02;

  useLayoutEffect(() => {
    const base = baseRef.current, pick = pickRef.current;
    if (!base || !pick) return;
    const o = new THREE.Object3D();
    const col = new THREE.Color();
    const dim = new THREE.Color("#28345a");
    const solidSet = new Set(solid);
    const tint = (it: Instance, jitter = 0, share = 1) => {
      col.set(it.color);
      if (share < 1) col.lerp(CARDBOARD, 1 - share);
      if (jitter) col.offsetHSL(0, 0, jitter);
      if (selectedId && it.customerId !== selectedId) col.lerp(dim, 0.8);
      return col;
    };
    // Load envelope per pallet: the carton stack (or the full pallet height if unknown).
    const envelope = (it: Instance) => {
      const pt = it.pattern;
      if (!pt || it.boxes === 0) return { w: config.palletDepth - 0.06, h: fullH, d: config.palletWidth - 0.06 };
      const layers = Math.ceil(it.boxes / pt.perLayer);
      const rowsUsed = layers > 1 ? pt.nz : Math.ceil(it.boxes / pt.nx);
      return { w: pt.nx * pt.bx, h: layers * pt.bh, d: rowsUsed * pt.bz };
    };

    let b = 0, s = 0;
    const boxes = boxRef.current, solidMesh = solidRef.current;
    instances.forEach((it, i) => {
      const top = it.y + PALLET_DECK_H;
      o.rotation.set(0, 0, 0);
      o.position.set(it.x, it.y + PALLET_DECK_H / 2, it.z);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      base.setMatrixAt(i, o.matrix);

      const env = envelope(it);
      // Envelope is centred on the pallet; partial top layers start at the -z edge.
      const z0 = it.z - (it.pattern ? (it.pattern.nz * it.pattern.bz) / 2 : 0);
      const ez = it.pattern && it.boxes > 0 ? z0 + env.d / 2 : it.z;
      o.position.set(it.x, top + env.h / 2, ez);
      o.scale.set(env.w, env.h, env.d);
      o.updateMatrix();
      pick.setMatrixAt(i, o.matrix);

      if (solidSet.has(i)) {
        if (solidMesh) {
          solidMesh.setMatrixAt(s, o.matrix);
          solidMesh.setColorAt(s, tint(it, 0, scanSlots ? 0 : 1));
        }
        s++;
        return;
      }
      if (!boxes || !it.pattern) return;
      const pt = it.pattern;
      const x0 = it.x - (pt.nx * pt.bx) / 2;
      for (let n = 0; n < it.boxes; n++) {
        const layer = Math.floor(n / pt.perLayer);
        const inLayer = n % pt.perLayer;
        const ix = inLayer % pt.nx, iz = Math.floor(inLayer / pt.nx);
        o.position.set(x0 + (ix + 0.5) * pt.bx, top + (layer + 0.5) * pt.bh, z0 + (iz + 0.5) * pt.bz);
        o.scale.set(pt.bx - BOX_GAP, pt.bh - BOX_GAP, pt.bz - BOX_GAP);
        o.updateMatrix();
        boxes.setMatrixAt(b, o.matrix);
        // Slight per-carton shade variation so the seams read as separate boxes.
        boxes.setColorAt(b, tint(it, (((ix * 7 + iz * 13 + layer * 5) % 5) - 2) * 0.018));
        b++;
      }
    });
    for (const m of [base, pick, boxes, solidMesh]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [instances, solid, selectedId, fullH, config.palletDepth, config.palletWidth, scanSlots]);

  const grounded = useMemo(() => (scanSlots ? instances.filter((it) => it.y === 0) : []), [scanSlots, instances]);

  if (instances.length === 0) return null;

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.instanceId !== undefined ? instances[e.instanceId] : undefined;

  return (
    // Over a scan the pallets are laid out square to its walls; this turns them to match.
    <group position={[scanFit?.centre.x ?? 0, 0, scanFit?.centre.z ?? 0]} rotation={[0, scanFit?.yaw ?? 0, 0]}>
    <group key={`${instances.length}:${boxCount}:${solid.length}`} position={[-(scanFit?.centre.x ?? 0), 0, -(scanFit?.centre.z ?? 0)]}>
      <GroundShadows spots={grounded} width={config.palletDepth} depth={config.palletWidth} />
      <GroundOutlines spots={grounded} depth={config.palletDepth} width={config.palletWidth} selectedId={selectedId} />
      {scanSlots ? (
        <instancedMesh ref={baseRef} args={[euroPallet.geometry, euroPallet.material, instances.length]} raycast={() => null} />
      ) : (
        <instancedMesh ref={baseRef} args={[undefined, undefined, instances.length]} castShadow receiveShadow raycast={() => null}>
          <boxGeometry args={[config.palletDepth, PALLET_DECK_H, config.palletWidth]} />
          <meshStandardMaterial color="#c08a52" roughness={0.85} />
        </instancedMesh>
      )}
      {scanSlots && <ScanCartons pallets={cartonPallets} products={products} selectedId={selectedId} />}
      {boxCount > 0 && (
        <instancedMesh ref={boxRef} args={[undefined, undefined, boxCount]} castShadow receiveShadow raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial roughness={0.75} />
        </instancedMesh>
      )}
      {solid.length > 0 && (
        <instancedMesh ref={solidRef} args={[undefined, undefined, solid.length]} castShadow receiveShadow raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial roughness={0.7} />
        </instancedMesh>
      )}
      {/* Invisible load envelopes: one cheap raycast target per pallet instead of per carton */}
      <instancedMesh
        ref={pickRef}
        args={[undefined, undefined, instances.length]}
        onClick={(e) => {
          e.stopPropagation();
          const it = pick(e);
          if (it) onSelect(it.customerId === selectedId ? null : it.customerId);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          const it = pick(e);
          if (it) onHover({ customerId: it.customerId, slot: it.spot ? `scan spot ${it.spot}` : slotLabel(layout, it.p, it.level), boxes: it.boxes });
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </instancedMesh>
    </group>
    </group>
  );
}

const SHADOW_SPREAD = 1.45; // shadow size relative to the pallet footprint

/** Soft dark patches under floor pallets: a scan can't receive real shadows. */
function GroundShadows({ spots, width, depth }: { spots: Instance[]; width: number; depth: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const texture = useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.filter = `blur(${size * 0.09}px)`;
    ctx.fillStyle = "#000";
    ctx.fillRect(size * 0.2, size * 0.2, size * 0.6, size * 0.6);
    return new THREE.CanvasTexture(canvas);
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    o.rotation.x = -Math.PI / 2;
    spots.forEach((it, i) => {
      o.position.set(it.x, 0.01, it.z);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [spots]);
  if (!spots.length) return null;
  return (
    // Drawn after the splats, which write no depth, so it lands on top of the scanned floor.
    <instancedMesh key={spots.length} ref={ref} args={[undefined, undefined, spots.length]} renderOrder={20} raycast={noRaycast}>
      <planeGeometry args={[width * SHADOW_SPREAD, depth * SHADOW_SPREAD]} />
      <meshBasicMaterial map={texture} transparent opacity={0.55} depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}

interface Tag {
  c: Customer;
  pos: THREE.Vector3; // world position (scene already recentered)
}

/** Name-tag anchor above each customer's cluster. */
function useTags({ config, layout, stacks, customers }: Props, scanSlots: ScanSlot[] | null, scanFit: ScanFit | null): Tag[] {
  return useMemo(() => {
    const nC = layout.cols.length;
    const acc = new Map<string, { x: number; z: number; n: number; top: number }>();
    let spot = 0;
    stacks.forEach((stack, p) => {
      const r = layout.rows[Math.floor(p / nC)];
      const col = layout.cols[p % nC];
      stack.forEach((id, level) => {
        if (id === null) return;
        const slot = scanSlots?.[spot++];
        if (scanSlots ? !slot : !r || col === undefined) return;
        const a = acc.get(id) ?? { x: 0, z: 0, n: 0, top: 0 };
        a.x += slot ? slot.x : r.x;
        a.z += slot ? slot.z : col;
        a.n++;
        a.top = Math.max(a.top, slot ? slot.y : levelY(config, level));
        acc.set(id, a);
      });
    });
    return customers
      .filter((c) => acc.has(c.id))
      .map((c) => {
        const a = acc.get(c.id)!;
        const mid = scanSlots && scanFit ? scanToSite(scanFit, a.x / a.n, a.z / a.n) : { x: a.x / a.n, z: a.z / a.n };
        const [wx, wz] = frameToWorld(layout, mid.x, mid.z);
        return {
          c,
          pos: new THREE.Vector3(wx - config.width / 2, a.top + config.palletHeight + 0.6, wz - config.length / 2),
        };
      });
  }, [stacks, layout, customers, config, scanSlots, scanFit]);
}

/** Moves the DOM name tags to their projected screen positions every frame. */
function TagProjector({ tags, els }: { tags: Tag[]; els: RefObject<Map<string, HTMLElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const t of tags) {
      const el = els.current.get(t.c.id);
      if (!el) continue;
      v.copy(t.pos).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        el.style.visibility = "hidden";
        continue;
      }
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.visibility = "visible";
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      el.style.zIndex = String(Math.round((1 - v.z) * 1e5));
    }
  });
  return null;
}


