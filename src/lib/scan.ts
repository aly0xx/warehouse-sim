import * as THREE from "three";

// 3D scan overlay: how a Gaussian splat scan is placed in the warehouse.
//
// An alignment maps the scan into the site frame (see warehouse.ts): the site
// origin is the building corner, y is up and the floor is y = 0. Scans open from
// a local file and never leave the browser; only the alignment is remembered.

export interface ScanAlignment {
  x: number; // m, site frame
  y: number;
  z: number;
  yaw: number; // degrees, about the vertical
  pitch: number;
  roll: number;
  scale: number; // meters per scan unit
}

// Splat files are commonly stored y-down, so scans start turned right way up.
export const DEFAULT_ALIGNMENT: ScanAlignment = { x: 0, y: 0, z: 0, yaw: 0, pitch: 180, roll: 0, scale: 1 };

/** Scan opened automatically when the app can find it next to the page. */
export const DEFAULT_SCAN = "linden-warehouse.spz";

export const SCAN_EXTENSIONS = [".spz", ".ply", ".splat", ".ksplat"];

export function isScanFile(name: string) {
  const lower = name.toLowerCase();
  return SCAN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const storageKey = (warehouseId: string, file: File) => `warehouse-sim:scan:${warehouseId}:${file.name}:${file.size}`;

/** Saved alignment for this scan in this warehouse, or the default. */
export function loadAlignment(warehouseId: string, file: File): ScanAlignment {
  try {
    const raw = localStorage.getItem(storageKey(warehouseId, file));
    if (!raw) return DEFAULT_ALIGNMENT;
    const saved = JSON.parse(raw) as Partial<ScanAlignment>;
    const merged = { ...DEFAULT_ALIGNMENT, ...saved };
    const valid = Object.values(merged).every((v) => typeof v === "number" && Number.isFinite(v)) && merged.scale > 0;
    return valid ? merged : DEFAULT_ALIGNMENT;
  } catch {
    return DEFAULT_ALIGNMENT;
  }
}

export function saveAlignment(warehouseId: string, file: File, alignment: ScanAlignment) {
  try {
    localStorage.setItem(storageKey(warehouseId, file), JSON.stringify(alignment));
  } catch {
    // Storage blocked or full: the alignment still applies for this session.
  }
}

// ---------------------------------------------------------------------------
// Pallet placement: pallets go on open floor found in the scan itself.

export interface ScanSlot {
  x: number; // pallet centre, site frame
  y: number; // surface the pallet rests on
  z: number;
}

// Slots, cells and walls are stored square to the building: turned by `yaw` about
// `centre`. `scanToSite` brings a point from that frame back to the site frame.
interface OpenCell {
  x: number;
  z: number;
  levels: number; // pallets that can stack here
}

export interface ScanFit {
  slots: ScanSlot[]; // nearest the middle of the open floor first
  cells: OpenCell[]; // the floor spots behind those slots, in the same order
  centre: { x: number; y: number; z: number }; // middle of the scan, ignoring stray splats
  walls: { x0: number; z0: number; cols: number; rows: number; blocked: Uint8Array } | null; // solid floor columns
  yaw: number; // radians the building's walls are turned from the site axes
}

const COLUMN = 0.25; // m, floor grid resolution
const BAND = 0.25; // m, height resolution above the floor
const BANDS = 32; // heights tracked, up to 8 m
const FLOOR_TOLERANCE = 0.2; // m, how far a point can be from y = 0 and count as floor
const OBSTACLE_POINTS = 3; // points in one column band that count as something solid
const FLOOR_COVERAGE = 0.7; // share of a pallet's footprint that must show floor
const WALK_BANDS = 8; // height bands a person walking through would touch
const WALL_BANDS = 4; // solid bands in that range that make a real obstacle, not stray splats
const WALK_RADIUS = 0.3; // m, kept clear around the camera
const WALK_CEILING = 2.6; // m, above this the camera flies over obstacles
const MAX_STACK = 3; // floor-stacked pallets per spot
const HEAD_ROOM = 0.1; // m, kept clear above a stack
const VIEW_MARGIN = 9; // m, from the edge of the placed pallets to the starting camera
const EYE_HEIGHT = 2.5; // m, camera height when it starts on open floor
const SIGHT_SKIP = 0.5; // m, ignored at each end of a line of sight
const OVERVIEW_RISE = 1.5; // m, above the stacks when no open floor is left to stand on

/** Value at fraction `q` of a sorted copy of every third coordinate in `points`. */
function quantiles(points: Float32Array, axis: number, qs: number[]) {
  const n = Math.floor(points.length / 3);
  const step = Math.max(1, Math.floor(n / 20000));
  const picked: number[] = [];
  for (let i = 0; i < n; i += step) picked.push(points[i * 3 + axis]);
  picked.sort((a, b) => a - b);
  return qs.map((q) => picked[Math.min(picked.length - 1, Math.floor(q * picked.length))] ?? 0);
}

const WALL_SAMPLES = 120_000; // points used to find the wall direction
const WALL_MIN_Y = 0.5; // m, ignores the floor
const WALL_MAX_Y = 4; // m, ignores roof trusses
const WALL_BIN = 0.1; // m
const WALL_BINS = 2048;

/** Turn, within ±45°, that lines the walls up with the axes: walls then pile into few, tall bins. */
function wallYaw(site: Float32Array, cx: number, cz: number) {
  const xs: number[] = [];
  const zs: number[] = [];
  const n = Math.floor(site.length / 3);
  const step = Math.max(1, Math.floor(n / (WALL_SAMPLES * 3)));
  for (let i = 0; i < n && xs.length < WALL_SAMPLES; i += step) {
    const y = site[i * 3 + 1];
    if (y < WALL_MIN_Y || y > WALL_MAX_Y) continue;
    xs.push(site[i * 3] - cx);
    zs.push(site[i * 3 + 2] - cz);
  }
  if (!xs.length) return 0;
  const across = new Uint32Array(WALL_BINS);
  const along = new Uint32Array(WALL_BINS);
  const sharpness = (angle: number) => {
    across.fill(0);
    along.fill(0);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let i = 0; i < xs.length; i++) {
      const u = Math.floor((xs[i] * cos - zs[i] * sin) / WALL_BIN) + WALL_BINS / 2;
      const v = Math.floor((xs[i] * sin + zs[i] * cos) / WALL_BIN) + WALL_BINS / 2;
      if (u >= 0 && u < WALL_BINS) across[u]++;
      if (v >= 0 && v < WALL_BINS) along[v]++;
    }
    let score = 0;
    for (let b = 0; b < WALL_BINS; b++) score += across[b] * across[b] + along[b] * along[b];
    return score;
  };
  const search = (from: number, to: number, stepDeg: number) => {
    let best = from, bestScore = -1;
    for (let deg = from; deg <= to; deg += stepDeg) {
      const score = sharpness(THREE.MathUtils.degToRad(deg));
      if (score > bestScore) [best, bestScore] = [deg, score];
    }
    return best;
  };
  const coarse = search(-45, 44, 1);
  return THREE.MathUtils.degToRad(search(coarse - 1, coarse + 1, 0.1));
}

