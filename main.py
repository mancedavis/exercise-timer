import sys


def self_test(out_path):
    """`ExerciseTimer.exe --self-test result.txt`: checks that the packaged program
    can create its window, save presets, and round-trip an export/import. Writes
    one line to result.txt. Uses a temporary folder, never the real presets."""
    import tempfile
    import tkinter as tk
    from pathlib import Path

    from exercise_timer import ui
    from exercise_timer.engine import Settings
    from exercise_timer.sound import Sound
    from exercise_timer.store import PresetStore
    from exercise_timer.transfer import export_text, parse_import

    try:
        with tempfile.TemporaryDirectory() as tmp:
            store = PresetStore(Path(tmp) / "presets.json")
            custom = Settings(name="Self test", sets_enabled=False, sets=2, reps_enabled=False,
                              reps=7, hold_enabled=False, hold=15, rep_break=0,
                              rest_enabled=True, rest=45, get_ready=0)
            store.put("Self test", custom)
            parsed = parse_import(export_text(store.presets).encode("utf-8"))
            assert parsed == store.presets, "export/import round trip differs"
            other = PresetStore(Path(tmp) / "other.json")
            counts = other.apply_import(parsed, {})
            assert counts == (1, 0, 0) or counts[0] >= 1, counts
            root = tk.Tk()
            root.withdraw()
            app = ui.App(root, store, sound=Sound(beep=lambda f, ms: None))
            root.update()
            app.start()
            app.stop()
            app.close()
            result = f"SELF-TEST OK python={sys.version.split()[0]} frozen={getattr(sys, 'frozen', False)}"
    except Exception as err:   # report any failure instead of dying silently in a windowed exe
        result = f"SELF-TEST FAILED {type(err).__name__}: {err}"
    Path(out_path).write_text(result + "\n", encoding="utf-8")
    return 0 if result.startswith("SELF-TEST OK") else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test":
        sys.exit(self_test(sys.argv[2]))
    from exercise_timer.ui import run
    run()
