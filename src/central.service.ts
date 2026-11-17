import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { KC_SUPORTE_OPTIONS, KcSuporteOptions } from './opcoes';
import { KcSuporteTransacao } from './transacao';

/** A status as the central defines it for this project. */
export interface SituacaoCentral {
  codigo: string;
  nome: string;
  categoria: 'INICIAL' | 'EM_ANDAMENTO' | 'AGUARDANDO_CLIENTE' | 'FINAL';
  permiteCliente: boolean;
  cor: 'info' | 'warn' | 'good' | 'bad' | 'neutral';
}
export interface Catalogo {
  tipos: { codigo: string; nome: string; slaHoras: number | null }[];
  situacoes: SituacaoCentral[];
}

interface Evento {
  id: number;
  idExterno: number;
  tipo: 'INTERACAO' | 'SITUACAO' | 'ANEXO';
  dados: {
    id?: number;
    idInteracao?: number;
    tipoMime?: string;
    tamanho?: number;
    sha256?: string;
    autor: string;
    mensagem?: string;
    codigo?: string;
    nome?: string;
    categoria?: SituacaoCentral['categoria'];
    criadoEm: string;
  };
}

export interface ResultadoSincronizacao {
  configurada: boolean;
  enviados: number;
  pendentes: number;
  eventos: number;
  erro?: string;
}

/**
 * Catalog when there is no central (development, tests, or an installation
 * without one): a fixed list, so the module works the same locally.
 */
export const CATALOGO_LOCAL: Catalogo = {
  tipos: [],
  situacoes: [
    { codigo: 'ABERTO', nome: 'Aberto', categoria: 'INICIAL', permiteCliente: false, cor: 'info' },
    {
      codigo: 'EM_ATENDIMENTO',
      nome: 'Em atendimento',
      categoria: 'EM_ANDAMENTO',
      permiteCliente: false,
      cor: 'warn',
    },
    {
      codigo: 'AGUARDANDO_USUARIO',
      nome: 'Aguardando usuário',
      categoria: 'AGUARDANDO_CLIENTE',
      permiteCliente: false,
      cor: 'warn',
    },
    {
      codigo: 'RESOLVIDO',
      nome: 'Resolvido',
      categoria: 'FINAL',
      permiteCliente: true,
      cor: 'good',
    },
    {
      codigo: 'FECHADO',
      nome: 'Fechado',
      categoria: 'FINAL',
      permiteCliente: false,
      cor: 'neutral',
    },
  ],
};


interface Pendente {
  id: string;
  tipo: string;
  id_chamado: string;
  id_interacao: string | null;
  id_anexo: string | null;
  situacao: string | null;
  id_usuario: number | null;
}

/**
 * Talks to kc-tickets (contract: DOCS/integracao.md in that repo).
 *
 * Nothing runs in the background: writes are sent when saved, and a sync runs
 * when someone opens the support screen or presses "Atualizar". If the central
 * does not answer, pending items stay in `chamado_envio` for the next sync.
 */
@Injectable()
export class KcCentralSuporteService {
  private readonly log = new Logger('CentralSuporte');
  private readonly url: string;
  private readonly chave: string;
  /** Two concurrent syncs would send the same thing twice. */
  private emCurso: Promise<ResultadoSincronizacao> | null = null;

  private readonly tempoLimite: number;
  private readonly tempoLimiteAnexo: number;

  constructor(
    @Inject(KC_SUPORTE_OPTIONS) opcoes: KcSuporteOptions,
    private readonly ds: DataSource,
    private readonly transacao: KcSuporteTransacao,
  ) {
    this.url = (opcoes.url ?? '').replace(/\/+$/, '');
    this.chave = opcoes.chave ?? '';
    this.tempoLimite = opcoes.tempoLimiteMs ?? 8000;
    // A 10 MB attachment over a slow link takes longer than a JSON call.
    this.tempoLimiteAnexo = opcoes.tempoLimiteAnexoMs ?? 120_000;
  }

  get configurada(): boolean {
    return !!this.url && !!this.chave;
  }

