'use strict';

const ROW_H = 56;
const OVERSCAN = 8;
const PREFS_KEY = 'ytml.prefs';
const BLOCKED_KEY = 'ytml.blocked';
const STALE_AFTER = 24 * 60 * 60; // 저장된 목록이 이보다 오래되면 열 때 자동으로 새로고침 (초)
// 이 오류 코드는 영상이 삭제됐거나 외부 재생(임베드)이 막힌 경우라서 다시 시도해도 소용없다.
const PERMANENT_ERRORS = new Set([2, 100, 101, 150, 153]);

const $ = (sel) => document.querySelector(sel);
const els = {
  summary: $('#summary'), synced: $('#synced'), refresh: $('#refresh'), settings: $('#settings'),
  q: $('#q'), chips: $('#chips'), playAll: $('#playAll'), shuffleAll: $('#shuffleAll'),
  cols: $('#cols'), list: $('#list'), spacer: $('#spacer'), rows: $('#rows'), empty: $('#empty'),
  player: $('#player'), npTitle: $('#npTitle'), npSub: $('#npSub'),
  cur: $('#cur'), tot: $('#tot'), seek: $('#seek'),
  btnPlay: $('#btnPlay'), btnPrev: $('#btnPrev'), btnNext: $('#btnNext'),
  btnShuffle: $('#btnShuffle'), btnLocate: $('#btnLocate'),
  favOnly: $('#favOnly'), favCount: $('#favCount'), npFav: $('#npFav'),
  volume: $('#volume'), vol: $('#vol'), volVal: $('#volVal'), btnMute: $('#btnMute'),
  queueInfo: $('#queueInfo'), openYtm: $('#openYtm'),
  setup: $('#setup'), setupForm: $('#setupForm'), headers: $('#headers'), setupErr: $('#setupErr'),
  connect: $('#connect'), disconnect: $('#disconnect'), resetBlocked: $('#resetBlocked'),
  setupCancel: $('#setupCancel'), toast: $('#toast'),
};

// ---------- 저장소 (실패해도 동작하도록) ----------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장이 안 돼도 이번 세션에서는 그대로 동작한다.
  }
}

const prefs = { sort: 'liked', desc: false, shuffle: false, volume: 100, muted: false, ...load(PREFS_KEY, {}) };
const blocked = new Set(load(BLOCKED_KEY, []));
const state = {
  all: [], sorted: [], view: [], artist: null, album: null, authed: false, fetchedAt: null, loading: false,
  favs: new Set(), favOnly: false, favPlaylistId: null,
};
const pendingFavs = new Set(); // YouTube Music에 반영 중인 곡
const play = { queue: [], order: [], pos: -1, current: null, playing: false, failStreak: 0, seeking: false };

