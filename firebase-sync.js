const firebaseConfig = {
  apiKey: "AIzaSyAzZaIWxPTIT8Q07cuH-clasTDxvI2Bmd4",
  authDomain: "cah-game-2aa1d.firebaseapp.com",
  databaseURL: "https://cah-game-2aa1d-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "cah-game-2aa1d",
  storageBucket: "cah-game-2aa1d.firebasestorage.app",
  messagingSenderId: "1077370275060",
  appId: "1:1077370275060:web:04073c4ef1bb1ece2a4aa1"
};

  const CAH = window.CAH;
  const box = document.getElementById('online-box');
  if (!CAH || !box || !window.firebase || firebaseConfig.apiKey === 'YOUR_API_KEY') return;

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  let uid = null;
  const ready = firebase.auth().signInAnonymously().then(c => { uid = c.user.uid; }).catch(e => console.error('Firebase auth', e));

  let attached = '';          // room|seat currently listened to
  let refs = [];              // [ref, handler] pairs to detach
  let all = {};               // rooms/CODE/rounds
  let remoteRound = null;
  let seatClash = false;
  let submittedKey = '';

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const roomRef = () => db.ref('rooms/' + CAH.state().room);

  function detach() { refs.forEach(([r, h, ev]) => r.off(ev, h)); refs = []; }
  function listen(ref, fn) { ref.on('value', fn); refs.push([ref, fn, 'value']); }

  async function attach() {
    const st = CAH.state();
    const key = st.room + '|' + st.seat;
    if (!st.room || key === attached) return;
    await ready;
    if (!uid) return;
    detach();
    attached = key;
    all = {}; remoteRound = null; seatClash = false;
    const base = db.ref('rooms/' + st.room);

    // Round sync: first value wins, later changes move everyone.
    listen(base.child('round'), snap => {
      const v = snap.val();
      const local = CAH.state().round;
      if (v == null) { base.child('round').set(local); remoteRound = local; return; }
      remoteRound = v;
      if (v !== local) CAH.setRound(v);
    });

    // Submissions, winners (and so scores) for every round.
    listen(base.child('rounds'), snap => { all = snap.val() || {}; render(); });

    // Seat presence: warns if two phones are in the same seat.
    const seatRef = base.child('seats/' + st.seat);
    listen(seatRef, snap => { const v = snap.val(); seatClash = Boolean(v && v !== uid); render(); });
    seatRef.transaction(v => v || uid).then(res => { if (res.snapshot.val() === uid) seatRef.onDisconnect().remove(); });
  }

  function scores() {
    const t = {};
    Object.values(all).forEach(r => { if (r && r.winner) t[r.winner] = (t[r.winner] || 0) + 1; });
    return t;
  }

  function who(key) { return key[0] === 'b' ? 'Bot ' + (parseInt(key.slice(1), 10) + 1) : CAH.seatLabel(parseInt(key, 10)); }

  function render() {
    const st = CAH.state();
    box.innerHTML = '';
    if (!st.syncMode || !st.room || !st.prompt || !(st.heading === 'Round' || st.heading === 'Czar')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const cur = all[st.round] || {};
    const subs = cur.subs || {};
    const winner = cur.winner;

    const head = el('p', 'online-line', '🌐 Online · ' + Object.keys(subs).length + ' answer' + (Object.keys(subs).length === 1 ? '' : 's') + ' in');
    box.appendChild(head);

    const sc = scores();
    const keys = Object.keys(sc).sort((a, b) => sc[b] - sc[a]);
    if (keys.length) box.appendChild(el('p', 'online-scores', '🏆 ' + keys.map(k => who(k) + ' ' + sc[k]).join(' · ')));
    if (seatClash) box.appendChild(el('p', 'online-warn', '⚠️ Another phone is already in ' + CAH.seatLabel(st.seat) + '. Use your own personal link.'));

    if (winner) box.appendChild(el('p', 'online-winner', '👑 Round winner: ' + who(winner) + '. Tap Next Round when ready.'));

    // Players submit.
    if (st.heading === 'Round') {
      const answers = CAH.selectedAnswers();
      const mine = subs[st.seat];
      const btn = el('button', 'reveal-button', mine ? 'Answer sent ✓ (tap to change)' : 'Submit answer');
      btn.type = 'button';
      btn.disabled = Boolean(winner) || answers.length !== st.pick;
      btn.addEventListener('click', () => roomRef().child('rounds/' + st.round + '/subs/' + st.seat).set(answers));
      box.appendChild(btn);
    }

    // Czar (or everyone, when there is no Czar) sees all answers and picks.
    if (st.isCzar || st.czarMode === 'off') {
      const list = [];
      Object.keys(subs).forEach(k => { if (String(k) !== String(st.seat)) list.push([k, subs[k]]); });
      if (st.czarMode === 'off' && subs[st.seat]) list.push([String(st.seat), subs[st.seat]]);
      CAH.botPlays().forEach((t, i) => list.push(['b' + i, t]));
      if (!list.length) box.appendChild(el('p', 'online-line', 'Waiting for answers…'));
      const wrap = el('div', 'online-subs');
      list.forEach(([k, texts]) => {
        const card = el('div', 'card black-card filled online-card' + (winner === k ? ' selected' : ''));
        card.appendChild(CAH.fillFragment(st.prompt.Text, texts));
        const pick = el('button', 'small-button', winner ? (winner === k ? 'Winner 👑' : '—') : 'Pick this one');
        pick.type = 'button';
        pick.disabled = Boolean(winner);
        pick.addEventListener('click', () => roomRef().child('rounds/' + st.round + '/winner').transaction(v => v || k));
        const cell = el('div', 'online-cell');
        cell.append(card, pick);
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
})();