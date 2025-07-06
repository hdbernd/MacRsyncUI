const { ipcRenderer } = require('electron');

let isRunning = false;
let jobs = [];

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
    const jobName = jobNameInput.value.trim();
    
    const config = {
        source,
        target,
        isMove,
        name: jobName || `${isMove ? 'Move' : 'Copy'} ${source.split('/').pop() || 'Job'}`
    };
    
    try {
        const jobId = await ipcRenderer.invoke('create-job', config);
        if (jobId) {
            logMessage(`Job created: ${config.name}`);
            jobNameInput.value = '';
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error creating job: ${error.message}`);
    }
}

async function startJob(jobId) {
    try {
        const success = await ipcRenderer.invoke('start-job', jobId);
        if (success) {
            logMessage(`Job started: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error starting job: ${error.message}`);
    }
}

async function pauseJob(jobId) {
    try {
        const success = await ipcRenderer.invoke('pause-job', jobId);
        if (success) {
            logMessage(`Job paused: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error pausing job: ${error.message}`);
    }
}

async function resumeJob(jobId) {
    try {
        const success = await ipcRenderer.invoke('resume-job', jobId);
        if (success) {
            logMessage(`Job resumed: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error resuming job: ${error.message}`);
    }
}

async function stopJob(jobId) {
    try {
        const success = await ipcRenderer.invoke('stop-job', jobId);
        if (success) {
            logMessage(`Job stopped: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error stopping job: ${error.message}`);
    }
}

async function restartJob(jobId) {
    try {
        const success = await ipcRenderer.invoke('restart-job', jobId);
        if (success) {
            logMessage(`Job restarted: ${jobId}`);
            await refreshJobs();
        }
    } catch (error) {
        logMessage(`Error restarting job: ${error.message}`);
    }
}

async function removeJob(jobId) {
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
}

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
                controls.push(`<button class="btn btn-secondary" onclick="pauseJob('${job.id}')">Pause</button>`);
                controls.push(`<button class="btn btn-danger" onclick="stopJob('${job.id}')">Stop</button>`);
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
    
    return `
        <div class="job-item" data-job-id="${job.id}">
            <div class="job-info">
                <div class="job-name">${job.name}</div>
                <div class="job-paths">${sourceName} → ${targetName}</div>
                <div class="job-time">
                    ${job.startTime ? `Started: ${formatTime(job.startTime)}` : ''}
                    ${job.endTime ? ` | Ended: ${formatTime(job.endTime)}` : ''}
                </div>
                ${job.status === 'running' ? '<div class="job-progress">Preparing...</div>' : ''}
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

ipcRenderer.on('job-error', (event, { jobId, error }) => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
        logMessage(`[${job.name}] Error: ${error.trim()}`);
    }
});

ipcRenderer.on('job-removed', (event, jobId) => {
    jobs = jobs.filter(j => j.id !== jobId);
    renderJobs();
});