// shaders.js -- fetch .glsl sources and resolve #include "..." recursively.
// GLSL has no preprocessor includes of its own, so we do it here. Semantics:
// include-once per compilation unit (guards in the chunks make it idempotent
// anyway), cycle-detected, and line-tagged so driver errors stay traceable.

const DIR = new URL('../shaders/', import.meta.url);
const cache = new Map();   // path -> raw text
const INCLUDE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm;

async function raw(path) {
  if (cache.has(path)) return cache.get(path);
  const url = new URL(path, DIR);
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw new Error(
      `无法读取着色器 ${path} (${e.message})。` +
      `请通过静态服务器打开本项目，file:// 协议下浏览器会阻止 fetch。`);
  }
  if (!res.ok) throw new Error(`着色器 ${path} 加载失败: HTTP ${res.status}`);
  const text = await res.text();
  cache.set(path, text);
  return text;
}

async function expand(path, seen, done) {
  if (done.has(path)) return '';
  if (seen.has(path)) throw new Error(`着色器 #include 循环: ${[...seen, path].join(' -> ')}`);
  done.add(path);

  const src = await raw(path);
  const names = [...src.matchAll(INCLUDE)].map((m) => m[1]);
  const parts = await Promise.all(
    [...new Set(names)].map(async (n) => [n, await expand(n, new Set([...seen, path]), done)]),
  );
  const byName = new Map(parts);

  INCLUDE.lastIndex = 0;
  const out = src.replace(INCLUDE, (_, n) => byName.get(n) ?? '');
  return `// ---- ${path} ----\n${out}\n`;
}

/** Resolve one shader file into a single flat source string. */
export function loadShader(path) {
  return expand(path, new Set(), new Set());
}

/** Resolve several shaders in parallel. `onProgress(done, total)` is optional. */
export async function loadShaders(paths, onProgress) {
  let n = 0;
  const srcs = await Promise.all(paths.map(async (p) => {
    const s = await loadShader(p);
    onProgress?.(++n, paths.length);
    return s;
  }));
  return Object.fromEntries(paths.map((p, i) => [p, srcs[i]]));
}
