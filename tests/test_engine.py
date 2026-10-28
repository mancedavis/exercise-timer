import itertools
import unittest

from exercise_timer.engine import (COMPLETE, GET_READY, HOLD, IDLE, REP_BREAK, SET_REST,
                                   Engine, Settings, parse_settings)


class Clock:
    def __init__(self):
        self.t = 100.0   # arbitrary monotonic origin

    def __call__(self):
        return self.t


def adv(engine, clock, seconds, step=1.0):
    """Advance in steps of at most `step`, like a UI that keeps ticking."""
    while seconds > 1e-9:
        dt = min(step, seconds)
        clock.t += dt
        seconds -= dt
        engine.update()


def make(**kw):
    base = dict(get_ready=0, rep_break=0, rest_enabled=False)
    base.update(kw)
    clock = Clock()
    return Engine(Settings(**base), clock), clock


class Run:
    """Steps a fake clock and records phase changes and events."""

    def __init__(self, engine, clock, step=0.5):
        self.e, self.c, self.step = engine, clock, step
        self.start = clock.t
        self.log, self.events = [], []
        self.done_at = None
        self._note()

    def _note(self):
        ev = self.e.pop_events()
        self.events += ev
        if not self.log or self.log[-1][1] != self.e.phase or "hold_start" in ev:
            self.log.append((self.c.t - self.start, self.e.phase))

    def advance(self, seconds):
        n = round(seconds / self.step)
        for _ in range(n):
            self.c.t += self.step
            self.e.update()
            self._note()
            if self.e.phase == COMPLETE and self.done_at is None:
                self.done_at = self.c.t - self.start

    def phases(self):
        return [p for _, p in self.log]


class RequiredExample(unittest.TestCase):
    def check(self, step):
        e, c = make(sets=2, reps=3, hold=4, rep_break=5, rest_enabled=True, rest=7)
        e.start()
        r = Run(e, c, step)
        r.advance(80)
        self.assertEqual(r.events.count("hold_start"), 6)
        self.assertEqual(r.events.count("hold_end"), 6)
        self.assertEqual(r.phases().count(REP_BREAK), 4)
        self.assertEqual(r.phases().count(SET_REST), 1)
        self.assertEqual(r.done_at, 51)
        self.assertEqual(r.phases(), [HOLD, REP_BREAK, HOLD, REP_BREAK, HOLD, SET_REST,
                                      HOLD, REP_BREAK, HOLD, REP_BREAK, HOLD, COMPLETE])
        self.assertEqual(r.events[-1], "complete")

    def test_ideal_clock_coarse_steps(self):
        self.check(1.0)

    def test_ideal_clock_fine_steps(self):
        self.check(0.25)


class Sequence(unittest.TestCase):
    def test_get_ready_runs_once_per_exercise(self):
        e, c = make(sets=2, reps=2, hold=2, get_ready=3)
        e.start()
        r = Run(e, c)
        self.assertEqual(e.phase, GET_READY)
        r.advance(30)
        self.assertEqual(r.phases().count(GET_READY), 1)
        # 3 get-ready + 4 holds of 2s, no breaks or rest configured
        self.assertEqual(r.done_at, 11)

    def test_counters_through_run(self):
        e, c = make(sets=2, reps=2, hold=2, rep_break=1, rest_enabled=True, rest=3)
        e.start()
        seen = []
        r = Run(e, c)
        for _ in range(40):
            r.advance(0.5)
            seen.append((e.phase, e.set_no, e.rep_no, e.reps_done))
        self.assertIn((HOLD, 1, 1, 0), seen)
        self.assertIn((REP_BREAK, 1, 1, 1), seen)
        self.assertIn((HOLD, 1, 2, 1), seen)
        self.assertIn((SET_REST, 1, 2, 2), seen)
        self.assertIn((HOLD, 2, 1, 0), seen)
        self.assertEqual(max(s[2] for s in seen), 2)   # never rep 3

    def test_zero_length_break_rest_and_get_ready_are_skipped(self):
        e, c = make(sets=2, reps=2, hold=2, rep_break=0, rest_enabled=True, rest=0, get_ready=0)
        e.start()
        self.assertEqual(e.phase, HOLD)
        r = Run(e, c)
        r.advance(10)
        self.assertEqual(r.phases().count(REP_BREAK) + r.phases().count(SET_REST), 0)
        self.assertEqual(r.events.count("hold_start"), 4)
        self.assertEqual(r.done_at, 8)

    def test_sets_disabled_means_one_set_and_no_rest(self):
        e, c = make(sets_enabled=False, sets=5, reps=2, hold=2, rest_enabled=True, rest=9)
        e.start()
        r = Run(e, c)
        r.advance(10)
        self.assertEqual(r.done_at, 4)
        self.assertEqual(e.display().set_text, "")

    def test_no_negative_countdowns(self):
        e, c = make(sets=2, reps=2, hold=2, rep_break=2, rest_enabled=True, rest=3, get_ready=2)
        e.start()
        r = Run(e, c, 0.25)
        for _ in range(120):
            r.advance(0.25)
            self.assertGreaterEqual(e.elapsed, 0)
            if e.remaining is not None:
                self.assertGreaterEqual(e.remaining, 0)
            self.assertFalse(e.display().timer_text.startswith("-"))


