import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KcAuthModule, KcJwtAuthGuard, KcRolesGuard, kcAuthEntities } from '@kc-software/nestjs-auth';
import { KcSuporteModule, KcSuporteOptions } from '../src';
import { BASE, ligacao } from './global-setup';

/** An application wired the way a KC product wires it. */
export async function criarApp(opcoes: KcSuporteOptions): Promise<INestApplication> {
  const modulo = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({ ...ligacao(BASE), entities: [...kcAuthEntities], synchronize: false }),
      KcAuthModule.forRoot({
        jwtSecret: 'segredo-de-teste-com-tamanho-suficiente',
        accessTokenExpiration: '1h',
        refreshTokenExpiration: '7d',
        enableRegistration: false,
        defaultRole: 'user',
      }),
      KcSuporteModule.forRoot(opcoes),
    ],
    providers: [
      { provide: APP_GUARD, useClass: KcJwtAuthGuard },
      { provide: APP_GUARD, useClass: KcRolesGuard },
    ],
  }).compile();
  const app = modulo.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return app;
}
