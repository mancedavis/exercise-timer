import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from exercise_timer.engine import COMPLETE, Engine, Settings
from exercise_timer.store import DEMO_NAME, PresetStore, StoreError
from exercise_timer.transfer import (ImportFileError, export_filename, export_text,
                                     parse_import, summary)

FIX = Path(__file__).resolve().parent.parent / "fixtures"


def fixture(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def raw(name):
    return (FIX / name).read_bytes()


class ImportParsing(unittest.TestCase):
    def test_valid_files(self):
        for case in fixture("import_cases.json")["valid"]:
            with self.subTest(case["name"]):
                data = raw(case["file"]) if "file" in case else case["text"].encode()
                self.assertEqual(list(parse_import(data)), case["names"])

    def test_invalid_files_are_rejected_with_message(self):
        for case in fixture("import_cases.json")["invalid"]:
            with self.subTest(case["name"]), self.assertRaises(ImportFileError) as cm:
                parse_import(case["text"].encode("utf-8"))
            self.assertIn(case["error_contains"], str(cm.exception))

    def test_binary_oversize_and_too_many(self):
        for data, fragment in ((b"\xff\xfe\x00\x01", "not a valid JSON"),
                               (b"x" * (256 * 1024 + 1), "too large"),
                               (b"[" * 100000, "not a valid JSON")):
            with self.subTest(fragment), self.assertRaises(ImportFileError) as cm:
                parse_import(data)
            self.assertIn(fragment, str(cm.exception))
        ok = json.loads(raw("export_single.json"))["presets"]["Open ended"]
        many = {"version": 1, "presets": {f"p{i}": ok for i in range(501)}}
        with self.assertRaises(ImportFileError) as cm:
            parse_import(json.dumps(many).encode())
        self.assertIn("too many", str(cm.exception))

    def test_utf8_bom_is_accepted(self):
        self.assertEqual(len(parse_import(b"\xef\xbb\xbf" + raw("export_all.json"))), 4)

    def test_legacy_windows_file_roundtrips_every_field(self):
        legacy = fixture("legacy_windows_presets.json")
        parsed = parse_import(raw("legacy_windows_presets.json"))
        self.assertEqual({n: s.to_dict() for n, s in parsed.items()}, legacy["presets"])
        again = parse_import(export_text(parsed).encode())
        self.assertEqual(again, parsed)
        # disabled flags and the values behind them survive
        self.assertFalse(parsed["Alpha hold"].sets_enabled)
        self.assertEqual(parsed["Alpha hold"].sets, 2)
        self.assertFalse(parsed["Manual stopwatch"].hold_enabled)
        self.assertEqual(export_text(parsed), (FIX / "export_all.json").read_text(encoding="utf-8"))

    def test_export_has_no_preferences(self):
        data = json.loads(export_text(parse_import(raw("export_all.json"))))
        self.assertEqual(set(data), {"version", "presets"})

    def test_filenames(self):
        for c in fixture("export_filenames.json"):
            self.assertEqual(export_filename(c["name"], c["today"]), c["expect"])

    def test_summary(self):
        self.assertEqual(summary(3, 1, 2), "3 added, 1 replaced, 2 skipped")

    def test_markup_in_names_stays_text(self):
        evil = '<img src=x onerror=alert(1)>'
        doc = json.loads(raw("export_single.json"))
        doc["presets"] = {evil: {**doc["presets"]["Open ended"], "name": evil}}
        parsed = parse_import(json.dumps(doc).encode())
        self.assertEqual(list(parsed), [evil])
        self.assertEqual(parsed[evil].name, evil)   # stored verbatim, only ever drawn as text


class ImportIntoStore(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "presets.json"
        shutil.copy(FIX / "legacy_windows_presets.json", self.path)
        self.store = PresetStore(self.path)

    def test_conflict_scenarios(self):
        spec = fixture("conflict_scenarios.json")
        entries = parse_import(raw(spec["import_file"]))
        for case in spec["cases"]:
            with self.subTest(case["name"]):
                self.store = PresetStore(self.path)
                before_file = self.path.read_bytes()
                added, conflicts = self.store.plan_import(entries)
                self.assertEqual(added, ["New One", "Brand New 2"])
                self.assertEqual([c[0] for c in conflicts], ["alpha hold", "Open ended"])
                if case["cancel"]:      # the UI stops before apply_import; nothing may change
                    self.assertEqual(self.path.read_bytes(), before_file)
                else:
                    counts = self.store.apply_import(entries, case["decisions"])
                    self.assertEqual(summary(*counts), case["summary"])
                    reread = PresetStore(self.path)
                    self.assertEqual(self.store.names(), case["names"])
                    self.assertEqual(reread.names(), case["names"])
                    self.assertEqual({n: reread.get(n).name for n in reread.names()},
                                     case["exercise_names"])
                    self.path.write_bytes(before_file)

    def test_preferences_untouched(self):
        s = PresetStore(self.path)
        s.sound, s.last = True, DEMO_NAME
        s.apply_import(parse_import(raw("export_single.json")), {"Open ended": "skip"})
        again = PresetStore(self.path)
        self.assertTrue(again.sound)
        self.assertEqual(again.last, DEMO_NAME)

    def test_failed_save_leaves_everything_intact(self):
        before_names, before_file = self.store.names(), self.path.read_bytes()
        before_vals = dict(self.store.presets)
        entries = parse_import(raw("import_overlap.json"))
        with mock.patch("os.replace", side_effect=PermissionError(13, "Access is denied")):
            with self.assertRaises(StoreError):
                self.store.apply_import(entries, {"alpha hold": "replace", "Open ended": "replace"})
        self.assertEqual(self.store.names(), before_names)
        self.assertEqual(self.store.presets, before_vals)
        self.assertEqual(self.path.read_bytes(), before_file)

    def test_import_does_not_touch_a_running_engine(self):
        e = Engine(self.store.get("Open ended"))
        e.start()
        snapshot = e.s
        self.store.apply_import(parse_import(raw("import_overlap.json")),
                                {"alpha hold": "replace", "Open ended": "replace"})
        self.assertIs(e.s, snapshot)
        self.assertEqual(e.s.name, "Open set")


if __name__ == "__main__":
    unittest.main()
