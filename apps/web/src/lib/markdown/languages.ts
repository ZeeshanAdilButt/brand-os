import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Languages highlighted in rendered articles. Anything else is shown as plain code, never dropped. */
export const HIGHLIGHT_LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

export const HIGHLIGHT_ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  go: ['golang'],
  rust: ['rs'],
  python: ['py'],
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs'],
  yaml: ['yml'],
  xml: ['html', 'svg'],
  ini: ['toml'],
  dockerfile: ['docker'],
  markdown: ['md'],
  sql: ['postgres', 'postgresql', 'pgsql'],
};

/** Fences that are intentionally not highlighted. */
export const PLAIN_TEXT_LANGUAGES = ['mermaid', 'text', 'txt', 'plaintext', 'plain', 'none'];
