// Core warehouse model: layout computation + compact pallet allocation.
//
// The warehouse is an automated storage & retrieval system (AS/RS): tall
// selective racking served by one rail-guided stacker crane per narrow aisle.
// Aisles run the full rack length (cranes can't cross them), and a pre-zone
// at the dock end holds a loop conveyor that moves pallets between the docks
// and each aisle's inbound/outbound pick-up & drop-off (P&D) conveyors.
//
// Layout coordinates use a "site frame" (meters): the dock wall is always
// z = 0, x runs along the dock wall, z runs away from it along the aisles, and
// y is up. The docks sit on the building's short wall, so the frame is the
// world rotated 90° when the warehouse is wider than it is long; see
// `frameToWorld`. Origin is the warehouse corner; the 3D scene recenters it.

export interface WarehouseConfig {
  width: number; // m, world x extent
  length: number; // m, world z extent
  ceilingHeight: number; // m
  maxStack: number; // max rack levels
  aisleWidth: number; // m, stacker-crane aisle between rack rows
  palletWidth: number; // m, pallet face along the row (z)
  palletDepth: number; // m, pallet depth into the row (x)
  palletHeight: number; // m, loaded pallet height
}

export const DEFAULT_CONFIG: WarehouseConfig = {
  width: 40,
  length: 60,
  ceilingHeight: 15,
  maxStack: 20,
  aisleWidth: 1.6,
  // EUR pallet (EN 13698-1), 1200 × 800 mm: 0.8 m face on the beam, 1.2 m deep.
  palletWidth: 0.8,
  palletDepth: 1.2,
  palletHeight: 1.5,
};

/** Narrowest crane aisle: pallet depth plus running clearance. */
export const MIN_CRANE_AISLE = 1.4;

export const WALL_MARGIN = 0.5; // clearance from walls
export const PALLET_GAP = 0.1; // gap between neighbouring pallets in a row
export const FLUE_GAP = 0.2; // gap between back-to-back rows
export const CEILING_CLEARANCE = 0.5; // sprinkler / safety clearance

// Selective pallet racking: pallets sit on steel beams + decking at each level.
export const BEAM_HEIGHT = 0.12; // beam profile height
export const LIFT_CLEARANCE = 0.13; // gap above a pallet for the crane forks to lift it
export const BAY_PALLETS = 3; // pallets per bay between two upright frames

// Pre-zone (site frame z, from the dock wall inward).
export const DOCK_ZONE_DEPTH = 2.4; // staging box inside each door
export const CONVEYOR_W = 1.0; // conveyor width
// Loop conveyor: two parallel lanes joined at both ends.
export const LOOP_OUTER_Z = 3.6; // lane on the dock side (flows -x)
export const LOOP_INNER_Z = 4.8; // lane on the rack side (flows +x)
export const FENCE_Z = 5.7; // safety fence closing off the crane zone
export const RACK_START = 9.5; // first rack bay face
export const CRANE_RUNOUT = 1.2; // crane end-of-aisle clearance at the back wall

/** Vertical distance between rack levels. */
export function levelPitch(c: WarehouseConfig) {
  return c.palletHeight + LIFT_CLEARANCE + BEAM_HEIGHT;
}
/** Height of the surface a pallet at `level` rests on (0 = floor, else beam top). */
export function levelY(c: WarehouseConfig, level: number) {
  return level * levelPitch(c);
}

export interface RowInfo {
  x: number; // center x of the row
  facing: -1 | 1; // which side its crane aisle is on
}

export interface Span {
  x0: number;
  x1: number;
}

export interface Layout {
  /** Site frame size and orientation (see header comment). */
  frame: { width: number; length: number; rotated: boolean };
  rows: RowInfo[];
  cols: number[]; // center z of each column
  levels: number;
  positions: number; // rows * cols (floor positions)
  capacity: number; // positions * levels
  aisles: Span[]; // crane aisles; every aisle has a rack row on both sides
  bays: { z0: number; z1: number }[]; // rack bays along each row (same for every row)
  rackZ0: number; // rack block extent along z
  rackZ1: number;
  docks: Dock[];
}

/** Loading dock door on the dock wall (site frame z = 0); `at` is its center x. */
export interface Dock {
  at: number;
  width: number; // door opening width
  height: number; // door opening height
  depth: number; // staging zone depth painted inside the door
}

export const DOCK_COUNT = 3;

function computeDocks(edge: number, ceiling: number): Dock[] {
  const width = Math.min(3, edge / DOCK_COUNT - 0.6);
  if (width < 1) return [];
  const height = Math.min(3.6, ceiling - 0.5);
  return Array.from({ length: DOCK_COUNT }, (_, i) => ({
    at: (edge * (i + 1)) / (DOCK_COUNT + 1),
    width,
    height,
    depth: DOCK_ZONE_DEPTH,
  }));
}

