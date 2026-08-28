// Electron shell for EREBUS — Descent.
//
// The game is a Vite/ESM app that uses a Web Worker to bake its procedural texture library.
// Loading it over file:// does not work: Chromium blocks ES module scripts and worker
// construction from that scheme. Rather than disable webSecurity, the shell starts a tiny
// static server bound to 127.0.0.1 on an ephemeral port and points the window at it, which
// keeps normal web security semantics and lets modules and workers behave exactly as they do
// in the browser build.
const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function createWindow() {
  const port = await serve();
  const win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1024, minHeight: 576,
    backgroundColor: '#07060f',
    title: 'EREBUS — Descent',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // Open real links in the user's browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

// A minimal menu: the default one is full of web-inspector affordances a player does not want,
// but F11 fullscreen and a reload escape hatch are genuinely useful.
function menu(win) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Game',
    submenu: [
      { label: 'Toggle Fullscreen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.reload() },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]));
}

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.whenReady().then(async () => {
  const win = await createWindow();
  menu(win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
