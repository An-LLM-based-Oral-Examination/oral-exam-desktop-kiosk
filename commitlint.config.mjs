export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
        'merge'
      ]
    ],
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    'scope-enum': [
      2,
      'always',
      [
        'kiosk',
        'electron',
        'native',
        'mf-04',
        'auth',
        'ui',
        'api',
        'ci',
        'deps',
        'docs'
      ]
    ],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [
      2,
      'never',
      ['sentence-case', 'start-case', 'pascal-case', 'upper-case']
    ],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100]
  }
};