/** Map a site-frame point to warehouse world coordinates (corner origin). */
export function frameToWorld(layout: Layout, x: number, z: number): [number, number] {
  return layout.frame.rotated ? [z, layout.frame.width - x] : [x, z];
}

/** Row name: A, B, … Z, AA, AB, … */
export function rowName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Column name: 01, 02, … */
export function colName(i: number): string {
  return String(i + 1).padStart(2, "0");
}

export function computeLayout(config: WarehouseConfig): Layout {
  // Work in the site frame: dock wall (the short side) along x at z = 0.
  const rotated = config.width > config.length;
  const W = rotated ? config.length : config.width;
  const L = rotated ? config.width : config.length;
  const c = config;
  const d = c.palletDepth;
  const aisleW = Math.max(MIN_CRANE_AISLE, c.aisleWidth);
  const maxX = W - WALL_MARGIN;

  // Across the dock wall: | row | aisle | row row | aisle | row row | … | aisle | row |
  // Single rows against the walls, back-to-back pairs between aisles, so every
  // crane aisle serves a rack row on each side.
  const rows: RowInfo[] = [];
  const aisles: Span[] = [];
  let x = WALL_MARGIN;
  if (x + d + aisleW + d <= maxX) {
    rows.push({ x: x + d / 2, facing: 1 });
    x += d;
    while (x + aisleW + d <= maxX) {
      aisles.push({ x0: x, x1: x + aisleW });
      x += aisleW;
      rows.push({ x: x + d / 2, facing: -1 });
      x += d;
      // Back-to-back partner only if its own aisle and far row also fit.
      if (x + FLUE_GAP + d + aisleW + d > maxX) break;
      x += FLUE_GAP;
      rows.push({ x: x + d / 2, facing: 1 });
      x += d;
    }
  }

  // Columns: one continuous rack run from the pre-zone to the back wall.
  const cols: number[] = [];
  const maxZ = L - WALL_MARGIN - CRANE_RUNOUT;
  for (let z = RACK_START; z + c.palletWidth <= maxZ; z += c.palletWidth + PALLET_GAP) cols.push(z + c.palletWidth / 2);
  if (!aisles.length) rows.length = 0;

  // Rack levels: the top pallet (resting on its beam) must clear the ceiling.
  const usable = Math.max(0, c.ceilingHeight - CEILING_CLEARANCE);
  const fit = usable >= c.palletHeight ? Math.floor((usable - c.palletHeight) / levelPitch(c)) + 1 : 0;
  const levels = cols.length && rows.length ? Math.max(0, Math.min(c.maxStack, fit)) : 0;

  // Split the run into bays of BAY_PALLETS between upright frames.
  const bays: { z0: number; z1: number }[] = [];
  for (let b = 0; b < cols.length; b += BAY_PALLETS) {
    const last = Math.min(b + BAY_PALLETS, cols.length) - 1;
    bays.push({
      z0: cols[b] - c.palletWidth / 2 - PALLET_GAP / 2,
      z1: cols[last] + c.palletWidth / 2 + PALLET_GAP / 2,
    });
  }

  const docks = computeDocks(W, c.ceilingHeight);
  const positions = rows.length * cols.length;
  return {
    frame: { width: W, length: L, rotated },
    rows,
    cols,
    levels,
    positions,
    capacity: positions * levels,
    aisles,
    bays,
    rackZ0: bays[0]?.z0 ?? RACK_START,
    rackZ1: bays[bays.length - 1]?.z1 ?? RACK_START,
    docks,
  };
}

// ---------------------------------------------------------------------------
// Storage state: each floor position has one slot per rack level (null = empty).

export interface Customer {
  id: string;
  name: string;
  productId: string; // every pallet of this allocation holds only this product
  pallets: number; // pallets allocated (the input)
  boxes: number; // derived: pallets × boxes per full pallet
  color: string;
  placed: boolean; // false if it could not be re-placed after a resize
}

// ---------------------------------------------------------------------------
// Products: a carton size, packed onto pallets in a fixed column-stack pattern.

export interface Product {
  id: string;
  name: string;
  length: number; // carton dimensions, cm
  width: number;
  height: number;
  print?: CartonPrint; // what's printed on the carton in the 3D scan view
}

export interface CartonPrint {
  title: string;
  titleAr?: string;
  pack: string;
  ink: string;
}

export const DEFAULT_PRODUCT: Product = {
  id: "standard-carton",
  name: "Standard carton",
  length: 40,
  width: 30,
  height: 30,
};

/** Sold in Egypt as 6 × 1 L. The case size is an estimate, not a manufacturer figure. */
export const JUHAYNA_MILK: Product = {
  id: "juhayna-full-cream-milk-6x1l",
  name: "Juhayna Full Cream Milk 6 × 1 L",
  length: 30,
  width: 20,
  height: 20,
  print: { title: "JUHAYNA FULL CREAM MILK", titleAr: "جهينة لبن كامل الدسم", pack: "6 × 1 L", ink: "#17406d" },
};