  async catalogo(): Promise<Catalogo> {
    if (!this.configurada) return CATALOGO_LOCAL;
    const [fila] = await this.ds.query<{ catalogo: Catalogo | null }[]>(
      'SELECT catalogo FROM central_suporte WHERE id = 1',
    );
    return fila?.catalogo ?? CATALOGO_LOCAL;
  }

  /** Sends what is pending without waiting: if it fails, the next sync retries. */
  enviarAgora(): void {
    if (!this.configurada) return;
    void this.sincronizar(false).catch((e: unknown) => this.log.warn(String(e)));
  }

  sincronizar(comEventos = true): Promise<ResultadoSincronizacao> {
    if (!this.configurada) {
      return Promise.resolve({ configurada: false, enviados: 0, pendentes: 0, eventos: 0 });
    }
    // Chained after the one in progress, so the events part is not lost when
    // the running one was only sending.
    const anterior = this.emCurso ?? Promise.resolve(null);
    const atual = anterior.then(() => this.executar(comEventos));
    this.emCurso = atual.finally(() => {
      if (this.emCurso === atual) this.emCurso = null;
    });
    return atual;
  }

  private async executar(comEventos: boolean): Promise<ResultadoSincronizacao> {
    let enviados = 0;
    let eventos = 0;
    let erro: string | undefined;
    try {
      enviados = await this.enviarPendentes();
      if (comEventos) {
        await this.atualizarCatalogo();
        eventos = await this.aplicarEventos();
        await this.ds.query('UPDATE central_suporte SET sincronizado_em = now() WHERE id = 1');
      }
    } catch (e) {
      erro = e instanceof Error ? e.message : String(e);
      this.log.warn(`sincronização incompleta: ${erro}`);
    }
    const [{ pendentes }] = await this.ds.query<{ pendentes: number }[]>(
      'SELECT COUNT(*)::int AS pendentes FROM chamado_envio WHERE enviado_em IS NULL',
    );
    return { configurada: true, enviados, pendentes, eventos, erro };
  }

  /**
   * In id order. Stops at the first failure: what comes next may depend on it
   * (a reply to a ticket that has not arrived yet).
   */
  private async enviarPendentes(): Promise<number> {
    const pendentes = await this.ds.query<Pendente[]>(
      `SELECT id, tipo, id_chamado, id_interacao, id_anexo, situacao, id_usuario
       FROM chamado_envio WHERE enviado_em IS NULL ORDER BY id LIMIT 200`,
    );
    let enviados = 0;
    for (const p of pendentes) {
      try {
        const resposta = await this.enviarUm(p);
        await this.ds.query(
          'UPDATE chamado_envio SET enviado_em = now(), tentativas = tentativas + 1, ultimo_erro = NULL WHERE id = $1',
          [p.id],
        );
        if (p.tipo === 'CHAMADO' && resposta)
          await this.aplicarSituacaoInicial(p.id_chamado, resposta);
        enviados++;
      } catch (e) {
        const mensagem = e instanceof Error ? e.message : String(e);
        await this.ds.query(
          'UPDATE chamado_envio SET tentativas = tentativas + 1, ultimo_erro = $2 WHERE id = $1',
          [p.id, mensagem.slice(0, 1000)],
        );
        throw e;
      }
    }
    return enviados;
  }

