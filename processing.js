/**
 * Splits a stereo AudioBuffer into its Mid and Side components.
 * (This function remains unchanged)
 */
function convertToMidSide(stereoBuffer) {
    if (stereoBuffer.numberOfChannels !== 2) {
        console.error("Input is not stereo. Cannot perform Mid/Side split.");
        return null;
    }
    const leftChannel = stereoBuffer.getChannelData(0);
    const rightChannel = stereoBuffer.getChannelData(1);
    const sampleCount = stereoBuffer.length;
    const midSignal = new Float32Array(sampleCount);
    const sideSignal = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        const leftSample = leftChannel[i];
        const rightSample = rightChannel[i];
        midSignal[i] = (leftSample + rightSample) / 2;
        sideSignal[i] = (leftSample - rightSample) / 2;
    }
    console.log("Successfully converted to Mid/Side signals.");
    return { mid: midSignal, side: sideSignal };
}

/**
 * Normalizes Mid and Side signals together, applying the same gain reduction to both.
 * @param {Float32Array} midSignal The mid channel audio data.
 * @param {Float32Array} sideSignal The side channel audio data.
 * @returns {{mid: Float32Array, side: Float32Array}} The processed signals.
 */
function normalizeCoupled(midSignal, sideSignal) {
    let overallPeak = 0;
    
    // Find peak in mid signal
    for (let i = 0; i < midSignal.length; i++) {
        const absSample = Math.abs(midSignal[i]);
        if (absSample > overallPeak) {
            overallPeak = absSample;
        }
    }
    // Find peak in side signal (and update overall if it's higher)
    for (let i = 0; i < sideSignal.length; i++) {
        const absSample = Math.abs(sideSignal[i]);
        if (absSample > overallPeak) {
            overallPeak = absSample;
        }
    }

    if (overallPeak > 0.95) {
        console.log(`Overall peak is ${overallPeak.toFixed(3)}, which is > 0.95. Normalizing both channels.`);
        const multiplier = 0.95 / overallPeak;

        // Apply the same multiplier to both signals
        for (let i = 0; i < midSignal.length; i++) {
            midSignal[i] *= multiplier;
        }
        for (let i = 0; i < sideSignal.length; i++) {
            sideSignal[i] *= multiplier;
        }
    } else {
        console.log(`Overall peak is ${overallPeak.toFixed(3)}, which is <= 0.95. No normalization needed.`);
    }

    return { mid: midSignal, side: sideSignal };
}

/**
 * A router function that chooses the best downsampling method based on the target rate.
 * (This function remains unchanged)
 */
function downsampleSignal(signalData, originalSampleRate, targetSampleRate) {
    if (targetSampleRate < 8000) {
        console.log(`Using MANUAL downsampler for target rate: ${targetSampleRate} Hz`);
        return Promise.resolve(manualDownsample(signalData, originalSampleRate, targetSampleRate));
    } else {
        console.log(`Using NATIVE Web Audio downsampler for target rate: ${targetSampleRate} Hz`);
        return nativeDownsample(signalData, originalSampleRate, targetSampleRate);
    }
}

// --- REFINED DOWNSAMPLING ALGORITHM ---

const FIR_TAPS = 64; // The new, much larger filter window size.

/**
 * Generates coefficients for a Windowed-Sinc FIR low-pass filter.
 * @param {number} originalSr Original sample rate.
 * @param {number} targetSr Target sample rate.
 * @param {number} taps The number of coefficients to generate (window size).
 * @returns {Float32Array} The array of filter coefficients.
 */
function generateFirCoefficients(originalSr, targetSr, taps) {
    const cutoff = targetSr / 2;
    const normalizedCutoff = cutoff / originalSr;
    const coeffs = new Float32Array(taps);
    let sum = 0;

    for (let i = 0; i < taps; i++) {
        const x = i - (taps - 1) / 2;
        
        // Sinc function
        let sinc = x === 0 ? 1.0 : Math.sin(2 * Math.PI * normalizedCutoff * x) / (2 * Math.PI * normalizedCutoff * x);
        
        // Blackman window function for smoothing
        let blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
        
        coeffs[i] = sinc * blackman;
        sum += coeffs[i];
    }
    
    // Normalize the coefficients to have a gain of 1.0 (prevents volume changes)
    for (let i = 0; i < taps; i++) {
        coeffs[i] /= sum;
    }

    return coeffs;
}

/**
 * Manually downsamples an audio signal using the refined high-quality FIR filter.
 */
