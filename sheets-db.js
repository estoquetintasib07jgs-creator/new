/**
 * sheets-db.js  -  Camada de dados do Controle de Estoque usando Google Sheets
 * Inclua no index.html ANTES do seu script principal:
 *   <script src="sheets-db.js"></script>
 *
 * Recursos:
 *  - listar / adicionar / limpar (por unidade)
 *  - fila offline: se estiver sem rede, guarda no aparelho e envia depois
 *  - sincronizacao automatica periodica
 *  - estoque() agrega entradas/saidas por item + lote + validade
 */
const SheetsDB = (() => {
  // ====== CONFIGURE AQUI ======
  const URL_WEBAPP = 'https://script.google.com/macros/s/AKfycbzU0-IUZpduPdO1ounu1np3iDC8d8k7v0cryFRUwX5bVNi2Zj7Wh21XJrXU4oxZE9C17A/exec';   // termina em /exec
  const TOKEN = 'W1e2g3wij';       // igual ao Code.gs
  const INTERVALO_SYNC_MS = 15000;
  // ============================

  const FILA_KEY = 'estoque_fila_pendente_v1';
  const CACHE_KEY = 'estoque_cache_v1';
  const DEV_KEY = 'estoque_dispositivo_v1';

  let ouvintes = [];
  let timer = null;
  let enviando = false;

  function dispositivo() {
    let d = localStorage.getItem(DEV_KEY);
    if (!d) {
      d = 'DEV-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      localStorage.setItem(DEV_KEY, d);
    }
    return d;
  }

  function novoId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function lerFila() {
    try { return JSON.parse(localStorage.getItem(FILA_KEY) || '[]'); } catch { return []; }
  }
  function gravarFila(f) { localStorage.setItem(FILA_KEY, JSON.stringify(f)); }

  function lerCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
  }
  function gravarCache(unidade, rows) {
    const c = lerCache(); c[unidade] = rows;
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  }

  async function get(params) {
    const qs = new URLSearchParams({ ...params, token: TOKEN }).toString();
    const r = await fetch(URL_WEBAPP + '?' + qs, { method: 'GET' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || 'erro');
    return j;
  }

  async function post(payload) {
    // text/plain evita o preflight CORS do Apps Script
    const r = await fetch(URL_WEBAPP, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: TOKEN })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || 'erro');
    return j;
  }

  function avisar(evento, dados) {
    ouvintes.forEach(fn => { try { fn(evento, dados); } catch (_) {} });
  }

  /** Envia pendencias da fila offline. */
  async function enviarFila() {
    if (enviando) return;
    const fila = lerFila();
    if (!fila.length) return;
    enviando = true;
    try {
      await post({ action: 'add', rows: fila });
      gravarFila([]);
      avisar('fila-enviada', { qtd: fila.length });
    } catch (e) {
      avisar('offline', { erro: String(e) });
    } finally {
      enviando = false;
    }
  }

  /** Lista movimentacoes de uma unidade (ja inclui as pendentes locais). */
  async function listar(unidade) {
    await enviarFila();
    let rows;
    try {
      const j = await get({ action: 'list', unidade });
      rows = j.rows;
      gravarCache(unidade, rows);
      avisar('online', {});
    } catch (e) {
      rows = lerCache()[unidade] || [];
      avisar('offline', { erro: String(e) });
    }
    const ids = new Set(rows.map(r => r.id));
    const pend = lerFila().filter(m => m.unidade === unidade && !ids.has(m.id));
    return rows.concat(pend);
  }

  /**
   * Registra uma movimentacao.
   * mov = { unidade, tipo: 'ENTRADA'|'SAIDA', item, lote, validade, qtd }
   */
  async function adicionar(mov) {
    const m = {
      id: novoId(),
      unidade: String(mov.unidade),
      data_hora: new Date().toISOString(),
      tipo: String(mov.tipo),
      item: String(mov.item),
      lote: String(mov.lote),
      validade: String(mov.validade),
      qtd: Number(mov.qtd) || 1,
      dispositivo: dispositivo()
    };
    const fila = lerFila(); fila.push(m); gravarFila(fila);
    enviarFila(); // nao bloqueia a tela
    return m;
  }

  /** Apaga SOMENTE a unidade informada. */
  async function limpar(unidade) {
    await post({ action: 'clear', unidade: String(unidade) });
    const c = lerCache(); delete c[unidade];
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    gravarFila(lerFila().filter(m => m.unidade !== unidade));
    avisar('limpo', { unidade });
  }

  /** Migracao: envia movimentos antigos (array) de uma vez. */
  async function importar(lista, unidade) {
    const rows = lista.map(m => ({
      id: m.id ? String(m.id) : novoId(),
      unidade: String(m.unidade || unidade),
      data_hora: m.data_hora || m.data || new Date().toISOString(),
      tipo: m.tipo, item: m.item, lote: m.lote, validade: m.validade,
      qtd: m.qtd, dispositivo: 'IMPORTADO'
    }));
    const TAM = 200;
    for (let i = 0; i < rows.length; i += TAM) {
      await post({ action: 'add', rows: rows.slice(i, i + TAM) });
    }
    return rows.length;
  }

  /** Agrega estoque por item + lote + validade (ENTRADA soma, SAIDA subtrai). */
  function estoque(movs) {
    const mapa = new Map();
    movs.forEach(m => {
      const k = [m.item, m.lote, m.validade].join('|');
      const sinal = String(m.tipo).toUpperCase().startsWith('S') ? -1 : 1;
      if (!mapa.has(k)) mapa.set(k, { item: m.item, lote: m.lote, validade: m.validade, total: 0 });
      mapa.get(k).total += sinal * (Number(m.qtd) || 0);
    });
    return [...mapa.values()].filter(x => x.total !== 0);
  }

  /** Sincronizacao automatica: chama callback(movs) a cada intervalo. */
  function iniciarSync(unidade, callback) {
    pararSync();
    const rodar = async () => callback(await listar(unidade));
    rodar();
    timer = setInterval(rodar, INTERVALO_SYNC_MS);
    window.addEventListener('online', rodar);
  }
  function pararSync() { if (timer) clearInterval(timer); timer = null; }

  function aoMudar(fn) { ouvintes.push(fn); }

  return { listar, adicionar, limpar, importar, estoque, iniciarSync, pararSync, aoMudar, pendentes: () => lerFila().length };
})();
