/**
 * OpenCode Prompt Attachments
 *
 * Turns chat attachments into what the service's prompt endpoint accepts:
 * data-URI file parts (`{uri, filename, mime}`), so the model actually sees
 * images and documents. The legacy `<images_input>`/`<files_input>` path
 * tags are still appended to the prompt text because the transcript readers
 * strip them back out to display the attachments after a reload.
 *
 * @module opencode-prompt-attachments
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  isAllowedImageSourcePath,
  normalizeAttachmentDescriptors,
  resolveImageAbsolutePath,
  resolveImageMediaType,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type { AnyRecord } from '@/shared/types.js';

import type { OpenCodePromptFile } from './opencode-api.client.js';

/** Inline ceiling; larger files keep only their path tag in the prompt. */
const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
};

const resolveMediaType = (descriptor: ChatAttachmentDescriptor): string => (
  resolveImageMediaType(descriptor)
  ?? TEXT_EXTENSION_MEDIA_TYPES[path.extname(descriptor.path).toLowerCase()]
  ?? 'application/octet-stream'
);

/**
 * The prompt text: the user's message plus the path tags for every
 * attachment (images first, then files), exactly as the spawn-based runtime
 * sent it.
 *
 * Consumer: opencode runtime.
 */
export function buildOpenCodePromptText(command: string | null | undefined, options: AnyRecord): string {
  return appendFilesInputTag(appendImagesInputTag(command?.trim() || '', options.images), options.files);
}

/**
 * Reads every attachment (images and files alike) into a file part. The
 * gateway already restricts attachment paths to the upload store and the
 * working directory; the containment check is repeated so a descriptor that
 * slipped past can never widen the read. Unreadable or oversized files are
 * skipped with a warning — their path tag still reaches the model.
 *
 * Consumer: opencode runtime.
 */
export async function buildOpenCodePromptFiles(options: AnyRecord, workingDir: string): Promise<OpenCodePromptFile[]> {
  const descriptors = [...normalizeAttachmentDescriptors(options.images), ...normalizeAttachmentDescriptors(options.files)];
  const files: OpenCodePromptFile[] = [];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.path)) {
      continue;
    }
    seen.add(descriptor.path);
    const absolutePath = resolveImageAbsolutePath(workingDir, descriptor.path);
    if (!isAllowedImageSourcePath(absolutePath, workingDir)) {
      console.warn(`[OpenCode] skipping attachment outside the allowed directories: ${descriptor.path}`);
      continue;
    }
    try {
      // Second containment pass on the symlink-resolved path: a link pointing
      // out of the allowed roots must not widen the read (same barrier as the
      // Claude image builder).
      const canonicalPath = await fs.realpath(absolutePath);
      if (!isAllowedImageSourcePath(canonicalPath, workingDir)) {
        console.warn(`[OpenCode] skipping symlinked attachment outside the allowed directories: ${descriptor.path}`);
        continue;
      }
      const stats = await fs.stat(canonicalPath);
      if (stats.size > MAX_INLINE_ATTACHMENT_BYTES) {
        console.warn(`[OpenCode] attachment too large to inline (${stats.size} bytes): ${descriptor.path}`);
        continue;
      }
      const content = await fs.readFile(canonicalPath);
      const mime = resolveMediaType(descriptor);
      files.push({
        uri: `data:${mime};base64,${content.toString('base64')}`,
        filename: descriptor.name || path.basename(canonicalPath),
        mime,
      });
    } catch (error) {
      console.warn(`[OpenCode] failed to read attachment ${descriptor.path}:`, error);
    }
  }
  return files;
}
