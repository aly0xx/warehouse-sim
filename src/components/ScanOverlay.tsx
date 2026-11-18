"use client";

import { useFrame, useThree } from "@react-three/fiber";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { ChangeEvent, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  DEFAULT_ALIGNMENT,
  DEFAULT_SCAN,
  SCAN_EXTENSIONS,
  ScanAlignment,
  fitPalletsToScan,
  isScanFile,
  loadAlignment,
  saveAlignment,
  scanView,
  walkClear,
} from "@/lib/scan";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; splats: number }
  | { kind: "error"; message: string };

/** A calibration step waiting for clicks on the scan. */
type Pick =
  | { mode: "scale"; first: { local: THREE.Vector3; site: THREE.Vector3 } | null }
  | { mode: "floor" }
  | { mode: "origin" }
  | null;

const PICK_HINT = {
  scale: "Click the first tape mark on the scan.",
  floor: "Click a point on the floor.",
  origin: "Click the building corner on the floor.",
};

export type ScanController = ReturnType<typeof useScan>;

const MAX_SAMPLES = 1_500_000; // splat centres kept for finding open floor
const MIN_SAMPLE_OPACITY = 0.4; // fainter splats are haze, not surfaces

export function useScan(warehouseId: string, pallet: { width: number; depth: number; height: number }) {
  const [owner, setOwner] = useState(warehouseId);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [alignment, setAlignmentState] = useState(DEFAULT_ALIGNMENT);
  const [visible, setVisible] = useState(true);
  const [pick, setPick] = useState<Pick>(null);
  const [hint, setHint] = useState("");
  const [tapeLength, setTapeLength] = useState("5");
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const { width, depth, height } = pallet;
  const fit = useMemo(
    () => (samples ? fitPalletsToScan(samples, alignment, { width, depth, height }) : null),
    [samples, alignment, width, depth, height],
  );

  // A scan belongs to one warehouse: switching warehouses closes it.
  if (owner !== warehouseId) {
    setOwner(warehouseId);
    setFile(null);
    setSamples(null);
    setStatus({ kind: "idle" });
    setPick(null);
    setHint("");
  }

  const load = useCallback(
    (next: File) => {
      setPick(null);
      setHint("");
      setSamples(null);
      if (!isScanFile(next.name)) {
        setFile(null);
        setStatus({ kind: "error", message: `Choose a ${SCAN_EXTENSIONS.join(", ")} file.` });
        return;
      }
      setAlignmentState(loadAlignment(warehouseId, next));
      setVisible(true);
      setStatus({ kind: "loading" });
      setFile(next);
    },
    [warehouseId],
  );

  // Someone's own choice always beats the automatic scan still downloading.
  const chosen = useRef(false);
  const open = useCallback(
    (next: File) => {
      chosen.current = true;
      load(next);
    },
    [load],
  );

  useEffect(() => {
    let cancelled = false;
    chosen.current = false;
    (async () => {
      try {
        const res = await fetch(new URL(DEFAULT_SCAN, document.baseURI));
        if (!res.ok || cancelled || chosen.current) return;
        const blob = await res.blob();
        if (!cancelled && !chosen.current) load(new File([blob], DEFAULT_SCAN));
      } catch {
        // No bundled scan here: the simulated warehouse stays on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [warehouseId, load]);

  const close = useCallback(() => {
    chosen.current = true;
    setFile(null);
    setSamples(null);
    setStatus({ kind: "idle" });
    setPick(null);
    setHint("");
  }, []);

  const setAlignment = useCallback(
    (next: ScanAlignment) => {
      setAlignmentState(next);
      if (file) saveAlignment(warehouseId, file, next);
    },
    [file, warehouseId],
  );

  const startPick = useCallback((mode: "scale" | "floor" | "origin") => {
    setPick(mode === "scale" ? { mode, first: null } : { mode });
    setHint(PICK_HINT[mode]);
  }, []);

  const cancelPick = useCallback(() => {
    setPick(null);
    setHint("");
  }, []);

  return {
    file,
    status,
    alignment,
    visible,
    pick,
    hint,
    tapeLength,
    fit,
    /** True while the scan replaces the simulated building. */
    showing: status.kind === "ready" && visible,
    open,
    close,
    setAlignment,
    setStatus,
    setSamples,
    setVisible,
    setPick,
    setHint,
    setTapeLength,
    startPick,
    cancelPick,
  };
}

const CLICK_SLOP = 5; // px of pointer travel before a click counts as an orbit drag
const LOOK_HEIGHT = 1; // m, height of the point the camera orbits

const LOOK_REACH = 0.1; // m, orbit point just ahead of the camera, so dragging looks around in place
const WALK_SPEED = 4; // m/s
const RUN_SPEED = 10; // m/s, with Shift held
const WHEEL_STEP = 0.01; // m of travel per wheel unit
const MIN_EYE_HEIGHT = 0.4; // m, keeps the camera above the floor
const MAX_STRIDE = 0.2; // m, longest move between collision checks
const TURN_SPEED = 1.6; // radians per second with the arrow keys
const MAX_TILT = 0.05; // radians kept from looking straight up or down

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
  enableZoom: boolean;
  enablePan: boolean;
  rotateSpeed: number;
  maxPolarAngle: number;
}

const WALK_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight",
]);

type Clear = (world: THREE.Vector3) => boolean;

/** Moves the camera and its orbit point together, sliding along anything solid. */
function moveView(camera: THREE.Camera, orbit: OrbitLike | null, step: THREE.Vector3, clear: Clear) {
  const room = MIN_EYE_HEIGHT - camera.position.y;
  if (step.y < room) step.y = Math.min(0, room);
  const parts = Math.max(1, Math.ceil(step.length() / MAX_STRIDE));
  const stride = step.clone().divideScalar(parts);
  const next = new THREE.Vector3();
  for (let i = 0; i < parts; i++) {
    // Starting inside something (a stray splat, say) must never trap the camera.
    const free = clear(camera.position);
    for (const axis of ["x", "y", "z"] as const) {
      next.copy(camera.position);
      next[axis] += stride[axis];
      if (free && !clear(next)) continue;
      camera.position[axis] = next[axis];
      if (orbit) orbit.target[axis] += stride[axis];
    }
  }
}

/** WASD to walk, arrows to turn, Q/E to rise and sink, Shift to run, wheel to move along the view. */
function ScanWalk({ clear }: { clear: RefObject<Clear> }) {
  const get = useThree((s) => s.get);
  const held = useRef(new Set<string>());

  useEffect(() => {
    const keys = held.current;
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
    };
    const onDown = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || !WALK_KEYS.has(e.code)) return;
      keys.add(e.code);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.code);
    const release = () => keys.clear();
    const { gl } = get();
    const el = gl.domElement;
    // Clicking the view takes focus out of the side panel so the keys work straight away.
    const onPointerDown = () => (document.activeElement as HTMLElement | null)?.blur?.();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { camera, controls } = get();
      const step = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-e.deltaY * WHEEL_STEP);
      moveView(camera, controls as unknown as OrbitLike | null, step, clear.current);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("wheel", onWheel);
      keys.clear();
    };
  }, [get, clear]);

  useFrame((state, delta) => {
    const keys = held.current;
    if (!keys.size) return;
    const on = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);
    const orbit = state.controls as unknown as OrbitLike | null;
    const turn = on("ArrowLeft") - on("ArrowRight");
    const tilt = on("ArrowUp") - on("ArrowDown");
    if (orbit && (turn || tilt)) {
      // Swinging the orbit point around the camera turns the view on the spot.
      const aim = new THREE.Spherical().setFromVector3(orbit.target.clone().sub(state.camera.position));
      const angle = TURN_SPEED * Math.min(delta, 0.1);
      aim.theta += turn * angle;
      aim.phi = THREE.MathUtils.clamp(aim.phi - tilt * angle, MAX_TILT, Math.PI - MAX_TILT);
      orbit.target.copy(state.camera.position).add(new THREE.Vector3().setFromSpherical(aim));
    }
    const forward = on("KeyW") - on("KeyS");
    const strafe = on("KeyD") - on("KeyA");
    const rise = on("KeyE") - on("KeyQ");
    if (!forward && !strafe && !rise) return;
    const look = state.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(look, state.camera.up).normalize();
    const speed = on("ShiftLeft", "ShiftRight") ? RUN_SPEED : WALK_SPEED;
    const step = look.multiplyScalar(forward).addScaledVector(right, strafe).setY(rise).normalize();
    moveView(state.camera, orbit, step.multiplyScalar(speed * Math.min(delta, 0.1)), clear.current);
  });

  return null;
}

