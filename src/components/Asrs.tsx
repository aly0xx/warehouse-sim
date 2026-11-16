"use client";

import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  CONVEYOR_W,
  FENCE_Z,
  LOOP_INNER_Z,
  LOOP_OUTER_Z,
  Customer,
  Layout,
  PALLET_DECK_H,
  Product,
  SlotContent,
  Stacks,
  WarehouseConfig,
  levelY,
  palletContents,
} from "@/lib/warehouse";

/**
 * Automated storage & retrieval equipment, in the site frame (dock wall at
 * z = 0), plus a material-flow simulation that plays out allocation changes:
 *
 *   allocate:  truck (docks 1 & 3) → dock conveyor → loop conveyor
 *              → aisle inbound P&D → stacker crane → the allocated slot
 *   remove:    crane fetches the pallet → aisle outbound P&D → loop conveyor
 *              → dock 2 conveyor → truck
 *
 * Nothing moves unless the allocation changes. Pallets only appear or vanish
 * inside a trailer; a slot fills in when its crane sets the pallet down, and a
 * removed pallet stays in the rack until its crane picks it up.
 *
 * The loop has an outer lane (dock side, flows -x) and an inner lane (rack
 * side, flows +x) joined at both ends.
 */

const noRaycast = () => null;
const CONVEYOR_TOP = 0.5; // conveyor surface height
const CRANE_COLOR = "#f59e0b";
const RAIL_COLOR = "#64748b";
const TRUCK_Z = -1.3; // pallet center inside a docked trailer
const BELT_SPEED = 0.8; // m/s
const SPACING = 1.05; // min distance between pallets on a conveyor (0.8 m long + gap)
const FORK_TO_PALLET = 0.12; // pallet underside above the crane lift origin
const MAX_FREE = 600; // instanced capacity for pallets on conveyors and forks

type V2 = [number, number];

interface Conveyor {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  alongX: boolean; // rollers perpendicular to x (pallets travel along x)
}

interface Route {
  pts: V2[];
  cum: number[]; // cumulative length at each point
  len: number;
}

function route(points: V2[]): Route {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** Point and unit direction at distance s along a route. */
function sample(r: Route, s: number, out: { x: number; z: number; dx: number; dz: number }) {
  const t = Math.min(Math.max(s, 0), r.len);
  let i = 1;
  while (i < r.pts.length - 1 && r.cum[i] < t) i++;
  const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i];
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const k = (t - r.cum[i - 1]) / seg;
  out.x = ax + (bx - ax) * k;
  out.z = az + (bz - az) * k;
  out.dx = (bx - ax) / seg;
  out.dz = (bz - az) / seg;
  return out;
}

interface AisleNet {
  x: number; // crane aisle center
  inX: number; // inbound P&D conveyor (head of the row on the left)
  outX: number; // outbound P&D conveyor (head of the row on the right)
  leftRow: number;
  rightRow: number;
  inbound: Route[]; // one route per inbound dock
  outbound: Route | null;
}

interface Network {
  conveyors: Conveyor[];
  aisles: AisleNet[];
  pdZ: number; // pallet center at the P&D end of the aisle conveyors
}

