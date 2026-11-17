import { ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/** Who makes the change: for the application's audit trigger, if it has one. */
export interface KcSuporteAutor {
  idUsuario?: number | null;
  ip?: string | null;
}

/** From the JWT already validated by the auth guard — never from the body. */
export const Autor = createParamDecorator((_d: unknown, ctx: ExecutionContext): KcSuporteAutor => {
  const req = ctx.switchToHttp().getRequest<{ user?: { id?: number }; ip?: string }>();
  return { idUsuario: req.user?.id ?? null, ip: req.ip ?? null };
});

/**
 * Runs a unit of work in a transaction with `app.current_user_id` and
 * `app.current_ip` set LOCAL to it — the convention KC products' audit
 * triggers read. Harmless when nothing reads them. LOCAL matters: a pooled
 * connection must not carry the previous request's user.
 */
@Injectable()
export class KcSuporteTransacao {
  constructor(private readonly ds: DataSource) {}

  async executar<T>(autor: KcSuporteAutor, trabalho: (m: EntityManager) => Promise<T>): Promise<T> {
    return this.ds.transaction(async (m) => {
      await m.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        'app.current_user_id',
        autor.idUsuario != null ? String(autor.idUsuario) : '',
        'app.current_ip',
        autor.ip ?? '',
      ]);
      return trabalho(m);
    });
  }
}
