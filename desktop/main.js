'use strict';
/**
 * FilmCut 裁片 Windows 桌面壳（Electron，复刻 ImgMark 桌面壳模式）
 * - 主进程内直接 require FilmCut 的 Express 服务（同 Node 栈），端口占用自动 +1，
 *   28210 已有 filmcut 实例则直接复用
 * - preload 暴露 window.filmcutDesktop：原生文件夹对话框（扫描目录 / 输出目录不用手输路径）
 * - 关闭窗口 = 缩到托盘，扫描监听不受影响；真正退出走托盘菜单
 */
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const http = require('node:http');

const BASE_PORT = Number(process.env.FILMCUT_PORT || 28210);
let win = null;
let tray = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

function probeFilmcut(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'filmcut'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await probeFilmcut(p)) return p;
  }
  // 服务代码打包在 resources/filmcut/server（开发时用仓库根）
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'filmcut', 'server')
    : path.join(__dirname, '..');
  process.env.FILMCUT_DATA_DIR = app.getPath('userData'); // 必须在 require 前设置
  const { start } = require(path.join(serverRoot, 'src', 'server.js'));
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await probeFilmcut(p)) return p;
    // 只绑回环地址：桌面版无鉴权，绑 0.0.0.0 等于把文件浏览接口暴露给整个局域网
    try { await start({ port: p, host: '127.0.0.1' }); return p; }
    catch { /* 端口被其它程序占用，换下一个 */ }
  }
  throw new Error('28210 起连续 20 个端口均不可用');
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 620,
    title: 'FilmCut 裁片', icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true, backgroundColor: '#f4f6f9',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 关闭窗口 = 缩到托盘；真正退出走托盘菜单「退出」
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('FilmCut 裁片');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMain },
    { type: 'separator' },
    { label: '退出 FilmCut', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function showMain() {
  if (!win) createWindow(boundPort);
  else { win.show(); win.focus(); }
}

// ---- 原生对话框：选文件夹（扫描目录 / 输出目录）----
ipcMain.handle('pick-folder', async (e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: String(title || '选择文件夹'),
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

let boundPort = BASE_PORT;

app.whenReady().then(async () => {
  app.setAppUserModelId('cn.techysy.filmcut');
  try { boundPort = await startServer(); } catch (e) {
    dialog.showErrorBox('FilmCut 启动失败', String(e.message || e));
    app.quit();
    return;
  }
  createWindow(boundPort);
  createTray();
  app.on('activate', () => showMain());
});

app.on('before-quit', () => { isQuitting = true; });
app.on('second-instance', () => showMain());
app.on('window-all-closed', () => app.quit());
