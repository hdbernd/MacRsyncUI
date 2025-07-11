const { ipcRenderer } = require('electron');

let isRunning = false;
let jobs = [];

// Declare functions first so they can be attached to window immediately
async function pauseJob(jobId) {
    console.log(`Frontend: Attempting to pause job ${jobId}`);
    logMessage(`Attempting to pause job: ${jobId}`);
    
    try {
        const success = await ipcRenderer.invoke('pause-job', jobId);
        console.log(`Frontend: Pause result for job ${jobId}:`, success);
        if (success) {
            logMessage(`Job paused successfully: ${jobId}`);
        } else {
            logMessage(`Failed to pause job: ${jobId}`);
        }
    } catch (error) {
        console.error(`Frontend: Error pausing job ${jobId}:`, error);
        logMessage(`Error pausing job: ${error.message}`);
    }
}

async function stopJob(jobId) {
    console.log(`Frontend: Attempting to stop job ${jobId}`);
    logMessage(`Attempting to stop job: ${jobId}`);
    
    try {
        const success = await ipcRenderer.invoke('stop-job', jobId);
        console.log(`Frontend: Stop result for job ${jobId}:`, success);
        if (success) {
            logMessage(`Job stopped successfully: ${jobId}`);
        } else {
            logMessage(`Failed to stop job: ${jobId}`);
        }
    } catch (error) {
        console.error(`Frontend: Error stopping job ${jobId}:`, error);
        logMessage(`Error stopping job: ${error.message}`);
    }
}

// Forward declarations for functions that will be defined later
let startJob, resumeJob, restartJob, removeJob;

// Attach to window immediately
window.pauseJob = pauseJob;
window.stopJob = stopJob;

// DOM elements
const sourceFolderInput = document.getElementById('source-folder');
const targetFolderInput = document.getElementById('target-folder');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const progressLog = document.getElementById('progress-log');
const jobNameInput = document.getElementById('job-name');
const jobsList = document.getElementById('jobs-list');

// Load saved configuration on startup
document.addEventListener('DOMContentLoaded', async () => {
    const config = await ipcRenderer.invoke('load-config');
    if (config) {
        sourceFolderInput.value = config.source || '';
        targetFolderInput.value = config.target || '';
        
        const operationRadios = document.querySelectorAll('input[name="operation"]');
        operationRadios.forEach(radio => {
            if (radio.value === (config.isMove ? 'move' : 'copy')) {
                radio.checked = true;
            }
        });
    }
    
    // Setup drag and drop
    setupDragAndDrop();
    
    // Load existing jobs
    await refreshJobs();
    
    // Refresh jobs every 2 seconds to ensure status updates are visible
    setInterval(async () => {
        await refreshJobs();
    }, 2000);
    
    // Make job management functions globally available for onclick handlers
    window.startJob = startJob;
    window.pauseJob = pauseJob;
    window.resumeJob = resumeJob;
    window.stopJob = stopJob;
    window.restartJob = restartJob;
    window.removeJob = removeJob;
    
    // Debug: Log that functions are attached
    console.log('Job management functions attached to window:', {
        startJob: typeof window.startJob,
        pauseJob: typeof window.pauseJob,
        resumeJob: typeof window.resumeJob,
        stopJob: typeof window.stopJob,
        restartJob: typeof window.restartJob,
        removeJob: typeof window.removeJob
    });
    
    // Add event delegation for job control buttons
    const jobsList = document.getElementById('jobs-list');
    jobsList.addEventListener('click', function(event) {
        const target = event.target;
        const jobId = target.getAttribute('data-job-id');
        
        if (!jobId) return;
        
        console.log(`Button clicked: ${target.className}, jobId: ${jobId}`);
        
        if (target.classList.contains('job-pause-btn')) {
            console.log(`Pause button clicked for job ${jobId}`);
            pauseJob(jobId);
        } else if (target.classList.contains('job-stop-btn')) {
            console.log(`Stop button clicked for job ${jobId}`);
            stopJob(jobId);
        }
    });
});

