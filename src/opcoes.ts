import { ModuleMetadata } from '@nestjs/common';

/**
 * Connection to the KC support central (kc-tickets). Both empty = local mode:
 * tickets live only in this installation and local support users answer them.
 */
export interface KcSuporteOptions {
  /** e.g. `https://tickets.kcsoftware.com.br/api`. */
  url?: string;
  /** The project's API key (`kct_…`), generated in the central. */
  chave?: string;
  /** Timeout of a JSON call to the central. Default 8 s. */
  tempoLimiteMs?: number;
  /** Timeout of an attachment upload/download. Default 120 s. */
  tempoLimiteAnexoMs?: number;
}

export interface KcSuporteAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => KcSuporteOptions | Promise<KcSuporteOptions>;
  inject?: any[];
}

export const KC_SUPORTE_OPTIONS = Symbol('KC_SUPORTE_OPTIONS');
