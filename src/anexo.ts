import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';

/**
 * Ticket attachments: only photos (JPEG, PNG, WebP) and PDF, 10 MB per file,
 * 5 per message. The database enforces the same three rules
 * (sql/001_kc_suporte.sql); this is to answer with a clear message first.
 */
export const TAMANHO_MAXIMO = 10 * 1024 * 1024;
export const ANEXOS_POR_MENSAGEM = 5;

/** What multer leaves of an uploaded file (memoryStorage). */
export interface ArquivoRecebido {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** Limits for FileInterceptor / FilesInterceptor. */
export const LIMITES_UPLOAD = {
  limits: { fileSize: TAMANHO_MAXIMO, files: ANEXOS_POR_MENSAGEM },
};

const ASSINATURAS: { tipo: string; confere: (b: Buffer) => boolean }[] = [
  { tipo: 'image/jpeg', confere: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  {
    tipo: 'image/png',
    confere: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    tipo: 'image/webp',
    confere: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { tipo: 'application/pdf', confere: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** The type from the content, not the extension. `null` if not one of the four. */
export function tipoPorAssinatura(b: Buffer): string | null {
  return ASSINATURAS.find((a) => a.confere(b))?.tipo ?? null;
}

export interface AnexoValidado {
  nome: string;
  tipoMime: string;
  tamanho: number;
  sha256: string;
  conteudo: Buffer;
}

export function validarAnexo(arquivo: ArquivoRecebido): AnexoValidado {
  const nome = nomeLimpo(arquivo.originalname);
  if (!arquivo.size) throw new BadRequestException(`${nome}: o arquivo está vazio.`);
  if (arquivo.size > TAMANHO_MAXIMO)
    throw new BadRequestException(`${nome}: o limite é de 10 MB por arquivo.`);
  const tipoMime = tipoPorAssinatura(arquivo.buffer);
  if (!tipoMime)
    throw new BadRequestException(`${nome}: só são aceitas fotos (JPEG, PNG, WebP) e PDF.`);
  return {
    nome,
    tipoMime,
    tamanho: arquivo.size,
    sha256: createHash('sha256').update(arquivo.buffer).digest('hex'),
    conteudo: arquivo.buffer,
  };
}

/**
 * multer hands the file name over as latin1 even when the browser sent UTF-8
 * ("relatório.pdf" arrives as "relatÃ³rio.pdf"). Recover it, strip paths and
 * control characters, and cap the length.
 */
export function nomeLimpo(original: string): string {
  let nome = Buffer.from(original ?? '', 'latin1').toString('utf8');
  if (nome.includes('�')) nome = original;
  nome = nome
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();
  return (nome || 'anexo').slice(-200);
}

/**
 * Sends the content. Images inline, to be shown on screen; PDFs always as a
 * download — never opened inside the application.
 */
export function enviarAnexo(
  res: Response,
  a: { nome: string; tipo_mime: string; sha256: string; conteudo: Buffer },
): void {
  const disposicao = a.tipo_mime === 'application/pdf' ? 'attachment' : 'inline';
  const ascii = a.nome.replace(/[^\x20-\x7e]/g, '_');
  res.setHeader('Content-Type', a.tipo_mime);
  res.setHeader('Content-Length', a.conteudo.length);
  res.setHeader(
    'Content-Disposition',
    `${disposicao}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
  );
  res.setHeader('X-Content-SHA256', a.sha256);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.end(a.conteudo);
}
