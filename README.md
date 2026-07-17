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
| `GET /api/inpe` | `{ focos: [{id, lat, lng, sat, bioma, frp, when}], updated, cached, age_s }` |
| `GET /api/articulacao` | `{ municipios: [{ibge, municipio, cob, bbm, tipo, unidade, lat, lng}], updated, cached, age_s }` |
| `GET /api/uc` | `{ features: [{nome, categoria, grupo, geometry}], updated, cached, age_s }` |
| `GET /api/uc-amortecimento` | `{ features: [{nome, categoria, geometry}], updated, cached, age_s }` |
| `GET /api/health` | status da chave e do cache |

O `/api/firms` tem cache de 10 min em memória — os satélites passam ~2× por dia,
recarregar a cada request só desperdiça cota. Se o FIRMS cair e houver cache antigo,
ele é servido com `stale: true` em vez de deixar o painel cego.

O request ao FIRMS usa `day_range=2` (até 48h numa única chamada) para que o painel
possa alternar entre janela de 24h e 48h sem novo request — o `day_range` maior não
aumenta o número de transações contra a MAP_KEY, porque o cache já garante no máximo
1 chamada ao FIRMS a cada 10 min, não importa quantos clientes acessem `/api/firms`
nesse intervalo. O componente de Ignição do IRIV, porém, sempre usa um corte fixo de
24h — trocar a janela de exibição no painel é só visual e não muda o índice.

O `/api/inpe` é um segundo proxy, independente do FIRMS: lê os arquivos CSV diários
e públicos do Programa Queimadas (INPE), que não exigem chave. Junta os últimos 3
dias (UTC) e filtra por `estado == "MINAS GERAIS"`, devolvendo os focos com timestamp
em UTC — o front-end aplica a janela de 24h/48h no navegador, sem precisar recarregar
o proxy a cada troca. Mesmo cache de 10 min e mesmo fallback `stale` do FIRMS.

Os dois conjuntos de focos (FIRMS e INPE) são exibidos como camadas separadas no mapa,
lado a lado — o INPE é só uma camada visual de comparação; o cálculo do índice IRIV
continua usando exclusivamente o FIRMS para o componente de Ignição.

O `/api/articulacao` é um terceiro proxy: lê a planilha pública do Corpo de Bombeiros MG
com a articulação vigente (COB e BBM responsáveis por cada um dos 853 municípios do
estado) e devolve os dados já convertidos em JSON, com cache de 6 h (é uma tabela
administrativa, atualizada raramente — não precisa do TTL curto do FIRMS/INPE). Os 34
municípios de referência são casados por nome com essa planilha e ganham colunas de
COB/BBM/unidade responsável no painel; os demais ~819 municípios entram no mapa só como
pontos filtráveis por COB/BBM, sem clima nem IRIV — ver "Limites conhecidos".

O `/api/uc` e o `/api/uc-amortecimento` proxeiam o GeoServer público da SEMAD/IDE-Sisema
(`geoserver.meioambiente.mg.gov.br`), que publica as Unidades de Conservação (UC)
estaduais de MG e as zonas de amortecimento oficiais (raio legal de 3 km para UCs sem
plano de manejo aprovado, mais o buffer customizado das que têm plano — CONAMA 13/1990).
As geometrias vêm em SIRGAS2000 e são reprojetadas para EPSG:4326 na própria requisição
WFS; o servidor ainda simplifica cada polígono (Douglas-Peucker, tolerância 0,001° ≈
110 m) antes de responder, o que reduz o payload de ~2,8 MB para ~290 KB no contorno das
95 UCs, e de ~4,9 MB para ~320 KB nas 77 zonas de amortecimento estaduais. Cache de 24h —
é geometria administrativa, muda raramente.

No front-end, cada foco (FIRMS ou INPE) é testado por point-in-polygon contra os
polígonos de UC e, se não estiver dentro de nenhuma, contra os de amortecimento. O
resultado fica anexado ao próprio objeto do foco (`foco.ucAlert`) assim que os dados
carregam, em vez de recalculado a cada redesenho do mapa — o `draw()` roda a cada tick do
slider de vento, e repetir ~170 testes de polígono por foco nesse ritmo seria
desperdício. Focos dentro de uma UC ou na sua zona de amortecimento ganham uma plaquinha
de alerta (triângulo com "!") no mapa.

## Limites conhecidos

- Clima e vento vêm de modelo global (ECMWF/GFS), não de estação de superfície.
  Para uso operacional, calibrar contra o INMET.
- Declividade e combustibilidade por fitofisionomia são parâmetros fixos por bioma,
  não medidos por pixel. O caminho natural é substituir por um raster de declividade
  (SRTM/Copernicus) e uso do solo (MapBiomas).
- 34 municípios de referência têm clima (Open-Meteo) e IRIV calculado. Os filtros de COB
  e BBM cobrem os 853 municípios de MG (via planilha do CBMMG), mas os demais ~819
  aparecem no mapa sem risco — expandir o Open-Meteo para todos eles não é viável numa
  única chamada (URL longa demais, HTTP 414 acima de ~300 coordenadas) e exigiria vários
  megabytes de JSON por carregamento. Também falta uma fonte confiável de bioma
  predominante por município para esses 819 — sem isso o componente de espalhamento do
  IRIV ficaria impreciso.

## Fontes

- Open-Meteo — https://open-meteo.com (ECMWF/GFS, sem chave)
- NASA FIRMS — https://firms.modaps.eosdis.nasa.gov
- INPE (Programa Queimadas) — https://data.inpe.br/queimadas/dados-abertos (CSV diário, sem chave)
- Corpo de Bombeiros MG — planilha pública de articulação (COB/BBM por município)
- SEMAD/IDE-Sisema — geoserver.meioambiente.mg.gov.br (UCs estaduais + zonas de amortecimento)
- Contorno municipal — IBGE
- Método — CSR/UFMG (FIP-Cerrado); FMA: Soares, R.V. (1972)