class OptionalCombinations(unittest.TestCase):
    def test_all_eight_combinations_complete(self):
        for sets_on, reps_on, hold_on in itertools.product([True, False], repeat=3):
            with self.subTest(sets=sets_on, reps=reps_on, hold=hold_on):
                e, c = make(sets_enabled=sets_on, sets=2, reps_enabled=reps_on, reps=3,
                            hold_enabled=hold_on, hold=2, rep_break=1,
                            rest_enabled=True, rest=2)
                e.start()
                r = Run(e, c)
                for _ in range(400):
                    if e.can_finish_rep and e.elapsed >= 1:
                        e.finish_rep()
                    if e.can_end_set and e.reps_done >= 2:
                        e.end_set()
                    r.advance(0.5)
                    if e.phase == COMPLETE:
                        break
                self.assertEqual(e.phase, COMPLETE)
                sets = 2 if sets_on else 1
                reps = 3 if reps_on else 2
                self.assertEqual(r.events.count("hold_start"), sets * reps)
                self.assertEqual(r.phases().count(SET_REST), sets - 1)
                self.assertEqual(e.set_no, sets)
                if reps_on and hold_on and sets_on:
                    self.assertEqual(r.done_at, 2 * (3 * 2 + 2 * 1) + 2)

    def test_disabled_hold_never_advances_itself(self):
        e, c = make(hold_enabled=False, reps=3)
        e.start()
        r = Run(e, c, 1.0)
        r.advance(3000)
        self.assertEqual((e.phase, e.rep_no), (HOLD, 1))
        self.assertEqual(r.events, ["hold_start"])

    def test_huge_time_jump_does_not_advance_manual_rep(self):
        e, c = make(hold_enabled=False)
        e.start()
        c.t += 1e6
        e.update()
        self.assertEqual((e.phase, e.rep_no), (HOLD, 1))
        self.assertTrue(e.paused)

    def test_finish_rep_only_in_active_manual_rep(self):
        e, c = make(hold_enabled=True, hold=5, rep_break=2)
        e.start()
        self.assertFalse(e.finish_rep())          # timed hold
        e2, c2 = make(hold_enabled=False, rep_break=2, get_ready=2)
        self.assertFalse(e2.finish_rep())         # idle
        e2.start()
        self.assertFalse(e2.finish_rep())         # get ready
        adv(e2, c2, 2)
        e2.pause()
        self.assertFalse(e2.finish_rep())         # paused
        e2.resume()
        self.assertTrue(e2.finish_rep())
        self.assertEqual(e2.phase, REP_BREAK)
        self.assertFalse(e2.finish_rep())         # in the break

    def test_manual_last_rep_goes_straight_to_rest_or_complete(self):
        e, c = make(hold_enabled=False, reps=2, sets=2, rep_break=3, rest_enabled=True, rest=4)
        e.start()
        e.finish_rep()
        self.assertEqual(e.phase, REP_BREAK)
        adv(e, c, 3)
        e.finish_rep()
        self.assertEqual(e.phase, SET_REST)
        self.assertEqual(e.display().banner, "NEXT: SET 2, REP 1")

    def test_all_disabled_is_an_open_ended_stopwatch(self):
        e, c = make(sets_enabled=False, reps_enabled=False, hold_enabled=False, rep_break=5)
        e.start()
        r = Run(e, c, 1.0)
        r.advance(125)
        self.assertEqual((e.phase, e.rep_no), (HOLD, 1))
        self.assertEqual(e.display().timer_text, "125")
        e.finish_rep()
        self.assertEqual(e.phase, REP_BREAK)
        r.advance(4)
        self.assertEqual(e.phase, REP_BREAK)
        r.advance(1)
        self.assertEqual((e.phase, e.rep_no, e.elapsed), (HOLD, 2, 0))
        self.assertTrue(e.end_set())
        self.assertEqual(e.phase, COMPLETE)

    def test_end_set_without_reps_advances_sets_with_rest(self):
        e, c = make(reps_enabled=False, sets=2, hold=3, rep_break=2, rest_enabled=True, rest=6)
        e.start()
        r = Run(e, c, 1.0)
        r.advance(3)                      # rep 1 done -> break
        self.assertEqual(e.phase, REP_BREAK)
        self.assertTrue(e.end_set())      # end set during a break
        self.assertEqual((e.phase, e.reps_done), (SET_REST, 1))
        r.advance(6)
        self.assertEqual((e.phase, e.set_no, e.rep_no), (HOLD, 2, 1))
        r.advance(1)
        self.assertTrue(e.end_set())      # end set during a hold: no rest after the last set
        self.assertEqual(e.phase, COMPLETE)
        self.assertEqual(e.reps_done, 0)  # the unfinished rep is not counted

    def test_end_set_not_available_with_fixed_reps(self):
        e, c = make(reps_enabled=True, hold=5)
        e.start()
        self.assertFalse(e.can_end_set)
        self.assertFalse(e.end_set())
        self.assertEqual(e.phase, HOLD)

    def test_end_set_only_in_hold_or_break(self):
        e, c = make(reps_enabled=False, get_ready=3, sets=2, rest_enabled=True, rest=5, hold=1)
        e.start()
        self.assertFalse(e.end_set())     # get ready
        adv(e, c, 3)
        e.end_set()
        self.assertEqual(e.phase, SET_REST)
        self.assertFalse(e.end_set())     # rest