// Folder selection
async function selectFolder(isSource) {
    try {
        console.log('Attempting to select folder, isSource:', isSource);
        const folderPath = await ipcRenderer.invoke('select-folder', isSource);
        console.log('Selected folder path:', folderPath);
        
        if (folderPath) {
            if (isSource) {
                sourceFolderInput.value = folderPath;
                logMessage(`Source folder selected: ${folderPath}`);
            } else {
                targetFolderInput.value = folderPath;
                logMessage(`Target folder selected: ${folderPath}`);
            }
        } else {
            console.log('No folder selected or dialog was cancelled');
        }
    } catch (error) {
        console.error('Error selecting folder:', error);
        logMessage(`Error selecting folder: ${error.message}`);
    }
}

// Start sync operation
async function startSync() {
    const source = sourceFolderInput.value;
    const target = targetFolderInput.value;
    
    if (!source || !target) {
        alert('Please select both source and target folders');
        return;
    }
    
    const isMove = document.querySelector('input[name="operation"]:checked').value === 'move';
    
    isRunning = true;
    updateUI();
    
    const config = {
        source,
        target,
        isMove
    };
    
    logMessage(`Starting ${isMove ? 'move' : 'copy'} operation...`);
    logMessage(`Source: ${source}`);
    logMessage(`Target: ${target}`);
    logMessage('---');
    
    try {
        await ipcRenderer.invoke('start-rsync', config);
    } catch (error) {
        logMessage(`Error: ${error.message}`);
        setStatus('error', 'Error occurred');
        isRunning = false;
        updateUI();
    }
}

// Stop sync operation
async function stopSync() {
    const stopped = await ipcRenderer.invoke('stop-rsync');
    if (stopped) {
        logMessage('Sync operation stopped by user');
        setStatus('idle', 'Stopped');
        isRunning = false;
        updateUI();
    }
}

// Save configuration
async function saveConfig() {
    const config = {
        source: sourceFolderInput.value,
        target: targetFolderInput.value,
        isMove: document.querySelector('input[name="operation"]:checked').value === 'move'
    };
    
    const saved = await ipcRenderer.invoke('save-config', config);
    if (saved) {
        logMessage('Configuration saved successfully');
    } else {
        logMessage('Failed to save configuration');
    }
}

// Update UI based on running state
function updateUI() {
    if (isRunning) {
        startBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        setStatus('active', 'Running');
    } else {
        startBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        if (statusText.textContent === 'Running') {
            setStatus('idle', 'Ready');
        }
    }
}

// Set status indicator and text
function setStatus(type, text) {
    statusIndicator.className = `status-indicator ${type}`;
    statusText.textContent = text;
}

// Log message to progress log
function logMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    progressLog.textContent += `[${timestamp}] ${message}\n`;
    progressLog.scrollTop = progressLog.scrollHeight;
}

// IPC event listeners
ipcRenderer.on('rsync-progress', (event, data) => {
    progressLog.textContent += data;
    progressLog.scrollTop = progressLog.scrollHeight;
});

ipcRenderer.on('rsync-error', (event, error) => {
    logMessage(`Error: ${error}`);
    setStatus('error', 'Error occurred');
});

ipcRenderer.on('rsync-complete', (event, code) => {
    isRunning = false;
    updateUI();
    
    if (code === 0) {
        logMessage('Sync completed successfully!');
        setStatus('idle', 'Completed');
    } else {
        logMessage(`Sync finished with code: ${code}`);
        setStatus('error', `Finished with errors (code: ${code})`);
    }
    
    logMessage('---');
});

ipcRenderer.on('dialog-error', (event, error) => {
    logMessage(`Dialog error: ${error}`);
    const manualInput = prompt('Dialog failed. Please enter the folder path manually:');
    if (manualInput) {
        // Determine which input field to update based on last clicked button
        // For now, we'll just log it - you can click the input field and type manually
        logMessage(`Manual path entered: ${manualInput}`);
    }
});