/** Bring a point from the building-square frame back to the site frame. */
export function scanToSite(fit: Pick<ScanFit, "yaw" | "centre">, x: number, z: number) {
  const cos = Math.cos(fit.yaw), sin = Math.sin(fit.yaw);
  const dx = x - fit.centre.x, dz = z - fit.centre.z;
  return { x: fit.centre.x + dx * cos + dz * sin, z: fit.centre.z - dx * sin + dz * cos };
}

/**
 * Find where pallets physically fit. `points` are opaque splat centres in scan
 * units; a spot needs visible floor under it and nothing solid above that floor.
 */
export function fitPalletsToScan(
  points: Float32Array,
  a: ScanAlignment,
  pallet: { width: number; depth: number; height: number },
): ScanFit {
  const rad = THREE.MathUtils.degToRad;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(a.pitch), rad(a.yaw), rad(a.roll), "YXZ")),
    new THREE.Vector3(a.scale, a.scale, a.scale),
  ).elements;
  const n = Math.floor(points.length / 3);
  const site = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    site[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    site[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    site[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }

  // Stray splats far outside the building must not stretch the grid.
  const centre = { x: quantiles(site, 0, [0.5])[0], y: quantiles(site, 1, [0.5])[0], z: quantiles(site, 2, [0.5])[0] };
  const yaw = wallYaw(site, centre.x, centre.z);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  for (let i = 0; i < n; i++) {
    const dx = site[i * 3] - centre.x, dz = site[i * 3 + 2] - centre.z;
    site[i * 3] = centre.x + dx * cos - dz * sin;
    site[i * 3 + 2] = centre.z + dx * sin + dz * cos;
  }
  const [x0, x1] = quantiles(site, 0, [0.005, 0.995]);
  const [z0, z1] = quantiles(site, 2, [0.005, 0.995]);
  const cols = Math.ceil((x1 - x0) / COLUMN);
  const rows = Math.ceil((z1 - z0) / COLUMN);
  if (!(cols > 0 && rows > 0) || cols * rows > 4_000_000) return { slots: [], cells: [], centre, walls: null, yaw };

  const floor = new Uint8Array(cols * rows);
  const solid = new Uint16Array(cols * rows * BANDS);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((site[i * 3] - x0) / COLUMN);
    const r = Math.floor((site[i * 3 + 2] - z0) / COLUMN);
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const y = site[i * 3 + 1];
    if (Math.abs(y) <= FLOOR_TOLERANCE) floor[c + r * cols] = 1;
    else if (y > FLOOR_TOLERANCE) {
      const band = Math.floor((y - FLOOR_TOLERANCE) / BAND);
      if (band < BANDS) solid[(c + r * cols) * BANDS + band]++;
    }
  }

  const blocked = new Uint8Array(cols * rows);
  for (let i = 0; i < blocked.length; i++) {
    let hits = 0;
    for (let b = 0; b < WALK_BANDS; b++) if (solid[i * BANDS + b] >= OBSTACLE_POINTS) hits++;
    blocked[i] = hits >= WALL_BANDS ? 1 : 0;
  }
  const walls = { x0, z0, cols, rows, blocked };

  // Tile the floor with pallet footprints and keep the ones with clear space above.
  const spanX = Math.max(1, Math.ceil((pallet.depth + 0.1) / COLUMN));
  const spanZ = Math.max(1, Math.ceil((pallet.width + 0.1) / COLUMN));
  const open: OpenCell[] = [];
  for (let r = 0; r + spanZ <= rows; r += spanZ) {
    for (let c = 0; c + spanX <= cols; c += spanX) {
      let seen = 0;
      let clear = BANDS;
      for (let j = r; j < r + spanZ; j++) {
        for (let i = c; i < c + spanX; i++) {
          seen += floor[i + j * cols];
          const base = (i + j * cols) * BANDS;
          for (let b = 0; b < clear; b++) if (solid[base + b] >= OBSTACLE_POINTS) clear = b;
        }
      }
      if (seen < FLOOR_COVERAGE * spanX * spanZ) continue;
      const height = FLOOR_TOLERANCE + clear * BAND - HEAD_ROOM;
      const levels = Math.min(MAX_STACK, Math.floor(height / pallet.height));
      if (levels < 1) continue;
      open.push({ x: x0 + (c + spanX / 2) * COLUMN, z: z0 + (r + spanZ / 2) * COLUMN, levels });
    }
  }
  if (!open.length) return { slots: [], cells: [], centre, walls, yaw };

  const mid = (values: number[]) => [...values].sort((p, q) => p - q)[Math.floor(values.length / 2)];
  const cx = mid(open.map((o) => o.x));
  const cz = mid(open.map((o) => o.z));
  open.sort((p, q) => Math.hypot(p.x - cx, p.z - cz) - Math.hypot(q.x - cx, q.z - cz));

  const slots: ScanSlot[] = [];
  for (const o of open) for (let l = 0; l < o.levels; l++) slots.push({ x: o.x, y: l * pallet.height, z: o.z });
  return { slots, cells: open, centre, walls, yaw };
}

