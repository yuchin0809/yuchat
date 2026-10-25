/* =========================================================
   ゆうダービー：レースの音（Web Audio で、その場で作る。音のファイルは使わない）

   ・ファンファーレ（発走の直前）・ゲートの音・蹄の音・観客の声（だんだん大きく）・ラスト200mの盛り上がり・ゴールの歓声・写真判定・的中／外れの音。
   ・初めは「切」。レース画面の 🔊 ボタンで入／切（選んだ状態は端末に覚えておく）。入にしたとき（ボタンを押したとき）に、音が使えるようになる。
   ・音は演出だけ。結果にも払い戻しにも関係しない。画面が見えていないとき（別のタブ・ほかの画面）は、update が呼ばれないので止まる（pause）。
========================================================= */

const KEY = "derbySound";

export function createRaceSound() {
  let ctx = null, master = null, crowd = null, crowdGain = null, noiseBuf = null;
  let enabled = false;
  let nextHoof = 0, hoofStep = 0, crowdLevel = 0, lastLevelAt = 0;
  try { enabled = localStorage.getItem(KEY) === "on"; } catch (_) { /* 使えなくても動く */ }
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(enabled); } catch (_) { /* 表示側のエラーは音に関係しない */ } });

  function ensure() {
    if (ctx) return ctx.state === "suspended" ? ctx.resume().catch(() => {}) && ctx : ctx;
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
      /* 観客：ノイズを帯域でしぼって、ゆっくり揺らす */
      const len = ctx.sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;   // ピンクノイズ（低めの音が多いノイズ）
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      crowd = ctx.createBufferSource(); crowd.buffer = noiseBuf; crowd.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 850; bp.Q.value = 0.7;
      crowdGain = ctx.createGain(); crowdGain.gain.value = 0;
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain(); lfo.frequency.value = 0.35; lfoGain.gain.value = 0.015; lfo.connect(lfoGain); lfoGain.connect(crowdGain.gain);
      crowd.connect(bp); bp.connect(crowdGain); crowdGain.connect(master);
      crowd.start(); lfo.start();
    } catch (_) { ctx = null; return null; }
    return ctx;
  }
  const ready = () => enabled && ensure() && ctx && ctx.state !== "closed";

  function tone(freq, at, dur, { type = "sawtooth", gain = 0.18, cutoff = 2600, glide = 0 } = {}) {
    const t0 = ctx.currentTime + at, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0); if (glide) o.frequency.linearRampToValueAtTime(freq * glide, t0 + dur);
    f.type = "lowpass"; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(f); f.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function burst(at, dur, { hp = 0, lp = 8000, gain = 0.2 } = {}) {
    const t0 = ctx.currentTime + at, s = ctx.createBufferSource(), f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f1.type = "highpass"; f1.frequency.value = hp; f2.type = "lowpass"; f2.frequency.value = lp;
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f1); f1.connect(f2); f2.connect(g); g.connect(master); s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
  }
  function hoof(at, strength) {
    const t0 = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(110, t0); o.frequency.exponentialRampToValueAtTime(48, t0 + 0.09);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.16 * strength, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.14);
    burst(at, 0.05, { hp: 600, lp: 2200, gain: 0.05 * strength });
  }
  const setCrowd = (level, speed = 0.6) => { if (crowdGain) crowdGain.gain.setTargetAtTime(Math.max(0, level), ctx.currentTime, speed); };

  const cues = {
    /* 発走の直前のファンファーレ */
    fanfare() {
      [[392, 0, 0.16], [523.25, 0.18, 0.16], [659.25, 0.36, 0.16], [783.99, 0.54, 0.4], [659.25, 1.0, 0.16], [783.99, 1.18, 0.7]].forEach(([f, at, dur]) => { tone(f, at, dur, { gain: 0.16 }); tone(f / 2, at, dur, { type: "square", gain: 0.05, cutoff: 900 }); });
    },
    /* ゲートが開く */
    start() { burst(0, 0.18, { hp: 1500, gain: 0.25 }); tone(70, 0, 0.3, { type: "sine", gain: 0.3, glide: 0.6 }); tone(880, 0.02, 0.35, { type: "triangle", gain: 0.1 }); setCrowd(0.1, 0.2); },
    /* ラスト200m：盛り上がり */
    final() { tone(220, 0, 1.3, { type: "sawtooth", gain: 0.06, cutoff: 1800, glide: 4 }); setCrowd(0.3, 0.4); },
    /* 1着のゴール */
    goal() {
      burst(0, 1.4, { hp: 4000, gain: 0.18 });
      if (crowdGain) { const t = ctx.currentTime; crowdGain.gain.cancelScheduledValues(t); crowdGain.gain.setValueAtTime(crowdGain.gain.value, t); crowdGain.gain.linearRampToValueAtTime(0.55, t + 0.25); crowdGain.gain.setTargetAtTime(0.18, t + 0.5, 1.4); }
    },
    /* 写真判定：ドキドキする低い音と、判定のチャイム */
    photo() { tone(98, 0, 1.8, { type: "sine", gain: 0.22 }); for (let i = 0; i < 4; i++) tone(98, i * 0.45, 0.2, { type: "triangle", gain: 0.12 }); },
    photoResult() { tone(1046.5, 0, 0.5, { type: "triangle", gain: 0.14 }); tone(1318.5, 0.14, 0.7, { type: "triangle", gain: 0.12 }); },
    /* 的中 */
    win() { [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.09, 0.5, { type: "triangle", gain: 0.16 })); [2093, 2637, 3136].forEach((f, i) => tone(f, 0.4 + i * 0.07, 0.3, { type: "sine", gain: 0.05 })); burst(0.35, 0.5, { hp: 5000, gain: 0.1 }); },
    /* 惜しい・外れ */
    lose() { tone(440, 0, 0.35, { type: "triangle", gain: 0.12 }); tone(349.23, 0.3, 0.6, { type: "triangle", gain: 0.12 }); }
  };

  return {
    get enabled() { return enabled; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /* ボタンを押したときに呼ぶ（押したときでないと、ブラウザが音を出させてくれない） */
    setEnabled(on) {
      enabled = Boolean(on);
      try { localStorage.setItem(KEY, enabled ? "on" : "off"); } catch (_) { /* 覚えられなくても動く */ }
      if (enabled) { if (ensure()) cues.photoResult(); } else if (ctx) setCrowd(0, 0.1);
      notify();
    },
    toggle() { this.setEnabled(!enabled); return enabled; },
    /* 単発の音（同じ出来事は呼ぶ側で1回だけにする） */
    cue(name) { if (!ready() || !cues[name]) return; try { cues[name](); } catch (_) { /* 音のエラーは演出に関係しない */ } },
    /* 毎フレーム：観客の大きさ（0〜1）と、蹄の速さ（0〜1。0＝走っていない）を渡す */
    update({ crowd: level = 0, hooves = 0 } = {}) {
      if (!ready()) return;
      const now = ctx.currentTime;
      if (Math.abs(level - crowdLevel) > 0.02 || now - lastLevelAt > 1) { crowdLevel = level; lastLevelAt = now; setCrowd(0.02 + level * 0.16, 0.5); }
      if (hooves <= 0) { nextHoof = 0; return; }
      if (nextHoof < now) { nextHoof = now + 0.02; hoofStep = 0; }
      const beat = 0.23 - 0.07 * hooves;   // 速いほど、間が短い
      while (nextHoof < now + 0.25) {   // 「ドッ・ドッ・ドッ」の3拍＋ひと休み
        const pattern = [1, 0.7, 0.85, 0];
        const s = pattern[hoofStep % 4];
        if (s > 0) hoof(nextHoof - now, (0.5 + 0.5 * hooves) * s);
        nextHoof += beat * (hoofStep % 4 === 3 ? 1.1 : 0.5);
        hoofStep++;
      }
    },
    /* 画面が見えていないとき・音を切るとき：観客と蹄を止める */
    pause() { nextHoof = 0; if (ctx && crowdGain) setCrowd(0, 0.15); }
  };
}