// ---------- 포맷 ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtNum = (n) => n.toLocaleString('ko-KR');
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${fmtNum(h)}시간 ${m}분` : `${m}분`;
}
function relTime(ts) {
  const min = Math.floor((Date.now() / 1000 - ts) / 60);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 60 / 24)}일 전`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(message, isError = false, ms = isError ? 6000 : 3200) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.detail || `요청에 실패했어요 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- 검색 ----------
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const isChoseong = (s) => /^[ㄱ-ㅎ]+$/.test(s);
const norm = (s) => s.normalize('NFKC').toLowerCase();
function toChoseong(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 0xac00;
    out += code >= 0 && code < 11172 ? CHO[Math.floor(code / 588)] : ch;
  }
  return out;
}

function prepare(song) {
  song.artistStr = song.artists.join(', ');
  song.hay = norm(`${song.title} ${song.artistStr} ${song.album ?? ''}`);
  song.cho = toChoseong(song.hay);
  return song;
}

function matcher() {
  // 자음만 입력한 단어는 초성으로, 나머지는 일반 문자열로 비교한다. NFKC는 호환 자모를 바꿔 버리므로 초성 판별 뒤에 적용한다.
  const tokens = els.q.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    .map((t) => (isChoseong(t) ? { cho: true, t } : { cho: false, t: norm(t) }));
  return (s) => (!state.favOnly || state.favs.has(s.id))
    && (!state.artist || s.artists.includes(state.artist))
    && (!state.album || s.album === state.album)
    && tokens.every(({ cho, t }) => (cho ? s.cho : s.hay).includes(t));
}

// ---------- 정렬 ----------
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const cmpText = (x, y) => (!x || !y ? !x - !y : collator.compare(x, y)); // 빈 값은 맨 뒤로
const SORTS = {
  liked: (a, b) => a.i - b.i,
  title: (a, b) => cmpText(a.title, b.title) || a.i - b.i,
  artist: (a, b) => cmpText(a.artistStr, b.artistStr) || cmpText(a.album, b.album) || a.i - b.i,
  album: (a, b) => cmpText(a.album, b.album) || cmpText(a.artistStr, b.artistStr) || a.i - b.i,
  dur: (a, b) => a.dur - b.dur || a.i - b.i,
};

function resort() {
  state.sorted = state.all.slice().sort(SORTS[prefs.sort] || SORTS.liked);
  if (prefs.desc) state.sorted.reverse();
  for (const btn of els.cols.querySelectorAll('button')) {
    if (btn.dataset.sort === prefs.sort) btn.setAttribute('aria-sort', prefs.desc ? 'descending' : 'ascending');
    else btn.removeAttribute('aria-sort');
  }
}

function refilter({ keepScroll = false } = {}) {
  state.view = state.sorted.filter(matcher());
  if (!keepScroll) els.list.scrollTop = 0;
  renderChips();
  renderSummary();
  renderList();
}

function setSort(key) {
  if (prefs.sort === key) prefs.desc = !prefs.desc;
  else Object.assign(prefs, { sort: key, desc: false });
  save(PREFS_KEY, prefs);
  resort();
  refilter();
}

// ---------- 렌더링 ----------
function renderSummary() {
  const total = state.all.length, shown = state.view.length;
  if (!total) {
    els.summary.textContent = '';
    return;
  }
  const secs = state.view.reduce((n, s) => n + s.dur, 0);
  const count = shown === total ? `${fmtNum(total)}곡` : `${fmtNum(shown)} / ${fmtNum(total)}곡`;
  els.summary.textContent = `${count} · ${fmtLong(secs)}`;
}

function renderSynced() {
  els.synced.textContent = state.fetchedAt ? `${relTime(state.fetchedAt)} 동기화` : '';
}

function renderChips() {
  const chips = [];
  if (state.artist) chips.push(['artist', '아티스트', state.artist]);
  if (state.album) chips.push(['album', '앨범', state.album]);
  els.chips.innerHTML = chips.map(([key, label, value]) =>
    `<button class="chip" data-clear="${key}" title="필터 해제"><span class="chip-k">${label}</span><span class="chip-v">${esc(value)}</span><span class="x">×</span></button>`,
  ).join('');
  els.chips.hidden = !chips.length;
}

function renderEmpty() {
  let html = '';
  if (state.loading && !state.all.length) {
    html = '<div class="spinner"></div><strong>좋아요 목록을 불러오는 중이에요</strong><span>곡이 많으면 1분 정도 걸릴 수 있어요.</span>';
  } else if (!state.all.length && !state.authed) {
    html = '<strong>YouTube Music을 연결해 주세요</strong><span>연결하면 좋아요한 곡 전체가 여기에 한 번에 표시돼요.</span><button class="btn primary" data-action="setup">연결하기</button>';
  } else if (!state.all.length) {
    html = '<strong>좋아요한 곡이 없어요</strong><span>YouTube Music에서 좋아요를 누른 뒤 새로고침해 보세요.</span>';
  } else if (!state.view.length && state.favOnly && !favCount()) {
    html = '<strong>즐겨찾기한 곡이 없어요</strong><span>곡에 마우스를 올리고 오른쪽 ☆를 눌러 추가해 보세요.</span>';
  } else if (!state.view.length) {
    html = '<strong>검색 결과가 없어요</strong><span>다른 검색어를 입력하거나 필터를 해제해 보세요.</span>';
  }
  els.empty.innerHTML = html;
  els.empty.hidden = !html;
}

let range = null;
function renderList() {
  els.spacer.style.height = `${state.view.length * ROW_H}px`;
  renderEmpty();
  range = null;
  renderRows();
}

function renderRows() {
  const top = els.list.scrollTop, height = els.list.clientHeight;
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(state.view.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);
  if (range && range[0] === start && range[1] === end) return;
  range = [start, end];
  els.rows.style.transform = `translateY(${start * ROW_H}px)`;
  let html = '';
  for (let k = start; k < end; k++) html += rowHtml(state.view[k], k);
  els.rows.innerHTML = html;
}

const EQ = '<span class="eq"><i></i><i></i><i></i></span>';
function rowHtml(s, k) {
  const isCurrent = play.current && play.current.id === s.id;
  const isBlocked = blocked.has(s.id);
  const cls = `row${isCurrent ? ' current' : ''}${!s.ok || isBlocked ? ' bad' : ''}`;
  const hint = !s.ok ? '재생할 수 없는 곡이에요 (YouTube Music에서 내려갔을 수 있어요)'
    : isBlocked ? '이 앱에서는 재생이 막힌 곡이에요. 클릭하면 YouTube Music에서 열려요' : '';
  const thumb = s.thumb
    ? `<img class="thumb" src="${esc(s.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '<div class="thumb"></div>';
  const artists = s.artists.map((a) => `<a href="#" data-artist="${esc(a)}">${esc(a)}</a>`).join(', ');
  const album = s.album ? `<a href="#" data-album="${esc(s.album)}">${esc(s.album)}</a>` : '';
  return `<div class="${cls}" data-k="${k}"${hint ? ` title="${hint}"` : ''}>`
    + `<div class="c-num">${isCurrent ? EQ : s.i + 1}</div>`
    + `<div class="c-title">${thumb}<span class="ellip"><span class="title">${esc(s.title)}</span>${s.explicit ? '<span class="badge">E</span>' : ''}</span></div>`
    + `<div class="c-artist ellip">${artists}</div>`
    + `<div class="c-album ellip">${album}</div>`
    + `<div class="c-fav">${s.id ? favButton(s.id) : ''}</div>`
    + `<div class="c-dur">${s.dur ? fmtTime(s.dur) : ''}</div></div>`;
}