/** Whether nothing solid stands between two floor points (building-square frame). */
function sightClear(fit: ScanFit, ax: number, az: number, bx: number, bz: number) {
  const walls = fit.walls;
  if (!walls) return true;
  const length = Math.hypot(bx - ax, bz - az);
  for (let d = SIGHT_SKIP; d < length - SIGHT_SKIP; d += COLUMN) {
    const c = Math.floor((ax + ((bx - ax) * d) / length - walls.x0) / COLUMN);
    const r = Math.floor((az + ((bz - az) * d) / length - walls.z0) / COLUMN);
    if (c >= 0 && c < walls.cols && r >= 0 && r < walls.rows && walls.blocked[c + r * walls.cols]) return false;
  }
  return true;
}

/** Where the camera starts: on floor the pallets don't use, with a clear view of them. */
export function scanView(fit: ScanFit, stored: number, palletHeight: number) {
  if (!fit.cells.length) return null;
  let used = 0;
  for (let placed = 0; used < fit.cells.length && placed < stored; used++) placed += fit.cells[used].levels;
  const taken = fit.cells.slice(0, Math.max(1, used));
  const look = {
    x: taken.reduce((sum, c) => sum + c.x, 0) / taken.length,
    z: taken.reduce((sum, c) => sum + c.z, 0) / taken.length,
  };
  const reach = Math.max(...taken.map((c) => Math.hypot(c.x - look.x, c.z - look.z))) + VIEW_MARGIN;
  const free = fit.cells.slice(used);
  if (free.length) {
    const miss = (c: OpenCell) => Math.abs(Math.hypot(c.x - look.x, c.z - look.z) - reach);
    const inView = free.filter((c) => sightClear(fit, c.x, c.z, look.x, look.z));
    const options = inView.length ? inView : free;
    const spot = options.reduce((best, c) => (miss(c) < miss(best) ? c : best), options[0]);
    return { eye: { ...scanToSite(fit, spot.x, spot.z), y: EYE_HEIGHT }, look: scanToSite(fit, look.x, look.z) };
  }
  // Every spot is full: look down over the stacks instead of standing inside them.
  const top = Math.max(...taken.map((c) => c.levels)) * palletHeight;
  return { eye: { ...scanToSite(fit, look.x + reach, look.z + reach), y: top + OVERVIEW_RISE }, look: scanToSite(fit, look.x, look.z) };
}