// Setup drag and drop functionality
function setupDragAndDrop() {
    const dropZones = document.querySelectorAll('.drop-zone');
    
    dropZones.forEach(dropZone => {
        // Prevent default drag behaviors
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });
        
        // Highlight drop zone when item is dragged over it
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, highlight, false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, unhighlight, false);
        });
        
        // Handle dropped files
        dropZone.addEventListener('drop', handleDrop, false);
    });
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function highlight(e) {
    e.currentTarget.classList.add('drag-over');
}

function unhighlight(e) {
    e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    
    if (files.length > 0) {
        const file = files[0];
        const folderPath = file.path;
        const target = e.currentTarget.dataset.target;
        
        // Update the appropriate input field
        if (target === 'source') {
            sourceFolderInput.value = folderPath;
            logMessage(`Source folder set via drag & drop: ${folderPath}`);
            updateDropZoneStatus(e.currentTarget, folderPath);
        } else if (target === 'target') {
            targetFolderInput.value = folderPath;
            logMessage(`Target folder set via drag & drop: ${folderPath}`);
            updateDropZoneStatus(e.currentTarget, folderPath);
        }
    }
}

function updateDropZoneStatus(dropZone, folderPath) {
    dropZone.classList.add('has-file');
    const dropText = dropZone.querySelector('.drop-text');
    const folderName = folderPath.split('/').pop() || folderPath;
    dropText.textContent = `✓ ${folderName}`;
}

// Job Management Functions
async function createJob() {
    const source = sourceFolderInput.value;
    const target = targetFolderInput.value;
    
    if (!source || !target) {
        alert('Please select both source and target folders');
        return;
    }
    
    const isMove = document.querySelector('input[name="operation"]:checked').value === 'move';
    let jobName = jobNameInput.value.trim();
    
    // If no name provided, generate smart name
    if (!jobName) {
        try {
            setStatus('active', 'Analyzing folders...');
            jobName = await ipcRenderer.invoke('generate-smart-name', source, target, isMove);
            logMessage(`🧠 Smart name generated: ${jobName}`);
        } catch (error) {
            console.error('Error generating smart name:', error);
            jobName = `${isMove ? 'Move' : 'Copy'} ${source.split('/').pop() || 'Job'}`;
        }
        setStatus('idle', 'Ready');
    }
    
    const config = {
        source,
        target,
        isMove,
        name: jobName
    };
    
    try {
        const jobId = await ipcRenderer.invoke('create-job', config);
        if (jobId) {
            logMessage(`✅ Job created: ${config.name}`);
            jobNameInput.value = '';
            await refreshJobs();
            
            // Show similar transfers if any
            showSimilarTransfers(source, target);
            
            // Auto-show recommendations for new jobs
            setTimeout(() => autoShowRecommendations(source, target), 500);
        }
    } catch (error) {
        logMessage(`Error creating job: ${error.message}`);
    }
}