function manualDownsample(signalData, originalSampleRate, targetSampleRate) {
    const ratio = originalSampleRate / targetSampleRate;
    const newLength = Math.floor(signalData.length / ratio);
    const result = new Float32Array(newLength);
    
    // Dynamically generate the high-quality filter coefficients
    const firCoeffs = generateFirCoefficients(originalSampleRate, targetSampleRate, FIR_TAPS);
    const halfCoeffsLen = Math.floor(firCoeffs.length / 2);

    // 1. Apply the low-pass filter (convolution)
    const filteredSignal = new Float32Array(signalData.length);
    for (let i = 0; i < signalData.length; i++) {
        let filteredSample = 0;
        for (let j = 0; j < firCoeffs.length; j++) {
            const sampleIndex = i - halfCoeffsLen + j;
            if (sampleIndex >= 0 && sampleIndex < signalData.length) {
                filteredSample += signalData[sampleIndex] * firCoeffs[j];
            }
        }
        filteredSignal[i] = filteredSample;
    }

    // 2. Decimate the filtered signal
    for (let i = 0; i < newLength; i++) {
        result[i] = filteredSignal[Math.floor(i * ratio)];
    }

    return result;
}

// --- End of refined section ---

/**
 * Downsamples using the high-quality native OfflineAudioContext.
 * (This function remains unchanged)
 */
async function nativeDownsample(signalData, originalSampleRate, targetSampleRate) {
    const tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sourceBuffer = tempAudioContext.createBuffer(1, signalData.length, originalSampleRate);
    sourceBuffer.copyToChannel(signalData, 0);
    const duration = sourceBuffer.duration;
    const newLength = Math.ceil(duration * targetSampleRate);
    const offlineCtx = new OfflineAudioContext(1, newLength, targetSampleRate);
    const sourceNode = offlineCtx.createBufferSource();
    sourceNode.buffer = sourceBuffer;
    sourceNode.connect(offlineCtx.destination);
    sourceNode.start(0);
    const downsampledBuffer = await offlineCtx.startRendering();
    return downsampledBuffer.getChannelData(0);
}

/**
 * NEW: Encodes a Float32Array into a PCM WAV file Blob.
 * @param {Float32Array} samples The audio data.
 * @param {number} sampleRate The sample rate of the audio.
 * @returns {Blob} A Blob object representing the WAV file.
 */
function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // Audio format 1 is PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // Byte rate
    view.setUint16(32, 2, true); // Block align
    view.setUint16(34, 16, true); // 16 bits per sample
    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Write the PCM data
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * NEW: Upsamples an audio signal to a new sample rate using OfflineAudioContext.
 * This version uses a playbackRate trick to handle source sample rates below the API's limit.
 * @param {Float32Array} signalData The raw audio data to upsample.
 * @param {number} originalSampleRate The original (low) sample rate of the signal.
 * @param {number} targetSampleRate The desired (high) new sample rate.
 * @returns {Promise<Float32Array>} A promise that resolves with the upsampled audio data.
 */
async function upsampleSignal(signalData, originalSampleRate, targetSampleRate) {
    console.log(`Upsampling signal from ${originalSampleRate}Hz to ${targetSampleRate}Hz for preview.`);
    const tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // 1. Create a buffer at a SUPPORTED sample rate (the context's own rate).
    const sourceBuffer = tempAudioContext.createBuffer(1, signalData.length, tempAudioContext.sampleRate);
    sourceBuffer.copyToChannel(signalData, 0);
    
    // 2. Calculate the true duration based on the ORIGINAL sample rate.
    const trueDuration = signalData.length / originalSampleRate;
    const newLength = Math.ceil(trueDuration * targetSampleRate);
    
    // 3. Create an offline context at the HIGH target rate.
    const offlineCtx = new OfflineAudioContext(1, newLength, targetSampleRate);
    
    const sourceNode = offlineCtx.createBufferSource();
    sourceNode.buffer = sourceBuffer;
    
    // 4. THE TRICK: Adjust playbackRate to stretch the audio.
    // This forces high-quality resampling to fill the gaps.
    sourceNode.playbackRate.value = originalSampleRate / tempAudioContext.sampleRate;
    
    sourceNode.connect(offlineCtx.destination);
    sourceNode.start(0);
    const upsampledBuffer = await offlineCtx.startRendering();
    
    return upsampledBuffer.getChannelData(0);
}

/**
 * NEW: Encodes two Float32Arrays into a STEREO PCM WAV file Blob.
 * @param {Float32Array} leftChannel The left channel audio data.
 * @param {Float32Array} rightChannel The right channel audio data.
 * @param {number} sampleRate The sample rate of the audio.
 * @returns {Blob} A Blob object representing the stereo WAV file.
 */
function encodeStereoWAV(leftChannel, rightChannel, sampleRate) {
    const length = Math.min(leftChannel.length, rightChannel.length);
    const buffer = new ArrayBuffer(44 + length * 4); // 2 channels, 2 bytes per sample
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length * 4, true);
    writeString(view, 8, 'WAVE');
    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 2, true); // 2 channels (Stereo)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true); // Byte rate
    view.setUint16(32, 4, true); // Block align
    view.setUint16(34, 16, true); // 16 bits per sample
    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, length * 4, true);

    // Write interleaved PCM data
    let offset = 44;
    for (let i = 0; i < length; i++) {
        // Left channel
        let s = Math.max(-1, Math.min(1, leftChannel[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
        // Right channel
        s = Math.max(-1, Math.min(1, rightChannel[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }
    
    return new Blob([view], { type: 'audio/wav' });
}