  private async enviarUm(
    p: Pendente,
  ): Promise<{ situacao: string; situacaoNome: string; categoria: string } | null> {
    if (p.tipo === 'CHAMADO') {
      const [c] = await this.ds.query<Record<string, string | null>[]>(
        `SELECT c.id::int AS id, c.protocolo, c.tipo, c.titulo, c.descricao, c.aberto_em,
                u.name AS nome, u.email
         FROM chamado c JOIN auth_users u ON u.id = c.id_solicitante WHERE c.id = $1`,
        [p.id_chamado],
      );
      return this.pedir('POST', '/integracao/chamados', {
        idExterno: Number(c.id),
        protocolo: c.protocolo,
        ...(c.tipo ? { tipo: c.tipo } : {}),
        titulo: c.titulo,
        descricao: c.descricao,
        // Only name and email: just what is needed to answer (LGPD).
        solicitante: { nome: c.nome, email: c.email },
        abertoEm: new Date(c.aberto_em!).toISOString(),
      });
    }
    if (p.tipo === 'INTERACAO') {
      const [i] = await this.ds.query<Record<string, string>[]>(
        `SELECT i.id::int AS id, i.mensagem, i.criado_em, u.name AS autor
         FROM chamado_interacao i JOIN auth_users u ON u.id = i.id_usuario WHERE i.id = $1`,
        [p.id_interacao],
      );
      await this.pedir('POST', `/integracao/chamados/${p.id_chamado}/interacoes`, {
        idExterno: Number(i.id),
        autor: i.autor,
        mensagem: i.mensagem,
        criadoEm: new Date(i.criado_em).toISOString(),
      });
      return null;
    }
    if (p.tipo === 'ANEXO') {
      const [a] = await this.ds.query<
        {
          id: string;
          id_interacao: string | null;
          nome: string;
          tipo_mime: string;
          criado_em: string;
          conteudo: Buffer;
        }[]
      >(
        `SELECT id, id_interacao, nome, tipo_mime, criado_em, conteudo
         FROM chamado_anexo WHERE id = $1`,
        [p.id_anexo],
      );
      const corpo = new FormData();
      corpo.append('idExterno', String(a.id));
      if (a.id_interacao) corpo.append('idInteracaoExterno', String(a.id_interacao));
      corpo.append('criadoEm', new Date(a.criado_em).toISOString());
      corpo.append(
        'arquivo',
        new Blob([new Uint8Array(a.conteudo)], { type: a.tipo_mime }),
        a.nome,
      );
      await this.pedir('POST', `/integracao/chamados/${p.id_chamado}/anexos`, corpo);
      return null;
    }
    const [u] = await this.ds.query<{ name: string }[]>(
      'SELECT name FROM auth_users WHERE id = $1',
      [p.id_usuario],
    );
    await this.pedir('POST', `/integracao/chamados/${p.id_chamado}/situacao`, {
      codigo: p.situacao,
      autor: u.name,
    });
    return null;
  }

  /** The central says which status a new ticket starts in: adopt it. */
  private async aplicarSituacaoInicial(
    idChamado: string,
    r: { situacao: string; situacaoNome: string; categoria: string },
  ): Promise<void> {
    const cat = await this.catalogo();
    const cor = cat.situacoes.find((s) => s.codigo === r.situacao)?.cor ?? 'info';
    await this.transacao.executar({}, (m) =>
      m.query(
        `UPDATE chamado SET situacao = $2, situacao_nome = $3, situacao_categoria = $4::varchar, situacao_cor = $5
         WHERE id = $1 AND situacao_categoria = 'INICIAL'`,
        [idChamado, r.situacao, r.situacaoNome, r.categoria, cor],
      ),
    );
  }

  private async atualizarCatalogo(): Promise<void> {
    const catalogo = await this.pedir<Catalogo>('GET', '/integracao/catalogo');
    await this.ds.query('UPDATE central_suporte SET catalogo = $1 WHERE id = 1', [
      JSON.stringify(catalogo),
    ]);
  }

  /**
   * Each event is applied in its own transaction together with the cursor:
   * all or nothing, and the next sync asks again from the same point. One by
   * one because an ANEXO is downloaded BEFORE opening the transaction: the
   * database is never kept waiting on the network.
   */
  private async aplicarEventos(): Promise<number> {
    let total = 0;
    const cores = new Map((await this.catalogo()).situacoes.map((s) => [s.codigo, s.cor]));
    for (let pagina = 0; pagina < 20; pagina++) {
      const [{ cursor_eventos: cursor }] = await this.ds.query<{ cursor_eventos: string }[]>(
        'SELECT cursor_eventos FROM central_suporte WHERE id = 1',
      );
      const r = await this.pedir<{ eventos: Evento[]; cursor: number; mais: boolean }>(
        'GET',
        `/integracao/eventos?depois=${cursor}&limite=200`,
      );
      if (!r.eventos.length) break;

      for (const e of r.eventos) {
        const conteudo = e.tipo === 'ANEXO' ? await this.baixarAnexo(e) : null;
        await this.transacao.executar({}, async (m) => {
          await this.aplicarEvento(m, e, conteudo, cores);
          await m.query('UPDATE central_suporte SET cursor_eventos = $1 WHERE id = 1', [e.id]);
        });
        total++;
      }
      if (!r.mais) break;
    }
    return total;
  }

