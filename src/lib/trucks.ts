// Outbound trucks: cartons (not pallets) are loaded loose into a truck's cargo
// box, and we plan the layout that uses the least floor length.
//
// Truck frame (meters): x runs from the front wall (behind the cab) toward the
// rear doors, y is up, z runs across the width. Cartons keep "this side up",
// so each can only be turned 90° about the vertical axis.
//
// Packing is wall building (George & Robinson): cartons of one product form
// vertical walls across the full width × height of the box, and walls are
// placed one after another from the front. For each product we pick the
// orientation that needs the shortest run of walls. Products are loaded
// largest carton first; a product's last wall may be partial, filled column
// by column from one side so the gap is one tidy block.

import { Product } from "./warehouse";

export interface Truck {
  id: string;
  name: string;
  length: number; // interior, cm
  width: number;
  height: number;
  loads: TruckLoad[];
}

/** One dispatch onto a truck: cartons of a single product for one customer. */
export interface TruckLoad {
  id: string;
  customer: string;
  warehouse: string;
  productId: string;
  boxes: number;
  color: string;
}

export const TRUCK_PRESETS = [
  { short: "Semi", name: "Semi-trailer 13.6 m", length: 1360, width: 248, height: 270 },
  { short: "Rigid", name: "Rigid truck 7.2 m", length: 720, width: 245, height: 250 },
  { short: "Van", name: "Box van 4.2 m", length: 420, width: 200, height: 210 },
];

export function defaultTrucks(): Truck[] {
  return TRUCK_PRESETS.slice(0, 2).map(({ name, length, width, height }, i) => ({
    id: `default-truck-${i}`,
    name,
    length,
    width,
    height,
    loads: [],
  }));
}

export interface Dims {
  length: number; // cm
  width: number;
  height: number;
}

export interface Placement {
  x: number; // min corner, m
  y: number;
  z: number;
  dx: number; // size, m
  dy: number;
  dz: number;
  loadId: string;
}

export interface WallPlan {
  productId: string;
  count: number;
  depth: number; // carton length along the truck, m
  across: number; // carton width across the truck, m
  height: number;
  nz: number; // cartons across
  ny: number; // cartons high
  walls: number;
  x0: number; // where this product's walls start
}

export interface TruckPlan {
  groups: WallPlan[];
  usedLength: number; // m of floor taken from the front
  fits: boolean;
  /** Products whose carton can't stand in this truck at all. */
  unfit: string[];
  cartonVolume: number; // m³ of cartons
  truckVolume: number; // m³ of cargo box
}

const EPS = 1e-6;

/** Plan walls for a set of (product, count) without placing individual cartons. */
export function planTruck(
  truck: Pick<Truck, "length" | "width" | "height">,
  counts: Map<string, number>,
  products: Map<string, Product>,
): TruckPlan {
  const L = truck.length / 100, W = truck.width / 100, H = truck.height / 100;
  const groups: WallPlan[] = [];
  const unfit: string[] = [];
  let cartonVolume = 0;
  // Largest cartons first (heaviest/bulkiest at the front).
  const entries = [...counts]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => [products.get(id), n] as const)
    .sort(([a], [b]) => vol(b) - vol(a));
  let x = 0;
  for (const [p, count] of entries) {
    if (!p) continue;
    const l = p.length / 100, w = p.width / 100, h = p.height / 100;
    cartonVolume += l * w * h * count;
    const ny = Math.floor(H / h + EPS);
    let best: WallPlan | null = null;
    for (const [depth, across] of [
      [l, w],
      [w, l],
    ]) {
      const nz = Math.floor(W / across + EPS);
      if (nz * ny === 0) continue;
      const walls = Math.ceil(count / (nz * ny));
      const cand: WallPlan = { productId: p.id, count, depth, across, height: h, nz, ny, walls, x0: x };
      const len = walls * depth, bestLen = best ? best.walls * best.depth : Infinity;
      if (len < bestLen - EPS || (Math.abs(len - bestLen) < EPS && nz > best!.nz)) best = cand;
    }
    if (!best) {
      unfit.push(p.id);
      continue;
    }
    groups.push(best);
    x += best.walls * best.depth;
  }
  return {
    groups,
    usedLength: x,
    fits: unfit.length === 0 && x <= L + EPS,
    unfit,
    cartonVolume,
    truckVolume: L * W * H,
  };
}

function vol(p: Product | undefined) {
  return p ? p.length * p.width * p.height : 0;
}

/** Cartons per product currently on a truck. */
export function truckCounts(loads: TruckLoad[], extra?: { productId: string; boxes: number }) {
  const m = new Map<string, number>();
  for (const l of loads) m.set(l.productId, (m.get(l.productId) ?? 0) + l.boxes);
  if (extra) m.set(extra.productId, (m.get(extra.productId) ?? 0) + extra.boxes);
  return m;
}

/**
 * Concrete carton positions for a truck's loads. Within a product, cartons are
 * handed out in load order so each customer's cartons stay together.
 */
export function packTruck(truck: Truck, products: Map<string, Product>) {
  const plan = planTruck(truck, truckCounts(truck.loads), products);
  const placements: Placement[] = [];
  for (const g of plan.groups) {
    const queue = truck.loads.filter((l) => l.productId === g.productId);
    let qi = 0, left = queue[0]?.boxes ?? 0;
    const perWall = g.nz * g.ny;
    for (let k = 0; k < g.count; k++) {
      while (left === 0 && qi < queue.length - 1) left = queue[++qi].boxes;
      left--;
      const wall = Math.floor(k / perWall), r = k % perWall;
      const col = Math.floor(r / g.ny), lvl = r % g.ny; // fill a column bottom-up, then the next across
      placements.push({
        x: g.x0 + wall * g.depth,
        y: lvl * g.height,
        z: col * g.across,
        dx: g.depth,
        dy: g.height,
        dz: g.across,
        loadId: queue[qi].id,
      });
    }
  }
  // Bounding box of the load, and the clear space behind it (full width and height), in cm.
  let ux = 0, uy = 0, uz = 0;
  for (const q of placements) {
    ux = Math.max(ux, q.x + q.dx);
    uy = Math.max(uy, q.y + q.dy);
    uz = Math.max(uz, q.z + q.dz);
  }
  const cm = (m: number) => Math.round(m * 100);
  const used: Dims = { length: cm(ux), width: cm(uz), height: cm(uy) };
  const free: Dims = { length: Math.max(0, truck.length - used.length), width: truck.width, height: truck.height };
  return { plan, placements, used, free };
}

/** Largest k ≤ max such that k × perUnit more cartons of a product still fit the truck. */
export function maxUnitsThatFit(
  truck: Truck,
  products: Map<string, Product>,
  productId: string,
  perUnit: number,
  max: number,
) {
  const fits = (k: number) => planTruck(truck, truckCounts(truck.loads, { productId, boxes: k * perUnit }), products).fits;
  if (!fits(0)) return 0;
  let lo = 0, hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
