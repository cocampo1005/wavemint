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
