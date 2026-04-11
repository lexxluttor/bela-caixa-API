import express from "express";
import cors from "cors";
import zlib from "zlib";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://bela-caixa-api.onrender.com";
const API_BELA_SHEETS = process.env.API_BELA_SHEETS || "";

const DATA_DIR = path.resolve("./storage");
const NOTAS_DIR = path.join(DATA_DIR, "notas");

// ================= CERTIFICADO =================

const CERT_PATH = "/etc/secrets/certificado.pfx";
const CERT_PASSWORD = process.env.CERT_PASSWORD || "";

let certificado = null;

try {
  certificado = fs.readFileSync(CERT_PATH);
  console.log("✔ certificado carregado");
} catch {
  console.log("⚠ certificado não encontrado");
}

// ================= EMPRESA =================

const EMPRESA = {
  razao_social: "APARECIDA DE JESUS MIRANDA",
  nome_fantasia: "BELA MODAS",
  cnpj: "19225338000170",
  ie: "0022589640048",
  crt: "1",
  regime: "Simples Nacional",
  logradouro: "AVENIDA MEXICO",
  numero: "87",
  bairro: "PETROVALE",
  cidade: "BETIM",
  uf: "MG",
  cep: "32668052",
  fone: "31997337304",
  pais: "BRASIL"
};

let sequencial = 1;

// ================= AUXILIARES =================

function somenteDigitos(v = "") {
  return String(v || "").replace(/\D+/g, "");
}

function dinheiro(v) {
  return Number(v || 0).toFixed(2);
}

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function dataMesRef(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function agoraBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo"
  }).format(new Date());
}

function formatarCNPJ(cnpj) {
  const d = somenteDigitos(cnpj);
  if (d.length !== 14) return cnpj || "";
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function formatarCEP(cep) {
  const d = somenteDigitos(cep);
  if (d.length !== 8) return cep || "";
  return d.replace(/^(\d{5})(\d{3})$/, "$1-$2");
}

function formatarTelefone(fone) {
  const d = somenteDigitos(fone);
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  return fone || "";
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toNumber(v, padrao = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function montarUrlAppsScript(action, params = {}) {
  if (!API_BELA_SHEETS) return "";
  const url = new URL(API_BELA_SHEETS);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });
  return url.toString();
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const text = await resp.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Resposta inválida do Apps Script");
  }

  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `Falha HTTP ${resp.status}`);
  }

  return data;
}

function pad2(v) {
  return String(v).padStart(2, "0");
}

function normalizarMes(ano, mes) {
  const a = Number(ano);
  const m = Number(mes);
  if (!Number.isInteger(a) || !Number.isInteger(m) || m < 1 || m > 12) {
    return "";
  }
  return `${a}-${pad2(m)}`;
}

// ================= APPS SCRIPT / XML =================

async function obterNumeroNfceRemoto() {
  if (!API_BELA_SHEETS) {
    throw new Error("API_BELA_SHEETS não configurada");
  }

  const url = montarUrlAppsScript("getProximoNumeroNfce");
  const data = await fetchJson(url);

  return {
    numero: toNumber(data.numero, 1),
    serie: toNumber(data.serie, 1)
  };
}

