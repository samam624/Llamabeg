"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llamaAPI", {
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("llama:update", listener);
    return () => ipcRenderer.removeListener("llama:update", listener);
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  pickFolder: (defaultPath) => ipcRenderer.invoke("dialog:pick-folder", defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  listCampaigns: () => ipcRenderer.invoke("campaigns:list"),
  selectCampaign: (campaignKey) => ipcRenderer.invoke("campaigns:select", campaignKey),
  hidePlayer: (name) => ipcRenderer.invoke("players:hide", name),
  unhidePlayer: (name) => ipcRenderer.invoke("players:unhide", name),
  analyzeModifier: (request) => ipcRenderer.invoke("modifiers:analyze", request),
  listModifierCatalog: () => ipcRenderer.invoke("modifiers:catalog"),
  listSocietalValueAxes: () => ipcRenderer.invoke("societal-values:list"),
  analyzeSocietalValue: (request) => ipcRenderer.invoke("societal-values:analyze", request),
});
