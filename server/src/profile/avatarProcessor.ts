import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

/**
 * Validación y saneado de imágenes de apariencia.
 *
 * Capas de defensa (todas obligatorias, en este orden):
 *  1. Tamaño del archivo (vacío / máximo configurable, 2 MB por defecto).
 *  2. Extensión del nombre original: .png, .jpg o .jpeg.
 *  3. Tipo MIME declarado: image/png o image/jpeg.
 *  4. Firma real del contenido (bytes mágicos PNG / JPEG).
 *  5. Los tres deben coincidir entre sí (un .png con contenido JPEG se rechaza).
 *  6. Rechazo de contenido marcado como HTML/JS/SVG/PHP incrustado.
 *  7. Lectura de cabecera con libvips (sharp): formato real, una sola imagen,
 *     dimensiones mínimas y máximas, límite de píxeles antes de decodificar.
 *  8. Decodificación completa, recorte cuadrado y RE-CODIFICACIÓN a PNG de
 *     128×128 sin metadatos: lo que se guarda lo genera el servidor, nunca el
 *     archivo original. Cualquier dato extra (polyglots, EXIF, texto) se pierde.
 */

export type ImageKind = 'png' | 'jpeg';

export interface AvatarLimits {
  maxBytes: number;
  maxDimension: number;
  minDimension: number;
}

export const DEFAULT_AVATAR_LIMITS: AvatarLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxDimension: 4096,
  minDimension: 32,
};

/** Lado de la imagen final (px). Se dibuja escalada dentro del personaje. */
export const AVATAR_OUTPUT_SIZE = 128;

export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg'] as const;

export class AvatarError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarError';
  }
}

export interface AvatarCrop {
  /** Esquina superior izquierda como fracción del ancho / alto (imagen orientada). */
  x: number;
  y: number;
  /** Lado del recorte como fracción del lado menor. */
  size: number;
}

export interface AvatarInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  crop?: AvatarCrop;
}

export interface ProcessedAvatar {
  image: Buffer;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceType: ImageKind;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Formato según los bytes mágicos, o null si no es PNG ni JPEG. */
export function detectSignature(buffer: Buffer): ImageKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return null;
}

/** Formato según la extensión del nombre original (solo la última extensión cuenta). */
export function kindFromFileName(fileName: string): ImageKind | null {
  if (!fileName || fileName.length > 255 || /[\u0000-\u001f]/.test(fileName)) return null;
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  return null;
}

export function kindFromMime(mimeType: string): ImageKind | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'image/png') return 'png';
  if (base === 'image/jpeg') return 'jpeg';
  return null;
}

/** Marcadores de contenido activo que nunca deben aparecer en una imagen subida. */
const SUSPICIOUS_MARKERS = ['<script', '<html', '<svg', '<?php', '<iframe', 'javascript:'];

export function containsActiveContent(buffer: Buffer): boolean {
  const text = buffer.toString('latin1').toLowerCase();
  return SUSPICIOUS_MARKERS.some((marker) => text.includes(marker));
}

const FORMAT_MESSAGE = 'Formato no permitido. Solo se aceptan imágenes PNG o JPEG (.png, .jpg, .jpeg).';

/** Calcula el recorte cuadrado en píxeles, siempre dentro de la imagen. */
export function computeCropRect(
  width: number,
  height: number,
  crop: AvatarCrop = { x: 0, y: 0, size: 1 },
): { left: number; top: number; width: number; height: number } {
  const minSide = Math.min(width, height);
  const side = Math.max(1, Math.min(minSide, Math.round(minSide * Math.min(Math.max(crop.size, 0.05), 1))));
  const left = Math.min(Math.max(0, Math.round(crop.x * width)), width - side);
  const top = Math.min(Math.max(0, Math.round(crop.y * height)), height - side);
  return { left, top, width: side, height: side };
}

