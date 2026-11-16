"use client";

import { FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import WarehouseScene, { HoverInfo } from "./WarehouseScene";
import TruckView from "./TruckView";
import { TRUCK_PRESETS, Truck, TruckLoad, defaultTrucks, maxUnitsThatFit, packTruck } from "@/lib/trucks";
import {
  Customer,
  DEFAULT_CONFIG,
  DEFAULT_PRODUCT,
  MIN_CRANE_AISLE,
  Product,
  Stacks,
  WarehouseConfig,
  allocate,
  computeLayout,
  customerColor,
  countPallets,
  emptyStacks,
  palletPattern,
  boxesFor,
  rebuild,
  release,
  releaseSome,
  syncBoxes,
} from "@/lib/warehouse";

const STORAGE_KEY = "warehouse-sim:v2";
const LEGACY_KEY = "warehouse-sim:v1";

interface SavedWarehouse {
  id: string;
  name: string;
  config: WarehouseConfig;
  customers: Customer[];
  colorIndex: number;
  /** Storage system the config was made for; missing = old forklift layout. */
  system?: "asrs";
}

interface Warehouse extends SavedWarehouse {
  stacks: Stacks; // derived on load by re-allocating customers; not persisted
  /**
   * How the 3D view should show the latest stacks change: "animate" plays it
   * out with trucks, conveyors and cranes; "snap" shows it instantly (initial
   * load, and re-allocations caused by layout or product changes).
   */
  transition: "animate" | "snap";
}

interface Saved {
  warehouses: SavedWarehouse[];
  activeId: string;
  products?: Product[]; // shared catalogue across warehouses
  trucks?: Truck[]; // outbound fleet, shared across warehouses
}

function newWarehouse(name: string): SavedWarehouse {
  return { id: crypto.randomUUID(), name, config: { ...DEFAULT_CONFIG }, customers: [], colorIndex: 0, system: "asrs" };
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Saved;
    // Migrate the single-warehouse format.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Omit<SavedWarehouse, "id" | "name">;
      const w = { ...newWarehouse("Warehouse 1"), ...old };
      return { warehouses: [w], activeId: w.id };
    }
  } catch {}
  return null;
}

/**
 * Build runtime state for a warehouse: pin the EUR pallet footprint, migrate
 * pre-product customers to the standard carton, derive carton counts from
 * pallets and place everyone.
 */
function hydrate(w: SavedWarehouse, products: Product[]): Warehouse {
  const { width, length, ceilingHeight, palletHeight } = { ...DEFAULT_CONFIG, ...w.config };
  const config: WarehouseConfig = {
    width,
    length,
    ceilingHeight,
    palletHeight,
    // Forklift-era warehouses: switch to crane aisles and let racks reach the ceiling.
    aisleWidth: w.system === "asrs" ? w.config.aisleWidth : DEFAULT_CONFIG.aisleWidth,
    maxStack: w.system === "asrs" ? w.config.maxStack : DEFAULT_CONFIG.maxStack,
    palletWidth: DEFAULT_CONFIG.palletWidth,
    palletDepth: DEFAULT_CONFIG.palletDepth,
  };
  const migrated = w.customers.map((c) => (c.productId ? c : { ...c, productId: DEFAULT_PRODUCT.id, boxes: 0 }));
  const r = rebuild(computeLayout(config), syncBoxes(migrated, products, config));
  return { ...w, config, customers: r.customers, stacks: r.stacks, system: "asrs", transition: "snap" };
}

/** "1360 × 248 × 270" (cm) */
function fmtDims(d: { length: number; width: number; height: number }) {
  return `${d.length} × ${d.width} × ${d.height}`;
}

/** "40 × 30 × 30 cm" */
function dims(p: Product) {
  return `${p.length} × ${p.width} × ${p.height} cm`;
}

const FIELDS: { key: keyof WarehouseConfig; label: string; step: number; min: number; max: number; unit?: string }[] = [
  { key: "width", label: "Width", step: 1, min: 5, max: 400, unit: "m" },
  { key: "length", label: "Length", step: 1, min: 5, max: 400, unit: "m" },
  { key: "ceilingHeight", label: "Ceiling height", step: 0.5, min: 3, max: 45, unit: "m" },
  { key: "maxStack", label: "Max rack levels", step: 1, min: 1, max: 40, unit: "lvl" },
  { key: "aisleWidth", label: "Crane aisle width", step: 0.1, min: MIN_CRANE_AISLE, max: 4, unit: "m" },
  { key: "palletHeight", label: "Loaded pallet height", step: 0.05, min: 0.3, max: 5, unit: "m" },
];

type Tab = "layout" | "allocate" | "products" | "trucks";

const PRODUCT_FIELDS = [
  { key: "length", label: "Length" },
  { key: "width", label: "Width" },
  { key: "height", label: "Height" },
] as const;

const EMPTY_PRODUCT_DRAFT = { id: "", name: "", length: "40", width: "30", height: "30" };
const EMPTY_TRUCK_DRAFT = { name: "", length: "1360", width: "248", height: "270" };
type Message = { kind: "ok" | "err"; text: string; switchTo?: string } | null;

const inputCls =
  "rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500";

