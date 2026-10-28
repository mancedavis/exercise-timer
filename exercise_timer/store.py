"""Preset persistence: a small JSON file under %APPDATA%\\ExerciseTimer."""
import json
import os
import shutil
import time
from pathlib import Path

from .engine import Settings, parse_settings
from .transfer import fold

DEMO_NAME = "Demo (example)"
DEMO = Settings(name="Demo exercise (example only)")


class StoreError(Exception):
    """A save failed; the message is safe to show to the user."""


def default_path():
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "ExerciseTimer" / "presets.json"


class PresetStore:
    def __init__(self, path=None):
        self.path = Path(path) if path else default_path()
        self.sound = True
        self.last = None
        self.presets = {}
        self.notice = ""   # set when stored data had to be set aside
        self.load()

    # ----- loading -------------------------------------------------------
    def load(self):
        self.sound, self.last, self.presets, self.notice = True, None, {}, ""
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            text = None
        except (OSError, UnicodeDecodeError):
            self._set_aside(move=False)
            text = None
        if text is not None:
            try:
                data = json.loads(text)
                if not isinstance(data, dict) or not isinstance(data.get("presets", {}), dict):
                    raise ValueError
            except ValueError:
                self._set_aside(move=True)
            else:
                self._adopt(data)
        if not self.presets:
            self.presets[DEMO_NAME] = DEMO
        if self.last not in self.presets:
            self.last = next(iter(self.presets), None)

    def _adopt(self, data):
        self.sound = data.get("sound", True) is not False
        last = data.get("last")
        self.last = last if isinstance(last, str) else None
        dropped = 0
        for name, raw in data.get("presets", {}).items():
            try:
                if not isinstance(raw, dict) or not str(name).strip():
                    raise ValueError
                self.presets[str(name)] = parse_settings(raw)
            except ValueError:
                dropped += 1
        if dropped:
            self._set_aside(move=False)
            self.notice = (f"{dropped} damaged preset(s) were skipped. "
                           f"A copy of the original file was kept: {self.notice_path}")

    def _set_aside(self, move):
        """Keep a recoverable copy of a damaged presets file."""
        self.notice_path = self.path.with_name(
            f"{self.path.name}.bad-{time.strftime('%Y%m%d-%H%M%S')}")
        try:
            (os.replace if move else shutil.copy2)(self.path, self.notice_path)
            self.notice = (f"Your saved presets could not be read. A copy was kept at "
                           f"{self.notice_path}.")
        except OSError:
            self.notice = "Your saved presets could not be read and no copy could be made."

    # ----- saving --------------------------------------------------------
    def save(self):
        data = {"version": 1, "sound": self.sound, "last": self.last,
                "presets": {n: s.to_dict() for n, s in self.presets.items()}}
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except OSError as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise StoreError(f"Could not save presets to {self.path}: "
                             f"{e.strerror or e}. Changes are kept until you close the app.") from e

    # ----- operations (each saves; changes stay in memory if the save fails) --
    def names(self):
        return list(self.presets)

    def find(self, name):
        """Stored name matching `name` case-insensitively, or None."""
        wanted = fold(name.strip())
        return next((n for n in self.presets if fold(n) == wanted), None)

    def plan_import(self, entries):
        """-> (names that will be added, [(incoming name, existing name)] conflicts)"""
        added, conflicts = [], []
        for name in entries:
            existing = self.find(name)
            (conflicts.append((name, existing)) if existing else added.append(name))
        return added, conflicts

    def apply_import(self, entries, decisions):
        """Commit an import as one operation. `decisions` maps each conflicting
        incoming name to "replace" or "skip". Sound and last-selected are not
        touched. On a failed save the stored presets are left exactly as they
        were, in memory and on disk. Returns (added, replaced, skipped)."""
        before = dict(self.presets)
        merged = dict(before)
        added = replaced = skipped = 0
        for name, settings in entries.items():
            existing = self.find(name)
            if existing is None:
                merged[name] = settings
                added += 1
            elif decisions.get(name) == "replace":
                merged[existing] = settings
                replaced += 1
            else:
                skipped += 1
        self.presets = merged
        try:
            self.save()
        except StoreError:
            self.presets = before
            raise
        return added, replaced, skipped

    def get(self, name):
        return self.presets[name]

    def put(self, name, settings):
        """Create or replace. The caller has already confirmed any replacement."""
        existing = self.find(name)
        self._replace(existing, name.strip(), settings)
        self.last = name.strip()
        self.save()

    def rename(self, old, new):
        clash = self.find(new)
        settings = self.presets[old]
        if clash and clash != old:
            del self.presets[clash]
        self._replace(old, new.strip(), settings)
        self.last = new.strip()
        self.save()

    def _replace(self, old_key, new_key, settings):
        """Store under new_key, keeping the list position of old_key (if any)."""
        self.presets = {(new_key if k == old_key else k): (settings if k == old_key else v)
                        for k, v in self.presets.items()}
        self.presets.setdefault(new_key, settings)

    def delete(self, name):
        self.presets.pop(name, None)
        if self.last == name:
            self.last = next(iter(self.presets), None)
        self.save()

    def set_sound(self, on):
        self.sound = bool(on)
        self.save()

    def set_last(self, name):
        if name in self.presets and self.last != name:
            self.last = name
            self.save()