  private async aplicarEvento(
    m: EntityManager,
    e: Evento,
    conteudo: Buffer | null,
    cores: Map<string, string>,
  ): Promise<void> {
    if (e.tipo === 'INTERACAO') {
      await m.query(
        `INSERT INTO chamado_interacao (id_chamado, autor_externo, id_central, mensagem, criado_em)
         SELECT id, $2, $3, $4, $5 FROM chamado WHERE id = $1
         ON CONFLICT (id_central) DO NOTHING`,
        [e.idExterno, e.dados.autor, e.dados.id, e.dados.mensagem, e.dados.criadoEm],
      );
      await m.query(
        'UPDATE chamado SET primeira_resposta_em = COALESCE(primeira_resposta_em, $2) WHERE id = $1',
        [e.idExterno, e.dados.criadoEm],
      );
    } else if (e.tipo === 'ANEXO') {
      // `conteudo` null: already stored (event applied twice) or its message
      // does not exist here. Nothing to save either way.
      if (!conteudo) return;
      await m.query(
        `INSERT INTO chamado_anexo (id_chamado, id_interacao, id_central, nome, tipo_mime,
                                    tamanho, sha256, conteudo, criado_em)
         SELECT i.id_chamado, i.id, $2, $3, $4, $5, $6, $7, $8
         FROM chamado_interacao i WHERE i.id_central = $1 AND i.id_chamado = $9
         ON CONFLICT (id_central) DO NOTHING`,
        [
          e.dados.idInteracao,
          e.dados.id,
          e.dados.nome,
          e.dados.tipoMime,
          conteudo.length,
          e.dados.sha256,
          conteudo,
          e.dados.criadoEm,
          e.idExterno,
        ],
      );
    } else {
      await m.query(
        `UPDATE chamado SET situacao = $2, situacao_nome = $3, situacao_categoria = $4::varchar,
                situacao_cor = $5,
                resolvido_em = CASE WHEN $4::varchar = 'FINAL' THEN COALESCE(resolvido_em, $6::timestamptz) END
         WHERE id = $1`,
        [
          e.idExterno,
          e.dados.codigo,
          e.dados.nome,
          e.dados.categoria,
          cores.get(e.dados.codigo!) ?? 'info',
          e.dados.criadoEm,
        ],
      );
    }
  }

  /**
   * Downloads a KC attachment and checks it is the one the event announces.
   * On failure the sync stops here and the cursor does not move past it.
   */
  private async baixarAnexo(e: Evento): Promise<Buffer | null> {
    const [ja] = await this.ds.query<unknown[]>(
      `SELECT 1 FROM chamado_anexo WHERE id_central = $1
       UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM chamado_interacao WHERE id_central = $2)`,
      [e.dados.id, e.dados.idInteracao],
    );
    if (ja) return null;
    const res = await fetch(`${this.url}/integracao/anexos/${e.dados.id}`, {
      headers: { Authorization: `Bearer ${this.chave}` },
      signal: AbortSignal.timeout(this.tempoLimiteAnexo),
    });
    if (!res.ok) throw new Error(`central respondeu ${res.status} ao baixar o anexo ${e.dados.id}`);
    const conteudo = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash('sha256').update(conteudo).digest('hex');
    if (sha256 !== e.dados.sha256)
      throw new Error(`o anexo ${e.dados.id} chegou corrompido (SHA-256 não confere)`);
    return conteudo;
  }

  /** JSON, or multipart when `corpo` is a FormData (fetch sets the boundary). */
  private async pedir<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<T> {
    const multipart = corpo instanceof FormData;
    const res = await fetch(`${this.url}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.chave}`,
        ...(corpo && !multipart ? { 'Content-Type': 'application/json' } : {}),
      },
      body: multipart ? corpo : corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(multipart ? this.tempoLimiteAnexo : this.tempoLimite),
    });
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new Error(
        `central respondeu ${res.status} em ${metodo} ${caminho}: ${texto.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}
