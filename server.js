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

// Articulação CBMMG (COB/BBM por município) — planilha pública do Corpo de Bombeiros,
// publicada como CSV. É uma tabela administrativa, atualizada raramente, então o cache
// pode ser bem mais longo que o do FIRMS/INPE.
const ARTIC_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRQFTo0KYBucY7PDb0lT5qys-_t9KrC6ey3dflIuJMtLlKoQcXRQhWLwykmVd6U14A5JN35KdWOpB97/pub?output=csv&gid=995676603';
const ARTIC_TTL_MS = 6 * 60 * 60 * 1000;
let articCache = { at: 0, body: null, count: 0 };

// Unidades de Conservação (UC) estaduais de MG + zonas de amortecimento — GeoServer
// público da SEMAD/IDE-Sisema. Geometria muda raramente, então cache bem mais longo
// que FIRMS/INPE, e simplificamos os polígonos (Douglas-Peucker) antes de responder
// pra não mandar megabytes de vértices que não fazem diferença no zoom do estado.
const GEOSERVER_BASE = 'https://geoserver.meioambiente.mg.gov.br/ows';
const UC_LAYER = 'ide_2010_mg_unidades_conservacao_estaduais_pol';
const UC_BUFFER_LAYERS = ['ide_2011_mg_amortecimento_uc_raio_3km_pol', 'ide_2011_mg_amortecimento_uc_plano_manejo_pol'];
const SIMPLIFY_TOL = 0.001;
const UC_TTL_MS = 24 * 60 * 60 * 1000;
let ucCache = { at: 0, body: null, count: 0 };
let ucAmortCache = { at: 0, body: null, count: 0 };

// Vento animado (estilo Windy/Ventusky) — grade regular sobre o bbox de MG,
// consultada em UMA chamada batch ao Open-Meteo (latitude/longitude aceitam
// listas separadas por vírgula). 0,5° dá ~23x18 = 414 pontos, testado abaixo
// de 1s de resposta. U/V convertidos a partir de velocidade+direção alimentam
// o leaflet-velocity, que espera o mesmo formato JSON estilo GRIB2 usado pelo
// GFS (header com la1/lo1/la2/lo2/dx/dy/nx/ny + array "data" por componente).
const WIND_STEP = 0.5;
const WIND_TTL_MS = 15 * 60 * 1000;
let windCache = { at: 0, body: null, count: 0 };

function buildWindGrid(step) {
  const [west, south, east, north] = MG_BBOX.split(',').map(Number);
  const ny = Math.floor((north - south) / step) + 1;
  const nx = Math.floor((east - west) / step) + 1;
  const reqLat = [], reqLon = [];
  for (let j = 0; j < ny; j++) {
    const lat = +(north - j * step).toFixed(4);
    for (let i = 0; i < nx; i++) {
      reqLat.push(lat);
      reqLon.push(+(west + i * step).toFixed(4));
    }
  }
  return {
    reqLat, reqLon, nx, ny,
    la1: north, la2: +(north - (ny - 1) * step).toFixed(4),
    lo1: west, lo2: +(west + (nx - 1) * step).toFixed(4)
  };
}

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

