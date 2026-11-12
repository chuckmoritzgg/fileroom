/**
 * Sound level meter for the baby station. Runs on the audio thread, so it keeps working when the
 * page is in the background and its timers are throttled. Posts the level ten times per second.
 * A 150 Hz high-pass keeps rumble (traffic, fans, handling noise) out of the measurement.
 */
class FileRoomLevel extends AudioWorkletProcessor {
    constructor() {
        super();
        this.window = Math.round(sampleRate * 0.1);
        this.alpha = 1 / (1 + (2 * Math.PI * 150) / sampleRate);
        this.prevIn = 0;
        this.prevOut = 0;
        this.sum = 0;
        this.peak = 0;
        this.count = 0;
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) {
            let { prevIn, prevOut, sum, peak } = this;
            const alpha = this.alpha;
            for (let i = 0; i < channel.length; i++) {
                const x = channel[i];
                const y = alpha * (prevOut + x - prevIn);
                prevIn = x;
                prevOut = y;
                sum += y * y;
                const a = y < 0 ? -y : y;
                if (a > peak) peak = a;
            }
            this.prevIn = prevIn; this.prevOut = prevOut; this.sum = sum; this.peak = peak;
            this.count += channel.length;
        } else {
            this.count += 128; // no input connected: silence
        }
        if (this.count >= this.window) {
            this.port.postMessage({ db: 10 * Math.log10(this.sum / this.count + 1e-10), peak: this.peak });
            this.sum = 0;
            this.peak = 0;
            this.count = 0;
        }
        return true;
    }
}

registerProcessor('fileroom-level', FileRoomLevel);
