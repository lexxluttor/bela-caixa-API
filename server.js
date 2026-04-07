import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import zlib from "zlib";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://bela-caixa-api.onrender.com";

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

const notas = new Map();
let sequencial = 1;

function somenteDigitos(v = "") { return String(v || "").replace(/\D+/g, ""); }
function dinheiro(v) { return Number(v || 0).toFixed(2); }
function dataMesRef(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, "0")}`;
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
    vendaId: String(body.vendaId || body.id || randomUUID()),
    dataVenda: body.dataVenda || new Date().toISOString(),
    cliente: {
      nome: String((body.cliente && body.cliente.nome) || "CONSUMIDOR NAO IDENTIFICADO"),
      cpf: somenteDigitos((body.cliente && body.cliente.cpf) || "")
    },
    itens, subtotal, desconto, total,
    pagamento: {
      tipo: String((body.pagamento && body.pagamento.tipo) || "dinheiro").toUpperCase(),
      valor: pagamentoValor
    }
  };
}

function gerarCupomHTML(nota) {
  const linhas = nota.itens.map((item, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong>${item.descricao}</strong><br><small>Cód: ${item.codigo || "-"} | NCM: ${item.ncm} | CFOP: ${item.cfop} | CSOSN: ${item.csosn}</small></td>
      <td>${item.unidade}</td>
      <td style="text-align:right">${item.quantidade}</td>
      <td style="text-align:right">R$ ${dinheiro(item.valorUnitario)}</td>
      <td style="text-align:right">R$ ${dinheiro(item.valorTotal)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>NFC-e ${nota.numero}</title>
<style>
body{font-family:Arial,sans-serif;padding:20px;color:#111} .wrap{max-width:820px;margin:0 auto}
h1,h2,p{margin:0 0 8px} .topo{border-bottom:2px dashed #333;padding-bottom:12px;margin-bottom:12px}
.box{border-top:1px dashed #333;padding-top:12px;margin-top:12px} table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:8px 6px;border-bottom:1px solid #ddd;vertical-align:top} th{text-align:left;background:#f2f2f2}
.t-right{text-align:right} small{color:#555} .total{font-size:20px;font-weight:700}
</style></head><body>
<div class="wrap">
<div class="topo">
<h1>${EMPRESA.nome_fantasia}</h1>
<p>${EMPRESA.razao_social}</p>
<p>CNPJ: ${formatarCNPJ(EMPRESA.cnpj)} | IE: ${EMPRESA.ie} | CRT: ${EMPRESA.crt} - ${EMPRESA.regime}</p>
<p>${EMPRESA.logradouro}, ${EMPRESA.numero} - ${EMPRESA.bairro} - ${EMPRESA.cidade}/${EMPRESA.uf} - CEP ${formatarCEP(EMPRESA.cep)}</p>
<p>Telefone: ${formatarTelefone(EMPRESA.fone)}</p>
</div>
<h2>NFC-e EM ESTRUTURA DE TESTE</h2>
<p><strong>Número:</strong> ${nota.numero} | <strong>Série:</strong> ${nota.serie} | <strong>Data:</strong> ${nota.dataEmissaoBR}</p>
<p><strong>ID interno:</strong> ${nota.id}</p>
<p><strong>Cliente:</strong> ${nota.cliente && nota.cliente.cpf ? nota.cliente.nome + " - CPF " + nota.cliente.cpf : "CONSUMIDOR NAO IDENTIFICADO"}</p>
<div class="box">
<table><thead><tr><th>#</th><th>Produto</th><th>UN</th><th class="t-right">Qtd</th><th class="t-right">Vl Unit</th><th class="t-right">Total</th></tr></thead><tbody>${linhas}</tbody></table>
</div>
<div class="box">
<p class="t-right"><strong>Subtotal:</strong> R$ ${dinheiro(nota.subtotal)}</p>
<p class="t-right"><strong>Desconto:</strong> R$ ${dinheiro(nota.desconto)}</p>
<p class="t-right total">TOTAL: R$ ${dinheiro(nota.total)}</p>
<p class="t-right"><strong>Pagamento:</strong> ${nota.pagamento.tipo} - R$ ${dinheiro(nota.pagamento.valor)}</p>
</div>
<div class="box">
<p><strong>Status:</strong> ${nota.status}</p>
<p><strong>Chave (pré-estrutura):</strong> ${nota.chave}</p>
<p><strong>Ambiente:</strong> HOMOLOGAÇÃO / ESTRUTURA</p>
<p><strong>Observação:</strong> pendente apenas certificado A1 e conexão com SEFAZ.</p>
</div>
</div></body></html>`;
}