function buildNetwork(config: WarehouseConfig, layout: Layout): Network | null {
  if (!layout.aisles.length || !layout.cols.length) return null;
  const d = config.palletDepth;
  const half = CONVEYOR_W / 2;
  const zA = LOOP_OUTER_Z, zB = LOOP_INNER_Z;
  const spurZ0 = zB + half, spurZ1 = layout.rackZ0 - 0.15;
  const pdZ = spurZ1 - config.palletWidth / 2;
  const docks = layout.docks.map((k) => k.at);
  const rowAt = (x: number) => layout.rows.findIndex((r) => Math.abs(r.x - x) < 1e-6);

  const base = layout.aisles.map((a) => ({ x: (a.x0 + a.x1) / 2, inX: a.x0 - d / 2, outX: a.x1 + d / 2 }));
  const xs = [...base.flatMap((a) => [a.inX, a.outX]), ...docks];
  // The leftmost inbound conveyor continues the loop's left connector (+z) and
  // the rightmost outbound one feeds the right connector (-z).
  const X0 = Math.min(...xs), X1 = Math.max(...xs);

  const conveyors: Conveyor[] = [
    { x0: X0 - half, x1: X1 + half, z0: zA - half, z1: zA + half, alongX: true },
    { x0: X0 - half, x1: X1 + half, z0: zB - half, z1: zB + half, alongX: true },
    { x0: X0 - half, x1: X0 + half, z0: zA + half, z1: zB - half, alongX: false },
    { x0: X1 - half, x1: X1 + half, z0: zA + half, z1: zB - half, alongX: false },
    ...docks.map((x) => ({ x0: x - half, x1: x + half, z0: -0.3, z1: zA - half, alongX: false })),
    ...base.flatMap((a) => [
      { x0: a.inX - half, x1: a.inX + half, z0: spurZ0, z1: spurZ1, alongX: false },
      { x0: a.outX - half, x1: a.outX + half, z0: spurZ0, z1: spurZ1, alongX: false },
    ]),
  ];

  // Docks 1 and 3 receive, dock 2 ships (fall back to dock 1 for both).
  const inDocks = docks.length >= 3 ? [docks[0], docks[2]] : docks.slice(0, 1);
  const outDock = docks.length >= 2 ? docks[1] : docks[0];

  const aisles: AisleNet[] = base.map((a) => ({
    ...a,
    leftRow: rowAt(a.inX),
    rightRow: rowAt(a.outX),
    inbound: inDocks.map((dx) =>
      route([[dx, TRUCK_Z], [dx, zA], [X0, zA], [X0, zB], [a.inX, zB], [a.inX, pdZ]]),
    ),
    outbound:
      outDock === undefined
        ? null
        : route([[a.outX, pdZ], [a.outX, zB], [X1, zB], [X1, zA], [outDock, zA], [outDock, TRUCK_Z]]),
  }));
  return { conveyors, aisles, pdZ };
}

/** What the racks should show while pallets are in flight (consumed by the pallet renderer). */
export interface FlowView {
  warehouseId: string;
  hidden: Set<string>; // allocated slots whose pallet hasn't been stored yet
  ghosts: SlotContent[]; // removed pallets still in the rack, awaiting their crane
}

export interface FlowStats {
  inbound: number; // allocated pallets not yet stored
  outbound: number; // removed pallets not yet loaded onto the truck
}

export interface FlowProps {
  config: WarehouseConfig;
  layout: Layout;
  stacks: Stacks;
  customers: Customer[];
  products: Product[];
  warehouseId: string;
  /** How to show the latest stacks change: play it out, or apply instantly. */
  transition: "animate" | "snap";
  speed: number; // simulation time multiplier
  finishSignal: number; // bump to complete every movement instantly
  onView: (v: FlowView) => void;
  onStats: (s: FlowStats) => void;
}

