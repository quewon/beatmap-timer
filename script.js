const canvas = document.querySelector("canvas");
const editor = new Editor(canvas, {
    timestampElement: timestamp,
    playPauseElement: playpause,
    exportElement: document.getElementById("export"),
    followPlayheadElement: followplayhead,
    metronomeVolumeElement: metronomevolume,
    sectionBpmElement: sectionbpm,
    sectionTimeSignatureNumeratorElement: sectiontimesignum,
    sectionTimeSignatureDenominatorElement: sectiontimesigden,
    sectionBeatCountElement: sectionbeatcount,
    undoElement: undo,
    redoElement: redo,
});

fileinput.addEventListener("change", async (e) => {
    await editor.loadFile(e.target.files[0]);
    fileinput.blur();
});

viewselect.addEventListener("change", function () {
    editor.drawMode = this.value;
});

document.getElementById("stop").addEventListener("click", () => editor.audio.stop());
document.getElementById("export").addEventListener("click", () => editor.exportTimingPoints());
document.getElementById("help").addEventListener("click", () => helpdialog.showModal());

editor.start();
