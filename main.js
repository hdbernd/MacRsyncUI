const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

let mainWindow;
let rsyncProcess = null;
let jobManager = null;

class SmartJobNaming {
  static async generateJobName(sourcePath, targetPath, isMove = false) {
    try {
      const sourceInfo = await this.analyzeFolder(sourcePath);
      const targetInfo = await this.analyzeFolder(targetPath);
      
      const operation = isMove ? 'Move' : 'Copy';
      const timestamp = new Date().toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      
      // Generate smart name based on analysis
      let smartName = this.generateNameFromAnalysis(sourceInfo, targetInfo, operation);
      
      return `${smartName} - ${timestamp}`;
    } catch (error) {
      console.error('Error generating smart name:', error);
      return this.generateFallbackName(sourcePath, isMove);
    }
  }
  
  static async analyzeFolder(folderPath) {
    try {
      const baseName = path.basename(folderPath);
      const stats = { name: baseName, type: 'unknown', fileCount: 0, totalSize: 0, fileTypes: {} };
      
      // Get basic folder info
      try {
        // Get actual file count (not limited)
        const { stdout: countOutput } = await execAsync(`find "${folderPath}" -type f | wc -l`);
        stats.fileCount = parseInt(countOutput.trim()) || 0;
        
        // Get file list sample for type analysis (limited for performance)
        const { stdout } = await execAsync(`find "${folderPath}" -type f | head -50`);
        const files = stdout.trim().split('\n').filter(f => f);
        
        // Analyze file types
        for (const file of files.slice(0, 20)) { // Sample first 20 files
          const ext = path.extname(file).toLowerCase();
          if (ext) {
            stats.fileTypes[ext] = (stats.fileTypes[ext] || 0) + 1;
          }
        }
        
        // Get folder size (limited for performance)
        try {
          const { stdout: sizeOutput } = await execAsync(`du -sh "${folderPath}" 2>/dev/null || echo "0K"`);
          stats.totalSize = sizeOutput.split('\t')[0];
        } catch (e) {
          stats.totalSize = 'Unknown';
        }
        
      } catch (e) {
        console.log('Could not analyze folder contents:', e.message);
      }
      
      // Determine folder type
      stats.type = this.categorizeFolder(baseName, stats.fileTypes);
      
      return stats;
    } catch (error) {
      return { name: path.basename(folderPath), type: 'unknown', fileCount: 0, fileTypes: {} };
    }
  }
  