export const PALLET_DECK_H = 0.15; // wooden pallet deck height, m

export interface PalletPattern {
  nx: number; // cartons across the pallet depth (x)
  nz: number; // cartons along the pallet face (z)
  layers: number;
  perLayer: number;
  perPallet: number;
  bx: number; // carton footprint as placed, m
  bz: number;
  bh: number; // carton height, m
}

/**
 * Best way to stack a carton on a pallet: try both flat orientations
 * (this side up — no tipping), keep the one with more cartons per layer, and
 * stack as many layers as fit under the loaded pallet height.
 * Returns null if not even one carton fits.
 */
export function palletPattern(p: Product, c: WarehouseConfig): PalletPattern | null {
  const l = p.length / 100, w = p.width / 100, h = p.height / 100;
  if (!(l > 0 && w > 0 && h > 0)) return null;
  const eps = 1e-6;
  const fit = (a: number, b: number) => ({
    nx: Math.floor(c.palletDepth / a + eps),
    nz: Math.floor(c.palletWidth / b + eps),
    bx: a,
    bz: b,
  });
  const o1 = fit(l, w), o2 = fit(w, l);
  const best = o2.nx * o2.nz > o1.nx * o1.nz ? o2 : o1;
  const layers = Math.floor((c.palletHeight - PALLET_DECK_H) / h + eps);
  const perLayer = best.nx * best.nz;
  if (perLayer === 0 || layers === 0) return null;
  return { ...best, layers, perLayer, perPallet: perLayer * layers, bh: h };
}

/** Cartons on `pallets` full pallets of a product (0 if the carton doesn't fit). */
export function boxesFor(pallets: number, pattern: PalletPattern | null) {
  return pattern ? pallets * pattern.perPallet : 0;
}

/** stacks[row * cols + col][level] = customer id or null. */
export type Stacks = (string | null)[][];

export function emptyStacks(layout: Layout): Stacks {
  return Array.from({ length: layout.positions }, () => Array(layout.levels).fill(null));
}

export function countPallets(stacks: Stacks) {
  let n = 0;
  for (const s of stacks) for (const id of s) if (id !== null) n++;
  return n;
}

/** Penalty (m per pallet) for sharing a rack column with another customer. */
const MIXED_STACK_PENALTY = 1.5;
/** Small per-level cost so lower levels are filled first. */
const LEVEL_COST = 0.05;

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop()!, lastV = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && k[r] < k[l] ? r : l;
        if (k[m] >= lastK) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

/**
 * Find `count` free slots that are as close together as possible.
 *
 * For every floor position with free space we grow a region outward in order
 * of physical distance (a best-first flood over the row/column grid) until it
 * holds enough free slots. The region's cost is the summed distance of each
 * pallet to the seed (plus small penalties for higher levels and for sharing a
 * stack with another customer). The cheapest region wins. Aisles are accounted
 * for automatically because distances use real coordinates.
 *
 * Returns the list of position indices (one entry per pallet) or null.
 */
export function findCompactSlots(
  layout: Layout,
  stacks: Stacks,
  count: number,
): number[] | null {
  const { rows, cols, levels } = layout;
  const nR = rows.length, nC = cols.length, P = nR * nC;
  if (count <= 0 || levels === 0) return null;

  const free = new Int32Array(P);
  let totalFree = 0;
  for (let p = 0; p < P; p++) {
    free[p] = stacks[p].reduce((n, id) => (id === null ? n + 1 : n), 0);
    totalFree += free[p];
  }
  if (totalFree < count) return null;

  const visited = new Int32Array(P); // stamp per seed, avoids clearing
  let best = Infinity;
  let bestSeed = -1;

  const slotCost = (p: number, dist: number, k: number) => {
    // k = index of pallet within this column's free levels (0 = lowest free)
    const h = levels - free[p] + k; // approx. level; exact when filled bottom-up
    const mixed = free[p] < levels ? MIXED_STACK_PENALTY : 0;
    return dist + mixed + h * LEVEL_COST;
  };

  const grow = (seed: number, stamp: number, bound: number, out?: number[]) => {
    const sr = (seed / nC) | 0, sc = seed % nC;
    const sx = rows[sr].x, sz = cols[sc];
    const heap = new MinHeap();
    heap.push(0, seed);
    visited[seed] = stamp;
    let need = count;
    let cost = 0;
    while (need > 0 && heap.size) {
      const [d, p] = heap.pop();
      if (cost + need * d >= bound) return Infinity; // can't beat best
      const f = free[p];
      if (f > 0) {
        const take = Math.min(f, need);
        for (let k = 0; k < take; k++) {
          cost += slotCost(p, d, k);
          out?.push(p);
        }
        need -= take;
      }
      const r = (p / nC) | 0, c = p % nC;
      const push = (q: number, qr: number, qc: number) => {
        if (visited[q] === stamp) return;
        visited[q] = stamp;
        const dx = rows[qr].x - sx, dz = cols[qc] - sz;
        heap.push(Math.sqrt(dx * dx + dz * dz), q);
      };
      if (r > 0) push(p - nC, r - 1, c);
      if (r < nR - 1) push(p + nC, r + 1, c);
      if (c > 0) push(p - 1, r, c - 1);
      if (c < nC - 1) push(p + 1, r, c + 1);
    }
    return need > 0 ? Infinity : cost;
  };

  let stamp = 0;
  for (let s = 0; s < P; s++) {
    if (free[s] === 0) continue;
    const cost = grow(s, ++stamp, best);
    if (cost < best - 1e-9) {
      best = cost;
      bestSeed = s;
    }
  }
  if (bestSeed < 0) return null;
  const out: number[] = [];
  grow(bestSeed, ++stamp, Infinity, out);
  return out;
}

