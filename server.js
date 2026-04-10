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

const DATA_DIR = path.resolve("./storage");
const NOTAS_DIR = path.join(DATA_DIR, "notas");

const CERT_PATH = "/etc/secrets/certificado.pfx";
const CERT_PASSWORD = process.env.CERT_PASSWORD || "";

let certificado = null;

try {
  certificado = fs.readFileSync(CERT_PATH);
  console.log("✔ certificado carregado");
} catch {
  console.log("⚠ certificado não encontrado");
}

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

function agoraBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo"
  }).format(new Date());
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function ensureDirs() {
  await fsp.mkdir(NOTAS_DIR, { recursive: true });
}

function caminhoNota(id) {
  return path.join(NOTAS_DIR, `${id}.json`);
}

async function salvarNota(nota) {
  await ensureDirs();
  await fsp.writeFile(caminhoNota(nota.id), JSON.stringify(nota, null, 2));
}

async function lerNota(id) {
  try {
    return JSON.parse(await fsp.readFile(caminhoNota(id)));
  } catch {
    return null;
  }
}

async function listarNotas() {
  await ensureDirs();
  const arquivos = await fsp.readdir(NOTAS_DIR);

  const lista = [];

  for (const a of arquivos) {
    if (!a.endsWith(".json")) continue;
    try {
      lista.push(JSON.parse(await fsp.readFile(path.join(NOTAS_DIR, a))));
    } catch {}
  }

  lista.sort((a, b) =>
    new Date(a.dataEmissaoIso) - new Date(b.dataEmissaoIso)
  );

  return lista;
}

async function carregarSequencial() {
  const notas = await listarNotas();

  const max = notas.reduce(
    (m, n) => Math.max(m, Number(n.numero || 0)),
    0
  );

  sequencial = max + 1;
}

function obterProdutoFiscal(item = {}) {

  const qtd = Number(item.qtd ?? item.quantidade ?? item.qty ?? 1);

  const valorUnitario = Number(
    item.valorUnitario ?? item.preco ?? item.valor ?? 0
  );

  const valorTotal = Number(
    item.valorTotal ?? qtd * valorUnitario
  );

  return {

    codigo:
      String(item.cod || item.codigo || item.ref || item.id || ""),

    ean:
      String(
        item.ean ||
        item.codigo_barras ||
        item.codBarras ||
        item.codigoDeBarras ||
        ""
      ),

    descricao:
      String(item.descricao || item.nome || item.desc || "PRODUTO"),

    ncm:
      String(item.ncm || "00000000"),

    cfop:
      String(item.cfop || "5102"),

    csosn:
      String(item.csosn || "102"),

    unidade:
      String(item.unidade || "UN"),

    origem:
      String(item.origem || "0"),

    quantidade: qtd,

    valorUnitario,

    valorTotal
  };
}

function normalizarPayload(body = {}) {

  const itens =
    (Array.isArray(body.itens) ? body.itens : [])
      .map(obterProdutoFiscal);

  const subtotal =
    itens.reduce(
      (s, i) => s + Number(i.valorTotal),
      0
    );

  const desconto =
    Number(body.desconto || 0);

  const total =
    subtotal - desconto;

  return {

    vendaId:
      String(body.vendaId || `nf-${Date.now()}`),

    cliente: {
      nome:
        String(body.cliente?.nome || "CONSUMIDOR"),
      cpf:
        somenteDigitos(body.cliente?.cpf || "")
    },

    itens,

    subtotal,

    desconto,

    total,

    pagamento: {
      tipo:
        String(
          body.pagamento?.tipo ||
          body.forma_pagamento ||
          "DINHEIRO"
        ).toUpperCase(),

      valor:
        Number(body.pagamento?.valor || total)
    }
  };
}

function gerarXML(nota) {

  const itensXml =
    (nota.itens || [])
      .map((item, idx) => `
<det nItem="${idx + 1}">
<prod>

<cProd>${esc(item.codigo)}</cProd>

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

  return `<?xml version="1.0"?>

<nfce>

${itensXml}

</nfce>`;
}

function gerarHTML(nota) {

const itens =
(nota.itens || [])
.map(item => {

const codigo =
item.ean || item.codigo || "-";

return `

<tr>

<td class="cod">${esc(codigo)}</td>

<td class="desc">${esc(item.descricao)}</td>

<td class="qtd">${item.quantidade}</td>

<td class="unit">${moeda(item.valorUnitario)}</td>

<td class="total">${moeda(item.valorTotal)}</td>

</tr>

`;

}).join("");

return `

<html>

<style>

body{

font-family: monospace;

}

table{

width:100%;

table-layout:fixed;

font-size:12px;

}

.cod{

width:70px;

}

.desc{

width:120px;

}

.qtd{

width:25px;

text-align:center;

}

.unit{

width:40px;

text-align:right;

}

.total{

width:45px;

text-align:right;

font-weight:bold;

}

</style>

<table>

<tr>

<th>Cód</th>

<th>Descrição</th>

<th>Qtd</th>

<th>Unit</th>

<th>Total</th>

</tr>

${itens}

</table>

`;

}

app.post("/nfce/emitir", async (req, res) => {

const venda =
normalizarPayload(req.body);

const id =
String(req.body.vendaId || Date.now());

const numero =
sequencial++;

const nota = {

...venda,

id,

numero,

serie:1,

dataEmissaoIso:
new Date().toISOString(),

dataEmissaoBR:
agoraBR(),

status:
"emitida_homologacao",

chave:id

};

await salvarNota(nota);

res.json({

ok:true,

nfce:{

id,

numero,

xml_url:
`${BASE_URL}/nfce/${id}/xml`,

pdf_url:
`${BASE_URL}/nfce/${id}/pdf`

}

});

});

app.get("/nfce/:id/xml",
async (req,res)=>{

const nota =
await lerNota(req.params.id);

res.type("text/xml")
.send(gerarXML(nota));

});

app.get("/nfce/:id/pdf",
async (req,res)=>{

const nota =
await lerNota(req.params.id);

res.send(
gerarHTML(nota)
);

});

ensureDirs()
.then(carregarSequencial)
.then(()=>{

app.listen(PORT,
()=>console.log("API rodando"));

});