/** Whether the camera can stand at this site-frame point without entering a wall or a stack. */
export function walkClear(
  fit: ScanFit,
  stored: number,
  pallet: { width: number; depth: number; height: number },
  siteX: number,
  y: number,
  siteZ: number,
) {
  // Cells and walls are stored square to the building.
  const cos = Math.cos(fit.yaw), sin = Math.sin(fit.yaw);
  const dx = siteX - fit.centre.x, dz = siteZ - fit.centre.z;
  const x = fit.centre.x + dx * cos - dz * sin;
  const z = fit.centre.z + dx * sin + dz * cos;
  let placed = 0;
  for (const cell of fit.cells) {
    if (placed >= stored) break;
    const count = Math.min(cell.levels, stored - placed);
    placed += count;
    if (y > count * pallet.height) continue;
    if (Math.abs(x - cell.x) < pallet.depth / 2 + WALK_RADIUS && Math.abs(z - cell.z) < pallet.width / 2 + WALK_RADIUS) return false;
  }
  const walls = fit.walls;
  if (!walls || y > WALK_CEILING) return true;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const c = Math.floor((x + dx * WALK_RADIUS - walls.x0) / COLUMN);
    const r = Math.floor((z + dz * WALK_RADIUS - walls.z0) / COLUMN);
    if (c >= 0 && c < walls.cols && r >= 0 && r < walls.rows && walls.blocked[c + r * walls.cols]) return false;
  }
  return true;
}
