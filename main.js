const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let rsyncProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    titleBarStyle: 'default',
    movable: true,
    resizable: true
  });

  mainWindow.loadFile('index.html');
  
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('select-folder', async (event, isSource = true) => {
  try {
    console.log('Opening folder dialog using osascript...');
    
    // Use native macOS dialog via osascript
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);
    
    const title = isSource ? 'Select Source Folder' : 'Select Target Folder';
    const defaultPath = isSource ? '/Volumes' : process.env.HOME;
    
    const script = `osascript -e 'tell application "System Events" to return POSIX path of (choose folder with prompt "${title}" default location "${defaultPath}")'`;
    
    const { stdout } = await execAsync(script);
    const selectedPath = stdout.trim();
    
    console.log('Selected path:', selectedPath);
    return selectedPath || null;
    
  } catch (error) {
    console.error('Error opening dialog:', error);
    
    // Fallback to Electron dialog
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: isSource ? 'Select Source Folder' : 'Select Target Folder',
        defaultPath: isSource ? '/Volumes' : process.env.HOME
      });
      
      if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch (fallbackError) {
      console.error('Fallback dialog also failed:', fallbackError);
    }
    
    return null;
  }
});

ipcMain.handle('start-rsync', async (event, config) => {
  return new Promise((resolve, reject) => {
    if (rsyncProcess) {
      rsyncProcess.kill();
    }

    const args = [
      '-avz',
      '--partial',
      '--progress',
      '--human-readable'
    ];

    if (config.isMove) {
      args.push('--remove-source-files');
    }

    args.push(config.source + '/');
    args.push(config.target);

    rsyncProcess = spawn('rsync', args);

    rsyncProcess.stdout.on('data', (data) => {
      mainWindow.webContents.send('rsync-progress', data.toString());
    });

    rsyncProcess.stderr.on('data', (data) => {
      mainWindow.webContents.send('rsync-error', data.toString());
    });

    rsyncProcess.on('close', (code) => {
      mainWindow.webContents.send('rsync-complete', code);
      rsyncProcess = null;
      resolve(code);
    });

    rsyncProcess.on('error', (error) => {
      mainWindow.webContents.send('rsync-error', error.message);
      reject(error);
    });
  });
});

ipcMain.handle('stop-rsync', async () => {
  if (rsyncProcess) {
    rsyncProcess.kill();
    rsyncProcess = null;
    return true;
  }
  return false;
});

ipcMain.handle('save-config', async (event, config) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('load-config', async () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const data = await fs.promises.readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
});