export default function Simulator() {
  // Component is client-only (ssr: false), so localStorage is safe to read here.
  const [initial] = useState(() => {
    const saved = load();
    let products = saved?.products?.length ? saved.products : [DEFAULT_PRODUCT];
    // Older saves only know the standard carton; make sure it exists for them.
    if (saved?.warehouses.some((w) => w.customers.some((c) => !c.productId)) && !products.some((p) => p.id === DEFAULT_PRODUCT.id))
      products = [DEFAULT_PRODUCT, ...products];
    const list = saved?.warehouses.length ? saved.warehouses : [newWarehouse("Warehouse 1")];
    const warehouses = list.map((w) => hydrate(w, products));
    const activeId = warehouses.some((w) => w.id === saved?.activeId) ? saved!.activeId : warehouses[0].id;
    const trucks = saved?.trucks ?? defaultTrucks();
    return { warehouses, activeId, products, trucks };
  });
  const [warehouses, setWarehouses] = useState<Warehouse[]>(initial.warehouses);
  const [products, setProducts] = useState<Product[]>(initial.products);
  const [productDraft, setProductDraft] = useState(EMPTY_PRODUCT_DRAFT);
  const [productId, setProductId] = useState(initial.products[0]?.id ?? "");
  const [activeId, setActiveId] = useState(initial.activeId);
  const [tab, setTab] = useState<Tab>("allocate");
  const [trucks, setTrucks] = useState<Truck[]>(initial.trucks);
  const [truckId, setTruckId] = useState(initial.trucks[0]?.id ?? "");
  const [truckDraft, setTruckDraft] = useState(EMPTY_TRUCK_DRAFT);
  const [truckHover, setTruckHover] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState(""); // "" = the warehouse each load came from
  // Dispatch panel under a customer row: which customer, how many pallets, onto which truck.
  const [ship, setShip] = useState<{ customerId: string; count: string; truckId: string } | null>(null);
  const active = warehouses.find((w) => w.id === activeId) ?? warehouses[0];
  const { config, customers, stacks } = active;

  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(active.config));
  const [nameDraft, setNameDraft] = useState(active.name);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [name, setName] = useState("");
  const [count, setCount] = useState("10");
  const [targetId, setTargetId] = useState(active.id);
  const [message, setMessage] = useState<Message>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Layout + occupancy for every warehouse (for the switcher and target picker).
  const summaries = useMemo(
    () =>
      new Map(
        warehouses.map((w) => {
          const layout = computeLayout(w.config);
          const used = countPallets(w.stacks);
          return [w.id, { layout, used, free: layout.capacity - used }];
        }),
      ),
    [warehouses],
  );
  const { layout, used, free } = summaries.get(active.id)!;

  useEffect(() => {
    try {
      const data: Saved = {
        warehouses: warehouses.map(({ id, name, config, customers, colorIndex, system }) => ({
          id,
          name,
          config,
          customers,
          colorIndex,
          system,
        })),
        activeId,
        products,
        trucks,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, [warehouses, activeId, products, trucks]);

  const footprint = useMemo(() => stacks.filter((s) => s.some((id) => id !== null)).length, [stacks]);
  const productsInUse = useMemo(
    () =>
      new Set([
        ...warehouses.flatMap((w) => w.customers.map((c) => c.productId)),
        ...trucks.flatMap((t) => t.loads.map((l) => l.productId)),
      ]),
    [warehouses, trucks],
  );
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function patch(id: string, fn: (w: Warehouse) => Warehouse) {
    setWarehouses((ws) => ws.map((w) => (w.id === id ? fn(w) : w)));
  }

  function switchTo(id: string, list: Warehouse[] = warehouses) {
    const w = list.find((x) => x.id === id);
    if (!w) return;
    setActiveId(id);
    setTargetId(id);
    setDraft(toDraft(w.config));
    setNameDraft(w.name);
    setSelectedId(null);
    setHover(null);
    setConfirmDelete(false);
    setMessage(null);
  }

  function addWarehouse() {
    const base = hydrate(newWarehouse(`Warehouse ${warehouses.length + 1}`), products);
    const list = [...warehouses, base];
    setWarehouses(list);
    switchTo(base.id, list);
    setTab("layout");
  }

  function deleteWarehouse() {
    if (warehouses.length < 2) return;
    const rest = warehouses.filter((w) => w.id !== active.id);
    setWarehouses(rest);
    switchTo(rest[0].id, rest);
  }

  function applyConfig(e: FormEvent) {
    e.preventDefault();
    const next = { ...config };
    for (const f of FIELDS) {
      const v = parseFloat(draft[f.key]);
      if (!Number.isFinite(v)) continue;
      const clamped = Math.min(f.max, Math.max(f.min, v));
      next[f.key] = f.step >= 1 ? Math.round(clamped) : clamped;
    }
    // Pallet height changes how many cartons fit per pallet.
    const r = rebuild(computeLayout(next), syncBoxes(customers, products, next));
    const newName = nameDraft.trim() || active.name;
    patch(active.id, (w) => ({
      ...w,
      name: newName,
      config: next,
      customers: r.customers,
      stacks: r.stacks,
      transition: "snap",
    }));
    setDraft(toDraft(next));
    setNameDraft(newName);
    const unplaced = r.customers.filter((c) => !c.placed).length;
    setMessage(
      unplaced
        ? { kind: "err", text: `Layout updated. ${unplaced} customer(s) no longer fit and are unplaced.` }
        : { kind: "ok", text: "Layout updated and all customers re-allocated." },
    );
  }

  function addCustomer(e: FormEvent) {
    e.preventDefault();
    const n = parseInt(count, 10);
    const trimmed = name.trim();
    const target = warehouses.find((w) => w.id === targetId) ?? active;
    const t = summaries.get(target.id)!;
    const product = products.find((p) => p.id === productId);
    if (!trimmed) return setMessage({ kind: "err", text: "Enter a customer name." });
    if (!product) return setMessage({ kind: "err", text: "Pick a product (add one in the Products tab)." });
    if (!Number.isFinite(n) || n < 1) return setMessage({ kind: "err", text: "Pallet count must be at least 1." });
    const pattern = palletPattern(product, target.config);
    if (!pattern)
      return setMessage({
        kind: "err",
        text: `A ${dims(product)} carton doesn't fit on a pallet in ${target.name} (120 × 80 cm, ${target.config.palletHeight} m loaded).`,
      });
    const boxes = boxesFor(n, pattern);
    if (n > t.free) {
      const alt = warehouses.find((w) => w.id !== target.id && summaries.get(w.id)!.free >= n);
      return setMessage({
        kind: "err",
        text: `Not enough space in ${target.name}: ${n} requested, only ${t.free} pallet spaces free.${
          alt ? ` ${alt.name} has room.` : ""
        }`,
        switchTo: alt?.id,
      });
    }
    const id = crypto.randomUUID();
    const next = allocate(t.layout, target.stacks, id, n);
    if (!next) return setMessage({ kind: "err", text: "Could not allocate space." });
    const c: Customer = {
      id,
      name: trimmed,
      productId: product.id,
      boxes,
      pallets: n,
      color: customerColor(target.colorIndex),
      placed: true,
    };
    patch(target.id, (w) => ({
      ...w,
      customers: [...w.customers, c],
      stacks: next,
      colorIndex: w.colorIndex + 1,
      transition: "animate",
    }));
    if (target.id !== active.id) switchTo(target.id);
    setSelectedId(id);
    setName("");
    setMessage({
      kind: "ok",
      text: `Allocated ${n} pallet${n > 1 ? "s" : ""} of ${product.name} (${boxes.toLocaleString()} boxes) for ${trimmed} in ${target.name}.`,
    });
  }

  function removeCustomer(id: string) {
    patch(active.id, (w) => ({
      ...w,
      stacks: release(w.stacks, id),
      transition: "animate",
      customers: w.customers.filter((c) => c.id !== id),
    }));
    if (selectedId === id) setSelectedId(null);
  }

  /** Take pallets out of the racks and load their cartons onto a truck. */
  function shipCustomer(e: FormEvent) {
    e.preventDefault();
    if (!ship) return;
    const c = customers.find((x) => x.id === ship.customerId);
    const truck = trucks.find((t) => t.id === ship.truckId);
    const n = parseInt(ship.count, 10);
    if (!c) return setShip(null);
    if (!truck) return setMessage({ kind: "err", text: "Pick a truck (add one in the Trucks tab)." });
    if (!Number.isFinite(n) || n < 1 || n > c.pallets)
      return setMessage({ kind: "err", text: `Ship between 1 and ${c.pallets} pallets.` });
    const product = productById.get(c.productId);
    const pattern = product ? palletPattern(product, config) : null;
    if (!product || !pattern) return setMessage({ kind: "err", text: `${c.name}'s product has no cartons to load.` });
    const room = maxUnitsThatFit(truck, productById, product.id, pattern.perPallet, n);
    if (room < n)
      return setMessage({
        kind: "err",
        text: `${truck.name} only has room for ${room} more pallet${room === 1 ? "" : "s"} of ${product.name}.`,
      });
    const boxes = n * pattern.perPallet;
    const load: TruckLoad = {
      id: crypto.randomUUID(),
      customer: c.name,
      warehouse: active.name,
      warehouseId: active.id,
      productId: product.id,
      boxes,
      color: c.color,
    };
    setTrucks((ts) => ts.map((t) => (t.id === truck.id ? { ...t, loads: [...t.loads, load] } : t)));
    patch(active.id, (w) => {
      const all = n >= c.pallets;
      return {
        ...w,
        stacks: all ? release(w.stacks, c.id) : releaseSome(w.stacks, c.id, n),
        transition: "animate",
        customers: all
          ? w.customers.filter((x) => x.id !== c.id)
          : w.customers.map((x) => (x.id === c.id ? { ...x, pallets: x.pallets - n, boxes: x.boxes - boxes } : x)),
      };
    });
    if (n >= c.pallets && selectedId === c.id) setSelectedId(null);
    setShip(null);
    setTruckId(truck.id);
    setMessage({
      kind: "ok",
      text: `Loaded ${boxes.toLocaleString()} boxes of ${product.name} (${n} pallet${n > 1 ? "s" : ""} unpacked) from ${c.name} onto ${truck.name}.`,
    });
  }

  function saveTruck(e: FormEvent) {
    e.preventDefault();
    const trimmed = truckDraft.name.trim();
    const [length, width, height] = (["length", "width", "height"] as const).map((k) => parseFloat(truckDraft[k]));
    if (!trimmed) return setMessage({ kind: "err", text: "Enter a truck name." });
    if (![length, width, height].every((v) => Number.isFinite(v) && v >= 50))
      return setMessage({ kind: "err", text: "Truck dimensions must be at least 50 cm." });
    const t: Truck = { id: crypto.randomUUID(), name: trimmed, length, width, height, loads: [] };
    setTrucks((ts) => [...ts, t]);
    setTruckId(t.id);
    setTruckDraft(EMPTY_TRUCK_DRAFT);
    setMessage({ kind: "ok", text: `Added ${trimmed}.` });
  }

  function emptyTruck(id: string) {
    setTrucks((ts) => ts.map((t) => (t.id === id ? { ...t, loads: [] } : t)));
  }

  /**
   * Take loads off a truck and put them back in the racks: cartons are
   * re-palletised (full pallets, rounded up) and allocated in the chosen
   * warehouse, or the one each load came from. A load joins the customer it
   * came from when that customer still holds the same product there.
   */
  function returnLoads(truckId: string, loadIds: string[]) {
    const truck = trucks.find((t) => t.id === truckId);
    if (!truck) return;
    const byId = new Map(warehouses.map((w) => [w.id, w]));
    const done: string[] = [];
    const failed: string[] = [];
    let pallets = 0;
    for (const l of truck.loads.filter((x) => loadIds.includes(x.id))) {
      const w =
        byId.get(returnTo) ??
        (l.warehouseId ? byId.get(l.warehouseId) : undefined) ??
        [...byId.values()].find((x) => x.name === l.warehouse) ??
        byId.get(active.id)!;
      const product = productById.get(l.productId);
      const pattern = product && palletPattern(product, w.config);
      if (!pattern) {
        failed.push(`${l.customer} (product doesn't fit a pallet in ${w.name})`);
        continue;
      }
      const n = Math.ceil(l.boxes / pattern.perPallet);
      const existing = w.customers.find((c) => c.name === l.customer && c.productId === l.productId && c.placed);
      const id = existing?.id ?? crypto.randomUUID();
      const stacks = allocate(computeLayout(w.config), w.stacks, id, n);
      if (!stacks) {
        failed.push(`${l.customer} (no room for ${n} pallets in ${w.name})`);
        continue;
      }
      const customers = existing
        ? w.customers.map((c) => (c.id === id ? { ...c, pallets: c.pallets + n, boxes: c.boxes + n * pattern.perPallet } : c))
        : [
            ...w.customers,
            { id, name: l.customer, productId: l.productId, pallets: n, boxes: n * pattern.perPallet, color: l.color, placed: true },
          ];
      byId.set(w.id, { ...w, stacks, customers, transition: "animate" });
      done.push(l.id);
      pallets += n;
    }
    if (done.length) {
      setWarehouses(warehouses.map((w) => byId.get(w.id)!));
      setTrucks((ts) => ts.map((t) => (t.id === truckId ? { ...t, loads: t.loads.filter((l) => !done.includes(l.id)) } : t)));
    }
    setMessage(
      failed.length
        ? { kind: "err", text: `${done.length ? `Returned ${pallets} pallet${pallets === 1 ? "" : "s"}. ` : ""}Could not return: ${failed.join("; ")}.` }
        : { kind: "ok", text: `Returned ${pallets} pallet${pallets === 1 ? "" : "s"} from ${truck.name} to the warehouse.` },
    );
  }

  function removeLoad(truck: string, loadId: string) {
    setTrucks((ts) => ts.map((t) => (t.id === truck ? { ...t, loads: t.loads.filter((l) => l.id !== loadId) } : t)));
  }

  function deleteTruck(id: string) {
    const rest = trucks.filter((t) => t.id !== id);
    setTrucks(rest);
    if (truckId === id) setTruckId(rest[0]?.id ?? "");
  }

  function retryPlace(c: Customer) {
    const next = allocate(layout, stacks, c.id, c.pallets);
    if (!next) return setMessage({ kind: "err", text: `Still no room for ${c.name}.` });
    patch(active.id, (w) => ({
      ...w,
      stacks: next,
      transition: "animate",
      customers: w.customers.map((x) => (x.id === c.id ? { ...x, placed: true } : x)),
    }));
  }

  function clearCustomers() {
    patch(active.id, (w) => ({ ...w, customers: [], stacks: emptyStacks(computeLayout(w.config)), transition: "animate" }));
    setSelectedId(null);
    setMessage(null);
  }

  /** Apply a new catalogue; re-pack pallets of edited products (pallet counts and slots stay put). */
  function commitProducts(next: Product[]) {
    setProducts(next);
    setWarehouses((ws) =>
      ws.map((w) => {
        const synced = syncBoxes(w.customers, next, w.config);
        return synced.every((c, i) => c === w.customers[i]) ? w : { ...w, customers: synced };
      }),
    );
  }

  function saveProduct(e: FormEvent) {
    e.preventDefault();
    const trimmed = productDraft.name.trim();
    const [length, width, height] = PRODUCT_FIELDS.map((f) => parseFloat(productDraft[f.key]));
    if (!trimmed) return setMessage({ kind: "err", text: "Enter a product name." });
    if (![length, width, height].every((v) => Number.isFinite(v) && v > 0))
      return setMessage({ kind: "err", text: "Box dimensions must be positive numbers (cm)." });
    const product: Product = { id: productDraft.id || crypto.randomUUID(), name: trimmed, length, width, height };
    if (!palletPattern(product, config))
      return setMessage({
        kind: "err",
        text: `A ${dims(product)} carton doesn't fit on a 120 × 80 cm pallet loaded to ${config.palletHeight} m.`,
      });
    const editing = products.some((p) => p.id === product.id);
    commitProducts(editing ? products.map((p) => (p.id === product.id ? product : p)) : [...products, product]);
    if (!editing) setProductId(product.id);
    setProductDraft(EMPTY_PRODUCT_DRAFT);
    const repacked = editing && productsInUse.has(product.id);
    setMessage({
      kind: "ok",
      text: editing
        ? `Updated ${trimmed}.${repacked ? " Pallets holding it were re-packed." : ""}`
        : `Added ${trimmed}.`,
    });
  }

  function deleteProduct(id: string) {
    const next = products.filter((p) => p.id !== id);
    setProducts(next);
    if (productId === id) setProductId(next[0]?.id ?? "");
    if (productDraft.id === id) setProductDraft(EMPTY_PRODUCT_DRAFT);
  }


  // Live preview of what the requested pallets hold.
  const allocPreview = useMemo(() => {
    const product = productById.get(productId);
    const target = warehouses.find((w) => w.id === targetId) ?? active;
    const n = parseInt(count, 10);
    if (!product || !Number.isFinite(n) || n < 1) return null;
    const pattern = palletPattern(product, target.config);
    if (!pattern) return { error: `Carton doesn't fit on a pallet in ${target.name}.` };
    return {
      text: `${boxesFor(n, pattern).toLocaleString()} boxes · ${pattern.perPallet} boxes/pallet (${pattern.nx}×${pattern.nz}×${pattern.layers})`,
    };
  }, [productById, productId, warehouses, targetId, active, count]);

  // Planned carton layout for every truck.
  const packed = useMemo(() => new Map(trucks.map((t) => [t.id, packTruck(t, productById)])), [trucks, productById]);
  const activeTruck = trucks.find((t) => t.id === truckId) ?? trucks[0];
  const truckLoadById = useMemo(
    () => new Map(trucks.flatMap((t) => t.loads.map((l) => [l.id, l] as const))),
    [trucks],
  );
  const loadColor = useMemo(() => (id: string) => truckLoadById.get(id)?.color ?? "#888888", [truckLoadById]);
  const hoveredLoad = truckHover ? truckLoadById.get(truckHover) : null;

  // Live check for the dispatch panel: how many pallets of this customer the chosen truck can still take.
  const shipRoom = useMemo(() => {
    if (!ship) return null;
    const c = customers.find((x) => x.id === ship.customerId);
    const truck = trucks.find((t) => t.id === ship.truckId);
    const product = c && productById.get(c.productId);
    const pattern = product && palletPattern(product, config);
    if (!c || !truck || !product || !pattern) return null;
    return maxUnitsThatFit(truck, productById, product.id, pattern.perPallet, c.pallets);
  }, [ship, customers, trucks, productById, config]);

  const hovered = hover ? customers.find((c) => c.id === hover.customerId) : null;
  const pct = layout.capacity ? (used / layout.capacity) * 100 : 0;

  const capacityBar = (
    <div>
      <div className="h-2 overflow-hidden rounded bg-slate-800">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {used} / {layout.capacity} pallets stored ({pct.toFixed(1)}%) · {footprint} floor spots in use
      </p>
    </div>
  );

  const messageEl = message && (
    <p className={`text-xs ${message.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
      {message.text}
      {message.switchTo && (
        <button
          type="button"
          onClick={() => setTargetId(message.switchTo!)}
          className="ml-1 text-sky-400 underline hover:text-sky-300"
        >
          Use it
        </button>
      )}
    </p>
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b1226] text-slate-200 md:flex-row">
      <aside className="flex max-h-[55vh] w-full shrink-0 flex-col gap-4 overflow-y-auto border-slate-800 bg-[#141b24] p-4 md:max-h-none md:w-[340px] md:border-r">
        <header>
          <h1 className="text-lg font-semibold text-white">Warehouse Simulator</h1>
          <p className="text-[11px] font-medium uppercase tracking-wider text-amber-400">Automated AS/RS · stacker cranes</p>
          <p className="text-xs text-slate-400">Drag to orbit · right-drag to pan · scroll to zoom · click a pallet to select its customer</p>
        </header>

        {/* Warehouse switcher */}
        <section className="flex gap-2">
          <select
            value={active.id}
            onChange={(e) => switchTo(e.target.value)}
            aria-label="Active warehouse"
            className={`${inputCls} min-w-0 flex-1`}
          >
            {warehouses.map((w) => {
              const s = summaries.get(w.id)!;
              return (
                <option key={w.id} value={w.id}>
                  {w.name} — {s.free.toLocaleString()} pallet spaces free
                </option>
              );
            })}
          </select>
          <button
            onClick={addWarehouse}
            className="shrink-0 rounded border border-slate-700 px-3 text-sm text-slate-300 hover:border-sky-500 hover:text-white"
            title="Add a new warehouse"
          >
            + New
          </button>
        </section>

        {/* Tabs */}
        <nav className="flex rounded bg-slate-900 p-1 text-sm" role="tablist">
          {(
            [
              ["allocate", "Allocate"],
              ["products", "Products"],
              ["trucks", "Trucks"],
              ["layout", "Layout"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                setMessage(null);
              }}
              className={`flex-1 rounded py-1.5 font-medium transition-colors ${
                tab === key ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "layout" && (
          <>
            <section>
              <form onSubmit={applyConfig} className="grid grid-cols-2 gap-2">
                <label className="col-span-2 flex flex-col gap-1 text-[11px] text-slate-400">
                  Name
                  <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className={inputCls} />
                </label>
                {FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-[11px] text-slate-400">
                    {f.label}
                    <div className="flex items-center rounded border border-slate-700 bg-slate-900 focus-within:border-sky-500">
                      <input
                        type="number"
                        step={f.step}
                        min={f.min}
                        max={f.max}
                        value={draft[f.key]}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                        className="w-full min-w-0 bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
                      />
                      {f.unit && <span className="pr-2 text-[10px] text-slate-500">{f.unit}</span>}
                    </div>
                  </label>
                ))}
                <button type="submit" className="col-span-2 mt-1 rounded bg-sky-600 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
                  Apply layout
                </button>
              </form>
              {messageEl && <div className="mt-2">{messageEl}</div>}
            </section>

            <section className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Cranes" value={layout.aisles.length} />
              <Stat label="Rows" value={layout.rows.length} />
              <Stat label="Columns" value={layout.cols.length} />
              <Stat label="Rack levels" value={layout.levels} />
              <Stat label="Floor spots" value={layout.positions} />
              <Stat label="Capacity" value={layout.capacity} />
              <Stat label="Free spaces" value={free} />
              <div className="col-span-3 text-left">{capacityBar}</div>
            </section>

            <section className="mt-auto border-t border-slate-800 pt-3">
              {warehouses.length < 2 ? (
                <p className="text-[11px] text-slate-500">Add another warehouse to be able to delete this one.</p>
              ) : confirmDelete ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex-1 text-rose-300">
                    Delete {active.name} and its {customers.length} customer(s)?
                  </span>
                  <button onClick={deleteWarehouse} className="rounded bg-rose-600 px-2 py-1 text-white hover:bg-rose-500">
                    Delete
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-slate-400 hover:text-white">
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="text-xs text-slate-500 hover:text-rose-400">
                  Delete this warehouse
                </button>
              )}
            </section>
          </>
        )}

        {tab === "products" && (
          <>
            <section>
              <form onSubmit={saveProduct} className="grid grid-cols-3 gap-2">
                <label className="col-span-3 flex flex-col gap-1 text-[11px] text-slate-400">
                  Product name
                  <input
                    value={productDraft.name}
                    onChange={(e) => setProductDraft((d) => ({ ...d, name: e.target.value }))}
                    className={inputCls}
                  />
                </label>
                {PRODUCT_FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Box {f.label.toLowerCase()}
                    <div className="flex items-center rounded border border-slate-700 bg-slate-900 focus-within:border-sky-500">
                      <input
                        type="number"
                        step={0.5}
                        min={1}
                        value={productDraft[f.key]}
                        onChange={(e) => setProductDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                        className="w-full min-w-0 bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
                      />
                      <span className="pr-2 text-[10px] text-slate-500">cm</span>
                    </div>
                  </label>
                ))}
                <p className="col-span-3 text-[11px] text-slate-500">
                  Boxes are packed flat on a 120 × 80 cm pallet (rotated if more fit) and stacked up to the loaded
                  pallet height ({config.palletHeight} m in {active.name}). Each pallet holds one product.
                </p>
                <button
                  type="submit"
                  className={`${productDraft.id ? "col-span-2" : "col-span-3"} rounded bg-sky-600 py-1.5 text-sm font-medium text-white hover:bg-sky-500`}
                >
                  {productDraft.id ? "Save changes" : "Add product"}
                </button>
                {productDraft.id && (
                  <button
                    type="button"
                    onClick={() => setProductDraft(EMPTY_PRODUCT_DRAFT)}
                    className="rounded border border-slate-700 text-sm text-slate-300 hover:text-white"
                  >
                    Cancel
                  </button>
                )}
              </form>
              {messageEl && <div className="mt-2">{messageEl}</div>}
            </section>

            <section className="flex flex-col">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Products ({products.length})
              </h2>
              {products.length === 0 && <p className="text-xs text-slate-500">No products yet.</p>}
              <ul className="flex flex-col gap-1">
                {products.map((p) => {
                  const pattern = palletPattern(p, config);
                  const inUse = productsInUse.has(p.id);
                  return (
                    <li
                      key={p.id}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                        productDraft.id === p.id ? "bg-slate-700" : "hover:bg-slate-800"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{p.name}</span>
                        <span className="block truncate text-[11px] text-slate-500">
                          {dims(p)} ·{" "}
                          {pattern
                            ? `${pattern.perPallet} / pallet (${pattern.nx}×${pattern.nz}×${pattern.layers})`
                            : "doesn't fit a pallet here"}
                        </span>
                      </span>
                      <button
                        onClick={() =>
                          setProductDraft({
                            id: p.id,
                            name: p.name,
                            length: String(p.length),
                            width: String(p.width),
                            height: String(p.height),
                          })
                        }
                        className="text-xs text-slate-400 hover:text-sky-400"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteProduct(p.id)}
                        disabled={inUse}
                        className="text-slate-500 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-500"
                        aria-label={`Delete ${p.name}`}
                        title={inUse ? "In use by a customer — remove those allocations first" : `Delete ${p.name}`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}

        {tab === "trucks" && (
          <>
            {messageEl}
            <section className="flex flex-col">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Trucks ({trucks.length})</h2>
              {trucks.length === 0 && <p className="text-xs text-slate-500">No trucks yet.</p>}
              <ul className="flex flex-col gap-1">
                {trucks.map((t) => {
                  const { plan, used, free } = packed.get(t.id)!;
                  const lenPct = (plan.usedLength / (t.length / 100)) * 100;
                  const boxes = t.loads.reduce((n, l) => n + l.boxes, 0);
                  return (
                    <li
                      key={t.id}
                      onClick={() => setTruckId(t.id)}
                      className={`cursor-pointer rounded px-2 py-1.5 text-sm ${
                        activeTruck?.id === t.id ? "bg-slate-700" : "hover:bg-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteTruck(t.id);
                          }}
                          className="text-slate-500 hover:text-rose-400"
                          aria-label={`Delete ${t.name}`}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {fmtDims(t)} cm · {boxes.toLocaleString()} boxes
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Used {fmtDims(used)} · Free {fmtDims(free)}
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800">
                        <div
                          className={`h-full ${plan.fits ? "bg-amber-400" : "bg-rose-500"}`}
                          style={{ width: `${Math.min(100, lenPct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {activeTruck && (() => {
              const { plan, used, free } = packed.get(activeTruck.id)!;
              const L = activeTruck.length / 100;
              return (
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{activeTruck.name} load plan</h2>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="Floor used" value={`${plan.usedLength.toFixed(2)} m`} />
                    <Stat label="Floor free" value={`${Math.max(0, L - plan.usedLength).toFixed(2)} m`} />
                    <Stat label="Volume" value={`${((plan.cartonVolume / plan.truckVolume) * 100).toFixed(0)}%`} />
                  </div>
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="text-left font-normal" />
                        <th className="text-right font-normal">Length</th>
                        <th className="text-right font-normal">Width</th>
                        <th className="text-right font-normal">Height</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {(
                        [
                          ["Truck", activeTruck],
                          ["Used", used],
                          ["Remaining", free],
                        ] as const
                      ).map(([label, d]) => (
                        <tr key={label}>
                          <td className="text-slate-500">{label}</td>
                          <td className="text-right">{d.length} cm</td>
                          <td className="text-right">{d.width} cm</td>
                          <td className="text-right">{d.height} cm</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!plan.fits && (
                    <p className="text-[11px] text-rose-400">
                      Over capacity — a product was resized after loading. Remove a load to fix it.
                    </p>
                  )}
                  {plan.groups.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                      {plan.groups.map((g) => (
                        <li key={g.productId}>
                          {productById.get(g.productId)?.name ?? "Unknown"}: {g.walls} wall{g.walls > 1 ? "s" : ""} of {g.nz}×{g.ny}{" "}
                          ({Math.round(g.depth * 100)} cm deep) · {g.count.toLocaleString()} boxes
                        </li>
                      ))}
                    </ul>
                  )}
                  {activeTruck.loads.length === 0 ? (
                    <p className="text-xs text-slate-500">Empty. Ship a customer from the Allocate tab to load it.</p>
                  ) : (
                    <>
                      <label className="flex items-center gap-2 text-[11px] text-slate-400">
                        Return to
                        <select value={returnTo} onChange={(e) => setReturnTo(e.target.value)} className={`${inputCls} min-w-0 flex-1 py-1 text-xs`}>
                          <option value="">Warehouse it came from</option>
                          {warehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name} ({summaries.get(w.id)!.free.toLocaleString()} pallet spaces free)
                            </option>
                          ))}
                        </select>
                      </label>
                      <ul className="flex flex-col gap-1">
                        {activeTruck.loads.map((l) => (
                          <li
                            key={l.id}
                            className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${truckHover === l.id ? "bg-slate-700" : ""}`}
                          >
                            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: l.color }} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{l.customer}</span>
                              <span className="block truncate text-[11px] text-slate-500">
                                {productById.get(l.productId)?.name ?? "Unknown product"} · {l.boxes.toLocaleString()} boxes · from{" "}
                                {l.warehouse}
                              </span>
                            </span>
                            <button
                              onClick={() => returnLoads(activeTruck.id, [l.id])}
                              className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-emerald-500 hover:text-emerald-300"
                              title="Re-palletise these cartons and put them back in the racks"
                            >
                              Return
                            </button>
                            <button
                              onClick={() => removeLoad(activeTruck.id, l.id)}
                              className="text-slate-500 hover:text-rose-400"
                              aria-label={`Discard ${l.customer}'s load`}
                              title="Remove this load from the truck without returning it"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className="flex gap-2">
                        <button
                          onClick={() => returnLoads(activeTruck.id, activeTruck.loads.map((l) => l.id))}
                          className="flex-1 rounded border border-slate-700 py-1 text-xs text-slate-300 hover:border-emerald-500 hover:text-white"
                          title="Put every load on this truck back in the racks"
                        >
                          Return all to warehouse
                        </button>
                        <button
                          onClick={() => emptyTruck(activeTruck.id)}
                          className="flex-1 rounded border border-slate-700 py-1 text-xs text-slate-300 hover:border-sky-500 hover:text-white"
                          title="The truck leaves; its cargo is cleared"
                        >
                          Dispatch truck
                        </button>
                      </div>
                    </>
                  )}
                </section>
              );
            })()}

            <section className="border-t border-slate-800 pt-3">
              <form onSubmit={saveTruck} className="grid grid-cols-3 gap-2">
                <label className="col-span-3 flex flex-col gap-1 text-[11px] text-slate-400">
                  <span className="flex justify-between">
                    New truck
                    <span className="flex gap-2">
                      {TRUCK_PRESETS.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() =>
                            setTruckDraft({ name: p.name, length: String(p.length), width: String(p.width), height: String(p.height) })
                          }
                          className="text-sky-400 hover:text-sky-300"
                          title={`${p.name}: ${p.length} × ${p.width} × ${p.height} cm`}
                        >
                          {p.short}
                        </button>
                      ))}
                    </span>
                  </span>
                  <input
                    value={truckDraft.name}
                    placeholder="Name"
                    onChange={(e) => setTruckDraft((d) => ({ ...d, name: e.target.value }))}
                    className={inputCls}
                  />
                </label>
                {(["length", "width", "height"] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Inner {k}
                    <div className="flex items-center rounded border border-slate-700 bg-slate-900 focus-within:border-sky-500">
                      <input
                        type="number"
                        min={50}
                        step={1}
                        value={truckDraft[k]}
                        onChange={(e) => setTruckDraft((d) => ({ ...d, [k]: e.target.value }))}
                        className="w-full min-w-0 bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
                      />
                      <span className="pr-2 text-[10px] text-slate-500">cm</span>
                    </div>
                  </label>
                ))}
                <button type="submit" className="col-span-3 rounded bg-sky-600 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
                  Add truck
                </button>
              </form>
              <p className="mt-2 text-[11px] text-slate-500">
                Cartons are loaded loose, this side up, in walls across the full width and height from the cab
                backwards. Each product uses the carton orientation that needs the least floor length.
              </p>
            </section>
          </>
        )}

        {tab === "allocate" && (
          <>
            <section className="flex flex-col gap-2">
              <form onSubmit={addCustomer} className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                  Customer name
                  <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                  <span className="flex justify-between">
                    Pallet contents
                    <button type="button" onClick={() => setTab("products")} className="text-sky-400 hover:text-sky-300">
                      Manage products
                    </button>
                  </span>
                  <select value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
                    {products.length === 0 && <option value="">No products yet</option>}
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({dims(p)})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-2">
                  <label className="flex w-24 flex-col gap-1 text-[11px] text-slate-400">
                    Pallets
                    <input type="number" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} className={inputCls} />
                  </label>
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-slate-400">
                    Warehouse
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className={inputCls}>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({summaries.get(w.id)!.free.toLocaleString()} pallet spaces free)
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {allocPreview && (
                  <p className={`text-[11px] ${"error" in allocPreview ? "text-rose-400" : "text-slate-400"}`}>
                    {"error" in allocPreview ? allocPreview.error : `= ${allocPreview.text}`}
                  </p>
                )}
                <button type="submit" className="rounded bg-emerald-600 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
                  Allocate
                </button>
              </form>
              {messageEl}
              {capacityBar}
            </section>

            <section className="flex min-h-0 flex-col">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Customers in {active.name} ({customers.length})
                </h2>
                {customers.length > 0 && (
                  <button onClick={clearCustomers} className="text-[11px] text-slate-500 hover:text-rose-400">
                    Clear all
                  </button>
                )}
              </div>
              {customers.length === 0 && <p className="text-xs text-slate-500">No customers yet.</p>}
              <ul className="flex flex-col gap-1">
                {customers.map((c) => (
                  <Fragment key={c.id}>
                  <li
                    onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
                      selectedId === c.id ? "bg-slate-700" : "hover:bg-slate-800"
                    }`}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: c.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.name}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {productById.get(c.productId)?.name ?? "Unknown product"} · {c.boxes.toLocaleString()} boxes
                      </span>
                    </span>
                    {c.placed ? (
                      <span className="text-xs text-slate-400">{c.pallets} plt</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          retryPlace(c);
                        }}
                        className="text-xs text-amber-400 hover:underline"
                        title="Did not fit after resize — click to retry"
                      >
                        unplaced · retry
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMessage(null);
                        setShip(
                          ship?.customerId === c.id
                            ? null
                            : { customerId: c.id, count: String(c.pallets), truckId: activeTruck?.id ?? "" },
                        );
                      }}
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        ship?.customerId === c.id
                          ? "border-sky-500 text-sky-300"
                          : "border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300"
                      }`}
                      title="Deallocate onto a truck"
                    >
                      Ship
                    </button>
                  </li>
                  {ship?.customerId === c.id && (
                    <li className="mb-1 rounded border border-slate-700 bg-slate-900/60 p-2">
                      <form onSubmit={shipCustomer} className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <label className="flex w-20 flex-col gap-1 text-[11px] text-slate-400">
                            Pallets
                            <input
                              type="number"
                              min={1}
                              max={c.pallets}
                              step={1}
                              value={ship.count}
                              onChange={(e) => setShip({ ...ship, count: e.target.value })}
                              className={inputCls}
                            />
                          </label>
                          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-slate-400">
                            Truck
                            <select
                              value={ship.truckId}
                              onChange={(e) => setShip({ ...ship, truckId: e.target.value })}
                              className={inputCls}
                            >
                              {trucks.length === 0 && <option value="">No trucks yet</option>}
                              {trucks.map((t) => {
                                const pl = packed.get(t.id)!.plan;
                                return (
                                  <option key={t.id} value={t.id}>
                                    {t.name} ({Math.round((pl.usedLength / (t.length / 100)) * 100)}% full)
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        </div>
                        {shipRoom !== null && (
                          <p className={`text-[11px] ${shipRoom < (parseInt(ship.count, 10) || 0) ? "text-rose-400" : "text-slate-400"}`}>
                            Room for {shipRoom} of {c.pallets} pallet{c.pallets === 1 ? "" : "s"} · cartons are unpacked and loaded loose
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            type="submit"
                            disabled={!c.placed}
                            className="flex-1 rounded bg-sky-600 py-1 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                          >
                            Load onto truck
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              removeCustomer(c.id);
                              setShip(null);
                            }}
                            className="text-[11px] text-slate-500 hover:text-rose-400"
                            title="Remove all of this customer's pallets without loading a truck"
                          >
                            Remove without shipping
                          </button>
                        </div>
                      </form>
                    </li>
                  )}
                  </Fragment>
                ))}
              </ul>
            </section>
          </>
        )}
      </aside>

      <main className="relative min-h-0 flex-1">
        {/* Kept mounted (hidden) on the Trucks tab so in-flight animations carry on */}
        <div className={`absolute inset-0 isolate ${tab === "trucks" ? "invisible" : ""}`}>
        <WarehouseScene
          config={config}
          layout={layout}
          stacks={stacks}
          customers={customers}
          products={products}
          warehouseId={active.id}
          transition={active.transition}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onHover={setHover}
        />
        </div>
        {tab !== "trucks" && hovered && hover && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-indigo-500/40 bg-[#0d1433]/90 px-3 py-2 text-xs shadow-lg">
            <div className="flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: hovered.color }} />
              {hovered.name}
            </div>
            <div className="text-slate-300">
              {productById.get(hovered.productId)?.name ?? "Unknown product"} · {hover.boxes} boxes on this pallet
            </div>
            <div className="text-slate-400">
              Slot {hover.slot} · {hovered.pallets} pallets / {hovered.boxes.toLocaleString()} boxes total
            </div>
          </div>
        )}
        {tab === "trucks" && (
          <div className="absolute inset-0 z-10 bg-[#c9dceb]">
            {activeTruck ? (
              <TruckView
                truck={activeTruck}
                plan={packed.get(activeTruck.id)!.plan}
                placements={packed.get(activeTruck.id)!.placements}
                colorOf={loadColor}
                onHover={setTruckHover}
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-[#0f172a] text-sm text-slate-500">Add a truck to see its load plan.</div>
            )}
            {hoveredLoad && (
              <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-indigo-500/40 bg-[#0d1433]/90 px-3 py-2 text-xs shadow-lg">
                <div className="flex items-center gap-2 font-semibold">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: hoveredLoad.color }} />
                  {hoveredLoad.customer}
                </div>
                <div className="text-slate-300">
                  {productById.get(hoveredLoad.productId)?.name ?? "Unknown product"} · {hoveredLoad.boxes.toLocaleString()} boxes
                </div>
              </div>
            )}
            {activeTruck && (
              <div className="pointer-events-none absolute bottom-3 right-3 rounded-full border border-amber-500/30 bg-[#0d1433]/80 px-3 py-1 text-[11px] text-amber-300">
                {activeTruck.name} · cab on the left, rear doors on the right · yellow line = end of load
              </div>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-full border border-sky-500/30 bg-[#0d1433]/80 px-3 py-1 text-[11px] text-sky-300">
          {active.name} · {config.width} m × {config.length} m × {config.ceilingHeight} m
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded bg-slate-900 px-1 py-2">
      <div className="text-base font-semibold text-white">{value.toLocaleString()}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

function toDraft(c: WarehouseConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)]));
}
