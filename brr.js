// Adapted from https://github.com/Optiroc/BRRtools
// by Bregalad, Kode54, Optiroc, nyanpasu64....


/**
 * Simulates 16-bit signed integer wrapping. This is the key to matching hardware behavior.
 * @param {number} n The number to wrap.
 * @returns {number} The 16-bit wrapped signed value.
 */
function wrap16(n) {
    return (n << 16) >> 16;
}

/**
 * Clamps a number to the signed 16-bit integer range [-32768, 32767].
 * @param {number} n The number to clamp.
 * @returns {number} The clamped number.
 */
function clamp16(n) {
    if (n > 32767) return 32767;
    if (n < -32768) return -32768;
    return Math.round(n);
}

/**
 * Calculates the predicted next sample value using stable floating-point math
 * and then wraps the result to the 16-bit signed range to perfectly simulate hardware behavior.
 * @param {number} filter The filter index (0-3).
 * @param {number} p1 The previous sample.
 * @param {number} p2 The sample before the previous one.
 * @returns {number} The wrapped, predicted sample value.
 */
function getPrediction(filter, p1, p2) {
    let prediction = 0.0;
    switch (filter) {
        case 0: break;
        case 1: prediction = p1 * 0.9375; break;
        case 2: prediction = p1 * 1.90625 - p2 * 0.9375; break;
        case 3: prediction = p1 * 1.796875 - p2 * 0.8125; break;
    }
    return wrap16(Math.round(prediction));
}

/**
 * Performs a single trial or final encoding of a 16-sample block.
 * @returns {object} An object containing either the error or the encoded block and the final history samples.
 */
function processBlock(pcmBlock, shiftAmount, filter, initial_p1, initial_p2, writeMode) {
    const brrBuffer = writeMode ? new Uint8Array(9) : null;
    let totalError = 0;
    let p1 = initial_p1;
    let p2 = initial_p2;

    for (let i = 0; i < 16; i++) {
        const pcmSample = pcmBlock[i];
        const prediction = getPrediction(filter, p1, p2);
        const vlin = prediction >> 1;

        let diff = (pcmSample >> 1) - vlin;
        const diff_abs = Math.abs(diff);
        if (diff_abs > 16384 && diff_abs < 32768) {
            diff = diff > 0 ? diff - 32768 : diff + 32768;
        }

        const step = 1 << shiftAmount;
        const dp_quant_offset = diff + (step << 2) + (step >> 2);
        let c = 0;
        if (dp_quant_offset > 0) {
            c = (step > 1) ? ((dp_quant_offset / (step / 2)) | 0) : dp_quant_offset * 2;
            if (c > 15) c = 15;
        }

        const quantizedNibble = c - 8;
        const dp_dequant = (quantizedNibble << shiftAmount) >> 1;
        const halfSample = vlin + dp_dequant;
        const clampedHalf = clamp16(halfSample);
        const reconstructedSample = clampedHalf * 2;
        if ((reconstructedSample > 32767 || reconstructedSample < -32768)) {
            if (writeMode) console.log("Warning: reconstructed sample out of range");
            totalError += 999999999;
        }

        const wrappedReconstructedSample = wrap16(reconstructedSample);

        const error = pcmSample - wrappedReconstructedSample;
        totalError += error * error;

        p2 = p1;
        p1 = wrappedReconstructedSample;

        if (writeMode) {
            const finalNibble = quantizedNibble & 0x0F;
            const byteIndex = 1 + (i >> 1);
            if (i % 2 === 0) {
                brrBuffer[byteIndex] = (finalNibble << 4);
            } else {
                brrBuffer[byteIndex] |= finalNibble;
            }
        }
    }

    if (writeMode) {
        return { block: brrBuffer, p1: p1, p2: p2 };
    } else {
        return { error: totalError / 16, p1: p1, p2: p2 };
    }
}

/**
 * Finds the best encoding parameters for a 16-sample block and encodes it.
 * @returns {object} An object containing the 9-byte BRR block and the final p1/p2 history.
 */
function findAndEncodeBlock(pcmBlock, p1, p2) {
    let bestError = Infinity;
    let bestShift = 0;
    let bestFilter = 0;
    for (let s = 0; s < 13; s++) {
        for (let f = 0; f < 4; f++) {
            const result = processBlock(pcmBlock, s, f, p1, p2, false);
            if (result.error < bestError) {
                bestError = result.error;
                bestShift = s;
                bestFilter = f;
            }
        }
    }
    const finalResult = processBlock(pcmBlock, bestShift, bestFilter, p1, p2, true);
    finalResult.block[0] = (bestShift << 4) | (bestFilter << 2);
    return finalResult;
}

/**
 * The main entry point for encoding a full audio signal into SNES BRR format.
 * @param {Float32Array} float32PcmData The raw audio data.
 * @returns {Uint8Array[]} An array of 9-byte BRR blocks.
 */
