import { INestApplication } from '@nestjs/common';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { criarApp } from './app';

interface Pedido {
  metodo: string;
  caminho: string;
  autorizacao?: string;
  corpo: Record<string, unknown> | null;
  /** El cuerpo tal cual (para los multipart de anexos). */
  bruto: Buffer;
}

/** Un PNG de 1×1 y un PDF mínimo: lo que importa es la firma. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Integración con kc-tickets (ADR 002) contra una central FALSA, levantada
 * aquí con node:http: lo que se prueba es lo que hace almoxarifado —qué manda,
 * cuándo reintenta, cómo aplica lo que vuelve—, no la central.
 */
describe('Central de suporte (kc-tickets)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let central: Server;
  let token: string;
  const pedidos: Pedido[] = [];
  let caida = false;
  let eventos: unknown[] = [];
  /** Lo que sirve GET /integracao/anexos/:id. */
  const anexosDaCentral: Record<number, Buffer> = {};
  const sufixo = Math.random().toString(36).slice(2, 8);
  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const catalogo = {
    tipos: [{ codigo: 'ERRO', nome: 'Erro no sistema', slaHoras: 8 }],
    situacoes: [
      { codigo: 'NOVO', nome: 'Novo', categoria: 'INICIAL', permiteCliente: false, cor: 'info' },
      {
        codigo: 'EM_ANALISE',
        nome: 'Em análise',
        categoria: 'EM_ANDAMENTO',
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
    ],
  };

  function responder(req: IncomingMessage, res: ServerResponse, bruto: Buffer): void {
    const url = new URL(req.url!, 'http://central');
    const ehJson = (req.headers['content-type'] ?? '').includes('application/json');
    pedidos.push({
      metodo: req.method!,
      caminho: url.pathname,
      autorizacao: req.headers.authorization,
      corpo: ehJson ? (JSON.parse(bruto.toString()) as Record<string, unknown>) : null,
      bruto,
    });
    const json = (status: number, dados: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dados));
    };
    if (caida) return json(503, { message: 'fora do ar' });
    if (url.pathname === '/api/integracao/catalogo') return json(200, catalogo);
    if (url.pathname === '/api/integracao/eventos') {
      const lote = eventos;
      eventos = [];
      const ultimo = lote.length
        ? (lote[lote.length - 1] as { id: number }).id
        : Number(url.searchParams.get('depois'));
      return json(200, { eventos: lote, cursor: ultimo, mais: false });
    }
    const anexo = /^\/api\/integracao\/anexos\/(\d+)$/.exec(url.pathname);
    if (anexo) {
      const conteudo = anexosDaCentral[Number(anexo[1])];
      if (!conteudo) return json(404, { message: 'não existe' });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return void res.end(conteudo);
    }
    if (url.pathname === '/api/integracao/chamados')
      return json(200, { id: 1, situacao: 'NOVO', situacaoNome: 'Novo', categoria: 'INICIAL' });
    return json(200, { ok: true });
  }

  beforeAll(async () => {
    central = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (c: Buffer) => partes.push(c));
      req.on('end', () => responder(req, res, Buffer.concat(partes)));
    });
    await new Promise<void>((ok) => central.listen(0, '127.0.0.1', ok));
    const porta = (central.address() as AddressInfo).port;

    app = (await criarApp({ url: `http://127.0.0.1:${porta}/api`, chave: 'kct_teste' })) as INestApplication<App>;
    ds = app.get(DataSource);

    const email = `central-${sufixo}@prova.test`;
    await ds.query(
      `INSERT INTO auth_users (email, password_hash, name, role, permissions)
       VALUES ($1, $2, 'Maria Solicitante', 'user', $3)`,
      [
        email,
        await bcrypt.hash('senha-de-prova-segura', 4),
        JSON.stringify(['chamado:incluir', 'chamado:consultar']),
      ],
    );
    const r = await api()
      .post('/api/auth/login')
      .send({ email, password: 'senha-de-prova-segura' })
      .expect(201);
    token = (r.body as { accessToken: string }).accessToken;
    // Primera sincronización: trae el catálogo de la central.
    await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await new Promise((ok) => central.close(ok));
  });

  const esperarEnvio = async (idChamado: number) => {
    for (let i = 0; i < 50; i++) {
      const [{ n }] = await ds.query<{ n: number }[]>(
        'SELECT COUNT(*)::int AS n FROM chamado_envio WHERE id_chamado = $1 AND enviado_em IS NULL',
        [idChamado],
      );
      if (n === 0) return;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error('o envio não terminou');
  };

  it('o catálogo vem da central e o chamado nasce na situação inicial dela', async () => {
    const cat = await api().get('/api/chamados/catalogo').set(auth()).expect(200);
    expect(cat.body).toMatchObject({ central: true, podeResolver: true, tipos: catalogo.tipos });

    await api()
      .post('/api/chamados')
      .set(auth())
      .send({ tipo: 'NAO_EXISTE', titulo: 'x', descricao: 'y' })
      .expect(400);
    const r = await api()
      .post('/api/chamados')
      .set(auth())
      .send({ tipo: 'ERRO', titulo: 'Erro ao salvar', descricao: 'Aparece erro 500.' })
      .expect(201);
    const c = r.body as { id: string; situacao: string; tipo_nome: string };
    expect(c.situacao).toBe('NOVO');
    expect(c.tipo_nome).toBe('Erro no sistema');

    await esperarEnvio(Number(c.id));
    // Por su id: en la cola pueden ir antes chamados de otras suites.
    const enviado = pedidos.find(
      (p) => p.caminho === '/api/integracao/chamados' && p.corpo?.idExterno === Number(c.id),
    );
    expect(enviado?.autorizacao).toBe('Bearer kct_teste');
    expect(enviado?.corpo).toMatchObject({
      idExterno: Number(c.id),
      tipo: 'ERRO',
      titulo: 'Erro ao salvar',
      solicitante: { nome: 'Maria Solicitante', email: `central-${sufixo}@prova.test` },
    });
  });

  it('se a central cai, a resposta fica pendente e sai na sincronização seguinte', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    caida = true;
    await api()
      .post(`/api/chamados/${id}/interacoes`)
      .set(auth())
      .send({ mensagem: 'Foi ontem.' })
      .expect(201);
    const sinc = await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
    expect(sinc.body).toMatchObject({ configurada: true, pendentes: 1 });
    const lista = await api().get('/api/chamados').set(auth()).expect(200);
    expect((lista.body as { dados: { pendente: boolean }[] }).dados[0].pendente).toBe(true);

    caida = false;
    const ok = await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
    expect(ok.body).toMatchObject({ pendentes: 0, enviados: 1 });
    const resposta = pedidos
      .filter((p) => p.caminho === `/api/integracao/chamados/${id}/interacoes`)
      .pop();
    expect(resposta?.corpo).toMatchObject({ autor: 'Maria Solicitante', mensagem: 'Foi ontem.' });
  });

  it('aplica a resposta e a mudança de situação da KC, sem duplicar ao repetir', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    const lote = [
      {
        id: 101,
        idExterno: Number(id),
        tipo: 'INTERACAO',
        dados: {
          id: 9001,
          autor: 'Suporte KC — José',
          mensagem: 'Já corrigimos.',
          criadoEm: new Date().toISOString(),
        },
      },
      {
        id: 102,
        idExterno: Number(id),
        tipo: 'SITUACAO',
        dados: {
          codigo: 'EM_ANALISE',
          nome: 'Em análise',
          categoria: 'EM_ANDAMENTO',
          autor: 'Suporte KC — José',
          criadoEm: new Date().toISOString(),
        },
      },
    ];
    eventos = lote;
    await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
    // La central reenvía lo mismo (p. ej. se perdió el cursor): no duplica.
    await ds.query('UPDATE central_suporte SET cursor_eventos = 0');
    eventos = lote;
    await api().post('/api/chamados/sincronizar').set(auth()).expect(200);

    const d = await api().get(`/api/chamados/${id}`).set(auth()).expect(200);
    const body = d.body as {
      chamado: {
        situacao: string;
        situacao_nome: string;
        situacao_cor: string;
        primeira_resposta_em: string;
      };
      interacoes: { usuario: string; externo: boolean }[];
    };
    expect(body.chamado).toMatchObject({
      situacao: 'EM_ANALISE',
      situacao_nome: 'Em análise',
      situacao_cor: 'warn',
    });
    expect(body.chamado.primeira_resposta_em).toBeTruthy();
    expect(body.interacoes.filter((i) => i.externo)).toEqual([
      expect.objectContaining({ usuario: 'Suporte KC — José', externo: true }),
    ]);
    // La respuesta de KC no vuelve a la central.
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM chamado_envio e JOIN chamado_interacao i ON i.id = e.id_interacao
       WHERE i.id_central IS NOT NULL`,
    );
    expect(n).toBe(0);
  });

  it('o solicitante encerra e a central recebe a situação', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    await api().post(`/api/chamados/${id}/resolver`).set(auth()).expect(200);
    await esperarEnvio(Number(id));
    const s = pedidos.filter((p) => p.caminho === `/api/integracao/chamados/${id}/situacao`).pop();
    expect(s?.corpo).toEqual({ codigo: 'RESOLVIDO', autor: 'Maria Solicitante' });
    const [c] = await ds.query<{ situacao_categoria: string; resolvido_em: string }[]>(
      'SELECT situacao_categoria, resolvido_em FROM chamado WHERE id = $1',
      [id],
    );
    expect(c.situacao_categoria).toBe('FINAL');
    expect(c.resolvido_em).toBeTruthy();
  });

  it('a BD recusa uma interação com usuário e autor externo ao mesmo tempo', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    const [{ uid }] = await ds.query<{ uid: number }[]>('SELECT id AS uid FROM auth_users LIMIT 1');
    await expect(
      ds.query(
        `INSERT INTO chamado_interacao (id_chamado, id_usuario, autor_externo, id_central, mensagem)
         VALUES ($1, $2, 'X', 1, 'oi')`,
        [id, uid],
      ),
    ).rejects.toThrow(/ck_interacao_autor/);
  });

  it('anexos do órgão: vão para a central depois do chamado e da resposta', async () => {
    const r = await api()
      .post('/api/chamados')
      .set(auth())
      .field('titulo', 'Tela em branco')
      .field('descricao', 'Segue o print.')
      .attach('anexos', PNG, 'print da tela.png')
      .expect(201);
    const id = Number((r.body as { id: string }).id);
    await esperarEnvio(id);

    const caminhos = pedidos.map((p) => p.caminho);
    const iChamado = caminhos.lastIndexOf('/api/integracao/chamados');
    const iAnexo = caminhos.lastIndexOf(`/api/integracao/chamados/${id}/anexos`);
    expect(iAnexo).toBeGreaterThan(iChamado);
    const enviado = pedidos[iAnexo];
    expect(enviado.bruto.includes(PNG)).toBe(true);
    expect(enviado.bruto.toString('latin1')).toContain('name="idExterno"');
    expect(enviado.bruto.toString('latin1')).not.toContain('name="idInteracaoExterno"');

    await api()
      .post(`/api/chamados/${id}/interacoes`)
      .set(auth())
      .field('mensagem', 'O relatório também.')
      .attach('anexos', PDF, 'relatório.pdf')
      .expect(201);
    await esperarEnvio(id);
    const [i] = await ds.query<{ id: string }[]>(
      'SELECT max(id) AS id FROM chamado_interacao WHERE id_chamado = $1',
      [id],
    );
    const ultimo = pedidos
      .filter((p) => p.caminho === `/api/integracao/chamados/${id}/anexos`)
      .pop()!;
    expect(ultimo.bruto.toString('latin1')).toMatch(
      new RegExp(`name="idInteracaoExterno"\r\n\r\n${i.id}\r\n`),
    );

    const d = await api().get(`/api/chamados/${id}`).set(auth()).expect(200);
    const anexos = (
      d.body as { anexos: { id: string; nome: string; id_interacao: string | null }[] }
    ).anexos;
    expect(anexos.map((a) => a.nome)).toEqual(['print da tela.png', 'relatório.pdf']);
    expect(anexos[0].id_interacao).toBeNull();

    const baixado = await api()
      .get(`/api/chamados/${id}/anexos/${anexos[1].id}`)
      .set(auth())
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(baixado.headers['content-disposition']).toMatch(/^attachment/);
    expect(sha(baixado.body as Buffer)).toBe(sha(PDF));
  });

  it('só fotos e PDF, pelo conteúdo: um executável com nome .pdf não entra', async () => {
    const [{ antes }] = await ds.query<{ antes: number }[]>(
      'SELECT COUNT(*)::int AS antes FROM chamado',
    );
    const r = await api()
      .post('/api/chamados')
      .set(auth())
      .field('titulo', 'Nota')
      .field('descricao', 'Anexo')
      .attach('anexos', Buffer.from('MZ\x90\x00 programa'), 'nota.pdf')
      .expect(400);
    expect((r.body as { message: string }).message).toMatch(/só são aceitas/);
    const [{ depois }] = await ds.query<{ depois: number }[]>(
      'SELECT COUNT(*)::int AS depois FROM chamado',
    );
    expect(depois).toBe(antes);
  });

  it('anexo da KC: baixa, confere o SHA-256 e guarda; corrompido, não avança o cursor', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    anexosDaCentral[501] = PDF;
    anexosDaCentral[502] = PDF;
    const interacao = {
      id: 201,
      idExterno: Number(id),
      tipo: 'INTERACAO',
      dados: {
        id: 9101,
        autor: 'Suporte KC — José',
        mensagem: 'Segue o manual.',
        criadoEm: new Date().toISOString(),
      },
    };
    const anexo = (idEvento: number, idAnexo: number, hash: string) => ({
      id: idEvento,
      idExterno: Number(id),
      tipo: 'ANEXO',
      dados: {
        id: idAnexo,
        idInteracao: 9101,
        nome: 'manual.pdf',
        tipoMime: 'application/pdf',
        tamanho: PDF.length,
        sha256: hash,
        criadoEm: new Date().toISOString(),
      },
    });

    // Corrompido: la interacción se aplica, el anexo no, y el cursor se queda en ella.
    eventos = [interacao, anexo(202, 502, '0'.repeat(64))];
    const falha = await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
    expect((falha.body as { erro: string }).erro).toMatch(/SHA-256/);
    const [{ cursor_eventos: cursor }] = await ds.query<{ cursor_eventos: string }[]>(
      'SELECT cursor_eventos FROM central_suporte',
    );
    expect(Number(cursor)).toBe(201);

    eventos = [anexo(203, 501, sha(PDF))];
    await api().post('/api/chamados/sincronizar').set(auth()).expect(200);
    const [a] = await ds.query<{ nome: string; sha256: string; id_usuario: number | null }[]>(
      'SELECT nome, sha256, id_usuario FROM chamado_anexo WHERE id_central = 501',
    );
    expect(a).toEqual({ nome: 'manual.pdf', sha256: sha(PDF), id_usuario: null });
    // No vuelve a la central.
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM chamado_envio e JOIN chamado_anexo a ON a.id = e.id_anexo
       WHERE a.id_central IS NOT NULL`,
    );
    expect(n).toBe(0);
  });

  it('a BD recusa anexo com firma falsa e não deixa alterar anexos', async () => {
    const [{ id }] = await ds.query<{ id: string }[]>('SELECT max(id) AS id FROM chamado');
    const [{ uid }] = await ds.query<{ uid: number }[]>('SELECT id AS uid FROM auth_users LIMIT 1');
    const falso = Buffer.from('não sou png');
    await expect(
      ds.query(
        `INSERT INTO chamado_anexo (id_chamado, id_usuario, nome, tipo_mime, tamanho, sha256, conteudo)
         VALUES ($1, $2, 'x.png', 'image/png', $3, $4, $5)`,
        [id, uid, falso.length, sha(falso), falso],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(ds.query("UPDATE chamado_anexo SET nome = 'x'")).rejects.toThrow();
  });
});
