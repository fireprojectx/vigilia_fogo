/**
 * Vigília Fogo · MG — servidor
 *
 * Serve o app estático e expõe /api/firms como proxy do NASA FIRMS.
 * A MAP_KEY nunca chega ao navegador: fica em process.env.FIRMS_MAP_KEY.
 *
 * Resolve dois problemas de uma vez:
 *   1. CORS  — o FIRMS não libera requisição direta do navegador; aqui a chamada é server-side.
 *   2. Segredo — a chave não vai para o bundle público.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAP_KEY = process.env.FIRMS_MAP_KEY;

// Bounding box de Minas Gerais (oeste,sul,leste,norte)
const MG_BBOX = '-51.1,-22.95,-39.85,-14.2';
const SENSOR = process.env.FIRMS_SENSOR || 'VIIRS_SNPP_NRT';
// day_range=2 traz ~48h num único request — o front-end filtra 24h/48h no
// navegador. Isso NÃO aumenta o número de transações contra a MAP_KEY: o
// cache abaixo já garante no máximo 1 chamada ao FIRMS a cada 10 min,
// independente de quantos clientes acessem /api/firms nesse intervalo.
const DAY_RANGE = 2;

// Cache em memória. O FIRMS limita a 5.000 transações / 10 min e os satélites
// passam ~2x por dia, então recarregar a cada request é desperdício puro.
const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, body: null, count: 0 };

// INPE (Programa Queimadas) — CSV diário público, sem chave, multi-satélite.
// Cobre um estado ("MINAS GERAIS") e junta os últimos 3 arquivos (UTC) para
// garantir 48h completas mesmo perto da virada do dia.
const INPE_BASE = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil';
const INPE_ESTADO = 'MINAS GERAIS';
let inpeCache = { at: 0, body: null, count: 0 };

function inpeUrl(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${INPE_BASE}/focos_diario_br_${y}${m}${d}.csv`;
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/firms', async (req, res) => {
  if (!MAP_KEY) {
    return res.status(503).json({
      error: 'FIRMS_MAP_KEY não configurada no servidor.',
      hint: 'Defina a variável de ambiente FIRMS_MAP_KEY e reinicie.'
    });
  }

  const fresh = Date.now() - cache.at < TTL_MS;
  if (fresh && cache.body) {
    return res.json({ ...cache.body, cached: true, age_s: Math.round((Date.now() - cache.at) / 1000) });
  }

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${SENSOR}/${MG_BBOX}/${DAY_RANGE}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!r.ok) throw new Error(`FIRMS respondeu HTTP ${r.status}`);
    const txt = await r.text();

    // O FIRMS devolve 200 com texto de erro quando a chave é inválida.
    if (!/^\s*country_id|latitude/i.test(txt.split('\n')[0] || '')) {
      throw new Error('Resposta inesperada do FIRMS (chave inválida ou cota esgotada).');
    }

    const focos = parseCsv(txt);
    cache = { at: Date.now(), body: { focos, sensor: SENSOR, updated: new Date().toISOString() }, count: focos.length };
    res.json({ ...cache.body, cached: false, age_s: 0 });
  } catch (e) {
    // Se a chamada falhar mas houver cache velho, é melhor entregar dado antigo
    // rotulado do que deixar o painel cego.
    if (cache.body) {
      return res.json({
        ...cache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - cache.at) / 1000),
        warning: e.message
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/inpe', async (req, res) => {
  const fresh = Date.now() - inpeCache.at < TTL_MS;
  if (fresh && inpeCache.body) {
    return res.json({ ...inpeCache.body, cached: true, age_s: Math.round((Date.now() - inpeCache.at) / 1000) });
  }

  const now = Date.now();
  const days = [0, 1, 2].map(k => inpeUrl(new Date(now - k * 86400000)));

  try {
    const texts = await Promise.all(days.map(async url => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        return r.ok ? await r.text() : null;
      } catch {
        return null;
      }
    }));

    if (texts.every(t => !t)) throw new Error('Nenhum arquivo diário do INPE respondeu.');

    const seen = new Set();
    const focos = [];
    for (const txt of texts) {
      if (!txt) continue;
      for (const foco of parseInpeCsv(txt)) {
        if (seen.has(foco.id)) continue;
        seen.add(foco.id);
        focos.push(foco);
      }
    }
    focos.sort((a, b) => b.when.localeCompare(a.when));

    inpeCache = { at: Date.now(), body: { focos, updated: new Date().toISOString() }, count: focos.length };
    res.json({ ...inpeCache.body, cached: false, age_s: 0 });
  } catch (e) {
    if (inpeCache.body) {
      return res.json({
        ...inpeCache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - inpeCache.at) / 1000),
        warning: e.message
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    firms_key: MAP_KEY ? 'configurada' : 'ausente',
    cache_focos: cache.count,
    cache_age_s: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null,
    cache_inpe_focos: inpeCache.count,
    cache_inpe_age_s: inpeCache.at ? Math.round((Date.now() - inpeCache.at) / 1000) : null
  });
});

function parseCsv(txt) {
  const lines = txt.trim().split('\n');
  const head = lines[0].split(',').map(s => s.trim());
  const iLat = head.indexOf('latitude');
  const iLng = head.indexOf('longitude');
  const iConf = head.indexOf('confidence');
  const iFrp = head.indexOf('frp');
  const iDate = head.indexOf('acq_date');
  const iTime = head.indexOf('acq_time');
  if (iLat < 0 || iLng < 0) throw new Error('CSV do FIRMS sem colunas de coordenada.');

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const lat = parseFloat(c[iLat]);
    const lng = parseFloat(c[iLng]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const time = (iTime >= 0 ? c[iTime] || '' : '').padStart(4, '0');
    out.push({
      lat, lng,
      conf: iConf >= 0 ? c[iConf] : '',
      frp: iFrp >= 0 ? parseFloat(c[iFrp]) || 0 : 0,
      when: iDate >= 0 ? `${c[iDate]}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z` : ''
    });
  }
  return out;
}

function parseInpeCsv(txt) {
  const lines = txt.trim().split('\n');
  const head = lines[0].split(',').map(s => s.trim());
  const iId = head.indexOf('id');
  const iLat = head.indexOf('lat');
  const iLng = head.indexOf('lon');
  const iWhen = head.indexOf('data_hora_gmt');
  const iSat = head.indexOf('satelite');
  const iEstado = head.indexOf('estado');
  const iBioma = head.indexOf('bioma');
  const iFrp = head.indexOf('frp');
  if (iLat < 0 || iLng < 0 || iEstado < 0) throw new Error('CSV do INPE sem colunas esperadas.');

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(s => s.trim());
    if (c[iEstado] !== INPE_ESTADO) continue;
    const lat = parseFloat(c[iLat]);
    const lng = parseFloat(c[iLng]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    out.push({
      id: c[iId] || `${c[iWhen]}_${lat}_${lng}`,
      lat, lng,
      sat: c[iSat] || '',
      bioma: iBioma >= 0 ? c[iBioma] : '',
      frp: iFrp >= 0 ? parseFloat(c[iFrp]) || 0 : 0,
      when: `${(c[iWhen] || '').replace(' ', 'T')}Z`
    });
  }
  return out;
}

app.listen(PORT, () => {
  console.log(`Vigília Fogo · MG rodando na porta ${PORT}`);
  console.log(`FIRMS MAP_KEY: ${MAP_KEY ? 'configurada ✓' : 'AUSENTE — /api/firms vai retornar 503'}`);
});
