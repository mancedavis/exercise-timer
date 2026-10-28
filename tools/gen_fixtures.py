"""Regenerates fixtures/ from the Windows implementation. Fixtures are synthetic.

Run from the project root:  python tools/gen_fixtures.py
Both test suites (Python unittest and Node node:test) read these files, so the
web app is held to the same expected timelines and file semantics.

Timing driver (implemented identically in tests/fixtures_driver.py and
web_tests/driver.js): start the engine, then loop up to `max_steps` times:
  1. if finish-rep is allowed and the hold has run >= finish_after s -> finish_rep
  2. if end-set is allowed and reps_done >= end_after_reps          -> end_set
  3. record (time, phase, set_no, rep_no, reps_done) on a phase change or hold start
  4. stop when COMPLETE, otherwise advance the clock by `step` and update()
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from exercise_timer.engine import COMPLETE, Engine, Settings  # noqa: E402
from exercise_timer.store import PresetStore  # noqa: E402
from exercise_timer.transfer import export_text  # noqa: E402

OUT = ROOT / "fixtures"


def write(name, text):
    """LF endings on every platform so fixtures are byte-identical everywhere."""
    with open(OUT / name, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def dump(name, obj):
    write(name, json.dumps(obj, indent=2) + "\n")


# ---- preset files -------------------------------------------------------
def S(**kw):
    return Settings(**kw)


PRESETS = {
    "Demo (example)": S(name="Demo exercise (example only)"),
    "Alpha hold": S(name="Alpha", sets_enabled=False, sets=2, hold=30, rep_break=3,
                    rest_enabled=True, rest=45, get_ready=0),       # disabled field keeps value 2
    "Open ended": S(name="Open set", reps_enabled=False, reps=7, hold_enabled=True, hold=5,
                    rep_break=0, get_ready=3),
    "Manual stopwatch": S(name="Stopwatch", sets_enabled=False, reps_enabled=False,
                          hold_enabled=False, hold=12, rep_break=4, get_ready=10),
}


def preset_files():
    with tempfile.TemporaryDirectory() as tmp:
        store = PresetStore(Path(tmp) / "presets.json")
        store.presets = dict(PRESETS)
        store.sound, store.last = False, "Alpha hold"
        store.save()
        legacy = (Path(tmp) / "presets.json").read_text(encoding="utf-8")
    write("legacy_windows_presets.json", legacy.replace("\r\n", "\n"))
    write("export_all.json", export_text(PRESETS))
    one = {"Open ended": PRESETS["Open ended"]}
    write("export_single.json", export_text(one))
    overlap = {
        "alpha hold": S(name="Alpha REPLACED"),
        "New One": S(name="Brand new", sets=4),
        "Open ended": S(name="Open REPLACED"),
        "Brand New 2": S(name="Another"),
    }
    write("import_overlap.json", export_text(overlap))


def import_cases():
    ok = PRESETS["Demo (example)"].to_dict()

    def doc(**changes):
        d = {"version": 1, "presets": {"A": dict(ok)}}
        d.update(changes)
        return json.dumps(d)

    def with_field(**kw):
        return json.dumps({"version": 1, "presets": {"A": {**ok, **kw}}})

    def without(key):
        p = dict(ok)
        del p[key]
        return json.dumps({"version": 1, "presets": {"A": p}})

    invalid = [
        ("not json", "{nope", "not a valid JSON"),
        ("empty text", "", "not a valid JSON"),
        ("array", "[]", "does not contain Exercise Timer presets"),
        ("no presets key", '{"version": 1}', "does not contain Exercise Timer presets"),
        ("presets is a list", '{"version": 1, "presets": []}', "does not contain Exercise Timer presets"),
        ("missing version", json.dumps({"presets": {"A": ok}}), "no format version"),
        ("string version", json.dumps({"version": "1", "presets": {"A": ok}}), "no format version"),
        ("bool version", json.dumps({"version": True, "presets": {"A": ok}}), "no format version"),
        ("version 2", json.dumps({"version": 2, "presets": {"A": ok}}), "format version 2"),
        ("version 0", json.dumps({"version": 0, "presets": {"A": ok}}), "format version 0"),
        ("no presets", '{"version": 1, "presets": {}}', "contains no presets"),
        ("preset not object", '{"version": 1, "presets": {"A": 5}}', "not a set of settings"),
        ("float count", with_field(reps=3.0), "Reps per set must be a whole number"),
        ("float written as 3.0", doc().replace('"reps": 10', '"reps": 10.0'), "Reps per set must be a whole number"),
        ("string number", with_field(sets="3"), "Sets must be a whole number"),
        ("bool as number", with_field(hold=True), "Hold seconds must be a whole number"),
        ("reps zero", with_field(reps=0), "Reps per set must be a whole number, 1 to 9999"),
        ("reps too big", with_field(reps=10000), "Reps per set must be a whole number, 1 to 9999"),
        ("hold too big", with_field(hold=86401), "Hold seconds must be a whole number, 1 to 86400"),
        ("negative break", with_field(rep_break=-1), "Rep break must be a whole number, 0 to 86400"),
        ("huge integer", doc().replace('"get_ready": 5', '"get_ready": ' + "9" * 40), "Get-ready must be a whole number"),
        ("flag not bool", with_field(rest_enabled="no"), "Set rest on/off must be true or false"),
        ("flag number", with_field(sets_enabled=1), "Sets on/off must be true or false"),
        ("missing field", without("rest"), "Set rest must be a whole number"),
        ("blank exercise name", with_field(name="   "), "invalid exercise name"),
        ("padded exercise name", with_field(name=" x"), "invalid exercise name"),
        ("long exercise name", with_field(name="x" * 81), "invalid exercise name"),
        ("name not string", with_field(name=5), "invalid exercise name"),
        ("padded preset name", json.dumps({"version": 1, "presets": {" A": ok}}), "blank or over-long name"),
        ("blank preset name", json.dumps({"version": 1, "presets": {"": ok}}), "blank or over-long name"),
        ("long preset name", json.dumps({"version": 1, "presets": {"n" * 81: ok}}), "blank or over-long name"),
        ("duplicate key", '{"version": 1, "presets": {"A": %s, "A": %s}}' % (json.dumps(ok), json.dumps(ok)), 'lists "A" more than once'),
        ("duplicate ignoring case", json.dumps({"version": 1, "presets": {"Plank": ok, "plank": ok}}), "more than once"),
        ("duplicate field inside preset", '{"version": 1, "presets": {"A": {"name": "x", "name": "y"}}}', 'lists "name" more than once'),
        ("NaN", doc().replace('"reps": 10', '"reps": NaN'), "not a valid JSON"),
        ("trailing comma", '{"version": 1, "presets": {},}', "not a valid JSON"),
    ]
    valid = [
        {"name": "legacy full presets.json", "file": "legacy_windows_presets.json",
         "names": list(PRESETS)},
        {"name": "export all", "file": "export_all.json", "names": list(PRESETS)},
        {"name": "export single", "file": "export_single.json", "names": ["Open ended"]},
        {"name": "extra keys ignored", "text": json.dumps(
            {"version": 1, "sound": False, "last": "A", "extra": [1], "presets": {"A": {**ok, "future": 1}}}),
         "names": ["A"]},
    ]
    dump("import_cases.json", {"invalid": [{"name": n, "text": t, "error_contains": e} for n, t, e in invalid],
                               "valid": valid})


def conflict_scenarios():
    existing = list(PRESETS)
    cases = [
        ("replace all", {"alpha hold": "replace", "Open ended": "replace"}, False),
        ("skip all", {"alpha hold": "skip", "Open ended": "skip"}, False),
        ("mixed", {"alpha hold": "replace", "Open ended": "skip"}, False),
        ("cancel", {}, True),
    ]
    out = []
    for name, decisions, cancel in cases:
        if cancel:
            out.append({"name": name, "cancel": True, "summary": None,
                        "names": existing, "exercise_names": {k: PRESETS[k].name for k in existing}})
            continue
        added = 2
        replaced = sum(v == "replace" for v in decisions.values())
        skipped = sum(v == "skip" for v in decisions.values())
        ex = {k: PRESETS[k].name for k in existing}
        if decisions.get("alpha hold") == "replace":
            ex["Alpha hold"] = "Alpha REPLACED"
        if decisions.get("Open ended") == "replace":
            ex["Open ended"] = "Open REPLACED"
        ex["New One"], ex["Brand New 2"] = "Brand new", "Another"
        out.append({"name": name, "decisions": decisions, "cancel": False,
                    "summary": f"{added} added, {replaced} replaced, {skipped} skipped",
                    "names": existing + ["New One", "Brand New 2"], "exercise_names": ex})
    dump("conflict_scenarios.json", {"existing_file": "legacy_windows_presets.json",
                                     "import_file": "import_overlap.json", "cases": out})


def filenames():
    dump("export_filenames.json", [
        {"name": None, "today": "20260115", "expect": "exercise-timer-presets-20260115.json"},
        {"name": "Wall sit / legs!", "today": "20260115", "expect": "exercise-timer-Wall-sit-legs.json"},
        {"name": "Demo (example)", "today": "20260115", "expect": "exercise-timer-Demo-example.json"},
        {"name": "æ—¥æœ¬èªž", "today": "20260115", "expect": "exercise-timer-preset.json"},
        {"name": "x" * 60, "today": "20260115", "expect": "exercise-timer-" + "x" * 40 + ".json"},
    ])


# ---- timing -------------------------------------------------------------
class Clock:
    t = 100.0

    def __call__(self):
        return self.t


def run_case(settings, step, max_steps, finish_after, end_after):
    clock = Clock()
    e = Engine(settings, clock)
    e.start()
    t0 = clock.t
    timeline, events, samples, done_at = [], [], [], None
    last_phase, next_sample = None, 0.0

    def record(now):
        nonlocal last_phase, next_sample, done_at
        ev = e.pop_events()
        events.extend(ev)
        if e.phase != last_phase or "hold_start" in ev:
            timeline.append([now, e.phase, e.set_no, e.rep_no, e.reps_done])
            last_phase = e.phase
        if e.phase == COMPLETE and done_at is None:
            done_at = now
        while now >= next_sample:
            d = e.display()
            samples.append([next_sample, d.phase_label, d.set_text, d.rep_text, d.rep_total_text,
                            d.rep_caption, d.timer_text, d.timer_suffix])
            next_sample += 1.0
    for _ in range(max_steps):
        if e.can_finish_rep and finish_after is not None and e.elapsed >= finish_after:
            e.finish_rep()
        if e.can_end_set and end_after is not None and e.reps_done >= end_after:
            e.end_set()
        record(clock.t - t0)
        if e.phase == COMPLETE:
            break
        clock.t += step
        e.update()
    return {"timeline": timeline,
            "holds": events.count("hold_start"), "hold_ends": events.count("hold_end"),
            "breaks": sum(1 for r in timeline if r[1] == "rep_break"),
            "rests": sum(1 for r in timeline if r[1] == "set_rest"),
            "done_at": done_at, "events": events, "samples": samples}


def timing():
    cases = []

    def add(name, settings, step=0.5, max_steps=4000, finish_after=None, end_after=None, sample=False):
        r = run_case(settings, step, max_steps, finish_after, end_after)
        if not sample:
            r.pop("samples")
        cases.append({"name": name, "settings": settings.to_dict(), "step": step,
                      "max_steps": max_steps, "finish_after": finish_after,
                      "end_after_reps": end_after, "expect": r})
        return r

    r = add("required example 2x3x4s", S(sets=2, reps=3, hold=4, rep_break=5, rest_enabled=True,
                                         rest=7, get_ready=0), sample=True)
    assert (r["holds"], r["breaks"], r["rests"], r["done_at"]) == (6, 4, 1, 51.0), r
    r = add("get ready then 2x2", S(sets=2, reps=2, hold=2, rep_break=1, rest_enabled=True,
                                    rest=3, get_ready=3), sample=True)
    assert (r["holds"], r["breaks"], r["rests"], r["done_at"]) == (4, 2, 1, 3 + 4 * 2 + 2 + 3), r
    r = add("zero break and rest", S(sets=2, reps=2, hold=2, rep_break=0, rest_enabled=True,
                                     rest=0, get_ready=0))
    assert (r["breaks"], r["rests"], r["done_at"]) == (0, 0, 8.0), r
    r = add("rest ignored for one set", S(sets_enabled=False, sets=5, reps=2, hold=2,
                                          rep_break=1, rest_enabled=True, rest=9, get_ready=0))
    assert (r["rests"], r["done_at"]) == (0, 5.0), r
    for sets_on in (True, False):
        for reps_on in (True, False):
            for hold_on in (True, False):
                label = f"combo sets={sets_on} reps={reps_on} hold={hold_on}"
                s = S(sets_enabled=sets_on, sets=2, reps_enabled=reps_on, reps=3,
                      hold_enabled=hold_on, hold=2, rep_break=1, rest_enabled=True, rest=2,
                      get_ready=0)
                r = add(label, s, finish_after=1, end_after=2, sample=sets_on and not reps_on and not hold_on)
                assert r["done_at"] is not None, label
                assert r["holds"] == (2 if sets_on else 1) * (3 if reps_on else 2), label
    r = add("manual stopwatch never self-advances",
            S(sets_enabled=False, reps_enabled=False, hold_enabled=False, rep_break=5, get_ready=0),
            step=1.0, max_steps=300, sample=True)
    assert r["done_at"] is None and r["holds"] == 1, r
    dump("timing_cases.json", cases)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    preset_files()
    import_cases()
    conflict_scenarios()
    filenames()
    timing()
    print("fixtures written to", OUT)
