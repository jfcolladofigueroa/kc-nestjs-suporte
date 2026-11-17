import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Permissions } from '@kc-software/nestjs-auth';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { CATALOGO_LOCAL, KcCentralSuporteService } from './central.service';
import { Autor, KcSuporteTransacao, type KcSuporteAutor as ContextoAuditoria } from './transacao';
import {
  type AnexoValidado,
  type ArquivoRecebido,
  enviarAnexo,
  LIMITES_UPLOAD,
  validarAnexo,
} from './anexo';

class CriarChamadoDto {
  @IsOptional() @Matches(/^[A-Z0-9_]+$/) tipo?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) titulo!: string;
  @IsString() @IsNotEmpty() @MaxLength(20000) descricao!: string;
}
class InteracaoDto {
  @IsString() @IsNotEmpty() @MaxLength(20000) mensagem!: string;
}
class ConsultaDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pagina?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) porPagina?: number;
}
/** Local mode only: with a central, KC decides the status. */
class SituacaoDto {
  @IsIn(CATALOGO_LOCAL.situacoes.map((s) => s.codigo))
  situacao!: string;
}

/** `chamado:<verb>`, checked by the global guard of @kc-software/nestjs-auth. */
const Permissao = (_recurso: 'chamado', verbo: 'consultar' | 'incluir' | 'alterar') =>
  Permissions(`chamado:${verbo}`);

/**
 * The support screen's API. Tickets are opened, answered and read here; with a
 * central configured, KC answers them in kc-tickets and decides the status.
 * Without one, local support users (`chamado:alterar`) answer them.
 */
@Controller('chamados')
export class KcChamadosController {
  constructor(
    private readonly ds: DataSource,
    private readonly transacao: KcSuporteTransacao,
    private readonly central: KcCentralSuporteService,
  ) {}

  private async suporte(
    manager: DataSource | EntityManager,
    autor: ContextoAuditoria,
  ): Promise<boolean> {
    const [u] = await manager.query<{ suporte: boolean }[]>(
      `SELECT (u.role = 'admin' OR u.permissions::jsonb ? 'chamado:alterar'
        OR EXISTS (SELECT 1 FROM auth_profile_permissions p WHERE p.profile_id = u.profile_id
                   AND p.resource = 'chamado' AND p.can_update)) AS suporte FROM auth_users u WHERE u.id = $1`,
      [autor.idUsuario],
    );
    return u?.suporte ?? false;
  }

  private async exigir(manager: DataSource | EntityManager, id: number, autor: ContextoAuditoria) {
    const [chamado] = await manager.query<
      { id: string; id_solicitante: number; situacao: string; situacao_categoria: string }[]
    >('SELECT * FROM chamado WHERE id = $1', [id]);
    if (!chamado) throw new NotFoundException('Chamado não encontrado.');
    if (chamado.id_solicitante !== autor.idUsuario && !(await this.suporte(manager, autor)))
      throw new ForbiddenException();
    return chamado;
  }

