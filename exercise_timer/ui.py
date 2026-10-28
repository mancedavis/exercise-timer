"""tkinter interface. All timing decisions live in engine.Engine; this module
polls it with `after`, draws the display, and manages settings and presets."""
import time
import tkinter as tk
from tkinter import font as tkfont
from tkinter import filedialog, messagebox, simpledialog

from .engine import COMPLETE, MAX_NAME, Engine, Settings, parse_settings
from .sound import Sound
from .store import PresetStore, StoreError
from .transfer import (MAX_BYTES, ImportFileError, export_filename, export_text,
                       parse_import, summary)

TICK_MS = 40
FONT = "Segoe UI"
BG, PANEL, FG, DIM, ERR = "#000000", "#181818", "#ffffff", "#9aa0a6", "#ff6b6b"
PHASE_COLORS = {
    "idle": "#cfd8dc", "get_ready": "#ffd23f", "hold": "#39ff7a",
    "rep_break": "#ff9f1c", "set_rest": "#4cc9f0", "complete": "#ffd700",
    "paused": "#ff7ae0",
}


def layout_metrics(width, height):
    """Pixel font sizes for the display canvas, proportional to its height.
    At a 1920x1080 full screen (about 900-1000 px of canvas) the rep numeral
    is roughly 290-320 px and the timer 120-135 px."""
    h = max(height, 100)
    return {
        "name": 0.055 * h, "set": 0.04 * h, "phase": 0.06 * h,
        "numeral": 0.32 * h, "total": 0.10 * h, "caption": 0.04 * h,
        "timer": 0.135 * h, "suffix": 0.06 * h, "banner": 0.045 * h,
    }


