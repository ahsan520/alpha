// ══════════════════════════════════════════════
// journal.js — trade journal CRUD and display
// ══════════════════════════════════════════════

function addTrade() {
  const sym = document.getElementById('j-sym').value.toUpperCase().trim();
  if (!sym) return;
  const entry = parseFloat(document.getElementById('j-entry').value) || 0;
  const exit = parseFloat(document.getElementById('j-exit').value) || 0;
  const size = parseFloat(document.getElementById('j-size').value) || 0;
  const stop = parseFloat(document.getElementById('j-stop').value) || 0;
  const dir = document.getElementById('j-dir').value;
  const status = document.getElementById('j-status').value;
  const signal = document.getElementById('j-signal').value;
  const notes = document.getElementById('j-notes').value;

  let pnl = 0, pnlPct = 0;
  if (status === 'CLOSED' && entry > 0 && exit > 0 && size > 0) {
    pnl = dir === 'LONG' ? (exit - entry) * size : (entry - exit) * size;
    pnlPct = dir === 'LONG' ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
  }
  const rr = (stop > 0 && entry > 0) ? Math.abs((exit || entry) - entry) / Math.abs(entry - stop) : null;

  STATE.trades.unshift({
    id: Date.now(), date: new Date().toLocaleDateString(),
    sym, dir, status, entry, exit, size, stop,
    pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
    signal, notes, rr: rr ? parseFloat(rr.toFixed(2)) : null
  });
  localStorage.setItem('a49_trades', JSON.stringify(STATE.trades));
  ['j-sym', 'j-entry', 'j-exit', 'j-size', 'j-stop', 'j-signal', 'j-notes'].forEach(id => document.getElementById(id).value = '');
  renderJournal();
}

function delTrade(id) {
  STATE.trades = STATE.trades.filter(t => t.id !== id);
  localStorage.setItem('a49_trades', JSON.stringify(STATE.trades));
  renderJournal();
}

function renderJournal() {
  const { trades } = STATE;
  const closed = trades.filter(t => t.status === 'CLOSED');
  const wins = closed.filter(t => t.pnl > 0).length;
  const totPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const rrTrades = closed.filter(t => t.rr);
  const avgRR = rrTrades.length ? (rrTrades.reduce((s, t) => s + t.rr, 0) / rrTrades.length).toFixed(2) : '—';
  const wr = closed.length ? ((wins / closed.length) * 100).toFixed(0) + '%' : '0%';

  document.getElementById('js-total').textContent = trades.length;
  document.getElementById('js-wr').textContent = wr;
  document.getElementById('js-wr').style.color = wins >= (closed.length / 2) ? 'var(--bull)' : 'var(--bear)';
  document.getElementById('js-pnl').textContent = '$' + totPnl.toFixed(2);
  document.getElementById('js-pnl').style.color = totPnl >= 0 ? 'var(--bull)' : 'var(--bear)';
  document.getElementById('js-rr').textContent = avgRR;

  document.getElementById('j-tbody').innerHTML = trades.map(t => {
    const pc = t.pnl > 0 ? 'var(--bull)' : t.pnl < 0 ? 'var(--bear)' : 'var(--text-dim)';
    const dc = t.dir === 'LONG' ? 'var(--bull)' : 'var(--bear)';
    return `<tr>
      <td style="color:var(--text-dim)">${t.date}</td>
      <td style="color:var(--accent);font-weight:700">${t.sym}</td>
      <td style="color:${dc};font-weight:700">${t.dir}</td>
      <td>${t.entry || '—'}</td><td>${t.exit || '—'}</td><td>${t.size || '—'}</td>
      <td style="color:${pc};font-weight:700">${t.status === 'CLOSED' ? '$' + t.pnl : 'OPEN'}</td>
      <td style="color:${pc}">${t.status === 'CLOSED' ? t.pnlPct + '%' : '—'}</td>
      <td style="max-width:160px;white-space:normal;color:var(--text-dim);font-size:9px">${t.signal || '—'}</td>
      <td><span style="font-size:8px;padding:2px 6px;border-radius:3px;background:${t.status === 'OPEN' ? 'rgba(61,155,255,.15)' : 'rgba(100,100,100,.2)'};color:${t.status === 'OPEN' ? 'var(--accent)' : 'var(--text-dim)'}">${t.status}</span></td>
      <td><button class="delbtn" onclick="delTrade(${t.id})">×</button></td>
    </tr>`;
  }).join('');
}

function calcPos() {
  const acc = parseFloat(document.getElementById('ps-acc').value) || 0;
  const risk = parseFloat(document.getElementById('ps-risk').value) || 0;
  const entry = parseFloat(document.getElementById('ps-entry').value) || 0;
  const stop = parseFloat(document.getElementById('ps-stop').value) || 0;
  if (!acc || !risk || !entry || !stop || entry === stop) return;
  const riskD = acc * (risk / 100);
  const stopD = Math.abs(entry - stop);
  const units = riskD / stopD;
  const posSize = units * entry;
  const distPct = (stopD / entry * 100).toFixed(2);
  document.getElementById('pc-r').textContent = '$' + riskD.toFixed(2);
  document.getElementById('pc-u').textContent = units.toFixed(4);
  document.getElementById('pc-p').textContent = '$' + posSize.toFixed(2);
  document.getElementById('pc-d').textContent = distPct + '%';
  document.getElementById('pc-result').style.display = 'grid';
}
