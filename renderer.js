const { ipcRenderer } = require('electron');

let isRunning = false;

// DOM elements
const sourceFolderInput = document.getElementById('source-folder');
const targetFolderInput = document.getElementById('target-folder');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const progressLog = document.getElementById('progress-log');

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