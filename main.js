const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

let mainWindow;
let rsyncProcess = null;
let jobManager = null;

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.activeJobs = new Set();
    this.maxConcurrentJobs = 3;
  }

  createJob(config) {
    const job = {
      id: crypto.randomUUID(),
      name: config.name || `${config.isMove ? 'Move' : 'Copy'} Job`,
      source: config.source,
      target: config.target,
      isMove: config.isMove,
      status: 'pending',
      progress: 0,
      startTime: null,
      endTime: null,
      process: null,
      error: null,
      createdAt: new Date().toISOString()
    };
    
    this.jobs.set(job.id, job);
    this.notifyJobUpdate(job);
    return job.id;
  }

  startJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'running') return false;
    
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      job.status = 'queued';
      this.notifyJobUpdate(job);
      return false;
    }

    job.status = 'running';
    job.startTime = new Date().toISOString();
    job.error = null;
    this.activeJobs.add(jobId);
    
    this.executeJob(job);
    this.notifyJobUpdate(job);
    return true;
  }

  executeJob(job) {
    const args = ['-avz', '--partial', '--progress', '--human-readable'];
    
    if (job.isMove) {
      args.push('--remove-source-files');
    }
    
    args.push(job.source + '/');
    args.push(job.target);

    job.process = spawn('rsync', args);

    job.process.stdout.on('data', (data) => {
      const output = data.toString();
      this.notifyJobProgress(job.id, output);
    });

    job.process.stderr.on('data', (data) => {
      const error = data.toString();
      job.error = error;
      this.notifyJobError(job.id, error);
    });

    job.process.on('close', (code) => {
      job.endTime = new Date().toISOString();
      job.status = code === 0 ? 'completed' : 'failed';
      job.process = null;
      
      this.activeJobs.delete(job.id);
      this.notifyJobUpdate(job);
      this.startNextQueuedJob();
    });

    job.process.on('error', (error) => {
      job.error = error.message;
      job.status = 'failed';
      job.endTime = new Date().toISOString();
      job.process = null;
      
      this.activeJobs.delete(job.id);
      this.notifyJobUpdate(job);
      this.startNextQueuedJob();
    });
  }

  pauseJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return false;
    
    if (job.process) {
      try {
        job.process.kill('SIGSTOP');
        job.status = 'paused';
        this.notifyJobUpdate(job);
        return true;
      } catch (error) {
        console.error('Error pausing job:', error);
        return false;
      }
    }
    return false;
  }

  resumeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return false;
    
    if (job.process) {
      try {
        job.process.kill('SIGCONT');
        job.status = 'running';
        this.notifyJobUpdate(job);
        return true;
      } catch (error) {
        console.error('Error resuming job:', error);
        return false;
      }
    }
    return false;
  }

  stopJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || !['running', 'paused', 'queued'].includes(job.status)) return false;
    
    if (job.process) {
      job.process.kill();
      job.process = null;
    }
    
    job.status = 'stopped';
    job.endTime = new Date().toISOString();
    this.activeJobs.delete(jobId);
    this.notifyJobUpdate(job);
    this.startNextQueuedJob();
    return true;
  }

  restartJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    if (job.process) {
      job.process.kill();
      job.process = null;
    }
    
    this.activeJobs.delete(jobId);
    job.status = 'pending';
    job.progress = 0;
    job.startTime = null;
    job.endTime = null;
    job.error = null;
    
    this.notifyJobUpdate(job);
    return this.startJob(jobId);
  }

  removeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    if (job.process) {
      job.process.kill();
    }
    
    this.activeJobs.delete(jobId);
    this.jobs.delete(jobId);
    this.notifyJobRemoved(jobId);
    this.startNextQueuedJob();
    return true;
  }

  startNextQueuedJob() {
    if (this.activeJobs.size >= this.maxConcurrentJobs) return;
    
    const queuedJob = Array.from(this.jobs.values())
      .find(job => job.status === 'queued');
    
    if (queuedJob) {
      this.startJob(queuedJob.id);
    }
  }

  getAllJobs() {
    return Array.from(this.jobs.values()).map(job => {
      // Create a serializable copy without the process object
      const { process, ...serializableJob } = job;
      return serializableJob;
    });
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    
    // Create a serializable copy without the process object
    const { process, ...serializableJob } = job;
    return serializableJob;
  }

  notifyJobUpdate(job) {
    if (mainWindow) {
      // Send serializable copy without process object
      const { process, ...serializableJob } = job;
      mainWindow.webContents.send('job-update', serializableJob);
    }
  }

  notifyJobProgress(jobId, output) {
    if (mainWindow) {
      mainWindow.webContents.send('job-progress', { jobId, output });
    }
  }

  notifyJobError(jobId, error) {
    if (mainWindow) {
      mainWindow.webContents.send('job-error', { jobId, error });
    }
  }

  notifyJobRemoved(jobId) {
    if (mainWindow) {
      mainWindow.webContents.send('job-removed', jobId);
    }
  }
}

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
  jobManager = new JobManager();
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

// Job Management IPC handlers
ipcMain.handle('create-job', async (event, config) => {
  if (!jobManager) return null;
  return jobManager.createJob(config);
});

ipcMain.handle('start-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.startJob(jobId);
});

ipcMain.handle('pause-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.pauseJob(jobId);
});

ipcMain.handle('resume-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.resumeJob(jobId);
});

ipcMain.handle('stop-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.stopJob(jobId);
});

ipcMain.handle('restart-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.restartJob(jobId);
});

ipcMain.handle('remove-job', async (event, jobId) => {
  if (!jobManager) return false;
  return jobManager.removeJob(jobId);
});

ipcMain.handle('get-all-jobs', async () => {
  if (!jobManager) return [];
  return jobManager.getAllJobs();
});

ipcMain.handle('get-job', async (event, jobId) => {
  if (!jobManager) return null;
  return jobManager.getJob(jobId);
});