class PauseStopAndDelays(unittest.TestCase):
    def test_pause_freezes_and_resume_keeps_fractions(self):
        e, c = make(hold=10, rep_break=0, reps=1, sets_enabled=False)
        e.start()
        adv(e, c, 3.5)
        e.pause()
        c.t += 100
        e.update()
        self.assertEqual(e.elapsed, 3.5)
        self.assertEqual(e.display().phase_label, "PAUSED")
        e.resume()
        adv(e, c, 0.25)
        self.assertEqual(e.elapsed, 3.75)
        adv(e, c, 6.25)
        self.assertEqual(e.phase, COMPLETE)

    def test_pause_in_every_countdown_phase(self):
        e, c = make(get_ready=4, reps=1, hold=2, sets=2, rest_enabled=True, rest=5)
        e.start()
        for expected, seconds in ((GET_READY, 4), (HOLD, 2), (SET_REST, 5)):
            self.assertEqual(e.phase, expected)
            adv(e, c, 1.5)
            e.pause()
            frozen = e.remaining
            c.t += 50
            e.update()
            self.assertEqual(e.remaining, frozen)
            e.resume()
            adv(e, c, seconds - 1.5)

    def test_stop_resets_counters_and_keeps_settings(self):
        e, c = make(sets=2, reps=3, hold=2, get_ready=1)
        e.start()
        adv(e, c, 3)
        e.stop()
        self.assertEqual((e.phase, e.set_no, e.rep_no, e.reps_done), (IDLE, 1, 0, 0))
        self.assertEqual(e.pop_events(), [])
        self.assertEqual(e.s.sets, 2)
        c.t += 100
        e.update()
        self.assertEqual(e.phase, IDLE)   # nothing runs after stop
        e.start()
        self.assertEqual(e.phase, GET_READY)

    def test_complete_stays_until_started_again(self):
        e, c = make(reps=1, sets_enabled=False, hold=1)
        e.start()
        adv(e, c, 1)
        c.t += 500
        e.update()
        self.assertEqual(e.phase, COMPLETE)
        self.assertEqual(e.display().timer_text, "Exercise complete")
        self.assertTrue(e.start())
        self.assertEqual(e.phase, HOLD)

    def test_late_callback_neither_skips_nor_shortens(self):
        e, c = make(hold=4, rep_break=5, reps=3, sets_enabled=False)
        e.start()
        adv(e, c, 3)
        c.t += 1.7                 # callback arrives 0.7s late
        e.update()
        self.assertEqual(e.phase, REP_BREAK)
        adv(e, c, 4.75)
        self.assertEqual(e.phase, REP_BREAK)   # break still gets its full 5s
        adv(e, c, 0.25)
        self.assertEqual((e.phase, e.rep_no), (HOLD, 2))

    def test_late_callback_moves_one_phase_only(self):
        e, c = make(hold=1, rep_break=1, reps=5, sets_enabled=False)
        e.start()
        c.t += 1.9                 # one very late callback
        e.update()
        self.assertEqual((e.phase, e.reps_done), (REP_BREAK, 1))
        c.t += 1.9
        e.update()
        self.assertEqual((e.phase, e.rep_no), (HOLD, 2))   # next phase began now, rep 3 not reached

    def test_long_gap_auto_pauses_until_resume(self):
        e, c = make(hold=10, reps=3, sets_enabled=False, rep_break=3)
        e.start()
        adv(e, c, 1)
        c.t += 3600               # computer slept
        e.update()
        self.assertTrue(e.paused and e.auto_paused)
        self.assertEqual(e.elapsed, 1)
        self.assertIn("automatically", e.display().banner)
        c.t += 60
        e.update()
        self.assertEqual((e.phase, e.rep_no), (HOLD, 1))
        e.resume()
        adv(e, c, 8.5)
        self.assertEqual(e.phase, HOLD)        # 1s credited before the gap, 9.5 total
        adv(e, c, 0.5)
        self.assertEqual(e.phase, REP_BREAK)