  static categorizeFolder(folderName, fileTypes) {
    const name = folderName.toLowerCase();
    const extensions = Object.keys(fileTypes);
    
    // Camera/Photo folders
    if (name.includes('dcim') || name.includes('camera') || name.includes('photos')) {
      return 'photos';
    }
    
    // Video folders
    if (name.includes('video') || name.includes('movies')) {
      return 'videos';
    }
    
    // Document folders
    if (name.includes('documents') || name.includes('papers') || name.includes('files')) {
      return 'documents';
    }
    
    // Music folders
    if (name.includes('music') || name.includes('audio') || name.includes('songs')) {
      return 'music';
    }
    
    // Backup folders
    if (name.includes('backup') || name.includes('archive')) {
      return 'backup';
    }
    
    // Analyze by file extensions
    const photoExts = ['.jpg', '.jpeg', '.png', '.raw', '.dng', '.tiff', '.heic'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp'];
    const docExts = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.pages'];
    const musicExts = ['.mp3', '.m4a', '.wav', '.flac', '.aac'];
    
    const photoCount = extensions.filter(ext => photoExts.includes(ext)).length;
    const videoCount = extensions.filter(ext => videoExts.includes(ext)).length;
    const docCount = extensions.filter(ext => docExts.includes(ext)).length;
    const musicCount = extensions.filter(ext => musicExts.includes(ext)).length;
    
    if (photoCount > 0 && photoCount >= videoCount) return 'photos';
    if (videoCount > 0) return 'videos';
    if (docCount > 0) return 'documents';
    if (musicCount > 0) return 'music';
    
    return 'files';
  }
  
  static generateNameFromAnalysis(sourceInfo, targetInfo, operation) {
    const typeMap = {
      'photos': 'Photo Import',
      'videos': 'Video Transfer',
      'documents': 'Document Backup',
      'music': 'Music Sync',
      'backup': 'Backup Job',
      'files': 'File Transfer'
    };
    
    const sourceType = typeMap[sourceInfo.type] || 'Transfer';
    const sourceName = sourceInfo.name;
    
    // Check if it's a camera/device import
    if (sourceInfo.type === 'photos' && sourceName.toUpperCase().includes('DCIM')) {
      return `Camera Import (${sourceInfo.fileCount} items)`;
    }
    
    // Check if it's going to a backup location
    if (targetInfo.name.toLowerCase().includes('backup') || 
        targetInfo.name.toLowerCase().includes('archive')) {
      return `${sourceType} to ${targetInfo.name}`;
    }
    
    // Default naming with file count
    const fileCountStr = sourceInfo.fileCount > 0 ? ` (${sourceInfo.fileCount} files)` : '';
    return `${sourceType}: ${sourceName}${fileCountStr}`;
  }
  
  static generateFallbackName(sourcePath, isMove) {
    const operation = isMove ? 'Move' : 'Copy';
    const folderName = path.basename(sourcePath);
    const timestamp = new Date().toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    return `${operation} ${folderName} - ${timestamp}`;
  }
}

class ErrorAnalyzer {
  static analyzeError(errorMessage) {
    const error = errorMessage.toLowerCase();
    
    // Common rsync error patterns and solutions
    const errorPatterns = [
      {
        pattern: /permission denied|operation not permitted/,
        title: '🔒 Permission Error',
        explanation: 'The transfer failed due to insufficient permissions.',
        solutions: [
          'Check that you have write permissions to the target folder',
          'Try running with administrator privileges if copying system files',
          'Ensure the source files are not locked or in use by another application'
        ]
      },
      {
        pattern: /no space left on device/,
        title: '💾 Storage Full',
        explanation: 'The destination drive does not have enough free space.',
        solutions: [
          'Free up space on the target drive',
          'Choose a different destination with more available space',
          'Consider compressing files before transfer'
        ]
      },
      {
        pattern: /connection refused|host unreachable|network/,
        title: '🌐 Network Error',
        explanation: 'Cannot connect to the remote destination.',
        solutions: [
          'Check your network connection',
          'Verify the target path is accessible and mounted',
          'Try reconnecting to the network drive or NAS'
        ]
      },
      {
        pattern: /file exists|already exists/,
        title: '📁 File Conflict',
        explanation: 'Files with the same name already exist at the destination.',
        solutions: [
          'Use different rsync options to handle duplicates',
          'Rename conflicting files manually',
          'Choose to skip existing files or overwrite them'
        ]
      },
      {
        pattern: /invalid argument|illegal option/,
        title: '⚙️ Invalid Parameters',
        explanation: 'The rsync command contains invalid options or arguments.',
        solutions: [
          'Check that file paths contain valid characters',
          'Verify source and target paths exist',
          'Try using different rsync options'
        ]
      },
      {
        pattern: /timeout|timed out/,
        title: '⏱️ Connection Timeout',
        explanation: 'The transfer took too long and timed out.',
        solutions: [
          'Check network stability and speed',
          'Try transferring smaller batches of files',
          'Increase timeout settings if available'
        ]
      },
      {
        pattern: /rsync: unrecognized option/,
        title: '🔧 Unsupported Option',
        explanation: 'Your version of rsync does not support this option.',
        solutions: [
          'Update rsync to the latest version',
          'Use alternative transfer method for this feature',
          'Check rsync documentation for supported options'
        ]
      }
    ];
    
    // Find matching error pattern
    for (const errorInfo of errorPatterns) {
      if (errorInfo.pattern.test(error)) {
        return {
          type: 'analyzed',
          title: errorInfo.title,
          explanation: errorInfo.explanation,
          solutions: errorInfo.solutions,
          originalError: errorMessage
        };
      }
    }
    
    // Generic error if no specific pattern matches
    return {
      type: 'generic',
      title: '❌ Transfer Error',
      explanation: 'An error occurred during the file transfer.',
      solutions: [
        'Check the error message below for specific details',
        'Verify source and target paths are correct and accessible',
        'Try restarting the transfer',
        'Check available disk space and permissions'
      ],
      originalError: errorMessage
    };
  }
  
