const fetch = require('node-fetch');

const RIVALS_BASE_V1 = 'https://marvelrivalsapi.com/api/v1';
const RIVALS_BASE_V2 = 'https://marvelrivalsapi.com/api/v2';
const RIVALS_IMG     = 'https://marvelrivalsapi.com/rivals';

function getRivalsKey() {
  return process.env.RIVALS_API_KEY || '';
}

function rivalsHeaders() {
  return {
    'x-api-key': getRivalsKey(),
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; fragr/1.0)',
    'Origin': 'https://fragr.live',
    'Referer': 'https://fragr.live/',
  };
}

// ── In-memory cache ────────────────────────────────────────────────────────────
const _cache = new Map();  // key → { data, ts }
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 500) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

function getCacheStatus() {
  const now = Date.now();
  return [..._cache.entries()].map(([k, v]) => ({
    key: k,
    ageMinutes: Math.floor((now - v.ts) / 60000),
  }));
}

function clearRivalsCache(name) {
  if (name) {
    _cache.delete(name.toLowerCase());
    return 1;
  }
  const count = _cache.size;
  _cache.clear();
  return count;
}

// ── Rank helpers ───────────────────────────────────────────────────────────────
const RANK_ORDER = [
  'Bronze III','Bronze II','Bronze I',
  'Silver III','Silver II','Silver I',
  'Gold III','Gold II','Gold I',
  'Platinum III','Platinum II','Platinum I',
  'Diamond III','Diamond II','Diamond I',
  'Grandmaster III','Grandmaster II','Grandmaster I',
  'Celestial III','Celestial II','Celestial I',
  'Eternity','One Above All',
];

// Season ID → human label
function seasonLabel(id) {
  const n = String(id);
  const match = n.match(/^1001(\d+)$/);
  if (!match) return `S${id}`;
  const num    = parseInt(match[1], 10);
  const season = Math.ceil(num / 2);
  const half   = num % 2 === 0 ? '.5' : '';
  return `S${season}${half}`;
}

// ── Player fetch (v1 — free tier) ─────────────────────────────────────────────
async function fetchRivalsPlayer(username) {
  if (!username) throw new Error('Username required');
  const key = username.toLowerCase();
  const cached = getCached(key);
  if (cached) return { ...cached, _cached: true };

  const apiKey = getRivalsKey();
  if (!apiKey) throw new Error('RIVALS_API_KEY not configured');

  // v1 player stats — includes match_history in the same response
  const statsUrl = `${RIVALS_BASE_V1}/player/${encodeURIComponent(username)}`;
  const statsRes = await fetch(statsUrl, { headers: rivalsHeaders() });
  if (!statsRes.ok) {
    const body = await statsRes.text().catch(() => '');
    console.error(`[Rivals] ${statsRes.status} from ${statsUrl} — body: ${body.slice(0, 200)}`);
    if (statsRes.status === 404) throw new Error('Player not found');
    if (statsRes.status === 401) throw new Error('Invalid API key (401)');
    if (statsRes.status === 403) throw new Error('Invalid API key (403) — check RIVALS_API_KEY on Render');
    throw new Error(`Rivals API error: ${statsRes.status}`);
  }
  const statsData = await statsRes.json();

  if (statsData.isPrivate) {
    const partial = { username, uid: statsData.uid || null, isPrivate: true };
    setCache(key, partial);
    return partial;
  }

  const result = processRivalsData(username, statsData);
  setCache(key, result);
  return result;
}