/** Renders the scan. Mount inside the site-frame group so alignment is in site coordinates. */
export function ScanLayer({
  scan,
  stored,
  pallet,
}: {
  scan: ScanController;
  stored: number;
  pallet: { width: number; depth: number; height: number };
}) {
  const get = useThree((s) => s.get);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const anchor = useRef<THREE.Group>(null);
  const [mesh, setMesh] = useState<SplatMesh | null>(null);
  const { file, alignment, visible, pick, tapeLength, fit, setStatus, setSamples, setAlignment, setPick, setHint } = scan;

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let spark: SparkRenderer | null = null;
    let splat: SplatMesh | null = null;
    (async () => {
      try {
        // Spark is about 3 MB, so it is only fetched once a scan is opened.
        const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
        const fileBytes = await file.arrayBuffer();
        if (cancelled) return;
        spark = new SparkRenderer({ renderer: gl });
        scene.add(spark);
        splat = new SplatMesh({ fileBytes, fileName: file.name });
        await splat.initialized;
        if (cancelled) return;
        const total = splat.splats?.getNumSplats() ?? 0;
        const step = Math.max(1, Math.ceil(total / MAX_SAMPLES));
        const points = new Float32Array(Math.ceil(total / step) * 3);
        let used = 0;
        splat.forEachSplat((index, center, _scales, _quaternion, opacity) => {
          if (index % step !== 0 || opacity < MIN_SAMPLE_OPACITY) return;
          points[used++] = center.x;
          points[used++] = center.y;
          points[used++] = center.z;
        });
        setSamples(points.slice(0, used));
        setMesh(splat);
        setStatus({ kind: "ready", splats: splat.splats?.getNumSplats() ?? 0 });
      } catch (err) {
        if (cancelled) return;
        console.error("Could not load scan", err);
        setStatus({ kind: "error", message: `Could not read ${file.name}. The file may be damaged or unsupported.` });
      }
    })();
    return () => {
      cancelled = true;
      setMesh(null);
      splat?.removeFromParent();
      splat?.dispose();
      if (spark) {
        scene.remove(spark);
        spark.dispose();
      }
    };
  }, [file, gl, scene, setStatus, setSamples]);

  // A scan has a roof, so view the pallets from inside; leaving puts the camera back.
  const view = fit ? scanView(fit, stored, pallet.height) : null;
  const viewRef = useRef(view);
  const centreRef = useRef(fit?.centre);
  const clearRef = useRef<Clear>(() => true);
  useEffect(() => {
    viewRef.current = view;
    centreRef.current = fit?.centre;
    const site = new THREE.Vector3();
    clearRef.current = (world) => {
      const frame = anchor.current?.parent;
      if (!fit || !frame) return true;
      frame.worldToLocal(site.copy(world));
      return walkClear(fit, stored, pallet, site.x, site.y, site.z);
    };
  });
  useEffect(() => {
    const frame = anchor.current?.parent;
    if (!mesh || !visible || !frame) return;
    const start = viewRef.current;
    const { camera: cam, controls } = get();
    const orbit = controls as unknown as OrbitLike | null;
    const savedPosition = cam.position.clone();
    const savedTarget = orbit?.target.clone();
    const savedControls = orbit && {
      enableZoom: orbit.enableZoom,
      enablePan: orbit.enablePan,
      rotateSpeed: orbit.rotateSpeed,
      maxPolarAngle: orbit.maxPolarAngle,
    };
    frame.updateWorldMatrix(true, false);
    // With no open floor to stand on yet, start in the middle of the scan.
    const middle = centreRef.current;
    const eye = frame.localToWorld(start ? new THREE.Vector3(start.eye.x, start.eye.y, start.eye.z) : new THREE.Vector3(middle?.x, middle?.y, middle?.z));
    const look = frame.localToWorld(start ? new THREE.Vector3(start.look.x, LOOK_HEIGHT, start.look.z) : new THREE.Vector3(middle?.x, middle?.y, (middle?.z ?? 0) + 1));
    cam.position.copy(eye);
    if (orbit) {
      Object.assign(orbit, { enableZoom: false, enablePan: false, rotateSpeed: 0.5, maxPolarAngle: Math.PI });
      orbit.target.copy(eye).addScaledVector(look.sub(eye).normalize(), LOOK_REACH);
      orbit.update();
    }
    return () => {
      cam.position.copy(savedPosition);
      if (orbit && savedControls && savedTarget) {
        Object.assign(orbit, savedControls);
        orbit.target.copy(savedTarget);
        orbit.update();
      }
    };
  }, [mesh, visible, get]);

  useLayoutEffect(() => {
    const group = anchor.current;
    if (!group || !mesh) return;
    group.add(mesh);
    return () => {
      group.remove(mesh);
    };
  }, [mesh]);

  // The anchor carries the alignment, so the scan object itself is never restyled.
  useLayoutEffect(() => {
    const group = anchor.current;
    if (!group) return;
    const rad = THREE.MathUtils.degToRad;
    group.position.set(alignment.x, alignment.y, alignment.z);
    // Yaw last, so it always turns the scan about the true vertical.
    group.rotation.set(rad(alignment.pitch), rad(alignment.yaw), rad(alignment.roll), "YXZ");
    group.scale.setScalar(alignment.scale);
  }, [alignment]);

  // Calibration clicks. A drag is an orbit, not a pick.
  useEffect(() => {
    if (!pick || !mesh) return;
    const el = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) return;
      const box = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - box.left) / box.width) * 2 - 1,
        -((e.clientY - box.top) / box.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      const frame = anchor.current?.parent;
      if (!hit || !frame) {
        setHint("That click missed the scan. Try a solid spot.");
        return;
      }
      frame.updateWorldMatrix(true, false);
      const site = frame.worldToLocal(hit.point.clone());
      if (pick.mode === "floor") {
        setAlignment({ ...alignment, y: alignment.y - site.y });
      } else if (pick.mode === "origin") {
        setAlignment({ ...alignment, x: alignment.x - site.x, z: alignment.z - site.z });
      } else {
        const local = mesh.worldToLocal(hit.point.clone());
        if (!pick.first) {
          setPick({ mode: "scale", first: { local, site } });
          setHint("Now click the second tape mark.");
          return;
        }
        const scanUnits = local.distanceTo(pick.first.local);
        const meters = Number(tapeLength);
        if (!(scanUnits > 1e-6) || !(meters > 0)) {
          setHint("Those marks can't set the scale. Check the distance and try again.");
          setPick(null);
          return;
        }
        setAlignment({ ...alignment, scale: meters / scanUnits });
      }
      setPick(null);
      setHint("");
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    document.body.style.cursor = "crosshair";
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [pick, mesh, gl, camera, alignment, tapeLength, setAlignment, setPick, setHint]);

  const marker = pick?.mode === "scale" ? pick.first?.site : undefined;
  return (
    <>
      <group ref={anchor} visible={visible} />
      {mesh && visible && <ScanWalk clear={clearRef} />}
      {marker && (
        <mesh position={marker} renderOrder={10} raycast={() => null}>
          <sphereGeometry args={[0.12, 16, 12]} />
          <meshBasicMaterial color="#f43f5e" depthTest={false} transparent />
        </mesh>
      )}
    </>
  );
}

