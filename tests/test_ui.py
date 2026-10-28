"""Smoke tests that create a real (hidden) tkinter window with a fake clock."""
import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest import mock

from exercise_timer.engine import COMPLETE, HOLD, IDLE
from exercise_timer.sound import Sound
from exercise_timer.store import PresetStore
from exercise_timer import ui


class Clock:
    t = 50.0

    def __call__(self):
        return self.t


class UiTests(unittest.TestCase):
    def setUp(self):
        try:
            self.root = tk.Tk()
        except tk.TclError as e:
            self.skipTest(f"no display: {e}")
        self.root.withdraw()
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "presets.json"
        self.beeps = []
        self.clock = Clock()
        self.app = self.make_app()

    def make_app(self):
        return ui.App(self.root, PresetStore(self.path), self.clock,
                      Sound(beep=lambda f, ms: self.beeps.append(f)))

    def tearDown(self):
        self.app._cancel_tick()
        self.app.sound.close()
        self.root.destroy()
        self.tmp.cleanup()

    def set_fields(self, **kw):
        for k, v in kw.items():
            self.app.vars[k].set(v)

    def test_layout_sizes_at_1080p(self):
        for h in (900, 1000):      # canvas height of a 1080p full screen, controls included
            m = ui.layout_metrics(1920, h)
            self.assertTrue(240 <= m["numeral"] <= 320, m["numeral"])
            self.assertTrue(100 <= m["timer"] <= 160, m["timer"])
            self.assertLess(m["total"], m["numeral"])

    def test_nothing_clipped_at_any_size(self):
        self.set_fields(name="A very long exercise name for the big screen " * 2, reps="100")
        self.app.start()
        self.clock.t += 1
        self.app._tick()
        for w, h in ((700, 400), (1600, 900), (1920, 1000), (3840, 2000), (400, 900)):
            with self.subTest(size=(w, h)):
                self.app.canvas.winfo_width = lambda w=w: w
                self.app.canvas.winfo_height = lambda h=h: h
                self.app._render(force=True)
                x0, y0, x1, y1 = self.app.canvas.bbox("all")
                self.assertGreaterEqual(x0, 0)
                self.assertGreaterEqual(y0, 0)
                self.assertLessEqual(x1, w)
                self.assertLessEqual(y1, h)

    def test_start_locks_settings_and_stop_unlocks(self):
        self.set_fields(get_ready="0")
        self.app.start()
        self.assertEqual(self.app.engine.phase, HOLD)
        self.assertEqual(str(self.app.entries["reps"][0].cget("state")), "disabled")
        self.assertEqual(str(self.app.buttons["start"].cget("state")), "disabled")
        self.assertEqual(str(self.app.preset_buttons[0].cget("state")), "disabled")
        self.assertIsNotNone(self.app._after_id)
        self.app.stop()
        self.assertIsNone(self.app._after_id)
        self.assertIsNone(self.app.engine)
        self.assertEqual(str(self.app.entries["reps"][0].cget("state")), "normal")

    def test_invalid_input_blocks_start_but_disabled_input_does_not(self):
        self.set_fields(reps="0")
        self.app.start()
        self.assertIsNone(self.app.engine)
        self.assertIn("Reps per set", self.app.msg.cget("text"))
        self.set_fields(reps_enabled=False)
        self.app.start()
        self.assertIsNotNone(self.app.engine)

    def test_pause_disables_phase_controls(self):
        self.set_fields(get_ready="0", hold_enabled=False, reps_enabled=False)
        self.app.start()
        b = self.app.buttons
        self.assertEqual(str(b["finish"].cget("state")), "normal")
        self.assertEqual(str(b["end"].cget("state")), "normal")
        self.app.pause_resume()
        self.assertEqual(b["pause"].cget("text"), "Resume")
        self.assertEqual(str(b["finish"].cget("state")), "disabled")
        self.assertEqual(str(b["end"].cget("state")), "disabled")
        self.assertIsNone(self.app._after_id)       # no timer runs while paused
        self.app.pause_resume()
        self.assertIsNotNone(self.app._after_id)

    def test_run_to_complete_keeps_result_and_unlocks(self):
        self.set_fields(get_ready="0", sets_enabled=False, reps="1", hold="2")
        self.app.start()
        self.clock.t += 2
        self.app._tick()
        self.assertEqual(self.app.engine.phase, COMPLETE)
        self.assertIsNone(self.app._after_id)
        self.assertEqual(self.app.engine.display().timer_text, "Exercise complete")
        self.assertEqual(str(self.app.entries["reps"][0].cget("state")), "normal")
        self.assertIn(880, self.beeps) if self.beeps else None

    def test_pause_that_catches_up_to_completion_is_handled(self):
        self.set_fields(get_ready="0", sets_enabled=False, reps="1", hold="2")
        self.app.start()
        self.clock.t += 1.9
        self.app._tick()
        self.clock.t += 0.3            # hold ended inside the gap before the Pause click
        self.app.pause_resume()
        self.assertEqual(self.app.engine.phase, COMPLETE)
        self.assertEqual(str(self.app.entries["reps"][0].cget("state")), "normal")
        self.assertIsNone(self.app._after_id)

    def test_dialog_events_do_not_trigger_fullscreen_keys(self):
        class Ev:
            widget = tk.Toplevel(self.root)
        self.assertFalse(self.app._own(Ev()))
        Ev.widget.destroy()

        class Ev2:
            widget = self.root
        self.assertTrue(self.app._own(Ev2()))

    def test_no_duplicate_timers_on_repeated_ticks(self):
        self.set_fields(get_ready="0")
        self.app.start()
        with mock.patch.object(self.root, "after_cancel", wraps=self.root.after_cancel) as ac:
            self.app._tick()
            self.app._tick()
            self.assertEqual(ac.call_count, 2)

    def test_shortcuts_and_typing_guard(self):
        self.set_fields(get_ready="0", hold_enabled=False)
        self.root.deiconify()
        self.root.update()
        entry = self.app.entries["name"][0]
        entry.focus_force()
        self.root.update()
        self.assertTrue(self.app._typing())
        self.assertIsNone(self.app._shortcut(self.app.space))
        self.assertIsNone(self.app.engine)             # typing a space did not start it
        self.root.focus_force()
        self.root.focus_set()
        self.root.update()
        self.assertFalse(self.app._typing())
        self.assertEqual(self.app._shortcut(self.app.space), "break")
        self.assertEqual(self.app.engine.phase, HOLD)
        self.app._shortcut(self.app.space)
        self.assertTrue(self.app.engine.paused)
        self.app._shortcut(self.app.space)
        self.assertFalse(self.app.engine.paused)
        self.app._shortcut(self.app.finish_rep)
        self.assertEqual(self.app.engine.reps_done, 1)

    def test_fullscreen_toggle(self):
        self.app.toggle_fullscreen()
        self.assertTrue(self.app.fullscreen)
        self.app.toggle_fullscreen(False)
        self.assertFalse(self.app.fullscreen)

    def test_close_cancels_timer_and_sound(self):
        self.set_fields(get_ready="0")
        self.app.start()
        self.app.close()
        self.assertIsNone(self.app._after_id)
        self.root = tk.Tk()   # tearDown destroys it
        self.root.withdraw()

    def test_presets_save_select_persist_and_confirm(self):
        self.set_fields(name="Plank", reps="4", hold="30")
        with mock.patch.object(ui.simpledialog, "askstring", return_value="Plank"):
            self.app.preset_save_as()
        self.assertEqual(self.app.current, "Plank")
        self.assertEqual(self.app.dirty_label.cget("text"), "")
        self.set_fields(reps="5")
        self.assertTrue(self.app.dirty_label.cget("text"))
        # replacing another preset asks first
        with mock.patch.object(ui.simpledialog, "askstring", return_value="demo (EXAMPLE)"), \
                mock.patch.object(ui.messagebox, "askyesno", return_value=False) as ask:
            self.app.preset_save_as()
            ask.assert_called_once()
        self.assertNotEqual(self.app.store.get("Demo (example)").reps, 5)
        # deletion asks first
        with mock.patch.object(ui.messagebox, "askyesno", return_value=False):
            self.app.preset_delete()
        self.assertIn("Plank", self.app.store.names())
        self.app.preset_save()      # update
        self.app.sound_var.set(False)
        self.app._sound_toggled()
        # reopen
        self.app.sound.close()
        self.root.destroy()
        self.root = tk.Tk()
        self.root.withdraw()
        self.app = self.make_app()
        self.assertEqual(self.app.current, "Plank")
        self.assertEqual(self.app.vars["reps"].get(), "5")
        self.assertFalse(self.app.sound.enabled)
        with mock.patch.object(ui.messagebox, "askyesno", return_value=True):
            self.app.preset_delete()
        self.assertNotIn("Plank", self.app.store.names())

    # ----- import / export ------------------------------------------------
    FIX = Path(__file__).resolve().parent.parent / "fixtures"

    def _import(self, filename, choices=None, asked=None):
        """Run preset_import on a fixture; choices = answers for the conflict dialog."""
        answers = iter(choices or [])

        def ask(existing, more):
            if asked is not None:
                asked.append((existing, more))
            return next(answers)
        with mock.patch.object(ui.filedialog, "askopenfilename", return_value=str(self.FIX / filename)), \
                mock.patch.object(self.app, "_ask_conflict", side_effect=ask), \
                mock.patch.object(ui.messagebox, "showinfo") as info, \
                mock.patch.object(ui.messagebox, "showerror") as err:
            self.app.preset_import()
        return info, err

    def test_import_adds_and_preserves_preferences(self):
        sound_before = self.app.store.sound
        info, err = self._import("legacy_windows_presets.json", [("skip", False)])
        err.assert_not_called()
        self.assertEqual(info.call_args[0][1], "3 added, 0 replaced, 1 skipped.")
        self.assertIn("Open ended", self.app.store.names())
        reread = PresetStore(self.path)
        self.assertEqual(reread.sound, sound_before)       # file said sound=false; ignored
        self.assertEqual(reread.last, "Demo (example)")

    def test_import_conflicts_asked_once_each_and_cancel_changes_nothing(self):
        self._import("legacy_windows_presets.json", [("skip", False)])    # seed 3 new presets
        before = self.path.read_bytes()
        asked = []
        info, err = self._import("import_overlap.json",
                                 [("replace", False), ("cancel", False)], asked)
        self.assertEqual([a[0] for a in asked], ["Alpha hold", "Open ended"])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(info.call_args[0][0], "Import cancelled")

    def test_import_apply_to_all_asks_only_once(self):
        self._import("legacy_windows_presets.json", [("skip", False)])
        asked = []
        info, _ = self._import("import_overlap.json", [("replace", True)], asked)
        self.assertEqual(len(asked), 1)
        self.assertEqual(info.call_args[0][1], "2 added, 2 replaced, 0 skipped.")
        self.assertEqual(self.app.store.get("Alpha hold").name, "Alpha REPLACED")

    def test_import_replacing_the_selected_preset_refreshes_the_form(self):
        self._import("legacy_windows_presets.json", [("skip", False)])
        self.app._select_preset("Alpha hold")
        self.assertEqual(self.app.vars["name"].get(), "Alpha")
        self._import("import_overlap.json", [("replace", True)])
        self.assertEqual(self.app.vars["name"].get(), "Alpha REPLACED")
        self.assertEqual(self.app.dirty_label.cget("text"), "")

    def test_import_bad_file_changes_nothing(self):
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text('{"version": 2, "presets": {}}')
        before = self.path.exists() and self.path.read_bytes()
        with mock.patch.object(ui.filedialog, "askopenfilename", return_value=str(bad)), \
                mock.patch.object(ui.messagebox, "showerror") as err:
            self.app.preset_import()
        self.assertIn("format version 2", err.call_args[0][1])
        self.assertIn("Nothing was changed", err.call_args[0][1])
        self.assertEqual(self.app.store.names(), ["Demo (example)"])
        self.assertEqual(self.path.exists() and self.path.read_bytes(), before)

    def test_import_failed_save_keeps_presets(self):
        with mock.patch("os.replace", side_effect=PermissionError(13, "Access is denied")):
            _info, err = self._import("export_all.json", [("skip", False)])
        err.assert_called_once()
        self.assertEqual(self.app.store.names(), ["Demo (example)"])

    def test_export_all_and_selected_then_reimport(self):
        self._import("export_all.json", [("skip", False)])
        out = Path(self.tmp.name) / "out.json"
        with mock.patch.object(ui.filedialog, "asksaveasfilename", return_value=str(out)) as save, \
                mock.patch.object(ui.messagebox, "askyesnocancel", return_value=True), \
                mock.patch.object(ui.messagebox, "showinfo"):
            self.app.preset_export()
        self.assertTrue(save.call_args[1]["initialfile"].startswith("exercise-timer-presets-"))
        from exercise_timer.transfer import parse_import
        self.assertEqual(list(parse_import(out.read_bytes())), self.app.store.names())
        self.app._select_preset("Open ended")
        with mock.patch.object(ui.filedialog, "asksaveasfilename", return_value=str(out)) as save, \
                mock.patch.object(ui.messagebox, "askyesnocancel", return_value=False), \
                mock.patch.object(ui.messagebox, "showinfo"):
            self.app.preset_export()
        self.assertEqual(save.call_args[1]["initialfile"], "exercise-timer-Open-ended.json")
        self.assertEqual(list(parse_import(out.read_bytes())), ["Open ended"])

    def test_export_cancelled_dialog_writes_nothing(self):
        with mock.patch.object(ui.filedialog, "asksaveasfilename", return_value=""), \
                mock.patch.object(ui.messagebox, "showinfo") as info:
            self.app.preset_export()
        info.assert_not_called()

    def test_import_export_buttons_locked_during_run(self):
        self.set_fields(get_ready="0")
        self.app.start()
        names = [str(b.cget("text")) for b in self.app.preset_buttons]
        self.assertIn("Import file…", names)
        self.assertTrue(all(str(b.cget("state")) == "disabled" for b in self.app.preset_buttons))

    def test_write_failure_is_reported(self):
        self.set_fields(name="X")
        with mock.patch.object(ui.simpledialog, "askstring", return_value="X"), \
                mock.patch("os.replace", side_effect=PermissionError(13, "Access is denied")), \
                mock.patch.object(ui.messagebox, "showerror") as err:
            self.app.preset_save_as()
        err.assert_called_once()
        self.assertIn("Could not save presets", err.call_args[0][1])


if __name__ == "__main__":
    unittest.main()
