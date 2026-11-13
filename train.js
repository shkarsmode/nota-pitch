import { readJSON, writeJSON, noteText, decimal } from './settings.js';
import { audio, tone, stopTones } from './audio.js';
import { median, pcOf } from './music.js';
import { scoreNote, createPassScorer, layoutFold, activeTarget } from './notes.js';
import { SKILLS, IV_NAMES, HIT, normalize, fitRange, planSession, needOrder, judge, record, finishBlock, addTime, summary, scoreOf } from './trainer.js';

const CUE_MS = 850;
const CUE_GUARD = 330;
const RESULT_MS = 1300;
const LAT = 70;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const plural = (n, one, few, many) => {
  const a = n % 100;
  const b = n % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cents = (v) => `${Math.round(v)}¢`;
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}¢`;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function today() {
  const d = new Date();
  const two = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function createTrain(ctx) {
  const { $, voice } = ctx;
  let P = normalize(readJSON('nota.train', null));
  let S = null;
  let C = null;
  let fresh = false;
  let order = needOrder(P);
  const shown = {};

  const save = () => writeJSON('nota.train', P);
  const block = () => S.plan.blocks[S.bi];
  const name = (m) => noteText(m, false);

  function begin() {
    fresh = false;
    voice.hist.length = 0;
    if (P.range) S = newSession();
    else C = { step: 0, lo: null, cap: null, ack: 0, msg: '' };
    ctx.refresh();
    ctx.micOn();
  }

  function recalibrate() {
    fresh = false;
    voice.hist.length = 0;
    C = { step: 0, lo: null, cap: null, ack: 0, msg: '', only: true };
    ctx.refresh();
    ctx.micOn();
  }

  function newSession() {
    return {
      plan: planSession(P, Math.random, 9, order),
      bi: 0,
      ti: 0,
      phase: 'intro',
      at: 0,
      trial: null,
      cap: null,
      hits: [],
      res: [],
      blockRes: [],
      active: 0,
      n: 0,
      err: 0,
      hit: 0,
      confirm: false,
      fb: null,
      tl: null,
      waitSilence: false,
      retries: 0,
      cueEnd: 0,
      resultMs: RESULT_MS,
    };
  }

  function startTrial() {
    S.trial = block().trials[S.ti];
    S.retries = 0;
    cue();
    ctx.refresh();
  }

  function cue() {
    const t = S.trial;
    const now = performance.now();
    stopTones();
    S.phase = 'cue';
    S.at = now;
    S.cap = null;
    S.hits = [];
    S.fb = null;
    S.tl = null;
    S.waitSilence = false;
    if (t.skill === 'phrase') {
      const notes = layoutFold(t.notes.map((n) => ({ ...n })));
      const len = notes[notes.length - 1].t1;
      const listen = now + 500;
      const sing = listen + len + 900;
      S.tl = { notes, listen, sing, end: sing + len + 350, scorer: createPassScorer(notes, HIT), res: [] };
      for (const n of notes) {
        tone(n.midi, { hold: true, gain: 0.5, delay: (listen + n.t0 - now) / 1000, dur: (n.t1 - n.t0) / 1000 - 0.03 });
      }
      S.cueEnd = sing - 250;
    } else {
      t.cue.forEach((m, i) => tone(m, { hold: true, gain: 0.55, delay: (i * CUE_MS) / 1000, dur: 0.72 }));
      S.cueEnd = now + (t.cue.length - 1) * CUE_MS + 720 + CUE_GUARD;
    }
  }

  function closeHit() {
    const cap = S.cap;
    S.cap = null;
    const dur = cap.last - cap.t0;
    if (dur > 900) S.waitSilence = true;
    if (dur < 150) return;
    const r = scoreNote(cap.frames, S.trial.target, HIT);
    if (r) {
      S.hits.push({ r, j: judge('attack', r) });
      S.hitAt = performance.now();
    }
  }

  function finishAttack() {
    const hs = S.hits;
    const avg = (f) => hs.reduce((s, h) => s + f(h.r), 0) / hs.length;
    const r = { onset: avg((x) => x.onset), err: avg((x) => x.err), bias: avg((x) => x.bias) };
    const j = judge('attack', r);
    const good = hs.filter((h) => h.j.hit).length;
    const low = hs.filter((h) => !h.j.hit && h.r.onset < -30).length;
    const high = hs.filter((h) => !h.j.hit && h.r.onset > 30).length;
    j.hit = good >= 2;
    if (good === hs.length) {
      j.cls = 'good';
      j.text = 'Сразу в ноту';
    } else {
      j.cls = good >= 2 ? 'warn' : 'bad';
      if (low && low >= high) j.text = 'Подъезд снизу';
      else if (high) j.text = 'Вход сверху';
      else if (j.text === 'Сразу в ноту') j.text = 'Мимо ноты';
    }
    j.sub = `${good} из ${hs.length} чисто · на входе в среднем ${signed(r.onset)}`;
    result(j, r);
  }

  function finishNote() {
    const r = scoreNote(S.cap.frames, S.trial.target, HIT);
    S.cap = null;
    if (r) result(judge(S.trial.skill, r), r);
  }

  function result(j, r) {
    const t = S.trial;
    S.phase = 'result';
    S.at = performance.now();
    S.fb = j;
    S.resultMs = t.check ? 1900 : t.skill === 'phrase' ? 1700 : RESULT_MS;
    record(P, today(), t, j, r);
    S.res.push(j);
    S.n++;
    S.err += Math.min(100, j.err);
    if (j.hit) S.hit++;
    save();
    if (t.check) {
      tone(t.target, { hold: true, gain: 0.55, dur: 0.75, delay: 0.3 });
      ctx.markRef(t.target, 1350);
    }
  }

  function next() {
    S.ti++;
    if (S.ti < block().trials.length) startTrial();
    else endBlock();
  }

  function skip() {
    if (!S || !S.trial || S.phase === 'result') return;
    stopTones();
    S.res.push(null);
    next();
  }

  function endBlock() {
    const b = block();
    const done = S.res.filter(Boolean);
    const hits = done.filter((j) => j.hit).length;
    const info = finishBlock(P, b, hits, done.length);
    S.blockRes.push({ skill: b.skill, warmup: !!b.warmup, focus: !!b.focus, level: b.level, hits, total: done.length, change: info.change });
    S.res = [];
    S.bi++;
    S.ti = 0;
    S.trial = null;
    save();
    if (S.bi < S.plan.blocks.length) {
      S.phase = 'intro';
      ctx.refresh();
    } else {
      finish();
    }
  }

  function finish() {
    stopTones();
    if (S.res.length) {
      const b = block();
      const done = S.res.filter(Boolean);
      if (done.length) {
        const hits = done.filter((j) => j.hit).length;
        const info = finishBlock(P, b, hits, done.length);
        S.blockRes.push({ skill: b.skill, warmup: !!b.warmup, focus: !!b.focus, level: b.level, hits, total: done.length, change: info.change });
      }
    }
    if (S.n) {
      const sec = S.active / 1000;
      addTime(P, today(), sec);
      P.sessions++;
      P.last = {
        at: Date.now(),
        sec,
        n: S.n,
        err: S.err / S.n,
        hit: S.hit / S.n,
        score: scoreOf(S.err / S.n),
        prev: P.last ? P.last.score : null,
        blocks: S.blockRes,
      };
      fresh = true;
    }
    save();
    S = null;
    renderHome();
    ctx.refresh();
  }

  function resume() {
    S.confirm = false;
    if (S.phase !== 'intro') startTrial();
    else ctx.refresh();
  }

  function prevLine(r) {
    const lvl = r.change > 0 ? ' Уровень повышен.' : r.change < 0 ? ' Уровень понижен, так будет полезнее.' : '';
    return `«${SKILLS[r.skill].name}»: ${r.hits} из ${r.total}.${lvl}`;
  }

  function tickSing(now) {
    const t = S.trial;
    if (t.skill === 'phrase') {
      const tl = S.tl;
      const lt = now - tl.sing - LAT;
      tl.notes.forEach((n, i) => {
        if (lt >= n.t0 && lt < n.t1) tl.scorer.feed(i, voice.now);
        else if (lt >= n.t1 && !(i in tl.res)) tl.res[i] = tl.scorer.result(i) || { cls: 'miss', cover: 0, err: null, bias: 0 };
      });
      if (now >= tl.end) {
        const res = tl.notes.map((_, i) => tl.res[i] || tl.scorer.result(i) || { cls: 'miss', cover: 0, err: null, bias: 0 });
        tl.res = res;
        result(judge('phrase', res), res);
      }
      return;
    }
    const cap = S.cap;
    if (t.skill === 'attack') {
      if (cap && (now - cap.last > 110 || cap.last - cap.t0 > 900)) closeHit();
      if (S.hits.length >= t.hits || (S.hits.length && !S.cap && now - S.hitAt > 4500)) {
        finishAttack();
        return;
      }
    } else if (cap) {
      const dur = cap.last - cap.t0;
      if (dur >= t.holdMs) {
        finishNote();
        return;
      }
      if (now - cap.last > 350) {
        if (dur >= Math.max(400, t.holdMs * 0.45)) {
          finishNote();
          return;
        }
        S.cap = null;
      }
    }
    if (!S.cap && !S.hits.length && now - S.at > 9000) {
      if (S.retries++ < 1) cue();
      else skip();
    }
  }

  function tickCalib(now) {
    if (C.ack) {
      if (now >= C.ack && now - voice.lastVoiced > 250) {
        C.ack = 0;
        C.cap = null;
      }
      return;
    }
    const c = C.cap;
    if (!c) return;
    if (now - c.last > 300) {
      C.cap = null;
    } else if (c.last - c.t0 >= 1500) {
      const m = Math.round(median(c.vals));
      if (C.step === 0) {
        C.lo = m;
        C.step = 1;
        C.ack = now + 1200;
        C.msg = `Записал: ${noteText(m)}`;
      } else {
        P.range = fitRange(C.lo, m);
        save();
        const only = C.only;
        C = null;
        if (only) renderHome();
        else S = newSession();
        ctx.refresh();
      }
    }
  }

  function setText(key, el, v) {
    if (shown[key] === v) return;
    shown[key] = v;
    el.textContent = v;
  }

  function renderTop(now) {
    let step = '';
    let prompt = '';
    let sub = '';
    let cls = 'idle';
    let fill = 0;
    let dots = '';

    if (C) {
      step = 'Настройка диапазона';
      if (C.ack) {
        prompt = C.msg;
        sub = 'Секунду тишины…';
        cls = 'good';
        fill = 1;
      } else {
        prompt = C.step === 0 ? 'Спой низкую ноту' : 'Теперь высокую';
        sub = C.cap ? 'Тяни…' : 'Удобную, не крайнюю. Тяни её 2 секунды';
        fill = C.cap ? Math.min(1, (C.cap.last - C.cap.t0) / 1500) : 0;
      }
    } else if (S) {
      const b = block();
      const t = S.trial;
      const tag = b.warmup ? ' · разогрев' : b.focus ? ' · ещё раз' : '';
      step = `${S.bi + 1} из ${S.plan.blocks.length} · ${SKILLS[b.skill].title}${tag}`;
      if (!t) {
        prompt = '';
      } else if (S.phase === 'cue') {
        cls = 'ref';
        prompt = 'Слушай';
        if (t.skill === 'interval') sub = `Опорная нота: ${name(t.tonic)}`;
        else if (t.skill === 'phrase') sub = 'Запомни фразу';
        else sub = t.hide ? 'Запомни высоту' : `Нота ${name(t.target)}`;
      } else if (S.phase === 'sing') {
        if (t.skill === 'phrase') {
          prompt = 'Пой вместе с полосками';
          fill = Math.max(0, Math.min(1, (now - S.tl.sing) / (S.tl.end - S.tl.sing)));
        } else if (t.skill === 'attack') {
          prompt = 'Та · та · та';
          sub = S.hits.length
            ? S.hits.map((h) => (h.j.hit ? '✓ сразу' : h.r.onset < 0 ? '↗ снизу' : '↘ сверху')).join('   ')
            : t.hide
              ? 'Коротко, по памяти'
              : `Коротко и сразу в ${name(t.target)}`;
          fill = S.hits.length / t.hits;
        } else {
          const got = S.cap ? S.cap.last - S.cap.t0 : 0;
          fill = Math.min(1, got / t.holdMs);
          if (t.skill === 'hold') {
            prompt = `Тяни ${name(t.target)}`;
            sub = `${decimal(t.holdMs / 1000)} с ровно`;
          } else if (t.skill === 'interval') {
            const dir = t.iv > 0 ? 'вверх' : 'вниз';
            prompt = t.hide ? `${IV_NAMES[Math.abs(t.iv)]} ${dir}` : `Спой ${name(t.target)}`;
            sub = t.hide ? `от ${name(t.tonic)}, без подсказки` : `${IV_NAMES[Math.abs(t.iv)]} ${dir} от ${name(t.tonic)}`;
          } else {
            prompt = t.hide ? 'Спой её на слух' : `Спой ${name(t.target)}`;
            sub = 'и потяни';
          }
          if (!S.cap && now - S.at > 5000) sub = 'Не слышу тебя: спой погромче';
        }
      } else if (S.phase === 'result' && S.fb) {
        cls = S.fb.cls;
        prompt = `${S.fb.text}${S.fb.cls === 'good' ? ' ✓' : ''}`;
        sub = S.fb.sub;
        fill = 1;
      }
      const trials = b.trials.length;
      for (let i = 0; i < trials; i++) {
        const j = S.res[i];
        const c = i < S.res.length ? (j ? j.cls : 'skip') : i === S.ti && t ? 'cur' : '';
        dots += `<i class="${c}"></i>`;
      }
    }

    const top = $('trainTop');
    if (shown.cls !== cls) {
      shown.cls = cls;
      top.dataset.state = cls;
    }
    setText('step', $('tStep'), step);
    setText('prompt', $('tPrompt'), prompt);
    setText('sub', $('tSub'), sub);
    const f = fill.toFixed(3);
    if (shown.fill !== f) {
      shown.fill = f;
      $('tFill').style.transform = `scaleX(${f})`;
    }
    if (shown.dots !== dots) {
      shown.dots = dots;
      $('tDots').innerHTML = dots;
    }
  }

  function insightText(i) {
    if (i.kind === 'scoop') return `Подъезжаешь к нотам снизу: на входе в среднем ${signed(i.v)}. Поэтому «Точного входа» будет больше.`;
    if (i.kind === 'flat') return `Чаще занижаешь: в среднем ${signed(i.v)}. Целься чуть выше и не отпускай опору.`;
    if (i.kind === 'sharp') return `Чаще завышаешь: в среднем ${signed(i.v)}. Не дави, сними напор.`;
    if (i.kind === 'notes') return `Труднее всего даются: ${i.notes.map((n) => name(n)).join(' и ')}. Они будут попадаться чаще.`;
    return `Сложный интервал: ${IV_NAMES[Math.abs(i.iv)]} ${i.iv > 0 ? 'вверх' : 'вниз'}. Он будет попадаться чаще.`;
  }

  function resultCard(L) {
    const delta = L.prev == null ? '' : L.score - L.prev;
    const badge =
      delta === ''
        ? ''
        : `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : '−'}${Math.abs(delta)} к прошлому разу</span>`;
    const rows = L.blocks
      .filter((b) => b.total)
      .map((b) => {
        const lvl = b.change > 0 ? '<em class="up">уровень ↑</em>' : b.change < 0 ? '<em class="down">уровень ↓</em>' : '';
        const tag = b.warmup ? ' (разогрев)' : b.focus ? ' (ещё раз)' : '';
        return `<li><span>${esc(SKILLS[b.skill].name)}${tag}</span><b>${b.hits} из ${b.total}</b>${lvl}</li>`;
      })
      .join('');
    return `<section class="card done">
      <div class="card-h">Готово · ${clock(L.sec)}</div>
      <div class="stats">
        <div><b>${L.score}</b><small>точность</small></div>
        <div><b>${Math.round(L.hit * 100)}%</b><small>в ноту</small></div>
        <div><b>${cents(L.err)}</b><small>ср. ошибка</small></div>
      </div>
      ${badge}
      <ul class="rows">${rows}</ul>
    </section>`;
  }

  function chartSVG(chart) {
    const w = 14;
    const gap = 6;
    const h = 72;
    const bars = chart
      .map((c, i) => {
        const x = i * (w + gap);
        const day = Number(c.d.slice(8));
        const lab = i % 2 === 1 || c.today ? `<text x="${x + w / 2}" y="${h + 14}" class="${c.today ? 'on' : ''}">${day}</text>` : '';
        if (c.score == null) return `<rect x="${x}" y="${h - 3}" width="${w}" height="3" rx="1.5" class="none"/>${lab}`;
        const bh = Math.max(6, (c.score / 100) * h);
        return `<rect x="${x}" y="${h - bh}" width="${w}" height="${bh}" rx="4" class="${c.today ? 'on' : ''}"/>${lab}`;
      })
      .join('');
    return `<svg class="chart" viewBox="0 0 ${chart.length * (w + gap) - gap} ${h + 18}" role="img" aria-label="Точность по дням">${bars}</svg>`;
  }

  function renderHome() {
    const s = summary(P, today());
    order = needOrder(P);
    const focus = s.total ? order[0] : null;
    const out = ['<h1>Тренировка</h1>'];
    if (fresh && P.last) out.push(resultCard(P.last));

    if (!P.range) {
      out.push(`<section class="card">
        <div class="card-h">Первый запуск</div>
        <p class="lead">Каждый день короткая тренировка на попадание в ноты: около 9 минут.</p>
        <p class="hint">«Нота» запоминает, где ты промахиваешься, и подбирает упражнения под это. Сначала 15 секунд настроим твой диапазон.</p>
        <button type="button" class="primary wide" id="trainStart">Настроить и начать</button>
      </section>`);
    } else {
      const again = s.today ? `<p class="hint">Сегодня уже сделано ${s.today.n} ${plural(s.today.n, 'задание', 'задания', 'заданий')}. Можно ещё раз.</p>` : '';
      out.push(`<section class="card">
        <div class="card-h">Сегодня</div>
        <p class="lead">≈ 9 минут${focus ? ` · упор на «${esc(SKILLS[focus].name)}»` : ' · пять видов упражнений'}</p>
        <div class="tags">${order.map((id) => `<span class="${id === focus ? 'on' : ''}">${esc(SKILLS[id].name)}</span>`).join('')}</div>
        ${again}
        <button type="button" class="primary wide" id="trainStart">${s.today ? 'Ещё тренировка' : 'Начать тренировку'}</button>
        <p class="hint small">Нужен звук на телефоне: ноты-подсказки играют через динамик. Лучше в тихом месте.</p>
      </section>`);
    }

    const week = s.week
      .map((d, i) => `<span class="${d.done ? 'done' : ''}${d.today ? ' today' : ''}"><i></i>${WEEKDAYS[i]}</span>`)
      .join('');
    out.push(`<section class="card streak">
      <div><b>${s.streak}</b> ${plural(s.streak, 'день', 'дня', 'дней')} подряд</div>
      <div class="week">${week}</div>
    </section>`);

    let progress;
    if (!s.total) {
      progress = '<p class="hint">После первой тренировки здесь появится график точности. Через неделю покажу сравнение «было / стало».</p>';
    } else {
      const lines = [];
      if (s.compare) {
        const [a, b] = s.compare.err;
        const lead = s.compare.kind === 'week' ? 'За неделю' : 'С первого дня';
        const better = b < a - 0.5;
        lines.push(`<p class="cmp">${lead}: средняя ошибка <b>${cents(a)} → ${cents(b)}</b> <span class="delta ${better ? 'up' : b > a + 0.5 ? 'down' : ''}">${better ? 'лучше' : b > a + 0.5 ? 'хуже' : 'так же'}</span></p>`);
        const [oa, ob] = s.compare.on;
        if (oa != null && ob != null) lines.push(`<p class="cmp">Промах на входе в ноту: <b>${cents(oa)} → ${cents(ob)}</b></p>`);
      } else if (s.today) {
        lines.push(`<p class="cmp">Сегодня: точность <b>${s.today.score}</b>, средняя ошибка <b>${cents(s.today.err)}</b>. Сравнение появится после следующей тренировки.</p>`);
      }
      progress = `${lines.join('')}${chartSVG(s.chart)}<p class="hint small">Столбики — точность за день (0–100). Чем выше, тем ближе к нотам.</p>`;
    }
    out.push(`<section class="card"><div class="card-h">Прогресс</div>${progress}</section>`);

    const skills = s.skills
      .map((k) => {
        const val = k.score == null ? '—' : k.score;
        const width = k.score == null ? 0 : Math.max(4, k.score);
        return `<li class="${k.id === focus ? 'weak' : ''}">
          <span>${esc(k.name)}${k.id === focus ? ' <em>упор</em>' : ''}</span>
          <div class="bar"><i style="width:${width}%"></i></div>
          <b>${val}</b><small>ур. ${k.level}</small>
        </li>`;
      })
      .join('');
    out.push(`<section class="card"><div class="card-h">Навыки</div><ul class="skills">${skills}</ul></section>`);

    if (s.insights.length) {
      out.push(`<section class="card"><div class="card-h">Над чем работаем</div><ul class="tips">${s.insights.map((i) => `<li>${esc(insightText(i))}</li>`).join('')}</ul></section>`);
    }

    if (P.range) {
      out.push(`<section class="card line">
        <span>Диапазон: <b>${esc(noteText(P.range.lo))} – ${esc(noteText(P.range.hi))}</b></span>
        <button type="button" class="ghost" id="trainRange">Изменить</button>
      </section>`);
    }

    const el = $('trainHome');
    el.innerHTML = `<div class="page-in">${out.join('')}</div>`;
    el.scrollTop = 0;
    $('trainStart').addEventListener('click', begin);
    const rng = $('trainRange');
    if (rng) rng.addEventListener('click', recalibrate);
  }

  $('trainExit').addEventListener('click', () => {
    if (C) {
      C = null;
      renderHome();
      ctx.refresh();
    } else if (S) {
      stopTones();
      S.confirm = true;
      ctx.refresh();
    }
  });
  $('trainReplay').addEventListener('click', () => {
    if (S && S.trial && !S.confirm && S.phase !== 'result' && audio.running) cue();
  });
  $('trainSkip').addEventListener('click', () => {
    if (S && !S.confirm) skip();
  });
  renderHome();

  return {
    view: () => (S || C ? 'train-run' : 'train-home'),
    focus: () => !!(S || C),
    fold: () => true,
    needsMic: () => !!(S || C),
    isRef: () => !!S && S.phase === 'cue',
    overlay() {
      if (!S && !C) return null;
      if (S && S.confirm) {
        return { title: 'Закончить тренировку?', msg: 'Сделанные упражнения сохранятся.', btn: 'Продолжить', onBtn: resume, alt: 'Закончить', onAlt: finish };
      }
      if (!audio.running) {
        const started = !!S && S.active > 0;
        return {
          title: started ? 'Пауза' : 'Нужен микрофон',
          msg: ctx.state.micMsg || 'Разреши доступ к микрофону, чтобы начать.',
          btn: audio.starting ? 'Жду доступ…' : started ? 'Продолжить' : 'Включить микрофон',
          icon: 'mic',
          busy: audio.starting,
          onBtn: async () => {
            if ((await ctx.micOn()) && S && S.phase !== 'intro') startTrial();
          },
        };
      }
      if (!S || S.phase !== 'intro') return null;
      const b = block();
      const prev = S.blockRes[S.blockRes.length - 1];
      const tag = b.warmup ? ' · разогрев' : b.focus ? ' · ещё раз' : '';
      const lvl = b.warmup ? '' : `\n\nУровень ${b.level} из 3.`;
      return {
        title: `${SKILLS[b.skill].title}${tag}`,
        msg: `${prev ? `${prevLine(prev)}\n\n` : ''}${SKILLS[b.skill].hint}${lvl}`,
        btn: S.bi === 0 ? 'Начать' : 'Дальше',
        onBtn: startTrial,
      };
    },
    render() {
      $('dockTrain').hidden = !S || !S.trial;
      renderTop(performance.now());
    },
    enter() {
      renderHome();
    },
    leave() {
      if (S) finish();
      C = null;
      fresh = false;
    },
    micLost() {
      stopTones();
      if (C) C.cap = null;
    },
    relabel() {
      if (!S && !C) renderHome();
    },
    voiced(now, v) {
      if (C) {
        if (C.ack) return;
        const c = C.cap;
        if (!c || (c.vals.length >= 3 && Math.abs(v - median(c.vals)) > 1.2)) C.cap = { t0: now, last: now, vals: [v] };
        else {
          c.vals.push(v);
          c.last = now;
        }
        return;
      }
      if (!S || S.confirm || S.phase !== 'sing' || S.trial.skill === 'phrase' || S.waitSilence) return;
      if (!S.cap) S.cap = { t0: now, last: now, frames: [] };
      S.cap.frames.push({ t: now, m: v });
      S.cap.last = now;
    },
    idle(now) {
      if (S && S.waitSilence && now - voice.lastVoiced > 100) S.waitSilence = false;
    },
    tick(now, dt) {
      if (C) {
        if (audio.running) tickCalib(now);
        if (C) renderTop(now);
        return;
      }
      if (!S) return;
      if (!S.confirm && audio.running && S.phase !== 'intro') {
        S.active += dt;
        if (S.phase === 'cue') {
          if (now >= S.cueEnd) {
            S.phase = 'sing';
            S.at = now;
            S.cap = null;
          }
        } else if (S.phase === 'sing') {
          tickSing(now);
        } else if (S.phase === 'result' && now - S.at >= S.resultMs) {
          next();
        }
      }
      if (S) renderTop(now);
    },
    target(now, m) {
      if (!S || !S.trial) return null;
      const t = S.trial;
      if (t.skill === 'phrase') {
        if (!S.tl) return null;
        const n = activeTarget(S.tl.notes, now - S.tl.sing, m);
        return n ? n.midi : null;
      }
      if (S.phase === 'cue') return t.hide ? null : t.cue[0];
      if (S.phase === 'sing') return t.hide ? null : t.target;
      return t.target;
    },
    anchor(now) {
      if (!S || !S.trial || !S.tl) return null;
      const lt = now - S.tl.sing;
      const n = S.tl.notes.find((x) => lt < x.t1 && x.t0 - lt < 700);
      return n ? n.pos : null;
    },
    scene(s, now) {
      if (!S || !S.trial) return;
      const t = S.trial;
      if (t.skill === 'interval') s.dronePc = pcOf(t.tonic);
      if (t.skill !== 'phrase' || !S.tl) return;
      s.nowFrac = 0.34;
      s.bars = [];
      S.tl.notes.forEach((n, i) => {
        s.bars.push({ t0: S.tl.listen + n.t0, t1: S.tl.listen + n.t1, pos: n.pos, cls: 'ref' });
        const r = S.tl.res[i];
        s.bars.push({ t0: S.tl.sing + n.t0, t1: S.tl.sing + n.t1, pos: n.pos, cls: r ? r.cls : 'todo' });
      });
    },
    pill: () => '',
  };
}
