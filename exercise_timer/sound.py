"""Short beep cues on a background thread. Never raises into the timer."""
import queue
import threading

CUES = {
    "hold_start": [(880, 120)],
    "hold_end": [(587, 220)],
    "complete": [(659, 160), (784, 160), (1047, 360)],
}


def _winsound_beep(freq, ms):
    import winsound
    winsound.Beep(freq, ms)


class Sound:
    def __init__(self, beep=_winsound_beep, enabled=True):
        self.enabled = enabled
        self._beep = beep
        self._queue = queue.Queue()
        self._generation = 0
        self._thread = None

    def play(self, cue):
        if not self.enabled or cue not in CUES:
            return
        try:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()
            self._queue.put((self._generation, cue))
        except Exception:
            pass

    def cancel(self):
        """Drop queued cues (call on stop/reset). A tone already sounding
        finishes; it is at most a third of a second."""
        self._generation += 1
        try:
            while True:
                self._queue.get_nowait()
        except queue.Empty:
            pass

    def close(self):
        self.cancel()
        self._queue.put((self._generation, None))

    def _run(self):
        while True:
            generation, cue = self._queue.get()
            if cue is None:
                return
            for freq, ms in CUES[cue]:
                if generation != self._generation:
                    break
                try:
                    self._beep(freq, ms)
                except Exception:
                    pass   # no audio device, wrong platform, etc.