  static formatErrorSuggestion(analysis) {
    let message = `${analysis.title}\n${analysis.explanation}\n\nSuggested solutions:`;
    analysis.solutions.forEach((solution, index) => {
      message += `\n${index + 1}. ${solution}`;
    });
    message += `\n\nOriginal error: ${analysis.originalError}`;
    return message;
  }
}

class TransferOptimizer {
  static getOptimizationRecommendations(sourceInfo, targetInfo, transferHistory) {
    const recommendations = [];
    
    // File type specific optimizations
    if (sourceInfo.type === 'photos') {
      recommendations.push({
        type: 'optimization',
        title: '📸 Photo Transfer Detected',
        suggestion: `Transferring ${sourceInfo.fileCount} photo files - compression is already enabled`,
        details: 'Your photos will be transferred efficiently with built-in compression (-z option)'
      });
    }
    
    if (sourceInfo.type === 'videos') {
      recommendations.push({
        type: 'optimization',
        title: '🎬 Video Transfer Detected',
        suggestion: `Transferring ${sourceInfo.fileCount} video files - resume capability is enabled`,
        details: 'Large video files can be resumed if interrupted (--partial option active)'
      });
    }
    
    // Size-based recommendations
    if (sourceInfo.fileCount > 500) {
      recommendations.push({
        type: 'performance',
        title: '🚀 Large Transfer Detected',
        suggestion: `Processing ${sourceInfo.fileCount} files - monitor progress carefully`,
        details: 'Large transfers benefit from the parallel job system and progress tracking'
      });
    }
    
    // Historical performance recommendations
    if (transferHistory && transferHistory.length > 0) {
      const avgSpeed = transferHistory.reduce((sum, t) => {
        const speed = this.parseSpeedToBytes(t.averageSpeed);
        return sum + speed;
      }, 0) / transferHistory.length;
      
      if (avgSpeed < 10 * 1024 * 1024) { // Less than 10MB/s
        recommendations.push({
          type: 'network',
          title: '🌐 Network Performance Notice',
          suggestion: 'Previous transfers averaged less than 10MB/s - consider off-peak hours',
          details: 'Network congestion may be affecting transfer speeds based on your history'
        });
      } else {
        recommendations.push({
          type: 'network',
          title: '🌐 Good Network Performance',
          suggestion: `Previous transfers averaged ${this.formatSpeed(avgSpeed)} - network looks good`,
          details: 'Your transfer history shows consistent performance'
        });
      }
    }
    
    // Backup-specific recommendations
    if (targetInfo.name.toLowerCase().includes('backup')) {
      recommendations.push({
        type: 'backup',
        title: '💾 Backup Operation Detected',
        suggestion: 'Archive mode (-a) ensures file permissions and timestamps are preserved',
        details: 'Your backup will maintain original file attributes and directory structure'
      });
    }
    
    return recommendations;
  }
  
