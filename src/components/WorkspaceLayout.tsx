import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export type WorkspacePanelId = "library" | "vu" | "center";

export interface WorkspacePanel {
  id: WorkspacePanelId;
  title: string;
  content: ReactNode;
}

interface LayoutState {
  order: WorkspacePanelId[];
  sizes: Record<WorkspacePanelId, number>;
}

interface Props {
  panels: WorkspacePanel[];
  storageKey?: string;
}

interface ResizeState {
  index: number;
  startX: number;
  width: number;
  order: WorkspacePanelId[];
  sizes: Record<WorkspacePanelId, number>;
  moved: boolean;
}

interface MoveState {
  id: WorkspacePanelId;
  target: number;
}

const PANEL_IDS: WorkspacePanelId[] = ["library", "vu", "center"];
const DEFAULT_ORDER: WorkspacePanelId[] = ["library", "vu", "center"];
const DEFAULT_SIZES: Record<WorkspacePanelId, number> = {
  library: 40,
  vu: 3,
  center: 57,
};
const MIN_WIDTHS: Record<WorkspacePanelId, number> = {
  library: 300,
  vu: 34,
  center: 420,
};
const GAP = 8;
const STORAGE_KEY = "miradio.workspace.v2";

function isPanelId(value: unknown): value is WorkspacePanelId {
  return value === "library" || value === "vu" || value === "center";
}

function loadLayout(key: string): LayoutState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as { order?: unknown; sizes?: unknown };
    const stored = Array.isArray(parsed.order) ? parsed.order.filter(isPanelId) : [];
    const order = stored.filter((id, index) => stored.indexOf(id) === index);
    for (const id of PANEL_IDS) if (!order.includes(id)) order.push(id);
    const sizes = { ...DEFAULT_SIZES };
    if (parsed.sizes && typeof parsed.sizes === "object") {
      const values = parsed.sizes as Record<string, unknown>;
      for (const id of PANEL_IDS) {
        const value = Number(values[id]);
        if (Number.isFinite(value) && value > 0) sizes[id] = value;
      }
    }
    return { order, sizes };
  } catch {
    return { order: [...DEFAULT_ORDER], sizes: { ...DEFAULT_SIZES } };
  }
}

function columnsFor(
  order: WorkspacePanelId[],
  sizes: Record<WorkspacePanelId, number>,
): string {
  return order
    .map((id, index) => `${sizes[id]}fr${index < order.length - 1 ? ` ${GAP}px` : ""}`)
    .join(" ");
}

