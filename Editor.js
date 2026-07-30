class TimingPoint {
    constructor({ id, time, bpm = 120, timeSignature = [4, 4], beatCount = 0 }) {
        this.id = id;
        this.time = time;
        this.bpm = bpm;
        this.timeSignature = timeSignature;
        this.beatCount = beatCount;
    }
}

class Editor {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.audio = options.audio || new WaveformAudio();

        this.drawMode = options.drawMode || "waveform";
        this.waveformColor = options.waveformColor || "rgb(50, 150, 150)";
        this.playheadColor = options.playheadColor || "red";
        this.cursorColor = options.cursorColor || "red";
        this.timingPointColor = options.timingPointColor || "white";
        this.pointColor = options.pointColor || "gray";
        this.pointHighlightColor = options.pointHighlightColor || "yellow";
        this.misalignedPointColor = options.misalignedPointColor || "red";

        this.timestampElement = options.timestampElement;
        this.playPauseElement = options.playPauseElement;
        this.exportElement = options.exportElement;
        this.followPlayheadElement = options.followPlayheadElement;
        this.metronomeVolumeElement = options.metronomeVolumeElement;
        this.undoElement = options.undoElement;
        this.redoElement = options.redoElement;

        this.sectionBpmElement = options.sectionBpmElement;
        this.sectionTimeSignatureNumeratorElement = options.sectionTimeSignatureNumeratorElement;
        this.sectionTimeSignatureDenominatorElement = options.sectionTimeSignatureDenominatorElement;
        this.sectionBeatCountElement = options.sectionBeatCountElement;
        this.currentSectionPointId = null;

        this.followPlayheadEnabled = !!this.followPlayheadElement.checked;

        this.mouse = null; // { x, y } in px
        this.dragPan = null; // { startClientX, startViewStart } while dragging

        this.viewStart = 0;
        this.viewDuration = null;

        this.minViewDuration = options.minViewDuration ?? 0.05;
        this.zoomWheelSensitivity = options.zoomWheelSensitivity ?? 0.002;
        this.trackpadZoomSensitivity = options.trackpadZoomSensitivity ?? 0.008;
        this.trackpadDeltaThreshold = options.trackpadDeltaThreshold ?? 50;
        this.panWheelSensitivity = options.panWheelSensitivity ?? 1;
        this.keyboardZoomFactor = options.keyboardZoomFactor ?? 1.3;
        this.keyboardScrollFraction = options.keyboardScrollFraction ?? 0.1;
        this.maxUndoSteps = options.maxUndoSteps ?? 500;

        this.resetControls();

        this.rulerHeight = options.rulerHeight ?? 14;
        this.handleHitRadius = options.handleHitRadius ?? 8;

        this.metronomeBuffers = { tick: null, accent: null };
        this.metronomeGainNode = this.audio.audioContext.createGain();
        this.metronomeGainNode.connect(this.audio.audioContext.destination);
        this.metronomeVolumeMin = options.metronomeVolumeMin ?? 0;
        this.metronomeVolumeMax = options.metronomeVolumeMax ?? 6; // 600%
        this.metronomeVolume = Number(this.metronomeVolumeElement.value);
        this.loadMetronomeSounds();

        this.createTimingOverlayElements();

        this.rafId = null;

