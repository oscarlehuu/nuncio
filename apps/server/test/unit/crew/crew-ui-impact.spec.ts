import {
  classifyUiImpact,
  extractDiffFiles,
  MAX_UI_IMPACT_FILES,
} from '../../../src/crew/domain/crew-ui-impact';

describe('extractDiffFiles', () => {
  it('extracts the new-side path of every file header in a unified git diff', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
    ].join('\n');
    expect(extractDiffFiles(diff)).toEqual(['src/app.ts', 'README.md']);
  });

  it('uses the rename destination and handles quoted paths with spaces', () => {
    const diff = [
      'diff --git a/old/name.tsx b/new/name.tsx',
      'similarity index 90%',
      'rename from old/name.tsx',
      'rename to new/name.tsx',
      'diff --git "a/with space.css" "b/with space.css"',
      '--- "a/with space.css"',
      '+++ "b/with space.css"',
    ].join('\n');
    expect(extractDiffFiles(diff)).toEqual(['new/name.tsx', 'with space.css']);
  });

  it('never treats diff body lines that merely mention headers as files', () => {
    const diff = [
      'diff --git a/doc.md b/doc.md',
      '@@ -1 +1 @@',
      '+example text: diff --git a/fake.tsx b/fake.tsx',
    ].join('\n');
    expect(extractDiffFiles(diff)).toEqual(['doc.md']);
    expect(extractDiffFiles('')).toEqual([]);
  });
});

describe('classifyUiImpact', () => {
  const header = (path: string) => `diff --git a/${path} b/${path}`;

  it('flags UI extensions and styling files regardless of directory', () => {
    const diff = [
      header('apps/web/src/anything/deep/box.tsx'),
      header('theme/tokens.css'),
      header('index.html'),
    ].join('\n');
    expect(classifyUiImpact(diff)).toEqual({
      uiTouched: true,
      uiFiles: ['apps/web/src/anything/deep/box.tsx', 'theme/tokens.css', 'index.html'],
      uiFileCount: 3,
    });
  });

  it('flags plain ts/js only inside UI path segments, plus tailwind config', () => {
    const diff = [
      header('apps/web/src/components/use-thing.ts'),
      header('src/screens/home.js'),
      header('tailwind.config.mjs'),
      header('apps/server/src/crew/crew.service.ts'),
      header('scripts/release.mjs'),
    ].join('\n');
    expect(classifyUiImpact(diff)).toEqual({
      uiTouched: true,
      uiFiles: ['apps/web/src/components/use-thing.ts', 'src/screens/home.js', 'tailwind.config.mjs'],
      uiFileCount: 3,
    });
  });

  it('reports untouched for backend-only or empty diffs', () => {
    const backendOnly = [header('apps/server/src/main.ts'), header('README.md')].join('\n');
    expect(classifyUiImpact(backendOnly)).toEqual({ uiTouched: false, uiFiles: [], uiFileCount: 0 });
    expect(classifyUiImpact('')).toEqual({ uiTouched: false, uiFiles: [], uiFileCount: 0 });
  });

  it('caps the reported file list while keeping the true total count', () => {
    const paths = Array.from({ length: MAX_UI_IMPACT_FILES + 5 }, (_, i) => `src/components/c${i}.tsx`);
    const result = classifyUiImpact(paths.map(header).join('\n'));
    expect(result.uiTouched).toBe(true);
    expect(result.uiFiles).toHaveLength(MAX_UI_IMPACT_FILES);
    expect(result.uiFileCount).toBe(MAX_UI_IMPACT_FILES + 5);
  });

  it('is case-insensitive on extensions and segments', () => {
    const diff = [header('Src/Components/Button.TSX')].join('\n');
    expect(classifyUiImpact(diff).uiTouched).toBe(true);
  });
});
