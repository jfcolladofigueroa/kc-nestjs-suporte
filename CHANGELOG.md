# Changelog

## 0.1.0 — 2026-11-17

First version, extracted from almoxarifado (migrations 014, 016 and 017 and
its `chamado` module).

- `KcSuporteModule.forRoot` / `forRootAsync`: tickets answered in the KC
  central (kc-tickets), or locally when no central is configured.
- Outbox `chamado_envio` filled by triggers; sync on demand with an event
  cursor, one transaction per event.
- Photo and PDF attachments both ways: JPEG, PNG, WebP and PDF, 10 MB, 5 per
  message, type checked by content signature in the API and the database;
  KC attachments verified by SHA-256.
- Schema in `sql/001_kc_suporte.sql`.
