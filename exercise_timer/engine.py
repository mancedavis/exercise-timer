"""Timing logic for Exercise Timer. No tkinter here: the clock is injected so
tests can drive it without waiting."""
import math
import time
from dataclasses import dataclass, asdict

IDLE, GET_READY, HOLD, REP_BREAK, SET_REST, COMPLETE = (
    "idle", "get_ready", "hold", "rep_break", "set_rest", "complete")
ACTIVE = (GET_READY, HOLD, REP_BREAK, SET_REST)

# If the engine is not updated for longer than this while running (computer
# sleep, a frozen UI), it pauses itself at the last good time and waits for
# Resume instead of crediting or skipping the gap.
GAP_LIMIT = 2.0

MAX_NAME = 80        # exercise and preset names
MAX_COUNT = 9999     # sets, reps
MAX_SECONDS = 86400  # every duration

LABELS = {IDLE: "READY", GET_READY: "GET READY", HOLD: "HOLD",
          REP_BREAK: "REP BREAK", SET_REST: "SET REST", COMPLETE: "COMPLETE"}


@dataclass(frozen=True)
class Settings:
    name: str = "Exercise"
    sets_enabled: bool = True
    sets: int = 3
    reps_enabled: bool = True
    reps: int = 10
    hold_enabled: bool = True
    hold: int = 10
    rep_break: int = 5
    rest_enabled: bool = False
    rest: int = 30
    get_ready: int = 5

    @property
    def total_sets(self):
        return self.sets if self.sets_enabled else 1

    @property
    def rest_seconds(self):
        """Rest between sets; 0 means none (also when there is only one set)."""
        return self.rest if self.rest_enabled and self.total_sets > 1 else 0

    def to_dict(self):
        return asdict(self)


_FIELDS = (  # key, label, minimum, toggle key (or None), default
    ("sets", "Sets", 1, "sets_enabled", 3),
    ("reps", "Reps per set", 1, "reps_enabled", 10),
    ("hold", "Hold seconds", 1, "hold_enabled", 10),
    ("rep_break", "Rep break", 0, None, 5),
    ("rest", "Set rest", 0, "rest_enabled", 30),
    ("get_ready", "Get-ready", 0, None, 5),
)


def parse_settings(raw):
    """Build Settings from raw UI/JSON values (numbers may be strings).

    Raises ValueError with a short message. Fields whose enable flag is off
    are never validated; they fall back to the default if unreadable."""
    name = str(raw.get("name", "")).strip() or "Exercise"
    if len(name) > MAX_NAME:
        raise ValueError(f"Name must be {MAX_NAME} characters or fewer.")
    values = {"name": name}
    for key, label, minimum, toggle, default in _FIELDS:
        enabled = True if toggle is None else raw.get(toggle, False)
        if not isinstance(enabled, bool):
            raise ValueError(f"{label}: enable flag must be true or false.")
        if toggle:
            values[toggle] = enabled
        text = raw.get(key, default)
        maximum = MAX_COUNT if key in ("sets", "reps") else MAX_SECONDS
        try:
            if isinstance(text, bool) or isinstance(text, float):
                raise ValueError
            digits = str(text).strip()
            if not (digits.isascii() and digits.isdigit()):   # no "+5", "1_000", "-1", "٣"
                raise ValueError
            number = int(digits)
            if not minimum <= number <= maximum:
                raise ValueError
        except ValueError:
            if enabled:
                raise ValueError(
                    f"{label} must be a whole number, {minimum} to {maximum}.") from None
            number = default
        values[key] = number
    return Settings(**values)


@dataclass(frozen=True)
class Display:
    name: str
    phase_key: str          # drives colour; text label below is the real cue
    phase_label: str
    set_text: str
    rep_text: str
    rep_total_text: str
    rep_caption: str
    timer_text: str
    timer_suffix: str
    banner: str


