-- @kc-software/nestjs-suporte — schema, version 1.
--
-- Copy this file into your application's migrations (e.g.
-- `database/migrations/NNN_kc_suporte.sql`) AFTER the auth tables exist: the
-- support tables reference `auth_users(id)`. PostgreSQL only.
--
-- What it creates:
--   chamado            the ticket, with its protocol number (yearly prefix + sequence)
--   chamado_interacao  messages; insert-only
--   chamado_anexo      photos and PDFs (bytea); insert-only
--   chamado_envio      outbox of what still has to reach the KC central,
--                      filled by triggers in the SAME transaction as the fact
--   central_suporte    one row: event cursor and the central's catalog
--
-- Auditing: the module runs every write inside a transaction that sets
-- `app.current_user_id` and `app.current_ip` (SET LOCAL). If your application
-- has an audit trigger that reads them, attach it to these tables in your own
-- migration — leaving `conteudo` out of `chamado_anexo`'s log.

-- ── Ticket ──────────────────────────────────────────────────────────────
CREATE SEQUENCE chamado_protocolo_seq;

CREATE TABLE chamado (
  id                   BIGSERIAL PRIMARY KEY,
  protocolo            TEXT NOT NULL UNIQUE DEFAULT
    to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY') || '/' ||
    lpad(nextval('chamado_protocolo_seq')::text, 8, '0'),
  id_solicitante       INTEGER NOT NULL REFERENCES auth_users(id),
  titulo               VARCHAR(200) NOT NULL CHECK (length(trim(titulo)) > 0),
  descricao            TEXT NOT NULL CHECK (length(trim(descricao)) > 0),
  -- Status as dictated by the central (code + how to show it).
  situacao             VARCHAR(30) NOT NULL DEFAULT 'ABERTO'
                       CONSTRAINT ck_chamado_situacao_codigo CHECK (situacao ~ '^[A-Z0-9_]+$'),
  situacao_nome        VARCHAR(80) NOT NULL DEFAULT 'Aberto',
  situacao_categoria   VARCHAR(20) NOT NULL DEFAULT 'INICIAL'
                       CHECK (situacao_categoria IN ('INICIAL', 'EM_ANDAMENTO', 'AGUARDANDO_CLIENTE', 'FINAL')),
  situacao_cor         VARCHAR(10) NOT NULL DEFAULT 'info'
                       CHECK (situacao_cor IN ('info', 'warn', 'good', 'bad', 'neutral')),
  tipo                 VARCHAR(40) CHECK (tipo ~ '^[A-Z0-9_]+$'),
  tipo_nome            VARCHAR(80),
  aberto_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  primeira_resposta_em TIMESTAMPTZ,
  resolvido_em         TIMESTAMPTZ
);
CREATE INDEX ix_chamado_solicitante ON chamado (id_solicitante, aberto_em DESC);

-- ── Messages: a local user OR an author from the central, never both ─────
CREATE TABLE chamado_interacao (
  id            BIGSERIAL PRIMARY KEY,
  id_chamado    BIGINT NOT NULL REFERENCES chamado(id),
  id_usuario    INTEGER REFERENCES auth_users(id),
  autor_externo VARCHAR(160),
  -- Id of the reply in the central: applying an event twice does not duplicate it.
  id_central    BIGINT UNIQUE,
  mensagem      TEXT NOT NULL CHECK (length(trim(mensagem)) > 0),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_interacao_autor CHECK (
    (id_usuario IS NOT NULL AND autor_externo IS NULL AND id_central IS NULL)
    OR (id_usuario IS NULL AND autor_externo IS NOT NULL AND id_central IS NOT NULL)
  ),
  CONSTRAINT uq_chamado_interacao_chamado UNIQUE (id_chamado, id)
);
CREATE INDEX ix_chamado_interacao ON chamado_interacao (id_chamado, id);

CREATE FUNCTION kc_suporte_imutavel() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% é só de inserção: % recusado', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tg_chamado_interacao_imutavel BEFORE UPDATE OR DELETE ON chamado_interacao
  FOR EACH ROW EXECUTE FUNCTION kc_suporte_imutavel();