startJob = async function(jobId) {
    try {
        const success = await ipcRenderer.invoke('start-job', jobId);
        if (success) {
            logMessage(`Job started: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error starting job: ${error.message}`);
    }
};
window.startJob = startJob;

resumeJob = async function(jobId) {
    try {
        const success = await ipcRenderer.invoke('resume-job', jobId);
        if (success) {
            logMessage(`Job resumed: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error resuming job: ${error.message}`);
    }
};
window.resumeJob = resumeJob;

restartJob = async function(jobId) {
    try {
        const success = await ipcRenderer.invoke('restart-job', jobId);
        if (success) {
            logMessage(`Job restarted: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error restarting job: ${error.message}`);
    }
};
window.restartJob = restartJob;

removeJob = async function(jobId) {
    if (confirm('Are you sure you want to remove this job?')) {
        try {
            const success = await ipcRenderer.invoke('remove-job', jobId);
            if (success) {
                logMessage(`Job removed: ${jobId}`);
                await refreshJobs();
            }
        } catch (error) {
            logMessage(`Error removing job: ${error.message}`);
        }
    }
};
window.removeJob = removeJob;

async function refreshJobs() {
    try {
        jobs = await ipcRenderer.invoke('get-all-jobs');
        renderJobs();
    } catch (error) {
        logMessage(`Error refreshing jobs: ${error.message}`);
    }
}

async function clearCompletedJobs() {
    const completedJobs = jobs.filter(job => job.status === 'completed');
    if (completedJobs.length === 0) {
        alert('No completed jobs to clear');
        return;
    }
    
    if (confirm(`Remove ${completedJobs.length} completed job(s)?`)) {
        for (const job of completedJobs) {
            await ipcRenderer.invoke('remove-job', job.id);
        }
        await refreshJobs();
    }
}

function renderJobs() {
    if (jobs.length === 0) {
        jobsList.innerHTML = '<div class="no-jobs">No jobs in queue</div>';
        return;
    }
    
    // Store current progress text to preserve it
    const currentProgress = {};
    document.querySelectorAll('.job-progress').forEach(el => {
        const jobId = el.closest('.job-item').dataset.jobId;
        if (jobId) {
            currentProgress[jobId] = el.textContent;
        }
    });
    
    const jobsHTML = jobs.map(job => createJobHTML(job)).join('');
    jobsList.innerHTML = jobsHTML;
    
    // Restore progress text
    Object.keys(currentProgress).forEach(jobId => {
        const jobElement = document.querySelector(`[data-job-id="${jobId}"]`);
        if (jobElement) {
            const progressElement = jobElement.querySelector('.job-progress');
            if (progressElement && currentProgress[jobId] !== 'Preparing...') {
                progressElement.textContent = currentProgress[jobId];
            }
        }
    });
    
    // Draw speed graphs for running jobs
    jobs.filter(job => job.status === 'running' && job.progressData && job.progressData.speedHistory.length > 1)
        .forEach(job => drawSpeedGraph(job));
    
    // Update elapsed time for running jobs
    updateElapsedTimes();
}

function drawSpeedGraph(job) {
    const canvas = document.querySelector(`canvas[data-job-id="${job.id}"]`);
    if (!canvas || !job.progressData.speedHistory.length) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width = 100;
    const height = canvas.height = 30;
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    const speedHistory = job.progressData.speedHistory;
    if (speedHistory.length < 2) return;
    
    // Find min/max speeds for scaling
    const speeds = speedHistory.map(entry => entry.speed);
    const minSpeed = Math.min(...speeds);
    const maxSpeed = Math.max(...speeds);
    const speedRange = maxSpeed - minSpeed || 1;
    
    // Draw grid
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    
    // Draw speed line
    ctx.strokeStyle = '#28a745';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    speedHistory.forEach((entry, index) => {
        const x = (width / (speedHistory.length - 1)) * index;
        const y = height - ((entry.speed - minSpeed) / speedRange) * height;
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.stroke();
    
    // Draw current speed point
    const lastEntry = speedHistory[speedHistory.length - 1];
    const lastX = width - 2;
    const lastY = height - ((lastEntry.speed - minSpeed) / speedRange) * height;
    
    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, 2 * Math.PI);
    ctx.fill();
}

function updateElapsedTimes() {
    jobs.filter(job => job.status === 'running' && job.startTime)
        .forEach(job => {
            const elapsedElement = document.querySelector(`[data-job-id="${job.id}"] .elapsed`);
            if (elapsedElement) {
                const elapsedTime = formatElapsedTime(new Date(job.startTime));
                elapsedElement.textContent = `⏱️ ${elapsedTime}`;
            }
        });
}

function formatElapsedTime(startTime) {
    const now = new Date();
    const elapsed = Math.floor((now - startTime) / 1000); // seconds
    
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

function createJobHTML(job) {
    const formatTime = (timestamp) => {
        if (!timestamp) return '';
        return new Date(timestamp).toLocaleTimeString();
    };
    
    const getJobControls = (job) => {
        const controls = [];
        
        switch (job.status) {
            case 'pending':
                controls.push(`<button class="btn btn-primary" onclick="startJob('${job.id}')">Start</button>`);
                controls.push(`<button class="btn btn-danger" onclick="removeJob('${job.id}')">Remove</button>`);
                break;
            case 'running':
                console.log(`Creating pause/stop buttons for job ${job.id}`);
                controls.push(`<button class="btn btn-secondary job-pause-btn" data-job-id="${job.id}">Pause</button>`);
                controls.push(`<button class="btn btn-danger job-stop-btn" data-job-id="${job.id}">Stop</button>`);
                break;
            case 'paused':
                controls.push(`<button class="btn btn-primary" onclick="resumeJob('${job.id}')">Resume</button>`);
                controls.push(`<button class="btn btn-danger" onclick="stopJob('${job.id}')">Stop</button>`);
                break;
            case 'completed':
            case 'failed':
            case 'stopped':
                controls.push(`<button class="btn btn-secondary" onclick="restartJob('${job.id}')">Restart</button>`);
                controls.push(`<button class="btn btn-danger" onclick="removeJob('${job.id}')">Remove</button>`);
                break;
            case 'queued':
                controls.push(`<button class="btn btn-danger" onclick="stopJob('${job.id}')">Cancel</button>`);
                break;
        }
        
        return controls.join('');
    };
    
    const sourceName = job.source.split('/').pop() || job.source;
    const targetName = job.target.split('/').pop() || job.target;
    
    const createProgressSection = (job) => {
        if (!['running', 'paused'].includes(job.status) || !job.progressData) return '';
        
        const progress = job.progressData;
        const elapsedTime = job.startTime ? formatElapsedTime(new Date(job.startTime)) : '';
        const fileProgress = progress.fileCount.total > 0 ? 
            `${progress.fileCount.current}/${progress.fileCount.total} files` : '';
        
        return `
            <div class="job-progress-container">
                <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: ${progress.percentage}%"></div>
                    <div class="progress-bar-text">${progress.percentage}% (Overall Progress)</div>
                </div>
                <div class="job-stats">
                    <div class="job-stats-left">
                        <span class="speed-current">🚀 ${progress.currentSpeed}</span>
                        <span class="speed-average">📊 ${progress.averageSpeed}</span>
                        ${progress.highestSpeed && progress.highestSpeed !== '0B/s' ? `<span class="speed-highest">📈 Max: ${progress.highestSpeed}</span>` : ''}
                        ${progress.lowestSpeed && progress.lowestSpeed !== '0B/s' ? `<span class="speed-lowest">📉 Min: ${progress.lowestSpeed}</span>` : ''}
                        <span class="transferred">📦 ${progress.transferred}${progress.total && progress.total !== '0B' ? `/${progress.total}` : ''}</span>
                        ${fileProgress ? `<span class="file-count">📁 ${fileProgress}</span>` : ''}
                    </div>
                    <div class="job-stats-right">
                        ${elapsedTime ? `<span class="elapsed">⏱️ ${elapsedTime}</span>` : ''}
                        ${progress.eta ? `<span class="eta">🎯 ETA: ${progress.eta}</span>` : ''}
                        <canvas class="job-speed-graph" data-job-id="${job.id}"></canvas>
                    </div>
                </div>
                ${progress.currentFile ? `<div class="current-file">📄 ${progress.currentFile}</div>` : ''}
            </div>
        `;
    };

    return `
        <div class="job-item" data-job-id="${job.id}">
            <div class="job-info">
                <div class="job-name">${job.name}</div>
                <div class="job-paths">${sourceName} → ${targetName}</div>
                ${job.rsyncCommand ? `<div class="job-rsync-command">💻 ${job.rsyncCommand}</div>` : ''}
                <div class="job-time">
                    ${job.startTime ? `Started: ${formatTime(job.startTime)}` : ''}
                    ${job.endTime ? ` | Ended: ${formatTime(job.endTime)}` : ''}
                </div>
                ${createProgressSection(job)}
            </div>
            <div class="job-status">
                <span class="job-status-badge ${job.status}">${job.status}</span>
            </div>
            <div class="job-controls">
                ${getJobControls(job)}
            </div>
        </div>
    `;
}

// New IPC event listeners for job management
ipcRenderer.on('job-update', (event, job) => {
    console.log('Job update received:', job);
    const jobIndex = jobs.findIndex(j => j.id === job.id);
    if (jobIndex >= 0) {
        jobs[jobIndex] = job;
    } else {
        jobs.push(job);
    }
    renderJobs();
    
    // Update speed graph if job is running
    if (job.status === 'running' && job.progressData && job.progressData.speedHistory.length > 1) {
        setTimeout(() => drawSpeedGraph(job), 100);
    }
});

ipcRenderer.on('job-progress', (event, { jobId, output }) => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
        logMessage(`[${job.name}] ${output.trim()}`);
        
        // Update job progress display
        const jobElement = document.querySelector(`[data-job-id="${jobId}"]`);
        if (jobElement) {
            const progressElement = jobElement.querySelector('.job-progress');
            if (progressElement) {
                // Extract progress info from rsync output
                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                if (lastLine.includes('%')) {
                    progressElement.textContent = lastLine.trim();
                }
            }
        }
    }
});

ipcRenderer.on('job-error', (event, { jobId, error, analysis }) => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
        logMessage(`[${job.name}] Error: ${error.trim()}`);
        
        // Show error analysis if available
        if (analysis) {
            logMessage(`💡 ${analysis.title}`);
            logMessage(`   ${analysis.explanation}`);
            logMessage(`   Suggestions:`);
            analysis.solutions.forEach((solution, index) => {
                logMessage(`   ${index + 1}. ${solution}`);
            });
        }
    }
});

ipcRenderer.on('job-removed', (event, jobId) => {
    jobs = jobs.filter(j => j.id !== jobId);
    renderJobs();
});

// Copy log to clipboard function
async function copyLogToClipboard() {
    try {
        const logContent = progressLog.textContent;
        await navigator.clipboard.writeText(logContent);
        logMessage('📋 Log copied to clipboard!');
    } catch (error) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = progressLog.textContent;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        logMessage('📋 Log copied to clipboard!');
    }
}

