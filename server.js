// Backend Bela Modas NFC-e 2.7

// HOMOLOGACAO SEFAZ MG - BELA MODAS
// Backend ajustado automaticamente

// Backend NFC-e Bela Modas - Preparado para Homologação SEFAZ MG
import express from "express";
import cors from "cors";
import zlib from "zlib";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "xmldom";
import crypto from "crypto";


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
  console.log("⚠ certificado não encontrado - sistema em homologação");
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

function calcularDV(chave43) {
  let peso = 2;
  let soma = 0;

  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  return resto === 0 || resto === 1 ? 0 : 11 - resto;
}

function gerarChaveAcesso(numeroNF) {
  const cUF = "31";

  const agora = new Date();
  const ano = String(agora.getFullYear()).slice(-2);
  const mes = String(agora.getMonth() + 1).padStart(2, "0");

  const aamm = `${ano}${mes}`;

  const cnpj = somenteDigitos(EMPRESA.cnpj);
  const modelo = "65";
  const serie = "001";
  const numero = String(numeroNF).padStart(9, "0");
  const tpEmis = "1";

  const cNF = String(
    Math.floor(Math.random() * 99999999)
  ).padStart(8, "0");

  const chave43 = `${cUF}${aamm}${cnpj}${modelo}${serie}${numero}${tpEmis}${cNF}`;

  const dv = calcularDV(chave43);

  return `${chave43}${dv}`;
}

function assinarXML(xml, refId) {
  try {
    if (!certificado || !CERT_PASSWORD) {
      console.log("⚠ certificado não configurado");
      return xml;
    }

    const p12Der = forge.util.createBuffer(
      certificado.toString("binary")
    );

    const p12Asn1 = forge.asn1.fromDer(p12Der);

    const p12 = forge.pkcs12.pkcs12FromAsn1(
      p12Asn1,
      CERT_PASSWORD
    );

    let chavePrivada = null;

    for (const sci of p12.safeContents) {
      for (const sbi of sci.safeBags) {
        if (sbi.key) {
          chavePrivada = forge.pki.privateKeyToPem(sbi.key);
        }
      }
    }

    if (!chavePrivada) {
      throw new Error("Chave privada não encontrada");
    }

    const sig = new SignedXml();

    sig.privateKey = chavePrivada;

    sig.addReference({
      xpath: `//*[@Id='${refId}']`,
      digestAlgorithm:
        "http://www.w3.org/2000/09/xmldsig#sha1",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
      ]
    });

    sig.canonicalizationAlgorithm =
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

    sig.signatureAlgorithm =
      "http://www.w3.org/2000/09/xmldsig#rsa-sha1";

    sig.computeSignature(xml);

    return sig.getSignedXml();
  } catch (e) {
    console.error("Erro assinatura XML:", e.message);
    return xml;
  }
}


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

