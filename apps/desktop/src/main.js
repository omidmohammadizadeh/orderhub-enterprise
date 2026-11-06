// Order Hub for Windows — a full-window shell around the web dashboard.
//
// Same idea as the tablet app (apps/mobile): the web POS IS the product, this
// just makes it feel like an installed till app instead of a browser tab.
// Unlike the tablet app it exposes NO native bridge (window.OrderHubBT /
// OrderHubNative): the web already has a complete desktop-browser printing
// path (lib/printing/browser-printers.ts — WebUSB, Web Serial, print dialog)
// and that path switches itself OFF the moment a native bridge is present.
// So this behaves like Chrome/Edge on Windows, plus:
//   - sign-in survives restarts (persistent session partition)
//   - the order sound plays without a click first
//   - the screen never sleeps mid-shift
//   - external links go to the system browser; our own pages (print pages,
//     /print/*) open in an app window that shares the signed-in session
//   - WebUSB / Web Serial device pickers, which Electron has no UI for

const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, session, shell } = require("electron");
const path = require("path");

// MUST be the canonical www host — the non-www host redirects, and the web
// session lives in per-origin localStorage (see apps/mobile PosWebView.tsx).
const WEB_URL = process.env.ORDERHUB_WEB_URL || "https://www.orderhubsolutions.com";
const START_URL = `${WEB_URL}/dashboard`;
const OUR_HOSTS = new Set(["www.orderhubsolutions.com", "orderhubsolutions.com", new URL(WEB_URL).host]);
const RETRY_MS = 10_000;

// The web POS plays an MP3 when an order lands; Chromium would block it
// until the operator clicks somewhere.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let retryTimer = null;

function isOurs(url) {
  try {
    return OUR_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

// Google refuses sign-in from user agents it recognises as embedded
// ("This browser or app may not be secure"). Present as the Chrome we are.
function chromeUserAgent(ua) {
  return ua.replace(/\s?Electron\/\S+/, "").replace(/\s?OrderHubSolutions\/\S+/i, "");
}

function configureSession(ses) {
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));

  // Camera (barcode scanning at the till), mic, notifications, clipboard,
  // fullscreen, USB/serial: granted for our own pages, refused elsewhere.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isOurs(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isOurs(origin));
  ses.setDevicePermissionHandler((details) => isOurs(details.origin));

  // navigator.usb.requestDevice() — Electron fires this instead of showing
  // Chrome's chooser, so we draw our own (a simple button list).
  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList || [];
    chooseDevice(
      "Choose a USB printer",
      devices.map((d) => d.productName || `USB device ${hex(d.vendorId)}:${hex(d.productId)}`),
    ).then((i) => callback(i == null ? "" : devices[i].deviceId));
  });

  // navigator.serial.requestPort() — COM ports, including Bluetooth printers
  // paired in Windows (they appear as an outgoing COM port).
  ses.on("select-serial-port", (event, portList, wc, callback) => {
    event.preventDefault();
    chooseDevice(
      "Choose a serial / Bluetooth printer port",
      portList.map((p) => [p.displayName || p.portName, p.portName].filter(Boolean).join(" — ")),
    ).then((i) => callback(i == null ? "" : portList[i].portId));
  });
}

function hex(n) {
  return Number(n || 0).toString(16).padStart(4, "0");
}

async function chooseDevice(title, labels) {
  if (labels.length === 0) {
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title,
      message: "No devices found",
      detail: "Check the printer is switched on and plugged in (or paired in Windows Settings → Bluetooth), then try again.",
    });
    return null;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title,
    message: title,
    buttons: [...labels, "Cancel"],
    cancelId: labels.length,
    noLink: true,
  });
  return response === labels.length ? null : response;
}

function showOffline(win, failedUrl) {
  win.loadFile(path.join(__dirname, "offline.html"), { query: { url: failedUrl || START_URL } });
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!win.isDestroyed()) win.loadURL(failedUrl || START_URL);
  }, RETRY_MS);
}

function wireNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Our own print pages need the signed-in session, so they open in an
    // app window (same partition) where Ctrl+P / Save as PDF works.
    if (isOurs(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 1100, height: 900 },
      };
    }
    if (/^https?:|^mailto:|^tel:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", (event, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED: a navigation we (or the page) cancelled, not an outage.
    if (!isMainFrame || code === -3) return;
    showOffline(win, url);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0F172A",
    autoHideMenuBar: true,
    title: "Order Hub Solutions",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Never throttle a background till: the orders feed and its sound
      // must keep running while another window is in front.
      backgroundThrottling: false,
    },
  });

  wireNavigation(mainWindow);
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
}

function buildMenu() {
  const reload = () => mainWindow?.webContents.reload();
  const template = [
    {
      label: "Order Hub",
      submenu: [
        { label: "Dashboard", accelerator: "Ctrl+H", click: () => mainWindow?.loadURL(START_URL) },
        { label: "Reload", accelerator: "Ctrl+R", click: reload },
        { label: "Reload", accelerator: "F5", visible: false, click: reload },
        { type: "separator" },
        { role: "togglefullscreen", accelerator: "F11" },
        { role: "zoomIn", accelerator: "Ctrl+=" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Open in browser", click: () => shell.openExternal(mainWindow?.webContents.getURL() || WEB_URL) },
        { label: "Developer tools", accelerator: "Ctrl+Shift+I", click: () => mainWindow?.webContents.toggleDevTools() },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  configureSession(session.defaultSession);
  buildMenu();
  // A till that dims mid-rush is a till that misses orders.
  powerSaveBlocker.start("prevent-display-sleep");
  createWindow();
});

// Child windows (print pages) also get our navigation rules.
app.on("web-contents-created", (event, contents) => {
  if (contents.getType() === "window") {
    contents.setWindowOpenHandler(({ url }) => {
      if (isOurs(url)) return { action: "allow" };
      if (/^https?:|^mailto:|^tel:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
  }
});

app.on("window-all-closed", () => app.quit());