// Smart features functions
async function showSimilarTransfers(sourcePath, targetPath) {
    try {
        const similar = await ipcRenderer.invoke('get-similar-transfers', sourcePath, targetPath);
        if (similar.length > 0) {
            logMessage(`🔍 Found ${similar.length} similar transfer(s) in history`);
            similar.slice(0, 3).forEach(transfer => {
                const duration = transfer.duration ? formatDuration(transfer.duration) : 'Unknown';
                logMessage(`   • ${transfer.name} - ${duration} (${transfer.averageSpeed})`);
            });
        }
    } catch (error) {
        console.error('Error getting similar transfers:', error);
    }
}

async function generateSmartName() {
    const source = sourceFolderInput.value;
    const target = targetFolderInput.value;
    
    if (!source || !target) {
        alert('Please select both source and target folders first');
        return;
    }
    
    const isMove = document.querySelector('input[name="operation"]:checked').value === 'move';
    
    try {
        setStatus('active', 'Generating smart name...');
        const smartName = await ipcRenderer.invoke('generate-smart-name', source, target, isMove);
        jobNameInput.value = smartName;
        logMessage(`🧠 Smart name generated: ${smartName}`);
        setStatus('idle', 'Ready');
    } catch (error) {
        logMessage(`Error generating smart name: ${error.message}`);
        setStatus('idle', 'Ready');
    }
}