-- ── Attachments: only JPEG, PNG, WebP and PDF; 10 MB; 5 per message ──────
-- The type is decided by the content's signature, checked here.
CREATE FUNCTION fn_assinatura_confere(tipo VARCHAR, conteudo BYTEA) RETURNS BOOLEAN AS $$
  SELECT CASE tipo
    WHEN 'image/jpeg'      THEN substring(conteudo FROM 1 FOR 3) = '\xffd8ff'::bytea
    WHEN 'image/png'       THEN substring(conteudo FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea
    WHEN 'image/webp'      THEN substring(conteudo FROM 1 FOR 4) = '\x52494646'::bytea
                            AND substring(conteudo FROM 9 FOR 4) = '\x57454250'::bytea
    WHEN 'application/pdf' THEN substring(conteudo FROM 1 FOR 5) = '\x255044462d'::bytea
    ELSE FALSE
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE chamado_anexo (
  id           BIGSERIAL PRIMARY KEY,
  id_chamado   BIGINT       NOT NULL REFERENCES chamado(id),
  -- NULL = attached when the ticket was opened.
  id_interacao BIGINT,
  id_usuario   INTEGER      REFERENCES auth_users(id),
  id_central   BIGINT       UNIQUE,
  nome         VARCHAR(200) NOT NULL CHECK (length(trim(nome)) > 0),
  tipo_mime    VARCHAR(40)  NOT NULL
               CHECK (tipo_mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  tamanho      INTEGER      NOT NULL CHECK (tamanho > 0 AND tamanho <= 10485760),
  sha256       CHAR(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  conteudo     BYTEA        NOT NULL,
  criado_em    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (octet_length(conteudo) = tamanho),
  CHECK (fn_assinatura_confere(tipo_mime, conteudo)),
  CONSTRAINT ck_anexo_autor CHECK (
    (id_usuario IS NOT NULL AND id_central IS NULL)
    OR (id_usuario IS NULL AND id_central IS NOT NULL AND id_interacao IS NOT NULL)
  ),
  FOREIGN KEY (id_chamado, id_interacao) REFERENCES chamado_interacao (id_chamado, id)
);
CREATE INDEX ix_chamado_anexo ON chamado_anexo (id_chamado, id);

CREATE TRIGGER tg_chamado_anexo_imutavel BEFORE UPDATE OR DELETE ON chamado_anexo
  FOR EACH ROW EXECUTE FUNCTION kc_suporte_imutavel();

-- Same side as its message, and at most 5 per message.
CREATE FUNCTION fn_chamado_anexo_regras() RETURNS TRIGGER AS $$
DECLARE
  v_local BOOLEAN;
  v_total INTEGER;
BEGIN
  IF NEW.id_interacao IS NOT NULL THEN
    SELECT id_usuario IS NOT NULL INTO v_local FROM chamado_interacao WHERE id = NEW.id_interacao;
    IF v_local IS DISTINCT FROM (NEW.id_usuario IS NOT NULL) THEN
      RAISE EXCEPTION 'O anexo e a mensagem têm de ser do mesmo lado'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM 1 FROM chamado WHERE id = NEW.id_chamado FOR UPDATE;
  SELECT COUNT(*) INTO v_total FROM chamado_anexo
   WHERE id_chamado = NEW.id_chamado AND id_interacao IS NOT DISTINCT FROM NEW.id_interacao;
  IF v_total >= 5 THEN
    RAISE EXCEPTION 'No máximo 5 anexos por mensagem' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER tg_chamado_anexo_regras BEFORE INSERT ON chamado_anexo
  FOR EACH ROW EXECUTE FUNCTION fn_chamado_anexo_regras();

-- ── Outbox to the central ────────────────────────────────────────────────
CREATE TABLE chamado_envio (
  id            BIGSERIAL PRIMARY KEY,
  tipo          VARCHAR(10) NOT NULL
                CONSTRAINT chamado_envio_tipo_check
                CHECK (tipo IN ('CHAMADO', 'INTERACAO', 'SITUACAO', 'ANEXO')),
  id_chamado    BIGINT      NOT NULL REFERENCES chamado(id),
  id_interacao  BIGINT      REFERENCES chamado_interacao(id),
  id_anexo      BIGINT      REFERENCES chamado_anexo(id),
  -- SITUACAO only: the code the user set, and who.
  situacao      VARCHAR(40),
  id_usuario    INTEGER     REFERENCES auth_users(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em    TIMESTAMPTZ,
  tentativas    INTEGER     NOT NULL DEFAULT 0,
  ultimo_erro   TEXT,
  CHECK ((tipo = 'INTERACAO') = (id_interacao IS NOT NULL)),
  CHECK ((tipo = 'SITUACAO') = (situacao IS NOT NULL AND id_usuario IS NOT NULL)),
  CONSTRAINT ck_envio_anexo CHECK ((tipo = 'ANEXO') = (id_anexo IS NOT NULL))
);
CREATE INDEX ix_chamado_envio_pendente ON chamado_envio (id) WHERE enviado_em IS NULL;

CREATE FUNCTION fn_chamado_envio() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'chamado' THEN
    INSERT INTO chamado_envio (tipo, id_chamado) VALUES ('CHAMADO', NEW.id);
  ELSIF NEW.id_usuario IS NOT NULL THEN
    -- Only what the installation writes. What comes from the central is already there.
    INSERT INTO chamado_envio (tipo, id_chamado, id_interacao)
    VALUES ('INTERACAO', NEW.id_chamado, NEW.id);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER tg_chamado_envio AFTER INSERT ON chamado
  FOR EACH ROW EXECUTE FUNCTION fn_chamado_envio();
CREATE TRIGGER tg_chamado_interacao_envio AFTER INSERT ON chamado_interacao
  FOR EACH ROW EXECUTE FUNCTION fn_chamado_envio();

CREATE FUNCTION fn_chamado_anexo_envio() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id_usuario IS NOT NULL THEN
    INSERT INTO chamado_envio (tipo, id_chamado, id_anexo) VALUES ('ANEXO', NEW.id_chamado, NEW.id);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER tg_chamado_anexo_envio AFTER INSERT ON chamado_anexo
  FOR EACH ROW EXECUTE FUNCTION fn_chamado_anexo_envio();

-- ── Sync state: a single row ─────────────────────────────────────────────
CREATE TABLE central_suporte (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor_eventos  BIGINT      NOT NULL DEFAULT 0,
  catalogo        JSONB,
  sincronizado_em TIMESTAMPTZ
);
INSERT INTO central_suporte (id) VALUES (1);