async function salvarXmlNfceRemoto(nota, xml) {
  if (!API_BELA_SHEETS) {
    throw new Error("API_BELA_SHEETS não configurada");
  }

  const payload = {
    action: "salvarNfceXml",
    id: nota.id,
    vendaId: nota.vendaId || nota.id,
    numero: nota.numero,
    serie: nota.serie,
    dataEmissao: nota.dataEmissaoIso,
    cliente: nota.cliente?.nome || "",
    cpf: nota.cliente?.cpf || "",
    total: nota.total || 0,
    xml
  };

  return await fetchJson(API_BELA_SHEETS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function listarXmlMesRemoto(mes) {
  if (!API_BELA_SHEETS) {
    throw new Error("API_BELA_SHEETS não configurada");
  }

  const url = montarUrlAppsScript("listarNfceXmlMes", { mes });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

async function listarXmlPeriodoRemoto(inicio, fim) {
  if (!API_BELA_SHEETS) {
    throw new Error("API_BELA_SHEETS não configurada");
  }

  const url = montarUrlAppsScript("listarNfceXmlPeriodo", { inicio, fim });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

// ================= STORAGE =================

async function ensureDirs() {
  await fsp.mkdir(NOTAS_DIR, { recursive: true });
}

function caminhoNota(id) {
  return path.join(NOTAS_DIR, `${id}.json`);
}

async function salvarNota(nota) {
  await ensureDirs();
  await fsp.writeFile(caminhoNota(nota.id), JSON.stringify(nota, null, 2), "utf-8");
}

async function lerNota(id) {
  try {
    const raw = await fsp.readFile(caminhoNota(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listarNotas() {
  await ensureDirs();

  const arquivos = await fsp.readdir(NOTAS_DIR);
  const lista = [];

  for (const arq of arquivos) {
    if (!arq.endsWith(".json")) continue;

    try {
      const raw = await fsp.readFile(path.join(NOTAS_DIR, arq), "utf-8");
      lista.push(JSON.parse(raw));
    } catch {}
  }

  lista.sort((a, b) => new Date(a.dataEmissaoIso || a.data || 0) - new Date(b.dataEmissaoIso || b.data || 0));
  return lista;
}

async function carregarSequencial() {
  const notas = await listarNotas();
  const max = notas.reduce((m, n) => Math.max(m, Number(n.numero || 0)), 0);
  sequencial = max + 1;
}

// ================= NORMALIZAR VENDA =================

function obterProdutoFiscal(item = {}) {
  const qtd = Number(item.qtd ?? item.quantidade ?? item.qty ?? 1);
  const valorUnitario = Number(item.valorUnitario ?? item.preco ?? item.valor ?? 0);
  const valorTotal = Number(item.valorTotal ?? (qtd * valorUnitario));

  return {
    codigo: String(item.cod || item.codigo || item.ref || item.id || ""),
    ean: String(item.ean || item.codigo_barras || item.codBarras || item.codigoDeBarras || ""),
    descricao: String(item.descricao || item.nome || item.desc || "PRODUTO"),
    ncm: String(item.ncm || "00000000"),
    cfop: String(item.cfop || "5102"),
    csosn: String(item.csosn || "102"),
    unidade: String(item.unidade || "UN"),
    origem: String(item.origem || "0"),
    quantidade: qtd,
    valorUnitario,
    valorTotal
  };
}

function normalizarPayload(body = {}) {
  const itens = (Array.isArray(body.itens) ? body.itens : []).map(obterProdutoFiscal);

  const subtotal = itens.reduce(
    (s, i) => s + Number(i.valorTotal || (i.quantidade * i.valorUnitario) || 0),
    0
  );

  const desconto = Number(body.desconto || 0);
  const totalCalculado = subtotal - desconto;

  const total = body.total != null
    ? Number(body.total)
    : totalCalculado;

  const pagamentoValor = body.pagamento?.valor != null
    ? Number(body.pagamento.valor)
    : total;

  return {
    vendaId: String(body.vendaId || body.id || `nfce-${Date.now()}`),
    dataVenda: body.dataVenda || new Date().toISOString(),
    cliente: {
      nome: String((body.cliente && body.cliente.nome) || body.cliente || "CONSUMIDOR NAO IDENTIFICADO"),
      cpf: somenteDigitos((body.cliente && body.cliente.cpf) || body.cpf || "")
    },
    itens,
    subtotal,
    desconto,
    total,
    pagamento: {
      tipo: String((body.pagamento && body.pagamento.tipo) || body.forma_pagamento || "DINHEIRO").toUpperCase(),
      valor: pagamentoValor
    }
  };
}

// ================= XML =================

function gerarXML(nota) {
  const itensXml = (nota.itens || []).map((item, idx) => `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${esc(item.codigo || String(idx + 1))}</cProd>
        <cEAN>${esc(item.ean || "SEM GTIN")}</cEAN>
        <xProd>${esc(item.descricao)}</xProd>
        <NCM>${esc(item.ncm)}</NCM>
        <CFOP>${esc(item.cfop)}</CFOP>
        <uCom>${esc(item.unidade)}</uCom>
        <qCom>${dinheiro(item.quantidade)}</qCom>
        <vUnCom>${dinheiro(item.valorUnitario)}</vUnCom>
        <vProd>${dinheiro(item.valorTotal)}</vProd>
      </prod>
      <imposto>
        <ICMS>
          <ICMSSN102>
            <orig>${esc(item.origem)}</orig>
            <CSOSN>${esc(item.csosn)}</CSOSN>
          </ICMSSN102>
        </ICMS>
      </imposto>
    </det>
  `).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfce>
  <ide>
    <cNF>${nota.numero}</cNF>
    <natOp>VENDA DE MERCADORIA</natOp>
    <mod>65</mod>
    <serie>${nota.serie}</serie>
    <nNF>${nota.numero}</nNF>
    <dhEmi>${nota.dataEmissaoIso}</dhEmi>
    <tpNF>1</tpNF>
    <tpAmb>2</tpAmb>
  </ide>
  <emit>
    <CNPJ>${EMPRESA.cnpj}</CNPJ>
    <xNome>${esc(EMPRESA.razao_social)}</xNome>
    <xFant>${esc(EMPRESA.nome_fantasia)}</xFant>
    <IE>${esc(EMPRESA.ie)}</IE>
    <CRT>${esc(EMPRESA.crt)}</CRT>
    <enderEmit>
      <xLgr>${esc(EMPRESA.logradouro)}</xLgr>
      <nro>${esc(EMPRESA.numero)}</nro>
      <xBairro>${esc(EMPRESA.bairro)}</xBairro>
      <cMun>3106705</cMun>
      <xMun>${esc(EMPRESA.cidade)}</xMun>
      <UF>${esc(EMPRESA.uf)}</UF>
      <CEP>${esc(EMPRESA.cep)}</CEP>
      <cPais>1058</cPais>
      <xPais>${esc(EMPRESA.pais)}</xPais>
      <fone>${esc(EMPRESA.fone)}</fone>
    </enderEmit>
  </emit>
  <dest>
    <xNome>${esc(nota.cliente?.nome || "CONSUMIDOR NAO IDENTIFICADO")}</xNome>
    <CPF>${esc(nota.cliente?.cpf || "")}</CPF>
  </dest>
  ${itensXml}
  <total>
    <ICMSTot>
      <vProd>${dinheiro(nota.subtotal)}</vProd>
      <vDesc>${dinheiro(nota.desconto)}</vDesc>
      <vNF>${dinheiro(nota.total)}</vNF>
    </ICMSTot>
  </total>
  <pag>
    <detPag>
      <tPag>${esc(nota.pagamento?.tipo || "DINHEIRO")}</tPag>
      <vPag>${dinheiro(nota.pagamento?.valor || nota.total)}</vPag>
    </detPag>
  </pag>
  <infAdic>
    <infCpl>ESTRUTURA DE TESTE BELA MODAS - CERTIFICADO CARREGADO.</infCpl>
  </infAdic>
</nfce>`;
}

function nomeArquivoXML(nota) {
  const serie = String(nota.serie || 1).padStart(3, "0");
  const numero = String(nota.numero || 0).padStart(9, "0");
  return `${EMPRESA.cnpj}65${serie}${numero}.xml`;
}

function nomeArquivoXMLRegistro(r = {}) {
  const serie = String(r.serie || 1).padStart(3, "0");
  const numero = String(r.numero || 0).padStart(9, "0");
  return `${EMPRESA.cnpj}65${serie}${numero}.xml`;
}

// ================= ZIP XML =================

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

const CRC_TABLE = (() => {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function dosDateTime(date) {
  const d = new Date(date);
  const year = Math.max(d.getFullYear(), 1980);
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  files.forEach(file => {
    const nameBuf = Buffer.from(file.name, "utf8");
    const dataBuf = Buffer.from(file.data, "utf8");
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = crc32(dataBuf);
    const { dosTime, dosDate } = dosDateTime(file.date || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  });

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

// ================= HTML CUPOM =================

function gerarHTML(nota) {
  const itens = (nota.itens || []).map((item) => {
    const codigoExibido = item.ean || item.codigo || "-";
    return `
<tr>
  <td>${esc(codigoExibido)}</td>
  <td>${esc(item.descricao)}</td>
  <td style="text-align:center">${item.quantidade}</td>
  <td style="text-align:right">${moeda(item.valorUnitario)}</td>
  <td style="text-align:right">${moeda(item.valorTotal)}</td>
</tr>
`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>NFC-e ${nota.numero}</title>
<style>
body{
  font-family: monospace;
  background:#fff;
  margin:0;
  padding:10px;
  color:#000;
}
.cupom{
  width:300px;
  margin:auto;
  font-size:12px;
}
.center{
  text-align:center;
}
.sep{
  border-top:1px dashed #000;
  margin:6px 0;
}
table{
  width:100%;
  border-collapse:collapse;
  font-size:11px;
}
th{
  text-align:left;
  border-bottom:1px solid #000;
  padding-bottom:3px;
}
td{
  padding:2px 0;
  vertical-align:top;
}
.total{
  font-size:14px;
  font-weight:bold;
}
.btns{
  margin-top:10px;
  display:flex;
  gap:6px;
  justify-content:center;
}
button{
  padding:6px 10px;
  border:none;
  background:#000;
  color:#fff;
  border-radius:6px;
  cursor:pointer;
  font-size:12px;
}
@media print{
  body{ padding:0; }
  .btns{ display:none; }
}
</style>
</head>
<body>
<div class="cupom">

  <div class="center">
    <strong style="font-size:18px;">${esc(EMPRESA.nome_fantasia)}</strong><br>
    ${esc(EMPRESA.razao_social)}<br>
    CNPJ ${formatarCNPJ(EMPRESA.cnpj)}<br>
    IE ${esc(EMPRESA.ie)}<br>
    ${esc(EMPRESA.logradouro)}, ${esc(EMPRESA.numero)}<br>
    ${esc(EMPRESA.bairro)} - ${esc(EMPRESA.cidade)}/${esc(EMPRESA.uf)}<br>
    CEP ${formatarCEP(EMPRESA.cep)}<br>
    Tel ${formatarTelefone(EMPRESA.fone)}
  </div>

  <div class="sep"></div>

  Número: ${nota.numero}<br>
  Série: ${nota.serie}<br>
  Data: ${esc(nota.dataEmissaoBR)}<br>
  ID: ${esc(nota.id)}<br>
  Cliente: ${esc(nota.cliente?.nome || "Consumidor")}

  <div class="sep"></div>

  <table>
    <thead>
      <tr>
        <th>Cód barras</th>
        <th>Descrição</th>
        <th>Qtd</th>
        <th style="text-align:right">Unit</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${itens}
    </tbody>
  </table>

  <div class="sep"></div>

  Qtd itens: ${(nota.itens || []).reduce((s, item) => s + Number(item.quantidade || 0), 0)}<br>
  Subtotal: R$ ${moeda(nota.subtotal || 0)}<br>
  Desconto: R$ ${moeda(nota.desconto || 0)}<br>

  <div class="total">
    TOTAL R$ ${moeda(nota.total || 0)}
  </div>

  Pagamento: ${esc(nota.pagamento?.tipo || "DINHEIRO")}<br>
  Valor pago: R$ ${moeda(nota.pagamento?.valor || nota.total || 0)}

  <div class="sep"></div>

  Status: ${esc(nota.status || "emitida_homologacao")}<br>
  Chave: ${esc(nota.chave || nota.id)}<br>

  <div style="margin-top:8px;font-size:11px;">
    AMBIENTE DE TESTE / HOMOLOGAÇÃO
  </div>

</div>

<div class="btns">
  <button onclick="window.print()">Imprimir</button>
  <button onclick="window.close()">Fechar</button>
</div>

</body>
</html>`;
}

// ================= HELPERS DE EXPORTAÇÃO =================

async function obterArquivosXmlMes(mes) {
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlMesRemoto(mes);
      if (rows.length) {
        return rows.map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml || ""),
          date: r.dataEmissao || new Date().toISOString()
        }));
      }
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do mês no Apps Script:", e.message);
  }

  const lista = (await listarNotas()).filter(n => n.mesRef === mes);

  return lista.map(n => ({
    name: nomeArquivoXML(n),
    data: gerarXML(n),
    date: n.dataEmissaoIso || n.data || new Date().toISOString()
  }));
}

async function obterArquivosXmlPeriodo(inicio, fim) {
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlPeriodoRemoto(inicio, fim);
      if (rows.length) {
        return rows.map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml || ""),
          date: r.dataEmissao || new Date().toISOString()
        }));
      }
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do período no Apps Script:", e.message);
  }

  const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
  const dFim = fim ? new Date(fim + "T23:59:59") : null;

  const lista = (await listarNotas()).filter(n => {
    const d = new Date(n.dataEmissaoIso || n.data);
    if (dIni && d < dIni) return false;
    if (dFim && d > dFim) return false;
    return true;
  });

  return lista.map(n => ({
    name: nomeArquivoXML(n),
    data: gerarXML(n),
    date: n.dataEmissaoIso || n.data || new Date().toISOString()
  }));
}