async function showTransferHistory() {
    try {
        const history = await ipcRenderer.invoke('get-transfer-history', 10);
        if (history.length === 0) {
            logMessage('📚 No transfer history found');
            return;
        }
        
        logMessage(`📚 Recent transfer history (${history.length} entries):`);
        history.forEach((transfer, index) => {
            const duration = transfer.duration ? formatDuration(transfer.duration) : 'Unknown';
            const status = transfer.status === 'completed' ? '✅' : '❌';
            logMessage(`   ${index + 1}. ${status} ${transfer.name} - ${duration}`);
        });
    } catch (error) {
        logMessage(`Error loading transfer history: ${error.message}`);
    }
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// Optimization recommendations functions
async function showOptimizationRecommendations() {
    const source = sourceFolderInput.value;
    const target = targetFolderInput.value;
    
    if (!source || !target) {
        alert('Please select both source and target folders first');
        return;
    }
    
    try {
        setStatus('active', 'Getting optimization recommendations...');
        const recommendations = await ipcRenderer.invoke('get-optimization-recommendations', source, target);
        
        if (recommendations.length === 0) {
            logMessage('💡 No specific optimization recommendations found for this transfer');
            setStatus('idle', 'Ready');
            return;
        }
        
        displayRecommendations(recommendations);
        logMessage(`💡 Found ${recommendations.length} optimization recommendation(s)`);
        setStatus('idle', 'Ready');
    } catch (error) {
        logMessage(`Error getting optimization recommendations: ${error.message}`);
        setStatus('idle', 'Ready');
    }
}

function displayRecommendations(recommendations) {
    const recommendationsSection = document.getElementById('recommendations-section');
    const recommendationsContent = document.getElementById('recommendations-content');
    
    // Clear previous recommendations
    recommendationsContent.innerHTML = '';
    
    // Create recommendation items
    recommendations.forEach(rec => {
        const item = document.createElement('div');
        item.className = `recommendation-item ${rec.type}`;
        
        item.innerHTML = `
            <div class="recommendation-title">${rec.title}</div>
            <div class="recommendation-suggestion">${rec.suggestion}</div>
            <div class="recommendation-details">${rec.details}</div>
        `;
        
        recommendationsContent.appendChild(item);
    });
    
    // Show the recommendations section
    recommendationsSection.style.display = 'block';
    
    // Scroll to recommendations section
    recommendationsSection.scrollIntoView({ behavior: 'smooth' });
}

function hideRecommendations() {
    const recommendationsSection = document.getElementById('recommendations-section');
    recommendationsSection.style.display = 'none';
}

// Auto-show recommendations when creating a job
async function autoShowRecommendations(source, target) {
    try {
        const recommendations = await ipcRenderer.invoke('get-optimization-recommendations', source, target);
        if (recommendations.length > 0) {
            displayRecommendations(recommendations);
        }
    } catch (error) {
        console.error('Error auto-showing recommendations:', error);
    }
}

// Custom File Browser Functions
let currentBrowserPath = '/';
let isBrowserForSource = true;

async function showCustomBrowser(isSource) {
    isBrowserForSource = isSource;
    const modal = document.getElementById('file-browser-modal');
    const title = document.getElementById('browser-title');
    
    title.textContent = isSource ? 'Select Source Folder' : 'Select Target Folder';
    currentBrowserPath = isSource ? '/Volumes' : process.env.HOME || '/';
    
    modal.style.display = 'block';
    await loadDirectoryContents(currentBrowserPath);
}

function closeCustomBrowser() {
    const modal = document.getElementById('file-browser-modal');
    modal.style.display = 'none';
}

async function loadDirectoryContents(path) {
    const browserList = document.getElementById('browser-list');
    const currentPathInput = document.getElementById('current-path');
    
    try {
        browserList.innerHTML = '<div class="loading">Loading...</div>';
        currentPathInput.value = path;
        
        const result = await ipcRenderer.invoke('browse-directories', path);
        currentBrowserPath = result.currentPath;
        
        browserList.innerHTML = '';
        
        // Add directories
        result.directories.forEach(dir => {
            const item = document.createElement('div');
            item.className = 'folder-item';
            item.innerHTML = `
                <span class="folder-icon">📁</span>
                <span>${dir.name}</span>
            `;
            item.onclick = () => loadDirectoryContents(dir.path);
            browserList.appendChild(item);
        });
        
        if (result.directories.length === 0) {
            browserList.innerHTML = '<div class="loading">No folders found</div>';
        }
        
    } catch (error) {
        console.error('Error loading directory contents:', error);
        browserList.innerHTML = '<div class="loading">Error loading directory</div>';
    }
}

async function goToParent() {
    const pathModule = require('path');
    const parent = pathModule.dirname(currentBrowserPath);
    if (parent !== currentBrowserPath) {
        await loadDirectoryContents(parent);
    }
}

function selectCurrentPath() {
    const targetInput = isBrowserForSource ? sourceFolderInput : targetFolderInput;
    targetInput.value = currentBrowserPath;
    closeCustomBrowser();
}