app.get('/api/wind', async (req, res) => {
  const fresh = Date.now() - windCache.at < WIND_TTL_MS;
  if (fresh && windCache.body) {
    return res.json({ ...windCache.body, cached: true, age_s: Math.round((Date.now() - windCache.at) / 1000) });
  }

  try {
    const grid = buildWindGrid(WIND_STEP);
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + grid.reqLat.join(',')
      + '&longitude=' + grid.reqLon.join(',')
      + '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!r.ok) throw new Error(`Open-Meteo respondeu HTTP ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length !== grid.reqLat.length) {
      throw new Error('Resposta inesperada do Open-Meteo (grade de vento).');
    }

    // direction = de onde o vento vem (convenção meteorológica); U/V descrevem
    // para onde ele sopra, por isso o sinal negativo em ambas as componentes.
    const u = new Array(arr.length), v = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i] && arr[i].current;
      const speed = c ? c.wind_speed_10m || 0 : 0;
      const rad = (c ? c.wind_direction_10m || 0 : 0) * Math.PI / 180;
      u[i] = +(-speed * Math.sin(rad)).toFixed(2);
      v[i] = +(-speed * Math.cos(rad)).toFixed(2);
    }

    const headerBase = {
      parameterUnit: 'm.s-1', numberPoints: grid.nx * grid.ny,
      lo1: grid.lo1, la1: grid.la1, lo2: grid.lo2, la2: grid.la2,
      dx: WIND_STEP, dy: WIND_STEP, nx: grid.nx, ny: grid.ny,
      refTime: new Date().toISOString(), forecastTime: 0, scanMode: 0
    };
    const gridData = [
      { header: { ...headerBase, parameterCategory: 2, parameterNumber: 2, parameterNumberName: 'U-component_of_wind' }, data: u },
      { header: { ...headerBase, parameterCategory: 2, parameterNumber: 3, parameterNumberName: 'V-component_of_wind' }, data: v }
    ];

    windCache = { at: Date.now(), body: { grid: gridData, updated: new Date().toISOString() }, count: u.length };
    res.json({ ...windCache.body, cached: false, age_s: 0 });
  } catch (e) {
    if (windCache.body) {
      return res.json({
        ...windCache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - windCache.at) / 1000),
        warning: e.message
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/articulacao', async (req, res) => {
  const fresh = Date.now() - articCache.at < ARTIC_TTL_MS;
  if (fresh && articCache.body) {
    return res.json({ ...articCache.body, cached: true, age_s: Math.round((Date.now() - articCache.at) / 1000) });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(ARTIC_URL, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!r.ok) throw new Error(`Planilha respondeu HTTP ${r.status}`);
    const txt = await r.text();

    const municipios = parseArticulacaoCsv(txt);
    if (!municipios.length) throw new Error('Planilha sem linhas válidas.');

    articCache = { at: Date.now(), body: { municipios, updated: new Date().toISOString() }, count: municipios.length };
    res.json({ ...articCache.body, cached: false, age_s: 0 });
  } catch (e) {
    if (articCache.body) {
      return res.json({
        ...articCache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - articCache.at) / 1000),
        warning: e.message
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/uc', async (req, res) => {
  const fresh = Date.now() - ucCache.at < UC_TTL_MS;
  if (fresh && ucCache.body) {
    return res.json({ ...ucCache.body, cached: true, age_s: Math.round((Date.now() - ucCache.at) / 1000) });
  }

  try {
    const fc = await fetchWfsLayer(UC_LAYER);
    const features = fc.features
      .filter(f => f.geometry && f.properties.nome_uc)
      .map(f => ({
        nome: f.properties.nome_uc,
        categoria: f.properties.categoria || '',
        grupo: f.properties.grupo || '',
        geometry: simplifyGeometry(f.geometry, SIMPLIFY_TOL)
      }));
    if (!features.length) throw new Error('GeoServer sem feições de UC.');

    ucCache = { at: Date.now(), body: { features, updated: new Date().toISOString() }, count: features.length };
    res.json({ ...ucCache.body, cached: false, age_s: 0 });
  } catch (e) {
    if (ucCache.body) {
      return res.json({
        ...ucCache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - ucCache.at) / 1000),
        warning: e.message
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/uc-amortecimento', async (req, res) => {
  const fresh = Date.now() - ucAmortCache.at < UC_TTL_MS;
  if (fresh && ucAmortCache.body) {
    return res.json({ ...ucAmortCache.body, cached: true, age_s: Math.round((Date.now() - ucAmortCache.at) / 1000) });
  }

  try {
    const fcs = await Promise.all(UC_BUFFER_LAYERS.map(fetchWfsLayer));
    const features = [];
    fcs.forEach(fc => {
      fc.features.forEach(f => {
        if (!f.geometry) return;
        if (f.properties.esfera !== 'Estadual') return;
        // ide_2011_..._raio_3km_pol usa "nome_uc"; ide_2011_..._plano_manejo_pol usa "un_conserv".
        const nome = f.properties.nome_uc || f.properties.un_conserv;
        if (!nome) return;
        features.push({
          nome,
          categoria: f.properties.categoria || '',
          geometry: simplifyGeometry(f.geometry, SIMPLIFY_TOL)
        });
      });
    });
    if (!features.length) throw new Error('GeoServer sem feições de amortecimento estadual.');

    ucAmortCache = { at: Date.now(), body: { features, updated: new Date().toISOString() }, count: features.length };
    res.json({ ...ucAmortCache.body, cached: false, age_s: 0 });
  } catch (e) {
    if (ucAmortCache.body) {
      return res.json({
        ...ucAmortCache.body,
        cached: true,
        stale: true,
        age_s: Math.round((Date.now() - ucAmortCache.at) / 1000),
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
    cache_inpe_age_s: inpeCache.at ? Math.round((Date.now() - inpeCache.at) / 1000) : null,
    cache_artic_municipios: articCache.count,
    cache_artic_age_s: articCache.at ? Math.round((Date.now() - articCache.at) / 1000) : null,
    cache_uc_count: ucCache.count,
    cache_uc_age_s: ucCache.at ? Math.round((Date.now() - ucCache.at) / 1000) : null,
    cache_uc_amort_count: ucAmortCache.count,
    cache_uc_amort_age_s: ucAmortCache.at ? Math.round((Date.now() - ucAmortCache.at) / 1000) : null,
    cache_wind_points: windCache.count,
    cache_wind_age_s: windCache.at ? Math.round((Date.now() - windCache.at) / 1000) : null
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

// Parser de linha CSV com suporte a campos entre aspas (a planilha de articulação usa
// vírgula decimal em latitude/longitude, ex: "-18,48330" — split(',') ingênuo quebraria
// esse campo em dois).
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, c => c.toUpperCase());
}

function parseArticulacaoCsv(txt) {
  const lines = txt.trim().split('\n');
  const head = parseCsvLine(lines[0]).map(s => s.trim());
  const iIbge = head.indexOf('Código [7]');
  const iNome = head.indexOf('MUNICÍPIOS INPE');
  const iCob = head.indexOf('COB');
  const iBbm = head.indexOf('BBM');
  const iTipo = head.indexOf('TIPO');
  const iUnidade = head.indexOf('Nome da unidade');
  const iLat = head.indexOf('latitude');
  const iLng = head.indexOf('longitude');
  if (iNome < 0 || iCob < 0 || iBbm < 0 || iLat < 0 || iLng < 0) {
    throw new Error('CSV de articulação sem colunas esperadas.');
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    const lat = parseFloat((c[iLat] || '').replace(',', '.'));
    const lng = parseFloat((c[iLng] || '').replace(',', '.'));
    if (!isFinite(lat) || !isFinite(lng)) continue;
    out.push({
      ibge: iIbge >= 0 ? c[iIbge] : '',
      municipio: titleCase(c[iNome] || ''),
      cob: c[iCob] || '',
      bbm: c[iBbm] || '',
      tipo: iTipo >= 0 ? c[iTipo] : '',
      unidade: iUnidade >= 0 ? c[iUnidade] : '',
      lat, lng
    });
  }
  return out;
}

async function fetchWfsLayer(typeName) {
  const url = `${GEOSERVER_BASE}?service=wfs&version=2.0.0&request=GetFeature`
    + `&typeName=IDE:${typeName}&outputFormat=application/json&srsName=EPSG:4326`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`GeoServer respondeu HTTP ${r.status} (${typeName})`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Douglas-Peucker: reduz o número de vértices de um anel de coordenadas mantendo o
// contorno visualmente fiel na tolerância dada (em graus). As UCs vêm do GeoServer com
// resolução de agrimensura, muito além do que faz diferença no zoom estadual do mapa.
function simplifyRing(points, tol) {
  if (points.length < 3) return points;
  let maxDist = 0, idx = 0;
  const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const norm = dx * dx + dy * dy;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    let dist;
    if (norm === 0) {
      dist = Math.hypot(x - x1, y - y1);
    } else {
      const t = ((x - x1) * dx + (y - y1) * dy) / norm;
      const px = x1 + t * dx, py = y1 + t * dy;
      dist = Math.hypot(x - px, y - py);
    }
    if (dist > maxDist) { maxDist = dist; idx = i; }
  }
  if (maxDist > tol) {
    const left = simplifyRing(points.slice(0, idx + 1), tol);
    const right = simplifyRing(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function simplifyGeometry(geom, tol) {
  if (geom.type === 'Polygon') {
    return { type: geom.type, coordinates: geom.coordinates.map(ring => simplifyRing(ring, tol)) };
  }
  if (geom.type === 'MultiPolygon') {
    return { type: geom.type, coordinates: geom.coordinates.map(poly => poly.map(ring => simplifyRing(ring, tol))) };
  }
  return geom;
}

app.listen(PORT, () => {
  console.log(`Vigília Fogo · MG rodando na porta ${PORT}`);
  console.log(`FIRMS MAP_KEY: ${MAP_KEY ? 'configurada ✓' : 'AUSENTE — /api/firms vai retornar 503'}`);
});
