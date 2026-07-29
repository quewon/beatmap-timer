function _nextPow2(n) {
    return Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 * `re`/`im` are Float32Arrays of equal length n (must be a power of 2);
 * results are written back into them.
 */
function _fft(re, im) {
    const n = re.length;

    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curWr = 1, curWi = 0;
            for (let k = 0; k < half; k++) {
                const aRe = re[i + k], aIm = im[i + k];
                const bRe = re[i + k + half], bIm = im[i + k + half];
                const tRe = bRe * curWr - bIm * curWi;
                const tIm = bRe * curWi + bIm * curWr;
                re[i + k] = aRe + tRe;
                im[i + k] = aIm + tIm;
                re[i + k + half] = aRe - tRe;
                im[i + k + half] = aIm - tIm;
                const nextWr = curWr * wr - curWi * wi;
                const nextWi = curWr * wi + curWi * wr;
                curWr = nextWr;
                curWi = nextWi;
            }
        }
    }
}

const _SPECTROGRAM_COLOR_STOPS = [
    [0.00, 0, 0, 4],
    [0.25, 40, 11, 84],
    [0.50, 140, 41, 129],
    [0.70, 222, 73, 104],
    [0.85, 250, 152, 58],
    [1.00, 252, 255, 164],
];

function _defaultSpectrogramColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < _SPECTROGRAM_COLOR_STOPS.length; i++) {
        const [t1, r1, g1, b1] = _SPECTROGRAM_COLOR_STOPS[i - 1];
        const [t2, r2, g2, b2] = _SPECTROGRAM_COLOR_STOPS[i];
        if (t <= t2) {
            const f = (t - t1) / (t2 - t1 || 1);
            return [
                Math.round(r1 + (r2 - r1) * f),
                Math.round(g1 + (g2 - g1) * f),
                Math.round(b1 + (b2 - b1) * f),
            ];
        }
    }
    const last = _SPECTROGRAM_COLOR_STOPS[_SPECTROGRAM_COLOR_STOPS.length - 1];
    return [last[1], last[2], last[3]];
}

class WaveformAudio {
    constructor(audioContext = null, { peaksSamplesPerPixel = 256 } = {}) {
        this.audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();

        this.buffer = null;
        this.duration = 0;
        this.sampleRate = 0;
        this.numberOfChannels = 0;
        this.fileName = null;

        this._peaksSamplesPerPixel = peaksSamplesPerPixel;
        this._peaks = null; // { perChannel: [{min,max}], mix: {min,max}, step, peakLength }
        this._rawChannelData = null; // Float32Array per channel, kept for high-zoom exact drawing

        this._spectrogram = null;

        this._gainNode = this.audioContext.createGain();
        this._gainNode.connect(this.audioContext.destination);

        this._sourceNode = null;
        this._isPlaying = false;
        this._startContextTime = 0;
        this._startOffset = 0;
        this._pausedAt = 0;
        this._playbackRate = 1;

        this._onEndedCallback = null;
    }

    get isLoaded() {
        return this.buffer !== null;
    }

    get isPlaying() {
        return this._isPlaying;
    }

    get isSpectrogramLoading() {
        return this._spectrogram !== null && this._spectrogram.status === "building";
    }

    set volume(v) {
        this._gainNode.gain.value = v;
    }

    get volume() {
        return this._gainNode.gain.value;
    }

    set playbackRate(rate) {
        const current = this.getCurrentTime();
        this._playbackRate = rate;
        if (this._sourceNode) {
            this._sourceNode.playbackRate.value = rate;
        }
        this._startContextTime = this.audioContext.currentTime;
        this._startOffset = current;
    }

    get playbackRate() {
        return this._playbackRate;
    }

