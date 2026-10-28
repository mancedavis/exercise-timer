"""Runs the shared timing fixtures (also run by the web app's tests) against the
Windows engine. Driver rules are documented in tools/gen_fixtures.py."""
import json
import unittest
from pathlib import Path

from exercise_timer.engine import COMPLETE, Engine, Settings

CASES = json.loads((Path(__file__).resolve().parent.parent / "fixtures" / "timing_cases.json")
                   .read_text(encoding="utf-8"))


class Clock:
    t = 100.0

    def __call__(self):
        return self.t


def drive(case):
    clock = Clock()
    e = Engine(Settings(**case["settings"]), clock)
    e.start()
    t0 = clock.t
    timeline, events, samples, done_at = [], [], [], None
    last, next_sample = None, 0.0
    for _ in range(case["max_steps"]):
        fa, ea = case["finish_after"], case["end_after_reps"]
        if e.can_finish_rep and fa is not None and e.elapsed >= fa:
            e.finish_rep()
        if e.can_end_set and ea is not None and e.reps_done >= ea:
            e.end_set()
        now = clock.t - t0
        ev = e.pop_events()
        events += ev
        if e.phase != last or "hold_start" in ev:
            timeline.append([now, e.phase, e.set_no, e.rep_no, e.reps_done])
            last = e.phase
        if e.phase == COMPLETE and done_at is None:
            done_at = now
        while now >= next_sample:
            d = e.display()
            samples.append([next_sample, d.phase_label, d.set_text, d.rep_text, d.rep_total_text,
                            d.rep_caption, d.timer_text, d.timer_suffix])
            next_sample += 1.0
        if e.phase == COMPLETE:
            break
        clock.t += case["step"]
        e.update()
    return timeline, events, samples, done_at


class TimingFixtures(unittest.TestCase):
    def test_all_cases(self):
        self.assertGreaterEqual(len(CASES), 12)
        for case in CASES:
            with self.subTest(case["name"]):
                timeline, events, samples, done_at = drive(case)
                exp = case["expect"]
                self.assertEqual(timeline, exp["timeline"])
                self.assertEqual(events, exp["events"])
                self.assertEqual(done_at, exp["done_at"])
                self.assertEqual(events.count("hold_start"), exp["holds"])
                if "samples" in exp:
                    self.assertEqual(samples[:len(exp["samples"])], exp["samples"])

    def test_required_example_numbers(self):
        case = next(c for c in CASES if c["name"].startswith("required example"))["expect"]
        self.assertEqual((case["holds"], case["breaks"], case["rests"], case["done_at"]),
                         (6, 4, 1, 51.0))


if __name__ == "__main__":
    unittest.main()
