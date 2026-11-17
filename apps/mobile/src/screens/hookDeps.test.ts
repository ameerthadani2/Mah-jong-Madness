import { join } from 'path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { timeBound } from '../../../../packages/engine/test/helpers/timing';

const repo = join(__dirname, '../../../..');

describe('hook dependencies in the review screen', () => {
  it(
    'lists every value its hooks read (react-hooks/exhaustive-deps), so a hook never runs on a stale value',
    async () => {
      const eslint = new ESLint({ cwd: repo });
      const [result] = await eslint.lintFiles([join(repo, 'apps/mobile/src/screens/ReviewScreen.tsx')]);
      expect(result.messages.filter((m) => m.ruleId === 'react-hooks/exhaustive-deps').map((m) => `${m.line}: ${m.message}`)).toEqual([]);
    },
    timeBound(30000),
  );
});
