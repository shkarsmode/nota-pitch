import { settings, saveSettings, readJSON, writeJSON, noteText, decimal } from './settings.js';
import { audio, tone, stopTones } from './audio.js';
import { segmentNotes, layoutFold, createPassScorer, activeTarget } from './notes.js';

const LEAD = 900;
const TAIL = 700;
const MAX_REC = 60000;
const LAT = 70;
const LINGER = 130;
const KEEP = 12;
const TEMPOS = [1, 0.75, 0.5];
const INTRO = 'Сыграй её на инструменте или спой: одним голосом, без аккордов. «Нота» запомнит ноты и будет крутить их по кругу, а ты пой поверх и смотри, куда попадаешь.';

const plural = (n, one, few, many) => {
  const a = n % 100;
  const b = n % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
};

function loadSaved() {
  const raw = readJSON('nota.loops', []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it) => it && Number.isFinite(it.id) && Number.isFinite(it.dur) && Array.isArray(it.notes) && it.notes.length)
    .filter((it) => it.notes.every((n) => Array.isArray(n) && n.length === 3 && n.every(Number.isFinite)))
    .slice(0, KEEP);
}

export function createLoop(ctx) {
  const { $, voice } = ctx;
  const L = {
    st: 'empty',
    notes: [],
    dur: 0,
    id: null,
    pos: 0,
    pass: -1,
    paused: false,
    resync: false,
    scorer: null,
    cur: [],
    prev: [],
    sang: false,
    last: null,
    best: null,
    frames: [],
    recAt: 0,
    msg: null,
  };
  let saved = loadSaved();

  const ltNow = () => L.pos - Math.floor(L.pos / L.dur) * L.dur;
  const playing = () => L.st === 'play' && !L.paused && audio.running;

  function schedule(from) {
    const tempo = settings.loopTempo;
    for (const n of L.notes) {
      if (n.t0 < from) continue;
      tone(n.midi, {
        hold: true,
        gain: 0.5,
        delay: (n.t0 - from) / tempo / 1000,
        dur: Math.max(0.12, (n.t1 - n.t0) / tempo / 1000 - 0.04),
      });
    }
  }

  function resound() {
    stopTones();
    if (settings.loopSound && playing()) schedule(ltNow());
  }

  async function startRec() {
    if (!(await ctx.micOn())) return;
    stopTones();
    L.st = 'rec';
    L.frames = [];
    L.recAt = performance.now();
    L.msg = null;
    ctx.refresh();
  }

  function cancelRec() {
    L.st = L.notes.length ? 'play' : 'empty';
    L.resync = true;
    ctx.refresh();
  }

  function finishRec() {
    const notes = segmentNotes(L.frames).map((n) => ({ t0: n.t0, t1: Math.max(n.t1, n.t0 + 160), midi: n.midi }));
    L.frames = [];
    if (!notes.length) {
      L.st = 'empty';
      L.notes = [];
      L.msg = 'Не услышал нот. Играй или пой погромче и поближе к телефону.';
      ctx.refresh();
      return;
    }
    const shift = LEAD - notes[0].t0;
    notes.forEach((n, i) => {
      n.t0 = Math.round(n.t0 + shift);
      n.t1 = Math.round(n.t1 + shift);
      if (i > 0 && notes[i - 1].t1 > n.t0 - 20) notes[i - 1].t1 = n.t0 - 20;
    });
    const item = {
      id: Date.now(),
      dur: notes[notes.length - 1].t1 + TAIL,
      notes: notes.map((n) => [n.t0, n.t1, n.midi]),
    };
    saved = [item, ...saved].slice(0, KEEP);
    writeJSON('nota.loops', saved);
    open(item);
  }

  function open(item) {
    stopTones();
    L.notes = layoutFold(item.notes.map(([t0, t1, midi]) => ({ t0, t1, midi })));
    L.dur = item.dur;
    L.id = item.id;
    L.st = 'play';
    L.pos = 0;
    L.pass = -1;
    L.paused = false;
    L.scorer = null;
    L.cur = [];
    L.prev = [];
    L.last = null;
    L.best = null;
    L.msg = null;
    ctx.refresh();
  }

  function startPass(k) {
    if (L.scorer) {
      L.notes.forEach((_, i) => {
        if (!(i in L.cur)) L.cur[i] = L.scorer.result(i);
      });
      if (L.sang) {
        L.last = L.scorer.total();
        L.best = Math.max(L.best ?? 0, L.last);
      }
      L.prev = L.cur;
    }
    L.pass = k;
    L.scorer = createPassScorer(L.notes, settings.tol);
    L.cur = [];
    L.sang = false;
    if (settings.loopSound) schedule(0);
  }

  function title(it) {
    const d = new Date(it.id);
    const two = (v) => String(v).padStart(2, '0');
    return `${two(d.getDate())}.${two(d.getMonth() + 1)} в ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  function renderList() {
    const el = $('loopList');
    el.innerHTML = '';
    if (!saved.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Пока пусто. Запиши первую мелодию.';
      el.appendChild(p);
      return;
    }
    for (const it of saved) {
      const row = document.createElement('div');
      row.className = `item${it.id === L.id && L.st === 'play' ? ' on' : ''}`;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'item-main';
      const names = it.notes.slice(0, 7).map((n) => noteText(n[2], false)).join(' ') + (it.notes.length > 7 ? ' …' : '');
      const b = document.createElement('b');
      b.textContent = names;
      const small = document.createElement('small');
      small.textContent = `${title(it)} · ${it.notes.length} ${plural(it.notes.length, 'нота', 'ноты', 'нот')} · ${decimal(it.dur / 1000)} с`;
      main.append(b, small);
      main.addEventListener('click', () => {
        ctx.closeSheets();
        open(it);
        ctx.micOn();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'item-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Удалить');
      del.addEventListener('click', () => {
        if (!row.classList.contains('ask')) {
          row.classList.add('ask');
          del.textContent = 'Удалить';
          return;
        }
        saved = saved.filter((x) => x.id !== it.id);
        writeJSON('nota.loops', saved);
        if (it.id === L.id) {
          stopTones();
          L.st = 'empty';
          L.notes = [];
          L.id = null;
          ctx.refresh();
        }
        renderList();
      });
      row.append(main, del);
      el.appendChild(row);
    }
  }

  function openList() {
    renderList();
    ctx.openSheet('loopSheet');
  }

  function renderDock() {
    $('loopPlay').classList.toggle('on', !L.paused);
    $('loopPlay').setAttribute('aria-label', L.paused ? 'Продолжить' : 'Пауза');
    $('loopSound').classList.toggle('on', settings.loopSound);
    $('loopSoundState').textContent = settings.loopSound ? 'вкл · в наушниках' : 'выкл';
    $('loopTempo').classList.toggle('on', settings.loopTempo !== 1);
    $('loopTempoState').textContent = `${Math.round(settings.loopTempo * 100)}%`;
  }

  $('recStop').addEventListener('click', finishRec);
  $('recCancel').addEventListener('click', cancelRec);
  $('loopPlay').addEventListener('click', () => {
    L.paused = !L.paused;
    resound();
    renderDock();
  });
  $('loopSound').addEventListener('click', () => {
    settings.loopSound = !settings.loopSound;
    saveSettings();
    resound();
    renderDock();
  });
  $('loopTempo').addEventListener('click', () => {
    settings.loopTempo = TEMPOS[(TEMPOS.indexOf(settings.loopTempo) + 1) % TEMPOS.length];
    saveSettings();
    resound();
    renderDock();
  });
  $('loopMenu').addEventListener('click', openList);
  $('loopNew').addEventListener('click', () => {
    ctx.closeSheets();
    startRec();
  });
  renderDock();

  return {
    view: () => `loop-${L.st}`,
    focus: () => L.st === 'rec',
    fold: () => true,
    needsMic: () => L.st !== 'empty',
    render: renderDock,
    overlay() {
      if (L.st !== 'empty') return null;
      return {
        title: 'Запиши мелодию',
        msg: L.msg || INTRO,
        btn: 'Записать',
        icon: 'rec',
        onBtn: startRec,
        alt: saved.length ? `Мои мелодии (${saved.length})` : null,
        onAlt: openList,
      };
    },
    enter() {
      L.resync = true;
      renderDock();
    },
    leave() {
      stopTones();
      if (L.st === 'rec') cancelRec();
    },
    micLost() {
      if (L.st === 'rec') finishRec();
      L.resync = true;
    },
    relabel() {
      if ($('loopSheet').classList.contains('open')) renderList();
    },
    keyTap(lane, midi) {
      tone(midi);
      ctx.state.flash = { n: lane, until: performance.now() + 220 };
    },
    voiced(now, v) {
      if (L.st === 'rec') L.frames.push({ t: now - L.recAt, m: v, db: audio.level });
    },
    idle(now) {
      if (L.st === 'rec' && audio.running) L.frames.push({ t: now - L.recAt, m: NaN, db: audio.level });
    },
    tick(now, dt) {
      if (L.st === 'rec') {
        if (now - L.recAt > MAX_REC) finishRec();
        return;
      }
      if (!playing()) return;
      if (L.resync) {
        L.resync = false;
        resound();
      }
      const tempo = settings.loopTempo;
      L.pos += dt * tempo;
      const k = Math.floor(L.pos / L.dur);
      if (k !== L.pass) startPass(k);
      const lt = L.pos - k * L.dur - LAT * tempo;
      L.notes.forEach((n, i) => {
        if (lt >= n.t0 && lt < n.t1) {
          L.scorer.feed(i, voice.now);
          if (!Number.isNaN(voice.now)) L.sang = true;
        } else if (lt >= n.t1 && !(i in L.cur)) {
          L.cur[i] = L.scorer.result(i);
        }
      });
    },
    target(now, m) {
      if (L.st !== 'play') return null;
      const n = activeTarget(L.notes, ltNow(), m, LINGER * settings.loopTempo);
      return n ? n.midi : null;
    },
    anchor() {
      if (L.st !== 'play') return null;
      const lt = ltNow();
      const n = activeTarget(L.notes, lt, voice.now, LINGER * settings.loopTempo) || L.notes.find((x) => x.t0 > lt && x.t0 - lt < 700);
      return n ? n.pos : null;
    },
    scene(s, now) {
      if (L.st !== 'play') return;
      s.nowFrac = 0.34;
      const tempo = settings.loopTempo;
      const k = Math.max(0, L.pass);
      s.bars = [];
      for (const kk of [k - 1, k, k + 1]) {
        if (kk < 0) continue;
        const base = kk * L.dur - L.pos;
        L.notes.forEach((n, i) => {
          const res = kk === k ? L.cur[i] : kk < k ? L.prev[i] : null;
          s.bars.push({
            t0: now + (base + n.t0) / tempo,
            t1: now + (base + n.t1) / tempo,
            pos: n.pos,
            cls: res ? res.cls : 'todo',
          });
        });
      }
    },
    pill(now) {
      if (L.st === 'rec') return `● Запись ${Math.floor((now - L.recAt) / 1000)} с`;
      if (L.st !== 'play') return '';
      if (L.paused) return 'Пауза';
      if (L.last == null) return 'Пой вместе с полосками';
      const pct = (v) => `${Math.round(v * 100)}%`;
      return `Прошлый круг: ${pct(L.last)} в ноту${L.best > L.last + 0.005 ? ` · лучший ${pct(L.best)}` : ''}`;
    },
  };
}