/** Place a customer's pallets. Mutates and returns new stacks, or null if it doesn't fit. */
export function allocate(
  layout: Layout,
  stacks: Stacks,
  customerId: string,
  count: number,
): Stacks | null {
  const slots = findCompactSlots(layout, stacks, count);
  if (!slots) return null;
  const next = stacks.map((s) => s.slice());
  for (const p of slots) next[p][next[p].indexOf(null)] = customerId; // lowest free level
  return next;
}

/** Remove a customer. Racked pallets are independent, so nothing else moves. */
export function release(stacks: Stacks, customerId: string): Stacks {
  return stacks.map((s) => (s.includes(customerId) ? s.map((id) => (id === customerId ? null : id)) : s));
}

/** Remove `count` of a customer's pallets, highest rack levels first. */
export function releaseSome(stacks: Stacks, customerId: string, count: number): Stacks {
  const slots: [number, number][] = [];
  stacks.forEach((s, p) => s.forEach((id, level) => id === customerId && slots.push([p, level])));
  slots.sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const next = stacks.map((s) => s.slice());
  for (const [p, level] of slots.slice(0, count)) next[p][level] = null;
  return next;
}

/** What one occupied rack slot holds. */
export interface SlotContent {
  key: string; // `${position}:${level}`
  p: number; // floor position index (row * cols + col)
  level: number;
  customerId: string;
  color: string;
  boxes: number; // cartons on this pallet
  pattern: PalletPattern | null;
}

export const slotKey = (p: number, level: number) => `${p}:${level}`;

/** Every occupied slot with its cartons (pallets are always full). */
export function palletContents(
  stacks: Stacks,
  customers: Customer[],
  products: Product[],
  config: WarehouseConfig,
): SlotContent[] {
  const productById = new Map(products.map((p) => [p.id, p]));
  const info = new Map(
    customers.map((c) => {
      const product = productById.get(c.productId);
      return [c.id, { c, pattern: product ? palletPattern(product, config) : null }];
    }),
  );
  const out: SlotContent[] = [];
  stacks.forEach((stack, p) =>
    stack.forEach((customerId, level) => {
      if (customerId === null) return;
      const it = info.get(customerId);
      const boxes = it?.pattern?.perPallet ?? 0;
      out.push({
        key: slotKey(p, level),
        p,
        level,
        customerId,
        color: it?.c.color ?? "#888888",
        boxes,
        pattern: it?.pattern ?? null,
      });
    }),
  );
  return out;
}

/** Recompute each customer's carton count from its pallets and product (after a product or config change). */
export function syncBoxes(customers: Customer[], products: Product[], config: WarehouseConfig): Customer[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return customers.map((c) => {
    const product = byId.get(c.productId);
    const boxes = product ? boxesFor(c.pallets, palletPattern(product, config)) : 0;
    return boxes === c.boxes ? c : { ...c, boxes };
  });
}

/** Re-place every customer from scratch (used after the warehouse is resized). */
export function rebuild(layout: Layout, customers: Customer[]) {
  let stacks = emptyStacks(layout);
  const updated = customers.map((c) => {
    const next = allocate(layout, stacks, c.id, c.pallets);
    if (next) stacks = next;
    return { ...c, placed: !!next };
  });
  return { stacks, customers: updated };
}

export function customerColor(index: number): string {
  const hue = (index * 137.508 + 20) % 360;
  return `hsl(${hue.toFixed(0)}, 85%, 58%)`;
}

export function slotLabel(layout: Layout, p: number, level: number) {
  const nC = layout.cols.length;
  return `${rowName(Math.floor(p / nC))}-${colName(p % nC)}-L${level + 1}`;
}
