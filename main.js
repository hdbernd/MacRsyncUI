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
      createdAt: new Date().toISOString(),
      // Progress tracking
      progressData: {
        percentage: 0,
        currentSpeed: '0B/s',
        averageSpeed: '0B/s',
        transferred: '0B',
        total: '0B',
        totalBytes: 0,
        eta: null,
        currentFile: '',
        fileCount: { current: 0, total: 0 },
        speedHistory: [],
        lastUpdate: null
      }
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
    const args = ['-avz', '--partial', '--progress', '--human-readable', '--stats'];
    
    if (job.isMove) {
      args.push('--remove-source-files');
    }
    
    args.push(job.source + '/');
    args.push(job.target);

    job.process = spawn('rsync', args);

    job.process.stdout.on('data', (data) => {
      const output = data.toString();
      this.parseProgressData(job, output);
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
    
    // Reset progress data
    job.progressData = {
      percentage: 0,
      currentSpeed: '0B/s',
      averageSpeed: '0B/s',
      transferred: '0B',
      total: '0B',
      totalBytes: 0,
      eta: null,
      currentFile: '',
      fileCount: { current: 0, total: 0 },
      speedHistory: [],
      lastUpdate: null
    };
    
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

  parseProgressData(job, output) {
    console.log('Raw rsync output:', JSON.stringify(output));
    const lines = output.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      // Parse file count from the "to-chk" line (this gives us overall progress info)
      // Format: "  1,234,567  100%   12.34MB/s    0:00:15 (xfr#123, to-chk=45/678)"
      const fileCountMatch = trimmedLine.match(/\(xfr#(\d+),\s*(?:ir-chk|to-chk)=(\d+)\/(\d+)\)/);
      if (fileCountMatch) {
        const [, xfrNum, remaining, total] = fileCountMatch;
        job.progressData.fileCount.total = parseInt(total);
        job.progressData.fileCount.current = parseInt(total) - parseInt(remaining);
        
        // Calculate overall progress based on files transferred
        const fileProgress = Math.round((job.progressData.fileCount.current / job.progressData.fileCount.total) * 100);
        job.progressData.percentage = fileProgress;
        job.progress = fileProgress;
        
        console.log(`Job ${job.id}: ${job.progressData.fileCount.current}/${job.progressData.fileCount.total} files = ${fileProgress}% overall progress`);
      }
      
      // Parse progress line with speed and timing info
      // Format: "  1,234,567  75%   12.34MB/s    0:00:15"
      const progressMatch = trimmedLine.match(/^\s*(\d{1,3}(?:,\d{3})*|\d+)\s+(\d+)%\s+([\d.]+[KMGT]?B\/s)\s+(\d+:\d+:\d+)/);
      if (progressMatch) {
        const [, transferred, , speed, timeRemaining] = progressMatch;
        
        job.progressData.currentSpeed = speed;
        job.progressData.transferred = this.formatBytes(parseInt(transferred.replace(/,/g, '')));
        job.progressData.eta = timeRemaining;
        job.progressData.lastUpdate = Date.now();
        
        // Add to speed history
        job.progressData.speedHistory.push({
          timestamp: Date.now(),
          speed: this.parseSpeed(speed)
        });
        
        if (job.progressData.speedHistory.length > 60) {
          job.progressData.speedHistory.shift();
        }
        
        // Calculate average speed
        if (job.progressData.speedHistory.length > 1) {
          const avgSpeed = job.progressData.speedHistory.reduce((sum, entry) => sum + entry.speed, 0) / job.progressData.speedHistory.length;
          job.progressData.averageSpeed = this.formatSpeed(avgSpeed);
        }
        
        continue;
      }
      
      // Parse current file being transferred
      if (trimmedLine.length > 0 && 
          !trimmedLine.includes('%') && 
          !trimmedLine.includes('receiving file list') &&
          !trimmedLine.includes('sending incremental') &&
          !trimmedLine.includes('total size') &&
          !trimmedLine.includes('speedup') &&
          !trimmedLine.includes('Number of files') &&
          !trimmedLine.includes('Total file size') &&
          !trimmedLine.includes('delta-transmission') &&
          !trimmedLine.match(/^\s*$/) &&
          !trimmedLine.match(/^[\d,]+\s+\d+%/) &&
          !trimmedLine.includes('(') &&
          trimmedLine.length > 3) {
        
        job.progressData.currentFile = trimmedLine.substring(0, 50) + (trimmedLine.length > 50 ? '...' : '');
        console.log(`Job ${job.id}: Current file: ${job.progressData.currentFile}`);
      }
      
      // Parse file list completion
      if (trimmedLine.includes('receiving file list') && trimmedLine.includes('done')) {
        job.progressData.currentFile = 'File list received, starting transfer...';
      }
    }
  }

  parseSpeed(speedStr) {
    const match = speedStr.match(/([\d.]+)([KMGT]?)B\/s/);
    if (!match) return 0;
    
    const [, value, unit] = match;
    const multipliers = { '': 1, 'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4 };
    return parseFloat(value) * (multipliers[unit] || 1);
  }

  formatSpeed(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    let unitIndex = 0;
    let speed = bytesPerSecond;
    
    while (speed >= 1024 && unitIndex < units.length - 1) {
      speed /= 1024;
      unitIndex++;
    }
    
    return `${speed.toFixed(2)}${units[unitIndex]}`;
  }

  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)}${units[unitIndex]}`;
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