function encodeBRR(float32PcmData) {
    const pcmData = new Int16Array(float32PcmData.length);
    for (let i = 0; i < float32PcmData.length; i++) {
        pcmData[i] = clamp16(float32PcmData[i] * 32767);
    }
    const padding = (16 - (pcmData.length % 16)) % 16;
    let paddedPcmData = pcmData;
    if (padding !== 0) {
        paddedPcmData = new Int16Array(pcmData.length + padding);
        paddedPcmData.set(pcmData, 0);
    }
    let p1 = 0, p2 = 0;
    const brrBlocks = [];
    for (let i = 0; i < paddedPcmData.length; i += 16) {
        const pcmBlock = paddedPcmData.subarray(i, i + 16);
        const result = findAndEncodeBlock(pcmBlock, p1, p2);
        brrBlocks.push(result.block);
        p1 = result.p1;
        p2 = result.p2;
    }
    if (brrBlocks.length > 0) {
        brrBlocks[brrBlocks.length - 1][0] |= 0x01;
    }
    console.log(`Encoded ${paddedPcmData.length} samples into ${brrBlocks.length} BRR blocks.`);
    return brrBlocks;
}


/**
 * The main entry point for decoding an array of BRR blocks into PCM audio data.
 * @param {Uint8Array[]} brrBlocks An array of 9-byte BRR blocks.
 * @returns {Float32Array} The decoded audio data, normalized to [-1.0, 1.0].
 */
function decodeBRR(brrBlocks) {
    const totalSamples = brrBlocks.length * 16;
    const pcmSamples = new Int16Array(totalSamples);
    let p1 = 0; // History sample 1
    let p2 = 0; // History sample 2

    for (let blockIndex = 0; blockIndex < brrBlocks.length; blockIndex++) {
        const block = brrBlocks[blockIndex];
        const header = block[0];
        const shiftAmount = (header >> 4) & 0x0F;
        const filter = (header >> 2) & 0x03;

        for (let i = 0; i < 8; i++) {
            const byte = block[i + 1];

            // Decode high nibble
            let nibble = byte >> 4;
            let signedNibble = (nibble & 8) ? (nibble - 16) : nibble;
            
            let sample = (shiftAmount <= 12) ? ((signedNibble << shiftAmount) >> 1) : ((signedNibble < 0) ? -2048 : 2048);
            
            sample += getPrediction(filter, p1, p2);
            sample = clamp16(sample);
            
            // SPC700 specific 15-bit wrapping behavior
            if (sample > 16383) sample -= 32768;
            if (sample < -16384) sample += 32768;
            
            p2 = p1;
            p1 = sample;
            pcmSamples[blockIndex * 16 + i * 2] = wrap16(p1 * 2);

            // Decode low nibble
            nibble = byte & 0x0F;
            signedNibble = (nibble & 8) ? (nibble - 16) : nibble;
            
            sample = (shiftAmount <= 12) ? ((signedNibble << shiftAmount) >> 1) : ((signedNibble < 0) ? -2048 : 2048);

            sample += getPrediction(filter, p1, p2);
            sample = clamp16(sample);

            // SPC700 specific 15-bit wrapping behavior
            if (sample > 16383) sample -= 32768;
            if (sample < -16384) sample += 32768;

            p2 = p1;
            p1 = sample;
            pcmSamples[blockIndex * 16 + i * 2 + 1] = wrap16(p1 * 2);
        }
    }

    // Convert to Float32Array for Web Audio API
    const float32Pcm = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
        float32Pcm[i] = pcmSamples[i] / 32768.0;
    }

    return float32Pcm;
}

/**
 * Applies the SNES's Gaussian low-pass filter emulation to a decoded signal.
 * This should be applied AFTER decoding.
 * @param {Float32Array} pcmData The decoded PCM data (range -1.0 to 1.0).
 * @returns {Float32Array} A new array containing the filtered audio data.
 */
function applyGaussFilter(pcmData) {
    const len = pcmData.length;
    if (len < 2) return pcmData.slice(); // Return a copy if too short to filter

    const out = new Float32Array(len);
    
    // FIR coefficients from C code, normalized by 2048
    const c0 = 372 / 2048;  // 0.181640625
    const c1 = 1304 / 2048; // 0.63671875
    
    // Handle first sample (edge case)
    let prev = (c1 + c0) * pcmData[0] + c0 * pcmData[1];
    
    // Main loop
    for (let i = 1; i < len - 1; i++) {
        let current = c0 * pcmData[i - 1] + c1 * pcmData[i] + c0 * pcmData[i + 1];
        out[i - 1] = prev;
        prev = current;
    }

    // Handle last two samples (edge cases)
    let last = c0 * pcmData[len - 2] + (c1 + c0) * pcmData[len - 1];
    out[len - 2] = prev;
    out[len - 1] = last;
    
    return out;
}