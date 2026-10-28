"""Preset interchange files shared with the web app (see docs/ and README).

File format (version 1) is the same shape as the Windows presets.json, so a
full presets.json can be imported directly and exports can be read by both
apps:

    {"version": 1, "presets": {"<preset name>": {<11 settings fields>}}}

Anything else at the top level (sound, last, ...) is ignored on import."""
import json
import re
import unicodedata

from .engine import MAX_COUNT, MAX_NAME, MAX_SECONDS, Settings

FORMAT_VERSION = 1
MAX_BYTES = 256 * 1024
MAX_PRESETS = 500

# field, label, minimum, maximum (None = boolean)
FIELDS = (
    ("sets_enabled", "Sets on/off", None, None), ("sets", "Sets", 1, MAX_COUNT),
    ("reps_enabled", "Reps on/off", None, None), ("reps", "Reps per set", 1, MAX_COUNT),
    ("hold_enabled", "Hold on/off", None, None), ("hold", "Hold seconds", 1, MAX_SECONDS),
    ("rep_break", "Rep break", 0, MAX_SECONDS),
    ("rest_enabled", "Set rest on/off", None, None), ("rest", "Set rest", 0, MAX_SECONDS),
    ("get_ready", "Get-ready", 0, MAX_SECONDS),
)


class ImportFileError(ValueError):
    """The chosen file cannot be imported; the message is safe to show."""


def fold(name):
    """Case-insensitive comparison key used for preset names on both platforms."""
    return unicodedata.normalize("NFC", name).lower()


def _no_duplicate_keys(pairs):
    seen = set()
    for key, _ in pairs:
        if key in seen:
            raise ImportFileError(f'The file lists "{key}" more than once.')
        seen.add(key)
    return dict(pairs)


def _bad_constant(_):
    raise ImportFileError("That is not a valid JSON preset file.")


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _preset(name, raw):
    where = f'Preset "{name}"'
    if not isinstance(raw, dict):
        raise ImportFileError(f"{where} is not a set of settings.")
    ex = raw.get("name")
    if not isinstance(ex, str) or not ex.strip() or ex != ex.strip() or len(ex) > MAX_NAME:
        raise ImportFileError(f"{where} has an invalid exercise name.")
    values = {"name": ex}
    for key, label, lo, hi in FIELDS:
        v = raw.get(key)
        if lo is None:
            if not isinstance(v, bool):
                raise ImportFileError(f"{where}: {label} must be true or false.")
        elif not _is_int(v) or not lo <= v <= hi:
            raise ImportFileError(f"{where}: {label} must be a whole number, {lo} to {hi}.")
        values[key] = v
    return Settings(**values)


def parse_import(raw):
    """Validate a whole file (bytes) and return {preset name: Settings}.

    Raises ImportFileError before anything is changed anywhere."""
    if len(raw) > MAX_BYTES:
        raise ImportFileError("That file is too large to be a preset file (limit 256 KB).")
    try:
        text = raw.decode("utf-8-sig")
        data = json.loads(text, object_pairs_hook=_no_duplicate_keys,
                          parse_constant=_bad_constant)
    except ImportFileError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ImportFileError("That is not a valid JSON preset file.") from None
    if not isinstance(data, dict) or not isinstance(data.get("presets"), dict):
        raise ImportFileError("That file does not contain Exercise Timer presets.")
    version = data.get("version")
    if not _is_int(version):
        raise ImportFileError("That file has no format version, so it cannot be imported.")
    if version != FORMAT_VERSION:
        raise ImportFileError(
            f"That file uses format version {version}; this app reads version "
            f"{FORMAT_VERSION}." + (" Update the app and try again." if version > 1 else ""))
    presets = data["presets"]
    if not presets:
        raise ImportFileError("That file contains no presets.")
    if len(presets) > MAX_PRESETS:
        raise ImportFileError(f"That file has too many presets (limit {MAX_PRESETS}).")
    result, folded = {}, set()
    for name, body in presets.items():
        if not name.strip() or name != name.strip() or len(name) > MAX_NAME:
            raise ImportFileError("The file has a preset with a blank or over-long name.")
        key = fold(name)
        if key in folded:
            raise ImportFileError(f'The file lists "{name}" more than once (names ignore case).')
        folded.add(key)
        result[name] = _preset(name, body)
    return result


def export_text(presets):
    """presets: {name: Settings} in the order to write."""
    return json.dumps({"version": FORMAT_VERSION,
                       "presets": {n: s.to_dict() for n, s in presets.items()}}, indent=2) + "\n"


def export_filename(name=None, today="19700101"):
    """today is passed in (YYYYMMDD) so the result is testable."""
    if name is None:
        return f"exercise-timer-presets-{today}.json"
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-")[:40] or "preset"
    return f"exercise-timer-{safe}.json"


def summary(added, replaced, skipped):
    return f"{added} added, {replaced} replaced, {skipped} skipped"
