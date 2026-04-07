# Bela Caixa API

Estrutura de NFC-e da Bela Modas pronta.

## Status atual
- Cupom visual estruturado
- XML estruturado
- Exportação de XML por mês
- Exportação de XML por período

## Rotas úteis
- GET /health
- POST /nfce/emitir
- GET /nfce/:id/pdf
- GET /nfce/:id/xml
- GET /nfce/xml/mes/AAAA-MM
- GET /nfce/xml/periodo?inicio=AAAA-MM-DD&fim=AAAA-MM-DD
- GET /nfce/lista

## Pendências
- certificado A1
- conexão com SEFAZ
