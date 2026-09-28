'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filmcutDesktop', {
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
});