// ── Process v1 API response ────────────────────────────────────────────────────
function processRivalsData(username, stats) {
  const p       = stats.player || {};
  const overall = stats.overall_stats || {};
  const uid     = stats.uid || p.uid || null;

  // Avatar
  const iconPath = p.icon?.player_icon || null;
  const avatarUrl = iconPath ? `${RIVALS_IMG}${iconPath}` : null;

  // Current rank — v1 uses rank.image (not rank.icon)
  const rank      = p.rank || {};
  const rankName  = rank.rank   || 'Unranked';
  const rankScore = rank.score  || '0';
  const rankIcon  = rank.image  ? `${RIVALS_IMG}${rank.image}` : null;
  const rankColor = rank.color  || '#888';

  // Season history
  const seasonMap = p.info?.rank_game_season || {};
  const seasons = Object.entries(seasonMap).map(([id, s]) => ({
    id,
    label:     seasonLabel(id),
    level:     s.level,
    rankScore: Math.round(s.rank_score || 0),
    maxLevel:  s.max_level,
    maxScore:  Math.round(s.max_rank_score || 0),
    winCount:  s.win_count || 0,
    diffScore: s.diff_score || 0,
  })).sort((a, b) => a.id.localeCompare(b.id));

  // Overall stats — v1: total_wins is a plain number, not an object
  const totalMatches = overall.total_matches || 0;
  const totalWins    = typeof overall.total_wins === 'object'
    ? (overall.total_wins?.wins || 0)
    : (overall.total_wins || 0);
  const winPct    = totalMatches > 0 ? ((totalWins / totalMatches) * 100).toFixed(1) : '0.0';
  const kd        = overall.overall_kd        ? overall.overall_kd.toFixed(2) : '0.00';
  const kda       = overall.overall_kda?.kda  ? overall.overall_kda.kda.toFixed(2) : '0.00';
  const playtime  = overall.total_play_time?.playtime || overall.ranked?.total_time_played || '--';
  const dmgPerMin = overall.per_minute?.total_damage_per_minute  || 0;
  const healPerMin= overall.per_minute?.total_healing_per_minute || 0;

  // Match history — v1 includes it inline as stats.match_history
  const rawMatches = stats.match_history || [];
  const matches = rawMatches.map(m => {
    const mp   = m.match_player || {};
    const hero = mp.player_hero || {};
    const heroIconPath = hero.hero_type || null;
    const scoreDelta = mp.score_info?.add_score != null
      ? Math.round(mp.score_info.add_score)
      : null;

    return {
      matchId:      m.match_uid,
      timestamp:    m.match_time_stamp ? new Date(m.match_time_stamp * 1000).toISOString() : null,
      duration:     m.match_play_duration || m.duration || '--',
      season:       m.match_season ?? m.season ?? '--',
      mapId:        m.match_map_id || m.map_id,
      mapThumb:     m.map_thumbnail ? `${RIVALS_IMG}${m.map_thumbnail}` : null,
      gameModeId:   m.game_mode_id,
      playModeId:   m.play_mode_id,
      win:          mp.is_win?.is_win ?? null,
      kills:        mp.kills ?? hero.kills ?? 0,
      deaths:       mp.deaths ?? hero.deaths ?? 0,
      assists:      mp.assists ?? hero.assists ?? 0,
      heroId:       hero.hero_id,
      heroName:     hero.hero_name || 'Unknown',
      heroIcon:     heroIconPath ? `${RIVALS_IMG}${heroIconPath}` : null,
      heroDamage:   Math.round(hero.total_hero_damage || 0),
      heroHeal:     Math.round(hero.total_hero_heal   || 0),
      damageTaken:  Math.round(hero.total_damage_taken|| 0),
      scoreDelta,
      newScore:     mp.score_info?.new_score != null ? Math.round(mp.score_info.new_score) : null,
      isMvp:        m.mvp_uid === mp.player_uid,
      isSvp:        m.svp_uid === mp.player_uid,
      disconnected: mp.disconnected || false,
    };
  });

  // Top heroes from match history
  const heroMap = {};
  for (const m of matches) {
    if (!m.heroName || m.heroName === 'Unknown') continue;
    if (!heroMap[m.heroName]) {
      heroMap[m.heroName] = { heroName: m.heroName, heroIcon: m.heroIcon, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    }
    const h = heroMap[m.heroName];
    h.games++;
    if (m.win) h.wins++;
    h.kills   += m.kills;
    h.deaths  += m.deaths;
    h.assists += m.assists;
  }
  const topHeroes = Object.values(heroMap)
    .sort((a, b) => b.games - a.games)
    .slice(0, 8)
    .map(h => ({
      ...h,
      winPct: h.games > 0 ? ((h.wins / h.games) * 100).toFixed(1) : '0.0',
      kd:     h.deaths > 0 ? (h.kills / h.deaths).toFixed(2) : h.kills.toFixed(2),
      kda:    h.deaths > 0 ? ((h.kills + h.assists / 3) / h.deaths).toFixed(2) : (h.kills + h.assists / 3).toFixed(2),
    }));

  return {
    username,
    uid,
    name:      p.name || username,
    level:     p.level || '?',
    avatarUrl,
    isPrivate: false,
    rank:      { name: rankName, score: rankScore, icon: rankIcon, color: rankColor, peak: null },
    seasons,
    stats:     { totalMatches, totalWins, winPct, kd, kda, playtime, dmgPerMin, healPerMin },
    matches,
    topHeroes,
  };
}

// ── Trigger a data refresh (v1 update endpoint) ────────────────────────────────
async function refreshRivalsPlayer(username) {
  const apiKey = getRivalsKey();
  if (!apiKey) return { ok: false, error: 'No API key' };
  try {
    const url = `${RIVALS_BASE_V1}/player/${encodeURIComponent(username)}/update`;
    const res = await fetch(url, { headers: rivalsHeaders() });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  fetchRivalsPlayer,
  refreshRivalsPlayer,
  clearRivalsCache,
  getCacheStatus,
  RIVALS_IMG,
};
