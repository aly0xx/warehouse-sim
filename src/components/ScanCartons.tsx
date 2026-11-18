"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALLET_DECK_H, PalletPattern, Product } from "@/lib/warehouse";

// Photo-real-ish pallets for the 3D scan view: printed corrugated cartons with
// packing tape on real EUR pallets, with the owner's colour outlined on the floor.

export interface CartonPallet {
  x: number;
  y: number; // surface the pallet rests on
  z: number;
  boxes: number;
  customerId: string;
  productId: string;
  pattern: PalletPattern;
}

const PIXELS_PER_METER = 1700;
const KRAFT = "#d6b78c";
const DEFAULT_INK = "#3a3026";
const SEAM = 0.003; // m, gap left between neighbouring cartons
const SHIFT = 0.003; // m, how far a carton can sit out of line
const TWIST = 0.009; // radians, how far a carton can sit out of square
const OUTLINE_WIDTH = 0.04; // m, painted line around a pallet
const OUTLINE_GAP = 0.012; // m, between the pallet and its line
const OUTLINE_LIFT = 0.02; // m, above the scanned floor
const DIMMED = 0.3; // brightness of cartons that aren't selected

/** Repeatable pseudo-random value in 0..1, so cartons don't jump between renders. */
function noise(seed: number) {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function sheet(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(16, Math.round(width * PIXELS_PER_METER));
  canvas.height = Math.max(16, Math.round(height * PIXELS_PER_METER));
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = KRAFT;
  ctx.fillRect(0, 0, w, h);
  // Corrugation showing faintly through the liner.
  ctx.fillStyle = "rgba(70,45,20,0.05)";
  for (let x = 0; x < w; x += 9) ctx.fillRect(x, 0, 3, h);
  // Paper fibres.
  for (let i = 0; i < (w * h) / 110; i++) {
    const light = noise(i) > 0.5;
    ctx.strokeStyle = light ? "rgba(255,235,205,0.07)" : "rgba(60,38,15,0.07)";
    const x = noise(i + 1) * w, y = noise(i + 2) * h, a = noise(i + 3) * Math.PI, l = 4 + noise(i + 4) * 16;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  // Scuffed, darker edges where cartons rub together.
  const edge = Math.min(w, h) * 0.05;
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
    [0, 0, edge, 0, 0, 0, edge, h],
    [w, 0, w - edge, 0, w - edge, 0, edge, h],
    [0, 0, 0, edge, 0, 0, w, edge],
    [0, h, 0, h - edge, 0, h - edge, w, edge],
  ]) {
    const fade = ctx.createLinearGradient(x0, y0, x1, y1);
    fade.addColorStop(0, "rgba(50,30,12,0.3)");
    fade.addColorStop(1, "rgba(50,30,12,0)");
    ctx.fillStyle = fade;
    ctx.fillRect(rx, ry, rw, rh);
  }
  return { canvas, ctx, w, h };
}

function tape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = "rgba(196,150,88,0.82)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(255,240,210,0.16)";
  ctx.fillRect(x, y, w, h * 0.3);
  ctx.strokeStyle = "rgba(70,45,20,0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

