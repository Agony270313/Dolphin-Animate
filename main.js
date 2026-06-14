const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic.replace('app.asar', 'app.asar.unpacked')); // handle packaged paths


// Fix Windows cache permission issues
app.setPath('userData', path.join(app.getPath('appData'), 'Dolphin-Animate'));
const localUserData = path.join(app.getPath('appData'), 'Dolphin-Animate');
app.setPath('userData', localUserData);
app.setPath('sessionData', path.join(localUserData, 'Session'));
app.disableHardwareAcceleration();
// Fix disk cache errors by disabling GPU disk cache
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('enable-features', 'UseSkiaRenderer');

let mainWindow;
let updateDownloaded = false;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Dolphin Animate',

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false
    },
    backgroundColor: '#2d2d2d',
  });

  mainWindow.loadFile('dist/index.html');
  // mainWindow.webContents.openDevTools();
  mainWindow.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.webContents.send('request-close');
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  // Initial check after 5 seconds, then every 60 seconds
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 5000);
  setInterval(() => {
    if (!updateDownloaded) {
      autoUpdater.checkForUpdates();
    }
  }, 60000);
});

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('update-status', 'checking');
});

autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('update-status', 'available');
});

autoUpdater.on('update-not-available', (info) => {
  mainWindow?.webContents.send('update-status', 'up-to-date');
});

autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('update-progress', progress.percent);
});

autoUpdater.on('update-downloaded', (info) => {
  updateDownloaded = true;
  mainWindow?.webContents.send('update-status', 'downloaded');
  // Ask user if they want to restart now
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `Version ${info.version} is downloaded. Restart now to apply the update?`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
  });
  if (choice === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
  mainWindow?.webContents.send('update-status', 'error');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Export IPC handlers
ipcMain.handle('export-png-sequence', async (event, { frames, dirPath, fileName }) => {
  try {
    for (let i = 0; i < frames.length; i++) {
      const base64Data = frames[i].replace(/^data:image\/png;base64,/, '');
      const filePath = path.join(dirPath, `${fileName}_${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(filePath, base64Data, 'base64');
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-mp4', async (event, { frames, fps, filePath, audioBase64 }) => {
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolphin-'));
    for (let i = 0; i < frames.length; i++) {
      const base64Data = frames[i].replace(/^data:image\/png;base64,/, '');
      const framePath = path.join(tempDir, `frame_${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(framePath, base64Data, 'base64');
    }
    
    let audioPath = null;
    if (audioBase64) {
      audioPath = path.join(tempDir, 'audio.wav');
      const audioData = audioBase64.replace(/^data:audio\/wav;base64,/, '');
      fs.writeFileSync(audioPath, audioData, 'base64');
    }

    return new Promise((resolve) => {
      let command = ffmpeg()
        .input(path.join(tempDir, 'frame_%04d.png'))
        .inputFPS(fps);
        
      if (audioPath) {
        command = command.input(audioPath);
      }

      command
        .output(filePath)
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p'
        ])
        .on('end', () => {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e){}
          resolve({ success: true });
        })
        .on('error', (err) => {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e){}
          resolve({ success: false, error: err.message });
        })
        .run();
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-file', async (event, { defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters,
  });
  if (!result.canceled && result.filePath) {
    return result.filePath;
  }
  return null;
});

ipcMain.handle('open-file', async (event, { filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters,
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return null;
  }
});

ipcMain.handle('show-save-prompt', async () => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Save Project',
    message: 'Do you want to save the changes to your project?',
    detail: 'If you don\'t save, your changes will be lost.'
  });
  return res.response;
});

ipcMain.handle('quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.handle('export-sprite-sheet', async (event, { dirPath, fileName, pngData, meta }) => {
  try {
    const pngPath = path.join(dirPath, `${fileName}.png`);
    const jsonPath = path.join(dirPath, `${fileName}.json`);
    fs.writeFileSync(pngPath, pngData, 'base64');
    fs.writeFileSync(jsonPath, meta, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-file', async (event, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, data, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('restart-app', () => {
  autoUpdater.quitAndInstall();
});
