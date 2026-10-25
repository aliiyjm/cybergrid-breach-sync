import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_OUTPUT_SIZE,
  AvatarError,
  computeCropRect,
  detectSignature,
  kindFromFileName,
  kindFromMime,
  processAvatar,
} from '../../server/src/profile/avatarProcessor';
import { avatarCropSchema } from '../../server/src/validation/schemas';

const png = (w: number, h: number, color = '#2ee6ff') =>
  sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
const jpeg = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#ff2fb3' } }).jpeg().toBuffer();

async function rejectCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AvatarError) return error.code;
    throw error;
  }
  return 'ACEPTADO';
}

describe('Detección de formato', () => {
  it('reconoce extensión, MIME y firma real de PNG y JPEG', async () => {
    expect(kindFromFileName('Mi Foto.PNG')).toBe('png');
    expect(kindFromFileName('a.jpeg')).toBe('jpeg');
    expect(kindFromFileName('a.jpg')).toBe('jpeg');
    for (const bad of ['a.gif', 'a.svg', 'a.webp', 'a.bmp', 'a.exe', 'a.png.exe', 'png', '', 'a\u0000.png']) {
      expect(kindFromFileName(bad), bad).toBeNull();
    }
    expect(kindFromMime('image/png')).toBe('png');
    expect(kindFromMime('image/jpeg')).toBe('jpeg');
    expect(kindFromMime('image/gif')).toBeNull();
    expect(kindFromMime('text/html')).toBeNull();
    expect(detectSignature(await png(8, 8))).toBe('png');
    expect(detectSignature(await jpeg(8, 8))).toBe('jpeg');
    expect(detectSignature(Buffer.from('GIF89a'))).toBeNull();
    expect(detectSignature(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
});

describe('Procesado seguro de la imagen', () => {
  it('acepta PNG y JPEG válidos y los re-codifica a PNG 128×128 sin deformar', async () => {
    const outPng = await processAvatar({ buffer: await png(400, 300), fileName: 'yo.png', mimeType: 'image/png' });
    const outJpg = await processAvatar({
      buffer: await jpeg(300, 500),
      fileName: 'foto.JPG',
      mimeType: 'image/jpeg',
      crop: { x: 0, y: 0.2, size: 0.5 },
    });
    for (const out of [outPng, outJpg]) {
      const meta = await sharp(out.image).metadata();
      expect(meta.format).toBe('png');
      expect([meta.width, meta.height]).toEqual([AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE]);
      expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(outJpg.sourceType).toBe('jpeg');
  });

  it('rechaza formatos no permitidos aunque se renombren', async () => {
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).gif().toBuffer();
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).webp().toBuffer();
    expect(await rejectCode(processAvatar({ buffer: gif, fileName: 'a.gif', mimeType: 'image/gif' }))).toBe('FORMATO_NO_PERMITIDO');
    expect(await rejectCode(processAvatar({ buffer: gif, fileName: 'a.png', mimeType: 'image/png' }))).toBe('FORMATO_NO_PERMITIDO');
    expect(await rejectCode(processAvatar({ buffer: webp, fileName: 'a.jpg', mimeType: 'image/jpeg' }))).toBe('FORMATO_NO_PERMITIDO');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await rejectCode(processAvatar({ buffer: svg, fileName: 'a.png', mimeType: 'image/png' }))).toBe('FORMATO_NO_PERMITIDO');
    const exe = Buffer.from('MZ\u0090\u0000\u0003');
    expect(await rejectCode(processAvatar({ buffer: exe, fileName: 'juego.exe', mimeType: 'application/octet-stream' }))).toBe(
      'FORMATO_NO_PERMITIDO',
    );
  });

  it('rechaza archivos cuya extensión, MIME y contenido no coinciden', async () => {
    const jpg = await jpeg(64, 64);
    expect(await rejectCode(processAvatar({ buffer: jpg, fileName: 'a.png', mimeType: 'image/png' }))).toBe('FORMATO_INCOHERENTE');
    expect(await rejectCode(processAvatar({ buffer: jpg, fileName: 'a.jpg', mimeType: 'image/png' }))).toBe('FORMATO_INCOHERENTE');
  });

  it('rechaza HTML/JavaScript disfrazado de imagen', async () => {
    const real = await png(64, 64);
    const polyglot = Buffer.concat([real, Buffer.from('<html><script>fetch("/api")</script></html>')]);
    expect(await rejectCode(processAvatar({ buffer: polyglot, fileName: 'a.png', mimeType: 'image/png' }))).toBe(
      'CONTENIDO_NO_PERMITIDO',
    );
    const html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
    expect(await rejectCode(processAvatar({ buffer: html, fileName: 'a.jpg', mimeType: 'image/jpeg' }))).toBe(
      'FORMATO_NO_PERMITIDO',
    );
  });

  it('rechaza archivos vacíos, demasiado grandes, corruptos o con dimensiones fuera de rango', async () => {
    expect(await rejectCode(processAvatar({ buffer: Buffer.alloc(0), fileName: 'a.png', mimeType: 'image/png' }))).toBe(
      'ARCHIVO_VACIO',
    );
    const real = await png(64, 64);
    expect(
      await rejectCode(
        processAvatar({ buffer: real, fileName: 'a.png', mimeType: 'image/png' }, { maxBytes: 100, maxDimension: 4096, minDimension: 32 }),
      ),
    ).toBe('ARCHIVO_DEMASIADO_GRANDE');
    expect(await rejectCode(processAvatar({ buffer: real.subarray(0, 60), fileName: 'a.png', mimeType: 'image/png' }))).toBe(
      'IMAGEN_CORRUPTA',
    );
    const wide = await png(5000, 40);
    expect(await rejectCode(processAvatar({ buffer: wide, fileName: 'a.png', mimeType: 'image/png' }))).toBe('DIMENSIONES_EXCESIVAS');
    const tiny = await png(10, 10);
    expect(await rejectCode(processAvatar({ buffer: tiny, fileName: 'a.png', mimeType: 'image/png' }))).toBe(
      'IMAGEN_DEMASIADO_PEQUENA',
    );
  });

  it('el encuadre siempre queda dentro de la imagen y es cuadrado', () => {
    expect(computeCropRect(400, 300)).toEqual({ left: 0, top: 0, width: 300, height: 300 });
    expect(computeCropRect(400, 300, { x: 0.9, y: 0.9, size: 0.5 })).toEqual({ left: 250, top: 150, width: 150, height: 150 });
    expect(computeCropRect(100, 100, { x: 0, y: 0, size: 5 })).toMatchObject({ width: 100, height: 100 });
    expect(avatarCropSchema.safeParse({ x: '0.5', y: '0.1', size: '0.3' }).success).toBe(true);
    expect(avatarCropSchema.safeParse({ x: '2' }).success).toBe(false);
    expect(avatarCropSchema.safeParse({ size: '0' }).success).toBe(false);
    expect(avatarCropSchema.safeParse({ path: '../../etc' }).success).toBe(false);
  });
});