class DisplayText(unittest.TestCase):
    def test_hold_counts_up_with_target(self):
        e, c = make(hold=10, reps=10)
        e.start()
        adv(e, c, 3.9)
        d = e.display()
        self.assertEqual((d.phase_label, d.rep_text, d.rep_total_text), ("HOLD", "1", "of 10"))
        self.assertEqual((d.timer_text, d.timer_suffix), ("3", "/ 10 s"))

    def test_break_shows_completed_rep_and_next_rep(self):
        e, c = make(hold=2, rep_break=5, reps=10)
        e.start()
        adv(e, c, 2)
        d = e.display()
        self.assertEqual((d.phase_label, d.rep_text, d.rep_caption), ("REP BREAK", "1", "REP 1 COMPLETED"))
        self.assertEqual(d.banner, "NEXT: REP 2")
        self.assertEqual(d.timer_text, "5")
        adv(e, c, 1.2)
        self.assertEqual(e.display().timer_text, "4")

    def test_set_rest_names_next_set_and_complete_text(self):
        e, c = make(hold=1, reps=1, sets=2, rest_enabled=True, rest=3)
        e.start()
        adv(e, c, 1)
        d = e.display()
        self.assertEqual((d.phase_label, d.set_text, d.banner),
                         ("SET REST", "SET 1 of 2 DONE", "NEXT: SET 2, REP 1"))
        adv(e, c, 3)
        adv(e, c, 1)
        d = e.display()
        self.assertEqual((d.phase_label, d.timer_text), ("COMPLETE", "Exercise complete"))

    def test_get_ready_does_not_show_a_started_rep(self):
        e, c = make(get_ready=5)
        e.start()
        d = e.display()
        self.assertEqual((d.phase_label, d.rep_text, d.timer_text), ("GET READY", "0", "5"))

    def test_open_ended_reps_hide_total_and_hint_end_set(self):
        e, c = make(reps_enabled=False, hold=5)
        e.start()
        d = e.display()
        self.assertEqual(d.rep_total_text, "")
        self.assertIn("End Set", d.banner)


class Validation(unittest.TestCase):
    RAW = dict(name="x", sets_enabled=True, sets="3", reps_enabled=True, reps="10",
               hold_enabled=True, hold="10", rep_break="5", rest_enabled=False, rest="30",
               get_ready="5")

    def raw(self, **kw):
        return {**self.RAW, **kw}

    def test_valid(self):
        s = parse_settings(self.raw())
        self.assertEqual((s.sets, s.reps, s.hold, s.rep_break, s.get_ready), (3, 10, 10, 5, 5))

    def test_enabled_counts_must_be_positive_integers(self):
        for key in ("sets", "reps", "hold"):
            for bad in ("0", "-2", "1.5", "abc", "", " "):
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    parse_settings(self.raw(**{key: bad}))

    def test_durations_may_be_zero_but_not_negative(self):
        s = parse_settings(self.raw(rep_break="0", get_ready="0", rest_enabled=True, rest="0"))
        self.assertEqual((s.rep_break, s.get_ready, s.rest), (0, 0, 0))
        for key in ("rep_break", "get_ready"):
            with self.assertRaises(ValueError):
                parse_settings(self.raw(**{key: "-1"}))
        with self.assertRaises(ValueError):
            parse_settings(self.raw(rest_enabled=True, rest="x"))

    def test_disabled_inputs_do_not_block(self):
        s = parse_settings(self.raw(sets_enabled=False, sets="zzz", reps_enabled=False, reps="0",
                                    hold_enabled=False, hold="", rest_enabled=False, rest="-4"))
        self.assertFalse(s.sets_enabled or s.reps_enabled or s.hold_enabled)

    def test_message_is_short_and_helpful(self):
        with self.assertRaises(ValueError) as cm:
            parse_settings(self.raw(reps="0"))
        self.assertEqual(str(cm.exception), "Reps per set must be a whole number, 1 to 9999.")

    def test_upper_limits_and_name_length(self):
        with self.assertRaises(ValueError):
            parse_settings(self.raw(reps="10000"))
        with self.assertRaises(ValueError):
            parse_settings(self.raw(hold="86401"))
        with self.assertRaises(ValueError):
            parse_settings(self.raw(name="x" * 81))
        self.assertEqual(parse_settings(self.raw(hold="86400", reps="9999")).hold, 86400)
        # a disabled field that is out of range does not block
        self.assertEqual(parse_settings(self.raw(reps_enabled=False, reps="99999")).reps, 10)


if __name__ == "__main__":
    unittest.main()