  /** Inside the message's transaction: if one attachment fails, nothing is kept. */
  private async anexar(
    manager: EntityManager,
    idChamado: number | string,
    idInteracao: number | string | null,
    autor: ContextoAuditoria,
    anexos: AnexoValidado[],
  ): Promise<void> {
    for (const a of anexos) {
      await manager.query(
        `INSERT INTO chamado_anexo (id_chamado, id_interacao, id_usuario, nome, tipo_mime,
                                    tamanho, sha256, conteudo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          idChamado,
          idInteracao,
          autor.idUsuario,
          a.nome,
          a.tipoMime,
          a.tamanho,
          a.sha256,
          a.conteudo,
        ],
      );
    }
  }

  /** Types for the form, and whether there is a central behind. */
  @Get('catalogo')
  @Permissao('chamado', 'consultar')
  async catalogo() {
    const cat = await this.central.catalogo();
    const [estado] = await this.ds.query<{ sincronizado_em: string | null }[]>(
      'SELECT sincronizado_em FROM central_suporte WHERE id = 1',
    );
    return {
      central: this.central.configurada,
      tipos: cat.tipos,
      podeResolver: cat.situacoes.some((s) => s.permiteCliente && s.categoria === 'FINAL'),
      sincronizadoEm: estado?.sincronizado_em ?? null,
    };
  }

  /** Called by the screen when it opens and by the "Atualizar" button. */
  @Post('sincronizar')
  @HttpCode(200)
  @Permissao('chamado', 'consultar')
  sincronizar() {
    return this.central.sincronizar();
  }

  /** JSON or multipart: the fields plus up to 5 photos or PDFs in `anexos`. */
  @Post()
  @Permissao('chamado', 'incluir')
  @UseInterceptors(FilesInterceptor('anexos', 5, LIMITES_UPLOAD))
  async criar(
    @Body() dto: CriarChamadoDto,
    @Autor() autor: ContextoAuditoria,
    @UploadedFiles() arquivos: ArquivoRecebido[] | undefined,
  ) {
    const anexos = (arquivos ?? []).map(validarAnexo);
    const cat = await this.central.catalogo();
    const tipo = dto.tipo ? cat.tipos.find((t) => t.codigo === dto.tipo) : undefined;
    if (dto.tipo && !tipo) throw new BadRequestException(`Tipo ${dto.tipo} não existe.`);
    const inicial =
      cat.situacoes.find((s) => s.categoria === 'INICIAL') ?? CATALOGO_LOCAL.situacoes[0];

    // A trigger queues the send in this same transaction.
    const chamado = await this.transacao.executar(autor, async (manager) => {
      const [c] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO chamado (id_solicitante, titulo, descricao, tipo, tipo_nome,
                              situacao, situacao_nome, situacao_categoria, situacao_cor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          autor.idUsuario,
          dto.titulo.trim(),
          dto.descricao.trim(),
          tipo?.codigo ?? null,
          tipo?.nome ?? null,
          inicial.codigo,
          inicial.nome,
          inicial.categoria,
          inicial.cor,
        ],
      );
      await this.anexar(manager, c.id as string, null, autor, anexos);
      return c;
    });
    this.central.enviarAgora();
    return chamado;
  }

  @Get()
  @Permissao('chamado', 'consultar')
  async listar(@Query() dto: ConsultaDto, @Autor() autor: ContextoAuditoria) {
    const todos = await this.suporte(this.ds, autor);
    const pagina = dto.pagina ?? 1;
    const porPagina = dto.porPagina ?? 25;
    const [{ total }] = await this.ds.query<{ total: number }[]>(
      'SELECT COUNT(*)::int AS total FROM chamado WHERE $1::boolean OR id_solicitante = $2',
      [todos, autor.idUsuario],
    );
    const dados = await this.ds.query<Record<string, unknown>[]>(
      `SELECT c.id, c.protocolo, c.titulo, c.situacao, c.situacao_nome, c.situacao_cor,
              c.situacao_categoria, c.tipo_nome, c.aberto_em, c.primeira_resposta_em, c.resolvido_em,
              EXISTS (SELECT 1 FROM chamado_envio e WHERE e.id_chamado = c.id AND e.enviado_em IS NULL)
                AS pendente
       FROM chamado c WHERE $1::boolean OR c.id_solicitante = $2
       ORDER BY c.id DESC LIMIT $3 OFFSET $4`,
      [todos, autor.idUsuario, porPagina, (pagina - 1) * porPagina],
    );
    return { dados, total, pagina, porPagina };
  }

  @Get(':id')
  @Permissao('chamado', 'consultar')
  async detalhe(@Param('id', ParseIntPipe) id: number, @Autor() autor: ContextoAuditoria) {
    const chamado = await this.exigir(this.ds, id, autor);
    const interacoes = await this.ds.query<Record<string, unknown>[]>(
      `SELECT i.id, i.mensagem, i.criado_em, COALESCE(u.name, i.autor_externo) AS usuario,
              i.autor_externo IS NOT NULL AS externo,
              EXISTS (SELECT 1 FROM chamado_envio e WHERE e.id_interacao = i.id AND e.enviado_em IS NULL)
                AS pendente
       FROM chamado_interacao i LEFT JOIN auth_users u ON u.id = i.id_usuario
       WHERE i.id_chamado = $1 ORDER BY i.criado_em, i.id`,
      [id],
    );
    // Without the content; `id_interacao` NULL = attached at opening.
    const anexos = await this.ds.query<Record<string, unknown>[]>(
      `SELECT a.id, a.id_interacao, a.nome, a.tipo_mime, a.tamanho,
              EXISTS (SELECT 1 FROM chamado_envio e WHERE e.id_anexo = a.id AND e.enviado_em IS NULL)
                AS pendente
       FROM chamado_anexo a WHERE a.id_chamado = $1 ORDER BY a.id`,
      [id],
    );
    return { chamado, interacoes, anexos };
  }

  @Get(':id/anexos/:idAnexo')
  @Permissao('chamado', 'consultar')
  async anexo(
    @Param('id', ParseIntPipe) id: number,
    @Param('idAnexo', ParseIntPipe) idAnexo: number,
    @Autor() autor: ContextoAuditoria,
    @Res() res: Response,
  ) {
    await this.exigir(this.ds, id, autor);
    const [a] = await this.ds.query<
      { nome: string; tipo_mime: string; sha256: string; conteudo: Buffer }[]
    >(
      'SELECT nome, tipo_mime, sha256, conteudo FROM chamado_anexo WHERE id = $1 AND id_chamado = $2',
      [idAnexo, id],
    );
    if (!a) throw new NotFoundException('Anexo não encontrado.');
    enviarAnexo(res, a);
  }

  @Post(':id/interacoes')
  @Permissao('chamado', 'consultar')
  @UseInterceptors(FilesInterceptor('anexos', 5, LIMITES_UPLOAD))
  async responder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InteracaoDto,
    @Autor() autor: ContextoAuditoria,
    @UploadedFiles() arquivos: ArquivoRecebido[] | undefined,
  ) {
    const anexos = (arquivos ?? []).map(validarAnexo);
    const r = await this.transacao.executar(autor, async (manager) => {
      await this.exigir(manager, id, autor);
      const [i] = await manager.query<{ id: string }[]>(
        'INSERT INTO chamado_interacao (id_chamado, id_usuario, mensagem) VALUES ($1, $2, $3) RETURNING id',
        [id, autor.idUsuario, dto.mensagem.trim()],
      );
      await this.anexar(manager, id, i.id, autor, anexos);
      // Without a central, the first response is given by local support.
      if (!this.central.configurada && (await this.suporte(manager, autor))) {
        await manager.query(
          'UPDATE chamado SET primeira_resposta_em = COALESCE(primeira_resposta_em, now()) WHERE id = $1',
          [id],
        );
      }
      return { id };
    });
    this.central.enviarAgora();
    return r;
  }

  /**
   * "It is solved": the only status decision the installation makes. Applied
   * locally at once and sent to the central.
   */
  @Post(':id/resolver')
  @HttpCode(200)
  @Permissao('chamado', 'consultar')
  async resolver(@Param('id', ParseIntPipe) id: number, @Autor() autor: ContextoAuditoria) {
    const cat = await this.central.catalogo();
    const destino = cat.situacoes.find((s) => s.permiteCliente && s.categoria === 'FINAL');
    if (!destino) throw new ConflictException('A central não permite encerrar chamados por aqui.');
    const r = await this.transacao.executar(autor, async (manager) => {
      const c = await this.exigir(manager, id, autor);
      if (c.situacao === destino.codigo) return { id };
      await manager.query(
        `UPDATE chamado SET situacao = $2, situacao_nome = $3, situacao_categoria = $4::varchar,
                situacao_cor = $5, resolvido_em = COALESCE(resolvido_em, now()) WHERE id = $1`,
        [id, destino.codigo, destino.nome, destino.categoria, destino.cor],
      );
      if (this.central.configurada) {
        await manager.query(
          `INSERT INTO chamado_envio (tipo, id_chamado, situacao, id_usuario)
           VALUES ('SITUACAO', $1, $2, $3)`,
          [id, destino.codigo, autor.idUsuario],
        );
      }
      return { id };
    });
    this.central.enviarAgora();
    return r;
  }

  /** Status change by LOCAL support: only when there is no central. */
  @Patch(':id')
  @Permissao('chamado', 'alterar')
  alterar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SituacaoDto,
    @Autor() autor: ContextoAuditoria,
  ) {
    if (this.central.configurada)
      throw new ConflictException(
        'A situação dos chamados é definida pela central de suporte da KC.',
      );
    const s = CATALOGO_LOCAL.situacoes.find((x) => x.codigo === dto.situacao)!;
    return this.transacao.executar(autor, async (manager) => {
      await this.exigir(manager, id, autor);
      await manager.query(
        `UPDATE chamado SET situacao = $2, situacao_nome = $3, situacao_categoria = $4::varchar, situacao_cor = $5,
                resolvido_em = CASE WHEN $4::varchar = 'FINAL' THEN COALESCE(resolvido_em, now()) ELSE NULL END
         WHERE id = $1`,
        [id, s.codigo, s.nome, s.categoria, s.cor],
      );
      return { id };
    });
  }
}