const STAR = '<svg class="ico star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';
function favButton(id) {
  const on = state.favs.has(id);
  return `<button class="fav${on ? ' on' : ''}${pendingFavs.has(id) ? ' busy' : ''}" data-fav="${esc(id)}" `
    + `aria-pressed="${on}" title="${on ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가'}">${STAR}</button>`;
}

function setData(data, { keepScroll = false } = {}) {
  state.all = data.tracks.map(prepare);
  state.fetchedAt = data.fetchedAt;
  resort();
  refilter({ keepScroll });
  renderSynced();
  renderFavControls();
}

// ---------- 즐겨찾기 ----------
// 즐겨찾기는 내 YouTube Music 계정의 비공개 재생목록에 저장돼서 다른 PC와 휴대폰 앱에서도 똑같다.
const favCount = () => state.all.reduce((n, s) => n + (state.favs.has(s.id) ? 1 : 0), 0);

function renderFavControls() {
  els.favCount.textContent = fmtNum(favCount());
  els.favOnly.setAttribute('aria-pressed', state.favOnly);
  const id = play.current?.id;
  const on = !!id && state.favs.has(id);
  els.npFav.classList.toggle('on', on);
  els.npFav.classList.toggle('busy', !!id && pendingFavs.has(id));
  els.npFav.setAttribute('aria-pressed', on);
  els.npFav.title = on ? '즐겨찾기에서 빼기 (F)' : '즐겨찾기에 추가 (F)';
}

function renderFavs() {
  renderFavControls();
  if (state.favOnly) {
    refilter({ keepScroll: true }); // 즐겨찾기만 보는 중이면 뺀 곡은 바로 목록에서 사라진다
  } else {
    range = null;
    renderRows();
  }
}

// 서버가 돌려준 목록으로 맞추되, 아직 반영 중인 곡은 지금 화면 상태를 유지한다.
function applyFavs(res) {
  const next = new Set(res.ids);
  for (const id of pendingFavs) {
    if (state.favs.has(id)) next.add(id);
    else next.delete(id);
  }
  state.favs = next;
  state.favPlaylistId = res.playlistId;
  renderFavs();
}

async function toggleFav(id) {
  if (!id || pendingFavs.has(id)) return;
  if (!state.authed) {
    openSetup('즐겨찾기는 YouTube Music 재생목록에 저장돼서 연결이 필요해요.');
    return;
  }
  const adding = !state.favs.has(id);
  if (adding) state.favs.add(id);
  else state.favs.delete(id);
  pendingFavs.add(id); // 응답을 기다리지 않고 화면에 먼저 반영한다
  renderFavs();
  try {
    const res = await api(`/api/favorites/${encodeURIComponent(id)}`, { method: adding ? 'PUT' : 'DELETE' });
    pendingFavs.delete(id);
    const created = !state.favPlaylistId && res.playlistId; // 연달아 눌러도 처음 응답에서만 알린다
    applyFavs(res);
    if (created) toast('YouTube Music에 비공개 재생목록 "즐겨찾기 (좋아요 뷰어)"를 만들었어요.');
  } catch (err) {
    pendingFavs.delete(id);
    if (adding) state.favs.delete(id);
    else state.favs.add(id);
    renderFavs();
    if (err.status === 401) {
      state.authed = false;
      openSetup(err.message);
    } else {
      toast(err.message, true);
    }
  }
}

