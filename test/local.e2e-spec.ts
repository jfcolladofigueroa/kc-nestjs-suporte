import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { criarApp } from './app';

/** Without a central: tickets stay in the installation and local support answers. */
describe('Modo local (sem central)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const sufixo = Math.random().toString(36).slice(2, 8);
  const tokens: Record<string, string> = {};
  const api = () => request(app.getHttpServer());
  const como = (quem: string) => ({ Authorization: `Bearer ${tokens[quem]}` });

  async function usuario(quem: string, permissoes: string[]) {
    const email = `${quem}-${sufixo}@prova.test`;
    await ds.query(
      `INSERT INTO auth_users (email, password_hash, name, role, permissions) VALUES ($1, $2, $3, 'user', $4)`,
      [email, await bcrypt.hash('senha-de-prova-segura', 4), quem, JSON.stringify(permissoes)],
    );
    const r = await api().post('/api/auth/login').send({ email, password: 'senha-de-prova-segura' }).expect(201);
    tokens[quem] = (r.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await criarApp({});
    ds = app.get(DataSource);
    await usuario('ana', ['chamado:incluir', 'chamado:consultar']);
    await usuario('rui', ['chamado:incluir', 'chamado:consultar']);
    await usuario('suporte', ['chamado:consultar', 'chamado:alterar']);
  });

  afterAll(() => app.close());

  it('sem permissão, 403; sem token, 401', async () => {
    await api().get('/api/chamados').expect(401);
    await usuario('nada', []);
    await api().get('/api/chamados').set(como('nada')).expect(403);
  });

  it('o solicitante só vê os seus; o suporte vê todos e muda a situação', async () => {
    const r = await api()
      .post('/api/chamados')
      .set(como('ana'))
      .send({ titulo: 'Dúvida', descricao: 'Como emitir o relatório?' })
      .expect(201);
    const id = (r.body as { id: string; protocolo: string }).id;
    expect((r.body as { protocolo: string }).protocolo).toMatch(/^\d{4}\/\d{8}$/);

    await api().get(`/api/chamados/${id}`).set(como('rui')).expect(403);
    const lista = await api().get('/api/chamados').set(como('suporte')).expect(200);
    expect((lista.body as { dados: { id: string }[] }).dados.map((c) => c.id)).toContain(id);

    await api().post(`/api/chamados/${id}/interacoes`).set(como('suporte')).send({ mensagem: 'Menu Relatórios.' }).expect(201);
    await api().patch(`/api/chamados/${id}`).set(como('suporte')).send({ situacao: 'EM_ATENDIMENTO' }).expect(200);
    await api().patch(`/api/chamados/${id}`).set(como('ana')).send({ situacao: 'FECHADO' }).expect(403);

    const d = await api().get(`/api/chamados/${id}`).set(como('ana')).expect(200);
    const c = (d.body as { chamado: { situacao: string; primeira_resposta_em: string | null } }).chamado;
    expect(c.situacao).toBe('EM_ATENDIMENTO');
    expect(c.primeira_resposta_em).not.toBeNull();

    await api().post(`/api/chamados/${id}/resolver`).set(como('ana')).expect(200);
    const [f] = await ds.query<{ situacao_categoria: string }[]>('SELECT situacao_categoria FROM chamado WHERE id = $1', [id]);
    expect(f.situacao_categoria).toBe('FINAL');
  });

  it('sincronizar sem central não faz nada', async () => {
    const r = await api().post('/api/chamados/sincronizar').set(como('ana')).expect(200);
    expect(r.body).toEqual({ configurada: false, enviados: 0, pendentes: 0, eventos: 0 });
  });
});
