const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("waveMintAPI", {
  analyzeUrl: (payload) => ipcRenderer.invoke("analyze-url", payload),
  chooseOutputFolder: () => ipcRenderer.invoke("choose-output-folder"),
  chooseArtworkFile: () => ipcRenderer.invoke("choose-artwork-file"),
  generateSquareCropPreview: (payload) =>
    ipcRenderer.invoke("generate-square-crop-preview", payload),
  downloadMp3: (payload) => ipcRenderer.invoke("download-mp3", payload),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  openFolder: (folderPath) => ipcRenderer.invoke("open-folder", folderPath),

  getAppStatus: (options) => ipcRenderer.invoke("get-app-status", options),

  // YouTube authentication. File and folder paths are always chosen through
  // main-process dialogs; cookie contents never cross this bridge.
  getAuthState: () => ipcRenderer.invoke("auth-get-state"),
  setAuthMode: (mode) => ipcRenderer.invoke("auth-set-mode", mode),
  detectBrowsers: () => ipcRenderer.invoke("auth-detect-browsers"),
  setAuthBrowser: (payload) => ipcRenderer.invoke("auth-set-browser", payload),
  chooseBrowserProfileFolder: (browserId) =>
    ipcRenderer.invoke("auth-choose-profile-folder", browserId),
  chooseCookiesFile: () => ipcRenderer.invoke("auth-choose-cookies-file"),
  removeCookiesFile: () => ipcRenderer.invoke("auth-remove-cookies-file"),
  testAuthentication: () => ipcRenderer.invoke("auth-test"),

  onAnalyzeProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on("analyze-progress", listener);
    return () => ipcRenderer.removeListener("analyze-progress", listener);
  },

  onDownloadProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
});