// 다른 PC나 휴대폰에서 바꾼 즐겨찾기를 가져온다. 실패해도 저장된 즐겨찾기로 계속 쓴다.
async function syncFavs() {
  if (!state.authed) return;
  try {
    applyFavs(await api('/api/favorites/sync', { method: 'POST' }));
  } catch (err) {
    if (err.status === 401) {
      state.authed = false;
      toast(`${err.message}\n(⚙ 설정에서 다시 연결할 수 있어요)`, true, 10000);
    }
  }
}

// ---------- 동기화 ----------
async function refresh() {
  if (state.loading) return;
  if (!state.authed) return openSetup();
  const before = state.all.length;
  state.loading = true;
  els.refresh.disabled = true;
  els.refresh.classList.add('busy');
  els.refresh.querySelector('span').textContent = '불러오는 중…';
  renderEmpty();
  try {
    const data = await api('/api/refresh', { method: 'POST' });
    setData(data, { keepScroll: true });
    const diff = state.all.length - before;
    toast(before
      ? `동기화했어요 · ${fmtNum(state.all.length)}곡${diff ? ` (${diff > 0 ? '+' : ''}${fmtNum(diff)})` : ''}`
      : `${fmtNum(state.all.length)}곡을 불러왔어요.`);
    syncFavs();
  } catch (err) {
    if (err.status === 401) {
      state.authed = false;
      openSetup(err.message);
    } else {
      toast(err.message, true);
    }
  } finally {
    state.loading = false;
    els.refresh.disabled = false;
    els.refresh.classList.remove('busy');
    els.refresh.querySelector('span').textContent = '새로고침';
    renderEmpty();
  }
}

// ---------- 재생 ----------
let ytPlayer = null;   // 준비가 끝난 YT.Player
let ytLoading = null;  // 플레이어 생성 Promise

const ytApi = new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = () => resolve(window.YT);
});
(() => {
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => toast('YouTube 플레이어를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', true);
  document.head.append(script);
})();

function getPlayer(firstId) {
  ytLoading ??= ytApi.then((YT) => new Promise((resolve) => {
    const player = new YT.Player('yt', {
      width: '100%',
      height: '100%',
      videoId: firstId,
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          ytPlayer = player;
          applyVolume();
          resolve(player);
        },
        onStateChange,
        onError,
      },
    });
  }));
  return ytLoading;
}

async function loadVideo(id) {
  const isFirst = !ytLoading;
  const player = await getPlayer(id);
  // 첫 곡은 생성할 때 videoId로 넘겼으므로 다시 불러오지 않는다.
  if (isFirst) player.playVideo();
  else player.loadVideoById(id);
}

const isPlayable = (s) => s.ok && !blocked.has(s.id);

function shuffledOrder(n, firstIdx) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const at = order.indexOf(firstIdx);
  [order[0], order[at]] = [order[at], order[0]];
  return order;
}

// 대기열 안의 queueIdx 곡을 기준으로 재생 순서를 다시 만들고, 그 곡의 순서상 위치를 돌려준다.
function buildOrder(queueIdx) {
  const n = play.queue.length;
  play.order = prefs.shuffle ? shuffledOrder(n, queueIdx) : [...Array(n).keys()];
  return prefs.shuffle ? 0 : queueIdx;
}

function startQueue(list, first = null) {
  play.queue = list.filter(isPlayable);
  if (!play.queue.length) return toast('재생할 수 있는 곡이 없어요.');
  const idx = first ? Math.max(0, play.queue.indexOf(first))
    : prefs.shuffle ? Math.floor(Math.random() * play.queue.length) : 0;
  play.failStreak = 0;
  playAt(buildOrder(idx));
}

function playAt(pos) {
  play.pos = pos;
  const song = play.queue[play.order[pos]];
  play.current = song;
  showNowPlaying(song);
  range = null;
  renderRows();
  loadVideo(song.id);
}

