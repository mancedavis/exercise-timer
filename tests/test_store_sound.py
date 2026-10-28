import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from exercise_timer import store as store_mod
from exercise_timer.engine import Settings
from exercise_timer.sound import Sound
from exercise_timer.store import DEMO_NAME, PresetStore, StoreError


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "ExerciseTimer" / "presets.json"

    def test_fresh_store_has_labelled_demo(self):
        s = PresetStore(self.path)
        self.assertEqual(s.names(), [DEMO_NAME])
        self.assertIn("example", s.get(DEMO_NAME).name.lower())
        self.assertEqual(s.last, DEMO_NAME)
        self.assertTrue(s.sound)

    def test_roundtrip_all_fields_sound_and_last(self):
        s = PresetStore(self.path)
        custom = Settings(name="Wall sit", sets_enabled=False, sets=2, reps_enabled=False,
                          reps=7, hold_enabled=False, hold=15, rep_break=0,
                          rest_enabled=True, rest=45, get_ready=0)
        s.put("Legs", custom)
        s.put("Arms", Settings(name="Arms"))
        s.set_sound(False)
        s.set_last("Legs")
        again = PresetStore(self.path)
        self.assertEqual(again.get("Legs"), custom)
        self.assertEqual(again.names(), [DEMO_NAME, "Legs", "Arms"])
        self.assertFalse(again.sound)
        self.assertEqual(again.last, "Legs")
        self.assertEqual(again.notice, "")

    def test_replace_rename_delete(self):
        s = PresetStore(self.path)
        s.put("A", Settings(name="a1"))
        s.put("a", Settings(name="a2"))               # same name, different case: replaces
        self.assertEqual([n for n in s.names() if n.lower() == "a"], ["a"])
        self.assertEqual(s.get("a").name, "a2")
        s.put("B", Settings(name="b"))
        s.rename("B", "a")                              # replaces the clash
        self.assertEqual(s.get("a").name, "b")
        self.assertNotIn("B", s.names())
        self.assertEqual(s.find("A"), "a")
        s.delete("a")
        self.assertEqual(PresetStore(self.path).names(), [DEMO_NAME])

    def test_save_and_rename_keep_list_position(self):
        s = PresetStore(self.path)
        s.put("A", Settings(name="a"))
        s.put("B", Settings(name="b"))
        s.put("a", Settings(name="a2"))
        self.assertEqual(s.names(), [DEMO_NAME, "a", "B"])
        s.rename("a", "Z")
        self.assertEqual(s.names(), [DEMO_NAME, "Z", "B"])
        self.assertEqual(PresetStore(self.path).names(), [DEMO_NAME, "Z", "B"])

    def test_delete_last_selected_moves_selection(self):
        s = PresetStore(self.path)
        s.put("X", Settings())
        s.delete("X")
        self.assertEqual(s.last, DEMO_NAME)

    def test_corrupt_file_is_kept_and_defaults_load(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{ this is not json", encoding="utf-8")
        s = PresetStore(self.path)
        self.assertEqual(s.names(), [DEMO_NAME])
        self.assertTrue(s.notice)
        backups = list(self.path.parent.glob("presets.json.bad-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "{ this is not json")
        s.set_last(DEMO_NAME)
        s.put("New", Settings())
        self.assertIn("New", PresetStore(self.path).names())
        self.assertEqual(len(list(self.path.parent.glob("presets.json.bad-*"))), 1)

    def test_one_damaged_preset_is_skipped_others_survive(self):
        good = Settings(name="ok").to_dict()
        bad = {**good, "reps": "nope"}
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"version": 1, "sound": True, "last": "good",
                                         "presets": {"good": good, "bad": bad}}), encoding="utf-8")
        s = PresetStore(self.path)
        self.assertEqual(s.names(), ["good"])
        self.assertIn("skipped", s.notice)
        self.assertEqual(len(list(self.path.parent.glob("presets.json.bad-*"))), 1)

    def test_write_is_atomic_and_leaves_no_temp_file(self):
        s = PresetStore(self.path)
        s.put("A", Settings())
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["presets.json"])
        before = self.path.read_text(encoding="utf-8")
        with mock.patch("os.replace", side_effect=PermissionError(13, "Access is denied")):
            with self.assertRaises(StoreError) as cm:
                s.put("B", Settings())
        self.assertIn("Could not save", str(cm.exception))
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)   # old file intact
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["presets.json"])
        self.assertIn("B", s.names())   # still in memory so nothing is silently lost

    def test_unwritable_location_raises_store_error(self):
        blocker = self.dir / "file"
        blocker.write_text("x")
        s = PresetStore(blocker / "sub" / "presets.json")
        with self.assertRaises(StoreError):
            s.save()

    def test_default_path_is_under_appdata_not_temp_extraction(self):
        with mock.patch.dict(os.environ, {"APPDATA": str(self.dir)}):
            p = store_mod.default_path()
        self.assertEqual(p, self.dir / "ExerciseTimer" / "presets.json")


class SoundTests(unittest.TestCase):
    def test_disabled_plays_nothing(self):
        played = []
        s = Sound(beep=lambda f, ms: played.append(f), enabled=False)
        s.play("hold_start")
        s.close()
        self.assertEqual(played, [])

    def test_plays_cue(self):
        done = threading.Event()
        played = []

        def beep(f, ms):
            played.append(f)
            if len(played) == 3:
                done.set()
        s = Sound(beep=beep)
        s.play("complete")
        self.assertTrue(done.wait(2))
        s.close()

    def test_audio_failure_is_swallowed(self):
        done = threading.Event()
        calls = []

        def beep(f, ms):
            calls.append(f)
            done.set()
            raise RuntimeError("no audio device")
        s = Sound(beep=beep)
        s.play("hold_start")
        self.assertTrue(done.wait(2))
        s.play("hold_end")      # still usable afterwards
        s.close()

    def test_cancel_drops_queued_cues(self):
        gate, started = threading.Event(), threading.Event()
        played = []

        def beep(f, ms):
            played.append(f)
            started.set()
            gate.wait(2)
        s = Sound(beep=beep)
        s.play("hold_start")
        self.assertTrue(started.wait(2))
        s.play("complete")
        s.play("hold_end")
        s.cancel()
        gate.set()
        s.close()
        s._thread.join(2)
        self.assertEqual(len(played), 1)


if __name__ == "__main__":
    unittest.main()
