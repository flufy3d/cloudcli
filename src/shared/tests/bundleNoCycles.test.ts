import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Production bundle integrity', () => {
  it('should not contain circular dependencies between JS bundle chunks', () => {
    const assetsDir = path.resolve(process.cwd(), 'dist/assets');
    if (!fs.existsSync(assetsDir)) {
      // If dist has not been built yet, skip gracefully
      return;
    }

    const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
    const graph: Record<string, string[]> = {};

    for (const file of files) {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf-8');
      const regex = /import\s*(\{[^}]*\}|[a-zA-Z0-9_$,\s]+)\s*from\s*["\x27]\.\/([^"\x27]+)["\x27]/g;
      let match: RegExpExecArray | null;
      graph[file] = [];
      while ((match = regex.exec(content)) !== null) {
        graph[file].push(match[2]);
      }
    }

    const cycles: string[] = [];
    function findCycles(node: string, visited = new Set<string>(), currentPath: string[] = []) {
      visited.add(node);
      currentPath.push(node);
      for (const dep of (graph[node] || [])) {
        if (currentPath.includes(dep)) {
          const cycle = currentPath.slice(currentPath.indexOf(dep)).concat(dep).join(' -> ');
          if (!cycles.includes(cycle)) cycles.push(cycle);
        } else if (!visited.has(dep)) {
          findCycles(dep, visited, [...currentPath]);
        }
      }
    }

    for (const node of Object.keys(graph)) {
      findCycles(node);
    }

    expect(cycles, `Found circular dependencies in bundle: \n${cycles.join('\n')}`).toEqual([]);
  });
});
