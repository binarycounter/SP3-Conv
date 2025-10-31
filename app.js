// Get references to all DOM elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const midSamplerateSelect = document.getElementById('mid-samplerate-select');
const sideSamplerateSelect = document.getElementById('side-samplerate-select');
const fileInfo = document.getElementById('file-info');
const fileNameSpan = document.getElementById('file-name');
const audioDetails = document.getElementById('audio-details');
const statusArea = document.getElementById('status-area');
const resultsArea = document.getElementById('results-area');
const gaussToggle = document.getElementById('gauss-filter-toggle');
const playMidBtn = document.getElementById('play-mid-btn');
const playSideBtn = document.getElementById('play-side-btn');
const playFullBtn = document.getElementById('play-full-btn');
const downloadMidBrrBtn = document.getElementById('download-mid-brr-btn');
const downloadMidWavBtn = document.getElementById('download-mid-wav-btn');
const downloadSideBrrBtn = document.getElementById('download-side-brr-btn');
const downloadSideWavBtn = document.getElementById('download-side-wav-btn');
const downloadFullWavBtn = document.getElementById('download-full-wav-btn');
const encodingStats = document.getElementById('encoding-stats');
const encodedSizeSpan = document.getElementById('encoded-size');
const bitrateSpan = document.getElementById('bitrate');

// --- Web Audio API & State ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioContext;
let currentlyPlayingSource = null;
let playingChannel = null;
let currentFileObject = null;

// --- Data Storage ---
let decodedAudioBuffer = null;
let encodedBrr = { mid: null, side: null };
let decodedPcm = { mid: null, side: null };

// --- Initialization ---
function populateSampleRateSelectors() {
    for (let i = 2000; i <= 48000; i += 2000) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = `${i} Hz`;
        midSamplerateSelect.appendChild(option.cloneNode(true));
        sideSamplerateSelect.appendChild(option.cloneNode(true));
    }
    midSamplerateSelect.value = '32000';
    sideSamplerateSelect.value = '4000';
}
populateSampleRateSelectors();

// --- Event Listeners ---
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]); });
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length > 0) handleFile(fileInput.files[0]); });

playMidBtn.addEventListener('click', () => handlePlayback('mid'));
playSideBtn.addEventListener('click', () => handlePlayback('side'));
playFullBtn.addEventListener('click', () => handleFullPlayback());
downloadMidWavBtn.addEventListener('click', () => downloadDecodedWav('mid'));
downloadSideWavBtn.addEventListener('click', () => downloadDecodedWav('side'));
downloadFullWavBtn.addEventListener('click', () => downloadFullMixWav());
gaussToggle.addEventListener('change', stopPlayback);

function handleSettingChange() {
    if (currentFileObject) {
        handleFile(currentFileObject);
    }
}
midSamplerateSelect.addEventListener('change', handleSettingChange);
sideSamplerateSelect.addEventListener('change', handleSettingChange);

// --- Core Processing Chain ---
async function handleFile(file) {
    if (!file.type.startsWith('audio/')) return alert('Please drop a valid audio file.');
    
    currentFileObject = file;
    stopPlayback();
    resultsArea.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    encodingStats.classList.add('hidden'); // Hide stats on new file
    statusArea.classList.remove('hidden');
    fileNameSpan.textContent = file.name;
    audioDetails.innerHTML = '';
    decodedPcm = { mid: null, side: null };
    
    const targetMidSr = parseInt(midSamplerateSelect.value, 10);
    const targetSideSr = parseInt(sideSamplerateSelect.value, 10);

    statusArea.textContent = 'Reading file...';
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        statusArea.textContent = 'Decoding audio...';
        decodedAudioBuffer = await decodeAudio(arrayBuffer);
        if (!decodedAudioBuffer || decodedAudioBuffer.numberOfChannels !== 2) return;
        
        statusArea.textContent = 'Performing Mid/Side split...';
        let midSideSignals = convertToMidSide(decodedAudioBuffer);
        
        statusArea.textContent = 'Checking and normalizing volume...';
        const normalizedSignals = normalizeCoupled(midSideSignals.mid, midSideSignals.side);
        midSideSignals.mid = normalizedSignals.mid;
        midSideSignals.side = normalizedSignals.side;
        
        statusArea.textContent = 'Downsampling signals...';
        const [midDownsampled, sideDownsampled] = await Promise.all([
            downsampleSignal(midSideSignals.mid, decodedAudioBuffer.sampleRate, targetMidSr),
            downsampleSignal(midSideSignals.side, decodedAudioBuffer.sampleRate, targetSideSr)
        ]);
        
        statusArea.textContent = 'Encoding BRR data...';
        await new Promise(resolve => setTimeout(resolve, 50));
        
        encodedBrr.mid = encodeBRR(midDownsampled);
        encodedBrr.side = encodeBRR(sideDownsampled);
        
        statusArea.textContent = 'Processing complete!';
        setupResultControls();
        displayEncodingStats(); // Display the final stats
    } catch (error) {
        statusArea.textContent = `Error: ${error.message}`;
        console.error(error);
    }
}