function dataDiaRef(iso) {
  return String(iso || new Date().toISOString()).substring(0, 10);
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

// ================= CHAVE DE ACESSO NFC-e =================

const CUF_MG = "31";

function calcularDVChave(chave43) {
  // Módulo 11 com pesos 2-9 ciclicamente da direita para esquerda
  const seq = [2, 3, 4, 5, 6, 7, 8, 9];
  let soma = 0;
  let seqIdx = 0;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += parseInt(chave43[i], 10) * seq[seqIdx % 8];
    seqIdx++;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function gerarCNF(numero) {
  // cNF: 8 dígitos aleatórios/sequenciais (diferente do nNF)
  return String(numero).padStart(8, "0").slice(-8);
}

function calcularChaveAcesso(nota) {
  const aamm = nota.dataEmissaoIso
    ? nota.dataEmissaoIso.substring(2, 4) + nota.dataEmissaoIso.substring(5, 7)
    : new Date().toISOString().substring(2, 4) + new Date().toISOString().substring(5, 7);

  const cnpj     = EMPRESA.cnpj.padStart(14, "0");
  const mod      = "65";
  const serie    = String(nota.serie || 1).padStart(3, "0");
  const nnf      = String(nota.numero || 1).padStart(9, "0");
  const tpEmis   = "1"; // emissão normal
  const cnf      = gerarCNF(nota.numero || 1);

  const chave43  = CUF_MG + aamm + cnpj + mod + serie + nnf + tpEmis + cnf;
  const cdv      = calcularDVChave(chave43);

  return chave43 + String(cdv);
}

// ================= FORMA DE PAGAMENTO FISCAL =================

function mapearFormaPagamentoFiscal(tipo = "") {
  const t = String(tipo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

  if (!t) return "99";
  if (t.includes("PIX")) return "17";
  if (t.includes("DINHEIRO")) return "01";
  if (t.includes("DEBITO")) return "04";
  if (t.includes("CREDITO")) return "03";
  if (t.includes("CARTAO")) return "03";
  if (t.includes("BOLETO")) return "15";
  if (t.includes("CREDIARIO")) return "05";

  return "99";
}

// ================= APPS SCRIPT / XML / NOTAS =================

async function obterNumeroNfceRemoto() {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("getProximoNumeroNfce");
  const data = await fetchJson(url);

  return {
    numero: toNumber(data.numero, 1),
    serie: toNumber(data.serie, 1)
  };
}

async function salvarXmlNfceRemoto(nota, xml) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const payload = {
    action: "salvarNfceXml",
    id: nota.id,
    vendaId: nota.vendaId || nota.id,
    numero: nota.numero,
    serie: nota.serie,
    dataEmissao: nota.dataEmissaoIso,
    dataEmissaoBR: nota.dataEmissaoBR || "",
    cliente: nota.cliente?.nome || "",
    cpf: nota.cliente?.cpf || "",
    total: nota.total || 0,
    status: nota.status || "emitida_homologacao",
    chave: nota.chave || nota.id,
    pagamentoTipo: nota.pagamento?.tipo || "",
    pdfUrl: nota.pdf_url || "",
    xmlUrl: nota.xml_url || "",
    notaJson: JSON.stringify(nota),
    xml
  };

  return await fetchJson(API_BELA_SHEETS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function listarXmlMesRemoto(mes) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceXmlMes", { mes });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

async function listarXmlPeriodoRemoto(inicio, fim) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceXmlPeriodo", { inicio, fim });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

async function getNfceNotaRemota(id) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("getNfceNota", { id });
  const data = await fetchJson(url);
  return data.nota || null;
}

async function listarNfceNotasRemotas({ dia = "", mes = "" } = {}) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceNotas", { dia, mes });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

// ================= STORAGE LOCAL =================

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

async function lerNotaLocal(id) {
  try {
    const raw = await fsp.readFile(caminhoNota(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listarNotasLocal() {
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
  const notas = await listarNotasLocal();
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

  const total = body.total != null ? Number(body.total) : totalCalculado;
  const pagamentoValor = body.pagamento?.valor != null ? Number(body.pagamento.valor) : total;

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
  // Chave de acesso: calcula se não existir ainda
  const chave = nota.chaveAcesso || calcularChaveAcesso(nota);
  const nfeId = `NFe${chave}`;

  const cnf    = gerarCNF(nota.numero || 1);
  const serie  = String(nota.serie || 1).padStart(3, "0");
  const nnf    = String(nota.numero || 1).padStart(9, "0");
  const tpAmb  = "2"; // 1=produção, 2=homologação
  const dhEmi  = nota.dataEmissaoIso
    ? nota.dataEmissaoIso.replace("Z", "-03:00").substring(0, 19) + "-03:00"
    : new Date().toISOString().replace("Z", "-03:00").substring(0, 19) + "-03:00";

  // Itens
  const itensXml = (nota.itens || []).map((item, idx) => {
    const vProd = dinheiro(item.valorTotal || (item.quantidade * item.valorUnitario));
    return `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${esc(item.codigo || String(idx + 1).padStart(6, "0"))}</cProd>
        <cEAN>${esc(item.ean && item.ean.length >= 8 ? item.ean : "SEM GTIN")}</cEAN>
        <xProd>${esc(item.descricao || "PRODUTO")}</xProd>
        <NCM>${esc(item.ncm || "62034200")}</NCM>
        <CFOP>${esc(item.cfop || "5102")}</CFOP>
        <uCom>${esc(item.unidade || "UN")}</uCom>
        <qCom>${dinheiro(item.quantidade)}</qCom>
        <vUnCom>${dinheiro(item.valorUnitario)}</vUnCom>
        <vProd>${vProd}</vProd>
        <cEANTrib>${esc(item.ean && item.ean.length >= 8 ? item.ean : "SEM GTIN")}</cEANTrib>
        <uTrib>${esc(item.unidade || "UN")}</uTrib>
        <qTrib>${dinheiro(item.quantidade)}</qTrib>
        <vUnTrib>${dinheiro(item.valorUnitario)}</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        <vTotTrib>0.00</vTotTrib>
        <ICMS>
          <ICMSSN102>
            <orig>${esc(item.origem || "0")}</orig>
            <CSOSN>102</CSOSN>
          </ICMSSN102>
        </ICMS>
        <PIS>
          <PISNT>
            <CST>49</CST>
          </PISNT>
        </PIS>
        <COFINS>
          <COFINSNT>
            <CST>49</CST>
          </COFINSNT>
        </COFINS>
      </imposto>
    </det>`
  }).join("");

  // Totais
  const vProdTotal = dinheiro(nota.subtotal || nota.total || 0);
  const vDesc      = dinheiro(nota.desconto || 0);
  const vNF        = dinheiro(nota.total || 0);

  // Destinatário: omite bloco se não tiver CPF (consumidor não identificado)
  const temCpf = nota.cliente?.cpf && somenteDigitos(nota.cliente.cpf).length === 11;
  const destXml = temCpf ? `
  <dest>
    <CPF>${somenteDigitos(nota.cliente.cpf)}</CPF>
    <xNome>${esc(nota.cliente.nome || "CONSUMIDOR NAO IDENTIFICADO")}</xNome>
    <indIEDest>9</indIEDest>
  </dest>` : "";

  // Pagamento — suporta múltiplas formas
  const pagamentos = Array.isArray(nota.pagamentos) && nota.pagamentos.length
    ? nota.pagamentos
    : [{ tipo: nota.pagamento?.tipo || "DINHEIRO", valor: nota.pagamento?.valor || nota.total }];

  const detPagXml = pagamentos.map(p => `
    <detPag>
      <indPag>0</indPag>
      <tPag>${mapearFormaPagamentoFiscal(p.tipo)}</tPag>
      <vPag>${dinheiro(p.valor)}</vPag>
    </detPag>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="${nfeId}" versao="4.00">
      <ide>
        <cUF>${CUF_MG}</cUF>
        <cNF>${cnf}</cNF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>65</mod>
        <serie>${serie}</serie>
        <nNF>${nnf}</nNF>
        <dhEmi>${dhEmi}</dhEmi>
        <tpNF>1</tpNF>
        <idDest>1</idDest>
        <cMunFG>3106705</cMunFG>
        <tpImp>4</tpImp>
        <tpEmis>1</tpEmis>
        <cDV>${chave.slice(-1)}</cDV>
        <tpAmb>${tpAmb}</tpAmb>
        <finNFe>1</finNFe>
        <indFinal>1</indFinal>
        <indPres>1</indPres>
        <procEmi>0</procEmi>
        <verProc>1.0.0</verProc>
      </ide>
      <emit>
        <CNPJ>${EMPRESA.cnpj}</CNPJ>
        <xNome>${esc(EMPRESA.razao_social)}</xNome>
        <xFant>${esc(EMPRESA.nome_fantasia)}</xFant>
        <enderEmit>
          <xLgr>${esc(EMPRESA.logradouro)}</xLgr>
          <nro>${esc(EMPRESA.numero)}</nro>
          <xBairro>${esc(EMPRESA.bairro)}</xBairro>
          <cMun>3106705</cMun>
          <xMun>${esc(EMPRESA.cidade)}</xMun>
          <UF>${esc(EMPRESA.uf)}</UF>
          <CEP>${somenteDigitos(EMPRESA.cep)}</CEP>
          <cPais>1058</cPais>
          <xPais>BRASIL</xPais>
          <fone>${somenteDigitos(EMPRESA.fone)}</fone>
        </enderEmit>
        <IE>${somenteDigitos(EMPRESA.ie)}</IE>
        <CRT>${esc(EMPRESA.crt)}</CRT>
      </emit>${destXml}
      ${itensXml}
      <total>
        <ICMSTot>
          <vBC>0.00</vBC>
          <vICMS>0.00</vICMS>
          <vICMSDeson>0.00</vICMSDeson>
          <vFCP>0.00</vFCP>
          <vBCST>0.00</vBCST>
          <vST>0.00</vST>
          <vFCPST>0.00</vFCPST>
          <vFCPSTRet>0.00</vFCPSTRet>
          <vProd>${vProdTotal}</vProd>
          <vFrete>0.00</vFrete>
          <vSeg>0.00</vSeg>
          <vDesc>${vDesc}</vDesc>
          <vII>0.00</vII>
          <vIPI>0.00</vIPI>
          <vIPIDevol>0.00</vIPIDevol>
          <vPIS>0.00</vPIS>
          <vCOFINS>0.00</vCOFINS>
          <vOutro>0.00</vOutro>
          <vNF>${vNF}</vNF>
          <vTotTrib>0.00</vTotTrib>
        </ICMSTot>
      </total>
      <transp>
        <modFrete>9</modFrete>
      </transp>
      <pag>${detPagXml}
      </pag>
      <infAdic>
        <infCpl>BELA MODAS - SIMPLES NACIONAL - HOMOLOGACAO</infCpl>
      </infAdic>
    </infNFe>
  </NFe>
</nfeProc>`;
}

function nomeArquivoXML(nota) {
  // Nome padrão SEFAZ: chave44 + "-nfe.xml"
  const chave = nota.chaveAcesso || nota.chave || calcularChaveAcesso(nota);
  return `${chave}-nfe.xml`;
}

function nomeArquivoXMLRegistro(r = {}) {
  const chave = r.chaveAcesso || r.chave || calcularChaveAcesso(r);
  return `${chave}-nfe.xml`;
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
  const itens = (nota.itens || []).map((item, index) => {
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${esc(item.descricao || "")}</td>
        <td style="text-align:center">${Number(item.quantidade || 0).toFixed(0)}</td>
        <td style="text-align:right">R$ ${moeda(item.valorUnitario || 0)}</td>
        <td style="text-align:right">R$ ${moeda(item.valorTotal || 0)}</td>
      </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>NFC-e ${nota.numero}</title>

<style>
@page{
  size:80mm auto;
  margin:0;
}

body{
  margin:0;
  padding:10px;
  background:#f4f4f4;
  font-family:Arial,sans-serif;
  color:#000;
}

.cupom{
  width:80mm;
  margin:auto;
  background:#fff;
  padding:12px;
  border-radius:8px;
  box-sizing:border-box;
}

.topo{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:10px;
}

.empresa{
  flex:1;
  text-align:center;
}

.empresa h1{
  margin:0;
  font-size:22px;
}

.empresa p{
  margin:2px 0;
  font-size:13px;
}

.box-nfce{
  width:150px;
  border:1px solid #ccc;
  border-radius:8px;
  padding:8px;
  text-align:center;
}

.box-nfce h2{
  margin:0;
  font-size:18px;
}

.box-nfce .numero{
  font-size:34px;
  font-weight:bold;
}

.barra{
  margin:12px 0;
  background:#eee;
  padding:8px;
  text-align:center;
  font-weight:bold;
  border-radius:4px;
  font-size:14px;
}

.cliente{
  margin:10px 0;
  font-size:14px;
}

table{
  width:100%;
  border-collapse:collapse;
  font-size:12px;
}

th{
  border-top:1px solid #000;
  border-bottom:1px solid #000;
  padding:6px 2px;
  text-align:left;
}

td{
  padding:6px 2px;
  border-bottom:1px dashed #ccc;
  vertical-align:top;
}

.resumo{
  margin-top:12px;
  display:flex;
  justify-content:space-between;
  gap:10px;
}

.total-box{
  flex:1;
}

.total-box div{
  margin-bottom:8px;
}

.total-final{
  background:#f1f1f1;
  padding:10px;
  border-radius:6px;
  font-size:18px;
  font-weight:bold;
}

.pagamento-box{
  width:210px;
}

.pagamento-card{
  border:1px solid #ccc;
  border-radius:6px;
  padding:10px;
  margin-bottom:10px;
  text-align:center;
}

.pagamento-card strong{
  display:block;
  margin-bottom:6px;
}

.tributos{
  margin-top:16px;
  border:1px dashed #aaa;
  border-radius:6px;
  padding:10px;
  text-align:center;
  font-size:13px;
}

.info-final{
  margin-top:16px;
  border:1px dashed #ccc;
  border-radius:6px;
  padding:10px;
  display:flex;
  justify-content:space-between;
  gap:12px;
  font-size:13px;
}

.chave{
  background:#f1f1f1;
  padding:6px;
  border-radius:4px;
  word-break:break-all;
  margin-top:6px;
}

.qrcode{
  margin-top:16px;
  text-align:center;
}

.rodape{
  margin-top:16px;
  text-align:center;
  border:1px solid #ddd;
  border-radius:6px;
  padding:12px;
  font-size:14px;
}

.botoes{
  text-align:center;
  margin-top:14px;
}

button{
  padding:8px 14px;
  border:none;
  border-radius:6px;
  background:#222;
  color:#fff;
  cursor:pointer;
  margin:0 4px;
}

@media print{
  body{
    background:#fff;
    padding:0;
  }

  .cupom{
    width:100%;
    border-radius:0;
  }

  .botoes{
    display:none;
  }
}
</style>
</head>

<body>

<div class="cupom">

  <div class="topo">

    <div class="empresa">
      <h1>${esc(EMPRESA.nome_fantasia)}</h1>
      <p>${esc(EMPRESA.razao_social)}</p>
      <p>CNPJ: ${formatarCNPJ(EMPRESA.cnpj)} &nbsp;&nbsp; IE: ${esc(EMPRESA.ie)}</p>
      <p>${esc(EMPRESA.logradouro)}, ${esc(EMPRESA.numero)} - ${esc(EMPRESA.bairro)}</p>
      <p>${esc(EMPRESA.cidade)}/${esc(EMPRESA.uf)} - CEP: ${formatarCEP(EMPRESA.cep)}</p>
      <p>Tel: ${formatarTelefone(EMPRESA.fone)}</p>
    </div>

    <div class="box-nfce">
      <h2>NFC-e</h2>
      <div class="numero">${nota.numero}</div>
      <div>SÉRIE: ${nota.serie}</div>
      <div style="margin-top:8px;">EMISSÃO:</div>
      <div>${esc(nota.dataEmissaoBR)}</div>
      <div style="margin-top:8px;">VIA CONSUMIDOR</div>
    </div>

  </div>

  <div class="barra">
    DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica
  </div>

  <div class="cliente">
    <strong>Cliente:</strong> ${esc(nota.cliente?.nome || "Balcão")}
  </div>

  <table>
    <thead>
      <tr>
        <th>CÓDIGO</th>
        <th>DESCRIÇÃO</th>
        <th>QTD</th>
        <th>VL UNIT</th>
        <th>VL TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itens}
    </tbody>
  </table>

  <div class="resumo">

    <div class="total-box">
      <div>QTD. ITENS: ${(nota.itens || []).length}</div>
      <div>SUBTOTAL: R$ ${moeda(nota.subtotal || nota.total || 0)}</div>
      <div>DESCONTO: R$ ${moeda(nota.desconto || 0)}</div>

      <div class="total-final">
        TOTAL: R$ ${moeda(nota.total || 0)}
      </div>
    </div>

    <div class="pagamento-box">

      <div class="pagamento-card">
        <strong>FORMA DE PAGAMENTO</strong>
        ${esc(nota.pagamento?.tipo || "DINHEIRO")}
      </div>

      <div class="pagamento-card">
        <strong>VALOR PAGO</strong>
        R$ ${moeda(nota.pagamento?.valor || nota.total || 0)}
      </div>

    </div>

  </div>

  <div class="tributos">
    <strong>INFORMAÇÕES DOS TRIBUTOS</strong><br><br>
    Tributos Totais (Lei Federal 12.741/2012)<br>
    R$ ${moeda(nota.valorTributos || 0)}
  </div>

  <div style="margin-top:12px;text-align:center;font-size:13px;font-weight:bold;">
    DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL<br>
    NÃO GERA DIREITO A CRÉDITO FISCAL DE ICMS, ISS E IPI
  </div>

  <div class="info-final">

    <div>
      <div>Número: ${nota.numero}</div>
      <div>Série: ${nota.serie}</div>
      <div>Data de Emissão: ${esc(nota.dataEmissaoBR)}</div>
      <div>Status: ${esc(nota.status || "EMITIDA")}</div>
    </div>

    <div>
      <div><strong>Ambiente:</strong> HOMOLOGAÇÃO</div>
      <div style="margin-top:10px;"><strong>Chave de Acesso</strong></div>
      <div class="chave">
        ${esc(nota.chave || "")}
      </div>
    </div>

  </div>

  <div class="qrcode">
    <p>Consulte pela chave de acesso em:</p>
    <strong>www.nfce.fazenda.mg.gov.br/portalnfce</strong>
  </div>

  <div class="rodape">
    <strong>MENSAGEM AO CONSUMIDOR</strong><br>
    Obrigado pela preferência!<br>
    Volte sempre!
  </div>

  <div class="botoes">
    <button onclick="window.print()">Imprimir</button>
    <button onclick="window.close()">Fechar</button>
  </div>

</div>

</body>
</html>`;
}

// ================= HELPERS DE EXPORTAÇÃO =================

async function obterArquivosXmlMes(mes) {
  let arquivos = [];

  // 1) tenta XML completo salvo
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlMesRemoto(mes);
      arquivos = rows
        .filter(r => String(r.xml || "").trim() !== "")
        .map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml),
          date: r.dataEmissao || new Date().toISOString()
        }));
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do mês no Apps Script:", e.message);
  }

  // 2) fallback remoto: recria XML a partir de nfce_notas
  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({ mes });
      const existentes = new Set(arquivos.map(a => a.name));

      for (const n of notas) {
        const id = n.id;
        if (!id) continue;

        const notaCompleta = await getNfceNotaRemota(id);
        if (!notaCompleta) continue;

        const nome = nomeArquivoXML(notaCompleta);
        if (existentes.has(nome)) continue;

        arquivos.push({
          name: nome,
          data: gerarXML(notaCompleta),
          date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString()
        });
        existentes.add(nome);
      }
    }
  } catch (e) {
    console.error("⚠ falha ao recriar XML do mês via nfce_notas:", e.message);
  }

  // 3) último fallback local
  if (!arquivos.length) {
    const lista = (await listarNotasLocal()).filter(n => n.mesRef === mes);

    arquivos = lista.map(n => ({
      name: nomeArquivoXML(n),
      data: gerarXML(n),
      date: n.dataEmissaoIso || n.data || new Date().toISOString()
    }));
  }

  return arquivos;
}

async function obterArquivosXmlPeriodo(inicio, fim) {
  let arquivos = [];

  // 1) tenta XML completo salvo
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlPeriodoRemoto(inicio, fim);
      arquivos = rows
        .filter(r => String(r.xml || "").trim() !== "")
        .map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml),
          date: r.dataEmissao || new Date().toISOString()
        }));
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do período no Apps Script:", e.message);
  }

  // 2) fallback remoto: recria XML a partir de nfce_notas
  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({});
      const existentes = new Set(arquivos.map(a => a.name));
      const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
      const dFim = fim ? new Date(fim + "T23:59:59") : null;

      for (const n of notas) {
        const notaDate = new Date(n.data || "");
        if (dIni && notaDate < dIni) continue;
        if (dFim && notaDate > dFim) continue;

        const notaCompleta = await getNfceNotaRemota(n.id);
        if (!notaCompleta) continue;

        const nome = nomeArquivoXML(notaCompleta);
        if (existentes.has(nome)) continue;

        arquivos.push({
          name: nome,
          data: gerarXML(notaCompleta),
          date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString()
        });
        existentes.add(nome);
      }
    }
  } catch (e) {
    console.error("⚠ falha ao recriar XML do período via nfce_notas:", e.message);
  }

  // 3) último fallback local
  if (!arquivos.length) {
    const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
    const dFim = fim ? new Date(fim + "T23:59:59") : null;

    const lista = (await listarNotasLocal()).filter(n => {
      const d = new Date(n.dataEmissaoIso || n.data);
      if (dIni && d < dIni) return false;
      if (dFim && d > dFim) return false;
      return true;
    });

    arquivos = lista.map(n => ({
      name: nomeArquivoXML(n),
      data: gerarXML(n),
      date: n.dataEmissaoIso || n.data || new Date().toISOString()
    }));
  }

  return arquivos;
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
  let remoto = null;
  if (API_BELA_SHEETS) {
    try {
      remoto = await obterNumeroNfceRemoto();
    } catch (e) {
      remoto = { erro: e.message };
    }
  }

  let totalRemoto = null;
  try {
    const notasRemotas = API_BELA_SHEETS ? await listarNfceNotasRemotas({}) : [];
    totalRemoto = notasRemotas.length;
  } catch {
    totalRemoto = null;
  }

  const notasLocal = await listarNotasLocal();

  res.json({
    status: "ok",
    empresa: EMPRESA.nome_fantasia,
    total_notas_local: notasLocal.length,
    total_notas_remoto: totalRemoto,
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
      if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");
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

    // Calcula chave de acesso antes de montar a nota
    const chaveAcesso = calcularChaveAcesso({ numero, serie, dataEmissaoIso });

    const nota = {
      ...venda,
      id,
      numero,
      serie,
      chaveAcesso,
      dataEmissaoIso,
      dataEmissaoBR: agoraBR(),
      mesRef: dataMesRef(dataEmissaoIso),
      diaRef: dataDiaRef(dataEmissaoIso),
      status: "emitida_homologacao",
      chave: chaveAcesso
    };

    nota.pdf_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/pdf`;
    nota.xml_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/xml`;

    await salvarNota(nota);

    const xml = gerarXML(nota);

    let xmlSalvoNoAppsScript = false;
    let erroAppsScript = null;

    try {
      if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");
      await salvarXmlNfceRemoto(nota, xml);
      xmlSalvoNoAppsScript = true;
    } catch (e) {
      erroAppsScript = e.message;
      console.error("⚠ falha ao salvar XML/nota no Apps Script:", e.message);
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
  const dia = String(req.query.dia || "");
  const mes = String(req.query.mes || "");

  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({ dia, mes });
      return res.json({ ok: true, total: notas.length, notas });
    }
  } catch (e) {
    console.error("⚠ falha ao listar notas remotas:", e.message);
  }

  const notasLocal = await listarNotasLocal();
  const notasResumo = notasLocal.map(n => ({
    id: n.id,
    numero: n.numero,
    serie: n.serie,
    data: n.dataEmissaoIso || n.data,
    total: n.total,
    cliente: n.cliente?.nome || "",
    status: n.status,
    xml_url: n.xml_url,
    pdf_url: n.pdf_url,
    mesRef: n.mesRef,
    diaRef: n.diaRef || dataDiaRef(n.dataEmissaoIso || n.data || "")
  }));

  return res.json({ ok: true, total: notasResumo.length, notas: notasResumo });
});

async function lerNotaCompleta(id) {
  try {
    if (API_BELA_SHEETS) {
      const notaRemota = await getNfceNotaRemota(id);
      if (notaRemota) return notaRemota;
    }
  } catch (e) {
    console.error("⚠ falha ao ler nota remota:", e.message);
  }

  return await lerNotaLocal(id);
}

app.get("/nfce/:id", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) return res.status(404).json({ ok: false, error: "Nota não encontrada." });
  res.json({ ok: true, nfce: nota });
});

app.get("/nfce/:id/xml", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) return res.status(404).type("text/xml").send("<erro>Nota não encontrada</erro>");
  res.type("text/xml").send(gerarXML(nota));
});

app.get("/nfce/:id/pdf", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
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


// ================= CONFIG SIMPLES NACIONAL =================

const CRT = "1";
const CSOSN_PADRAO = "102";

function gerarBlocoICMS_SN() {
  return `
  <ICMS>
    <ICMSSN102>
      <orig>0</orig>
      <CSOSN>${CSOSN_PADRAO}</CSOSN>
    </ICMSSN102>
  </ICMS>
  `;
}

function gerarBlocoPIS_SN() {
  return `
  <PIS>
    <PISNT>
      <CST>49</CST>
    </PISNT>
  </PIS>
  `;
}

function gerarBlocoCOFINS_SN() {
  return `
  <COFINS>
    <COFINSNT>
      <CST>49</CST>
    </COFINSNT>
  </COFINS>
  `;
}

function gerarVTotTrib(valor) {
  return (Number(valor || 0) * 0.12).toFixed(2);
}

// Ambiente homologação padrão
const NFE_AMBIENTE = process.env.NFE_AMBIENTE || "2";

// Preparado para futura integração SEFAZ
// pendente:
// - SOAP
// - envio lote
// - retorno autorização
// - consulta recibo
// - CSC produção


// ================= XML ENVIO / AUTORIZADO =================

function montarXMLAutorizado(xmlNFe, protocolo = "000000000000000") {
  return `
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
${xmlNFe}

<protNFe versao="4.00">
  <infProt>
    <tpAmb>2</tpAmb>
    <verAplic>Bela Caixa NFC-e 2.6</verAplic>
    <chNFe></chNFe>
    <dhRecbto>${new Date().toISOString()}</dhRecbto>
    <nProt>${protocolo}</nProt>
    <digVal></digVal>
    <cStat>100</cStat>
    <xMotivo>Autorizado o uso da NF-e</xMotivo>
  </infProt>
</protNFe>

</nfeProc>
`;
}


// ================= cNF RANDOMICO =================

function gerarCodigoNumericoNFCE() {
  return String(
    Math.floor(10000000 + Math.random() * 90000000)
  );
}


// ================= DV CHAVE ACESSO =================

function calcularDVChave(chave43) {
  let soma = 0;
  let peso = 2;

  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}


// ================= QRCode NFC-e =================

function gerarInfNFeSupl(urlQRCode) {
  return `
<infNFeSupl>
  <qrCode><![CDATA[${urlQRCode}]]></qrCode>
  <urlChave>
    https://www.hom.nfce.fazenda.mg.gov.br/portalnfce
  </urlChave>
</infNFeSupl>
`;
}


// ================= ASSINATURA XML =================

function inserirAssinaturaFake(xml) {
  return xml + `
<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
  <SignedInfo></SignedInfo>
  <SignatureValue>ASSINATURA_PENDENTE</SignatureValue>
</Signature>
`;
}

// ================= ASSINATURA XML REAL =================

function assinarXMLReal(xml, privateKeyPem, certPem, refId) {
  try {
    const sig = new SignedXml();

    sig.privateKey = privateKeyPem;

    sig.addReference({
      xpath: `//*[@Id='${refId}']`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
      ],
      digestAlgorithm:
        "http://www.w3.org/2001/04/xmlenc#sha256"
    });

    sig.signatureAlgorithm =
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

    sig.canonicalizationAlgorithm =
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

    sig.keyInfoProvider = {
      getKeyInfo() {
        return `<X509Data><X509Certificate>${
          certPem
            .replace(/-----BEGIN CERTIFICATE-----/g, "")
            .replace(/-----END CERTIFICATE-----/g, "")
            .replace(/\\r?\\n|\\r/g, "")
        }</X509Certificate></X509Data>`;
      }
    };

    sig.computeSignature(xml);

    return sig.getSignedXml();
  } catch (e) {
    console.error("Erro assinatura XML:", e);
    return xml;
  }
}

// ================= CERTIFICADO DIGITAL =================

function carregarCertificadoPFX(certBase64, senha) {
  try {
    const p12Der = forge.util.decode64(certBase64);

    const p12Asn1 = forge.asn1.fromDer(p12Der);

    const p12 = forge.pkcs12.pkcs12FromAsn1(
      p12Asn1,
      senha
    );

    const bags =
      p12.getBags({
        bagType: forge.pki.oids.pkcs8ShroudedKeyBag
      });

    const keyObj =
      bags[forge.pki.oids.pkcs8ShroudedKeyBag][0];

    const certBags =
      p12.getBags({
        bagType: forge.pki.oids.certBag
      });

    const certObj =
      certBags[forge.pki.oids.certBag][0];

    return {
      privateKeyPem:
        forge.pki.privateKeyToPem(keyObj.key),

      certPem:
        forge.pki.certificateToPem(certObj.cert)
    };
  } catch (e) {
    console.error("Erro certificado:", e);
    return null;
  }
}

// ================= QRCODE OFICIAL MG =================

function gerarHashCSC(chave, CSC) {
  return crypto
    .createHash("sha1")
    .update(chave + CSC)
    .digest("hex");
}

function gerarQRCodeOficial(
  chave,
  tpAmb,
  valor,
  digest,
  CSC,
  CSC_ID
) {
  const hash = gerarHashCSC(chave, CSC);

  return `https://www.hom.nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|${tpAmb}|${CSC_ID}|${valor}|${digest}|${hash}`;
}