        this.bindEvents();
        this.resize();
    }

    get isReady() {
        return this.audio.isLoaded && this.viewDuration !== null;
    }

    isTimingBlocked() {
        return this.drawMode === "spectrogram" && this.audio.isSpectrogramLoading;
    }

    get viewEnd() {
        return this.viewStart + this.viewDuration;
    }

    get zoomLevel() {
        return this.isReady ? this.audio.duration / this.viewDuration : 1;
    }

    get rulerHeightPx() {
        return this.rulerHeight;
    }

    get dpr() {
        return window.devicePixelRatio || 1;
    }

    get drawWidth() {
        return this.canvas.width / this.dpr;
    }

    get drawHeight() {
        return this.canvas.height / this.dpr;
    }

    set metronomeVolume(v) {
        this.metronomeGainNode.gain.value = Math.max(this.metronomeVolumeMin, Math.min(this.metronomeVolumeMax, v));
    }

    get metronomeVolume() {
        return this.metronomeGainNode.gain.value;
    }

    async loadFile(file) {
        if (file && typeof file.name === "string" && file.name.toLowerCase().endsWith(".rtm")) {
            await this.loadRtmArchive(file);
        } else {
            this.importedArchive = null;
            await this.loadAudio(file);
        }
    }

    async loadAudio(source) {
        await this.audio.load(source);
        this.resetControls();
        this.resetView();
        return this.audio;
    }

    async loadRtmArchive(file) {
        const zip = await JSZip.loadAsync(file);

        const metaEntry = zip.file("meta.json");
        if (!metaEntry) throw new Error(`${file.name} is missing meta.json`);
        const meta = JSON.parse(await metaEntry.async("string"));

        const audioEntry = zip.file(meta.audioFile);
        if (!audioEntry) throw new Error(`meta.json references audioFile "${meta.audioFile}", not found in the archive`);
        const audioBlob = await audioEntry.async("blob");
        const audioFile = new File([audioBlob], meta.audioFile);

        await this.loadAudio(audioFile);

        this.importedArchive = { zip, meta, originalFileName: file.name };
        this.loadTimingPoints(meta.timingPoints);
    }

    loadTimingPoints(entries) {
        const points = (entries || []).map(
            (entry) =>
                new TimingPoint({
                    id: entry.id,
                    time: entry.time,
                    bpm: entry.bpm,
                    timeSignature: [entry.timeSignature?.[0] ?? 4, entry.timeSignature?.[1] ?? 4],
                })
        );
        points.sort((a, b) => a.time - b.time);

        for (let i = 0; i < points.length; i++) {
            const start = points[i].time;
            const end = points[i + 1] ? points[i + 1].time : this.audio.duration;
            const duration = Math.max(0, end - start);
            points[i].beatCount = Math.max(0, Math.round((points[i].bpm * duration) / 60));
        }

        this.timingPoints = points;
        this.nextTimingPointId = points.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    }

    resetControls() {
        this.timingPoints = []; // kept sorted ascending by time
        this.nextTimingPointId = 1;
        this.importedArchive = null;

        this.hoveredPointId = null;
        this.editingPointId = null;
        this.selectedPointId = null;
        this.hoveredBeat = null; // { pointId, index }
        this.pointDrag = null; // { pointId, snapshotTaken }

        this.undoStack = [];
        this.redoStack = [];
        this.updateUndoRedoButtons();
        this.updateExportButton();
        this.updateCanvasInteractivity();

        this.metronomeLastTime = null;
    }

    resetView() {
        this.viewStart = 0;
        this.viewDuration = this.audio.duration;
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.round(rect.width * this.dpr);
        this.canvas.height = Math.round(rect.height * this.dpr);
    }

    start() {
        if (this.rafId !== null) return;
        const loop = () => {
            this.draw();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stop() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    dispose() {
        this.stop();
        this.unbindEvents();
        this.destroyTimingOverlayElements();
    }

    // zoom

    zoomBy(factor, pivotTime = null) {
        if (!this.isReady || !isFinite(factor) || factor <= 0) return;

        const duration = this.audio.duration;
        const pivot = pivotTime !== null ? pivotTime : this.viewStart + this.viewDuration / 2;
        const pivotFrac = this.viewDuration > 0 ? (pivot - this.viewStart) / this.viewDuration : 0.5;

        const newDuration = Math.max(this.minViewDuration, Math.min(duration, this.viewDuration / factor));
        const maxStart = Math.max(0, duration - newDuration);
        const newStart = Math.max(0, Math.min(maxStart, pivot - pivotFrac * newDuration));

        this.viewDuration = newDuration;
        this.viewStart = newStart;
    }

    zoomIn(pivotTime = null, factor = null) {
        this.zoomBy(factor ?? this.keyboardZoomFactor, pivotTime);
    }

    zoomOut(pivotTime = null, factor = null) {
        this.zoomBy(1 / (factor ?? this.keyboardZoomFactor), pivotTime);
    }

    setView(startTime, viewDuration) {
        if (!this.audio.isLoaded) return;
        const duration = this.audio.duration;
        const d = Math.max(this.minViewDuration, Math.min(duration, viewDuration));
        const s = Math.max(0, Math.min(duration - d, startTime));
        this.viewDuration = d;
        this.viewStart = s;
    }

    // scroll

    scrollBy(deltaSeconds) {
        if (!this.isReady) return;
        this.disableFollowPlayhead();
        const maxStart = Math.max(0, this.audio.duration - this.viewDuration);
        this.viewStart = Math.max(0, Math.min(maxStart, this.viewStart + deltaSeconds));
    }

    disableFollowPlayhead() {
        if (!this.followPlayheadEnabled) return;
        this.followPlayheadEnabled = false;
        this.followPlayheadElement.checked = false;
    }

    scrollToTime(t, { align = "center" } = {}) {
        if (!this.isReady) return;
        let start;
        if (align === "start") start = t;
        else if (align === "end") start = t - this.viewDuration;
        else start = t - this.viewDuration / 2;

        const maxStart = Math.max(0, this.audio.duration - this.viewDuration);
        this.viewStart = Math.max(0, Math.min(maxStart, start));
    }

    followPlayhead(currentTime = null) {
        if (!this.isReady) return;
        const t = currentTime !== null ? currentTime : this.audio.getCurrentTime();
        this.scrollToTime(t, { align: "center" });
    }

    // timing points

    sortTimingPoints() {
        this.timingPoints.sort((a, b) => a.time - b.time);
    }

    sectionDurationAt(time) {
        const next = this.timingPoints.find((p) => p.time > time);
        return Math.max(0, (next ? next.time : this.audio.duration) - time);
    }

    getSections() {
        return this.timingPoints.map((point, i) => ({
            point,
            startTime: point.time,
            endTime: this.timingPoints[i + 1] ? this.timingPoints[i + 1].time : this.audio.duration,
        }));
    }

    currentSection(currentTime) {
        return this.getSections().find((s) => currentTime >= s.startTime && currentTime < s.endTime) || null;
    }

    *beatsInSection(section) {
        const beatDuration = 60 / section.point.bpm;
        for (let i = 1; i <= section.point.beatCount; i++) {
            const t = section.point.time + i * beatDuration;
            if (t >= section.endTime) break;
            yield { i, t };
        }
    }

    isPointMisaligned(point) {
        const index = this.timingPoints.indexOf(point);
        const prev = this.timingPoints[index - 1];
        if (!prev) return false;
        const expectedTime = prev.time + prev.beatCount * (60 / prev.bpm);
        return Math.abs(expectedTime - point.time) > 0.001;
    }

    colorForPoint(point) {
        if (point.id === this.selectedPointId) return this.pointHighlightColor;
        if (this.isPointMisaligned(point)) return this.misalignedPointColor;
        return this.timingPointColor;
    }

    // if inside a section, snap to nearest beat
    addTimingPoint(time) {
        if (!this.isReady) return null;
        const clamped = Math.max(0, Math.min(this.audio.duration, time));

        const hitRadiusPx = this.handleHitRadius;
        const tooClose = this.timingPoints.some(
            (p) => Math.abs(this.timeToX(p.time) - this.timeToX(clamped)) < hitRadiusPx
        );
        if (tooClose) return null;

        this.pushUndoSnapshot();

        const section = this.currentSection(clamped);
        if (section) {
            const nearestBeat = this.nearestBeatInSection(section, clamped);
            return nearestBeat
                ? this.splitSectionAtBeat(nearestBeat.section, nearestBeat.index)
                : this.splitSectionAtTime(section, clamped);
        }

        const bpm = 120;
        const sectionDuration = this.sectionDurationAt(clamped);
        const point = new TimingPoint({
            id: this.nextTimingPointId++,
            time: clamped,
            bpm,
            timeSignature: [4, 4],
            beatCount: Math.max(0, Math.round(sectionDuration / (60 / bpm))),
        });
        this.timingPoints.push(point);
        this.sortTimingPoints();
        this.refreshSectionInputs();
        return point;
    }

    // remove timing point and merge neighboring sections
    deleteTimingPoint(id) {
        const index = this.timingPoints.findIndex((p) => p.id === id);
        if (index === -1) return;

        this.pushUndoSnapshot();

        const deletedPoint = this.timingPoints[index];
        const prev = this.timingPoints[index - 1];
        const next = this.timingPoints[index + 1];

        if (prev) {
            if (next) {
                this.setSectionBeatCount(prev, next.time - prev.time, prev.beatCount + deletedPoint.beatCount);
            } else {
                const newDuration = Math.max(0, this.audio.duration - prev.time);
                this.setSectionBpm(prev, newDuration, prev.bpm);
            }
        }

        this.timingPoints = this.timingPoints.filter((p) => p.id !== id);
        if (this.editingPointId === id) this.closeEditPosition();
        if (this.selectedPointId === id) this.selectedPointId = null;
        if (this.hoveredPointId === id) this.hoveredPointId = null;
        this.refreshSectionInputs();
    }

    setSectionBpm(point, duration, bpm) {
        point.bpm = Math.max(1, bpm);
        point.beatCount = Math.max(0, Math.round((point.bpm * duration) / 60));
        if (point.id === this.currentSectionPointId) {
            this.sectionBpmElement.value = Math.round(point.bpm * 10000) / 10000;
            this.sectionBeatCountElement.value = String(point.beatCount);
        }
    }

    setSectionBeatCount(point, duration, beatCount) {
        point.beatCount = Math.max(0, Math.round(beatCount));
        point.bpm = duration > 0 ? Math.max(1, (point.beatCount * 60) / duration) : point.bpm;
        if (point.id === this.currentSectionPointId) {
            this.sectionBpmElement.value = Math.round(point.bpm * 10000) / 10000;
            this.sectionBeatCountElement.value = String(point.beatCount);
        }
    }

    splitSectionAtBeat(section, k) {
        const { point, startTime } = section;
        const bpm = point.bpm;
        const beatTime = startTime + k * (60 / bpm);

        const leftBeatCount = Math.max(1, k);
        const rightBeatCount = Math.max(1, point.beatCount - k);

        const newPoint = new TimingPoint({
            id: this.nextTimingPointId++,
            time: beatTime,
            bpm,
            timeSignature: [...point.timeSignature],
            beatCount: rightBeatCount,
        });

        point.beatCount = leftBeatCount;
        this.timingPoints.push(newPoint);
        this.sortTimingPoints();
        this.refreshSectionInputs();
        return newPoint;
    }

    splitSectionAtTime(section, time) {
        const { point, startTime } = section;
        const bpm = point.bpm;
        const beatDuration = 60 / bpm;
        const rawIndex = (time - startTime) / beatDuration;
        const k = Math.max(1, Math.min(point.beatCount - 1, Math.round(rawIndex)));

        const leftBeatCount = k;
        const rightBeatCount = Math.max(1, point.beatCount - k);

        const newPoint = new TimingPoint({
            id: this.nextTimingPointId++,
            time,
            bpm,
            timeSignature: [...point.timeSignature],
            beatCount: rightBeatCount,
        });

        point.beatCount = leftBeatCount;
        this.timingPoints.push(newPoint);
        this.sortTimingPoints();
        this.refreshSectionInputs();
        return newPoint;
    }

    // undo/redo

    // deep clones timing points
    snapshotTimingState() {
        return {
            timingPoints: this.timingPoints.map((p) => ({ ...p, timeSignature: [...p.timeSignature] })),
            nextTimingPointId: this.nextTimingPointId,
        };
    }

    restoreTimingState(snapshot) {
        this.timingPoints = snapshot.timingPoints.map((p) => new TimingPoint(p));
        this.nextTimingPointId = snapshot.nextTimingPointId;
        this.sortTimingPoints();

        this.pointDrag = null;
        this.hoveredBeat = null;
        if (!this.timingPoints.some((p) => p.id === this.hoveredPointId)) this.hoveredPointId = null;
        if (!this.timingPoints.some((p) => p.id === this.selectedPointId)) this.selectedPointId = null;
        if (this.editingPointId !== null && !this.timingPoints.some((p) => p.id === this.editingPointId)) {
            this.closeEditPosition();
        }
    }

    pushUndoSnapshot() {
        this.undoStack.push(this.snapshotTimingState());
        if (this.undoStack.length > this.maxUndoSteps) this.undoStack.shift();
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    undo() {
        if (this.undoStack.length === 0) return;
        this.redoStack.push(this.snapshotTimingState());
        this.restoreTimingState(this.undoStack.pop());
        this.updateUndoRedoButtons();
        this.refreshSectionInputs();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        this.undoStack.push(this.snapshotTimingState());
        this.restoreTimingState(this.redoStack.pop());
        this.updateUndoRedoButtons();
        this.refreshSectionInputs();
    }

    updateUndoRedoButtons() {
        this.undoElement.disabled = this.undoStack.length === 0;
        this.redoElement.disabled = this.redoStack.length === 0;
    }

    updateExportButton() {
        this.exportElement.disabled = !this.audio.isLoaded;
    }

    updateCanvasInteractivity() {
        this.canvas.style.pointerEvents = this.audio.isLoaded ? "" : "none";
    }

    // mouse

    clientToCanvasPx(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) * (this.drawWidth / rect.width),
            y: (clientY - rect.top) * (this.drawHeight / rect.height),
        };
    }

    isOverCanvasPreview(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    isInMarkerArea(clientX, clientY) {
        const { y } = this.clientToCanvasPx(clientX, clientY);
        return y >= 0 && y <= this.rulerHeightPx;
    }

    hitTestPointHandle(clientX, clientY) {
        if (!this.isReady) return null;
        const { x } = this.clientToCanvasPx(clientX, clientY);

        const radius = this.handleHitRadius;
        let best = null;
        let bestDist = Infinity;
        for (const point of this.timingPoints) {
            if (point.time < this.viewStart || point.time > this.viewEnd) continue;
            const dist = Math.abs(this.timeToX(point.time) - x);
            if (dist < radius && dist < bestDist) {
                best = point;
                bestDist = dist;
            }
        }
        return best;
    }

    nearestBeatAt(clientX, clientY) {
        if (!this.isReady || !this.isInMarkerArea(clientX, clientY)) return null;
        const time = this.clientXToTime(clientX);
        const section = this.currentSection(time);
        if (!section) return null;
        return this.nearestBeatInSection(section, time);
    }

    nearestBeatInSection(section, time) {
        let best = null;
        let bestDist = Infinity;
        for (const { i, t } of this.beatsInSection(section)) {
            const dist = Math.abs(t - time);
            if (dist < bestDist) {
                best = { section, index: i };
                bestDist = dist;
            }
        }
        return best;
    }

    // canvas-space x (device px) to time (seconds)
    xToTime(x) {
        if (!this.isReady) return 0;
        return this.viewStart + (x / this.drawWidth) * this.viewDuration;
    }

    timeToX(t) {
        if (!this.isReady) return 0;
        return ((t - this.viewStart) / this.viewDuration) * this.drawWidth;
    }

    clientXToTime(x) {
        const rect = this.canvas.getBoundingClientRect();
        const xCss = x - rect.left;
        return this.xToTime(xCss * (this.drawWidth / rect.width));
    }

    timeToClientX(t) {
        const rect = this.canvas.getBoundingClientRect();
        return rect.left + (this.timeToX(t) / this.drawWidth) * rect.width;
    }

    // export

    async exportTimingPoints() {
        if (!this.audio.isLoaded) return;

        if (this.importedArchive) {
            await this.exportRtmArchive();
        } else {
            this.exportJson();
        }
    }

    buildExportData() {
        return this.timingPoints.map((point) => ({
            id: point.id,
            time: Math.round(point.time * 1000),
            bpm: point.bpm,
            timeSignature: [...point.timeSignature],
        }));
    }

    exportJson() {
        const json = JSON.stringify(this.buildExportData(), null, 2);
        const baseName = (this.audio.fileName || "timing-points").replace(/\.[^./\\]+$/, "");
        this.downloadBlob(new Blob([json], { type: "application/json" }), `${baseName}.json`);
    }

    buildRtmTimingPoints() {
        return this.timingPoints.map((point) => ({
            id: point.id,
            time: point.time,
            bpm: point.bpm,
            timeSignature: [...point.timeSignature],
        }));
    }

    averageBpm() {
        const sections = this.getSections();
        if (sections.length === 0) return null;
        return sections.reduce((sum, s) => sum + s.point.bpm, 0) / sections.length;
    }

    async exportRtmArchive() {
        const { zip, meta, originalFileName } = this.importedArchive;
        const averageBpm = this.averageBpm();
        const updatedMeta = {
            ...meta,
            timingPoints: this.buildRtmTimingPoints(),
            ...(averageBpm !== null ? { bpm: averageBpm } : {}),
        };
        zip.file("meta.json", JSON.stringify(updatedMeta, null, 2));
        const blob = await zip.generateAsync({ type: "blob" });
        this.downloadBlob(blob, originalFileName);
    }

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // timing point overlays

    createTimingOverlayElements() {
        this.editPositionInputEl = document.createElement("input");
        this.editPositionInputEl.type = "text";
        this.editPositionInputEl.size = 8;
        Object.assign(this.editPositionInputEl.style, { position: "fixed", zIndex: "1", display: "none" });
        document.body.appendChild(this.editPositionInputEl);

        this.editPositionInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.editPositionInputEl.blur();
            } else if (e.key === "Escape") {
                this.closeEditPosition();
            }
        });
        this.editPositionInputEl.addEventListener("change", () => this.commitEditPosition());
    }

    destroyTimingOverlayElements() {
        this.editPositionInputEl.remove();
    }

    setHoveredTimingPoint(id) {
        this.hoveredPointId = id;
    }

    openEditPosition(pointId) {
        const point = this.timingPoints.find((p) => p.id === pointId);
        if (!point) return;
        this.editingPointId = pointId;
        this.editPositionInputEl.value = this.formatTimestamp(point.time);
        this.editPositionInputEl.style.display = "";
        this.editPositionInputEl.focus();
        this.editPositionInputEl.select();
    }

    closeEditPosition() {
        this.editingPointId = null;
        this.editPositionInputEl.style.display = "none";
    }

    commitEditPosition() {
        const point = this.timingPoints.find((p) => p.id === this.editingPointId);
        if (point) {
            this.pushUndoSnapshot();
            point.time = Math.max(0, Math.min(this.audio.duration, this.parseTimestamp(this.editPositionInputEl.value)));
            this.sortTimingPoints();
        }
        this.closeEditPosition();
    }

    updateOverlayPositions() {
        this.positionOverlay(this.editPositionInputEl, this.editingPointId);
    }

    positionOverlay(el, activePointId) {
        if (activePointId === null) {
            el.style.display = "none";
            return;
        }
        const point = this.timingPoints.find((p) => p.id === activePointId);
        if (!point) {
            el.style.display = "none";
            return;
        }
        const rect = this.canvas.getBoundingClientRect();
        const x = this.timeToClientX(point.time);
        if (x < rect.left || x > rect.right) {
            el.style.display = "none";
            return;
        }
        el.style.display = "";
        el.style.left = `${x}px`;
        el.style.top = `${rect.top + this.rulerHeight + 4}px`;
        el.style.transform = "translateX(-50%)";
    }

    // section header inputs

    isSectionInputFocused() {
        const el = document.activeElement;
        return (
            el === this.sectionBpmElement ||
            el === this.sectionTimeSignatureNumeratorElement ||
            el === this.sectionTimeSignatureDenominatorElement ||
            el === this.sectionBeatCountElement
        );
    }

    refreshSectionInputs() {
        if (this.isSectionInputFocused()) return;

        const currentTime = this.audio.isLoaded ? this.audio.getCurrentTime() : 0;
        const section = this.isReady ? this.currentSection(currentTime) : null;
        this.currentSectionPointId = section ? section.point.id : null;

        const fields = [
            [this.sectionBpmElement, section ? Math.round(section.point.bpm * 10000) / 10000 : ""],
            [this.sectionTimeSignatureNumeratorElement, section ? String(section.point.timeSignature[0]) : ""],
            [this.sectionTimeSignatureDenominatorElement, section ? String(section.point.timeSignature[1]) : ""],
            [this.sectionBeatCountElement, section ? String(section.point.beatCount) : ""],
        ];
        for (const [el, value] of fields) {
            el.disabled = !section;
            el.value = value;
        }
    }

    handleSectionFieldChange(field, rawValue) {
        if (this.currentSectionPointId === null) return;
        const section = this.getSections().find((s) => s.point.id === this.currentSectionPointId);
        if (!section) return;

        const value = Number(rawValue);
        if (!isFinite(value)) return;
        const duration = section.endTime - section.startTime;

        this.pushUndoSnapshot();
        if (field === "bpm") this.setSectionBpm(section.point, duration, value);
        else if (field === "beatCount") this.setSectionBeatCount(section.point, duration, value);
        else if (field === "timeSignatureNumerator") {
            section.point.timeSignature = [Math.max(1, Math.round(value)), section.point.timeSignature[1]];
            this.refreshSectionInputs();
        } else if (field === "timeSignatureDenominator") {
            section.point.timeSignature = [section.point.timeSignature[0], Math.max(1, Math.round(value))];
            this.refreshSectionInputs();
        }
    }

    bindSectionField(el, field) {
        const unbindChange = this.on(el, "change", () => this.handleSectionFieldChange(field, el.value));
        const unbindKeyDown = this.on(el, "keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                el.blur();
            }
        });
        return () => {
            unbindChange();
            unbindKeyDown();
        };
    }

    // metronome

    async loadMetronomeSounds() {
        try {
            const [tick, accent] = await Promise.all([
                this.loadMetronomeBuffer("assets/metronome/tick.wav"),
                this.loadMetronomeBuffer("assets/metronome/accent.wav"),
            ]);
            this.metronomeBuffers.tick = tick;
            this.metronomeBuffers.accent = accent;
        } catch (err) {
            console.warn("Failed to load metronome sounds:", err);
        }
    }

    async loadMetronomeBuffer(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        return this.audio.audioContext.decodeAudioData(arrayBuffer);
    }

    playMetronomeSound(buffer) {
        if (!buffer) return;
        const ctx = this.audio.audioContext;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.metronomeGainNode);
        source.start(0);
    }

    updateMetronome(currentTime) {
        if (
            this.metronomeLastTime === null ||
            currentTime <= this.metronomeLastTime ||
            currentTime - this.metronomeLastTime > 1
        ) {
            this.metronomeLastTime = currentTime;
            return;
        }

        const windowStart = this.metronomeLastTime;
        for (const section of this.getSections()) {
            const { point } = section;
            // i=0 is the timing point itself
            const beats = [{ i: 0, t: point.time }, ...this.beatsInSection(section)];
            for (const { i, t } of beats) {
                if (t > windowStart && t <= currentTime) {
                    const isAccent = i % point.timeSignature[0] === 0;
                    this.playMetronomeSound(isAccent ? this.metronomeBuffers.accent : this.metronomeBuffers.tick);
                }
            }
        }

        this.metronomeLastTime = currentTime;
    }

    // input

    // adds a listener on target and returns an unbind function
    on(target, event, handler, options) {
        target.addEventListener(event, handler, options);
        return () => target.removeEventListener(event, handler, options);
    }

    bindEvents() {
        const endDrags = () => {
            this.endDragPan();
            this.endPointDrag();
        };

        this.unbindFns = [
            this.on(window, "resize", () => this.resize()),
            this.on(this.canvas, "wheel", (e) => this.handleWheel(e), { passive: false }),
            this.on(this.canvas, "mousedown", (e) => this.handleMouseDown(e)),
            this.on(this.canvas, "contextmenu", (e) => this.handleContextMenu(e)),
            this.on(document, "mousemove", (e) => this.handleMouseMove(e)),
            this.on(document, "mouseup", endDrags),
            this.on(window, "blur", endDrags),
            this.on(document, "keydown", (e) => this.handleKeyDown(e)),

            this.on(this.timestampElement, "change", () => this.handleTimestampChange()),
            this.on(this.timestampElement, "keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    this.timestampElement.blur();
                }
            }),
            // pause while editing
            this.on(this.timestampElement, "focus", () => {
                if (this.audio.isPlaying) this.audio.pause();
            }),

            this.on(this.playPauseElement, "click", () => this.togglePlayPause()),
            this.on(this.followPlayheadElement, "change", () => {
                this.followPlayheadEnabled = this.followPlayheadElement.checked;
            }),
            this.on(this.metronomeVolumeElement, "input", () => {
                this.metronomeVolume = Number(this.metronomeVolumeElement.value);
            }),

            this.bindSectionField(this.sectionBpmElement, "bpm"),
            this.bindSectionField(this.sectionTimeSignatureNumeratorElement, "timeSignatureNumerator"),
            this.bindSectionField(this.sectionTimeSignatureDenominatorElement, "timeSignatureDenominator"),
            this.bindSectionField(this.sectionBeatCountElement, "beatCount"),

            this.on(this.undoElement, "click", () => this.undo()),
            this.on(this.redoElement, "click", () => this.redo()),
        ];
    }

    unbindEvents() {
        (this.unbindFns || []).forEach((unbind) => unbind());
        this.unbindFns = [];
    }

    handleWheel(e) {
        if (!this.isReady) return;
        e.preventDefault();

        const pivot = this.clientXToTime(e.clientX);

        if (e.ctrlKey || e.metaKey) {
            const isLikelyTrackpad = Math.abs(e.deltaY) < this.trackpadDeltaThreshold;
            const sensitivity = isLikelyTrackpad ? this.trackpadZoomSensitivity : this.zoomWheelSensitivity;
            const factor = Math.exp(-e.deltaY * sensitivity);
            this.zoomBy(factor, pivot);
        } else {
            const rect = this.canvas.getBoundingClientRect();
            const pxDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            const secondsPerCssPixel = this.viewDuration / rect.width;
            this.scrollBy(pxDelta * secondsPerCssPixel * this.panWheelSensitivity);
        }
    }

    handleMouseDown(e) {
        if (!this.isReady) return;
        if (!this.isOverCanvasPreview(e.clientX, e.clientY)) return;

        if (e.button === 0) {
            const blocked = this.isTimingBlocked();
            const inMarkerArea = !blocked && this.isInMarkerArea(e.clientX, e.clientY);

            // points are grabbable from anywhere along its line
            const pointHit = blocked ? null : this.hitTestPointHandle(e.clientX, e.clientY);
            if (pointHit) {
                this.selectedPointId = pointHit.id;
                this.pointDrag = { pointId: pointHit.id, snapshotTaken: false };
                this.canvas.style.cursor = "ew-resize";
                return;
            }

            if (inMarkerArea) {
                const beatHit = this.nearestBeatAt(e.clientX, e.clientY);
                if (beatHit) {
                    this.pushUndoSnapshot();
                    const newPoint = this.splitSectionAtBeat(beatHit.section, beatHit.index);
                    this.selectedPointId = newPoint.id;
                    this.pointDrag = { pointId: newPoint.id, snapshotTaken: true };
                    this.canvas.style.cursor = "ew-resize";
                    return;
                }

                // no beat to snap to here -- default placement
                const newPoint = this.addTimingPoint(this.clientXToTime(e.clientX));
                if (newPoint) {
                    this.selectedPointId = newPoint.id;
                    this.pointDrag = { pointId: newPoint.id, snapshotTaken: true };
                    this.canvas.style.cursor = "ew-resize";
                    this.updatePointDrag(e.clientX);
                }
                return;
            }

            this.selectedPointId = null;
            this.audio.seek(this.clientXToTime(e.clientX));
            return;
        }

        if (e.button === 1) {
            e.preventDefault();
            this.dragPan = { startClientX: e.clientX, startViewStart: this.viewStart };
            this.canvas.style.cursor = "grabbing";
        }
    }

    handleMouseMove(e) {
        this.mouse = { x: e.clientX, y: e.clientY };

        if (this.pointDrag) {
            this.updatePointDrag(e.clientX);
            return;
        }

        if (this.dragPan) {
            const rect = this.canvas.getBoundingClientRect();
            const secondsPerCssPixel = this.viewDuration / rect.width;
            const cssDeltaX = e.clientX - this.dragPan.startClientX;
            this.scrollBy(this.dragPan.startViewStart - cssDeltaX * secondsPerCssPixel - this.viewStart);
            return;
        }

        if (this.isTimingBlocked()) {
            this.setHoveredTimingPoint(null);
            this.hoveredBeat = null;
            this.canvas.style.cursor = "";
            return;
        }

        const pointHit = this.hitTestPointHandle(e.clientX, e.clientY);
        this.setHoveredTimingPoint(pointHit ? pointHit.id : null);

        const beatHit = pointHit ? null : this.nearestBeatAt(e.clientX, e.clientY);
        this.hoveredBeat = beatHit ? { pointId: beatHit.section.point.id, index: beatHit.index } : null;

        const anyHover = this.hoveredPointId !== null || this.hoveredBeat !== null;
        if (anyHover) {
            this.canvas.style.cursor = "ew-resize";
        } else if (this.isInMarkerArea(e.clientX, e.clientY)) {
            this.canvas.style.cursor = "copy";
        } else {
            this.canvas.style.cursor = "";
        }
    }

    endDragPan() {
        if (!this.dragPan) return;
        this.dragPan = null;
        this.canvas.style.cursor = "";
    }

    // preserve beatCount and recalculate bpm for sections around the point so it always lines up with a beat in either neighbor
    updatePointDrag(clientX) {
        const point = this.timingPoints.find((p) => p.id === this.pointDrag.pointId);
        if (!point) {
            this.endPointDrag();
            return;
        }

        const index = this.timingPoints.indexOf(point);
        const prev = this.timingPoints[index - 1];
        const next = this.timingPoints[index + 1];
        const epsilon = 0.001; // seconds - keeps points from crossing/colliding mid-drag
        const lowerBound = prev ? prev.time + epsilon : 0;
        const upperBound = next ? next.time - epsilon : this.audio.duration;

        const proposedTime = this.clientXToTime(clientX);
        const newTime = Math.max(lowerBound, Math.min(upperBound, proposedTime));
        if (newTime === point.time) return;

        if (!this.pointDrag.snapshotTaken) {
            this.pushUndoSnapshot();
            this.pointDrag.snapshotTaken = true;
        }
        point.time = newTime;

        const sections = this.getSections();
        const endingHere = prev ? sections.find((s) => s.point.id === prev.id) : null;
        const startingHere = sections.find((s) => s.point.id === point.id);

        for (const section of [endingHere, startingHere]) {
            if (!section) continue;
            const duration = section.endTime - section.startTime;
            if (duration <= 0) continue;
            this.setSectionBeatCount(section.point, duration, section.point.beatCount);
        }
    }

    endPointDrag() {
        if (!this.pointDrag) return;
        this.pointDrag = null;
        this.canvas.style.cursor = "";
    }

    handleContextMenu(e) {
        e.preventDefault();
    }

    isEditableTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }

    handleKeyDown(e) {
        if (this.isEditableTarget(e.target)) return;

        switch (e.code) {
            case "Space":
                e.preventDefault();
                this.togglePlayPause();
                break;
            case "ArrowLeft":
                this.scrollBy(-this.viewDuration * this.keyboardScrollFraction * (e.shiftKey ? 4 : 1));
                break;
            case "ArrowRight":
                this.scrollBy(this.viewDuration * this.keyboardScrollFraction * (e.shiftKey ? 4 : 1));
                break;
            case "Equal":
            case "NumpadAdd":
                this.zoomIn(this.audio.isLoaded ? this.audio.getCurrentTime() : null);
                break;
            case "Minus":
            case "NumpadSubtract":
                this.zoomOut(this.audio.isLoaded ? this.audio.getCurrentTime() : null);
                break;
            case "Digit0":
            case "Numpad0":
                this.resetView();
                break;
            case "Delete":
            case "Backspace":
                if (this.selectedPointId !== null && !this.isTimingBlocked()) {
                    e.preventDefault();
                    this.deleteTimingPoint(this.selectedPointId);
                }
                break;
            case "Enter":
                if (this.selectedPointId !== null && !this.isTimingBlocked()) {
                    e.preventDefault();
                    this.openEditPosition(this.selectedPointId);
                }
                break;
            case "KeyZ":
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    if (e.shiftKey) this.redo();
                    else this.undo();
                }
                break;
            case "KeyY":
                if (e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    this.redo();
                }
                break;
        }
    }

    // time

    togglePlayPause() {
        if (!this.audio.isLoaded) return;
        if (this.audio.isPlaying) this.audio.pause();
        else this.audio.play();
    }

    updatePlayPauseButton() {
        this.setElementText(this.playPauseElement, this.audio.isPlaying ? "⏸" : "▶");
    }

    setElementText(el, text) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") el.value = text;
        else el.textContent = text;
    }

    // format seconds as MM:SS:mmm
    formatTimestamp(t) {
        const totalMs = Math.max(0, Math.round(t * 1000));
        const minutes = Math.floor(totalMs / 60000);
        const seconds = Math.floor((totalMs % 60000) / 1000);
        const ms = totalMs % 1000;
        return `${minutes}:${String(seconds).padStart(2, "0")}:${String(ms).padStart(3, "0")}`;
    }

    updateTimestamp(currentTime = null) {
        if (document.activeElement === this.timestampElement) return;
        const t = currentTime !== null ? currentTime : (this.audio.isLoaded ? this.audio.getCurrentTime() : 0);
        this.setElementText(this.timestampElement, this.formatTimestamp(t));
    }

    // accepts MM:SS:mmm, SS:mmm, or just milliseconds as an integer
    parseTimestamp(text) {
        if (typeof text !== "string") return 0;
        const trimmed = text.trim();

        if (/^\d+$/.test(trimmed)) {
            return parseInt(trimmed, 10) / 1000;
        }

        const parts = trimmed.split(":");
        if (parts.length === 2) {
            const [secondsStr, msStr] = parts;
            if (!/^\d+$/.test(secondsStr) || !/^\d+$/.test(msStr)) return 0;
            const ms = parseInt(msStr, 10);
            if (ms >= 1000) return 0;
            return parseInt(secondsStr, 10) + ms / 1000;
        }

        if (parts.length === 3) {
            const [minutesStr, secondsStr, msStr] = parts;
            if (!/^\d+$/.test(minutesStr) || !/^\d+$/.test(secondsStr) || !/^\d+$/.test(msStr)) return 0;
            const seconds = parseInt(secondsStr, 10);
            const ms = parseInt(msStr, 10);
            if (seconds >= 60 || ms >= 1000) return 0;
            return parseInt(minutesStr, 10) * 60 + seconds + ms / 1000;
        }

        return 0;
    }

    handleTimestampChange() {
        this.audio.seek(this.parseTimestamp(this.timestampElement.value));
        this.updateTimestamp();
    }

    // rendering

    draw() {
        const { ctx } = this;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.drawWidth, this.drawHeight);

        // sampled once and reused
        const currentTime = this.audio.isLoaded ? this.audio.getCurrentTime() : 0;

        this.updateTimestamp(currentTime);
        this.updatePlayPauseButton();

        const trackedSection = this.isReady ? this.currentSection(currentTime) : null;
        if ((trackedSection ? trackedSection.point.id : null) !== this.currentSectionPointId) {
            this.refreshSectionInputs();
        }

        if (this.isReady) {
            if (this.followPlayheadEnabled && this.audio.isPlaying) {
                this.followPlayhead(currentTime);
            }

            if (this.audio.isPlaying) {
                this.updateMetronome(currentTime);
            } else {
                this.metronomeLastTime = null;
            }

            const contentY = this.rulerHeightPx;
            const contentHeight = this.drawHeight - contentY;
            const sliceOptions = {
                width: this.drawWidth,
                height: contentHeight,
                y: contentY,
                startTime: this.viewStart,
                endTime: this.viewEnd,
            };

            if (this.drawMode === "waveform") {
                this.audio.drawWaveform(ctx, { ...sliceOptions, color: this.waveformColor });
            } else {
                const wasLoading = this.audio.isSpectrogramLoading;
                this.audio.drawSpectrogram(ctx, sliceOptions);
                if (!wasLoading && this.audio.isSpectrogramLoading) this.resetView();
            }

            if (!this.isTimingBlocked()) {
                this.drawBeatLines(ctx, contentY, contentHeight);
                this.drawTicks(ctx);
            }

            const playheadX = this.timeToX(currentTime);
            ctx.save();
            ctx.strokeStyle = this.playheadColor;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(playheadX, 0);
            ctx.lineTo(playheadX, this.drawHeight);
            ctx.stroke();
            ctx.restore();
        }

        if (this.mouse && !this.isTimingBlocked() && this.isInMarkerArea(this.mouse.x, this.mouse.y)) {
            const { x } = this.clientToCanvasPx(this.mouse.x, this.mouse.y);
            ctx.save();
            ctx.strokeStyle = this.cursorColor;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.drawHeight);
            ctx.stroke();
            ctx.restore();
        }

        this.updateOverlayPositions();
    }

    drawBeatLines(ctx, y, height) {
        if (this.timingPoints.length === 0) return;

        ctx.save();

        ctx.lineWidth = 2;
        for (const point of this.timingPoints) {
            if (point.time < this.viewStart || point.time > this.viewEnd) continue;
            ctx.strokeStyle = this.colorForPoint(point);
            const x = this.timeToX(point.time);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + height);
            ctx.stroke();
        }

        ctx.lineWidth = 1;
        for (const section of this.getSections()) {
            if (section.endTime < this.viewStart || section.startTime > this.viewEnd) continue;
            for (const { i, t } of this.beatsInSection(section)) {
                if (t < this.viewStart || t > this.viewEnd) continue;
                const isBarLine = i % section.point.timeSignature[0] === 0;
                ctx.strokeStyle = isBarLine ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.3)";
                ctx.lineWidth = isBarLine ? 2 : 1;
                const x = this.timeToX(t);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + height);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    drawTicks(ctx) {
        const h = this.rulerHeightPx;

        ctx.save();

        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(0, 0, this.drawWidth, h);
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(this.drawWidth, h);
        ctx.stroke();

        const triHalfWidth = 5;
        for (const point of this.timingPoints) {
            if (point.time < this.viewStart || point.time > this.viewEnd) continue;
            const x = this.timeToX(point.time);
            ctx.fillStyle = this.colorForPoint(point);
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x - triHalfWidth, 0);
            ctx.lineTo(x + triHalfWidth, 0);
            ctx.closePath();
            ctx.fill();
        }

        const accentBeatMarkerHeight = h;
        const beatMarkerHeight = Math.min(6, h);
        for (const section of this.getSections()) {
            if (section.endTime < this.viewStart || section.startTime > this.viewEnd) continue;
            for (const { i, t } of this.beatsInSection(section)) {
                if (t < this.viewStart || t > this.viewEnd) continue;
                const isHovered = this.hoveredBeat?.pointId === section.point.id && this.hoveredBeat?.index === i;
                const x = this.timeToX(t);
                ctx.fillStyle = isHovered ? this.timingPointColor : this.pointColor;
                const height = i % section.point.timeSignature[0] === 0 ? accentBeatMarkerHeight : beatMarkerHeight;
                ctx.fillRect(x - 1.5, h - height, 3, height);
            }
        }

        ctx.restore();
    }
}