export function WorkspaceLayout({ panels, storageKey = STORAGE_KEY }: Props) {
  const gridRef = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout(storageKey));
  const orderRef = useRef(layout.order);
  const sizesRef = useRef(layout.sizes);
  const resizeRef = useRef<ResizeState | null>(null);
  const moveRef = useRef<MoveState | null>(null);

  useLayoutEffect(() => {
    orderRef.current = layout.order;
    sizesRef.current = layout.sizes;
    gridRef.current?.style.setProperty(
      "--workspace-cols",
      columnsFor(layout.order, layout.sizes),
    );
  }, [layout]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      return;
    }
  }, [layout, storageKey]);

  const panelNode = (id: WorkspacePanelId) =>
    gridRef.current?.querySelector<HTMLElement>(`[data-panel-id="${id}"]`) ?? null;

  const panelNodes = () =>
    Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>("[data-panel-id]") ?? [],
    );

  const applyColumns = (
    order: WorkspacePanelId[],
    sizes: Record<WorkspacePanelId, number>,
  ) => {
    gridRef.current?.style.setProperty("--workspace-cols", columnsFor(order, sizes));
  };

  const commitLayout = (next: LayoutState) => {
    orderRef.current = next.order;
    sizesRef.current = next.sizes;
    setLayout(next);
  };

  const innerWidth = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    const styles = getComputedStyle(grid);
    return Math.max(
      1,
      grid.clientWidth -
        (Number.parseFloat(styles.paddingLeft) || 0) -
        (Number.parseFloat(styles.paddingRight) || 0),
    );
  };

  const beginResize = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      index,
      startX: event.clientX,
      width: innerWidth(),
      order: [...orderRef.current],
      sizes: { ...sizesRef.current },
      moved: false,
    };
    document.body.classList.add("is-resizing");
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const left = drag.order[drag.index];
    const right = drag.order[drag.index + 1];
    if (!left || !right) return;
    const totalFr = drag.order.reduce((sum, id) => sum + drag.sizes[id], 0);
    const frWidth = Math.max(1, drag.width - GAP * (drag.order.length - 1));
    const frPerPx = totalFr / frWidth;
    const deltaFr = (event.clientX - drag.startX) * frPerPx;
    if (deltaFr === 0) return;
    drag.moved = true;
    const pairTotal = drag.sizes[left] + drag.sizes[right];
    const minLeft = (MIN_WIDTHS[left] / frWidth) * totalFr;
    const minRight = (MIN_WIDTHS[right] / frWidth) * totalFr;
    let leftSize = drag.sizes[left] + deltaFr;
    if (minLeft + minRight > pairTotal) {
      leftSize = pairTotal * (minLeft / (minLeft + minRight));
    } else {
      leftSize = Math.min(Math.max(leftSize, minLeft), pairTotal - minRight);
    }
    const nextSizes = {
      ...drag.sizes,
      [left]: leftSize,
      [right]: pairTotal - leftSize,
    };
    sizesRef.current = nextSizes;
    applyColumns(drag.order, nextSizes);
  };

  const endResize = () => {
    const drag = resizeRef.current;
    resizeRef.current = null;
    document.body.classList.remove("is-resizing");
    if (drag?.moved) {
      commitLayout({
        order: [...orderRef.current],
        sizes: { ...sizesRef.current },
      });
    }
  };

  const cancelResize = () => {
    const drag = resizeRef.current;
    resizeRef.current = null;
    document.body.classList.remove("is-resizing");
    if (!drag) return;
    sizesRef.current = drag.sizes;
    applyColumns(drag.order, drag.sizes);
  };

  const nudge = (index: number, deltaPx: number) => {
    const order = orderRef.current;
    const sizes = sizesRef.current;
    const left = order[index];
    const right = order[index + 1];
    if (!left || !right) return;
    const width = innerWidth();
    const totalFr = order.reduce((sum, id) => sum + sizes[id], 0);
    const frWidth = Math.max(1, width - GAP * (order.length - 1));
    const frPerPx = totalFr / frWidth;
    const pairTotal = sizes[left] + sizes[right];
    const minLeft = (MIN_WIDTHS[left] / frWidth) * totalFr;
    const minRight = (MIN_WIDTHS[right] / frWidth) * totalFr;
    let leftSize = sizes[left] + deltaPx * frPerPx;
    if (minLeft + minRight > pairTotal) {
      leftSize = pairTotal * (minLeft / (minLeft + minRight));
    } else {
      leftSize = Math.min(Math.max(leftSize, minLeft), pairTotal - minRight);
    }
    commitLayout({
      order: [...order],
      sizes: { ...sizes, [left]: leftSize, [right]: pairTotal - leftSize },
    });
  };

  const clearMoveMarks = () => {
    for (const node of panelNodes()) {
      delete node.dataset.dragging;
      delete node.dataset.drop;
    }
  };

  const beginMove = (
    id: WorkspacePanelId,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    moveRef.current = { id, target: orderRef.current.indexOf(id) };
    document.body.classList.add("is-reordering");
    const node = panelNode(id);
    if (node) node.dataset.dragging = "true";
  };

  const moveMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = moveRef.current;
    if (!drag) return;
    const nodes = panelNodes();
    const without = orderRef.current.filter((id) => id !== drag.id);
    let target = without.length;
    for (let index = 0; index < without.length; index += 1) {
      const node = nodes.find((item) => item.dataset.panelId === without[index]);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        target = index;
        break;
      }
    }
    if (target === drag.target) return;
    drag.target = target;
    for (const node of nodes) {
      if (node.dataset.panelId === drag.id) continue;
      if (node.dataset.panelId === without[target]) node.dataset.drop = "true";
      else delete node.dataset.drop;
    }
  };

  const endMove = () => {
    const drag = moveRef.current;
    moveRef.current = null;
    document.body.classList.remove("is-reordering");
    clearMoveMarks();
    if (!drag) return;
    const without = orderRef.current.filter((id) => id !== drag.id);
    const target = Math.max(0, Math.min(drag.target, without.length));
    const nextOrder = [
      ...without.slice(0, target),
      drag.id,
      ...without.slice(target),
    ];
    if (nextOrder.every((id, index) => id === orderRef.current[index])) return;
    commitLayout({ order: nextOrder, sizes: { ...sizesRef.current } });
  };

  const cancelMove = () => {
    moveRef.current = null;
    document.body.classList.remove("is-reordering");
    clearMoveMarks();
  };

  const moveByKey = (
    id: WorkspacePanelId,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = orderRef.current.indexOf(id);
    const target = current + (event.key === "ArrowLeft" ? -1 : 1);
    if (target < 0 || target >= orderRef.current.length) return;
    event.preventDefault();
    const next = [...orderRef.current];
    [next[current], next[target]] = [next[target], next[current]];
    commitLayout({ order: next, sizes: { ...sizesRef.current } });
  };

  const content = new Map(panels.map((panel) => [panel.id, panel.content]));
  const titles = new Map(panels.map((panel) => [panel.id, panel.title]));

  return (
    <main className="workspace" ref={gridRef}>
      {layout.order.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && (
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Redimensionar ${titles.get(layout.order[index - 1]) ?? ""} y ${titles.get(id) ?? ""}`}
              tabIndex={0}
              title="Arrastra para cambiar el ancho · doble clic: restablecer"
              onPointerDown={(event) => beginResize(index - 1, event)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={cancelResize}
              onDoubleClick={() =>
                commitLayout({
                  order: [...orderRef.current],
                  sizes: { ...DEFAULT_SIZES },
                })
              }
              onKeyDown={(event) => {
                const step = event.shiftKey ? 60 : 20;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudge(index - 1, -step);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudge(index - 1, step);
                }
              }}
            />
          )}
          <div className="workspace-panel" data-panel-id={id}>
            <button
              type="button"
              className="panel-grip"
              aria-label={`Mover ${titles.get(id) ?? ""}`}
              title={`Arrastra para mover ${titles.get(id) ?? ""} · flechas para reordenar`}
              onPointerDown={(event) => beginMove(id, event)}
              onPointerMove={moveMove}
              onPointerUp={endMove}
              onPointerCancel={cancelMove}
              onKeyDown={(event) => moveByKey(id, event)}
            >
              <svg viewBox="0 0 8 8" width="8" height="8" fill="currentColor" aria-hidden="true">
                <circle cx="2" cy="2" r="0.9" />
                <circle cx="6" cy="2" r="0.9" />
                <circle cx="2" cy="4" r="0.9" />
                <circle cx="6" cy="4" r="0.9" />
                <circle cx="2" cy="6" r="0.9" />
                <circle cx="6" cy="6" r="0.9" />
              </svg>
            </button>
            <div className="workspace-panel-body">{content.get(id)}</div>
          </div>
        </Fragment>
      ))}
    </main>
  );
}
