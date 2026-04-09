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
const CERT_PASSWORD = process.env.CERT_PASSWORD;

let certificadoBuffer = null;

try {
  certificadoBuffer = fs.readFileSync(CERT_PATH);
  console.log("✔ Certificado A1 carregado");
} catch (err) {
  console.log("⚠ Certificado ainda não encontrado");
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


// ================= FUNÇÕES AUX =================

function somenteDigitos(v = "") {
  return String(v || "").replace(/\D+/g, "");
}

function dinheiro(v) {
  return Number(v || 0).toFixed(2);
}

function agoraBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo"
  }).format(new Date());
}

function dataMesRef(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, "0")}`;
}


// ================= STORAGE =================

async function ensureDataDirs() {
  await fsp.mkdir(NOTAS_DIR, { recursive: true });
}

function notaPath(id) {
  return path.join(NOTAS_DIR, `${id}.json`);
}

async function salvarNota(nota) {
  await ensureDataDirs();
  await fsp.writeFile(notaPath(nota.id), JSON.stringify(nota, null, 2));
}

async function lerNota(id) {
  try {
    const raw = await fsp.readFile(notaPath(id));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listarNotas() {
  await ensureDataDirs();

  const files = await fsp.readdir(NOTAS_DIR);

  const lista = [];

  for (const f of files) {

    if (!f.endsWith(".json")) continue;

    const raw = await fsp.readFile(path.join(NOTAS_DIR, f));

    lista.push(JSON.parse(raw));
  }

  return lista;
}

async function carregarSequencial() {

  const notas = await listarNotas();

  const max = notas.reduce((m,n)=>Math.max(m, Number(n.numero||0)),0);

  sequencial = max + 1;

}


// ================= NORMALIZAR VENDA =================

function normalizarPayload(body = {}) {

  const itens = (body.itens || []).map(i => ({

    codigo: i.codigo || i.id || "1",

    descricao: i.nome || "PRODUTO",

    quantidade: Number(i.quantidade || 1),

    valorUnitario: Number(i.valorUnitario || i.preco || 0),

    valorTotal: Number(i.valorTotal || (i.quantidade * i.valorUnitario))

  }));


  const subtotal = itens.reduce((s,i)=>s+i.valorTotal,0);

  const total = Number(body.total || subtotal);


  return {

    vendaId: body.vendaId || randomUUID(),

    cliente: {

      nome: body.cliente?.nome || "CONSUMIDOR",

      cpf: somenteDigitos(body.cliente?.cpf)

    },

    itens,

    subtotal,

    desconto: Number(body.desconto || 0),

    total,

    pagamento: {

      tipo: body.pagamento?.tipo || "DINHEIRO",

      valor: total

    }

  };

}


// ================= XML =================

function gerarXML(nota) {

return `<?xml version="1.0" encoding="UTF-8"?>

<nfce>

<emit>

<CNPJ>${EMPRESA.cnpj}</CNPJ>

<xNome>${EMPRESA.razao_social}</xNome>

</emit>

<total>

<vNF>${dinheiro(nota.total)}</vNF>

</total>

</nfce>`;

}


// ================= ROTAS =================

app.get("/", (req,res)=>{

res.send("API Bela Modas online");

});


app.get("/health", async (req,res)=>{

const notas = await listarNotas();

res.json({

status:"ok",

certificado: certificadoBuffer ? true : false,

notas: notas.length,

proximoNumero: sequencial

});

});


// emitir estrutura

app.post("/nfce/emitir", async (req,res)=>{

try{

const venda = normalizarPayload(req.body);

const id = randomUUID();

const numero = sequencial++;

const nota = {

...venda,

id,

numero,

serie:1,

dataEmissaoIso: new Date().toISOString(),

dataEmissaoBR: agoraBR(),

mesRef: dataMesRef(),

status:"estrutura_pronta",

chave:`TESTE-${numero}`

};

await salvarNota(nota);

res.json({

ok:true,

id:nota.id,

numero:nota.numero,

xml_url:`${BASE_URL}/nfce/${id}/xml`

});

}catch(e){

res.status(400).json({

ok:false,

erro:e.message

});

}

});


// xml

app.get("/nfce/:id/xml", async (req,res)=>{

const nota = await lerNota(req.params.id);

if(!nota) return res.status(404).send("não encontrada");

res.type("text/xml");

res.send(gerarXML(nota));

});


// testar certificado

app.get("/certificado/status",(req,res)=>{

if(certificadoBuffer){

res.json({

ok:true,

mensagem:"certificado carregado"

});

}else{

res.json({

ok:false,

mensagem:"certificado não encontrado"

});

}

});


// ================= START =================

ensureDataDirs()

.then(carregarSequencial)

.then(()=>{

app.listen(PORT,()=>{

console.log("API rodando porta",PORT);

});

});
