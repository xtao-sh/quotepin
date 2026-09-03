const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("reviewAnnotationDesktop", {
  pickDocumentPath: () => ipcRenderer.invoke("review:pick-document-path"),
  pickDocumentPaths: () => ipcRenderer.invoke("review:pick-document-paths"),
  pickProjectDirectory: () => ipcRenderer.invoke("review:pick-project-directory"),
  getFilePath: (file) => webUtils.getPathForFile(file),
  onBeforeClose: (callback) => {
    const listener = (_event, requestId) => callback(requestId);
    ipcRenderer.on("review:before-close", listener);
    return () => ipcRenderer.removeListener("review:before-close", listener);
  },
  signalCloseReady: (requestId, result) => ipcRenderer.send("review:close-ready", { requestId, ...result })
});