export async function processAvatar(
  input: AvatarInput,
  limits: AvatarLimits = DEFAULT_AVATAR_LIMITS,
): Promise<ProcessedAvatar> {
  const { buffer } = input;

  // 1. Tamaño.
  if (!buffer || buffer.length === 0) throw new AvatarError(400, 'ARCHIVO_VACIO', 'No se recibió ninguna imagen.');
  if (buffer.length > limits.maxBytes) {
    const mb = (limits.maxBytes / (1024 * 1024)).toFixed(limits.maxBytes % (1024 * 1024) === 0 ? 0 : 1);
    throw new AvatarError(413, 'ARCHIVO_DEMASIADO_GRANDE', `La imagen supera el tamaño máximo de ${mb} MB.`);
  }

  // 2-5. Extensión, MIME y firma deben ser PNG o JPEG y coincidir.
  const byName = kindFromFileName(input.fileName);
  const byMime = kindFromMime(input.mimeType);
  const bySignature = detectSignature(buffer);
  if (!byName || !byMime) throw new AvatarError(415, 'FORMATO_NO_PERMITIDO', FORMAT_MESSAGE);
  if (!bySignature) {
    throw new AvatarError(415, 'FORMATO_NO_PERMITIDO', 'El contenido del archivo no es una imagen PNG o JPEG.');
  }
  if (byName !== byMime || byMime !== bySignature) {
    throw new AvatarError(
      415,
      'FORMATO_INCOHERENTE',
      'La extensión, el tipo del archivo y su contenido no coinciden. Sube una imagen PNG o JPEG real.',
    );
  }

  // 6. Contenido activo disfrazado de imagen.
  if (containsActiveContent(buffer)) {
    throw new AvatarError(415, 'CONTENIDO_NO_PERMITIDO', 'El archivo contiene código o marcado no permitido.');
  }

  // 7. Cabecera: formato real, dimensiones y límite de píxeles antes de decodificar.
  const decodeOptions = {
    failOn: 'warning' as const,
    limitInputPixels: limits.maxDimension * limits.maxDimension,
    pages: 1,
  };
  let meta: Metadata;
  try {
    meta = await sharp(buffer, decodeOptions).metadata();
  } catch {
    throw new AvatarError(422, 'IMAGEN_CORRUPTA', 'La imagen está dañada o no se puede leer.');
  }
  if (meta.format !== bySignature) {
    throw new AvatarError(415, 'FORMATO_NO_PERMITIDO', FORMAT_MESSAGE);
  }
  if ((meta.pages ?? 1) > 1) {
    throw new AvatarError(415, 'FORMATO_NO_PERMITIDO', 'No se admiten imágenes animadas.');
  }
  const rawWidth = meta.width ?? 0;
  const rawHeight = meta.height ?? 0;
  if (rawWidth > limits.maxDimension || rawHeight > limits.maxDimension) {
    throw new AvatarError(
      422,
      'DIMENSIONES_EXCESIVAS',
      `La imagen mide ${rawWidth}×${rawHeight} px; el máximo es ${limits.maxDimension}×${limits.maxDimension} px.`,
    );
  }
  if (rawWidth < limits.minDimension || rawHeight < limits.minDimension) {
    throw new AvatarError(
      422,
      'IMAGEN_DEMASIADO_PEQUENA',
      `La imagen debe medir al menos ${limits.minDimension}×${limits.minDimension} px.`,
    );
  }

  // Las orientaciones EXIF 5-8 intercambian ancho y alto al enderezar la imagen.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? rawHeight : rawWidth;
  const height = swap ? rawWidth : rawHeight;
  const rect = computeCropRect(width, height, input.crop);

  // 8. Decodificación completa + recorte + re-codificación (sin metadatos).
  let output: Buffer;
  try {
    output = await sharp(buffer, decodeOptions)
      .rotate()
      .extract(rect)
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    throw new AvatarError(422, 'IMAGEN_CORRUPTA', 'La imagen está dañada o no se puede procesar.');
  }

  return {
    image: output,
    width: AVATAR_OUTPUT_SIZE,
    height: AVATAR_OUTPUT_SIZE,
    bytes: output.length,
    sha256: createHash('sha256').update(output).digest('hex'),
    sourceType: bySignature,
  };
}