/** Largest size up to `size` at which the text fits in `maxWidth`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxWidth: number) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px "Noto Sans Arabic", "Noto Sans", system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 2;
  } while (s > 10);
  return s;
}

function barcode(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number) {
  ctx.fillStyle = "#efe6d4";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#1c1712";
  const pad = w * 0.07;
  let at = x + pad, i = seed;
  while (at < x + w - pad) {
    const bar = 1.5 + Math.floor(noise(i++) * 3) * 1.5;
    ctx.fillRect(at, y + h * 0.1, bar, h * 0.8);
    at += bar + 1.5 + Math.floor(noise(i++) * 3) * 1.5;
  }
}

/** The standard "this way up" handling mark: two arrows over a bar. */
function upArrows(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, ink: string) {
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = size * 0.1;
  for (const dx of [size * 0.25, size * 0.75]) {
    ctx.beginPath();
    ctx.moveTo(x + dx, y + size * 0.82);
    ctx.lineTo(x + dx, y + size * 0.25);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + dx - size * 0.18, y + size * 0.3);
    ctx.lineTo(x + dx, y);
    ctx.lineTo(x + dx + size * 0.18, y + size * 0.3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillRect(x, y + size * 0.9, size, size * 0.1);
}

function sideArt(product: Product, faceWidth: number, faceHeight: number, wide: boolean) {
  const { canvas, ctx, w, h } = sheet(faceWidth, faceHeight);
  const ink = product.print?.ink ?? DEFAULT_INK;
  const title = product.print?.title ?? product.name;
  const titleAr = product.print?.titleAr;
  const pack = product.print?.pack ?? `${product.length} × ${product.width} × ${product.height} cm`;
  const margin = w * 0.07;
  const cx = w / 2;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  ctx.fillRect(margin, h * 0.2, w - margin * 2, h * 0.012);

  if (titleAr) {
    ctx.direction = "rtl";
    fitText(ctx, titleAr, 800, h * 0.17, w - margin * 2);
    ctx.fillText(titleAr, cx, h * 0.33);
    ctx.direction = "ltr";
  }
  fitText(ctx, title, 800, h * 0.12, w - margin * 2);
  ctx.fillText(title, cx, titleAr ? h * 0.5 : h * 0.4);

  fitText(ctx, pack, 700, h * 0.09, w - margin * 2);
  ctx.fillText(pack, cx, h * 0.63);
  ctx.fillRect(margin, h * 0.72, w - margin * 2, h * 0.012);

  const mark = h * 0.17;
  upArrows(ctx, margin, h * 0.77, mark, ink);
  if (wide) {
    const bw = w * 0.3;
    barcode(ctx, w - margin - bw, h * 0.77, bw, mark, product.id.length * 13);
    ctx.textAlign = "center";
    ctx.font = `600 ${h * 0.045}px "Noto Sans", system-ui, sans-serif`;
    ctx.fillText("KEEP DRY · STORE COOL", cx, h * 0.86);
  }
  // Ends of the tape that runs over the top of the carton.
  tape(ctx, cx - w * 0.09, 0, w * 0.18, h * 0.11);
  return canvas;
}

function topArt(faceWidth: number, faceDepth: number) {
  const { canvas, ctx, w, h } = sheet(faceWidth, faceDepth);
  // The two long flaps meet down the middle under the tape.
  ctx.fillStyle = "rgba(45,28,12,0.45)";
  ctx.fillRect(0, h / 2 - 1.5, w, 3);
  tape(ctx, 0, h / 2 - h * 0.11, w, h * 0.22);
  return canvas;
}

function texture(canvas: HTMLCanvasElement, anisotropy: number) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function CartonStack({ product, pattern, pallets, selectedId }: {
  product: Product;
  pattern: PalletPattern;
  pallets: CartonPallet[];
  selectedId: string | null;
}) {
  const gl = useThree((s) => s.gl);
  const cartons = useRef<THREE.InstancedMesh>(null);
  const count = pallets.reduce((n, p) => n + p.boxes, 0);

  const materials = useMemo(() => {
    const anisotropy = gl.capabilities.getMaxAnisotropy();
    const { bx, bz, bh } = pattern;
    const paint = (canvas: HTMLCanvasElement) => new THREE.MeshStandardMaterial({ map: texture(canvas, anisotropy), roughness: 0.92 });
    const end = paint(sideArt(product, bz, bh, bz >= bx));
    const front = paint(sideArt(product, bx, bh, bx >= bz));
    const top = paint(topArt(bx, bz));
    return [end, end, top, top, front, front]; // box faces: +x -x +y -y +z -z
  }, [gl, product, pattern]);
  useEffect(
    () => () => {
      for (const m of new Set(materials)) {
        m.map?.dispose();
        m.dispose();
      }
    },
    [materials],
  );

  useLayoutEffect(() => {
    const mesh = cartons.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const shade = new THREE.Color();
    const { nx, nz, bx, bz, bh, perLayer } = pattern;
    let b = 0;
    pallets.forEach((p, pi) => {
      const dim = selectedId && p.customerId !== selectedId ? DIMMED : 1;
      const top = p.y + PALLET_DECK_H;
      const x0 = p.x - (nx * bx) / 2, z0 = p.z - (nz * bz) / 2;
      for (let n = 0; n < p.boxes; n++, b++) {
        const layer = Math.floor(n / perLayer), inLayer = n % perLayer;
        const ix = inLayer % nx, iz = Math.floor(inLayer / nx);
        const seed = pi * 97 + n;
        o.position.set(
          x0 + (ix + 0.5) * bx + (noise(seed) - 0.5) * SHIFT * 2,
          top + (layer + 0.5) * bh,
          z0 + (iz + 0.5) * bz + (noise(seed + 1) - 0.5) * SHIFT * 2,
        );
        o.rotation.set(0, (noise(seed + 2) - 0.5) * TWIST * 2, 0);
        o.scale.set(bx - SEAM, bh - SEAM / 2, bz - SEAM);
        o.updateMatrix();
        mesh.setMatrixAt(b, o.matrix);
        const tone = (0.88 + noise(seed + 3) * 0.12) * dim;
        mesh.setColorAt(b, shade.setRGB(tone, tone * (0.98 + noise(seed + 4) * 0.02), tone * (0.95 + noise(seed + 5) * 0.05)));
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [pallets, pattern, selectedId, count]);

  return (
    <instancedMesh key={count} ref={cartons} args={[undefined, materials, count]} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}

/** Every patterned pallet over the scan, drawn carton by carton per product. */
export default function ScanCartons({ pallets, products, selectedId }: {
  pallets: CartonPallet[];
  products: Product[];
  selectedId: string | null;
}) {
  const groups = useMemo(() => {
    const byProduct = new Map<string, CartonPallet[]>();
    for (const p of pallets) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
    return [...byProduct.entries()].flatMap(([id, list]) => {
      const product = products.find((x) => x.id === id);
      return product ? [{ product, list }] : [];
    });
  }, [pallets, products]);
  return (
    <>
      {groups.map(({ product, list }) => (
        <CartonStack key={product.id} product={product} pattern={list[0].pattern} pallets={list} selectedId={selectedId} />
      ))}
    </>
  );
}

/** A line in the owner's colour painted on the floor around each pallet spot. */
export function GroundOutlines({ spots, depth, width, selectedId }: {
  spots: { x: number; z: number; color: string; customerId: string }[];
  depth: number; // pallet size along x, m
  width: number; // pallet size along z, m
  selectedId: string | null;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const shade = new THREE.Color();
    o.rotation.x = -Math.PI / 2;
    const reach = OUTLINE_GAP + OUTLINE_WIDTH / 2;
    const outerX = depth + 2 * (OUTLINE_GAP + OUTLINE_WIDTH);
    const innerZ = width + 2 * OUTLINE_GAP;
    const strips = [
      [0, -(width / 2 + reach), outerX, OUTLINE_WIDTH],
      [0, width / 2 + reach, outerX, OUTLINE_WIDTH],
      [-(depth / 2 + reach), 0, OUTLINE_WIDTH, innerZ],
      [depth / 2 + reach, 0, OUTLINE_WIDTH, innerZ],
    ];
    let i = 0;
    for (const spot of spots) {
      shade.set(spot.color).multiplyScalar(selectedId && spot.customerId !== selectedId ? DIMMED : 1);
      for (const [dx, dz, sx, sz] of strips) {
        o.position.set(spot.x + dx, OUTLINE_LIFT, spot.z + dz);
        o.scale.set(sx, sz, 1);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
        mesh.setColorAt(i++, shade);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [spots, depth, width, selectedId]);
  if (!spots.length) return null;
  return (
    // Drawn after the splats, which write no depth, so the line lands on the scanned floor.
    <instancedMesh key={spots.length} ref={ref} args={[undefined, undefined, spots.length * 4]} renderOrder={21} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial transparent depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}

/** EUR pallet: three bottom boards, nine blocks, three stringers and a slatted top deck. */
export function useEuroPallet(depth: number, width: number) {
  const parts = useMemo(() => {
    const H = PALLET_DECK_H;
    const board = 0.022;
    const block = H - board * 3;
    const boxes: THREE.BufferGeometry[] = [];
    const add = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(x, y - H / 2, z);
      boxes.push(g);
    };
    const rowsZ = [-(width / 2 - 0.05), 0, width / 2 - 0.05];
    const rowsX = [-(depth / 2 - 0.05), 0, depth / 2 - 0.05];
    for (const z of rowsZ) {
      add(depth, board, 0.1, 0, board / 2, z); // bottom boards
      for (const x of rowsX) add(0.1, block, 0.1, x, board + block / 2, z); // blocks
    }
    for (const x of rowsX) add(0.1, board, width, x, board + block + board / 2, 0); // stringers
    const slats = 5;
    for (let i = 0; i < slats; i++) {
      const z = -width / 2 + 0.05 + (i * (width - 0.1)) / (slats - 1);
      add(depth, board, 0.1, 0, H - board / 2, z); // top deck
    }
    const geometry = mergeGeometries(boxes)!;
    boxes.forEach((g) => g.dispose());

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#b98e5e";
    ctx.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 90; i++) {
      ctx.strokeStyle = `rgba(${noise(i) > 0.5 ? "90,58,28" : "226,190,140"},${0.1 + noise(i + 1) * 0.2})`;
      const y = noise(i + 2) * 64;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(85, y + noise(i + 3) * 8 - 4, 170, y + noise(i + 4) * 8 - 4, 256, y);
      ctx.stroke();
    }
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    return { geometry, material: new THREE.MeshStandardMaterial({ map, roughness: 0.9 }) };
  }, [depth, width]);
  useEffect(
    () => () => {
      parts.geometry.dispose();
      parts.material.map?.dispose();
      parts.material.dispose();
    },
    [parts],
  );
  return parts;
}
