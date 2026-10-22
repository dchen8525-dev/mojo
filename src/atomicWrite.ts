import { promises as fs } from "node:fs";
import crypto from "node:crypto";

/**
 * Replace a file via a sibling temp file + rename, so a crash or power loss
 * mid-write leaves either the old or the new contents, never a torn file.
 * rename() is atomic on POSIX; on Windows it replaces the target too, but can
 * transiently fail with EPERM/EBUSY while a scanner or reader holds the file,
 * hence the short retry loop.
 *
 * Mode handling: an explicit `mode` wins (session files are created 0600);
 * otherwise an existing file keeps its permission bits and a new file gets
 * the usual 0666 minus umask. Symlinks are written through rather than
 * replaced, matching plain writeFile semantics.
 */
export async function atomicWriteFile(file: string, data: string, mode?: number): Promise<void> {
  let existing: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    existing = await fs.lstat(file);
  } catch {
    /* new file */
  }
  if (existing?.isSymbolicLink()) {
    await fs.writeFile(file, data, "utf8");
    return;
  }
  const fileMode = mode ?? (existing ? existing.mode & 0o777 : 0o666);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(tmp, "w", fileMode);
    try {
      await handle.writeFile(data, "utf8");
      // Some network/removable filesystems do not implement fsync; the
      // rename below still prevents torn files, so do not fail the write.
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
