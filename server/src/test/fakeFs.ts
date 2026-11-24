import * as Path from 'node:path';
import type { ScanFs } from '../JobModules/libraryScan.ts';

/** A symbolic link in a fake tree. `target` is an absolute path. */
export class SymLink {
  readonly target: string;
  constructor(target: string) {
    this.target = target;
  }
}

/** In-memory fs: a tree of directories (nested objects), files (string contents), and links. */
export type Tree = { [name: string]: Tree | string | SymLink };
type Node = Tree | string | SymLink;

//Shared by every fake, so descriptors from several fakes never collide.
let nextFd = 3;

const isDir = (node: Node): node is Tree => typeof node === 'object' && !(node instanceof SymLink);

/** Serves `tree` under `root`; paths outside it do not exist. Like the real lstat, a link is
 *  reported as a link and not followed. */
export function fakeFs(tree: Tree, root = '/library'): ScanFs & { tree: Tree } {
  const lookup = (p: string): Node | undefined => {
    const rel = Path.relative(root, p);
    if (rel.startsWith('..')) return undefined;
    const parts = rel === '' ? [] : rel.split(Path.sep);
    let node: Node | undefined = tree;
    for (const part of parts) {
      if (node === undefined || !isDir(node)) return undefined;
      node = node[part];
    }
    return node;
  };
  const must = (p: string) => {
    const node = lookup(p);
    if (node === undefined) throw new Error(`ENOENT: ${p}`);
    return node;
  };
  const fileContents = (p: string) => {
    const node = must(p);
    if (node instanceof SymLink) throw new Error(`ELOOP: ${p}`);
    if (typeof node !== 'string') throw new Error(`EISDIR: ${p}`);
    return Buffer.from(node);
  };
  const open = new Map<number, Buffer>();
  return {
    tree,
    lstatSync: (p) => {
      const node = must(p);
      return {
        isDirectory: () => isDir(node),
        isFile: () => typeof node === 'string',
        isSymbolicLink: () => node instanceof SymLink,
        birthtimeMs: 1_000_000,
        mtimeMs: 2_000_000,
      };
    },
    readdirSync: (p) => {
      const node = must(p);
      if (!isDir(node)) throw new Error(`ENOTDIR: ${p}`);
      return Object.keys(node);
    },
    existsSync: (p) => lookup(p) !== undefined,
    readFileSync: fileContents,
    openSync: (p) => {
      const fd = nextFd++;
      open.set(fd, fileContents(p));
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => {
      const contents = open.get(fd);
      if (!contents) throw new Error(`EBADF: ${fd}`);
      return contents.copy(buffer, offset, position, Math.min(position + length, contents.length));
    },
    closeSync: (fd) => {
      if (!open.delete(fd)) throw new Error(`EBADF: ${fd}`);
    },
  };
}
