import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('the adapter seam', () => {
  it('keeps the library out of the page and the language', () => {
    for (const file of ['../TopologyPage.tsx', '../topology-language.ts', './adapter.ts', './layout.ts', './filter.ts']) {
      expect(readFileSync(join(here, file), 'utf8')).not.toContain('@xyflow/react');
    }
  });

  it('imports the library only from the adapter implementation', () => {
    expect(readFileSync(join(here, 'xyflow-canvas.tsx'), 'utf8')).toContain("from '@xyflow/react'");
  });

  it('keeps the redundant canvas nodes out of the keyboard relationship path', () => {
    const implementation = readFileSync(join(here, 'xyflow-canvas.tsx'), 'utf8');
    expect(implementation).toContain('nodesFocusable={false}');
    expect(implementation).toContain("querySelectorAll('.react-flow__background, .react-flow__controls svg')");
  });
});