function step(dir) {
  const n = play.order.length;
  if (!n) return;
  let pos = play.pos;
  for (let tries = 0; tries < n; tries++) {
    pos = (pos + dir + n) % n; // 끝에 닿으면 처음으로 돌아간다
    if (isPlayable(play.queue[play.order[pos]])) return playAt(pos);
  }
  setPlaying(false);
  toast('재생할 수 있는 곡이 없어요.');
}

function prev() {
  if (ytPlayer && ytPlayer.getCurrentTime() > 3) ytPlayer.seekTo(0, true);
  else step(-1);
}

function togglePlay() {
  if (!play.current) return startQueue(state.view);
  if (!isPlayable(play.current)) return step(1);
  if (!ytPlayer) return;
  if (play.playing) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}

function setShuffle(on) {
  prefs.shuffle = on;
  save(PREFS_KEY, prefs);
  els.btnShuffle.classList.toggle('on', on);
  if (play.current && play.queue.length) play.pos = buildOrder(play.order[play.pos]);
  updateQueueInfo();
}

function setPlaying(on) {
  play.playing = on;
  document.body.classList.toggle('playing', on);
  const s = play.current;
  document.title = s ? `${on ? '▶ ' : ''}${s.title} · ${s.artistStr}` : '좋아요한 곡';
}

function onStateChange(e) {
  const { PLAYING, PAUSED, ENDED } = window.YT.PlayerState;
  if (e.data === PLAYING) {
    play.failStreak = 0;
    setPlaying(true);
  } else if (e.data === PAUSED) {
    setPlaying(false);
  } else if (e.data === ENDED) {
    step(1);
  }
}

function onError(e) {
  const song = play.current;
  if (!song) return;
  if (PERMANENT_ERRORS.has(e.data)) {
    blocked.add(song.id);
    save(BLOCKED_KEY, [...blocked]);
    range = null;
    renderRows();
  }
  if (++play.failStreak >= 8) {
    play.failStreak = 0; // 사용자가 다시 재생을 누르면 처음부터 다시 세도록
    setPlaying(false);
    return toast('여러 곡이 연달아 재생되지 않아서 멈췄어요.', true);
  }
  toast(`‘${song.title}’은(는) 여기서 재생할 수 없어서 건너뛰었어요.`);
  step(1);
}

function showNowPlaying(s) {
  els.player.hidden = false;
  els.npTitle.textContent = s.title;
  els.npSub.textContent = [s.artistStr, s.album].filter(Boolean).join(' · ');
  els.openYtm.href = `https://music.youtube.com/watch?v=${encodeURIComponent(s.id)}`;
  els.cur.textContent = '0:00';
  els.tot.textContent = fmtTime(s.dur);
  els.seek.value = 0;
  els.seek.style.setProperty('--p', '0%');
  updateQueueInfo();
  setPlaying(play.playing);
  renderFavControls();
}

function updateQueueInfo() {
  if (!play.queue.length) return;
  els.queueInfo.textContent = `대기열 ${fmtNum(play.pos + 1)} / ${fmtNum(play.queue.length)}${prefs.shuffle ? ' · 셔플' : ''}`;
}

function locateCurrent() {
  if (!play.current) return;
  const idx = state.view.findIndex((s) => s.id === play.current.id);
  if (idx < 0) return toast('지금 목록(검색·필터 결과)에 없는 곡이에요.');
  els.list.scrollTop = idx * ROW_H - els.list.clientHeight / 2 + ROW_H / 2;
}

function openInYtm(s) {
  if (ytPlayer && play.playing) ytPlayer.pauseVideo();
  window.open(`https://music.youtube.com/watch?v=${encodeURIComponent(s.id)}`, '_blank', 'noopener');
}

// ---------- 볼륨 ----------
let volumeChangedAt = 0;
const isSilent = () => prefs.muted || prefs.volume === 0;

function renderVolume() {
  const shown = isSilent() ? 0 : prefs.volume;
  els.vol.value = shown;
  els.vol.style.setProperty('--p', `${shown}%`);
  els.volVal.textContent = shown;
  els.btnMute.dataset.level = shown === 0 ? 'mute' : shown < 50 ? 'low' : 'high';
  els.btnMute.title = shown === 0 ? '음소거 해제 (M)' : '음소거 (M)';
}