// --- Playback State Management ---
function stopPlayback() {
    if (currentlyPlayingSource) {
        currentlyPlayingSource.stop();
        currentlyPlayingSource.onended = null;
    }
    currentlyPlayingSource = null;
    playingChannel = null;
    resetPlayButtons();
}

function resetPlayButtons() {
    playMidBtn.textContent = '▶ Play';
    playSideBtn.textContent = '▶ Play';
    playFullBtn.textContent = '▶ Play';
    playMidBtn.classList.remove('playing');
    playSideBtn.classList.remove('playing');
    playFullBtn.classList.remove('playing');
}

async function handlePlayback(channel) {
    if (playingChannel === channel) { stopPlayback(); return; }
    stopPlayback();
    playingChannel = channel;
    const btn = (channel === 'mid') ? playMidBtn : playSideBtn;
    btn.textContent = '■ Stop';
    btn.classList.add('playing');

    if (!decodedPcm[channel]) decodedPcm[channel] = decodeBRR(encodedBrr[channel]);
    
    let pcmData = decodedPcm[channel];
    const sampleRate = (channel === 'mid') 
        ? parseInt(midSamplerateSelect.value, 10) 
        : parseInt(sideSamplerateSelect.value, 10);
    let playbackRate = sampleRate;
    
    if (playbackRate < 8000) {
        pcmData = await upsampleSignal(pcmData, playbackRate, decodedAudioBuffer.sampleRate);
        playbackRate = decodedAudioBuffer.sampleRate;
    }
    
    if (gaussToggle.checked) pcmData = applyGaussFilter(pcmData);
    
    const audioBuffer = audioContext.createBuffer(1, pcmData.length, playbackRate);
    audioBuffer.copyToChannel(pcmData, 0);
    
    currentlyPlayingSource = audioContext.createBufferSource();
    currentlyPlayingSource.buffer = audioBuffer;
    currentlyPlayingSource.connect(audioContext.destination);
    currentlyPlayingSource.onended = () => { if (playingChannel === channel) stopPlayback(); };
    currentlyPlayingSource.start(0);
}

async function handleFullPlayback() {
    if (playingChannel === 'full') { stopPlayback(); return; }
    stopPlayback();
    playingChannel = 'full';
    playFullBtn.textContent = '■ Stop';
    playFullBtn.classList.add('playing');
    statusArea.textContent = 'Reconstructing stereo mix...';
    await new Promise(resolve => setTimeout(resolve, 10));

    const { left, right } = await reconstructStereo();
    const sampleRate = decodedAudioBuffer.sampleRate;
    const audioBuffer = audioContext.createBuffer(2, left.length, sampleRate);
    audioBuffer.copyToChannel(left, 0);
    audioBuffer.copyToChannel(right, 1);
    
    currentlyPlayingSource = audioContext.createBufferSource();
    currentlyPlayingSource.buffer = audioBuffer;
    currentlyPlayingSource.connect(audioContext.destination);
    currentlyPlayingSource.onended = () => { if (playingChannel === 'full') stopPlayback(); };
    currentlyPlayingSource.start(0);
    statusArea.textContent = 'Processing complete!';
}

