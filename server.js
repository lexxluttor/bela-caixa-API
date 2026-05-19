
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

const gerarXML = require("./services/xml");
const gerarQRCode = require("./services/qrcode");

const PORT = process.env.PORT || 3000;

const EMPRESA = {
  nomeFantasia: "BELA MODAS",
  razaoSocial: "APARECIDA DE JESUS MIRANDA",
  cnpj: "19225338000170",
  ie: "0022589640048",
  endereco: "AVENIDA MEXICO, 87 - PETROVALE",
  cidade: "BETIM/MG",
  cep: "32668-052",
  telefone: "(31) 99733-7304"
};

app.get("/", (req, res) => {
  res.send("API NFC-e Bela Modas");
});

app.post("/nfce", async (req, res) => {

  const venda = req.body;

  const xml = gerarXML(venda);

  const chave = "31260519225338000170650010000000261000002600";

  const qrCode = gerarQRCode(chave);

  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
  <head>
    <meta charset="UTF-8">
    <title>DANFE NFC-e</title>
    <link rel="stylesheet" href="/public/danfe.css">
  </head>
  <body>

    <div class="danfe">

      <div class="topo">
        <div class="empresa">
          <h1>${EMPRESA.nomeFantasia}</h1>
          <h2>${EMPRESA.razaoSocial}</h2>

          <p>CNPJ: 19.225.338/0001-70 &nbsp;&nbsp; IE: 0022589640048</p>
          <p>AVENIDA MEXICO, 87 - PETROVALE</p>
          <p>BETIM/MG - CEP: 32668-052</p>
          <p>Tel: (31) 99733-7304</p>
        </div>

        <div class="nfce-box">
          <div>NFC-e</div>
          <div class="numero">Nº ${venda.numero || 1}</div>
          <div>SÉRIE: 1</div>
          <div class="emissao">EMISSÃO:<br>${new Date().toLocaleString("pt-BR")}</div>
          <div>VIA CONSUMIDOR</div>
        </div>
      </div>

      <div class="barra">
        DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica
      </div>

      <div class="cliente">
        Cliente: ${venda.cliente || "Balcão"}
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
          ${(venda.itens || []).map(item => `
            <tr>
              <td>${item.codigo}</td>
              <td>${item.descricao}</td>
              <td>${item.qtd}</td>
              <td>${item.valor}</td>
              <td>${(item.qtd * item.valor).toFixed(2)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>

      <div class="totais">
        <div>
          <p>QTD. ITENS</p>
          <p>SUBTOTAL</p>
          <p>DESCONTO</p>

          <div class="total-final">
            TOTAL R$ ${(venda.total || 0).toFixed(2)}
          </div>
        </div>

        <div class="pagamento">
          <div class="box">
            <strong>FORMA DE PAGAMENTO</strong>
            <p>${venda.pagamento || "DINHEIRO"}</p>
          </div>

          <div class="box">
            <strong>VALOR PAGO</strong>
            <p>R$ ${(venda.total || 0).toFixed(2)}</p>
          </div>
        </div>
      </div>

      <div class="tributos">
        <strong>INFORMAÇÕES DOS TRIBUTOS</strong>
        <p>Tributos Totais (Lei Federal 12.741/2012)</p>
      </div>

      <div class="simples">
        DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL
      </div>

      <div class="rodape-info">
        <div>
          <p>Status: HOMOLOGAÇÃO</p>
          <p>Chave de Acesso:</p>
          <div class="chave">${chave}</div>
        </div>
      </div>

      <div class="qrcode">
        <img src="${qrCode}" width="150">
      </div>

      <div class="mensagem">
        Obrigado pela preferência!<br>
        Volte sempre!
      </div>

    </div>

  </body>
  </html>
  `;

  res.send(html);
});

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
