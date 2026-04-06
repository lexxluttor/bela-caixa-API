
import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("API Bela Modas rodando");
});

app.get("/health",(req,res)=>{
  res.json({status:"ok"});
});

app.post("/nfce/emitir",(req,res)=>{

  const venda = req.body;

  const id = uuid();

  res.json({
    ok:true,
    mensagem:"NFC-e gerada em modo teste",
    nfce:{
      id:id,
      numero: Math.floor(Math.random()*9999),
      chave: uuid().replace(/-/g,""),
      status:"emitida_homologacao",
      pdf_url:`https://bela-caixa-api.onrender.com/nfce/${id}/pdf`,
      xml_url:`https://bela-caixa-api.onrender.com/nfce/${id}/xml`
    }
  });

});

app.get("/nfce/:id/pdf",(req,res)=>{
  res.send(`
    <h1>Bela Modas</h1>
    <h2>NFC-e TESTE</h2>
    <p>ID: ${req.params.id}</p>
  `);
});

app.get("/nfce/:id/xml",(req,res)=>{
  res.type("text/xml");

  res.send(`
  <nfce>
    <empresa>Bela Modas</empresa>
    <id>${req.params.id}</id>
    <status>teste</status>
  </nfce>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>console.log("API rodando na porta "+PORT));