function gerarXML(nota) {
  const itensXml = nota.itens.map((item, idx) => `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${item.codigo || idx + 1}</cProd>
        <cEAN>${item.ean || "SEM GTIN"}</cEAN>
        <xProd>${item.descricao}</xProd>
        <NCM>${item.ncm}</NCM>
        <CFOP>${item.cfop}</CFOP>
        <uCom>${item.unidade}</uCom>
        <qCom>${item.quantidade}</qCom>
        <vUnCom>${dinheiro(item.valorUnitario)}</vUnCom>
        <vProd>${dinheiro(item.valorTotal)}</vProd>
      </prod>
      <imposto><ICMS><ICMSSN102><orig>${item.origem}</orig><CSOSN>${item.csosn}</CSOSN></ICMSSN102></ICMS></imposto>
    </det>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfce>
  <ide><cNF>${nota.numero}</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>65</mod><serie>${nota.serie}</serie><nNF>${nota.numero}</nNF><dhEmi>${nota.dataEmissaoIso}</dhEmi><tpNF>1</tpNF><tpAmb>2</tpAmb></ide>
  <emit><CNPJ>${EMPRESA.cnpj}</CNPJ><xNome>${EMPRESA.razao_social}</xNome><xFant>${EMPRESA.nome_fantasia}</xFant><IE>${EMPRESA.ie}</IE><CRT>${EMPRESA.crt}</CRT>
    <enderEmit><xLgr>${EMPRESA.logradouro}</xLgr><nro>${EMPRESA.numero}</nro><xBairro>${EMPRESA.bairro}</xBairro><cMun>3106705</cMun><xMun>${EMPRESA.cidade}</xMun><UF>${EMPRESA.uf}</UF><CEP>${EMPRESA.cep}</CEP><cPais>1058</cPais><xPais>${EMPRESA.pais}</xPais><fone>${EMPRESA.fone}</fone></enderEmit>
  </emit>
  <dest><xNome>${nota.cliente.nome}</xNome><CPF>${nota.cliente.cpf || ""}</CPF></dest>
  ${itensXml}
  <total><ICMSTot><vProd>${dinheiro(nota.subtotal)}</vProd><vDesc>${dinheiro(nota.desconto)}</vDesc><vNF>${dinheiro(nota.total)}</vNF></ICMSTot></total>
  <pag><detPag><tPag>${nota.pagamento.tipo}</tPag><vPag>${dinheiro(nota.pagamento.valor)}</vPag></detPag></pag>
  <infAdic><infCpl>ESTRUTURA DE TESTE BELA MODAS - PENDENTE CERTIFICADO A1 E CONEXAO SEFAZ.</infCpl></infAdic>
</nfce>`;
}

function nomeArquivoXML(nota) {
  const serie = String(nota.serie).padStart(3, "0");
  const numero = String(nota.numero).padStart(9, "0");
  return `${EMPRESA.cnpj}65${serie}${numero}.xml`;
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}
const CRC_TABLE = (() => {
  let c; const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
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
  const locals = [], centrals = []; let offset = 0;
  files.forEach(file => {
    const nameBuf = Buffer.from(file.name, "utf8");
    const dataBuf = Buffer.from(file.data, "utf8");
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = crc32(dataBuf);
    const { dosTime, dosDate } = dosDateTime(file.date || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  });

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

app.get("/", (req, res) => res.send("API Bela Modas rodando"));
app.get("/health", (req, res) => res.json({ status: "ok", empresa: EMPRESA.nome_fantasia }));
app.get("/empresa", (req, res) => res.json(EMPRESA));

app.post("/nfce/emitir", (req, res) => {
  try {
    const venda = normalizarPayload(req.body);
    const id = randomUUID();
    const numero = sequencial++;
    const serie = 1;
    const dataEmissaoIso = new Date().toISOString();
    const nota = {
      ...venda, id, numero, serie, dataEmissaoIso,
      dataEmissaoBR: agoraBR(),
      mesRef: dataMesRef(dataEmissaoIso),
      status: "estrutura_pronta_pendente_certificado_e_sefaz",
      chave: `PRE-${String(numero).padStart(6, "0")}-${id.slice(0, 8).toUpperCase()}`
    };
    nota.pdf_url = `${BASE_URL}/nfce/${id}/pdf`;
    nota.xml_url = `${BASE_URL}/nfce/${id}/xml`;
    notas.set(id, nota);
    res.json({ ok: true, mensagem: "NFC-e estruturada com sucesso.", nfce: {
      id: nota.id, numero: nota.numero, serie: nota.serie, chave: nota.chave, status: nota.status,
      pdf_url: nota.pdf_url, xml_url: nota.xml_url
    }});
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Erro ao estruturar NFC-e." });
  }
});

app.get("/nfce/:id", (req, res) => {
  const nota = notas.get(req.params.id);
  if (!nota) return res.status(404).json({ ok: false, error: "Nota não encontrada." });
  res.json({ ok: true, nfce: nota });
});
app.get("/nfce/:id/pdf", (req, res) => {
  const nota = notas.get(req.params.id);
  if (!nota) return res.status(404).send("Nota não encontrada.");
  res.type("html").send(gerarCupomHTML(nota));
});
app.get("/nfce/:id/xml", (req, res) => {
  const nota = notas.get(req.params.id);
  if (!nota) return res.status(404).type("text/xml").send("<erro>Nota não encontrada</erro>");
  res.type("text/xml").send(gerarXML(nota));
});
app.get("/nfce/xml/mes/:mes", (req, res) => {
  const mes = String(req.params.mes || "");
  const lista = [...notas.values()].filter(n => n.mesRef === mes);
  if (!lista.length) return res.status(404).json({ ok: false, error: "Nenhum XML encontrado para este mês." });
  const files = lista.map(n => ({ name: nomeArquivoXML(n), data: gerarXML(n), date: n.dataEmissaoIso }));
  const zipBuffer = makeZip(files);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${mes}.zip"`);
  res.send(zipBuffer);
});
app.get("/nfce/xml/periodo", (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");
  const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
  const dFim = fim ? new Date(fim + "T23:59:59") : null;
  const lista = [...notas.values()].filter(n => {
    const d = new Date(n.dataEmissaoIso);
    if (dIni && d < dIni) return false;
    if (dFim && d > dFim) return false;
    return true;
  });
  if (!lista.length) return res.status(404).json({ ok: false, error: "Nenhum XML encontrado no período." });
  const files = lista.map(n => ({ name: nomeArquivoXML(n), data: gerarXML(n), date: n.dataEmissaoIso }));
  const zipBuffer = makeZip(files);
  const nome = `${inicio || "inicio"}_${fim || "fim"}`.replace(/\//g, "-");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${nome}.zip"`);
  res.send(zipBuffer);
});
app.get("/nfce/lista", (req, res) => {
  const notasResumo = [...notas.values()].map(n => ({
    id: n.id, numero: n.numero, serie: n.serie, data: n.dataEmissaoIso, total: n.total,
    cliente: n.cliente.nome, status: n.status, xml_url: n.xml_url, pdf_url: n.pdf_url, mesRef: n.mesRef
  }));
  res.json({ ok: true, total: notasResumo.length, notas: notasResumo });
});

app.listen(PORT, () => console.log(`Bela Caixa API rodando na porta ${PORT}`));