async function responderZipMes(res, mes) {
  const files = await obterArquivosXmlMes(mes);

  if (!files.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado para este mês." });
  }

  const zipBuffer = makeZip(files);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${mes}.zip"`);
  return res.send(zipBuffer);
}

async function responderZipPeriodo(res, inicio, fim) {
  const files = await obterArquivosXmlPeriodo(inicio, fim);

  if (!files.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado no período." });
  }

  const zipBuffer = makeZip(files);
  const nome = `${inicio || "inicio"}_${fim || "fim"}`.replace(/\//g, "-");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${nome}.zip"`);
  return res.send(zipBuffer);
}

// ================= ROTAS =================

app.get("/", (req, res) => {
  res.send("API Bela Modas online");
});

app.get("/health", async (req, res) => {
  const notas = await listarNotas();

  let remoto = null;
  if (API_BELA_SHEETS) {
    try {
      remoto = await obterNumeroNfceRemoto();
    } catch (e) {
      remoto = { erro: e.message };
    }
  }

  res.json({
    status: "ok",
    empresa: EMPRESA.nome_fantasia,
    total_notas: notas.length,
    proximo_numero_local: sequencial,
    proximo_numero_remoto: remoto?.numero ?? null,
    serie_remota: remoto?.serie ?? null,
    apps_script_configurado: !!API_BELA_SHEETS,
    certificado: certificado ? true : false,
    cert_password_configurada: !!CERT_PASSWORD
  });
});

app.get("/certificado/status", (req, res) => {
  res.json({
    ok: certificado ? true : false,
    mensagem: certificado ? "certificado carregado" : "certificado nao encontrado"
  });
});

app.get("/empresa", (req, res) => {
  res.json(EMPRESA);
});

app.post("/nfce/emitir", async (req, res) => {
  try {
    const venda = normalizarPayload(req.body);
    const id = String(req.body.vendaId || req.body.id || venda.vendaId || `nfce-${Date.now()}`);

    let numero;
    let serie;
    let numeracaoOrigem = "local";

    try {
      if (!API_BELA_SHEETS) {
        throw new Error("API_BELA_SHEETS não configurada");
      }
      const remoto = await obterNumeroNfceRemoto();
      numero = remoto.numero;
      serie = remoto.serie;
      numeracaoOrigem = "apps_script";
    } catch (e) {
      numero = sequencial++;
      serie = 1;
      console.warn("⚠ usando numeração local:", e.message);
    }

    const dataEmissaoIso = new Date().toISOString();

    const nota = {
      ...venda,
      id,
      numero,
      serie,
      dataEmissaoIso,
      dataEmissaoBR: agoraBR(),
      mesRef: dataMesRef(dataEmissaoIso),
      status: "emitida_homologacao",
      chave: id
    };

    nota.pdf_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/pdf`;
    nota.xml_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/xml`;

    await salvarNota(nota);

    const xml = gerarXML(nota);

    let xmlSalvoNoAppsScript = false;
    let erroAppsScript = null;

    try {
      if (!API_BELA_SHEETS) {
        throw new Error("API_BELA_SHEETS não configurada");
      }
      await salvarXmlNfceRemoto(nota, xml);
      xmlSalvoNoAppsScript = true;
    } catch (e) {
      erroAppsScript = e.message;
      console.error("⚠ falha ao salvar XML no Apps Script:", e.message);
    }

    res.json({
      ok: true,
      mensagem: "NFC-e estruturada com sucesso.",
      nfce: {
        id: nota.id,
        numero: nota.numero,
        serie: nota.serie,
        chave: nota.chave,
        status: nota.status,
        pdf_url: nota.pdf_url,
        xml_url: nota.xml_url,
        numeracao_origem: numeracaoOrigem,
        xml_salvo_apps_script: xmlSalvoNoAppsScript,
        erro_apps_script: erroAppsScript
      }
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message || "Erro ao estruturar NFC-e."
    });
  }
});

app.get("/nfce/lista", async (req, res) => {
  const notas = await listarNotas();
  const notasResumo = notas.map(n => ({
    id: n.id,
    numero: n.numero,
    serie: n.serie,
    data: n.dataEmissaoIso || n.data,
    total: n.total,
    cliente: n.cliente?.nome || "",
    status: n.status,
    xml_url: n.xml_url,
    pdf_url: n.pdf_url,
    mesRef: n.mesRef
  }));
  res.json({ ok: true, total: notasResumo.length, notas: notasResumo });
});

app.get("/nfce/:id", async (req, res) => {
  const nota = await lerNota(req.params.id);
  if (!nota) return res.status(404).json({ ok: false, error: "Nota não encontrada." });
  res.json({ ok: true, nfce: nota });
});

app.get("/nfce/:id/xml", async (req, res) => {
  const nota = await lerNota(req.params.id);
  if (!nota) return res.status(404).type("text/xml").send("<erro>Nota não encontrada</erro>");
  res.type("text/xml").send(gerarXML(nota));
});

app.get("/nfce/:id/pdf", async (req, res) => {
  const nota = await lerNota(req.params.id);
  if (!nota) return res.status(404).send("nota nao encontrada");
  res.type("html").send(gerarHTML(nota));
});

// ====== ROTAS ANTIGAS ======

app.get("/nfce/xml/mes/:mes", async (req, res) => {
  const mes = String(req.params.mes || "");
  return responderZipMes(res, mes);
});

app.get("/nfce/xml/periodo", async (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");
  return responderZipPeriodo(res, inicio, fim);
});

// ====== ROTAS CURTAS PARA O INDEX ======

app.get("/xml/mes", async (req, res) => {
  const ano = String(req.query.ano || "");
  const mes = String(req.query.mes || "");
  const mesRef = normalizarMes(ano, mes);

  if (!mesRef) {
    return res.status(400).json({ ok: false, error: "Parâmetros ano/mes inválidos." });
  }

  return responderZipMes(res, mesRef);
});

app.get("/xml/periodo", async (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");

  if (!inicio || !fim) {
    return res.status(400).json({ ok: false, error: "Informe inicio e fim." });
  }

  return responderZipPeriodo(res, inicio, fim);
});

// ================= START =================

ensureDirs()
  .then(carregarSequencial)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bela Caixa API rodando na porta ${PORT}`);
      console.log(`Apps Script configurado: ${API_BELA_SHEETS ? "sim" : "não"}`);
    });
  })
  .catch(err => {
    console.error("Falha ao iniciar API:", err);
    process.exit(1);
  });
