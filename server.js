import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://bela-caixa-api.onrender.com";

const DATA_DIR = path.resolve("./storage");
const NOTAS_DIR = path.join(DATA_DIR, "notas");


// ================= CERTIFICADO =================

const CERT_PATH = "/etc/secrets/certificado.pfx";
const CERT_PASSWORD = process.env.CERT_PASSWORD;

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
  logradouro: "AVENIDA MEXICO",
  numero: "87",
  bairro: "PETROVALE",
  cidade: "BETIM",
  uf: "MG",
  cep: "32668052",
  fone: "31997337304"
};

let sequencial = 1;


// ================= STORAGE =================

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
    const raw = await fsp.readFile(caminhoNota(id));
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

    const raw = await fsp.readFile(path.join(NOTAS_DIR, arq));

    lista.push(JSON.parse(raw));

  }

  return lista;

}

async function carregarSequencial() {

  const notas = await listarNotas();

  const max = notas.reduce((m,n)=>Math.max(m, Number(n.numero||0)),0);

  sequencial = max + 1;

}


// ================= GERAR XML =================

function gerarXML(nota) {

return `<?xml version="1.0" encoding="UTF-8"?>

<nfce>

<emit>

<CNPJ>${EMPRESA.cnpj}</CNPJ>

<xNome>${EMPRESA.razao_social}</xNome>

</emit>

<total>

<vNF>${nota.total}</vNF>

</total>

</nfce>`;

}


// ================= GERAR CUPOM =================

function gerarHTML(nota){

return `

<html>

<body style="font-family:Arial">

<h2>BELA MODAS</h2>

<p>numero ${nota.numero}</p>

<p>valor ${nota.total}</p>

<p>teste estrutura NFCe</p>

</body>

</html>

`;

}


// ================= ROTAS =================

app.get("/",(req,res)=>{

res.send("API Bela Modas online");

});


app.get("/health", async (req,res)=>{

const notas = await listarNotas();

res.json({

status:"ok",

certificado: certificado ? true : false,

notas:notas.length,

proximoNumero:sequencial

});

});


app.get("/certificado/status",(req,res)=>{

res.json({

ok: certificado ? true:false

});

});


// emitir nota

app.post("/nfce/emitir", async (req,res)=>{

try{

const id = randomUUID();

const numero = sequencial++;

const total = Number(req.body.total || 0);


const nota = {

id,

numero,

total,

data:new Date().toISOString(),

status:"teste"

};


await salvarNota(nota);


res.json({

ok:true,

id,

numero,

pdf_url:`${BASE_URL}/nfce/${id}/pdf`,

xml_url:`${BASE_URL}/nfce/${id}/xml`

});

}catch(e){

res.status(400).json({

erro:e.message

});

}

});


// lista

app.get("/nfce/lista", async (req,res)=>{

const notas = await listarNotas();

res.json(notas);

});


// xml

app.get("/nfce/:id/xml", async (req,res)=>{

const nota = await lerNota(req.params.id);

if(!nota) return res.status(404).send("nota nao encontrada");

res.type("text/xml");

res.send(gerarXML(nota));

});


// pdf

app.get("/nfce/:id/pdf", async (req,res)=>{

const nota = await lerNota(req.params.id);

if(!nota) return res.status(404).send("nota nao encontrada");

res.send(gerarHTML(nota));

});


// ================= START =================

ensureDirs()

.then(carregarSequencial)

.then(()=>{

app.listen(PORT,()=>{

console.log("rodando",PORT);

});

});
