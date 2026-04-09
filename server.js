import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import zlib from "zlib";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://bela-caixa-api.onrender.com";

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
  const qtd = Number(item.quantidade || item.qtd || 1);
  const valorUnitario = Number(item.valorUnitario || item.preco || item.valor || 0);
  const valorTotal = Number(item.valorTotal || (qtd * valorUnitario));

  return {
    codigo: String(item.codigo || item.cod || item.id || ""),
    descricao: String(item.descricao || item.nome || item.desc || "PRODUTO"),
    ncm: String(item.ncm || "00000000"),
    cfop: String(item.cfop || "5102"),
    csosn: String(item.csosn || "102"),
    unidade: String(item.unidade || "UN"),
    origem: String(item.origem || "0"),
    ean: String(item.ean || ""),
    quantidade: qtd,
    valorUnitario,
    valorTotal
  };
}

function normalizarPayload(body = {}) {
  const itens = (Array.isArray(body.itens) ? body.itens : []).map(obterProdutoFiscal);
  const subtotal = itens.reduce((s, i) => s + Number(i.valorTotal || 0), 0);
  const desconto = Number(body.desconto || 0);
  const total = Number(body.total || (subtotal - desconto));
  const pagamentoValor = Number((body.pagamento && body.pagamento.valor) || total);

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
  const itens = (nota.itens || []).map((item) => `
    <div style="padding:6px 0;border-bottom:1px dotted #bbb;">
      <div style="font-size:13px;font-weight:700;">${esc(item.descricao)}</div>
      <div style="font-size:11px;color:#555;">${esc(item.unidade)} ${item.quantidade} x R$ ${moeda(item.valorUnitario)}</div>
      <div style="font-size:12px;font-weight:700;">R$ ${moeda(item.valorTotal)}</div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>NFC-e ${nota.numero}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;padding:16px;}
  .sheet{max-width:380px;margin:0 auto;border:1px solid #ddd;padding:14px;}
  .center{text-align:center;}
  .sep{border-top:1px dashed #000;margin:10px 0;}
  .btns{margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
  button{padding:8px 12px;border:none;border-radius:8px;background:#1a5276;color:#fff;cursor:pointer;font-weight:700}
  @media print{.btns{display:none}}
</style>
</head>
<body>
  <div class="sheet">
    <div class="center">
      <h2 style="margin:0 0 6px 0;">${esc(EMPRESA.nome_fantasia)}</h2>
      <div>${esc(EMPRESA.razao_social)}</div>
      <div>CNPJ: ${formatarCNPJ(EMPRESA.cnpj)}</div>
      <div>IE: ${esc(EMPRESA.ie)}</div>
      <div>${esc(EMPRESA.logradouro)}, ${esc(EMPRESA.numero)}</div>
      <div>${esc(EMPRESA.bairro)} - ${esc(EMPRESA.cidade)}/${esc(EMPRESA.uf)}</div>
      <div>CEP ${formatarCEP(EMPRESA.cep)} - Tel: ${formatarTelefone(EMPRESA.fone)}</div>
    </div>

    <div class="sep"></div>
    <div><strong>Número:</strong> ${nota.numero}</div>
    <div><strong>Série:</strong> ${nota.serie || 1}</div>
    <div><strong>Data:</strong> ${esc(nota.dataEmissaoBR || agoraBR())}</div>
    <div><strong>ID:</strong> ${esc(nota.id)}</div>
    <div><strong>Cliente:</strong> ${esc(nota.cliente?.nome || "CONSUMIDOR NAO IDENTIFICADO")}</div>

    <div class="sep"></div>
    ${itens || "<div>Sem itens</div>"}
    <div class="sep"></div>

    <div><strong>Subtotal:</strong> R$ ${moeda(nota.subtotal || nota.total || 0)}</div>
    <div><strong>Desconto:</strong> R$ ${moeda(nota.desconto || 0)}</div>
    <div style="font-size:18px;"><strong>Total:</strong> R$ ${moeda(nota.total || 0)}</div>
    <div><strong>Pagamento:</strong> ${esc(nota.pagamento?.tipo || "DINHEIRO")} - R$ ${moeda(nota.pagamento?.valor || nota.total || 0)}</div>

    <div class="sep"></div>
    <div><strong>Status:</strong> ${esc(nota.status || "emitida_homologacao")}</div>
    <div><strong>Chave:</strong> ${esc(nota.chave || nota.id)}</div>
    <div style="margin-top:8px;font-size:11px;">AMBIENTE DE TESTE / HOMOLOGAÇÃO</div>
  </div>

  <div class="btns">
    <button onclick="window.print()">Imprimir</button>
    <button onclick="window.close()">Fechar</button>
  </div>
</body>
</html>`;
}

// ================= ROTAS =================

app.get("/", (req, res) => {
  res.send("API Bela Modas online");
});

app.get("/health", async (req, res) => {
  const notas = await listarNotas();
  res.json({
    status: "ok",
    empresa: EMPRESA.nome_fantasia,
    total_notas: notas.length,
    proximo_numero: sequencial,
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

// emitir nota - compatível com o index atual
app.post("/nfce/emitir", async (req, res) => {
  try {
    const venda = normalizarPayload(req.body);
    const id = String(req.body.vendaId || req.body.id || venda.vendaId || `nfce-${Date.now()}`);
    const numero = sequencial++;
    const serie = 1;
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
        xml_url: nota.xml_url
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

app.get("/nfce/xml/mes/:mes", async (req, res) => {
  const mes = String(req.params.mes || "");
  const lista = (await listarNotas()).filter(n => n.mesRef === mes);

  if (!lista.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado para este mês." });
  }

  const files = lista.map(n => ({
    name: nomeArquivoXML(n),
    data: gerarXML(n),
    date: n.dataEmissaoIso || n.data || new Date().toISOString()
  }));

  const zipBuffer = makeZip(files);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${mes}.zip"`);
  res.send(zipBuffer);
});

app.get("/nfce/xml/periodo", async (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");
  const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
  const dFim = fim ? new Date(fim + "T23:59:59") : null;

  const lista = (await listarNotas()).filter(n => {
    const d = new Date(n.dataEmissaoIso || n.data);
    if (dIni && d < dIni) return false;
    if (dFim && d > dFim) return false;
    return true;
  });

  if (!lista.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado no período." });
  }

  const files = lista.map(n => ({
    name: nomeArquivoXML(n),
    data: gerarXML(n),
    date: n.dataEmissaoIso || n.data || new Date().toISOString()
  }));

  const zipBuffer = makeZip(files);
  const nome = `${inicio || "inicio"}_${fim || "fim"}`.replace(/\//g, "-");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${nome}.zip"`);
  res.send(zipBuffer);
});

// ================= START =================

ensureDirs()
  .then(carregarSequencial)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bela Caixa API rodando na porta ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Falha ao iniciar API:", err);
    process.exit(1);
  });
