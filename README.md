# Vigília Fogo · MG

Monitoramento de risco de incêndio em vegetação para Minas Gerais, aplicando o método
de propagação do CSR/UFMG às cinco fitofisionomias do estado (Cerrado, Caatinga,
Campo Rupestre, Mata Atlântica e transição).

## Índice IRIV

| Componente | Peso | Fonte |
|---|---|---|
| Risco climático — Fórmula de Monte Alegre (Soares, 1972) | 0,30 | Open-Meteo (UR 13 h + chuva diária, 30 d) |
| Ignição — focos de calor em raio de 35 km | 0,25 | NASA FIRMS (VIIRS S-NPP NRT) |
| Espalhamento — combustibilidade × secura × vento × declividade | 0,45 | Open-Meteo + parâmetros por fitofisionomia |

Sem os focos disponíveis, os pesos são renormalizados para **0,40 clima / 0,60 espalhamento**
e o painel sinaliza a ausência — o índice nunca é publicado como se estivesse completo.

## Por que existe um servidor

O front-end sozinho não dá conta de dois problemas:

1. **CORS** — o FIRMS não libera requisição direta do navegador. A chamada precisa ser server-side.
2. **Segredo** — chave em JavaScript client-side é chave pública. Qualquer visitante lê o
   bundle e queima a cota (5.000 transações / 10 min).

O `/api/firms` resolve os dois: lê a `FIRMS_MAP_KEY` de variável de ambiente e devolve
apenas os focos já parseados.

## Rodar local

```bash
npm install
cp .env.example .env      # cole sua MAP_KEY no .env
export $(cat .env | xargs)
npm start                 # http://localhost:3000
```

Chave gratuita: https://firms.modaps.eosdis.nasa.gov/api/map_key/

## Deploy no Railway

```bash
git init && git add . && git commit -m "Vigília Fogo MG"
railway init
railway variables set FIRMS_MAP_KEY=sua_chave_aqui
railway up
```

Ou pelo painel: **Variables → New Variable → `FIRMS_MAP_KEY`**. O Railway injeta `PORT`
automaticamente, o `server.js` já respeita.

> O `.gitignore` já exclui o `.env`. Confira que ele não foi commitado antes de dar push:
> `git ls-files | grep .env` deve retornar apenas `.env.example`.

## Endpoints

| Rota | Retorno |
|---|---|
| `GET /` | app |
| `GET /api/firms` | `{ focos: [{lat, lng, conf, frp, when}], sensor, updated, cached, age_s }` |
| `GET /api/health` | status da chave e do cache |

O `/api/firms` tem cache de 10 min em memória — os satélites passam ~2× por dia,
recarregar a cada request só desperdiça cota. Se o FIRMS cair e houver cache antigo,
ele é servido com `stale: true` em vez de deixar o painel cego.

## Limites conhecidos

- Clima e vento vêm de modelo global (ECMWF/GFS), não de estação de superfície.
  Para uso operacional, calibrar contra o INMET.
- Declividade e combustibilidade por fitofisionomia são parâmetros fixos por bioma,
  não medidos por pixel. O caminho natural é substituir por um raster de declividade
  (SRTM/Copernicus) e uso do solo (MapBiomas).
- 34 municípios de referência. Os 853 centroides saem do GeoJSON do IBGE
  (`geojs-31-mun.json`) se quiser cobertura total.

## Fontes

- Open-Meteo — https://open-meteo.com (ECMWF/GFS, sem chave)
- NASA FIRMS — https://firms.modaps.eosdis.nasa.gov
- Contorno municipal — IBGE
- Método — CSR/UFMG (FIP-Cerrado); FMA: Soares, R.V. (1972)
