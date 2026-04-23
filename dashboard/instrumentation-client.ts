const HOTJAR_SITE_ID = 6697668;
const HOTJAR_VERSION = 6;

type HotjarWindow = Window & {
  _hjSettings?: {
    hjid: number;
    hjsv: number;
  };
  hj?: (...args: unknown[]) => void;
};

function initHotjar(siteId: number, version: number) {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const hotjarWindow = window as HotjarWindow;
  if (hotjarWindow._hjSettings?.hjid === siteId) return;

  const queueHotjarCall = (...args: unknown[]) => {
    const queued = queueHotjarCall as ((...innerArgs: unknown[]) => void) & {
      q?: unknown[][];
    };
    queued.q = queued.q ?? [];
    queued.q.push(args);
  };

  hotjarWindow.hj = hotjarWindow.hj ?? queueHotjarCall;
  hotjarWindow._hjSettings = { hjid: siteId, hjsv: version };

  if (document.querySelector(`script[data-hotjar-site-id="${siteId}"]`)) return;

  const hotjarScript = document.createElement("script");
  hotjarScript.async = true;
  hotjarScript.src = `https://static.hotjar.com/c/hotjar-${siteId}.js?sv=${version}`;
  hotjarScript.setAttribute("data-hotjar-site-id", String(siteId));
  document.head.appendChild(hotjarScript);
}

if (process.env.NODE_ENV === "production") {
  try {
    initHotjar(HOTJAR_SITE_ID, HOTJAR_VERSION);
  } catch (error) {
    console.error("[hotjar] Failed to initialize", error);
  }
}