const FIELDS: { key: keyof ScanAlignment; label: string; step: number; min?: number }[] = [
  { key: "x", label: "Along dock wall (m)", step: 0.1 },
  { key: "z", label: "Away from dock (m)", step: 0.1 },
  { key: "y", label: "Height (m)", step: 0.01 },
  { key: "yaw", label: "Turn (°)", step: 0.5 },
  { key: "pitch", label: "Tilt front/back (°)", step: 0.5 },
  { key: "roll", label: "Tilt sideways (°)", step: 0.5 },
  { key: "scale", label: "Scale", step: 0.01, min: 0.0001 },
];

function NumberField({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  const shown = useMemo(() => String(+value.toFixed(4)), [value]);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
      {label}
      <input
        type="number"
        step={step}
        min={min}
        value={draft ?? shown}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(v) && (min === undefined || v >= min)) onChange(v);
        }}
        onBlur={() => setDraft(null)}
        className="w-20 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right text-xs text-white"
      />
    </label>
  );
}

const BUTTON = "rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800";

/** Floating panel over the 3D view: open a scan and line it up with the warehouse. */
export function ScanPanel({ scan, stored }: { scan: ScanController; stored: number }) {
  const { file, status, alignment, visible, pick, hint, tapeLength, fit } = scan;
  const room = fit?.slots.length ?? 0;
  const input = useRef<HTMLInputElement>(null);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0];
    e.target.value = ""; // lets the same file be chosen again
    if (next) scan.open(next);
  };
  const ready = status.kind === "ready";

  return (
    <div className="absolute right-3 top-3 flex max-h-[calc(100%-4rem)] w-60 flex-col gap-2 overflow-y-auto rounded-lg border border-slate-700 bg-[#0d1433]/90 p-3 text-xs text-slate-200 shadow-lg">
      <input ref={input} type="file" accept={SCAN_EXTENSIONS.join(",")} onChange={onFile} className="hidden" aria-label="Open 3D scan file" />
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-white">3D scan</span>
        <button onClick={() => input.current?.click()} className={BUTTON}>
          {file ? "Replace" : "Open file"}
        </button>
      </div>

      {status.kind === "idle" && <p className="text-[11px] text-slate-400">Opens from this computer. The scan is not uploaded.</p>}
      {status.kind === "loading" && <p className="text-[11px] text-amber-300" role="status">Loading {file?.name}…</p>}
      {status.kind === "error" && <p className="text-[11px] text-rose-300" role="alert">{status.message}</p>}

      {ready && (
        <>
          <p className="truncate text-[11px] text-slate-400" title={file?.name}>
            {file?.name} · {status.splats.toLocaleString()} splats
          </p>
          <div className="flex gap-2">
            <button onClick={() => scan.setVisible(!visible)} className={`${BUTTON} flex-1`}>
              {visible ? "Show simulation" : "Show scan"}
            </button>
            <button onClick={scan.close} className={BUTTON}>Close</button>
          </div>
        </>
      )}

      {ready && visible && (
        <p className="text-[11px] text-slate-300">
          <b className="text-white">WASD</b> move · <b className="text-white">arrows</b> or <b className="text-white">drag</b> look · <b className="text-white">Q/E</b> down/up · <b className="text-white">Shift</b> faster
        </p>
      )}

      {ready && visible && fit && (
        <p className={`text-[11px] ${stored > room ? "text-amber-300" : "text-emerald-300"}`} role="status">
          {room === 0
            ? "No open floor found. Set the scale and floor level below."
            : stored > room
              ? `Only ${room.toLocaleString()} of ${stored.toLocaleString()} pallets fit on the open floor in this scan.`
              : `${stored.toLocaleString()} pallets placed. Open floor has room for ${room.toLocaleString()}.`}
        </p>
      )}

      {ready && visible && (
        <>
          <details className="border-t border-slate-700 pt-2">
          <summary className="cursor-pointer font-semibold text-white">Adjust alignment</summary>
          <div className="mt-2 flex flex-col gap-1.5">
            <label className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
              Tape distance (m)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={tapeLength}
                onChange={(e) => scan.setTapeLength(e.target.value)}
                className="w-20 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right text-xs text-white"
              />
            </label>
            <button onClick={() => scan.startPick("scale")} className={BUTTON}>1. Set scale from tape marks</button>
            <button onClick={() => scan.startPick("floor")} className={BUTTON}>2. Set floor level</button>
            <button onClick={() => scan.startPick("origin")} className={BUTTON}>3. Set building corner</button>
            {hint && <p className="text-[11px] text-amber-300" role="status">{hint}</p>}
            {pick && <button onClick={scan.cancelPick} className="self-start text-[11px] text-sky-400 hover:text-sky-300">Cancel</button>}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-slate-700 pt-2">
            {FIELDS.map((f) => (
              <NumberField
                key={f.key}
                label={f.label}
                value={alignment[f.key]}
                step={f.step}
                min={f.min}
                onChange={(v) => scan.setAlignment({ ...alignment, [f.key]: v })}
              />
            ))}
            <div className="flex gap-2 pt-1">
              <button onClick={() => scan.setAlignment({ ...alignment, pitch: (alignment.pitch + 180) % 360 })} className={`${BUTTON} flex-1`}>
                Flip upright
              </button>
              <button onClick={() => scan.setAlignment(DEFAULT_ALIGNMENT)} className={`${BUTTON} flex-1`}>
                Reset
              </button>
            </div>
          </div>
          </details>
        </>
      )}
    </div>
  );
}
