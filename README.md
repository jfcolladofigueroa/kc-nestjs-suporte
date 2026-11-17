# @kc-software/nestjs-suporte

Support tickets for KC Software products. Users open, answer and follow
tickets inside the product; KC answers them in its central, **kc-tickets**,
and the installation picks the answers up. Photos and PDFs travel both ways.

Companion of [`@kc-software/nestjs-auth`](https://github.com/jfcolladofigueroa/kc-nestjs-auth):
it uses its users, its JWT guard and its permission matrix.

## How it works

- **The installation keeps its own record.** Tickets, messages and
  attachments live in the product's database. If the central is down, nothing
  is lost and the screen keeps working.
- **Outbox.** Whatever a user writes is queued in `chamado_envio` by a
  trigger, in the same transaction. It is sent right away and, if that fails,
  on the next sync — in order, stopping at the first failure.
- **No background jobs.** A sync runs when the support screen opens and when
  the user presses "Atualizar": send what is pending, refresh the catalog
  (types and statuses), then apply KC's events from a cursor, one transaction
  per event.
- **The central owns the status.** The user can only mark a ticket as solved
  (a status the central flags `permiteCliente`).
- **Attachments**: only JPEG, PNG, WebP and PDF, 10 MB each, 5 per message.
  The type is decided by the content's signature, checked by the API and by
  the database. KC's attachments are downloaded on sync and their SHA-256
  checked before they are stored.
- **Local mode**: with no URL or key, tickets stay in the installation and
  users with `chamado:alterar` answer them and set the status.

## Install

```bash
npm install @kc-software/nestjs-suporte
```

Requires Node ≥ 20, PostgreSQL, TypeORM and `@kc-software/nestjs-auth` ≥ 0.3.

### 1. Schema

Copy `node_modules/@kc-software/nestjs-suporte/sql/001_kc_suporte.sql` into
your migrations, after the auth tables (the support tables reference
`auth_users`). Never edit it once applied; later versions of the library ship
`002_…`, `003_…`.

### 2. Module

```ts
@Module({
  imports: [
    TypeOrmModule.forRoot({ /* postgres */ }),
    KcAuthModule.forRoot({ /* … */ }),
    KcSuporteModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        url: c.get('KC_TICKETS_URL'),     // https://tickets.kcsoftware.com.br/api
        chave: c.get('KC_TICKETS_CHAVE'), // kct_… (the project's key in the central)
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: KcJwtAuthGuard },
    { provide: APP_GUARD, useClass: KcRolesGuard },
  ],
})
export class AppModule {}
```

### 3. Permissions

The routes are protected with `@Permissions('chamado:…')`, so add the
resource `chamado` to your permission matrix:

| verb | what it allows |
|---|---|
| `consultar` | see own tickets, answer them, mark them solved, sync |
| `incluir` | open tickets |
| `alterar` | **support**: see everyone's tickets; in local mode, set the status |

### 4. Reverse proxy

Raise the request body limit for `/api/chamados` (e.g. nginx
`client_max_body_size 55m;`): a message carries up to 5 files of 10 MB.

## API

All under `/chamados` (with your global prefix).

| | |
|---|---|
| `GET catalogo` | types for the form, `central`, `podeResolver`, `sincronizadoEm` |
| `POST sincronizar` | send pending items, refresh catalog, apply events |
| `POST /` | open a ticket — JSON, or multipart with up to 5 files in `anexos` |
| `GET /?pagina&porPagina` | own tickets (all of them for support) |
| `GET :id` | ticket, messages and attachment list (without content) |
| `GET :id/anexos/:idAnexo` | attachment content (images inline, PDF as download) |
| `POST :id/interacoes` | answer — JSON or multipart, like opening |
| `POST :id/resolver` | mark as solved |
| `PATCH :id` | set the status — local mode only (`409` with a central) |

## Auditing

Every write runs in a transaction that sets `app.current_user_id` and
`app.current_ip` with `SET LOCAL`. If your audit trigger reads them, attach it
to `chamado` and `chamado_interacao`, and to `chamado_anexo` excluding
`conteudo`.

## Restoring a backup

The central identifies tickets by the installation's ids. After restoring an
older backup, the sequences go back and new ids may collide with tickets the
central already has: it answers `409`. Move the sequences past the highest id
the central knows (`SELECT setval('chamado_id_seq', <n>)`, and the same for
`chamado_interacao_id_seq` and `chamado_anexo_id_seq`) and sync again.

## Tests

```bash
KC_SUPORTE_TEST_DB_PORT=5432 KC_SUPORTE_TEST_DB_USER=postgres KC_SUPORTE_TEST_DB_PASSWORD=… npm test
```

They create a `kc_suporte_test` database from scratch on every run, apply the
auth migrations and `sql/001_kc_suporte.sql`, and talk to a fake central.

## License

MIT
