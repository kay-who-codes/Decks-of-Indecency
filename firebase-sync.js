/* firebase-sync.js: online multiplayer for Decks of Indecency.
   Shows a status badge so you can always see whether online play is working. */
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

  // ---- Status badge (always visible) ----
  const badge = el('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2000;padding:5px 10px;border-radius:999px;font:700 12px sans-serif;color:#fff;background:#555;max-width:90vw;';
  document.body.appendChild(badge);
  function setBadge(text, ok) { badge.textContent = text; badge.style.background = ok === true ? '#2e7d32' : ok === false ? '#b9331f' : '#555'; }

  const CAH = window.CAH;
  const box = document.getElementById('online-box');
  if (!window.firebase) { setBadge('Online: Firebase scripts not loaded (check the 3 script tags)', false); return; }
  if (!CAH) { setBadge('Online: index.html not patched (window.CAH missing). Run patch_index.py', false); return; }
  if (!box) { setBadge('Online: #online-box missing in index.html. Run patch_index.py', false); return; }

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  let uid = null;
  setBadge('Online: connecting…');
  const ready = firebase.auth().signInAnonymously()
    .then(c => { uid = c.user.uid; setBadge('Online: connected ✓', true); })
    .catch(e => { setBadge('Online: sign-in failed (' + (e.code || e.message) + ')', false); console.error('Firebase auth', e); });
  db.ref('.info/connected').on('value', s => { if (uid) setBadge(s.val() ? 'Online: connected ✓' : 'Online: reconnecting…', Boolean(s.val())); });

  let attached = '', refs = [], all = {}, remoteRound = null, seatClash = false;
  const roomRef = () => db.ref('rooms/' + CAH.state().room);
  const detach = () => { refs.forEach(([r, h]) => r.off('value', h)); refs = []; };
  const listen = (ref, fn) => { ref.on('value', fn, e => { setBadge('Online: ' + (e.code || e.message), false); console.error(e); }); refs.push([ref, fn]); };

  async function attach() {
    const st = CAH.state();
    const key = st.room + '|' + st.seat;
    if (!st.room || key === attached) return;
    await ready;
    if (!uid) return;
    detach();
    attached = key; all = {}; remoteRound = null; seatClash = false;
    const base = db.ref('rooms/' + st.room);

    listen(base.child('round'), snap => {
      const v = snap.val(), local = CAH.state().round;
      if (v == null) { base.child('round').set(local); remoteRound = local; return; }
      remoteRound = v;
      if (v !== local) CAH.setRound(v);
    });
    listen(base.child('rounds'), snap => { all = snap.val() || {}; render(); });

    const seatRef = base.child('seats/' + st.seat);
    listen(seatRef, snap => { const v = snap.val(); seatClash = Boolean(v && v !== uid); render(); });
    seatRef.transaction(v => v || uid).then(res => { if (res.snapshot.val() === uid) seatRef.onDisconnect().remove(); });
  }

  const who = k => k[0] === 'b' ? 'Bot ' + (parseInt(k.slice(1), 10) + 1) : CAH.seatLabel(parseInt(k, 10));

  function render() {
    const st = CAH.state();
    box.innerHTML = '';
    if (!st.syncMode || !st.room || !st.prompt || !(st.heading === 'Round' || st.heading === 'Czar')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const cur = all[st.round] || {}, subs = cur.subs || {}, winner = cur.winner;
    const czarOn = st.czarMode !== 'off';
    const humans = Object.keys(subs).filter(k => !(czarOn && String(k) === String(st.czarSeat)));
    const expected = st.players - (czarOn ? 1 : 0);

    box.appendChild(el('p', 'online-line', '🌐 Online · ' + humans.length + ' of ' + expected + ' players have submitted'));

    const tally = {};
    Object.values(all).forEach(r => { if (r && r.winner) tally[r.winner] = (tally[r.winner] || 0) + 1; });
    const ks = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
    if (ks.length) box.appendChild(el('p', 'online-scores', '🏆 ' + ks.map(k => who(k) + ' ' + tally[k]).join(' · ')));
    if (seatClash) box.appendChild(el('p', 'online-warn', '⚠️ Another phone is already in ' + CAH.seatLabel(st.seat) + '. Use your own personal link.'));
    if (winner) box.appendChild(el('p', 'online-winner', '👑 Winner: ' + who(winner) + '. Tap Next Round.'));

    if (st.heading === 'Round') {
      const answers = CAH.selectedAnswers();
      const btn = el('button', 'reveal-button', subs[st.seat] ? 'Answer sent ✓ (tap to change)' : 'Submit answer');
      btn.type = 'button';
      btn.disabled = Boolean(winner) || answers.length !== st.pick;
      btn.addEventListener('click', () => roomRef().child('rounds/' + st.round + '/subs/' + st.seat).set(answers));
      box.appendChild(btn);
    }

    if (st.isCzar || !czarOn) {
      const list = Object.keys(subs).filter(k => czarOn || String(k) !== String(st.seat) || true).map(k => [k, subs[k]]);
      CAH.botPlays().forEach((t, i) => list.push(['b' + i, t]));
      if (!list.length) box.appendChild(el('p', 'online-line', 'Waiting for answers…'));
      const wrap = el('div', 'online-subs');
      list.forEach(([k, texts], i) => {
        const card = el('div', 'card black-card filled online-card' + (winner === k ? ' selected' : ''));
        card.appendChild(CAH.fillFragment(st.prompt.Text, texts));
        const label = el('div', 'online-line', winner ? who(k) : 'Answer ' + (i + 1));
        const pick = el('button', 'small-button', winner ? (winner === k ? 'Winner 👑' : '—') : 'Pick this one');
        pick.type = 'button'; pick.disabled = Boolean(winner);
        pick.addEventListener('click', () => roomRef().child('rounds/' + st.round + '/winner').transaction(v => v || k));
        const cell = el('div', 'online-cell');
        cell.append(label, card, pick);
        wrap.appendChild(cell);
      });
      box.appendChild(wrap);
    }
  }

  window.CAHOnline = {
    onDraw() { attach().then(render); render(); },
    onSelect() { render(); },
    onRound(n) { if (attached && n !== remoteRound) { remoteRound = n; roomRef().child('round').set(n); } }
  };
  setBadge(uid ? 'Online: connected ✓' : 'Online: connecting…');
})();
