/* firebase-sync.js: online multiplayer for Decks of Indecency (v2).
   - Status badge: connection state, room code and how many seats are online.
   - Roster: every seat with an online dot, Czar crown and "submitted" tick.
   - Czar view: submissions (players + bots) as face-down WHITE cards, flipped one at a time.
   - Tapping a flipped card previews its text on the black card; "Pick winner" locks it in
     and the winning answer fills the black card on every device.
   Works with the existing index.html (needs window.CAH, #online-box and window.CAHOnline hooks). */
(() => {
  const firebaseConfig = {
    apiKey: "AIzaSyAzZaIWxPTIT8Q07cuH-clasTDxvI2Bmd4",
    authDomain: "cah-game-2aa1d.firebaseapp.com",
    databaseURL: "https://cah-game-2aa1d-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "cah-game-2aa1d",
    storageBucket: "cah-game-2aa1d.firebasestorage.app",
    messagingSenderId: "1077370275060",
    appId: "1:1077370275060:web:04073c4ef1bb1ece2a4aa1"
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  // ---------- Styles for everything this file draws ----------
  const style = document.createElement('style');
  style.textContent = `
    .online-roster{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;width:100%}
    .roster-chip{display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:13px;font-weight:700;
      background:var(--card-white);color:var(--ink);border:2px solid var(--ink);border-radius:999px}
    body.dark-mode .roster-chip{background:#201a14;color:#f1ead9;border-color:#f1ead9}
    .roster-chip.me{border-color:var(--crimson)}
    .roster-dot{width:10px;height:10px;border-radius:50%;background:#9a9186;flex-shrink:0}
    .roster-chip.on .roster-dot{background:#2e7d32}
    .roster-chip.off{opacity:.6}
    .online-sub{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%}
    .online-sub-cards{display:flex;flex-direction:column;gap:10px;width:100%;align-items:center}
    .card.online-white{width:100%;height:auto;min-height:150px;font-size:19px;background:#fffdf6;color:#1c1712;cursor:default}
    .card.online-white.flippable,.card.online-white.pickable{cursor:pointer}
    .card.online-white.online-back{background:#fffdf6;color:#b9331f;align-items:center;justify-content:center;
      text-align:center;font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;
      background-image:repeating-linear-gradient(45deg,rgba(28,23,18,.06) 0 8px,transparent 8px 16px)}
    .card.online-white.chosen,.card.online-white.winner-card{border-color:var(--crimson);border-width:4px;box-shadow:6px 9px 0 var(--crimson)}
    .online-hint{font-size:12px;color:var(--ink-soft)}
    body.dark-mode .online-hint{color:#b9ae9c}
    .online-badge-pad{height:44px}
  `;
  document.head.appendChild(style);

  // ---------- Status badge (always visible) ----------
  const badge = el('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:2000;padding:5px 10px;border-radius:999px;font:700 12px sans-serif;color:#fff;background:#555;max-width:90vw;';
  document.body.appendChild(badge);
  const pad = el('div', 'online-badge-pad'); document.body.appendChild(pad);

  let conn = 'connecting', errText = '', seatsNow = {};
  function updateBadge() {
    const st = window.CAH ? window.CAH.state() : {};
    let text, ok = null;
    if (conn === 'error') { text = 'Online: ' + errText; ok = false; }
    else if (conn === 'reconnecting') { text = 'Online: reconnecting…'; ok = false; }
    else if (conn === 'ok') {
      ok = true;
      text = 'Online ✓';
      if (st.syncMode && st.room) {
        const n = Object.keys(seatsNow).length;
        text += ' · ' + st.room + ' · ' + n + '/' + st.players + ' here';
      }
    } else text = 'Online: connecting…';
    badge.textContent = text;
    badge.style.background = ok === true ? '#2e7d32' : ok === false ? '#b9331f' : '#555';
  }

  const CAH = window.CAH;
  const box = document.getElementById('online-box');
  if (!window.firebase) { conn = 'error'; errText = 'Firebase scripts not loaded'; updateBadge(); return; }
  if (!CAH) { conn = 'error'; errText = 'window.CAH missing from index.html'; updateBadge(); return; }
  if (!box) { conn = 'error'; errText = '#online-box missing from index.html'; updateBadge(); return; }

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  let uid = null;
  const ready = firebase.auth().signInAnonymously()
    .then(c => { uid = c.user.uid; conn = 'ok'; updateBadge(); })
    .catch(e => { conn = 'error'; errText = 'sign-in failed (' + (e.code || e.message) + ')'; updateBadge(); console.error('Firebase auth', e); });

  let attached = '', refs = [], all = {}, remoteRound = null, seatClash = false, claimed = null;
  const roomRef = () => db.ref('rooms/' + CAH.state().room);
  const listen = (ref, fn) => { ref.on('value', fn, e => { conn = 'error'; errText = e.code || e.message; updateBadge(); console.error(e); }); refs.push([ref, fn]); };

  function releaseSeat() {
    if (!claimed) return;
    const r = db.ref('rooms/' + claimed.room + '/seats/' + claimed.seat);
    r.transaction(v => (v === uid ? null : v));
    r.onDisconnect().cancel();
    claimed = null;
  }
  function detach() { refs.forEach(([r, h]) => r.off('value', h)); refs = []; releaseSeat(); }

  // Claims this phone's seat. Called on attach AND on every reconnect, because
  // onDisconnect removes the seat when the connection drops.
  function claimSeat() {
    if (!uid || !attached) return;
    const st = CAH.state();
    if (!st.room) return;
    const seatRef = db.ref('rooms/' + st.room + '/seats/' + st.seat);
    seatRef.transaction(v => v || uid).then(res => {
      if (res.snapshot.val() === uid) { seatRef.onDisconnect().remove(); claimed = { room: st.room, seat: st.seat }; }
    });
  }

  db.ref('.info/connected').on('value', s => {
    if (!uid) return;
    if (s.val()) { conn = 'ok'; claimSeat(); } else conn = 'reconnecting';
    updateBadge();
  });

  async function attach() {
    const st = CAH.state();
    const key = st.room + '|' + st.seat;
    if (!st.room || key === attached) return;
    await ready;
    if (!uid) return;
    detach();
    attached = key; all = {}; seatsNow = {}; remoteRound = null; seatClash = false;
    const base = db.ref('rooms/' + st.room);

    listen(base.child('round'), snap => {
      const v = snap.val(), local = CAH.state().round;
      if (v == null) { base.child('round').set(local); remoteRound = local; return; }
      remoteRound = v;
      if (v !== local) CAH.setRound(v);
    });
    listen(base.child('rounds'), snap => { all = snap.val() || {}; render(); });
    listen(base.child('seats'), snap => {
      seatsNow = snap.val() || {};
      const mine = seatsNow[CAH.state().seat];
      seatClash = Boolean(mine && mine !== uid);
      render();
    });
    claimSeat();
  }

  const who = k => String(k)[0] === 'b' ? 'Bot ' + (parseInt(String(k).slice(1), 10) + 1) : CAH.seatLabel(parseInt(k, 10));

  // Stable shuffle so submissions aren't listed in seat order (which would give away who wrote what).
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // Czar-side local UI state
  const flipped = new Set();   // `${room}|${round}|${key}`
  let chosen = null;           // `${room}|${round}|${key}` currently previewed on the black card

  function blackEl() { return document.querySelector('#cards-container .black-card'); }
  function fillBlack(answers) {
    const b = blackEl(), st = CAH.state();
    if (!b || !st.prompt) return;
    b.classList.add('filled');
    b.textContent = '';
    b.appendChild(CAH.fillFragment(st.prompt.Text, answers));
  }

  function whiteCard(text, extra) {
    const c = el('div', 'card online-white' + (extra ? ' ' + extra : ''));
    c.textContent = text && text.trim() ? text : '________';
    return c;
  }

  function render() {
    updateBadge();
    const st = CAH.state();
    box.innerHTML = '';
    if (!st.syncMode || !st.room || !st.prompt || !(st.heading === 'Round' || st.heading === 'Czar')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    const cur = all[st.round] || {}, subs = cur.subs || {}, result = cur.result;
    const czarOn = st.czarMode !== 'off';
    // The Czar tells everyone which seat they are (index.html doesn't expose it).
    if (st.isCzar && cur.czar !== st.seat && uid) roomRef().child('rounds/' + st.round + '/czar').set(st.seat);
    const czarSeat = czarOn ? (st.isCzar ? st.seat : cur.czar) : null;

    // ----- Roster -----
    const humans = Object.keys(subs).filter(k => !(czarOn && czarSeat != null && String(k) === String(czarSeat)));
    const expected = st.players - (czarOn ? 1 : 0);
    box.appendChild(el('p', 'online-line', '🌐 ' + humans.length + ' of ' + expected + ' players have submitted'));
    const roster = el('div', 'online-roster');
    for (let s = 1; s <= st.players; s++) {
      const on = Boolean(seatsNow[s]);
      const isCzarSeat = czarOn && czarSeat != null && String(czarSeat) === String(s);
      const chip = el('span', 'roster-chip ' + (on ? 'on' : 'off') + (s === st.seat ? ' me' : ''));
      chip.appendChild(el('span', 'roster-dot'));
      let label = CAH.seatLabel(s) + (s === st.seat ? ' (you)' : '');
      if (isCzarSeat) label += ' 👑';
      else if (subs[s]) label += ' ✓';
      chip.appendChild(document.createTextNode(label));
      chip.setAttribute('aria-label', label + (on ? ', online' : ', offline'));
      roster.appendChild(chip);
    }
    box.appendChild(roster);

    // ----- Scores -----
    const tally = {};
    Object.values(all).forEach(r => { if (r && r.result) tally[r.result.key] = (tally[r.result.key] || 0) + 1; });
    const ks = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
    if (ks.length) box.appendChild(el('p', 'online-scores', '🏆 ' + ks.map(k => who(k) + ' ' + tally[k]).join(' · ')));
    if (seatClash) box.appendChild(el('p', 'online-warn', '⚠️ Another phone is already in ' + CAH.seatLabel(st.seat) + '. Use your own personal link.'));
    if (result) box.appendChild(el('p', 'online-winner', '👑 Winner: ' + who(result.key) + '. Tap Next Round.'));

    // ----- Player: submit -----
    if (st.heading === 'Round') {
      const answers = CAH.selectedAnswers();
      const btn = el('button', 'reveal-button', subs[st.seat] ? 'Answer sent ✓ (tap to change)' : 'Submit answer');
      btn.type = 'button';
      btn.disabled = Boolean(result) || answers.length !== st.pick;
      btn.addEventListener('click', () => roomRef().child('rounds/' + st.round + '/subs/' + st.seat).set(answers));
      box.appendChild(btn);
    }

    // ----- Judge view (Czar, or everyone when there is no Czar) -----
    if (st.isCzar || !czarOn) {
      const entries = Object.keys(subs)
        .filter(k => !(czarOn && String(k) === String(st.seat)))
        .map(k => ({ k, texts: subs[k] || [] }));
      CAH.botPlays().forEach((t, i) => entries.push({ k: 'b' + i, texts: t }));
      entries.sort((a, b) => hashStr(st.room + st.round + a.k) - hashStr(st.room + st.round + b.k));

      if (!entries.length) box.appendChild(el('p', 'online-line', 'Waiting for answers…'));
      else if (!result) box.appendChild(el('p', 'online-hint', 'Tap a white card to flip it. Tap it again to try it on the black card, then pick the winner.'));

      const wrap = el('div', 'online-subs');
      entries.forEach((e, i) => {
        const id = st.room + '|' + st.round + '|' + e.k;
        const isFlipped = Boolean(result) || flipped.has(id);
        const isChosen = chosen === id;
        const isWinner = result && result.key === e.k;
        const cell = el('div', 'online-cell');
        const group = el('div', 'online-sub');
        group.appendChild(el('div', 'online-line', result ? who(e.k) : 'Answer ' + (i + 1)));
        const cards = el('div', 'online-sub-cards');

        if (!isFlipped) {
          const back = el('div', 'card online-white online-back flippable', 'Decks of Indecency\nTap to flip');
          back.style.whiteSpace = 'pre-line';
          back.setAttribute('role', 'button'); back.setAttribute('tabindex', '0');
          back.setAttribute('aria-label', 'Face-down answer ' + (i + 1) + '. Tap to flip');
          const flip = () => { flipped.add(id); render(); };
          back.addEventListener('click', flip);
          back.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); } });
          cards.appendChild(back);
        } else {
          (e.texts.length ? e.texts : ['']).forEach(t => {
            const c = whiteCard(t, (isChosen ? 'chosen ' : '') + (isWinner ? 'winner-card ' : '') + (result ? '' : 'pickable'));
            if (!result) {
              c.setAttribute('role', 'button'); c.setAttribute('tabindex', '0');
              const choose = () => { chosen = id; render(); };
              c.addEventListener('click', choose);
              c.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); } });
            }
            cards.appendChild(c);
          });
        }
        group.appendChild(cards);

        if (result) {
          const tag = el('span', 'online-hint', isWinner ? 'Winner 👑' : '');
          group.appendChild(tag);
        } else if (isFlipped) {
          const pick = el('button', 'small-button', isChosen ? 'Pick as winner' : 'Select');
          pick.type = 'button';
          pick.addEventListener('click', () => {
            if (!isChosen) { chosen = id; render(); return; }
            roomRef().child('rounds/' + st.round + '/result').transaction(v => v || { key: e.k, answers: e.texts });
          });
          group.appendChild(pick);
        }
        cell.appendChild(group);
        wrap.appendChild(cell);
      });
      box.appendChild(wrap);

      // Preview the selected answer on the black card.
      if (!result && chosen) {
        const picked = entries.find(e => st.room + '|' + st.round + '|' + e.k === chosen);
        if (picked) fillBlack(picked.texts);
      }
    }

    // Once the Czar has picked, the winning answer is written into the black card on every device.
    if (result && result.answers) fillBlack(result.answers);
  }

  window.CAHOnline = {
    onDraw() { chosen = null; attach().then(render); render(); },
    // index.html redraws the black card AFTER this hook runs, so re-apply on the next tick.
    onSelect() { render(); setTimeout(() => {
      const cur = all[CAH.state().round] || {};
      if (cur.result && cur.result.answers) fillBlack(cur.result.answers);
    }, 0); },
    onRound(n) { if (attached && n !== remoteRound) { remoteRound = n; roomRef().child('round').set(n); } }
  };
  updateBadge();
})();