function applyVolume() {
  if (!ytPlayer) return;
  ytPlayer.setVolume(prefs.volume);
  if (isSilent()) ytPlayer.mute();
  else ytPlayer.unMute();
}

function setVolume(value, muted = false) {
  prefs.volume = Math.max(0, Math.min(100, Math.round(value)));
  prefs.muted = muted;
  save(PREFS_KEY, prefs);
  volumeChangedAt = Date.now();
  renderVolume();
  applyVolume();
}

function nudgeVolume(delta) {
  if (prefs.muted && delta < 0) return;
  setVolume(prefs.volume + delta); // 음소거 중에 올리면 원래 볼륨에서 이어서 올라간다
}

function toggleMute() {
  if (isSilent()) setVolume(prefs.volume || 50);
  else setVolume(prefs.volume, true);
}

// YouTube 플레이어 안의 컨트롤로 바꾼 볼륨도 따라간다. 방금 직접 바꾼 직후에는
// 플레이어가 아직 예전 값을 돌려줄 수 있어서 잠깐 기다렸다가 맞춘다.
function syncVolumeFromPlayer() {
  if (Date.now() - volumeChangedAt < 1500) return;
  const volume = ytPlayer.getVolume(), muted = ytPlayer.isMuted();
  if (typeof volume !== 'number' || (volume === prefs.volume && muted === prefs.muted)) return;
  Object.assign(prefs, { volume, muted });
  save(PREFS_KEY, prefs);
  renderVolume();
}

setInterval(() => {
  if (!ytPlayer || !play.current) return;
  syncVolumeFromPlayer();
  if (play.seeking) return;
  const cur = ytPlayer.getCurrentTime() || 0;
  const dur = ytPlayer.getDuration() || play.current.dur || 0;
  els.cur.textContent = fmtTime(cur);
  els.tot.textContent = fmtTime(dur);
  els.seek.max = Math.max(1, Math.floor(dur));
  els.seek.value = Math.floor(cur);
  els.seek.style.setProperty('--p', `${dur ? (cur / dur) * 100 : 0}%`);
}, 250);

// ---------- 연결 설정 ----------
function openSetup(message = '') {
  els.setupErr.textContent = message;
  els.setupErr.hidden = !message;
  els.disconnect.hidden = !state.authed;
  els.resetBlocked.hidden = !blocked.size;
  els.resetBlocked.textContent = `재생 막힘 표시 초기화 (${fmtNum(blocked.size)}곡)`;
  if (!els.setup.open) els.setup.showModal();
  els.headers.focus();
}

els.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const headers = els.headers.value.trim();
  if (!headers) return openSetup('복사한 요청 헤더를 붙여넣어 주세요.');
  els.connect.disabled = true;
  els.connect.textContent = '확인 중…';
  let result;
  try {
    result = await api('/api/auth', { method: 'POST', body: JSON.stringify({ headers }) });
  } catch (err) {
    openSetup(err.message);
    return;
  } finally {
    els.connect.disabled = false;
    els.connect.textContent = '연결';
  }
  state.authed = true;
  els.headers.value = '';
  els.setup.close();
  toast('연결됐어요. 좋아요 목록을 불러올게요.');
  await refresh();
  // 동기화 결과 알림에 가려지지 않도록 경고는 마지막에 띄운다.
  if (result.warning) toast(result.warning, true, 12000);
});

els.disconnect.addEventListener('click', async () => {
  if (!confirm('연결을 해제할까요? 이미 불러온 목록은 계속 볼 수 있어요.')) return;
  try {
    await api('/api/auth', { method: 'DELETE' });
    state.authed = false;
    els.setup.close();
    renderEmpty();
    toast('연결을 해제했어요.');
  } catch (err) {
    openSetup(err.message);
  }
});

els.resetBlocked.addEventListener('click', () => {
  blocked.clear();
  save(BLOCKED_KEY, []);
  els.resetBlocked.hidden = true;
  range = null;
  renderRows();
  toast('재생 막힘 표시를 초기화했어요.');
});

els.setupCancel.addEventListener('click', () => els.setup.close());

// ---------- 이벤트 ----------
els.list.addEventListener('scroll', renderRows, { passive: true });
new ResizeObserver(() => {
  range = null;
  renderRows();
}).observe(els.list);

