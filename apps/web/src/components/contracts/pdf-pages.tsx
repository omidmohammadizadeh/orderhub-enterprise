"use client";

// Renders an uploaded contract PDF to canvases, and hands back each page's
// on-screen box so callers can lay fields over it.
//
// One component for both surfaces on purpose. The operator places a box in the
// editor and the signer taps that same box on a phone; if the two rendered the
// document even slightly differently, a signature line would drift off the
// dotted rule it was placed on. Same renderer, same geometry, both ends.
//
// pdf.js is loaded lazily inside an effect. It is ~1.4MB and reaches for
// browser APIs at import time, so a static import would drag it into the
// server bundle and break SSR for a page most visitors reach on a phone.

import { useEffect, useRef, useState } from "react";

export interface PageBox {
  /** 0-based page index. */
  page: number;
  /** Rendered size in CSS pixels — the box fields are positioned against. */
  width: number;
  height: number;
}

export function PdfPages({
  fileUrl,
  onPages,
  renderOverlay,
}: {
  fileUrl: string;
  /** Fires once the whole document is rendered. */
  onPages?: (pages: PageBox[]) => void;
  /** Draws the field layer for a page, sized to that page's box. */
  renderOverlay?: (page: PageBox) => React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<PageBox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const canvases: HTMLCanvasElement[] = [];

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const pdfjs: any = await import("pdfjs-dist");
        // Served from our own origin rather than a CDN: the signing page must
        // keep working for a client whose network blocks third-party script
        // hosts, and an agreement that will not render cannot be signed.
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const doc = await pdfjs.getDocument({ url: fileUrl }).promise;
        if (cancelled) return;

        const host = hostRef.current;
        if (!host) return;
        host.innerHTML = "";

        // Fit the container, but never upscale past 2x — a phone at 3x DPR on
        // an A4 page produces canvases big enough to be killed by iOS.
        const containerWidth = host.clientWidth || 800;
        const boxes: PageBox[] = [];

        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = containerWidth / base.width;
          const viewport = page.getViewport({ scale });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          canvas.className = "block";

          const wrap = document.createElement("div");
          wrap.className =
            "relative mx-auto mb-4 w-fit rounded-lg border border-zinc-200 bg-white shadow-sm";
          wrap.dataset.page = String(n - 1);
          wrap.appendChild(canvas);
          host.appendChild(wrap);
          canvases.push(canvas);

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.scale(dpr, dpr);
            await page.render({ canvasContext: ctx, viewport }).promise;
          }
          boxes.push({
            page: n - 1,
            width: viewport.width,
            height: viewport.height,
          });
        }

        if (cancelled) return;
        setPages(boxes);
        onPages?.(boxes);
      } catch (e: any) {
        if (!cancelled) {
          setError(
            e?.message?.includes("Failed to fetch")
              ? "Couldn't load the document."
              : "Couldn't display this PDF.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const c of canvases) {
        c.width = 0;
        c.height = 0;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  return (
    <div className="relative">
      <div ref={hostRef} />

      {/* Overlays are portalled into the rendered page wrappers by index, so
          they inherit the exact canvas box without re-measuring. */}
      {pages.map((p) => (
        <PageOverlay key={p.page} host={hostRef} page={p}>
          {renderOverlay?.(p)}
        </PageOverlay>
      ))}

      {loading && (
        <p className="py-10 text-center text-sm text-zinc-400">
          Rendering document…
        </p>
      )}
      {error && (
        <div className="rounded-lg border border-zinc-200 p-6 text-center">
          <p className="text-sm text-zinc-600">{error}</p>
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-semibold text-orange-600 underline"
          >
            Open it directly
          </a>
        </div>
      )}
    </div>
  );
}

/** Mounts children absolutely inside the canvas wrapper for one page. */
function PageOverlay({
  host,
  page,
  children,
}: {
  host: React.RefObject<HTMLDivElement | null>;
  page: PageBox;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const wrap = host.current?.querySelector<HTMLElement>(
      `[data-page="${page.page}"]`,
    );
    setTarget(wrap ?? null);
  }, [host, page.page]);

  if (!target || !children) return null;
  return <PortalInto target={target}>{children}</PortalInto>;
}

function PortalInto({
  target,
  children,
}: {
  target: HTMLElement;
  children: React.ReactNode;
}) {
  const [mount, setMount] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "absolute inset-0";
    target.appendChild(el);
    setMount(el);
    return () => {
      el.remove();
    };
  }, [target]);

  if (!mount) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createPortal } = require("react-dom");
  return createPortal(children, mount);
}