class App:
    def __init__(self, root, store=None, clock=time.monotonic, sound=None):
        self.root = root
        self.clock = clock
        self.store = store or PresetStore()
        self.sound = sound or Sound()
        self.sound.enabled = self.store.sound
        self.engine = None
        self.preview = Engine(Settings(), clock)
        self.current = None            # name of the selected preset
        self._after_id = None
        self._drawn = None
        self._fonts = {}
        self.fullscreen = False
        self._build()
        self._select_preset(self.store.last, save=False)
        self._refresh_preview()
        self._render()
        self._sync_controls()
        if self.store.notice:
            self._warn(self.store.notice)
        self._bind_keys()
        root.protocol("WM_DELETE_WINDOW", self.close)

    # ----- construction --------------------------------------------------
    def _build(self):
        root = self.root
        root.title("Exercise Timer")
        root.configure(bg=BG)
        self.scale = scale = float(root.tk.call("tk", "scaling")) / 1.3333
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{min(int(1180 * scale), int(.92 * sw))}x"
                      f"{min(int(760 * scale), int(.88 * sh))}")
        root.minsize(min(int(900 * scale), int(.92 * sw)), min(int(600 * scale), int(.88 * sh)))
        base = tkfont.nametofont("TkDefaultFont")
        base.configure(family=FONT, size=11)
        root.option_add("*Font", base)
        root.columnconfigure(1, weight=1)
        root.rowconfigure(0, weight=1)

        self.panel_outer = tk.Frame(root, bg=PANEL)
        self.panel_outer.grid(row=0, column=0, sticky="ns")
        self._build_panel(self.panel_outer)

        main = tk.Frame(root, bg=BG)
        main.grid(row=0, column=1, sticky="nsew")
        main.rowconfigure(0, weight=1)
        main.columnconfigure(0, weight=1)
        self.canvas = tk.Canvas(main, bg=BG, highlightthickness=0)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.canvas.bind("<Configure>", lambda e: self._render(force=True))

        bar = tk.Frame(main, bg=BG)
        bar.grid(row=1, column=0, sticky="ew", padx=8, pady=(0, 8))
        big = tkfont.Font(family=FONT, size=14, weight="bold")
        self.buttons = {}
        # two rows of up to three, so nothing clips with the panel open
        for i, (key, text, cmd) in enumerate((
                ("start", "Start", self.start),
                ("pause", "Pause", self.pause_resume),
                ("stop", "Stop / Reset", self.stop),
                ("finish", "Finish Rep (N)", self.finish_rep),
                ("end", "End Set (E)", self.end_set))):
            b = tk.Button(bar, text=text, command=cmd, font=big, takefocus=0,
                          padx=6, pady=8, bg="#2b2b2b", fg=FG, activebackground="#444",
                          activeforeground=FG, disabledforeground="#666", relief="flat")
            b.grid(row=i // 3, column=i % 3, sticky="ew", padx=3, pady=3)
            self.buttons[key] = b
        for col in range(3):
            bar.columnconfigure(col, weight=1, uniform="b")
        small = tk.Frame(bar, bg=BG)
        small.grid(row=1, column=2, sticky="e", padx=3)
        for text, cmd in (("Settings panel", self.toggle_panel),
                          ("Full screen (F11)", self.toggle_fullscreen)):
            tk.Button(small, text=text, command=cmd, takefocus=0, bg="#222", fg=FG,
                      activebackground="#444", activeforeground=FG, relief="flat",
                      padx=8, pady=3).pack(side="left", padx=3)

    def _build_panel(self, outer):
        canvas = tk.Canvas(outer, bg=PANEL, highlightthickness=0, width=int(330 * self.scale))
        scroll = tk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        p = tk.Frame(canvas, bg=PANEL)
        window = canvas.create_window(0, 0, window=p, anchor="nw")
        def fit_panel(_e=None):   # grow to the content so scaled fonts never clip
            canvas.configure(scrollregion=canvas.bbox("all"),
                             width=max(int(330 * self.scale), p.winfo_reqwidth()))
        p.bind("<Configure>", fit_panel)
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window, width=e.width))
        for w in (canvas, p):
            w.bind("<MouseWheel>", lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))

        def label(text, row, **kw):
            tk.Label(p, text=text, bg=PANEL, fg=kw.pop("fg", FG), anchor="w", **kw).grid(
                row=row, column=0, columnspan=3, sticky="ew", padx=10, pady=(8, 0))

        v = self.vars = {
            "name": tk.StringVar(), "sets": tk.StringVar(), "reps": tk.StringVar(),
            "hold": tk.StringVar(), "rep_break": tk.StringVar(), "rest": tk.StringVar(),
            "get_ready": tk.StringVar(),
            "sets_enabled": tk.BooleanVar(), "reps_enabled": tk.BooleanVar(),
            "hold_enabled": tk.BooleanVar(), "rest_enabled": tk.BooleanVar(),
        }
        for var in v.values():
            var.trace_add("write", lambda *a: self._settings_changed())
        self.entries, self.checks = {}, {}

        def entry(key, row, toggle=None, text=""):
            if toggle:
                c = tk.Checkbutton(p, text=text, variable=v[toggle], bg=PANEL, fg=FG,
                                   selectcolor="#333", activebackground=PANEL,
                                   activeforeground=FG, disabledforeground="#777",
                                   takefocus=0, anchor="w")
                c.grid(row=row, column=0, columnspan=2, sticky="w", padx=(10, 0))
                self.checks[toggle] = c
            else:
                tk.Label(p, text=text, bg=PANEL, fg=FG, anchor="w").grid(
                    row=row, column=0, columnspan=2, sticky="w", padx=(10, 0))
            e = tk.Entry(p, textvariable=v[key], width=6, justify="right",
                         bg="#2b2b2b", fg=FG, insertbackground=FG,
                         disabledbackground="#1f1f1f", disabledforeground="#777",
                         relief="flat")
            e.grid(row=row, column=2, sticky="e", padx=10, pady=3)
            self.entries[key] = (e, toggle)

        label("PRESETS", 0, fg=DIM)
        lf = tk.Frame(p, bg=PANEL)
        lf.grid(row=1, column=0, columnspan=3, sticky="ew", padx=10)
        self.listbox = tk.Listbox(lf, height=5, exportselection=False, bg="#2b2b2b", fg=FG,
                                  selectbackground="#3a7bd5", relief="flat", activestyle="none")
        sb = tk.Scrollbar(lf, command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=sb.set)
        self.listbox.pack(side="left", fill="x", expand=True)
        sb.pack(side="right", fill="y")
        self.listbox.bind("<<ListboxSelect>>", self._on_list_select)
        bf = tk.Frame(p, bg=PANEL)
        bf.grid(row=2, column=0, columnspan=3, sticky="ew", padx=10, pady=4)
        self.preset_buttons = []
        for text, cmd in (("Save", self.preset_save), ("Save as…", self.preset_save_as),
                          ("Rename…", self.preset_rename), ("Delete", self.preset_delete)):
            b = tk.Button(bf, text=text, command=cmd, takefocus=0, bg="#2b2b2b", fg=FG,
                          activebackground="#444", activeforeground=FG,
                          disabledforeground="#666", relief="flat", padx=4)
            b.pack(side="left", padx=2)
            self.preset_buttons.append(b)
        bf2 = tk.Frame(p, bg=PANEL)
        bf2.grid(row=3, column=0, columnspan=3, sticky="ew", padx=10)
        for text, cmd in (("Import file…", self.preset_import), ("Export file…", self.preset_export)):
            b = tk.Button(bf2, text=text, command=cmd, takefocus=0, bg="#2b2b2b", fg=FG,
                          activebackground="#444", activeforeground=FG,
                          disabledforeground="#666", relief="flat", padx=4)
            b.pack(side="left", padx=2)
            self.preset_buttons.append(b)
        self.dirty_label = tk.Label(p, text="", bg=PANEL, fg="#ffd23f", anchor="w")
        self.dirty_label.grid(row=4, column=1, columnspan=2, sticky="e", padx=10)  # shares the EXERCISE header cell

        label("EXERCISE", 4, fg=DIM)
        tk.Label(p, text="Name", bg=PANEL, fg=FG).grid(row=5, column=0, sticky="w", padx=10)
        ne = tk.Entry(p, textvariable=v["name"], width=18, bg="#2b2b2b", fg=FG,
                      insertbackground=FG, disabledbackground="#1f1f1f",
                      disabledforeground="#777", relief="flat")
        ne.grid(row=5, column=1, columnspan=2, sticky="ew", padx=10, pady=3)
        self.entries["name"] = (ne, None)
        entry("sets", 6, "sets_enabled", "Sets")
        entry("reps", 7, "reps_enabled", "Reps per set")
        entry("hold", 8, "hold_enabled", "Hold seconds / rep")
        entry("rep_break", 9, None, "Rep break (s)")
        entry("rest", 10, "rest_enabled", "Set rest (s)")
        entry("get_ready", 11, None, "Get ready (s)")

        self.sound_var = tk.BooleanVar(value=self.store.sound)
        tk.Checkbutton(p, text="Sound cues", variable=self.sound_var, command=self._sound_toggled,
                       bg=PANEL, fg=FG, selectcolor="#333", activebackground=PANEL,
                       activeforeground=FG, takefocus=0).grid(
            row=12, column=0, columnspan=3, sticky="w", padx=10, pady=(8, 0))
        wrap = int(290 * self.scale)
        self.msg = tk.Label(p, text="", bg=PANEL, fg=ERR, anchor="w", justify="left",
                            wraplength=wrap)
        self.msg.grid(row=13, column=0, columnspan=3, sticky="ew", padx=10, pady=8)
        self.lock_note = tk.Label(p, text="", bg=PANEL, fg=DIM, anchor="w", justify="left",
                                  wraplength=wrap)
        self.lock_note.grid(row=14, column=0, columnspan=3, sticky="ew", padx=10)

    def _bind_keys(self):
        r = self.root
        r.bind_all("<space>", lambda e: self._shortcut(self.space))
        for k in "nN":
            r.bind_all(f"<KeyPress-{k}>", lambda e: self._shortcut(self.finish_rep))
        for k in "eE":
            r.bind_all(f"<KeyPress-{k}>", lambda e: self._shortcut(self.end_set))
        r.bind_all("<F11>", lambda e: self._own(e) and self.toggle_fullscreen())
        r.bind_all("<Escape>", lambda e: self._own(e) and self.toggle_fullscreen(False))
        # clicking anywhere that is not a text field hands the keyboard back to the shortcuts
        r.bind_all("<Button-1>", lambda e: self._own(e) and not isinstance(
            e.widget, (tk.Entry, tk.Listbox)) and r.focus_set(), add="+")
        for entry, _toggle in self.entries.values():
            entry.bind("<Return>", lambda e: r.focus_set())

    def _own(self, event):
        """True for events in the main window (not a dialog)."""
        try:
            return event.widget.winfo_toplevel() is self.root
        except (AttributeError, KeyError, tk.TclError):
            return False

    def _typing(self):
        try:
            return isinstance(self.root.focus_get(), (tk.Entry, tk.Listbox, tk.Text))
        except KeyError:
            return False

    def _shortcut(self, action):
        if self._typing():
            return None
        action()
        return "break"

    # ----- settings <-> widgets ------------------------------------------
    def _raw(self):
        return {k: v.get() for k, v in self.vars.items()}

    def _load(self, s):
        for k, v in s.to_dict().items():
            self.vars[k].set(v)

    def _locked(self):
        return self.engine is not None and self.engine.phase != COMPLETE

    def _apply_lock(self):
        locked = self._locked()
        for key, (entry, toggle) in self.entries.items():
            on = not locked and (toggle is None or self.vars[toggle].get())
            entry.configure(state="normal" if on else "disabled")
        for c in self.checks.values():
            c.configure(state="disabled" if locked else "normal")
        for b in self.preset_buttons:
            b.configure(state="disabled" if locked else "normal")
        self.listbox.configure(state="disabled" if locked else "normal")
        self.lock_note.configure(text="Settings are locked during a run. "
                                      "Press Stop / Reset to edit." if locked else "")

    def _settings_changed(self):
        if not self._locked():
            self._apply_lock()   # entries follow their enable checkboxes
            self._refresh_preview()
            self._update_dirty()
            self._render()

    def _refresh_preview(self):
        try:
            self.preview = Engine(parse_settings(self._raw()), self.clock)
            self.msg.configure(text="")
        except ValueError:
            pass   # keep the last valid preview; Start will explain the problem

    def _update_dirty(self):
        dirty = False
        if self.current in self.store.presets:
            try:
                dirty = parse_settings(self._raw()) != self.store.get(self.current)
            except ValueError:
                dirty = True
        self.dirty_label.configure(text="• unsaved changes" if dirty else "")

    # ----- commands ------------------------------------------------------
    def space(self):
        e = self.engine
        if e is None or not e.active:
            self.start()
        else:
            self.pause_resume()

    def start(self):
        if self.engine is not None and self.engine.active:
            return
        try:
            settings = parse_settings(self._raw())
        except ValueError as err:
            self.msg.configure(text=str(err))
            return
        self.msg.configure(text="")
        self.sound.cancel()
        self.engine = Engine(settings, self.clock)
        self.engine.start()
        self.root.focus_set()
        self._apply_lock()
        self._tick()

    def pause_resume(self):
        e = self.engine
        if e is None or not e.active:
            return
        if e.paused:
            e.resume()
            self._tick()
        else:
            e.pause()
            self._tick()   # plays/handles anything pause() just caught up; won't reschedule

    def finish_rep(self):
        if self.engine and self.engine.finish_rep():
            self._tick()

    def end_set(self):
        if self.engine and self.engine.end_set():
            self._tick()

    def stop(self):
        self._cancel_tick()
        self.sound.cancel()
        if self.engine:
            self.engine.stop()
        self.engine = None
        self.root.focus_set()
        self._apply_lock()
        self._refresh_preview()
        self._render()
        self._sync_controls()

    def close(self):
        self._cancel_tick()
        self.sound.close()
        self.root.destroy()

    def toggle_panel(self):
        if self.panel_outer.winfo_ismapped():
            self.panel_outer.grid_remove()
        else:
            self.panel_outer.grid()

    def toggle_fullscreen(self, on=None):
        self.fullscreen = (not self.fullscreen) if on is None else on
        self.root.attributes("-fullscreen", self.fullscreen)

    # ----- tick loop -----------------------------------------------------
    def _cancel_tick(self):
        if self._after_id is not None:
            self.root.after_cancel(self._after_id)
            self._after_id = None

    def _tick(self):
        self._cancel_tick()                  # never two loops at once
        e = self.engine
        if e is None:
            return
        e.update()
        self._play(e.pop_events())
        self._render()
        self._sync_controls()
        if e.phase == COMPLETE:
            self._apply_lock()               # run over: settings editable again
        elif e.active and not e.paused:
            self._after_id = self.root.after(TICK_MS, self._tick)

    def _play(self, events):
        for cue in ("complete", "hold_start", "hold_end"):   # one cue per tick
            if cue in events:
                self.sound.play(cue)
                return

    def _sync_controls(self):
        e = self.engine
        active = bool(e and e.active)
        state = lambda ok: "normal" if ok else "disabled"
        b = self.buttons
        b["start"].configure(state=state(not active))
        b["pause"].configure(state=state(active),
                             text="Resume" if active and e.paused else "Pause")
        b["stop"].configure(state=state(e is not None))
        b["finish"].configure(state=state(bool(e and e.can_finish_rep)))
        b["end"].configure(state=state(bool(e and e.can_end_set)))

    def _sound_toggled(self):
        self.sound.enabled = self.sound_var.get()
        if not self.sound.enabled:
            self.sound.cancel()
        self._save(lambda: self.store.set_sound(self.sound.enabled))

    # ----- presets -------------------------------------------------------
    def _warn(self, text):
        messagebox.showwarning("Exercise Timer", text, parent=self.root)

    def _save(self, action):
        try:
            action()
            return True
        except StoreError as err:
            messagebox.showerror("Could not save", str(err), parent=self.root)
            return False

    def _refresh_list(self):
        self.listbox.configure(state="normal")
        self.listbox.delete(0, "end")
        for n in self.store.names():
            self.listbox.insert("end", n)
        if self.current in self.store.presets:
            i = self.store.names().index(self.current)
            self.listbox.selection_set(i)
            self.listbox.see(i)
        self._apply_lock()

    def _select_preset(self, name, save=True):
        self.current = name if name in self.store.presets else None
        if self.current:
            self._load(self.store.get(self.current))
            if save:
                self._save(lambda: self.store.set_last(self.current))
        self._refresh_list()
        self._update_dirty()

    def _on_list_select(self, _event):
        sel = self.listbox.curselection()
        if sel and not self._locked():
            self._select_preset(self.listbox.get(sel[0]))
        self.root.focus_set()

    def _parse_or_complain(self):
        try:
            return parse_settings(self._raw())
        except ValueError as err:
            self.msg.configure(text=str(err))
            return None

    def preset_save(self):
        s = self._parse_or_complain()
        if s is None:
            return
        if self.current is None:
            return self.preset_save_as()
        self._save(lambda: self.store.put(self.current, s))
        self._select_preset(self.current, save=False)

    def _ask_name(self, title, initial):
        name = simpledialog.askstring("Exercise Timer", title, initialvalue=initial,
                                      parent=self.root)
        name = name.strip() if name else ""
        if len(name) > MAX_NAME:
            self.msg.configure(text=f"Preset names can be up to {MAX_NAME} characters.")
            return None
        return name or None

    def _confirm_replace(self, name):
        return messagebox.askyesno("Replace preset?", f'A preset named "{name}" already '
                                   "exists. Replace it?", parent=self.root)

    def preset_save_as(self):
        s = self._parse_or_complain()
        if s is None:
            return
        name = self._ask_name("Name for the new preset:", s.name)
        if not name:
            return
        clash = self.store.find(name)
        if clash and not self._confirm_replace(clash):
            return
        self._save(lambda: self.store.put(name, s))
        self._select_preset(name.strip(), save=False)

    def preset_rename(self):
        if self.current is None:
            return
        name = self._ask_name("New name for this preset:", self.current)
        if not name or name == self.current:
            return
        clash = self.store.find(name)
        if clash and clash != self.current and not self._confirm_replace(clash):
            return
        self._save(lambda: self.store.rename(self.current, name))
        self._select_preset(name, save=False)

    def preset_delete(self):
        if self.current is None:
            return
        if not messagebox.askyesno("Delete preset?", f'Delete "{self.current}"?',
                                   parent=self.root):
            return
        self._save(lambda: self.store.delete(self.current))
        self._select_preset(self.store.last, save=False)

    # ----- import / export ----------------------------------------------
    def preset_export(self):
        names = self.store.names()
        if not names:
            return
        only = None
        if self.current in self.store.presets and len(names) > 1:
            answer = messagebox.askyesnocancel(
                "Export presets",
                f"Export all {len(names)} presets?\n\nYes = all presets\n"
                f'No = only "{self.current}"', parent=self.root)
            if answer is None:
                return
            only = None if answer else self.current
        chosen = {only: self.store.get(only)} if only else {n: self.store.get(n) for n in names}
        path = filedialog.asksaveasfilename(
            parent=self.root, title="Export presets", defaultextension=".json",
            filetypes=[("JSON files", "*.json")],
            initialfile=export_filename(only, time.strftime("%Y%m%d")))
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(export_text(chosen))
        except OSError as err:
            messagebox.showerror("Could not export", f"Could not write the file: "
                                 f"{err.strerror or err}", parent=self.root)
            return
        messagebox.showinfo("Export complete", f"Saved {len(chosen)} preset(s) to:\n{path}",
                            parent=self.root)

    def preset_import(self):
        path = filedialog.askopenfilename(
            parent=self.root, title="Import presets",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")])
        if not path:
            return
        try:
            with open(path, "rb") as f:
                raw = f.read(MAX_BYTES + 1)
            entries = parse_import(raw)
        except OSError as err:
            messagebox.showerror("Could not import", f"Could not read the file: "
                                 f"{err.strerror or err}", parent=self.root)
            return
        except ImportFileError as err:
            messagebox.showerror("Could not import", f"{err}\n\nNothing was changed.",
                                 parent=self.root)
            return
        _added, conflicts = self.store.plan_import(entries)
        was_dirty = bool(self.dirty_label.cget("text"))
        decisions, remembered = {}, None
        for i, (incoming, existing) in enumerate(conflicts):
            if remembered:
                choice = remembered
            else:
                choice, every = self._ask_conflict(existing, len(conflicts) - i - 1)
                remembered = choice if every and choice != "cancel" else None
            if choice == "cancel":
                messagebox.showinfo("Import cancelled", "Nothing was changed.", parent=self.root)
                return
            decisions[incoming] = choice
        try:
            counts = self.store.apply_import(entries, decisions)
        except StoreError as err:
            messagebox.showerror("Could not import", f"{err}\n\nYour presets were not changed.",
                                 parent=self.root)
            return
        self._refresh_list()
        if not was_dirty and self.current in self.store.presets:
            self._load(self.store.get(self.current))   # the selected preset may have just been replaced
        self._update_dirty()
        messagebox.showinfo("Import complete", summary(*counts) + ".", parent=self.root)

    def _ask_conflict(self, name, more):
        """-> ("replace" | "skip" | "cancel", apply to the remaining conflicts too)"""
        dlg = tk.Toplevel(self.root)
        dlg.title("Preset already exists")
        dlg.configure(bg=PANEL)
        dlg.transient(self.root)
        result = {"choice": "cancel"}
        every = tk.BooleanVar(value=False)
        tk.Label(dlg, text=f'A preset named "{name}" already exists.\nReplace it with the '
                 "imported one?", bg=PANEL, fg=FG, justify="left").pack(padx=16, pady=(14, 8))
        if more:
            tk.Checkbutton(dlg, text=f"Do this for the other {more} too", variable=every,
                           bg=PANEL, fg=FG, selectcolor="#333", activebackground=PANEL,
                           activeforeground=FG).pack(padx=16)
        row = tk.Frame(dlg, bg=PANEL)
        row.pack(padx=16, pady=14)

        def choose(c):
            result["choice"] = c
            dlg.destroy()
        for text, c in (("Replace", "replace"), ("Skip", "skip"), ("Cancel import", "cancel")):
            tk.Button(row, text=text, command=lambda c=c: choose(c), padx=10).pack(
                side="left", padx=4)
        dlg.protocol("WM_DELETE_WINDOW", lambda: choose("cancel"))
        dlg.bind("<Escape>", lambda e: choose("cancel"))
        dlg.grab_set()
        dlg.wait_window()
        return result["choice"], every.get()

    # ----- drawing -------------------------------------------------------
    def _font(self, px, weight="bold"):
        key = (max(8, int(px)), weight)
        if key not in self._fonts:
            self._fonts[key] = tkfont.Font(family=FONT, size=-key[0], weight=key[1])
        return self._fonts[key]

    def _group(self, c, y, main, main_px, side, side_px, color, max_w, cx):
        """Draw a big value with a smaller suffix to its right, centred as a
        pair and shrunk until it fits `max_w`. Baselines are aligned."""
        k = 1.0
        while True:
            fm, fs = self._font(main_px * k), self._font(side_px * k)
            gap = fs.measure(" ") * 2 if side else 0
            total = fm.measure(main) + gap + (fs.measure(side) if side else 0)
            if total <= max_w or k < 0.15:
                break
            k *= 0.92
        x = cx - total / 2
        base = y + 0.36 * abs(fm.cget("size"))   # digits are ~0.72 em tall, centred on y
        c.create_text(x, base + fm.metrics("descent"), text=main, font=fm, fill=color, anchor="sw")
        if side:
            c.create_text(x + fm.measure(main) + gap, base + fs.metrics("descent"),
                          text=side, font=fs, fill=DIM if color == FG else color, anchor="sw")

    def _render(self, force=False):
        c = self.canvas
        w, h = c.winfo_width(), c.winfo_height()
        if w < 50 or h < 50:
            return
        src = self.engine or self.preview
        d = src.display()
        if not force and self._drawn == (d, w, h):
            return
        self._drawn = (d, w, h)
        m = layout_metrics(w, h)
        color = PHASE_COLORS[d.phase_key]
        cx = w / 2
        c.delete("all")

        def text(y, s, key, fill=FG, weight="bold"):
            f = self._font(m[key], weight)
            k = 1.0
            while f.measure(s) > w * 0.96 and k > 0.2:   # long names shrink to fit
                k *= 0.9
                f = self._font(m[key] * k, weight)
            c.create_text(cx, h * y, text=s, font=f, fill=fill)

        text(0.05, d.name, "name")
        text(0.115, d.set_text, "set", DIM, "normal")
        # phase chip: text label plus colour
        f = self._font(m["phase"])
        tw, th = f.measure(d.phase_label), f.metrics("linespace")
        c.create_rectangle(cx - tw / 2 - th * 0.6, h * 0.19 - th * 0.55,
                           cx + tw / 2 + th * 0.6, h * 0.19 + th * 0.55, fill=color, outline="")
        c.create_text(cx, h * 0.19, text=d.phase_label, font=f, fill=BG)
        self._group(c, h * 0.43, d.rep_text, m["numeral"], d.rep_total_text, m["total"],
                    color if d.phase_key != "hold" else FG, w * 0.94, cx)
        text(0.665, d.rep_caption, "caption", color)
        if d.phase_key == "complete":
            text(0.79, d.timer_text, "timer", color)
        else:
            self._group(c, h * 0.79, d.timer_text, m["timer"], d.timer_suffix, m["suffix"],
                        color, w * 0.94, cx)
        text(0.93, d.banner, "banner", FG, "normal")


def run():
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()