els.rows.addEventListener('click', (e) => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    toggleFav(favBtn.dataset.fav);
    return;
  }
  const link = e.target.closest('a[data-artist], a[data-album]');
  if (link) {
    e.preventDefault();
    if (link.dataset.artist) state.artist = link.dataset.artist;
    else state.album = link.dataset.album;
    refilter();
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  const song = state.view[Number(row.dataset.k)];
  if (!song.ok) return toast('재생할 수 없는 곡이에요.');
  if (blocked.has(song.id)) return openInYtm(song);
  startQueue(state.view, song);
});

els.empty.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="setup"]')) openSetup();
});

els.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-clear]');
  if (!chip) return;
  state[chip.dataset.clear] = null;
  refilter();
});

els.cols.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (btn) setSort(btn.dataset.sort);
});

let searchTimer;
els.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refilter, 80);
});

els.refresh.addEventListener('click', refresh);
els.settings.addEventListener('click', () => openSetup());
els.playAll.addEventListener('click', () => {
  setShuffle(false);
  startQueue(state.view);
});
els.shuffleAll.addEventListener('click', () => {
  setShuffle(true);
  startQueue(state.view);
});
els.btnPlay.addEventListener('click', togglePlay);
els.btnNext.addEventListener('click', () => step(1));
els.btnPrev.addEventListener('click', prev);
els.btnShuffle.addEventListener('click', () => setShuffle(!prefs.shuffle));
els.btnLocate.addEventListener('click', locateCurrent);
els.npFav.addEventListener('click', () => toggleFav(play.current?.id));
els.favOnly.addEventListener('click', () => {
  state.favOnly = !state.favOnly;
  renderFavControls();
  refilter();
});

els.seek.addEventListener('input', () => {
  play.seeking = true;
  els.cur.textContent = fmtTime(els.seek.value);
  els.seek.style.setProperty('--p', `${(els.seek.value / els.seek.max) * 100}%`);
});
els.seek.addEventListener('change', () => {
  if (ytPlayer) ytPlayer.seekTo(Number(els.seek.value), true);
  play.seeking = false;
});

els.vol.addEventListener('input', () => setVolume(Number(els.vol.value)));
els.btnMute.addEventListener('click', toggleMute);
els.volume.addEventListener('wheel', (e) => {
  e.preventDefault();
  nudgeVolume(e.deltaY < 0 ? 5 : -5);
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.target === els.q && e.key === 'Escape') {
    if (els.q.value) {
      els.q.value = '';
      refilter();
    } else {
      els.q.blur();
    }
    return;
  }
  // 슬라이더(range)를 만진 뒤에도 단축키가 먹도록 텍스트 입력칸만 제외한다.
  if (e.target.closest('input:not([type="range"]), textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  // 한글 입력 상태에서도 동작하도록 e.key 대신 물리 키(e.code)를 본다.
  switch (e.code) {
    case 'Slash':
      e.preventDefault();
      els.q.focus();
      els.q.select();
      break;
    case 'Space':
      if (e.target.closest('button, a')) return;
      e.preventDefault();
      togglePlay();
      break;
    case 'KeyN': step(1); break;
    case 'KeyP': prev(); break;
    case 'KeyS': setShuffle(!prefs.shuffle); break;
    case 'KeyL': locateCurrent(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyF': toggleFav(play.current?.id); break;
    case 'Minus':
    case 'NumpadSubtract': nudgeVolume(-5); break;
    case 'Equal':
    case 'NumpadAdd': nudgeVolume(5); break;
    default: break;
  }
});

setInterval(renderSynced, 60_000);

// ---------- 시작 ----------
async function init() {
  els.btnShuffle.classList.toggle('on', prefs.shuffle);
  renderVolume();
  try {
    const [status, favs] = await Promise.all([api('/api/status'), api('/api/favorites')]);
    state.authed = status.authed;
    state.favs = new Set(favs.ids); // 저장해 둔 즐겨찾기로 먼저 그린다
    state.favPlaylistId = favs.playlistId;
    if (status.count) setData(await api('/api/liked'));
    else renderList();
    renderFavControls();
    const stale = !status.fetchedAt || Date.now() / 1000 - status.fetchedAt > STALE_AFTER;
    if (status.authed && stale) refresh(); // 저장된 목록을 먼저 보여주고 뒤에서 새로 불러온다(즐겨찾기도 함께)
    else if (status.authed) syncFavs();
    else if (!status.count) openSetup();
  } catch (err) {
    toast(`서버에 연결하지 못했어요. app.py가 실행 중인지 확인해 주세요.\n(${err.message})`, true);
  }
}

init();