class Engine:
    def __init__(self, settings, clock=time.monotonic):
        self.s = settings
        self.clock = clock
        self._events = []
        self._reset()

    # ----- state ---------------------------------------------------------
    def _reset(self):
        self.phase = IDLE
        self.paused = False
        self.auto_paused = False
        self.set_no = 1
        self.rep_no = 0       # reps started in the current set
        self.reps_done = 0    # reps completed in the current set
        self._t0 = 0.0        # clock time the current phase began
        self._frozen = 0.0    # phase elapsed while paused
        self._last = 0.0      # clock time of the last update

    @property
    def active(self):
        return self.phase in ACTIVE

    @property
    def can_finish_rep(self):
        return self.phase == HOLD and not self.s.hold_enabled and not self.paused

    @property
    def can_end_set(self):
        return (self.phase in (HOLD, REP_BREAK) and not self.s.reps_enabled
                and not self.paused)

    def pop_events(self):
        events, self._events = self._events, []
        return events

    def _duration(self):
        s = self.s
        return {GET_READY: s.get_ready, REP_BREAK: s.rep_break,
                SET_REST: s.rest_seconds,
                HOLD: s.hold if s.hold_enabled else None}.get(self.phase)

    @property
    def elapsed(self):
        """Seconds spent in the current phase (frozen while paused)."""
        if not self.active:
            return 0.0
        return self._frozen if self.paused else max(0.0, self.clock() - self._t0)

    @property
    def remaining(self):
        d = self._duration()
        return None if d is None else max(0.0, d - self.elapsed)

    # ----- commands ------------------------------------------------------
    def start(self):
        if self.active:
            return False
        self._reset()
        self._events.clear()
        now = self._last = self.clock()
        if self.s.get_ready > 0:
            self.phase, self._t0 = GET_READY, now
        else:
            self._begin_hold(now)
        return True

    def stop(self):
        """Cancel the run and restore the starting counters."""
        self._reset()
        self._events.clear()

    def pause(self):
        self.update()
        if self.active and not self.paused:
            self._freeze(self.clock())

    def resume(self):
        if self.active and self.paused:
            now = self.clock()
            self._t0 = now - self._frozen
            self._last = now
            self.paused = self.auto_paused = False

    def finish_rep(self):
        self.update()
        if self.can_finish_rep:
            self._finish_rep(self.clock())
            return True
        return False

    def end_set(self):
        self.update()
        if self.can_end_set:
            now = self.clock()
            if self.phase == HOLD:       # the unfinished rep is not counted
                self._events.append("hold_end")
            self._set_done(now)
            return True
        return False

    def update(self):
        """Apply elapsed time. Call often; at most one phase change per call
        (plus skipped zero-length phases), and each new phase starts "now" so
        a late call never shortens what follows."""
        now = self.clock()
        if not self.active or self.paused:
            self._last = now
            return
        if now - self._last > GAP_LIMIT:
            self._freeze(self._last)
            self.auto_paused = True
            return
        self._last = now
        d = self._duration()
        if d is not None and now - self._t0 >= d:
            self._advance(now)

    # ----- transitions ---------------------------------------------------
    def _freeze(self, at):
        self._frozen = max(0.0, at - self._t0)
        self.paused = True

    def _advance(self, now):
        if self.phase == HOLD:
            self._finish_rep(now)
        elif self.phase == SET_REST:
            self._next_set(now)
        else:  # GET_READY or REP_BREAK
            self._begin_hold(now)

    def _begin_hold(self, now):
        self.rep_no += 1
        self.phase, self._t0 = HOLD, now
        self._events.append("hold_start")

    def _finish_rep(self, now):
        self._events.append("hold_end")
        self.reps_done = self.rep_no
        if self.s.reps_enabled and self.reps_done >= self.s.reps:
            self._set_done(now)
        elif self.s.rep_break > 0:
            self.phase, self._t0 = REP_BREAK, now
        else:
            self._begin_hold(now)

    def _set_done(self, now):
        if self.set_no >= self.s.total_sets:
            self.phase = COMPLETE
            self._events.append("complete")
        elif self.s.rest_seconds > 0:
            self.phase, self._t0 = SET_REST, now
        else:
            self._next_set(now)

    def _next_set(self, now):
        self.set_no += 1
        self.rep_no = self.reps_done = 0
        self._begin_hold(now)

    # ----- what to show --------------------------------------------------
    def display(self):
        s, ph = self.s, self.phase
        n_sets = s.total_sets
        rest_like = ph in (SET_REST, COMPLETE)
        if s.sets_enabled:
            set_text = (f"SET {self.set_no} of {n_sets} DONE" if rest_like
                        else f"SET {self.set_no} of {n_sets}")
        else:
            set_text = ""
        if ph == HOLD:
            rep = self.rep_no
        elif ph == REP_BREAK or rest_like:
            rep = self.reps_done
        else:
            rep = 0
        caption = ""
        if ph == REP_BREAK or rest_like:
            caption = f"REP {rep} COMPLETED" if rep else "SET ENDED"

        suffix = "s left"
        if ph == COMPLETE:
            timer, suffix = "Exercise complete", ""
        elif ph == IDLE:
            timer, suffix = "0", (f"/ {s.hold} s" if s.hold_enabled else "s")
        elif ph == HOLD:
            suffix = f"/ {s.hold} s" if s.hold_enabled else "s"
            e = math.floor(self.elapsed + 1e-9)
            timer = str(min(e, s.hold) if s.hold_enabled else e)
        else:
            timer = str(math.ceil(self.remaining - 1e-9))

        hint = ""
        if not s.reps_enabled and ph in (HOLD, REP_BREAK):
            hint = "End Set (E) finishes this set"
        if ph == IDLE:
            banner = "Press Start (Space)"
        elif ph == GET_READY:
            banner = "REP 1 starts when this reaches 0"
        elif ph == HOLD:
            banner = " · ".join(t for t in (
                "" if s.hold_enabled else "Finish Rep (N) when done", hint) if t)
        elif ph == REP_BREAK:
            banner = " · ".join(t for t in (f"NEXT: REP {rep + 1}", hint) if t)
        elif ph == SET_REST:
            banner = f"NEXT: SET {self.set_no + 1}, REP 1"
        else:
            banner = "Press Start (Space) to run again"

        key, label = ph, LABELS[ph]
        if self.paused:
            key, label = "paused", "PAUSED"
            banner = ("Paused automatically after a long delay. Press Resume (Space)"
                      if self.auto_paused else
                      f"{LABELS[ph]} paused. Press Resume (Space)")
        return Display(
            name=s.name, phase_key=key, phase_label=label, set_text=set_text,
            rep_text=str(rep), rep_total_text=f"of {s.reps}" if s.reps_enabled else "",
            rep_caption=caption, timer_text=timer, timer_suffix=suffix, banner=banner)