export default function Asrs(props: FlowProps) {
  const { config, layout, warehouseId } = props;
  const net = useMemo(() => buildNetwork(config, layout), [config, layout]);
  if (!net) return null;
  const signature = `${warehouseId}|${layout.rows.length}:${layout.cols.length}:${layout.levels}:${config.width}:${config.length}`;
  return (
    <group>
      {net.conveyors.map((c, i) => (
        <ConveyorBelt key={i} c={c} />
      ))}
      <Fence config={config} gaps={net.conveyors.filter((c) => c.z0 < FENCE_Z && c.z1 > FENCE_Z)} />
      {/* A different warehouse or rack grid starts from a clean, settled state */}
      <FlowSim key={signature} {...props} net={net} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Simulation: plays out allocation changes, idle otherwise.

/** An allocated pallet on its way from a truck to its slot. */
interface InJob {
  content: SlotContent;
  aisle: number;
  side: -1 | 1; // which side of the aisle the slot is on
  z: number;
  cancelled: boolean; // removed before it was stored: store it, then send it back out
}

/** A removed pallet to fetch from its slot and ship. */
interface OutJob {
  content: SlotContent;
  side: -1 | 1;
  z: number;
}

interface Pallet {
  route: Route;
  s: number;
  blocked: number; // seconds spent blocked (deadlock breaker)
  content: SlotContent;
  job: InJob | null; // null = outbound
  aisle: number;
}

type Step =
  | { t: "move"; z: number; y: number }
  | { t: "fork"; to: number }
  | { t: "do"; fn: () => void }
  | { t: "until"; ok: () => boolean }
  | { t: "wait"; s: number };

interface CraneState {
  z: number;
  y: number;
  fork: number;
  carrying: { content: SlotContent; outbound: boolean; job?: InJob } | null;
  fetching: boolean; // on its way to collect a removed pallet (counts as outbound)
  steps: Step[];
  preferOut: boolean; // alternate between storing and retrieving when both are possible
}

interface CraneRefs {
  carriage: THREE.Group | null;
  lift: THREE.Group | null;
  forks: THREE.Group | null;
}

const MAX_INBOUND_PER_AISLE = 3; // pallets heading to one aisle at once (its P&D conveyor holds ~4)

function FlowSim({
  config,
  layout,
  stacks,
  customers,
  products,
  warehouseId,
  transition,
  speed,
  finishSignal,
  onView,
  onStats,
  net,
}: FlowProps & { net: Network }) {
  const pdY = CONVEYOR_TOP - FORK_TO_PALLET;
  const slotY = (level: number) => levelY(config, level) - FORK_TO_PALLET;
  const nC = layout.cols.length;
  const fullH = config.palletHeight - PALLET_DECK_H;

  // Which aisle (and side) serves each rack row.
  const rowAisle = useMemo(() => {
    const m = new Map<number, { aisle: number; side: -1 | 1 }>();
    net.aisles.forEach((a, i) => {
      m.set(a.leftRow, { aisle: i, side: -1 });
      m.set(a.rightRow, { aisle: i, side: 1 });
    });
    return m;
  }, [net]);

  const sim = useRef({
    pallets: [] as Pallet[],
    spawnQueue: [] as InJob[],
    inJobs: new Map<string, InJob[]>(), // slot key -> jobs not yet stored
    hidden: new Map<string, number>(), // slot key -> pallets still to arrive
    ghosts: new Map<string, SlotContent>(),
    outQueues: net.aisles.map(() => [] as OutJob[]),
    cranes: net.aisles.map(
      () => ({ z: net.pdZ, y: pdY, fork: 0, carrying: null, fetching: false, steps: [], preferOut: false }) as CraneState,
    ),
    nextDock: 0,
    prevStacks: null as Stacks | null,
    prevContents: new Map<string, SlotContent>(),
    viewDirty: true,
    lastStats: "",
  });
  const refs = useRef<CraneRefs[]>(net.aisles.map(() => ({ carriage: null, lift: null, forks: null })));
  const register = useCallback((i: number, part: keyof CraneRefs, g: THREE.Group | null) => {
    refs.current[i][part] = g;
  }, []);

  const emitView = useCallback(() => {
    const s = sim.current;
    s.viewDirty = false;
    onView({
      warehouseId,
      hidden: new Set([...s.hidden].filter(([, n]) => n > 0).map(([k]) => k)),
      ghosts: [...s.ghosts.values()],
    });
  }, [onView, warehouseId]);

  /** Drop everything in flight and show `contents` as settled. */
  const settle = useCallback(
    (contents: Map<string, SlotContent>) => {
      const s = sim.current;
      s.pallets = [];
      s.spawnQueue = [];
      s.inJobs.clear();
      s.hidden.clear();
      s.ghosts.clear();
      s.outQueues.forEach((q) => (q.length = 0));
      s.cranes = s.cranes.map((c) => ({ ...c, carrying: null, fetching: false, steps: [{ t: "move", z: net.pdZ, y: pdY }] }));
      s.prevContents = contents;
      emitView();
    },
    [emitView, net, pdY],
  );

  // Allocation changed: diff it against what we last saw and queue the moves.
  useEffect(() => {
    const s = sim.current;
    if (s.prevStacks === stacks) return;
    const first = s.prevStacks === null;
    s.prevStacks = stacks;
    const next = new Map(palletContents(stacks, customers, products, config).map((c) => [c.key, c]));
    if (first || transition === "snap") return settle(next);

    const locate = (c: SlotContent) => {
      const ra = rowAisle.get(Math.floor(c.p / nC));
      return ra ? { ...ra, z: layout.cols[c.p % nC] } : null;
    };
    const addOut = (c: SlotContent) => {
      const pending = s.inJobs.get(c.key)?.find((j) => !j.cancelled);
      if (pending) {
        s.hidden.set(c.key, (s.hidden.get(c.key) ?? 1) - 1);
        const queued = s.spawnQueue.indexOf(pending);
        if (queued >= 0) {
          // Hasn't left the truck yet: simply don't unload it.
          s.spawnQueue.splice(queued, 1);
          const rest = (s.inJobs.get(c.key) ?? []).filter((j) => j !== pending);
          if (rest.length) s.inJobs.set(c.key, rest);
          else s.inJobs.delete(c.key);
        } else {
          // Already on its way in: let it be stored, then bring it back out.
          pending.cancelled = true;
        }
        return;
      }
      const loc = locate(c);
      if (!loc) return;
      s.ghosts.set(c.key, c);
      s.outQueues[loc.aisle].push({ content: c, side: loc.side, z: loc.z });
    };
    const addIn = (c: SlotContent) => {
      const loc = locate(c);
      if (!loc) return;
      const job: InJob = { content: c, aisle: loc.aisle, side: loc.side, z: loc.z, cancelled: false };
      s.inJobs.set(c.key, [...(s.inJobs.get(c.key) ?? []), job]);
      s.hidden.set(c.key, (s.hidden.get(c.key) ?? 0) + 1);
      s.spawnQueue.push(job);
    };
    for (const [key, prev] of s.prevContents) {
      const now = next.get(key);
      if (!now || now.customerId !== prev.customerId) addOut(prev);
    }
    for (const [key, now] of next) {
      const prev = s.prevContents.get(key);
      if (!prev || prev.customerId !== now.customerId) addIn(now);
    }
    s.prevContents = next;
    emitView();
  }, [stacks, customers, products, config, transition, settle, emitView, rowAisle, nC, layout.cols]);

  // "Finish now": complete every pending movement instantly.
  const lastFinish = useRef(finishSignal);
  useEffect(() => {
    if (lastFinish.current === finishSignal) return;
    lastFinish.current = finishSignal;
    settle(sim.current.prevContents);
  }, [finishSignal, settle]);

  const baseMesh = useRef<THREE.InstancedMesh>(null);
  const loadMesh = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(
    () => ({ o: new THREE.Object3D(), c: new THREE.Color(), p: { x: 0, z: 0, dx: 0, dz: 0 }, q: { x: 0, z: 0, dx: 0, dz: 0 } }),
    [],
  );

  useFrame((_, dtRaw) => {
    const s = sim.current;
    const { p, q } = tmp;
    const total = Math.min(dtRaw, 0.1) * speed;
    const n = Math.max(1, Math.ceil(total / 0.05));
    for (let k = 0; k < n; k++) step(total / n);

    function clearAt(x: number, z: number, d: number) {
      return s.pallets.every((pl) => {
        sample(pl.route, pl.s, q);
        return Math.hypot(q.x - x, q.z - z) > d;
      });
    }

    function step(dt: number) {
      // --- Release queued inbound pallets from the receiving trucks.
      if (s.spawnQueue.length) {
        const busy = new Array(net.aisles.length).fill(0);
        for (const pl of s.pallets) if (pl.job) busy[pl.aisle]++;
        const idx = s.spawnQueue.findIndex((j) => busy[j.aisle] < MAX_INBOUND_PER_AISLE);
        if (idx >= 0) {
          const job = s.spawnQueue[idx];
          const routes = net.aisles[job.aisle].inbound;
          if (routes.length) {
            const r = routes[s.nextDock % routes.length];
            if (clearAt(r.pts[0][0], r.pts[0][1], SPACING + 0.2)) {
              s.spawnQueue.splice(idx, 1);
              s.nextDock++;
              s.pallets.push({ route: r, s: 0, blocked: 0, content: job.content, job, aisle: job.aisle });
            }
          }
        }
      }

      // --- Move conveyor pallets, keeping their spacing.
      const pos = s.pallets.map((x) => sample(x.route, x.s, { x: 0, z: 0, dx: 0, dz: 0 }));
      s.pallets.forEach((pl, i) => {
        if (pl.s >= pl.route.len) return; // waiting at the end
        const me = pos[i];
        let blocked = false;
        for (let j = 0; j < pos.length && !blocked; j++) {
          if (j === i) continue;
          const vx = pos[j].x - me.x, vz = pos[j].z - me.z;
          const dist = Math.hypot(vx, vz);
          // Someone close and roughly straight ahead (±45°) blocks us.
          if (dist < SPACING && vx * me.dx + vz * me.dz > 0.7 * dist) blocked = true;
        }
        if (blocked && pl.blocked < 6) {
          pl.blocked += dt;
          return;
        }
        pl.blocked = 0;
        pl.s = Math.min(pl.route.len, pl.s + BELT_SPEED * dt);
      });
      // Outbound pallets that reached the shipping trailer are loaded.
      s.pallets = s.pallets.filter((x) => x.job || x.s < x.route.len);

      // --- Cranes.
      net.aisles.forEach((a, i) => {
        const c = s.cranes[i];
        if (!c.steps.length) plan(i, a, c);
        const st = c.steps[0];
        if (!st) return;
        const mv = (v: number, t: number, sp: number) => (Math.abs(t - v) <= sp * dt ? t : v + Math.sign(t - v) * sp * dt);
        switch (st.t) {
          case "move":
            if (c.fork !== 0) c.fork = mv(c.fork, 0, 1.6);
            else {
              c.z = mv(c.z, st.z, 3.2);
              c.y = mv(c.y, st.y, 1.1);
              if (c.z === st.z && c.y === st.y) c.steps.shift();
            }
            break;
          case "fork":
            c.fork = mv(c.fork, st.to, 1.6);
            if (c.fork === st.to) c.steps.shift();
            break;
          case "do":
            st.fn();
            c.steps.shift();
            break;
          case "until":
            if (st.ok()) c.steps.shift();
            break;
          case "wait":
            st.s -= dt;
            if (st.s <= 0) c.steps.shift();
            break;
        }
      });
    }

    function plan(i: number, a: AisleNet, c: CraneState) {
      const waiting = s.pallets.find((x) => x.job && x.aisle === i && x.s >= x.route.len);
      // A removed pallet may still occupy the slot this one is going to.
      const blocked = !!waiting && s.ghosts.has(waiting.content.key);
      const out = s.outQueues[i][0];
      const out0 = a.outbound?.pts[0];
      const outOk = !!out && !!out0 && clearAt(out0[0], out0[1], SPACING);
      const canStore = !!waiting && !blocked;

      if (outOk && (!canStore || c.preferOut || blocked)) {
        c.preferOut = false;
        const job = s.outQueues[i].shift()!;
        const route = a.outbound!;
        c.fetching = true;
        c.steps.push(
          { t: "move", z: job.z, y: slotY(job.content.level) },
          { t: "fork", to: job.side },
          {
            t: "do",
            fn: () => {
              s.ghosts.delete(job.content.key);
              c.fetching = false;
              c.carrying = { content: job.content, outbound: true };
              s.viewDirty = true;
            },
          },
          { t: "move", z: net.pdZ, y: pdY },
          { t: "until", ok: () => clearAt(route.pts[0][0], route.pts[0][1], SPACING) },
          { t: "fork", to: 1 },
          {
            t: "do",
            fn: () => {
              s.pallets.push({ route, s: 0, blocked: 0, content: job.content, job: null, aisle: i });
              c.carrying = null;
            },
          },
          { t: "fork", to: 0 },
        );
        return;
      }
      if (canStore) {
        c.preferOut = true;
        const pallet = waiting!;
        const job = pallet.job!;
        c.steps.push(
          { t: "move", z: net.pdZ, y: pdY },
          { t: "fork", to: -1 },
          {
            t: "do",
            fn: () => {
              s.pallets = s.pallets.filter((x) => x !== pallet);
              c.carrying = { content: job.content, outbound: false, job };
            },
          },
          { t: "move", z: job.z, y: slotY(job.content.level) },
          { t: "fork", to: job.side },
          {
            t: "do",
            fn: () => {
              c.carrying = null;
              const key = job.content.key;
              const rest = (s.inJobs.get(key) ?? []).filter((j) => j !== job);
              if (rest.length) s.inJobs.set(key, rest);
              else s.inJobs.delete(key);
              if (job.cancelled) {
                // Removed while in transit: it goes straight back out.
                s.ghosts.set(key, job.content);
                s.outQueues[i].unshift({ content: job.content, side: job.side, z: job.z });
              } else {
                const left = (s.hidden.get(key) ?? 1) - 1;
                if (left > 0) s.hidden.set(key, left);
                else s.hidden.delete(key);
              }
              s.viewDirty = true;
            },
          },
          { t: "fork", to: 0 },
        );
        return;
      }
      // Nothing to do: park at the P&D station.
      if (c.z !== net.pdZ || c.y !== pdY) c.steps.push({ t: "move", z: net.pdZ, y: pdY });
      else c.steps.push({ t: "wait", s: 0.25 });
    }

    // --- Push crane poses to their meshes.
    net.aisles.forEach((a, i) => {
      const c = s.cranes[i], r = refs.current[i];
      if (r.carriage) r.carriage.position.z = c.z;
      if (r.lift) r.lift.position.y = c.y;
      if (r.forks) r.forks.position.x = c.fork * (a.x - a.inX);
    });

    // --- Draw pallets on conveyors and on crane forks, in their customer's color.
    const b = baseMesh.current, l = loadMesh.current;
    if (b && l) {
      const { o, c: col } = tmp;
      let count = 0;
      const put = (x: number, yBottom: number, z: number, content: SlotContent) => {
        if (count >= MAX_FREE) return;
        const pt = content.pattern;
        const h = pt && content.boxes > 0 ? Math.min(fullH, Math.ceil(content.boxes / pt.perLayer) * pt.bh) : fullH * 0.75;
        o.scale.set(1, 1, 1);
        o.position.set(x, yBottom + PALLET_DECK_H / 2, z);
        o.updateMatrix();
        b.setMatrixAt(count, o.matrix);
        o.position.set(x, yBottom + PALLET_DECK_H + h / 2, z);
        o.scale.set(config.palletDepth - 0.06, h, config.palletWidth - 0.06);
        o.updateMatrix();
        l.setMatrixAt(count, o.matrix);
        l.setColorAt(count, col.set(content.color));
        count++;
      };
      for (const pl of s.pallets) {
        sample(pl.route, pl.s, p);
        put(p.x, CONVEYOR_TOP, p.z, pl.content);
      }
      net.aisles.forEach((a, i) => {
        const c = s.cranes[i];
        if (c.carrying) put(a.x + c.fork * (a.x - a.inX), c.y + FORK_TO_PALLET, c.z, c.carrying.content);
      });
      b.count = l.count = count;
      b.instanceMatrix.needsUpdate = true;
      l.instanceMatrix.needsUpdate = true;
      if (l.instanceColor) l.instanceColor.needsUpdate = true;
    }

    if (s.viewDirty) emitView();
    const busy = s.cranes.filter((c) => c.carrying);
    const stats: FlowStats = {
      inbound:
        s.spawnQueue.length +
        s.pallets.filter((x) => x.job && !x.job.cancelled).length +
        busy.filter((c) => !c.carrying!.outbound && !c.carrying!.job?.cancelled).length,
      outbound:
        s.outQueues.reduce((n, q) => n + q.length, 0) +
        s.pallets.filter((x) => !x.job || x.job.cancelled).length +
        busy.filter((c) => c.carrying!.outbound || c.carrying!.job?.cancelled).length +
        s.cranes.filter((c) => c.fetching).length,
    };
    const key = `${stats.inbound}/${stats.outbound}`;
    if (key !== s.lastStats) {
      s.lastStats = key;
      onStats(stats);
    }
  });

  const mastTop = Math.min(rackTop(config, layout) + 0.4, config.ceilingHeight - 0.25);
  return (
    <group>
      {net.aisles.map((a, i) => (
        <Crane
          key={i}
          config={config}
          x={a.x}
          zPD={net.pdZ}
          pdY={pdY}
          railZ0={layout.rackZ0 - 1.8}
          mastTop={mastTop}
          register={(part, g) => register(i, part, g)}
        />
      ))}
      {/* Pallets in flight: rewritten every frame, so skip culling */}
      <instancedMesh ref={baseMesh} args={[undefined, undefined, MAX_FREE]} castShadow frustumCulled={false} raycast={noRaycast}>
        <boxGeometry args={[config.palletDepth, PALLET_DECK_H, config.palletWidth]} />
        <meshStandardMaterial color="#c08a52" roughness={0.85} />
      </instancedMesh>
      <instancedMesh ref={loadMesh} args={[undefined, undefined, MAX_FREE]} castShadow frustumCulled={false} raycast={noRaycast}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
    </group>
  );
}

/** Height of the rack structure (matches Racking). */
function rackTop(config: WarehouseConfig, layout: Layout) {
  return layout.levels >= 2 ? levelY(config, layout.levels - 1) + config.palletHeight * 0.6 : config.palletHeight;
}

function Box({
  p,
  s,
  color,
  metal = 0.4,
  rough = 0.5,
}: {
  p: [number, number, number];
  s: [number, number, number];
  color: string;
  metal?: number;
  rough?: number;
}) {
  return (
    <mesh position={p} castShadow receiveShadow raycast={noRaycast}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} metalness={metal} roughness={rough} />
    </mesh>
  );
}

/** Stacker crane geometry; its pose is driven by FlowSim through `refs`. */
function Crane({
  config,
  x,
  zPD,
  pdY,
  railZ0,
  mastTop,
  register,
}: {
  config: WarehouseConfig;
  x: number;
  zPD: number;
  pdY: number;
  railZ0: number;
  mastTop: number;
  register: (part: keyof CraneRefs, g: THREE.Group | null) => void;
}) {
  const railZ1 = config.length - 0.6;
  const mastH = mastTop - 0.55;
  return (
    <group position={[x, 0, 0]}>
      {/* Floor rail and top guide rail along the whole aisle */}
      <Box p={[0, 0.06, (railZ0 + railZ1) / 2]} s={[0.12, 0.12, railZ1 - railZ0]} color={RAIL_COLOR} metal={0.8} />
      <Box p={[0, mastTop + 0.12, (railZ0 + railZ1) / 2]} s={[0.16, 0.12, railZ1 - railZ0]} color={RAIL_COLOR} metal={0.8} />
      {/* End stops */}
      <Box p={[0, 0.3, railZ0]} s={[0.5, 0.4, 0.2]} color="#dc2626" />
      <Box p={[0, 0.3, railZ1]} s={[0.5, 0.4, 0.2]} color="#dc2626" />

      <group ref={(g) => register("carriage", g)} position={[0, 0, zPD]}>
        {/* Bottom carriage with drive, top carriage, twin mast */}
        <Box p={[0, 0.35, 0.55]} s={[0.55, 0.5, 2.3]} color={CRANE_COLOR} />
        <Box p={[0, 0.35, 1.55]} s={[0.5, 0.42, 0.5]} color="#1f2937" />
        <Box p={[0, mastTop - 0.12, 0.6]} s={[0.4, 0.24, 1.6]} color={CRANE_COLOR} />
        <Box p={[0, 0.6 + mastH / 2, 0.75]} s={[0.36, mastH, 0.32]} color={CRANE_COLOR} />
        <Box p={[0, 0.6 + mastH / 2, -0.62]} s={[0.12, mastH, 0.12]} color={CRANE_COLOR} />
        <Box p={[0.19, 0.6 + mastH / 2, 0.75]} s={[0.02, mastH, 0.26]} color="#92400e" metal={0.2} />

        {/* Lifting carriage: frame against the mast, telescopic forks (carried pallets are drawn by FlowSim) */}
        <group ref={(g) => register("lift", g)} position={[0, pdY, 0]}>
          <Box p={[0, 0.45, 0.5]} s={[0.95, 0.9, 0.12]} color="#d97706" />
          <Box p={[0, 0.03, 0]} s={[0.95, 0.06, 0.95]} color="#334155" metal={0.7} />
          <group ref={(g) => register("forks", g)}>
            <Box p={[0, FORK_TO_PALLET - 0.025, -0.2]} s={[1.1, 0.05, 0.14]} color="#94a3b8" metal={0.8} />
            <Box p={[0, FORK_TO_PALLET - 0.025, 0.2]} s={[1.1, 0.05, 0.14]} color="#94a3b8" metal={0.8} />
          </group>
        </group>
      </group>
    </group>
  );
}

/** Roller-pattern texture (cloned per conveyor for its repeat). */
function makeRollerTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, 64, 16);
  const g = ctx.createLinearGradient(0, 0, 0, 12);
  g.addColorStop(0, "#e2e8f0");
  g.addColorStop(0.5, "#94a3b8");
  g.addColorStop(1, "#475569");
  ctx.fillStyle = g;
  ctx.fillRect(4, 1, 56, 11);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function ConveyorBelt({ c }: { c: Conveyor }) {
  const lx = c.x1 - c.x0, lz = c.z1 - c.z0;
  const along = c.alongX ? lx : lz;
  const tex = useMemo(() => {
    const t = makeRollerTexture();
    // One roller every 12 cm along the flow; rollers span the belt width.
    if (c.alongX) {
      t.rotation = Math.PI / 2;
      t.center.set(0.5, 0.5);
    }
    t.repeat.set(1, along / 0.12);
    return t;
  }, [c.alongX, along]);
  useEffect(() => () => tex.dispose(), [tex]);
  const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
  const legs: V2[] = [];
  const n = Math.max(2, Math.ceil(along / 1.5) + 1);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (c.alongX) for (const z of [c.z0 + 0.06, c.z1 - 0.06]) legs.push([c.x0 + 0.06 + t * (lx - 0.12), z]);
    else for (const x of [c.x0 + 0.06, c.x1 - 0.06]) legs.push([x, c.z0 + 0.06 + t * (lz - 0.12)]);
  }
  return (
    <group>
      <mesh position={[cx, CONVEYOR_TOP, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[lx, lz]} />
        <meshStandardMaterial map={tex} metalness={0.6} roughness={0.45} />
      </mesh>
      {c.alongX ? (
        <>
          <Box p={[cx, CONVEYOR_TOP - 0.06, c.z0 + 0.03]} s={[lx, 0.16, 0.06]} color="#2563eb" />
          <Box p={[cx, CONVEYOR_TOP - 0.06, c.z1 - 0.03]} s={[lx, 0.16, 0.06]} color="#2563eb" />
        </>
      ) : (
        <>
          <Box p={[c.x0 + 0.03, CONVEYOR_TOP - 0.06, cz]} s={[0.06, 0.16, lz]} color="#2563eb" />
          <Box p={[c.x1 - 0.03, CONVEYOR_TOP - 0.06, cz]} s={[0.06, 0.16, lz]} color="#2563eb" />
        </>
      )}
      {legs.map(([x, z], i) => (
        <Box key={i} p={[x, (CONVEYOR_TOP - 0.14) / 2, z]} s={[0.06, CONVEYOR_TOP - 0.14, 0.06]} color="#475569" />
      ))}
    </group>
  );
}

