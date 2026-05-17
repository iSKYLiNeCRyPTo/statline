const fetch = require('node-fetch');

const RIVALS_BASE = 'https://marvelrivalsapi.com/api/v2';
const RIVALS_IMG  = 'https://marvelrivalsapi.com/rivals';

function getRivalsKey() {
  return process.env.RIVALS_API_KEY || '';
}

function rivalsHeaders() {
  return { 'x-api-key': getRivalsKey(), 'Accept': 'application/json' };
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
  // Evict oldest entries if cache grows large
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

function rankTier(rankStr) {
  if (!rankStr) return 0;
  return RANK_ORDER.indexOf(rankStr);
}

// Season ID → human label (1001001 = Season 1, etc.)
function seasonLabel(id) {
  const n = String(id);
  // format: 100100X where X is season number, or 100100X for sub-seasons
  const match = n.match(/^1001(\d+)$/);
  if (!match) return id;
  const num = parseInt(match[1], 10);
  // 1 → S1, 2 → S1.5, 3 → S2, 4 → S2.5 etc.
  const season = Math.ceil(num / 2);
  const half   = num % 2 === 0 ? '.5' : '';
  return `S${season}${half}`;
}

// ── Player fetch ───────────────────────────────────────────────────────────────
async function fetchRivalsPlayer(username) {
  if (!username) throw new Error('Username required');
  const key = username.toLowerCase();
  const cached = getCached(key);
  if (cached) return { ...cached, _cached: true };

  const apiKey = getRivalsKey();
  if (!apiKey) throw new Error('RIVALS_API_KEY not configured');

  // 1) Player stats v2
  const statsUrl = `${RIVALS_BASE}/player/${encodeURIComponent(username)}`;
  const statsRes = await fetch(statsUrl, { headers: rivalsHeaders() });
  if (statsRes.status === 404) throw new Error('Player not found');
  if (statsRes.status === 401) throw new Error('Invalid API key');
  if (!statsRes.ok) throw new Error(`Rivals API error: ${statsRes.status}`);
  const statsData = await statsRes.json();

  if (statsData.isPrivate) {
    const partial = { username, uid: statsData.uid || null, isPrivate: true };
    setCache(key, partial);
    return partial;
  }

  // 2) Match history v2 (last 40 matches, all modes)
  const uid = statsData.uid || statsData.player?.uid;
  let matches = [];
  try {
    const histUrl = `${RIVALS_BASE}/player/${encodeURIComponent(username)}/match-history?limit=40&page=1`;
    const histRes = await fetch(histUrl, { headers: rivalsHeaders() });
    if (histRes.ok) {
      const histData = await histRes.json();
      matches = histData.match_history || [];
    }
  } catch(e) {
    console.warn('[Rivals] match history fetch failed:', e.message);
  }

  const result = processRivalsData(username, statsData, matches);
  setCache(key, result);
  return result;
}

// ── Process API response into clean shape ──────────────────────────────────────
function processRivalsData(username, stats, rawMatches) {
  const p = stats.player || {};
  const overall = stats.overall_stats || {};

  // Avatar
  const iconPath = p.icon?.player_icon || null;
  const avatarUrl = iconPath ? `${RIVALS_IMG}${iconPath}` : null;

  // Current rank
  const rank = p.rank || {};
  const rankName  = rank.rank  || 'Unranked';
  const rankScore = rank.score || '0';
  const rankIcon  = rank.icon  ? `${RIVALS_IMG}${rank.icon}` : null;
  const rankColor = rank.color || '#888';
  const peakRank  = rank.peak_rank ? {
    name:  rank.peak_rank.rank,
    score: rank.peak_rank.score,
    icon:  rank.peak_rank.icon ? `${RIVALS_IMG}${rank.peak_rank.icon}` : null,
    color: rank.peak_rank.color || '#888',
  } : null;

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

  // Overall stats
  const totalMatches = overall.total_matches || 0;
  const totalWins    = overall.total_wins?.wins || 0;
  const winPct       = totalMatches > 0 ? ((totalWins / totalMatches) * 100).toFixed(1) : '0.0';
  const kd           = overall.overall_kd ? overall.overall_kd.toFixed(2) : '0.00';
  const kda          = overall.overall_kda?.kda ? overall.overall_kda.kda.toFixed(2) : '0.00';
  const playtime     = overall.total_play_time?.playtime || '--';
  const dmgPerMin    = overall.per_minute?.total_damage_per_minute || 0;
  const healPerMin   = overall.per_minute?.total_healing_per_minute || 0;

  // Match history
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
      duration:     m.match_play_duration || '--',
      season:       m.match_season || '--',
      mapId:        m.match_map_id,
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
      heroHeal:     Math.round(hero.total_hero_heal || 0),
      damageTaken:  Math.round(hero.total_damage_taken || 0),
      scoreDelta,
      newScore:     mp.score_info?.new_score != null ? Math.round(mp.score_info.new_score) : null,
      isMvp:        m.mvp_uid === mp.player_uid,
      isSvp:        m.svp_uid === mp.player_uid,
      disconnected: mp.disconnected || false,
    };
  });

  // Top heroes by games played from match history
  const heroMap = {};
  for (const m of matches) {
    if (!m.heroName) continue;
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
      kda:    h.deaths > 0 ? ((h.kills + h.assists / 3) / h.deaths).toFixed(2) : ((h.kills + h.assists / 3)).toFixed(2),
    }));

  return {
    username,
    uid,
    name:   p.name || username,
    level:  p.level || '?',
    avatarUrl,
    isPrivate: false,
    rank: { name: rankName, score: rankScore, icon: rankIcon, color: rankColor, peak: peakRank },
    seasons,
    stats: { totalMatches, totalWins, winPct, kd, kda, playtime, dmgPerMin, healPerMin },
    matches,
    topHeroes,
  };
}

// ── Trigger a data refresh (calls Update Player endpoint) ──────────────────────
async function refreshRivalsPlayer(username) {
  const apiKey = getRivalsKey();
  if (!apiKey) return { ok: false, error: 'No API key' };
  try {
    const url = `${RIVALS_BASE}/player/${encodeURIComponent(username)}/update`;
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