// --- UI, Download, and Stat Logic ---
function setupResultControls() {
    const originalFileName = fileNameSpan.textContent.split('.').slice(0, -1).join('.') || 'audio';
    const midBrrBlob = new Blob([concatenateBlobs(encodedBrr.mid)], { type: 'application/octet-stream' });
    downloadMidBrrBtn.href = URL.createObjectURL(midBrrBlob);
    downloadMidBrrBtn.download = `${originalFileName}_mid.brr`;
    
    const sideBrrBlob = new Blob([concatenateBlobs(encodedBrr.side)], { type: 'application/octet-stream' });
    downloadSideBrrBtn.href = URL.createObjectURL(sideBrrBlob);
    downloadSideBrrBtn.download = `${originalFileName}_side.brr`;

    resultsArea.classList.remove('hidden');
}

function displayEncodingStats() {
    const totalEncodedSizeInBytes = (encodedBrr.mid.length + encodedBrr.side.length) * 9;
    const bitrateInBytesPerSecond = totalEncodedSizeInBytes / decodedAudioBuffer.duration;

    encodedSizeSpan.textContent = (totalEncodedSizeInBytes / 1024).toFixed(2);
    bitrateSpan.textContent = (bitrateInBytesPerSecond / 1024).toFixed(2);

    encodingStats.classList.remove('hidden');
}

async function downloadFullMixWav() {
    statusArea.textContent = 'Generating stereo WAV file...';
    const { left, right } = await reconstructStereo();
    const sampleRate = decodedAudioBuffer.sampleRate;
    const wavBlob = encodeStereoWAV(left, right, sampleRate);
    const url = URL.createObjectURL(wavBlob);
    
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `${fileNameSpan.textContent.split('.')[0]}_full_mix.wav`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    statusArea.textContent = 'Processing complete!';
}

async function reconstructStereo() {
    if (!decodedPcm.mid) decodedPcm.mid = decodeBRR(encodedBrr.mid);
    if (!decodedPcm.side) decodedPcm.side = decodeBRR(encodedBrr.side);

    const targetMidSr = parseInt(midSamplerateSelect.value, 10);
    const targetSideSr = parseInt(sideSamplerateSelect.value, 10);
    const targetSr = decodedAudioBuffer.sampleRate;

    const [upsampledMid, upsampledSide] = await Promise.all([
        upsampleSignal(decodedPcm.mid, targetMidSr, targetSr),
        upsampleSignal(decodedPcm.side, targetSideSr, targetSr)
    ]);

    let finalMid = gaussToggle.checked ? applyGaussFilter(upsampledMid) : upsampledMid;
    let finalSide = gaussToggle.checked ? applyGaussFilter(upsampledSide) : upsampledSide;
    
    const len = Math.max(finalMid.length, finalSide.length);
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        const m = finalMid[i] || 0;
        const s = finalSide[i] || 0;
        left[i] = m + s;
        right[i] = m - s;
    }
    return { left, right };
}

function downloadDecodedWav(channel) {
    const sampleRate = (channel === 'mid') 
        ? parseInt(midSamplerateSelect.value, 10) 
        : parseInt(sideSamplerateSelect.value, 10);

    if (!decodedPcm[channel]) {
        decodedPcm[channel] = decodeBRR(encodedBrr[channel]);
    }
    const wavBlob = encodeWAV(decodedPcm[channel], sampleRate);
    const url = URL.createObjectURL(wavBlob);
    
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `${fileNameSpan.textContent.split('.')[0]}_${channel}_decoded.wav`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
}

function concatenateBlobs(blocksArray) {
    const totalLength = blocksArray.length * 9;
    const result = new Uint8Array(totalLength);
    for (let i = 0; i < blocksArray.length; i++) {
        result.set(blocksArray[i], i * 9);
    }
    return result;
}

async function decodeAudio(arrayBuffer) {
    if (!audioContext) audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    audioDetails.innerHTML = `Sample Rate: ${audioBuffer.sampleRate} Hz<br>Channels: ${audioBuffer.numberOfChannels}<br>Duration: ${audioBuffer.duration.toFixed(2)} seconds`;
    if (audioBuffer.numberOfChannels !== 2) {
        statusArea.textContent = 'Warning: The provided file is not stereo. Processing will stop.';
        return null;
    }
    return audioBuffer;
}