/** Mesh safety fence across the pre-zone, with openings where conveyors pass through. */
function Fence({ config, gaps }: { config: WarehouseConfig; gaps: Conveyor[] }) {
  const panels = useMemo(() => {
    const H = 2.2;
    const open = gaps.map((g) => [g.x0 - 0.15, g.x1 + 0.15] as const).sort((a, b) => a[0] - b[0]);
    const segs: V2[] = [];
    let x = 0.6;
    for (const [a, b] of open) {
      if (a > x) segs.push([x, a]);
      x = Math.max(x, b);
    }
    if (config.width - 0.6 > x) segs.push([x, config.width - 0.6]);
    return { H, segs: segs.filter(([a, b]) => b - a > 0.2) };
  }, [config.width, gaps]);
  return (
    <group>
      {panels.segs.map(([a, b], i) => {
        const posts: number[] = [];
        const n = Math.max(1, Math.ceil((b - a) / 2));
        for (let k = 0; k <= n; k++) posts.push(a + ((b - a) * k) / n);
        return (
          <group key={i}>
            <mesh position={[(a + b) / 2, panels.H / 2 + 0.1, FENCE_Z]} raycast={noRaycast}>
              <planeGeometry args={[b - a, panels.H - 0.2]} />
              <meshStandardMaterial color="#cbd5e1" transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} metalness={0.6} />
            </mesh>
            <Box p={[(a + b) / 2, panels.H, FENCE_Z]} s={[b - a, 0.05, 0.05]} color="#facc15" />
            {posts.map((px, k) => (
              <Box key={k} p={[px, panels.H / 2, FENCE_Z]} s={[0.06, panels.H, 0.06]} color="#facc15" />
            ))}
          </group>
        );
      })}
    </group>
  );
}