    async load(source) {
        let arrayBuffer;
        let fileName = null;
        if (source instanceof ArrayBuffer) {
            arrayBuffer = source;
        } else if (source instanceof Blob) {
            arrayBuffer = await source.arrayBuffer();
            if (source instanceof File) fileName = source.name;
        } else if (typeof source === "string") {
            const res = await fetch(source);
            if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status} ${res.statusText}`);
            arrayBuffer = await res.arrayBuffer();
            fileName = decodeURIComponent(source.split("/").pop().split("?")[0].split("#")[0]) || null;
        } else {
            throw new TypeError("load() expects a URL string, File, Blob, or ArrayBuffer");
        }

        this._stopSourceNode();
        this._isPlaying = false;
        this._pausedAt = 0;

        this.buffer = await this.audioContext.decodeAudioData(arrayBuffer);
        this.duration = this.buffer.duration;
        this.sampleRate = this.buffer.sampleRate;
        this.numberOfChannels = this.buffer.numberOfChannels;
        this.fileName = fileName;

        this._buildPeaks();
        this._spectrogram = null;

        return this;
    }

    _buildPeaks() {
        const numChannels = this.numberOfChannels;
        const length = this.buffer.length;
        const step = this._peaksSamplesPerPixel;
        const peakLength = Math.max(1, Math.ceil(length / step));

        const channelData = [];
        for (let c = 0; c < numChannels; c++) channelData.push(this.buffer.getChannelData(c));

        const perChannel = [];
        for (let c = 0; c < numChannels; c++) {
            perChannel.push({ min: new Float32Array(peakLength), max: new Float32Array(peakLength), peakAmplitude: 0 });
        }
        const mix = { min: new Float32Array(peakLength), max: new Float32Array(peakLength), peakAmplitude: 0 };

        const chMin = new Float64Array(numChannels);
        const chMax = new Float64Array(numChannels);
        const chPeak = new Float64Array(numChannels);
        let mixPeak = 0;

        for (let i = 0; i < peakLength; i++) {
            const start = i * step;
            const end = Math.min(start + step, length);

            chMin.fill(Infinity);
            chMax.fill(-Infinity);
            let mixMin = Infinity;
            let mixMax = -Infinity;

            for (let s = start; s < end; s++) {
                let sum = 0;
                for (let c = 0; c < numChannels; c++) {
                    const v = channelData[c][s];
                    sum += v;
                    if (v < chMin[c]) chMin[c] = v;
                    if (v > chMax[c]) chMax[c] = v;
                }
                const mixed = sum / numChannels;
                if (mixed < mixMin) mixMin = mixed;
                if (mixed > mixMax) mixMax = mixed;
            }

            for (let c = 0; c < numChannels; c++) {
                perChannel[c].min[i] = chMin[c];
                perChannel[c].max[i] = chMax[c];
                chPeak[c] = Math.max(chPeak[c], Math.abs(chMin[c]), Math.abs(chMax[c]));
            }
            mix.min[i] = mixMin;
            mix.max[i] = mixMax;
            mixPeak = Math.max(mixPeak, Math.abs(mixMin), Math.abs(mixMax));
        }

        for (let c = 0; c < numChannels; c++) perChannel[c].peakAmplitude = chPeak[c];
        mix.peakAmplitude = mixPeak;

        this._peaks = { perChannel, mix, step, peakLength };
        this._rawChannelData = channelData;
    }

    _getPeakAmplitude(channel) {
        const src = channel === "mix" ? this._peaks.mix : this._peaks.perChannel[channel];
        return src ? src.peakAmplitude : 0;
    }

    _mixSampleAt(index) {
        const channels = this._rawChannelData;
        let sum = 0;
        for (let c = 0; c < channels.length; c++) sum += channels[c][index];
        return sum / channels.length;
    }

    drawWaveform(ctx, options = {}) {
        if (!this.isLoaded) throw new Error("No audio loaded. Call load() first.");

        const {
            x = 0,
            y = 0,
            width = ctx.canvas.width,
            height = ctx.canvas.height,
            startTime = 0,
            endTime = this.duration,
            channel = "mix",
            color = "#3b82f6",
            backgroundColor = null,
            amplitudeScale = 1,
            normalize = true,
            maxAmplitudeFraction = 1,
            lineWidth = 1,
            drawZeroLine = false,
            zeroLineColor = "rgba(255,255,255,0.2)",
        } = options;

        const clampedStart = Math.max(0, Math.min(startTime, this.duration));
        const clampedEnd = Math.max(clampedStart, Math.min(endTime, this.duration));

        ctx.save();

        if (backgroundColor) {
            ctx.fillStyle = backgroundColor;
            ctx.fillRect(x, y, width, height);
        }

        if (drawZeroLine) {
            ctx.strokeStyle = zeroLineColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y + height / 2);
            ctx.lineTo(x + width, y + height / 2);
            ctx.stroke();
        }

        if (width <= 0 || height <= 0 || clampedEnd <= clampedStart) {
            ctx.restore();
            return;
        }

        let effectiveAmplitudeScale = amplitudeScale;
        if (normalize) {
            const peak = this._getPeakAmplitude(channel);
            const normFactor = peak > 1e-6 ? maxAmplitudeFraction / peak : 1;
            effectiveAmplitudeScale *= normFactor;
        }

        const halfHeight = (height / 2) * effectiveAmplitudeScale;
        const midY = y + height / 2;

        const startSample = Math.floor(clampedStart * this.sampleRate);
        const endSample = Math.floor(clampedEnd * this.sampleRate);
        const sampleSpan = Math.max(1, endSample - startSample);
        const samplesPerPixel = sampleSpan / width;

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();

        // use fast cache when zoomed out enough
        const usePeaks = samplesPerPixel >= this._peaks.step;

        if (usePeaks) {
            const { min: minArr, max: maxArr } =
                channel === "mix" ? this._peaks.mix : this._peaks.perChannel[channel];
            const peaksPerPixel = samplesPerPixel / this._peaks.step;
            const startPeak = startSample / this._peaks.step;

            for (let px = 0; px < width; px++) {
                const peakStart = Math.floor(startPeak + px * peaksPerPixel);
                const peakEnd = Math.max(peakStart + 1, Math.floor(startPeak + (px + 1) * peaksPerPixel));
                const s = Math.max(0, peakStart);
                const e = Math.min(minArr.length, peakEnd);
                if (s >= e) continue;

                let mn = Infinity;
                let mx = -Infinity;
                for (let i = s; i < e; i++) {
                    if (minArr[i] < mn) mn = minArr[i];
                    if (maxArr[i] > mx) mx = maxArr[i];
                }

                const yTop = midY - mx * halfHeight;
                const yBottom = midY - mn * halfHeight;
                ctx.moveTo(x + px, yTop);
                ctx.lineTo(x + px, Math.max(yTop + lineWidth, yBottom));
            }
        } else {
            // zoomed in past cache resolution, read raw samples
            const data = channel === "mix" ? null : this._rawChannelData[channel];

            for (let px = 0; px < width; px++) {
                const sStart = Math.floor(startSample + px * samplesPerPixel);
                const sEnd = Math.max(sStart + 1, Math.floor(startSample + (px + 1) * samplesPerPixel));
                const s = Math.max(0, sStart);
                const e = Math.min(this.buffer.length, sEnd);
                if (s >= e) continue;

                let mn = Infinity;
                let mx = -Infinity;
                for (let i = s; i < e; i++) {
                    const v = data ? data[i] : this._mixSampleAt(i);
                    if (v < mn) mn = v;
                    if (v > mx) mx = v;
                }

                const yTop = midY - mx * halfHeight;
                const yBottom = midY - mn * halfHeight;
                ctx.moveTo(x + px, yTop);
                ctx.lineTo(x + px, Math.max(yTop + lineWidth, yBottom));
            }
        }

        ctx.stroke();
        ctx.restore();
    }

    _computeSpectrogramMagnitudes(channel, n, hop, startCol, endCol) {
        const half = n / 2;
        const bufferLength = this.buffer.length;
        const data = channel === "mix" ? null : this._rawChannelData[channel];
        const sampleAt = (i) => {
            if (i < 0 || i >= bufferLength) return 0;
            return data ? data[i] : this._mixSampleAt(i);
        };

        const window = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        }

        const columns = endCol - startCol;
        const magnitudes = new Float32Array(columns * half);
        const re = new Float32Array(n);
        const im = new Float32Array(n);

        for (let col = 0; col < columns; col++) {
            const winStart = (startCol + col) * hop - (n >> 1);

            im.fill(0);
            for (let i = 0; i < n; i++) {
                re[i] = sampleAt(winStart + i) * window[i];
            }

            _fft(re, im);

            const base = col * half;
            for (let k = 0; k < half; k++) {
                magnitudes[base + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n;
            }
        }

        return magnitudes;
    }

    _getSpectrogramState(options) {
        const {
            channel = "mix",
            fftSize = 1024,
            hopSize = null,
            minFrequency = 20,
            maxFrequency = this.sampleRate / 2,
            minDecibels = -100,
            maxDecibels = -30,
            frequencyScale = "log",
            colorMap = _defaultSpectrogramColor,
            cacheRows = 512,
            tileColumns = 4096,
        } = options;

        const n = _nextPow2(fftSize);
        const hop = hopSize || Math.max(1, Math.floor(n / 4));
        const rows = Math.max(1, Math.round(cacheRows));
        const key = [channel, n, hop, minFrequency, maxFrequency, minDecibels, maxDecibels, frequencyScale, rows, colorMap, tileColumns].join(":");

        if (this._spectrogram && this._spectrogram.key === key) {
            return this._spectrogram;
        }

        const half = n / 2;
        const columns = Math.max(1, Math.ceil(this.buffer.length / hop));
        const nyquist = this.sampleRate / 2;
        const clampedMinFreq = Math.max(frequencyScale === "log" ? 1 : 0, minFrequency);
        const clampedMaxFreq = Math.min(Math.max(maxFrequency, clampedMinFreq * 1.0001), nyquist);

        // Precompute which FFT bin each output row samples from (row 0 = top = maxFrequency).
        const rowBin = new Int32Array(rows);
        for (let py = 0; py < rows; py++) {
            const frac = rows === 1 ? 0 : py / (rows - 1);
            let freq;
            if (frequencyScale === "log") {
                const logMin = Math.log(clampedMinFreq);
                const logMax = Math.log(clampedMaxFreq);
                freq = Math.exp(logMax - frac * (logMax - logMin));
            } else {
                freq = clampedMaxFreq - frac * (clampedMaxFreq - clampedMinFreq);
            }
            const bin = Math.round((freq / nyquist) * half);
            rowBin[py] = Math.max(0, Math.min(half - 1, bin));
        }

        const state = {
            key, channel, n, half, hop, columns, rows, tileColumns, rowBin, minDecibels, maxDecibels, colorMap,
            tiles: [], // { startCol, endCol, canvas }, ascending, contiguous from column 0 up to builtColumns
            builtColumns: 0,
            status: "building", // building / done / error
            error: null,
            failedAtTime: null,
        };
        this._spectrogram = state;
        this._buildSpectrogramTiles(state);
        return state;
    }

    // build tiles one at a time
    async _buildSpectrogramTiles(state) {
        const dbRange = state.maxDecibels - state.minDecibels || 1;

        for (let startCol = 0; startCol < state.columns; startCol += state.tileColumns) {
            if (this._spectrogram !== state) return;

            const endCol = Math.min(state.columns, startCol + state.tileColumns);
            try {
                const tileCols = endCol - startCol;
                const magnitudes = this._computeSpectrogramMagnitudes(state.channel, state.n, state.hop, startCol, endCol);

                const canvas = document.createElement("canvas");
                canvas.width = tileCols;
                canvas.height = state.rows;
                const ctx = canvas.getContext("2d");
                const imageData = ctx.createImageData(tileCols, state.rows);
                const pixels = imageData.data;

                for (let col = 0; col < tileCols; col++) {
                    const base = col * state.half;
                    for (let py = 0; py < state.rows; py++) {
                        const db = 20 * Math.log10(magnitudes[base + state.rowBin[py]] + 1e-12);
                        const t = (db - state.minDecibels) / dbRange;
                        const [r, g, b] = state.colorMap(t);
                        const idx = (py * tileCols + col) * 4;
                        pixels[idx] = r;
                        pixels[idx + 1] = g;
                        pixels[idx + 2] = b;
                        pixels[idx + 3] = 255;
                    }
                }
                ctx.putImageData(imageData, 0, 0);

                state.tiles.push({ startCol, endCol, canvas });
                state.builtColumns = endCol;
            } catch (err) {
                state.status = "error";
                state.error = err;
                state.failedAtTime = (startCol * state.hop) / this.sampleRate;
                console.warn("Spectrogram build failed at t=" + state.failedAtTime.toFixed(1) + "s:", err);
                return;
            }

            await new Promise((resolve) => {
                if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => resolve());
                else setTimeout(resolve, 0);
            });
        }

        if (this._spectrogram === state) state.status = "done";
    }

    drawSpectrogram(ctx, options = {}) {
        if (!this.isLoaded) throw new Error("No audio loaded. Call load() first.");

        const {
            x = 0,
            y = 0,
            width = ctx.canvas.width,
            height = ctx.canvas.height,
            startTime = 0,
            endTime = this.duration,
            maxHeightFraction = 1,
        } = options;

        const clampedStart = Math.max(0, Math.min(startTime, this.duration));
        const clampedEnd = Math.max(clampedStart, Math.min(endTime, this.duration));
        if (width <= 0 || height <= 0 || clampedEnd <= clampedStart) return;

        const state = this._getSpectrogramState(options);

        const drawHeight = height * maxHeightFraction;
        const drawY = y + (height - drawHeight) / 2;

        const startCol = (clampedStart * this.sampleRate) / state.hop;
        const endCol = Math.max(startCol + 1 / state.columns, (clampedEnd * this.sampleRate) / state.hop);
        const colToX = (col) => x + ((col - startCol) / (endCol - startCol)) * width;

        ctx.save();

        for (const tile of state.tiles) {
            const overlapStart = Math.max(tile.startCol, startCol);
            const overlapEnd = Math.min(tile.endCol, endCol);
            if (overlapEnd <= overlapStart) continue;
            const srcX = overlapStart - tile.startCol;
            const srcW = Math.max(1e-6, overlapEnd - overlapStart);
            const dstX = colToX(overlapStart);
            const dstW = Math.max(1, colToX(overlapEnd) - dstX);
            ctx.drawImage(tile.canvas, srcX, 0, srcW, state.rows, dstX, drawY, dstW, drawHeight);
        }

        if (state.status === "error") {
            const failedCol = (state.failedAtTime * this.sampleRate) / state.hop;
            if (failedCol >= startCol && failedCol <= endCol) {
                const failX = colToX(failedCol);
                ctx.fillStyle = "rgba(220,50,50,0.6)";
                ctx.fillRect(failX, drawY, Math.max(2, width * 0.005), drawHeight);
                ctx.fillStyle = "rgba(255,140,140,0.95)";
                ctx.font = `${Math.max(10, Math.round(drawHeight * 0.04))}px monospace`;
                ctx.textAlign = "left";
                ctx.textBaseline = "top";
                ctx.fillText(`spectrogram failed here: ${state.error?.message || state.error}`, failX + 4, drawY + 4);
            }
        }

        ctx.restore();
    }

    play(offset = null) {
        if (!this.isLoaded) throw new Error("No audio loaded. Call load() first.");

        if (this.audioContext.state === "suspended") {
            this.audioContext.resume();
        }

        this._stopSourceNode();

        const startOffset = offset !== null ? this._clampTime(offset) : this._clampTime(this._pausedAt);

        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffer;
        source.playbackRate.value = this._playbackRate;
        source.connect(this._gainNode);
        source.onended = () => {
            if (this._sourceNode !== source) return;
            this._isPlaying = false;
            this._pausedAt = this.duration;
            this._sourceNode = null;
            if (this._onEndedCallback) this._onEndedCallback();
        };

        this._sourceNode = source;
        this._startContextTime = this.audioContext.currentTime;
        this._startOffset = startOffset;
        this._isPlaying = true;

        source.start(0, startOffset);

        return this;
    }

    pause() {
        if (!this._isPlaying) return this;
        this._pausedAt = this.getCurrentTime();
        this._stopSourceNode();
        this._isPlaying = false;
        return this;
    }

    stop() {
        this._stopSourceNode();
        this._isPlaying = false;
        this._pausedAt = 0;
        return this;
    }

    seek(time) {
        const t = this._clampTime(time);
        if (this._isPlaying) {
            this.play(t);
        } else {
            this._pausedAt = t;
        }
        return this;
    }

    getCurrentTime() {
        if (!this.isLoaded) return 0;
        if (this._isPlaying) {
            const elapsed = (this.audioContext.currentTime - this._startContextTime) * this._playbackRate;
            return this._clampTime(this._startOffset + elapsed);
        }
        return this._pausedAt;
    }

    onEnded(callback) {
        this._onEndedCallback = callback;
    }

    _stopSourceNode() {
        if (!this._sourceNode) return;
        const node = this._sourceNode;
        node.onended = null;
        try {
            node.stop();
        } catch (e) { }
        node.disconnect();
        if (this._sourceNode === node) this._sourceNode = null;
    }

    _clampTime(t) {
        return Math.max(0, Math.min(t, this.duration));
    }

    dispose() {
        this._stopSourceNode();
        this._gainNode.disconnect();
        this.buffer = null;
        this._peaks = null;
        this._rawChannelData = null;
        this._spectrogram = null;
    }
}