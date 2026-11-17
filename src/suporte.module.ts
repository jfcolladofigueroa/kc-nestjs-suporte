import { DynamicModule, Module, Provider } from '@nestjs/common';
import { KcCentralSuporteService } from './central.service';
import { KcChamadosController } from './chamados.controller';
import { KC_SUPORTE_OPTIONS, KcSuporteAsyncOptions, KcSuporteOptions } from './opcoes';
import { KcSuporteTransacao } from './transacao';

/**
 * Support tickets for KC products, answered in the KC central (kc-tickets).
 *
 *     KcSuporteModule.forRoot({ url: process.env.KC_TICKETS_URL, chave: process.env.KC_TICKETS_CHAVE })
 *
 * Needs, in the application: a TypeORM `DataSource` (PostgreSQL),
 * @kc-software/nestjs-auth with its JWT guard global (routes are protected by
 * `chamado:consultar|incluir|alterar`), and the schema in
 * `sql/001_kc_suporte.sql` applied by the application's migrations.
 */
@Module({})
export class KcSuporteModule {
  static forRoot(opcoes: KcSuporteOptions = {}): DynamicModule {
    return KcSuporteModule.montar([{ provide: KC_SUPORTE_OPTIONS, useValue: opcoes }]);
  }

  static forRootAsync(opcoes: KcSuporteAsyncOptions): DynamicModule {
    return {
      ...KcSuporteModule.montar([
        { provide: KC_SUPORTE_OPTIONS, useFactory: opcoes.useFactory, inject: opcoes.inject ?? [] },
      ]),
      imports: opcoes.imports ?? [],
    };
  }

  private static montar(opcoes: Provider[]): DynamicModule {
    return {
      module: KcSuporteModule,
      controllers: [KcChamadosController],
      providers: [...opcoes, KcSuporteTransacao, KcCentralSuporteService],
      exports: [KcCentralSuporteService],
    };
  }
}
