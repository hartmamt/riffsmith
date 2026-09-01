#!/usr/bin/env python3
"""Mine palm-mute chug hits out of full DI guitar stems.

Usage:  python3 scripts/mine_chugs.py <stem.wav> [<stem2.wav> ...] --out <dir>
        [--tab-root b1] [--min-gap 0.12]

Finds percussive onsets, keeps hits that look like chugs (short decay, low
spectral content, enough isolation to extract cleanly), measures each hit's
level, and emits bank-convention files:  <tabroot>_v<1-3>_rr<n>.wav
Every candidate is reported; rejects say why. Input can be any sample rate /
bit depth WAV (mono or stereo); output is 16-bit 44.1k mono, onset-trimmed,
30ms tail fade, max 0.6s per hit.

Naming is TAB-pitch: pass --tab-root for the note these chugs represent in
GuitarScrobble (default b1 = Drop B low string). Measured audio pitch is
reported but not used for naming, since chugs are often power chords whose
tracked pitch is unreliable.
"""
import argparse, math, os, struct, subprocess, sys, tempfile, wave

SR = 44100

def load_mono(path: str):
    # normalize via afconvert (handles 24-bit, stereo, any rate)
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", "-c", "1", path, tmp],
                   check=True, capture_output=True)
    with wave.open(tmp) as w:
        n = w.getnframes()
        data = list(struct.unpack("<%dh" % n, w.readframes(n)))
    os.unlink(tmp)
    return data

def rms(s, a, b):
    seg = s[a:b] or [0]
    return math.sqrt(sum(v * v for v in seg) / len(seg))

def find_onsets(s, min_gap_s):
    # local-jump detector suited to continuous performances: an onset is a
    # window that jumps 1.7x above the quietest of the previous four windows
    win = int(0.005 * SR)
    envelope = [rms(s, i, i + win) for i in range(0, len(s) - win, win)]
    peak = max(envelope) or 1
    onsets = []
    last = -1e9
    for i in range(4, len(envelope)):
        lo = min(envelope[i - 4:i])
        t = i * win / SR
        if envelope[i] > lo * 1.7 and envelope[i] > peak * 0.06 and t - last > min_gap_s:
            onsets.append(i * win)
            last = t
    return onsets

def goertzel(seg, f):
    w0 = 2 * math.pi * f / SR
    c = 2 * math.cos(w0)
    s1 = s2 = 0
    for x in seg:
        s0 = x + c * s1 - s2
        s2 = s1
        s1 = s0
    return math.sqrt(max(s1 * s1 + s2 * s2 - c * s1 * s2, 0)) / len(seg)

NOTE_FREQS = {"b1": 61.74, "c2": 65.41, "db2": 69.30, "d2": 73.42, "eb2": 77.78, "e2": 82.41}

def note_of(s, onset):
    """Classify by harmonic-SERIES energy (guitar DI barely contains the
    fundamental of low notes — harmonics 2-4 carry the pitch)."""
    seg = s[onset + int(0.008 * SR):onset + int(0.008 * SR) + 6144]
    if len(seg) < 6144:
        return None
    scores = {k: sum(goertzel(seg, f * h) for h in (1, 2, 3, 4)) for k, f in NOTE_FREQS.items()}
    return max(scores, key=lambda k: scores[k])

def track_pitch(s, onset):
    a = onset + int(0.03 * SR)
    seg = s[a:a + 8192]
    if len(seg) < 8192:
        return 0.0
    best, bl = 0, 0
    for lag in range(SR // 250, SR // 25):
        acc = sum(seg[i] * seg[i + lag] for i in range(0, 4096, 4))
        if acc > best:
            best, bl = acc, lag
    return SR / bl if bl else 0.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stems", nargs="+")
    ap.add_argument("--out", default=os.path.expanduser("~/Downloads/subsist-pm-bank"))
    ap.add_argument("--tab-root", default="b1")
    ap.add_argument("--min-gap", type=float, default=0.12)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    hits = []
    for path in args.stems:
        s = load_mono(path)
        onsets = find_onsets(s, args.min_gap)
        print(f"{os.path.basename(path)}: {len(onsets)} onsets")
        stats = {"short": 0, "wrong_note": 0, "smeared": 0, "kept": 0}
        file_hits = []
        for k, onset in enumerate(onsets):
            nxt = onsets[k + 1] if k + 1 < len(onsets) else len(s)
            if (nxt - onset) / SR < 0.07:
                stats["short"] += 1
                continue
            note = note_of(s, onset)
            if note != args.tab_root:
                stats["wrong_note"] += 1
                continue
            # clean pick: attack clearly louder than the 20ms before it
            attack = rms(s, onset, onset + int(0.03 * SR))
            pre = rms(s, max(0, onset - int(0.02 * SR)), onset) + 1
            if attack < pre * 1.3:
                stats["smeared"] += 1
                continue
            stats["kept"] += 1
            file_hits.append((attack, s, onset, min(nxt - int(0.003 * SR), onset + int(0.6 * SR))))
        print(f"  {stats}")
        # spread: at most one hit per 0.8s so round robins are distinct takes
        file_hits.sort(key=lambda h: h[2])
        last_t = -1e9
        for h in file_hits:
            if h[2] / SR - last_t > 0.8:
                hits.append(h)
                last_t = h[2] / SR

    if not hits:
        print("\nNo usable chug hits found.")
        sys.exit(1)

    # velocity layers by measured level: top third v3, middle v2, bottom v1
    hits.sort(key=lambda h: -h[0])
    hits = hits[:30]
    n = len(hits)
    fade = int(0.03 * SR)
    counters = {1: 0, 2: 0, 3: 0}
    for idx, (level, s, a, b) in enumerate(hits):
        v = 3 if idx < n / 3 else 2 if idx < 2 * n / 3 else 1
        counters[v] += 1
        clip = s[max(0, a - int(0.001 * SR)):b]
        for i in range(min(fade, len(clip))):
            clip[-fade + i] = int(clip[-fade + i] * (1 - (i + 1) / fade))
        name = f"{args.tab_root}_v{v}_rr{counters[v]}.wav"
        with wave.open(os.path.join(args.out, name), "wb") as w:
            w.setparams((1, 2, SR, 0, "NONE", "not compressed"))
            w.writeframes(struct.pack("<%dh" % len(clip), *clip))
    print(f"\nWrote {n} hits to {args.out}: "
          f"v3×{counters[3]}, v2×{counters[2]}, v1×{counters[1]}")
    print("Import them via the app's 'pm bank' button.")

if __name__ == "__main__":
    main()