  static parseSpeedToBytes(speedStr) {
    const match = speedStr.match(/([\d.]+)([KMGT]?)B\/s/);
    if (!match) return 0;
    
    const [, value, unit] = match;
    const multipliers = { '': 1, 'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4 };
    return parseFloat(value) * (multipliers[unit] || 1);
  }
  
  static formatSpeed(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unitIndex = 0;
    
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    
    return `${value.toFixed(1)}${units[unitIndex]}`;
  }
  
  static getTimeBasedRecommendations() {
    const hour = new Date().getHours();
    const recommendations = [];
    
    // Time-based suggestions
    if (hour >= 9 && hour <= 17) {
      recommendations.push({
        type: 'timing',
        title: '⏰ Business Hours Transfer',
        suggestion: 'Large transfers during business hours may be slower due to network usage',
        details: 'Evening transfers (after 6 PM) typically achieve better speeds'
      });
    } else if (hour >= 22 || hour <= 6) {
      recommendations.push({
        type: 'timing',
        title: '⏰ Off-Peak Hours - Optimal Time',
        suggestion: 'Excellent time for large transfers - minimal network congestion',
        details: 'Night hours typically provide the best transfer performance'
      });
    } else {
      recommendations.push({
        type: 'timing',
        title: '⏰ Good Transfer Time',
        suggestion: 'Evening hours offer good balance of availability and performance',
        details: 'This is a good time for most file transfer operations'
      });
    }
    
    return recommendations;
  }
}

class TransferHistory {
  constructor() {
    this.historyFile = path.join(app.getPath('userData'), 'transfer_history.json');
    this.history = this.loadHistory();
  }
  
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading transfer history:', error);
    }
    return [];
  }
  
  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    } catch (error) {
      console.error('Error saving transfer history:', error);
    }
  }
  
  recordTransfer(job) {
    const record = {
      id: job.id,
      name: job.name,
      source: job.source,
      target: job.target,
      isMove: job.isMove,
      status: job.status,
      startTime: job.startTime,
      endTime: job.endTime,
      duration: job.endTime && job.startTime ? 
        new Date(job.endTime) - new Date(job.startTime) : null,
      fileCount: job.progressData?.fileCount?.total || 0,
      transferred: job.progressData?.transferred || '0B',
      averageSpeed: job.progressData?.averageSpeed || '0B/s',
      recordedAt: new Date().toISOString()
    };
    
    this.history.unshift(record); // Add to beginning
    
    // Keep only last 100 transfers
    if (this.history.length > 100) {
      this.history = this.history.slice(0, 100);
    }
    
    this.saveHistory();
  }
  
  getRecentTransfers(limit = 10) {
    return this.history.slice(0, limit);
  }
  
  getSimilarTransfers(sourcePath, targetPath) {
    return this.history.filter(record => 
      record.source === sourcePath || 
      record.target === targetPath ||
      path.basename(record.source) === path.basename(sourcePath)
    );
  }
  
  predictTransferTime(fileCount, totalSize) {
    const similar = this.history.filter(record => 
      record.fileCount > 0 && record.duration > 0
    );
    
    if (similar.length === 0) return null;
    
    // Simple prediction based on file count
    const avgTimePerFile = similar.reduce((sum, record) => 
      sum + (record.duration / record.fileCount), 0) / similar.length;
    
    return Math.round(avgTimePerFile * fileCount / 1000); // Convert to seconds
  }
}

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.activeJobs = new Set();
    this.maxConcurrentJobs = 3;
    this.transferHistory = new TransferHistory();
  }

  async createJob(config) {
    // Generate smart name if not provided
    let jobName = config.name;
    if (!jobName || jobName.trim() === '') {
      try {
        jobName = await SmartJobNaming.generateJobName(config.source, config.target, config.isMove);
      } catch (error) {
        console.error('Error generating smart name:', error);
        jobName = SmartJobNaming.generateFallbackName(config.source, config.isMove);
      }
    }

    const job = {
      id: crypto.randomUUID(),
      name: jobName,
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
      
      // Analyze error and provide suggestions
      const analysis = ErrorAnalyzer.analyzeError(error);
      this.notifyJobError(job.id, error, analysis);
    });

    job.process.on('close', (code) => {
      job.endTime = new Date().toISOString();
      job.status = code === 0 ? 'completed' : 'failed';
      job.process = null;
      
      // Record in transfer history
      this.transferHistory.recordTransfer(job);
      
      this.activeJobs.delete(job.id);
      this.notifyJobUpdate(job);
      this.startNextQueuedJob();
    });

    job.process.on('error', (error) => {
      job.error = error.message;
      job.status = 'failed';
      job.endTime = new Date().toISOString();
      job.process = null;
      
      // Record failed transfer in history
      this.transferHistory.recordTransfer(job);
      
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
        const totalFiles = parseInt(total);
        const remainingFiles = parseInt(remaining);
        const currentFiles = totalFiles - remainingFiles;
        
        job.progressData.fileCount.total = totalFiles;
        job.progressData.fileCount.current = currentFiles;
        
        // Calculate overall progress based on files transferred
        const fileProgress = totalFiles > 0 ? Math.round((currentFiles / totalFiles) * 100) : 0;
        job.progressData.percentage = Math.max(0, Math.min(100, fileProgress)); // Clamp between 0-100
        job.progress = job.progressData.percentage;
        
        console.log(`Job ${job.id}: Progress calculation: ${currentFiles}/${totalFiles} files (${remainingFiles} remaining) = ${fileProgress}% overall progress`);
        console.log(`Job ${job.id}: Raw match: xfr#${xfrNum}, to-chk=${remainingFiles}/${totalFiles}`);
        
        // Notify UI of progress update
        this.notifyJobUpdate(job);
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

  notifyJobError(jobId, error, analysis = null) {
    if (mainWindow) {
      mainWindow.webContents.send('job-error', { jobId, error, analysis });
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

// Smart naming and history IPC handlers
ipcMain.handle('generate-smart-name', async (event, sourcePath, targetPath, isMove) => {
  try {
    return await SmartJobNaming.generateJobName(sourcePath, targetPath, isMove);
  } catch (error) {
    return SmartJobNaming.generateFallbackName(sourcePath, isMove);
  }
});

ipcMain.handle('get-transfer-history', async (event, limit = 10) => {
  if (!jobManager) return [];
  return jobManager.transferHistory.getRecentTransfers(limit);
});

ipcMain.handle('get-similar-transfers', async (event, sourcePath, targetPath) => {
  if (!jobManager) return [];
  return jobManager.transferHistory.getSimilarTransfers(sourcePath, targetPath);
});

ipcMain.handle('predict-transfer-time', async (event, fileCount, totalSize) => {
  if (!jobManager) return null;
  return jobManager.transferHistory.predictTransferTime(fileCount, totalSize);
});

ipcMain.handle('analyze-error', async (event, errorMessage) => {
  return ErrorAnalyzer.analyzeError(errorMessage);
});

ipcMain.handle('get-optimization-recommendations', async (event, sourcePath, targetPath) => {
  try {
    const sourceInfo = await SmartJobNaming.analyzeFolder(sourcePath);
    const targetInfo = await SmartJobNaming.analyzeFolder(targetPath);
    const history = jobManager ? jobManager.transferHistory.getSimilarTransfers(sourcePath, targetPath) : [];
    
    const recommendations = TransferOptimizer.getOptimizationRecommendations(sourceInfo, targetInfo, history);
    const timeRecommendations = TransferOptimizer.getTimeBasedRecommendations();
    
    return [...recommendations, ...timeRecommendations];
  } catch (error) {
    console.error('Error getting optimization recommendations:', error);
    return [];
  }
});